# Correlaciones de ETFs en BYMA

Heatmap interactivo con la correlación entre todos los ETFs que cotizan en BYMA.
Se actualiza solo, todos los días, con el cierre de mercado.

**→ https://ignacio-talento.github.io/byma-etf-correlaciones/**

---

## Qué muestra

Los **54 ETFs** que cotizan en BYMA como CEDEAR, correlacionados entre sí por sus
retornos diarios. En el tablero se puede:

- cambiar la **ventana** (1 mes a 3 años) y ver cómo cambia la foto;
- pasar de **dólares a pesos**, que le suma el efecto del CCL;
- **ordenar por similitud** (clustering jerárquico), que es lo que hace que los
  bloques de la matriz se lean como grupos y no como ruido;
- filtrar por categoría, resaltar un ticker, y abrir cualquier par para ver su
  **correlación móvil** — si el número de hoy es estable o es un momento suelto;
- ver la **tabla completa** de los 1.431 pares y bajarla en CSV.

## Decisiones que vale la pena conocer

**BYMA define el universo, pero los precios salen de EE.UU.**
El listado de qué ETFs entran sale del panel de CEDEARs de BYMA y se revalida en
cada corrida. Los retornos, en cambio, se calculan sobre el cierre ajustado del
ETF subyacente en el mercado americano.

El motivo es concreto: varios de estos CEDEARs son listados muy recientes o
operan poco. Al armar esto, nueve de ellos (XLK, XLY, XLP, XLV, XLI, XLB, XLC,
XLRE, VEA) tenían **una sola rueda** de historia local, y otros cuatro menos de
cien. Además, un CEDEAR que no operó repite el precio anterior, lo que genera un
retorno de cero que no es calma: es ausencia de dato. Eso sesga la correlación
hacia cero y ensucia toda la matriz. Con el subyacente los 54 tienen historia
completa y líquida.

**En pesos, el CCL es un factor común.**
La vista en pesos compone el retorno del ETF con el del CCL. Como el tipo de
cambio los mueve a todos a la vez, empuja cada par hacia arriba; se nota sobre
todo en los pares que en dólares dan negativo, que se comprimen hacia cero.
Cuánto pesa depende de cuán movido esté el dólar, así que el tablero muestra la
volatilidad del CCL de la ventana para que se pueda dimensionar.

**Los apalancados e inversos están, pero fuera de los rankings.**
TQQQ, SPXL, SH, PSQ y VXX aparecen en el mapa y en la tabla. Quedan afuera de las
listas de "más" y "menos" correlacionados porque su correlación es mecánica —SH
contra SPY da −1 por construcción, no porque diversifique— y si entran copan los
dos extremos y tapan los pares que sí dicen algo.

**Cómo se calcula.**
Correlación de Pearson sobre log-retornos diarios, par a par, usando sólo las
ruedas donde ambos tienen dato (mínimo 20). La matriz se calcula en el navegador
a partir de la serie de retornos, así que cambiar de ventana o de moneda es
instantáneo y no hay que precomputar una matriz por combinación.

## Identidad visual

Aplica el sistema de diseño de **Balanz**: paleta navy/cyan, Open Sans (self-hosted
en `docs/marca/fuentes/`, licencia OFL), wordmark oficial y disclaimer legal verbatim.

Una decisión que vale explicar: la escala del heatmap **no** usa navy y cyan como los
dos polos. Una escala divergente necesita que los extremos se lean como opuestos, y
navy (h=261°) y cyan (h=234°) son **los dos fríos** — puestos en los dos extremos, el
lector no distingue el signo de la correlación. Los polos salen del matiz exacto del
navy y del rojo de la paleta (`#C0392B`), llevados a la misma luminosidad en OKLab
para que −0,6 y +0,6 pesen visualmente igual, con un medio neutro de croma casi nula
para que el cero lea "nada".

## Cómo está armado

```
universo.json                 los 54 ETFs, con nombre y categoría (se edita a mano)
scripts/fuentes.py            acceso a BYMA, Yahoo y el CCL
scripts/actualizar.py         baja, acumula y publica el dataset
data/precios.csv              historia acumulada de cierres (el log de git es la auditoría)
data/ccl.csv                  serie del contado con liquidación
data/no_son_etf.json          caché del barrido de altas de BYMA
docs/                         el sitio (GitHub Pages)
docs/marca/                   wordmark Balanz + Open Sans (OFL)
docs/data/dataset.json        lo que consume el tablero
.github/workflows/            el job diario
```

Sin dependencias: sólo la librería estándar de Python. El job de CI no se puede
romper por una actualización de numpy o pandas.

### Correrlo local

```bash
python scripts/actualizar.py --rango 5y
```

Para recalcular el JSON sin volver a pegarle a las fuentes:

```bash
python scripts/actualizar.py --sin-red
```

Y para ver el sitio:

```bash
python -m http.server 5320 --directory docs
```

## El job diario

Corre por GitHub Actions a las 22:30 UTC (19:30 hora argentina) de lunes a
viernes, con una segunda pasada a las 06:00 UTC porque **los cron de Actions
llegan tarde o directamente no disparan**. Correrlo dos veces es inocuo: el
script es idempotente.

Cada corrida deja en el resumen del job la última rueda del dataset y los avisos.
Si el atraso pasa de 4 días —más que un fin de semana largo— marca un warning:
eso ya no es mercado cerrado, es una fuente que dejó de responder.

También se puede disparar a mano desde la pestaña Actions → *Actualizar cierre
diario* → *Run workflow*.

### Si BYMA lista un ETF nuevo

El job barre el panel de BYMA buscando altas y cachea lo que no es ETF, así que
después de unos días sólo revisa lo que aparece nuevo. Cuando encuentra un ETF
que no está en `universo.json`, lo avisa en el resumen del job y en el tablero.
Agregarlo es una línea en `universo.json` con su nombre y categoría; el resto
—historia, correlaciones, orden— sale solo en la corrida siguiente.

## Fuentes

| Qué | De dónde |
|---|---|
| Qué ETFs cotizan en BYMA | `open.bymadata.com.ar` (con `data912.com` de respaldo) |
| Precios de los subyacentes | Yahoo Finance |
| Contado con liquidación | `api.argentinadatos.com` |

## Aviso

Es una herramienta de análisis, no una recomendación de inversión. Y una
advertencia sobre el número en sí: las correlaciones no se sostienen solas —
suelen dispararse justo cuando más falta hace que no lo hagan.
