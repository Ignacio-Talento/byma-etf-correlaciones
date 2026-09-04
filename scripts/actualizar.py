"""Actualiza el dataset de correlaciones de los ETFs que cotizan en BYMA.

Que hace, en orden:
  1. Valida contra el panel de BYMA que ETFs cotizan hoy localmente.
  2. Baja el historico de cierres del ETF subyacente en EE.UU. (Yahoo).
  3. Baja el historico del CCL (para poder ver todo en pesos).
  4. Acumula todo en data/*.csv y publica docs/data/dataset.json.

Los precios se acumulan: si una fuente falla o acorta su historia, lo que ya
esta guardado no se pierde. El commit diario del CSV es el registro de auditoria.

Uso:
    py scripts/actualizar.py [--rango 5y] [--sin-red]
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuentes  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIVERSO = os.path.join(RAIZ, "universo.json")
CSV_PRECIOS = os.path.join(RAIZ, "data", "precios.csv")
CSV_CCL = os.path.join(RAIZ, "data", "ccl.csv")
CSV_TASA = os.path.join(RAIZ, "data", "tasa_libre_riesgo.csv")
CSV_LIQ = os.path.join(RAIZ, "data", "liquidez.csv")
CACHE_NO_ETF = os.path.join(RAIZ, "data", "no_son_etf.json")
SALIDA = os.path.join(RAIZ, "docs", "data", "dataset.json")

# Simbolos del panel que revisamos por corrida buscando ETFs nuevos. BYMA
# lista ~590 especies: con este ritmo el barrido completo tarda unos dias, y
# despues la cache deja solo los altas reales para revisar.
POR_CORRIDA = 60

# Cuantas ruedas de retornos publicamos. 760 ~ 3 anios: alcanza para la
# ventana mas larga del tablero (504) y mantiene liviano el JSON.
RUEDAS_PUBLICADAS = 760

# csv.writer termina las lineas con CRLF por defecto. Estos CSV los escribe
# tanto una corrida a mano en Windows como el job diario en Linux: si cada uno
# usa su final de linea, git ve las 66.000 filas del archivo como cambiadas y
# el diff diario deja de servir. Forzamos LF, que es como los guarda el repo.
LF = "\n"


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- almacen ---

def leer_csv_precios():
    """{ticker: {fecha: precio}} desde el CSV acumulado."""
    store = {}
    if not os.path.exists(CSV_PRECIOS):
        return store
    with open(CSV_PRECIOS, newline="", encoding="utf-8") as fh:
        for fila in csv.DictReader(fh):
            store.setdefault(fila["ticker"], {})[fila["fecha"]] = float(fila["cierre"])
    return store


def escribir_csv_precios(store):
    filas = []
    for tk in sorted(store):
        for f in sorted(store[tk]):
            filas.append((f, tk, store[tk][f]))
    filas.sort()
    with open(CSV_PRECIOS, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator=LF)
        w.writerow(["fecha", "ticker", "cierre"])
        for f, tk, p in filas:
            w.writerow([f, tk, "%.6f" % p])


def leer_csv_simple(ruta, col):
    """CSV de dos columnas fecha,<col> -> {fecha: valor}."""
    store = {}
    if os.path.exists(ruta):
        with open(ruta, newline="", encoding="utf-8") as fh:
            for fila in csv.DictReader(fh):
                store[fila["fecha"]] = float(fila[col])
    return store


def escribir_csv_simple(ruta, col, store, dec=4):
    with open(ruta, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator=LF)
        w.writerow(["fecha", col])
        for f in sorted(store):
            w.writerow([f, ("%." + str(dec) + "f") % store[f]])


def leer_csv_ccl():
    store = {}
    if os.path.exists(CSV_CCL):
        with open(CSV_CCL, newline="", encoding="utf-8") as fh:
            for fila in csv.DictReader(fh):
                store[fila["fecha"]] = float(fila["ccl"])
    return store


def escribir_csv_ccl(store):
    with open(CSV_CCL, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator=LF)
        w.writerow(["fecha", "ccl"])
        for f in sorted(store):
            w.writerow([f, "%.4f" % store[f]])


# ----------------------------------------------------------------- calculo ---

def log_retornos(fechas, precios):
    """Retorno logaritmico alineado al eje de fechas. None donde no hay dato.

    Se calcula contra el ultimo cierre disponible del propio ticker, no contra
    la fecha anterior del eje: asi un feriado o una rueda sin precio no inventa
    un retorno de cero ni parte el retorno en dos.
    """
    salida = []
    previo = None
    for f in fechas:
        p = precios.get(f)
        if p is None:
            salida.append(None)
            continue
        salida.append(math.log(p / previo) if previo else None)
        previo = p
    return salida


def rellenar_ccl(fechas, ccl):
    """CCL en cada fecha del eje, arrastrando el ultimo valor conocido.

    El eje son ruedas de EE.UU.; en feriados argentinos no hay CCL nuevo, asi
    que se mantiene el ultimo. Devuelve (niveles, log-retornos).
    """
    ordenadas = sorted(ccl)
    niveles, i, ultimo = [], 0, None
    for f in fechas:
        while i < len(ordenadas) and ordenadas[i] <= f:
            ultimo = ccl[ordenadas[i]]
            i += 1
        niveles.append(ultimo)
    rets, previo = [], None
    for v in niveles:
        if v is None:
            rets.append(None)
            continue
        rets.append(math.log(v / previo) if previo else None)
        previo = v
    return niveles, rets


def leer_csv_liquidez():
    """[(fecha, ticker, volumen_ars, operaciones, bid, ask), ...]"""
    filas = []
    if os.path.exists(CSV_LIQ):
        with open(CSV_LIQ, newline="", encoding="utf-8") as fh:
            for f in csv.DictReader(fh):
                filas.append(f)
    return filas


def escribir_csv_liquidez(filas):
    with open(CSV_LIQ, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator=LF)
        w.writerow(["fecha", "ticker", "volumen_ars", "operaciones", "bid", "ask"])
        for f in filas:
            w.writerow([f["fecha"], f["ticker"], f["volumen_ars"],
                        f["operaciones"], f["bid"], f["ask"]])


def mediana(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def resumen_liquidez(filas, tickers):
    """Mediana por ticker de las ruedas guardadas.

    Con una sola rueda es apenas una foto; el job va acumulando y el numero
    se vuelve representativo solo. Por eso se publica cuantas ruedas hay
    detras: sin eso, el lector no sabe cuanto creerle.
    """
    por_tk = {}
    fechas = set()
    for f in filas:
        tk = f["ticker"]
        if tk not in tickers:
            continue
        fechas.add(f["fecha"])
        d = por_tk.setdefault(tk, {"vol": [], "ops": [], "spread": []})
        try:
            v = float(f["volumen_ars"]); o = int(f["operaciones"])
            b = float(f["bid"]); a = float(f["ask"])
        except (TypeError, ValueError):
            continue
        d["vol"].append(v)
        d["ops"].append(o)
        if b > 0 and a > 0 and a >= b:
            d["spread"].append((a - b) / ((a + b) / 2) * 10000)

    out = {}
    for tk, d in por_tk.items():
        out[tk] = {
            "volumenArs": mediana(d["vol"]),
            "operaciones": mediana(d["ops"]),
            "spreadPb": mediana(d["spread"]),
            "ruedasConPunta": len(d["spread"]),
        }
    return out, len(fechas)


def detectar_etfs(simbolos):
    """Busca ETFs entre los simbolos del panel que todavia no conocemos.

    Consultar los ~590 simbolos de BYMA en cada corrida seria abusivo, asi que
    se revisan POR_CORRIDA por vez y se cachea todo lo que resulta NO ser ETF.
    Al cabo de unos dias la cache cubre el panel entero y solo quedan por
    revisar las altas nuevas.
    """
    try:
        descartados = set(json.load(open(CACHE_NO_ETF, encoding="utf-8")))
    except Exception:
        descartados = set()

    pendientes = [s for s in simbolos if s not in descartados]
    hallados, revisados = [], 0
    for s in pendientes[:POR_CORRIDA]:
        es_etf = None
        try:
            u = ("https://query2.finance.yahoo.com/v1/finance/search?q=%s"
                 "&quotesCount=6&newsCount=0" % urllib.parse.quote(s))
            d = fuentes._get(u, intentos=2)
            coincide = [q for q in d.get("quotes", [])
                        if q.get("symbol", "").upper() == s]
            if coincide:
                es_etf = coincide[0].get("quoteType") == "ETF"
                if es_etf:
                    hallados.append("%s (%s)"
                                    % (s, coincide[0].get("shortname") or ""))
            else:
                # Sin coincidencia exacta: son brasileros (sufijo 3), variantes
                # de liquidacion o tickers renombrados. No son ETFs de EE.UU.
                es_etf = False
        except Exception:
            es_etf = None  # error de red: lo reintentamos manana
        if es_etf is False:
            descartados.add(s)
        revisados += 1
        time.sleep(0.2)

    if revisados:
        os.makedirs(os.path.dirname(CACHE_NO_ETF), exist_ok=True)
        with open(CACHE_NO_ETF, "w", encoding="utf-8") as fh:
            json.dump(sorted(descartados), fh, indent=0)
    faltan = max(0, len(pendientes) - POR_CORRIDA)
    log("Barrido de altas: %d revisados, %d por revisar" % (revisados, faltan))
    return hallados


# -------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rango", default="5y", help="rango pedido a Yahoo")
    ap.add_argument("--sin-red", action="store_true",
                    help="recalcula el JSON con lo que ya hay en data/")
    args = ap.parse_args()

    universo = json.load(open(UNIVERSO, encoding="utf-8"))["etfs"]
    tickers = sorted(universo)
    log("Universo: %d ETFs" % len(tickers))

    precios = leer_csv_precios()
    ccl = leer_csv_ccl()
    tasa = leer_csv_simple(CSV_TASA, "tasa_anual_pct")
    liq = leer_csv_liquidez()
    avisos = []
    en_byma = {tk: None for tk in tickers}

    if not args.sin_red:
        # 1. Que cotiza hoy en BYMA
        try:
            especies, origen = fuentes.especies_byma()
            log("Panel BYMA (%s): %d especies" % (origen, len(especies)))
            for tk in tickers:
                en_byma[tk] = tk in especies
            faltan = [tk for tk in tickers if not en_byma[tk]]
            if faltan:
                avisos.append("No aparecen hoy en el panel de BYMA: %s"
                              % ", ".join(faltan))
            nuevos = sorted(especies - set(tickers))
            sugeridos = detectar_etfs(nuevos)
            if sugeridos:
                avisos.append("BYMA lista ETFs que faltan en universo.json: %s"
                              % ", ".join(sugeridos))
        except Exception as e:
            avisos.append("No se pudo validar el panel de BYMA: %s" % e)

        # 2. Precios en EE.UU.
        fallaron = []
        for i, tk in enumerate(tickers, 1):
            try:
                serie = fuentes.serie_yahoo(tk, args.rango)
                precios.setdefault(tk, {}).update(dict(serie))
                log("  [%2d/%d] %-5s %d ruedas" % (i, len(tickers), tk, len(serie)))
            except Exception as e:
                fallaron.append(tk)
                log("  [%2d/%d] %-5s FALLO: %s" % (i, len(tickers), tk, e))
            time.sleep(0.25)
        if fallaron:
            avisos.append("Yahoo fallo para: %s (se usa lo ya guardado)"
                          % ", ".join(fallaron))

        # 3. CCL
        try:
            ccl.update(dict(fuentes.serie_ccl()))
        except Exception as e:
            avisos.append("No se pudo actualizar el CCL: %s" % e)

        # 4. Liquidez del panel local: que se puede operar de verdad
        try:
            hoy = dt.date.today().isoformat()
            panel = fuentes.panel_liquidez()
            liq = [f for f in liq if f["fecha"] != hoy]
            for tk in tickers:
                d = panel.get(tk)
                if not d:
                    continue
                liq.append({"fecha": hoy, "ticker": tk,
                            "volumen_ars": "%.2f" % d["volumen_ars"],
                            "operaciones": str(d["operaciones"]),
                            "bid": "%.4f" % d["bid"], "ask": "%.4f" % d["ask"]})
            liq.sort(key=lambda f: (f["fecha"], f["ticker"]))
            escribir_csv_liquidez(liq)
        except Exception as e:
            avisos.append("No se pudo leer la liquidez del panel: %s" % e)

        # 5. Tasa libre de riesgo en USD, para el Sharpe de la frontera
        try:
            tasa.update(dict(fuentes.serie_tasa_libre_riesgo(args.rango)))
        except Exception as e:
            avisos.append("No se pudo actualizar la tasa libre de riesgo: %s" % e)

        escribir_csv_precios(precios)
        escribir_csv_ccl(ccl)
        escribir_csv_simple(CSV_TASA, "tasa_anual_pct", tasa, dec=4)

    faltantes = [tk for tk in tickers if not precios.get(tk)]
    if faltantes:
        raise SystemExit("Sin precios para: %s" % ", ".join(faltantes))

    # 6. Eje de fechas = ruedas donde cotizo al menos la mitad del universo.
    # Filtra dias sueltos o medias ruedas que aparecen en una sola serie.
    cuenta = {}
    for tk in tickers:
        for f in precios[tk]:
            cuenta[f] = cuenta.get(f, 0) + 1
    umbral = max(2, len(tickers) // 2)
    fechas = sorted(f for f, n in cuenta.items() if n >= umbral)
    fechas = fechas[-(RUEDAS_PUBLICADAS + 1):]
    log("Eje: %d ruedas, %s -> %s" % (len(fechas), fechas[0], fechas[-1]))

    niveles_ccl, ret_ccl = rellenar_ccl(fechas, ccl)
    niveles_tasa, _ = rellenar_ccl(fechas, tasa)   # mismo arrastre del ultimo dato
    if niveles_ccl[-1] is None:
        avisos.append("Sin CCL para el ultimo cierre: la vista en pesos "
                      "puede quedar desactualizada.")

    resumen_liq, ruedas_liq = resumen_liquidez(liq, set(tickers))
    salida_etfs = {}
    for tk in tickers:
        rets = log_retornos(fechas, precios[tk])
        meta = universo[tk]
        salida_etfs[tk] = {
            "nombre": meta["nombre"],
            "categoria": meta["categoria"],
            "apalancamiento": meta.get("apalancamiento", 1),
            "driver": meta.get("driver", ""),
            "liquidez": resumen_liq.get(tk),
            "enByma": en_byma[tk],
            "ret": [None if r is None else round(r, 6) for r in rets],
        }

    dataset = {
        "generado": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ultimaRueda": fechas[-1],
        "fechas": fechas,
        "etfs": salida_etfs,
        "ccl": {
            "nivel": [None if v is None else round(v, 2) for v in niveles_ccl],
            "ret": [None if r is None else round(r, 6) for r in ret_ccl],
        },
        "tasaLibreRiesgo": {
            "pct": [None if v is None else round(v, 4) for v in niveles_tasa],
            "descripcion": "T-bill EE.UU. 13 semanas (^IRX), % anual",
        },
        "liquidezRuedas": ruedas_liq,
        "avisos": avisos,
        "fuentes": {
            "universo": "Panel de CEDEARs de BYMA (open.bymadata.com.ar)",
            "precios": "Cierres ajustados del ETF subyacente en EE.UU. (Yahoo Finance)",
            "ccl": "Contado con liquidacion (api.argentinadatos.com)",
            "tasa": "T-bill EE.UU. 13 semanas, ^IRX (Yahoo Finance)",
            "liquidez": "Volumen, operaciones y puntas del cierre del panel de BYMA",
        },
    }

    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as fh:
        json.dump(dataset, fh, ensure_ascii=False, separators=(",", ":"))

    kb = os.path.getsize(SALIDA) / 1024
    log("")
    log("Escrito %s (%.0f KB)" % (os.path.relpath(SALIDA, RAIZ), kb))
    for a in avisos:
        log("  AVISO: %s" % a)
    log("Ultima rueda: %s" % fechas[-1])


if __name__ == "__main__":
    main()
