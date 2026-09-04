"""Backtest walk-forward de las estrategias de cartera.

El tablero muestra la cartera optima *de la ventana que ya paso*. Eso no dice
nada de si la estrategia sirve: la cartera se elige mirando el mismo tramo con
el que despues se la califica. Este script responde la otra pregunta, la que
importa: que habria rendido de verdad.

Protocolo, estrictamente point-in-time:
  - Cada fin de mes se optimiza usando SOLO los 252 dias habiles anteriores.
  - Los pesos se aplican a partir del dia siguiente y se mantienen hasta el
    proximo rebalanceo, dejando que deriven con los precios (que es lo que
    pasa en una cuenta real si no se toca nada).
  - El universo es variable en el tiempo: en cada fecha entran unicamente los
    ETFs que ya tenian historia suficiente ESE dia. IBIT y ETHA no existen
    antes de 2024 y no pueden aparecer en una cartera de 2019.

Estrategias comparadas:
  maxsharpe     cartera tangente (la que el tablero llama "moderado")
  maxsharpe_lw  la misma, pero con covarianza encogida (Ledoit-Wolf)
  minvar        minima varianza (la que el tablero llama "conservador")
  minvar_lw     la misma, con Ledoit-Wolf
  erc           paridad de riesgo: cada activo aporta el mismo riesgo
  equi          1/N, el benchmark que hay que ganarle
  spy           comprar SPY y no hacer nada

Las variantes _lw estan para contestar con datos, y no con opinion, si el
shrinkage mejora el resultado fuera de muestra.

Los rebalanceos ya calculados se cachean en data/backtest_pesos.csv, asi que
la corrida diaria solo trabaja cuando aparece un fin de mes nuevo. Sin eso, el
job reoptimizaria ~110 fechas todos los dias y no entraria en el timeout.

Uso:
    py scripts/backtest.py [--rehacer]
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIVERSO = os.path.join(RAIZ, "universo.json")
CSV_PRECIOS = os.path.join(RAIZ, "data", "precios.csv")
CSV_TASA = os.path.join(RAIZ, "data", "tasa_libre_riesgo.csv")
CSV_PESOS = os.path.join(RAIZ, "data", "backtest_pesos.csv")
SALIDA = os.path.join(RAIZ, "docs", "data", "backtest.json")

LF = "\n"
DIAS_ANIO = 252
LOOKBACK = 252          # un anio habil, igual que el tablero
TOPE = 0.15             # tope por activo, igual que el tablero
MIN_ACTIVOS = 8         # por debajo de esto no tiene sentido optimizar
COSTO_POR_LADO = 0.0020 # 20 pb por punta; los CEDEARs no son gratis de operar

# Las que hay que optimizar (y que por lo tanto rotan y pagan costo).
ESTRATEGIAS_OPT = ["maxsharpe", "maxsharpe_lw", "minvar", "minvar_lw", "erc", "equi"]
ESTRATEGIAS = ESTRATEGIAS_OPT + ["spy"]


def log(m):
    print(m, flush=True)


# ------------------------------------------------------------------ datos ---

def cargar_precios():
    h = {}
    with open(CSV_PRECIOS, newline="", encoding="utf-8") as fh:
        for f in csv.DictReader(fh):
            h.setdefault(f["ticker"], {})[f["fecha"]] = float(f["cierre"])
    return h


def cargar_tasa():
    h = {}
    if os.path.exists(CSV_TASA):
        with open(CSV_TASA, newline="", encoding="utf-8") as fh:
            for f in csv.DictReader(fh):
                h[f["fecha"]] = float(f["tasa_anual_pct"])
    return h


def eje_de_fechas(precios, tickers):
    """Ruedas donde cotizo al menos la mitad del universo."""
    cuenta = {}
    for tk in tickers:
        for f in precios.get(tk, {}):
            cuenta[f] = cuenta.get(f, 0) + 1
    umbral = max(2, len(tickers) // 4)
    return sorted(f for f, n in cuenta.items() if n >= umbral)


def matriz_retornos(precios, tickers, fechas):
    """{ticker: [log-retorno o None por fecha]}, contra el ultimo cierre propio."""
    out = {}
    for tk in tickers:
        px = precios.get(tk, {})
        serie, previo = [], None
        for f in fechas:
            p = px.get(f)
            if p is None:
                serie.append(None)
                continue
            serie.append(math.log(p / previo) if previo else None)
            previo = p
        out[tk] = serie
    return out


def fines_de_mes(fechas):
    """Ultima rueda de cada mes."""
    ult = {}
    for i, f in enumerate(fechas):
        ult[f[:7]] = i
    return [fechas[i] for _, i in sorted(ult.items())]


# --------------------------------------------------------------- algebra ---

def matvec(M, v):
    return [sum(M[i][j] * v[j] for j in range(len(v))) for i in range(len(v))]


def cuad(M, v):
    return sum(v[i] * x for i, x in enumerate(matvec(M, v)))


def proyectar(v, tope):
    """Proyeccion euclidea sobre {sum(w)=1, 0<=w<=tope}."""
    n = len(v)
    if tope * n < 1 - 1e-12:
        return None
    def suma(tau):
        return sum(min(max(x - tau, 0.0), tope) for x in v)
    lo, hi = min(v) - 1.0, max(v)
    for _ in range(80):
        mid = (lo + hi) / 2
        if suma(mid) > 1:
            lo = mid
        else:
            hi = mid
    tau = (lo + hi) / 2
    return [min(max(x - tau, 0.0), tope) for x in v]


def ascender(w0, obj, grad, tope, iters=400):
    w, fw, paso = list(w0), obj(w0), 1.0
    for _ in range(iters):
        g = grad(w)
        mejoro = False
        for _ in range(30):
            cand = proyectar([w[i] + paso * g[i] for i in range(len(w))], tope)
            if cand is not None:
                fc = obj(cand)
                if fc > fw + 1e-15:
                    w, fw, mejoro = cand, fc, True
                    paso *= 1.8
                    break
            paso *= 0.5
        if not mejoro:
            break
    return w


def shrinkage_ledoit_wolf(X):
    """Covarianza con shrinkage de Ledoit-Wolf (2004), objetivo identidad.

    Con 49 activos y 252 observaciones (N/T ~ 0,2) la covarianza muestral esta
    mal condicionada: sus autovalores extremos estan sesgados, y el optimizador
    se apoya justamente en esos extremos —carga los activos que la muestra dice
    que tienen poca varianza, que suelen ser los que la subestiman por azar—.
    Ledoit-Wolf la mezcla con un objetivo estructurado (varianza promedio en la
    diagonal, cero afuera) en la proporcion que minimiza el error cuadratico
    esperado. Esa proporcion se estima de los datos, no se elige a mano.

    X: lista de T filas, cada una con N retornos, YA centrada.
    Devuelve (covarianza_shrunk, intensidad). Sigue la formulacion de
    sklearn.covariance.ledoit_wolf, contra la que esta verificada.
    """
    T = len(X)
    N = len(X[0])

    # emp_cov = X'X / T (sesgada, que es como la define el paper)
    emp = [[0.0] * N for _ in range(N)]
    for t in range(T):
        fila = X[t]
        for i in range(N):
            xi = fila[i]
            if xi == 0.0:
                continue
            ei = emp[i]
            for j in range(i, N):
                ei[j] += xi * fila[j]
    for i in range(N):
        for j in range(i, N):
            emp[i][j] /= T
            emp[j][i] = emp[i][j]

    traza = sum(emp[i][i] for i in range(N))
    mu = traza / N

    # delta = ||emp - mu*I||^2_F / N
    norma2 = sum(emp[i][j] ** 2 for i in range(N) for j in range(N))
    delta = (norma2 - 2.0 * mu * traza + N * mu * mu) / N

    # beta = varianza de estimacion de emp, promediada
    # sum_ij sum_t x_ti^2 x_tj^2  =  sum_t (sum_i x_ti^2)^2
    suma_cuad = 0.0
    for t in range(T):
        s = 0.0
        for v in X[t]:
            s += v * v
        suma_cuad += s * s
    beta = (suma_cuad / T - norma2) / (N * T)

    beta = min(beta, delta)
    intensidad = 0.0 if (delta <= 0 or beta <= 0) else beta / delta

    out = [[(1.0 - intensidad) * emp[i][j] for j in range(N)] for i in range(N)]
    for i in range(N):
        out[i][i] += intensidad * mu
    return out, intensidad


def estadisticas(rets, idx_desde, idx_hasta):
    """Media y covarianza sobre las filas completas del tramo [desde, hasta]."""
    n = len(rets)
    filas = [t for t in range(idx_desde, idx_hasta + 1)
             if all(r[t] is not None for r in rets)]
    if len(filas) < 40:
        return None, None, 0
    mu = [sum(r[t] for t in filas) / len(filas) for r in rets]
    cov = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i, n):
            s = sum((rets[i][t] - mu[i]) * (rets[j][t] - mu[j]) for t in filas)
            cov[i][j] = cov[j][i] = s / (len(filas) - 1)
    centrada = [[rets[i][t] - mu[i] for i in range(n)] for t in filas]
    return mu, cov, len(filas), centrada


# ---------------------------------------------------------- optimizadores ---

def opt_maxsharpe(mu, cov, rf_d, tope):
    n = len(mu)
    ex = [m - rf_d for m in mu]
    def obj(w):
        v = cuad(cov, w)
        return -1e9 if v <= 0 else sum(ex[i] * w[i] for i in range(n)) / math.sqrt(v)
    def grad(w):
        cw = matvec(cov, w)
        sig = math.sqrt(max(cuad(cov, w), 1e-18))
        ew = sum(ex[i] * w[i] for i in range(n))
        return [ex[i] / sig - ew * cw[i] / sig ** 3 for i in range(n)]
    arranques = [proyectar([1.0 / n] * n, tope)]
    orden = sorted(range(n), key=lambda i: -ex[i])
    sesgo = [0.0] * n
    for i in orden[:max(3, int(math.ceil(1 / tope)))]:
        sesgo[i] = 1.0
    arranques.append(proyectar(sesgo, tope))
    inv = [1 / math.sqrt(max(cov[i][i], 1e-12)) for i in range(n)]
    s = sum(inv)
    arranques.append(proyectar([x / s for x in inv], tope))
    mejor, fmejor = None, -1e18
    for a in arranques:
        if a is None:
            continue
        w = ascender(a, obj, grad, tope)
        f = obj(w)
        if f > fmejor:
            mejor, fmejor = w, f
    return mejor


def opt_minvar(mu, cov, tope):
    n = len(mu)
    obj = lambda w: -cuad(cov, w)
    grad = lambda w: [-2 * x for x in matvec(cov, w)]
    return ascender(proyectar([1.0 / n] * n, tope), obj, grad, tope)


def opt_erc(cov, tope, iters=800):
    """Paridad de riesgo: cada activo aporta la misma contribucion al riesgo.

    Iteracion de punto fijo w_i <- b_i / (Sigma w)_i, que resuelve el problema
    convexo equivalente. No usa retornos esperados, que es justamente su gracia:
    esquiva la fuente de error de estimacion mas grande de todo Markowitz.
    """
    n = len(cov)
    b = 1.0 / n
    w = [1.0 / n] * n
    for _ in range(iters):
        cw = matvec(cov, w)
        nuevo = [b / cw[i] if cw[i] > 1e-18 else w[i] for i in range(n)]
        s = sum(nuevo)
        nuevo = [x / s for x in nuevo]
        if max(abs(nuevo[i] - w[i]) for i in range(n)) < 1e-10:
            w = nuevo
            break
        w = nuevo
    # El tope casi nunca ata en ERC (reparte fino), pero lo respetamos igual.
    if max(w) > tope + 1e-9:
        w = proyectar(w, tope) or w
    return w


# ----------------------------------------------------------------- cache ---

def leer_pesos():
    st = {}
    if os.path.exists(CSV_PESOS):
        with open(CSV_PESOS, newline="", encoding="utf-8") as fh:
            for f in csv.DictReader(fh):
                st.setdefault(f["fecha"], {}).setdefault(f["estrategia"], {})[
                    f["ticker"]] = float(f["peso"])
    return st


def escribir_pesos(st):
    filas = []
    for fecha in sorted(st):
        for estr in sorted(st[fecha]):
            for tk in sorted(st[fecha][estr]):
                filas.append([fecha, estr, tk, "%.8f" % st[fecha][estr][tk]])
    with open(CSV_PESOS, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator=LF)
        w.writerow(["fecha", "estrategia", "ticker", "peso"])
        w.writerows(filas)


# --------------------------------------------------------------- metricas ---

def metricas(nav, fechas, rf_por_fecha):
    """Metricas anualizadas de una curva de capital."""
    rets = [math.log(nav[i] / nav[i - 1]) for i in range(1, len(nav))]
    if len(rets) < 30:
        return None
    n = len(rets)
    med = sum(rets) / n
    var = sum((r - med) ** 2 for r in rets) / (n - 1)
    vol = math.sqrt(var * DIAS_ANIO)
    anios = n / DIAS_ANIO
    cagr = (nav[-1] / nav[0]) ** (1 / anios) - 1

    rfs = [rf_por_fecha.get(f) for f in fechas[1:]]
    rfs = [x for x in rfs if x is not None]
    rf = (sum(rfs) / len(rfs) / 100) if rfs else 0.0
    sharpe = (cagr - rf) / vol if vol > 0 else 0.0

    # Sortino: solo penaliza la volatilidad a la baja, que es la que duele.
    obj_d = rf / DIAS_ANIO
    abajo = [(r - obj_d) ** 2 for r in rets if r < obj_d]
    vol_abajo = math.sqrt(sum(abajo) / n * DIAS_ANIO) if abajo else 0.0
    sortino = (cagr - rf) / vol_abajo if vol_abajo > 0 else None

    pico, dd = nav[0], 0.0
    for v in nav:
        pico = max(pico, v)
        dd = min(dd, v / pico - 1)

    return {"cagr": cagr, "vol": vol, "sharpe": sharpe, "sortino": sortino,
            "maxDD": dd, "rf": rf, "anios": anios, "final": nav[-1] / nav[0]}


# -------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rehacer", action="store_true",
                    help="ignora la cache y recalcula todos los rebalanceos")
    args = ap.parse_args()

    universo = json.load(open(UNIVERSO, encoding="utf-8"))["etfs"]
    # Los apalancados e inversos quedan fuera: su retorno depende del camino
    # (se reapalancan a diario) y meterlos en un backtest de compra y
    # mantenimiento mensual daria un numero que no significa nada.
    # Los indices quedan fuera: no son instrumentos, no se pueden comprar.
    # Los apalancados e inversos tambien: su retorno depende del camino (se
    # reapalancan a diario) y en un backtest mensual daria un numero sin sentido.
    tickers = sorted(tk for tk, m in universo.items()
                     if m["categoria"] != "Apalancado / Inverso"
                     and m.get("tipo") != "indice")

    precios = cargar_precios()
    tasa = cargar_tasa()
    fechas = eje_de_fechas(precios, tickers)
    rets = matriz_retornos(precios, tickers, fechas)
    idx = {f: i for i, f in enumerate(fechas)}
    log("Universo: %d ETFs | eje: %d ruedas, %s -> %s"
        % (len(tickers), len(fechas), fechas[0], fechas[-1]))

    rf_por_fecha = {}
    ultimo = None
    for f in fechas:
        if f in tasa:
            ultimo = tasa[f]
        rf_por_fecha[f] = ultimo

    # Rebalanceos: fines de mes con al menos LOOKBACK ruedas de historia atras.
    rebal = [f for f in fines_de_mes(fechas) if idx[f] >= LOOKBACK]
    log("Rebalanceos posibles: %d (%s -> %s)" % (len(rebal), rebal[0], rebal[-1]))

    cache = {} if args.rehacer else leer_pesos()
    nuevos = 0

    for fecha in rebal:
        if fecha in cache and all(e in cache[fecha] for e in ESTRATEGIAS_OPT):
            continue
        t = idx[fecha]
        desde = t - LOOKBACK + 1

        # Universo point-in-time: solo los que ya tenian historia completa.
        vivos = [tk for tk in tickers
                 if all(rets[tk][k] is not None for k in range(desde, t + 1))]
        if len(vivos) < MIN_ACTIVOS:
            continue

        serie = [rets[tk] for tk in vivos]
        mu, cov, n_obs, centrada = estadisticas(serie, desde, t)
        if mu is None:
            continue
        cov_lw, _inten = shrinkage_ledoit_wolf(centrada)
        rf_d = (rf_por_fecha.get(fecha) or 0.0) / 100 / DIAS_ANIO

        soluciones = {
            "maxsharpe":    opt_maxsharpe(mu, cov, rf_d, TOPE),
            "maxsharpe_lw": opt_maxsharpe(mu, cov_lw, rf_d, TOPE),
            "minvar":       opt_minvar(mu, cov, TOPE),
            "minvar_lw":    opt_minvar(mu, cov_lw, TOPE),
            "erc":          opt_erc(cov_lw, TOPE),
            "equi":         [1.0 / len(vivos)] * len(vivos),
        }
        cache[fecha] = {
            e: {vivos[i]: w[i] for i in range(len(vivos)) if w[i] > 1e-5}
            for e, w in soluciones.items()
        }
        nuevos += 1
        if nuevos % 10 == 0:
            log("  ... %d rebalanceos nuevos (ultimo %s, %d activos vivos)"
                % (nuevos, fecha, len(vivos)))

    if nuevos:
        escribir_pesos(cache)
    log("Rebalanceos calculados ahora: %d | en cache: %d" % (nuevos, len(cache)))

    # --- recorrer el tiempo aplicando los pesos -----------------------------
    aplicables = [f for f in rebal if f in cache]
    if len(aplicables) < 6:
        raise SystemExit("Muy pocos rebalanceos para un backtest util.")

    inicio = idx[aplicables[0]]
    fechas_bt = fechas[inicio:]
    navs = {e: [1.0] for e in ESTRATEGIAS}
    turnover = {e: [] for e in ESTRATEGIAS_OPT}
    navs_neto = {e: [1.0] for e in ESTRATEGIAS_OPT}

    pesos_act = {e: {} for e in ESTRATEGIAS_OPT}
    prox = 0

    for k in range(1, len(fechas_bt)):
        f_ayer, f_hoy = fechas_bt[k - 1], fechas_bt[k]

        # Si ayer fue rebalanceo, hoy ya operamos con los pesos nuevos.
        if prox < len(aplicables) and aplicables[prox] == f_ayer:
            for e in ESTRATEGIAS_OPT:
                nuevo = cache[f_ayer][e]
                universo_union = set(nuevo) | set(pesos_act[e])
                to = sum(abs(nuevo.get(tk, 0) - pesos_act[e].get(tk, 0))
                         for tk in universo_union) / 2
                turnover[e].append(to)
                pesos_act[e] = dict(nuevo)
            prox += 1

        t_hoy = idx[f_hoy]
        for e in ESTRATEGIAS_OPT:
            w = pesos_act[e]
            if not w:
                navs[e].append(navs[e][-1])
                navs_neto[e].append(navs_neto[e][-1])
                continue
            bruto, peso_valido = 0.0, 0.0
            nuevo_w = {}
            for tk, wi in w.items():
                r = rets[tk][t_hoy]
                if r is None:
                    nuevo_w[tk] = wi
                    peso_valido += wi
                    continue
                cr = math.exp(r)
                bruto += wi * cr
                nuevo_w[tk] = wi * cr
                peso_valido += wi
            if peso_valido <= 0:
                navs[e].append(navs[e][-1])
                navs_neto[e].append(navs_neto[e][-1])
                continue
            factor = bruto / peso_valido
            navs[e].append(navs[e][-1] * factor)
            # Los pesos derivan con los precios hasta el proximo rebalanceo.
            s = sum(nuevo_w.values())
            pesos_act[e] = {tk: v / s for tk, v in nuevo_w.items()}
            # Version neta: el costo se cobra el dia que se rebalancea.
            costo = 0.0
            if turnover[e] and prox > 0 and aplicables[prox - 1] == f_ayer:
                costo = turnover[e][-1] * 2 * COSTO_POR_LADO
            navs_neto[e].append(navs_neto[e][-1] * factor * (1 - costo))

        r_spy = rets.get("SPY", [None] * len(fechas))[t_hoy]
        navs["spy"].append(navs["spy"][-1] * math.exp(r_spy) if r_spy is not None
                           else navs["spy"][-1])

    met = {e: metricas(navs[e], fechas_bt, rf_por_fecha) for e in ESTRATEGIAS}
    met_neto = {e: metricas(navs_neto[e], fechas_bt, rf_por_fecha)
                for e in ESTRATEGIAS_OPT}

    # Publicamos la curva BRUTA y el turnover de cada rebalanceo por separado.
    # Asi el tablero puede recalcular el neto para cualquier costo sin volver a
    # correr nada — y el costo es justamente la variable que decide el ranking.
    idx_rebal = []
    for k, f in enumerate(fechas_bt):
        if f in cache and f in aplicables:
            idx_rebal.append(k)

    salida = {
        "generado": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "protocolo": {
            "lookback": LOOKBACK, "tope": TOPE, "frecuencia": "mensual",
            "costoPorLadoDefecto": COSTO_POR_LADO,
            "desde": fechas_bt[0], "hasta": fechas_bt[-1],
            "rebalanceos": len(aplicables),
            "universoMax": len(tickers),
            "anios": met["equi"]["anios"],
        },
        "fechas": fechas_bt,
        "nav": {e: [round(v, 6) for v in navs[e]] for e in ESTRATEGIAS},
        "metricas": met,
        # Indice (dentro de `fechas`) del dia en que se paga cada rebalanceo,
        # y cuanto se movio la cartera esa vez.
        "rebalanceos": {
            "indices": idx_rebal[:len(turnover["equi"])],
            "turnover": {e: [round(x, 6) for x in turnover[e]] for e in ESTRATEGIAS_OPT},
        },
        "turnoverAnual": {e: (sum(turnover[e]) / (len(turnover[e]) / 12))
                          if turnover[e] else None for e in ESTRATEGIAS_OPT},
    }
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as fh:
        json.dump(salida, fh, ensure_ascii=False, separators=(",", ":"))

    log("")
    log("=== WALK-FORWARD  %s -> %s  (%d rebalanceos, %.1f anios) ==="
        % (fechas_bt[0], fechas_bt[-1], len(aplicables), met["equi"]["anios"]))
    log("%-14s %8s %8s %8s %9s %9s %9s" %
        ("", "CAGR", "Vol", "Sharpe", "Sortino", "MaxDD", "Turnover"))
    nombres = {"maxsharpe": "Max Sharpe", "maxsharpe_lw": "Max Sharpe LW",
               "minvar": "Min Var", "minvar_lw": "Min Var LW",
               "erc": "Paridad", "equi": "1/N", "spy": "SPY"}
    for e in ESTRATEGIAS:
        m = met[e]
        to = salida["turnoverAnual"].get(e)
        log("%-14s %7.1f%% %7.1f%% %8.2f %9s %8.1f%% %9s" % (
            nombres[e], m["cagr"] * 100, m["vol"] * 100, m["sharpe"],
            ("%.2f" % m["sortino"]) if m["sortino"] else "-",
            m["maxDD"] * 100, ("%.0f%%" % (to * 100)) if to else "-"))
    log("")
    log("Neto de costos (%.0f pb por punta):" % (COSTO_POR_LADO * 10000))
    for e in ESTRATEGIAS_OPT:
        m = met_neto[e]
        log("  %-14s CAGR %6.1f%%  Sharpe %5.2f" % (nombres[e], m["cagr"] * 100, m["sharpe"]))
    log("")
    log("Escrito %s (%.0f KB)" % (os.path.relpath(SALIDA, RAIZ),
                                  os.path.getsize(SALIDA) / 1024))


if __name__ == "__main__":
    main()
