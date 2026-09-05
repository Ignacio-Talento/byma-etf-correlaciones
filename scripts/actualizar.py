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
import io
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuentes  # noqa: E402
import publicar  # noqa: E402

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

# Cuantas ruedas de retornos publicamos. 1260 ~ 5 anios, que es la ventana mas
# larga que ofrece el tablero (y el lookback mas largo de la cartera). El JSON
# crece proporcionalmente, asi que este numero no se sube sin motivo.
RUEDAS_PUBLICADAS = 1260

# csv.writer termina las lineas con CRLF por defecto. Estos CSV los escribe
# tanto una corrida a mano en Windows como el job diario en Linux: si cada uno
# usa su final de linea, git ve las 66.000 filas del archivo como cambiadas y
# el diff diario deja de servir. Forzamos LF, que es como los guarda el repo.
LF = "\n"


class SkipLiquidez(Exception):
    """No corresponde registrar liquidez en esta corrida."""


class SkipPanel(Exception):
    """El panel de BYMA no puede contestar en esta corrida."""


def es_finde_en_bsas():
    """True si en Buenos Aires es sabado o domingo.

    Se calcula en hora argentina y no con la fecha del runner: el job corre en
    UTC y las pasadas de la noche caen de madrugada en Buenos Aires.
    """
    return (dt.datetime.now(dt.UTC) - dt.timedelta(hours=3)).weekday() >= 5


def sellar_assets():
    """Pone ?v=<hash> en los <script> y <link> de index.html.

    El sitio publica datos nuevos todos los dias pero el JS cambia poco, asi
    que un navegador puede quedarse con el codigo viejo y correrlo contra un
    dataset nuevo. El sello se calcula del CONTENIDO de cada archivo: cambia
    solo cuando el archivo cambio, con lo cual no fuerza descargas de mas.
    """
    import hashlib
    import re

    idx = os.path.join(RAIZ, "docs", "index.html")
    if not os.path.exists(idx):
        return 0
    html = io.open(idx, encoding="utf-8").read()

    def sello(archivo):
        ruta = os.path.join(RAIZ, "docs", archivo)
        if not os.path.exists(ruta):
            return None
        h = hashlib.sha256(open(ruta, "rb").read()).hexdigest()[:8]
        return h

    cambios = [0]

    def reemplazar(m):
        attr, archivo, resto = m.group(1), m.group(2), m.group(3)
        h = sello(archivo)
        if not h:
            return m.group(0)
        cambios[0] += 1
        return '%s="%s?v=%s"%s' % (attr, archivo, h, resto)

    nuevo = re.sub(r'(src|href)="((?:app|cartera|backtest|base100)\.js|estilos\.css)(?:\?v=[0-9a-f]+)?"([^>]*)',
                   reemplazar, html)
    if nuevo != html:
        io.open(idx, "w", encoding="utf-8", newline="").write(nuevo)
    return cambios[0]


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


# El adjclose de Yahoo llega en precision float32 y el factor de ajuste se
# recalcula del lado del servidor en cada request: dos llamadas identicas a
# --rango 10y devuelven precios distintos para 1703 de 2514 dias de SPY. Si se
# pisa lo guardado con lo recien bajado, el 8,4% de los retornos cambia en el
# ultimo decimal en CADA corrida y se recommitean los 3,6 MB del CSV sin que
# haya pasado nada en el mercado.
#
# El umbral sale de medir, no de estimar. Bajando dos veces 10y de cada ticker,
# la diferencia relativa entre ambas tiene mediana ~1e-7 pero cola larga: p99 de
# 8e-7 y maximo observado de 1,35e-6 (JPMB). Un 1e-6 se queda corto y deja pasar
# unos pocos dias por corrida, que es lo mismo que no filtrar: el archivo se
# reescribe igual.
#
# 1e-5 queda ~7x por encima del ruido medido y sigue estando un orden y medio
# por debajo del ajuste por dividendo mas chico que puede aparecer: un ETF que
# rinda 0,1% anual mueve el adjclose 2,5e-4 en cada pago trimestral. Los splits
# son de otra escala (>=1). O sea que las correcciones reales entran igual.
TOL_REFETCH = 1e-5


