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

    # El bar del dia en curso NO es un cierre: con la rueda abierta, Yahoo lo
    # va actualizando con el precio del momento. El 2026-09-11 una corrida a
    # mano a las 10:39 ART lo publico como "Cierre 2026-09-11", nueve minutos
    # despues de la apertura de EE.UU. Se descarta hasta que termina la rueda
    # regular, con el horario que informa Yahoo para ese mercado: ya contempla
    # el cambio de hora, y que ^IRX cierra una hora antes que las acciones.
    abierta = rueda_abierta(r.get("meta") or {})
    if abierta:
        porfecha.pop(abierta, None)
    return sorted(porfecha.items())


# Margen despues del cierre antes de aceptar el bar del dia: la subasta de
# cierre imprime unos minutos tarde y el primer valor puede no ser el final.
MARGEN_CIERRE_S = 30 * 60


def rueda_abierta(meta):
    """Fecha ISO de la rueda en curso si todavia no cerro, o None.

    Sale de meta.currentTradingPeriod.regular. Si Yahoo no lo manda, criterio
    conservador: ninguno de los mercados que se siguen cierra despues de las
    21:00 UTC, asi que el dia UTC en curso se da por abierto hasta las 21:30.
    """
    import datetime as dt

    ahora = dt.datetime.now(dt.UTC)
    reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    if reg.get("start") and reg.get("end"):
        if ahora.timestamp() < reg["end"] + MARGEN_CIERRE_S:
            return dt.datetime.fromtimestamp(reg["start"], dt.UTC).strftime("%Y-%m-%d")
        return None
    limite = ahora.replace(hour=21, minute=0, second=0, microsecond=0)
    if ahora.timestamp() < limite.timestamp() + MARGEN_CIERRE_S:
        return ahora.strftime("%Y-%m-%d")
    return None


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


# --------------------------------------------------------------------------
# Tasa libre de riesgo en USD (para el Sharpe)
# --------------------------------------------------------------------------

def serie_tasa_libre_riesgo(rango="5y"):
    """T-bill de EE.UU. a 13 semanas (^IRX), en % anual. [(fecha, tasa), ...].

    Es la tasa contra la que se mide el exceso de retorno: la cartera se
    optimiza en dolares, asi que la libre de riesgo tiene que ser en dolares.
    """
    return serie_yahoo("^IRX", rango)


# --------------------------------------------------------------------------
# Liquidez local: lo que se puede operar de verdad en BYMA
# --------------------------------------------------------------------------

def panel_liquidez():
    """Volumen, operaciones y puntas del cierre, por especie de BYMA.

    El optimizador razona sobre el subyacente en EE.UU., pero el que compra
    lo hace con el CEDEAR local. Un peso del 15% en algo que opera dos veces
    por semana no es una cartera, es un dibujo.

    Devuelve {simbolo: {volumen_ars, operaciones, bid, ask}}.
    """
    r = _get(BYMA_CEDEARS, datos={"T1": True, "T0": False, "T2": True})
    crudo = r.get("data", r) if isinstance(r, dict) else r
    out = {}
    for x in crudo:
        s = (x.get("symbol") or "").upper()
        if not s:
            continue
        out[s] = {
            "volumen_ars": float(x.get("volumeAmount") or 0),
            "operaciones": int(x.get("numberOfOrders") or 0),
            "bid": float(x.get("bidPrice") or 0),
            "ask": float(x.get("offerPrice") or 0),
        }
    return out
