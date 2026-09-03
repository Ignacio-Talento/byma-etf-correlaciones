"""Acceso a las fuentes de datos. Solo libreria estandar."""
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) monitor-etf-byma/1.0"
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def _get(url, datos=None, intentos=4, espera=1.5, timeout=30):
    """GET/POST con reintento exponencial. Devuelve el JSON parseado."""
    ultimo = None
    for i in range(intentos):
        try:
            cuerpo = json.dumps(datos).encode() if datos is not None else None
            cab = {"User-Agent": UA, "Accept": "application/json"}
            if datos is not None:
                cab["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=cuerpo, headers=cab)
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - queremos reintentar ante cualquier fallo de red
            ultimo = e
            if i < intentos - 1:
                time.sleep(espera * (2 ** i))
    raise RuntimeError("fallo %s: %s" % (url, ultimo))


# --------------------------------------------------------------------------
# BYMA: define QUE ETFs cotizan localmente (el universo)
# --------------------------------------------------------------------------

BYMA_CEDEARS = ("https://open.bymadata.com.ar/vanoms-be-core/rest/api/"
                "bymadata/free/cedears")
DATA912_CEDEARS = "https://data912.com/live/arg_cedears"


def especies_byma():
    """Simbolos base que cotizan hoy en el panel de CEDEARs de BYMA.

    Consulta BYMA y, si falla, cae a data912 (que espeja el mismo panel).
    Descarta los sufijos C/D, que son la misma especie liquidada en cable/MEP.
    """
    crudo, origen = None, None
    try:
        r = _get(BYMA_CEDEARS, datos={"T1": True, "T0": False, "T2": True})
        crudo = r.get("data", r) if isinstance(r, dict) else r
        origen = "BYMA"
    except Exception:
        crudo = _get(DATA912_CEDEARS)
        origen = "data912"

    simbolos = {x["symbol"].upper() for x in crudo if x.get("symbol")}
    base = {s for s in simbolos
            if not (len(s) > 1 and s[-1] in "CD" and s[:-1] in simbolos)}
    return base, origen


# --------------------------------------------------------------------------
# Yahoo Finance: precios del ETF subyacente en EE.UU.
# --------------------------------------------------------------------------

def serie_yahoo(ticker, rango="5y"):
    """Cierres ajustados diarios. Devuelve [(fecha ISO, precio), ...]."""
    import datetime as dt

    url = ("https://query2.finance.yahoo.com/v8/finance/chart/%s"
           "?range=%s&interval=1d&events=div%%2Csplit"
           % (urllib.parse.quote(ticker), rango))
    d = _get(url)
    res = (d.get("chart") or {}).get("result")
    if not res:
        raise RuntimeError("sin resultados para %s" % ticker)
    r = res[0]
    ts = r.get("timestamp") or []
    ind = r.get("indicators", {})
    aj = (ind.get("adjclose") or [{}])[0].get("adjclose")
    cierre = (ind.get("quote") or [{}])[0].get("close")
    px = aj if aj else cierre
    if not px:
        raise RuntimeError("sin precios para %s" % ticker)
    filas = []
    for t, p in zip(ts, px):
        if p is None or p <= 0:
            continue
        f = dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%d")
        filas.append((f, float(p)))
    # Yahoo puede repetir la ultima fecha en modo intradiario: nos quedamos
    # con el ultimo valor de cada dia.
    porfecha = {}
    for f, p in filas:
        porfecha[f] = p
    return sorted(porfecha.items())


# --------------------------------------------------------------------------
# CCL historico (para el toggle a pesos)
# --------------------------------------------------------------------------

CCL_HIST = "https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui"


def serie_ccl():
    """Serie diaria del contado con liquidacion. [(fecha ISO, nivel), ...]."""
    d = _get(CCL_HIST)
    filas = {}
    for r in d:
        f = r.get("fecha")
        compra, venta = r.get("compra"), r.get("venta")
        vals = [v for v in (compra, venta) if isinstance(v, (int, float)) and v > 0]
        if f and vals:
            filas[f] = sum(vals) / len(vals)
    return sorted(filas.items())
