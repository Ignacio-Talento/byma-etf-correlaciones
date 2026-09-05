# -*- coding: utf-8 -*-
"""Escribir los JSON del sitio sin ensuciar el historial.

Los dos JSON que consume el tablero llevan un campo "generado" con la hora al
segundo. Como el job corre tres veces por dia y el mercado deja dato nuevo una
sola vez, ese campo alcanzaba para que git viera un cambio en cada pasada: se
commiteaba el archivo entero —730 KB— para mover un timestamp, y cada commit
disparaba un rebuild de Pages. Con dos pasadas ya pasaba: el 2026-09-04 hay dos
commits "Cierre 2026-09-03" con el dato identico.

La solucion no es sacar el campo, que sirve, sino no reescribir el archivo
cuando lo unico distinto es el. El "generado" pasa entonces a significar
"cuando cambio el dato por ultima vez", que es lo que uno quiere leer en el
encabezado del sitio; para saber si el job sigue vivo esta la pestana de
Actions y el chequeo de atraso del propio workflow.
"""
import json
import os

# Mismo formato que usaba cada script: compacto y sin escapar los acentos.
_FORMATO = {"ensure_ascii": False, "separators": (",", ":")}


def escribir_json(ruta, payload, campo_hora="generado"):
    """Escribe `payload` en `ruta`. Devuelve True si el archivo cambio.

    La comparacion no es campo por campo sino contra el texto exacto que se
    escribiria, con el timestamp viejo puesto en lugar del nuevo. Asi no hay
    que preocuparse por el orden de las claves ni por como redondea float:
    si el archivo resultante seria byte por byte el que ya esta, no se toca.
    """
    previo = None
    if os.path.exists(ruta):
        try:
            with open(ruta, encoding="utf-8", newline="") as fh:
                previo = fh.read()
        except OSError:
            previo = None

    if previo is not None and campo_hora in payload:
        try:
            hora_previa = json.loads(previo).get(campo_hora)
        except ValueError:
            hora_previa = None
        if hora_previa is not None:
            comparable = dict(payload)
            comparable[campo_hora] = hora_previa
            if json.dumps(comparable, **_FORMATO) == previo:
                return False

    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with open(ruta, "w", encoding="utf-8", newline="") as fh:
        fh.write(json.dumps(payload, **_FORMATO))
    return True