def fusionar_serie(guardado, serie):
    """Mete `serie` en `guardado` ignorando el ruido de re-descarga.

    Devuelve (nuevos, corregidos) para poder loguear cuando una serie se
    restata de verdad, que es lo unico que deberia mover un dia viejo.
    """
    nuevos = corregidos = 0
    for f, px in serie:
        previo = guardado.get(f)
        if previo is None:
            guardado[f] = px
            nuevos += 1
        elif previo == 0 or abs(px / previo - 1) >= TOL_REFETCH:
            guardado[f] = px
            corregidos += 1
    return nuevos, corregidos


def enbyma_previo():
    """{ticker: enByma} del dataset ya publicado, o vacio si no hay.

    Sirve para las corridas en las que el panel no puede contestar: degradar a
    None reescribiria el dataset entero cada fin de semana para volver a
    escribirlo el lunes, y el dato anterior sigue siendo el mejor que hay.
    """
    try:
        with open(SALIDA, encoding="utf-8") as fh:
            return {tk: m.get("enByma")
                    for tk, m in json.load(fh).get("etfs", {}).items()}
    except (OSError, ValueError):
        return {}


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


def ccl_en(fecha, ccl_ordenado):
    """CCL vigente en esa fecha, arrastrando el ultimo dato anterior."""
    import bisect
    i = bisect.bisect_right(ccl_ordenado[0], fecha) - 1
    return ccl_ordenado[1][i] if i >= 0 else None


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

    def es_indice(tk):
        return universo[tk].get("tipo") == "indice"

    indices = [tk for tk in tickers if es_indice(tk)]
    log("Universo: %d instrumentos (%d ETFs, %d indices)"
        % (len(tickers), len(tickers) - len(indices), len(indices)))

    precios = leer_csv_precios()
    ccl = leer_csv_ccl()
    tasa = leer_csv_simple(CSV_TASA, "tasa_anual_pct")
    liq = leer_csv_liquidez()
    avisos = []
    # Arranca con lo que decia la corrida anterior. Solo se pisa si el panel
    # de BYMA llega a contestar; si no —fin de semana, caida de la fuente, o
    # una corrida --sin-red para resellar assets— se arrastra el ultimo dato
    # bueno en vez de degradar los 58 a "no se sabe" y reescribir el dataset.
    en_byma = {tk: None for tk in tickers}
    en_byma.update({tk: v for tk, v in enbyma_previo().items() if tk in en_byma})

    if not args.sin_red:
        # 1. Que cotiza hoy en BYMA
        try:
            # El panel contesta que cotiza HOY. El fin de semana devuelve cero
            # especies, y tomarlo al pie de la letra marcaria los 58 CEDEARs
            # como deslistados y publicaria un aviso falso en el sitio.
            if es_finde_en_bsas():
                raise SkipPanel("fin de semana en Buenos Aires")
            especies, origen = fuentes.especies_byma()
            # Un panel vacio en dia habil tampoco es una respuesta: son cientos
            # de especies siempre. Es la fuente que fallo, no BYMA que vacio.
            if not especies:
                raise SkipPanel("el panel vino vacio")
            log("Panel BYMA (%s): %d especies" % (origen, len(especies)))
            for tk in tickers:
                # Un indice no cotiza como CEDEAR: preguntarle al panel de
                # BYMA si esta seria pedirle algo que no puede contestar.
                en_byma[tk] = None if es_indice(tk) else (tk in especies)
            faltan = [tk for tk in tickers if en_byma[tk] is False]
            if faltan:
                avisos.append("No aparecen hoy en el panel de BYMA: %s"
                              % ", ".join(faltan))
            nuevos = sorted(especies - set(tickers))
            sugeridos = detectar_etfs(nuevos)
            if sugeridos:
                avisos.append("BYMA lista ETFs que faltan en universo.json: %s"
                              % ", ".join(sugeridos))
        except SkipPanel as e:
            log("Panel BYMA: no se consulta (%s); se arrastra la corrida anterior" % e)
        except Exception as e:
            avisos.append("No se pudo validar el panel de BYMA: %s" % e)

        # 2. CCL primero: hace falta para pasar a dolares las series en pesos
        try:
            # Mismo criterio que en los precios: el CSV guarda 4 decimales y
            # la API devuelve el float completo, asi que pisar a ciegas hace
            # que un punado de niveles historicos baile un centavo entre una
            # corrida con red y una --sin-red. Las restataciones de verdad
            # —como la del 2026-09-04, que movio 0,4%— pasan el umbral.
            fusionar_serie(ccl, fuentes.serie_ccl())
        except Exception as e:
            avisos.append("No se pudo actualizar el CCL: %s" % e)

        # 3. Precios
        fallaron = []
        ccl_ord = (sorted(ccl), [ccl[f] for f in sorted(ccl)]) if ccl else ([], [])
        for i, tk in enumerate(tickers, 1):
            try:
                simbolo = universo[tk].get("simboloYahoo", tk)
                serie = fuentes.serie_yahoo(simbolo, args.rango)
                if universo[tk].get("enPesos"):
                    # Se guarda ya pasado a dolares por el CCL del dia: asi el
                    # resto del pipeline lo trata igual que a cualquier otra
                    # serie, y la vista en pesos lo recompone sumando el CCL.
                    if not ccl_ord[0]:
                        raise RuntimeError("hace falta el CCL para pasar %s a dolares" % tk)
                    conv = []
                    for f, px in serie:
                        c = ccl_en(f, ccl_ord)
                        if c:
                            conv.append((f, px / c))
                    serie = conv
                nuevos, corregidos = fusionar_serie(
                    precios.setdefault(tk, {}), serie)
                log("  [%2d/%d] %-6s %d ruedas%s%s%s" % (
                    i, len(tickers), tk, len(serie),
                    "  (%s, pasado a USD por CCL)" % simbolo
                    if universo[tk].get("enPesos") else "",
                    "  +%d nuevas" % nuevos if nuevos else "",
                    # Un dia viejo que se mueve por encima del umbral es un
                    # split o un dividendo, no ruido: conviene verlo.
                    "  %d restatadas" % corregidos if corregidos else ""))
            except Exception as e:
                fallaron.append(tk)
                log("  [%2d/%d] %-5s FALLO: %s" % (i, len(tickers), tk, e))
            time.sleep(0.25)
        if fallaron:
            avisos.append("Yahoo fallo para: %s (se usa lo ya guardado)"
                          % ", ".join(fallaron))

        # 4. Liquidez del panel local: que se puede operar de verdad
        try:
            # Fecha en hora argentina, no la del runner: el job corre en UTC y
            # la segunda pasada (06:00 UTC) cae de madrugada en Buenos Aires.
            # Sin esto, los datos del viernes se guardarian como sabado y esa
            # rueda contaria dos veces en la mediana.
            ahora_ar = dt.datetime.now(dt.UTC) - dt.timedelta(hours=3)
            if es_finde_en_bsas():
                raise SkipLiquidez("fin de semana en Buenos Aires: el panel no es de hoy")
            hoy = ahora_ar.date().isoformat()
            panel = fuentes.panel_liquidez()
            liq = [f for f in liq if f["fecha"] != hoy]
            for tk in tickers:
                if es_indice(tk):
                    continue
                d = panel.get(tk)
                if not d:
                    continue
                liq.append({"fecha": hoy, "ticker": tk,
                            "volumen_ars": "%.2f" % d["volumen_ars"],
                            "operaciones": str(d["operaciones"]),
                            "bid": "%.4f" % d["bid"], "ask": "%.4f" % d["ask"]})
            liq.sort(key=lambda f: (f["fecha"], f["ticker"]))
            escribir_csv_liquidez(liq)
        except SkipLiquidez as e:
            log("Liquidez: no se registra (%s)" % e)
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
            "tipo": meta.get("tipo", "etf"),
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

    cambio = publicar.escribir_json(SALIDA, dataset)

    sellados = sellar_assets()
    if sellados:
        log("Assets sellados contra cache: %d" % sellados)

    kb = os.path.getsize(SALIDA) / 1024
    log("")
    if cambio:
        log("Escrito %s (%.0f KB)" % (os.path.relpath(SALIDA, RAIZ), kb))
    else:
        # Pasada de red que no encontro nada nuevo: se deja el archivo como
        # esta para que el commit del job no se dispare por el timestamp.
        log("Sin cambios en %s (%.0f KB): no se reescribe"
            % (os.path.relpath(SALIDA, RAIZ), kb))
    for a in avisos:
        log("  AVISO: %s" % a)
    log("Ultima rueda: %s" % fechas[-1])


if __name__ == "__main__":
    main()
