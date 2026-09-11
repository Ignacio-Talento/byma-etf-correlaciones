# -*- coding: utf-8 -*-
"""Mensaje del commit diario, armado con lo que realmente entro.

Antes el titulo era siempre "Cierre <ultimaRueda>". Pero el cierre llega en
dos tandas: lo argentino (liquidez de BYMA, MERVAL) apenas cierra BYMA, y los
precios de EE.UU. cuando Yahoo los publica, entre 1 y 11 horas despues. La
primera tanda salia titulada con la rueda ANTERIOR —el 2026-09-11 hubo un
"Cierre 2026-09-09" que traia datos del 10—, y un commit de correcciones de la
fuente se veia igual que uno de rueda nueva.

Se lee el diff ya stageado, asi que describe exactamente lo que se commitea.

Uso (con los cambios ya en el index):
    git commit -m "$(python scripts/mensaje_commit.py)"
"""
import json
import subprocess

DATASET = "docs/data/dataset.json"

# Archivo -> como se nombra en el mensaje. El orden es el del titulo.
CSVS = [
    ("data/precios.csv", None),          # se nombra por ticker, ver abajo
    ("data/liquidez.csv", "liquidez BYMA"),
    ("data/ccl.csv", "CCL"),
    ("data/tasa_libre_riesgo.csv", "tasa"),
]

# Hasta cuantos tickers se nombran uno por uno antes de pasar a contarlos.
MAX_TICKERS = 3


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")
    return r.stdout


def ultima_rueda(ref):
    """ultimaRueda del dataset en `ref`: "HEAD:" para el ultimo commit, ":" para el index."""
    try:
        return json.loads(git("show", ref + DATASET))["ultimaRueda"]
    except (ValueError, KeyError):
        return None


def es_fecha(s):
    return len(s) == 10 and s[4] == "-" and s[7] == "-" and s[:4].isdigit()


def filas_cambiadas(ruta):
    """(nuevas, corregidas) del diff stageado de un CSV cuya 1ra columna es fecha.

    Cada una es una lista de filas ya partidas por coma. Una fila es corregida
    si su clave —la fila sin el valor final— tambien aparece del lado borrado.
    """
    agregadas, borradas = [], set()
    for linea in git("diff", "--staged", "--unified=0", "--", ruta).splitlines():
        if linea.startswith(("+++", "---")):
            continue
        signo, fila = linea[:1], linea[1:].split(",")
        if signo not in "+-" or not es_fecha(fila[0]):
            continue
        # Clave: fecha, o fecha+ticker en los CSV que tienen ticker.
        clave = tuple(fila[:2]) if len(fila) > 2 else (fila[0],)
        if signo == "+":
            agregadas.append((clave, fila))
        else:
            borradas.add(clave)
    nuevas = [f for c, f in agregadas if c not in borradas]
    corregidas = [f for c, f in agregadas if c in borradas]
    return nuevas, corregidas


def nombre(ruta, etiqueta, filas):
    if etiqueta:
        return etiqueta
    tickers = sorted({f[1] for f in filas})
    if len(tickers) <= MAX_TICKERS:
        return ", ".join(tickers)
    return "precios de %d instrumentos" % len(tickers)


def fechas_cortas(fechas):
    """Una restatacion por dividendo toca decenas de fechas: no se listan todas."""
    fs = sorted(fechas)
    return ", ".join(fs) if len(fs) <= 3 else "%s a %s (%d fechas)" % (fs[0], fs[-1], len(fs))


def enumerar(partes):
    return partes[0] if len(partes) == 1 else ", ".join(partes[:-1]) + " y " + partes[-1]


def mensaje():
    antes, ahora = ultima_rueda("HEAD:"), ultima_rueda(":")

    nuevos, corregidos, fechas = [], [], set()
    for ruta, etiqueta in CSVS:
        n, c = filas_cambiadas(ruta)
        if n:
            nuevos.append(nombre(ruta, etiqueta, n))
            fechas.update(f[0] for f in n)
        if c:
            corregidos.append("%s %s" % (nombre(ruta, etiqueta, c),
                                         fechas_cortas({f[0] for f in c})))

    if ahora and ahora != antes:
        titulo = "Cierre %s" % ahora
    elif fechas:
        # Hay filas de una rueda nueva pero el eje no avanzo: faltan los
        # precios de EE.UU., que son los que definen la rueda.
        titulo = "Parcial %s: %s (faltan los precios de EE.UU.)" % (
            max(fechas), enumerar(nuevos))
    elif corregidos:
        titulo = "Correcciones de la fuente: %s" % "; ".join(corregidos)
    else:
        # Solo cambiaron los JSON derivados (backtest, recalculo). Raro, pero
        # que el titulo no mienta diciendo que hubo cierre.
        titulo = "Recalculo sin datos nuevos (ultima rueda %s)" % (ahora or "?")

    cuerpo = []
    if nuevos and not titulo.startswith("Parcial"):
        cuerpo.append("Entro: %s." % enumerar(nuevos))
    if corregidos and not titulo.startswith("Correcciones"):
        cuerpo.append("Corregido por la fuente: %s." % "; ".join(corregidos))
    return titulo + ("\n\n" + "\n".join(cuerpo) if cuerpo else "")


if __name__ == "__main__":
    print(mensaje())
