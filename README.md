# Correlaciones de ETFs en BYMA

Heatmap interactivo con la correlación entre todos los ETFs que cotizan en BYMA.
Se actualiza solo, todos los días, con el cierre de mercado.

**→ https://ignacio-talento.github.io/byma-etf-correlaciones/**

---

## Qué muestra

Los **58 ETFs** que cotizan en BYMA como CEDEAR, más el **Merval en dólares** como
referencia, correlacionados entre sí por sus retornos diarios. En el tablero se puede:

- cambiar la **ventana** (1 mes a 3 años) y ver cómo cambia la foto;
- pasar de **dólares a pesos**, que le suma el efecto del CCL;
- **ordenar por similitud** (clustering jerárquico), que es lo que hace que los
  bloques de la matriz se lean como grupos y no como ruido;
- filtrar por categoría, resaltar un ticker, y abrir cualquier par para ver su
  **correlación móvil** — si el número de hoy es estable o es un momento suelto;
- ver la **tabla completa** de todos los pares y bajarla en CSV;
- comparar rendimientos acumulados en la vista **base 100**;
- armar una **cartera diversificada por perfil de riesgo** sobre la frontera
  eficiente de Markowitz;
- y ver, en el **backtest walk-forward**, qué habría rendido cada estrategia de
  verdad — con el costo de operar como control en vivo.

### Renta fija en el panel

JPMB (deuda soberana emergente en dólares) y MUB (municipales de EE.UU.) son la
única clase de activo del panel con volatilidad de un dígito bajo: **5,4% y 3,0%**
contra 15-25% del equity. Agregarlos mejoró el perfil de riesgo de todo:
mínima varianza pasó de 12,8% a **9,9%** de volatilidad y de −26,6% a **−22,6%**
de caída máxima; máximo Sharpe, de 19,0% a 16,6% y de −28,2% a −24,7%, con el
mismo Sharpe.

Sumarlos también destapó dos bugs que estaban latentes porque hasta entonces todo
el universo compartía el mismo calendario — ver el historial de commits.

### El Merval en dólares

Se toma `^MERV` (el índice en pesos) y se divide por el CCL del día, y esa serie en
dólares se guarda como cualquier otra. Así la vista en pesos lo recompone sola
sumándole de vuelta el CCL, sin ningún caso especial aguas abajo.

**No es un ETF y no se puede comprar**, así que entra al mapa de correlaciones como
referencia pero queda afuera de la cartera y del backtest: proponer un índice en una
cartera sería proponer algo que no existe como instrumento.

Vale la pena porque es lo más descorrelacionado del panel: contra las últimas 252
ruedas correlaciona **+0,26 con el S&P 500**, +0,30 con Brasil y +0,04 con el oro,
con una volatilidad de 52,9%. El clustering lo ubica solo, entre las acciones
latinoamericanas y los activos de riesgo alto.

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

## La cartera (frontera eficiente)

Markowitz clásico sobre los mismos ETFs: media y covarianza de la ventana,
**sólo posiciones largas** y **tope por activo** (15% por defecto).

El tope no es cosmético. Sin restricciones, maximizar Sharpe sobre ~50 activos
con 252 observaciones concentra todo en dos o tres posiciones: óptimo dentro de
la muestra, inservible fuera. El tope es lo que hace que la cartera resultante
sea efectivamente diversificada.

Los **tres perfiles son tres puntos de la misma frontera**, no tres modelos:

| Perfil | Qué es | Cómo se elige |
|---|---|---|
| Conservador | Mínima varianza | El extremo izquierdo de la frontera |
| Moderado | Máximo Sharpe (cartera tangente) | Donde la recta desde la tasa libre de riesgo toca la frontera |
| Audaz | Más retorno, más riesgo | Sobre la frontera, a mitad de camino en volatilidad entre la tangente y el máximo alcanzable |

Se optimiza **en dólares**: el Sharpe necesita una tasa libre de riesgo y la que
usamos es el T-bill de EE.UU. a 13 semanas (`^IRX`). Una versión en pesos
requeriría una libre de riesgo en pesos, que es otra discusión.

**Sobre el Sharpe que muestra.** Está inflado por construcción: la cartera se
elige mirando el mismo período con el que después se la califica. Por eso al lado
siempre aparece el Sharpe de la cartera equiponderada, que no optimizó nada — esa
diferencia es lo que ganó el optimizador mirando el pasado, no lo que se puede
esperar hacia adelante.

La descorrelación no viene de una regla que la imponga: el optimizador minimiza
`w'Σw`, y la covarianza baja justamente cuando los activos no se mueven juntos.
El tablero reporta la correlación media ponderada de las posiciones contra la del
universo entero, para poder verificarlo.

**Verificación.** El optimizador corre en el navegador (gradiente proyectado con
backtracking sobre el símplex con tope). Sus pesos se compararon contra una
implementación independiente en Python con `scipy.optimize` (SLSQP): coinciden en
retorno, volatilidad, Sharpe y en los once pesos, al segundo decimal.

## Por qué 126 y 252, medido

Las dos ventanas del tablero no son convención: se eligieron midiendo.

**Correlación — 126 ruedas.** Se probó qué ventana predice mejor la correlación
del período siguiente, que es para lo que uno la mira:

| Ventana | Error (horizonte 3m) | Error (horizonte 6m) |
|---|---|---|
| 21 | 0,188 | 0,189 |
| 63 | 0,159 | 0,154 |
| **126** | **0,151** | **0,148** |
| 252 | 0,155 | 0,150 |
| 504 | 0,162 | 0,149 |

**Cartera — 252 ruedas.** Sharpe fuera de muestra, neto de 50 pb por punta:

| | 63 | 126 | **252** | 504 |
|---|---|---|---|---|
| Máximo Sharpe | 0,19 | 0,48 | **0,64** | 0,28 |
| Mínima varianza | 0,29 | 0,49 | **0,59** | 0,54 |
| Paridad de riesgo | 0,53 | 0,53 | 0,54 | **0,58** |

Máximo Sharpe tiene un óptimo marcado y se cae para los dos lados. Paridad es
casi indiferente y sólo prefiere 504 porque rota menos. Una vez que entra el
costo, el ranking lo decide la rotación más que la calidad de la estimación.

**Los tres perfiles comparten la ventana a propósito:** son puntos de la misma
frontera, y con ventanas distintas el gráfico dibujaría tres curvas como si
fueran una.

## Significancia estadística

Una correlación estimada tiene error de muestreo. Con 126 ruedas hace falta pasar
de **±0,17** para separarse de cero al 95% (intervalo de Fisher); con 21 ruedas,
de ±0,43. La casilla *Atenuar lo no significativo* baja el peso visual de lo que
no llega, y la tabla publica el intervalo de cada par.

| Ventana | Umbral | Pares significativos |
|---|---|---|
| 21 | ±0,43 | 46% |
| 63 | ±0,25 | 79% |
| 126 | ±0,17 | 91% |
| 252 | ±0,12 | 92% |

En la vista de diferencia el test es entre dos correlaciones (Fisher para muestras
independientes: las ruedas de caída y las de calma no se solapan). Ahí sólo el
**19%** de los cambios se distingue del ruido — los saltos grandes aguantan
(68 de 69), los chicos no. Con 76 ruedas de caída alcanza para detectar un efecto
grande, no uno chico.

## El orden de lectura

El tablero muestra primero el **backtest** y después la cartera, no al revés. La
cartera optimizada tiene un Sharpe de más de 3 dentro de la muestra; la misma
estrategia, fuera de muestra, da 0,82 y pierde contra comprar el índice apenas
entra el costo. Poner la propuesta antes que la evidencia sugeriría lo contrario
de lo que los datos dicen.

Arriba de la cartera hay un veredicto que cruza las dos cosas: toma el resultado
fuera de muestra de esa misma estrategia y lo compara con el **costo real de
armarla**, calculado con las puntas del panel de BYMA.

Se reporta el **costo de quiebre** —a partir de qué costo la estrategia deja de
superar al índice— y no el Sharpe a un costo puntual. Con 285% de rotación,
meter una punta de 773 pb en el modelo da un Sharpe de −1,29: correcto dentro del
modelo, pero describe un escenario que nadie operaría. El punto de quiebre es
robusto: para máximo Sharpe son **39 pb**, y las puntas de cierre están 20 veces
más arriba, así que la conclusión no depende de cuánto se angosten intradiario.

Se resuelve por bisección sobre el cálculo real, no con la fórmula lineal: el
costo se compone en cada rebalanceo y además mueve la volatilidad.

**Y hay un caso que conviene saber:** mínima varianza no le gana al índice ni
siquiera con costos de cero (0,66 contra 0,67).

## Lo que agrega el panel de cartera

Sobre la cartera optimizada, cuatro lecturas que el peso y el Sharpe no dan:

**Contribución al riesgo.** Un 15% en un ETF de 30% de volatilidad no es la
misma posición que un 15% en uno de 12%. La tabla muestra `%CTR` junto al peso:
en la ventana de sep-2026, XLP pesa 15% y aporta 1,8% del riesgo, mientras EWY
pesa 5,9% y aporta 14,7%. Y las dos medidas de diversificación no coinciden: por
peso la cartera equivale a 8,1 posiciones, por riesgo son **3,9 apuestas
independientes** (entropía sobre componentes principales, Meucci).

**Correlación cuando el mercado cae.** El mapa tiene tres modos de ruedas: todas,
sólo el decil peor del S&P 500, y cuánto sube la correlación entre esos dos
estados. La comparación es contra las ruedas tranquilas del **mismo período**,
para no mezclar el efecto crisis con el del momento. Resultado: la correlación
media del panel **no sube** (+0,33 → +0,31), pero 64 de 1.176 pares suben más de
0,25 y XLE pasa de +0,16 a **+0,76** contra el S&P.

**Estabilidad de los pesos.** Bootstrap por bloques, 150 remuestreos: sólo 3 de
16 posiciones aparecen en 8 de cada 10 muestras.

**Colas.** Máxima caída, CVaR 95% histórico, Sortino, asimetría y curtosis. El
Sharpe supone normalidad y este universo no la tiene.

## Lo que cuesta comprarlo acá

El job guarda a diario el volumen, las operaciones y las puntas del panel de
BYMA. La mediana de la punta a punta al cierre es de **933 pb**: QQQ es la más
ajustada con 184 pb y USO cotiza a 4.006 pb.

Armar la cartera de máximo Sharpe cuesta del orden de **752 pb** ponderado por
peso — y el backtest muestra que pasados los ~100 pb por punta conviene comprar
SPY y no hacer nada. Dicho de otra forma: **la cartera óptima es, con las puntas
de este mercado, imposible de sostener.** Es probablemente la conclusión más
importante de toda la herramienta.

Caveat: son puntas del cierre, más anchas que las intradiarias. Y hoy hay una
sola rueda acumulada; el tablero publica cuántas hay detrás del número.

## El backtest walk-forward

La sección de cartera muestra la mejor combinación *del período que ya pasó*. Eso
no dice nada sobre si la estrategia sirve. El walk-forward responde la otra
pregunta, y es la única parte de la herramienta que es genuinamente fuera de
muestra.

**Protocolo**, estrictamente point-in-time: a cada fin de mes se optimiza usando
sólo las 252 ruedas anteriores, los pesos se aplican **desde el día siguiente** y
se dejan derivar hasta el próximo rebalanceo. El universo es variable en el
tiempo: en cada fecha entran únicamente los ETFs que ya tenían historia ese día
(IBIT y ETHA no existían en 2019 y no aparecen en las carteras de esos años). Se
comparan máximo Sharpe, mínima varianza, paridad de riesgo, 1/N y comprar SPY.

**El resultado, con 109 rebalanceos entre 2017 y 2026:**

| Costo por punta | 0 pb | 20 pb | 50 pb | 100 pb | 200 pb |
|---|---|---|---|---|---|
| Máx. Sharpe (rota 285%/año) | **0,82** | **0,76** | 0,65 | 0,48 | 0,14 |
| Mín. varianza (93%) | 0,66 | 0,62 | 0,56 | 0,47 | 0,28 |
| Paridad de riesgo (54%) | 0,57 | 0,56 | 0,53 | 0,50 | 0,43 |
| 1/N (26%) | 0,60 | 0,59 | 0,58 | 0,57 | 0,54 |
| SPY (no rota) | 0,67 | 0,67 | **0,67** | **0,67** | **0,67** |

Sin fricción el máximo Sharpe gana con comodidad. Pasando los ~50 pb por punta
—perfectamente normal en CEDEARs— **lo mejor es comprar SPY y no hacer nada**, y
pasados los 100 pb el máximo Sharpe queda último. Rota 294% al año: es la única
estrategia cuyo veredicto cambia de signo según el costo, y por eso el costo es
un control en vivo del tablero y no un parámetro escondido.

Además, el máximo Sharpe **le gana a 1/N en sólo 5 de 10 años calendario**: el
promedio lo sostienen 2020 y los dos últimos años. La ventaja no es pareja.

**Sesgo que queda:** el universo son los ETFs que BYMA lista *hoy*, y esa
selección se hizo en parte mirando cuáles anduvieron bien. Empuja para arriba a
todas las estrategias por igual, así que la comparación entre ellas se sostiene;
los niveles absolutos, menos.

Los rebalanceos se cachean en `data/backtest_pesos.csv`: la primera construcción
tarda ~90 segundos y las corridas diarias, menos de un segundo.

### Shrinkage de Ledoit-Wolf: se midió, y aporta poco

La covarianza muestral con 49 activos y 252 observaciones está mal condicionada
(número de condición **305.017**). El shrinkage de Ledoit-Wolf lo baja a **753**.
Suena decisivo. No lo es:

| | sin LW | con LW |
|---|---|---|
| Máx. Sharpe | 0,82 | 0,83 |
| Mín. varianza | 0,66 | 0,66 |
| Rotación de mín. varianza | 93% | 83% |

El aporte al Sharpe es marginal. Donde sí sirve es en la **rotación**, y dado
cuánto pesa el costo, esa es la parte que termina valiendo algo. La intensidad de
shrinkage que estima el método es baja (media 3,8%), coherente con que T/N ≈ 5 no
es un régimen crítico. La implementación en Python puro está verificada contra
`sklearn.covariance.ledoit_wolf`: coinciden a 4e-17.

### El tope resultó mucho más importante que el shrinkage

Corriendo el mismo walk-forward con distintos topes:

| Máx. Sharpe | tope 15% | 25% | 50% | sin tope |
|---|---|---|---|---|
| Sharpe | **0,82** | 0,77 | 0,66 | 0,64 |

Apretar el tope vale ~20 veces más que el shrinkage. Probé la hipótesis de que el
tope estuviera tapando el beneficio del shrinkage y **no se confirmó**: el
shrinkage sigue marginal con todos los topes, incluso sin tope. La explicación
más probable es que la restricción de sólo-largo —presente en todas las
corridas— ya esté regularizando, que es el mecanismo de Jagannathan y Ma (2003);
pero este experimento no lo aísla y queda como hipótesis.

### Estabilidad de los pesos: casi ninguno es señal

El panel de cartera remuestrea la ventana por **bloques de 10 ruedas** —para no
romper el agrupamiento de volatilidad— y reoptimiza 150 veces. Con la ventana de
sep-2026:

- sólo **3 de 16** posiciones aparecen en 8 de cada 10 remuestreos;
- la frecuencia media de inclusión es **52%**;
- XLP e IBB tienen peso 15% y un rango p10–p90 de **0% a 15%**;
- EWZ pesa **cero** en la cartera propuesta y aparece en el 33% de las muestras,
  con hasta 14,3%;
- el único peso robusto es USO (aparece en el 97%).

Es la conclusión más útil de toda la herramienta: los pesos puntuales no son una
recomendación, son una de muchas soluciones casi equivalentes.

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
universo.json                 los 59 instrumentos: nombre, categoría y driver (se edita a mano)
data/backtest_universo.json   huella del universo con que se calculó la caché
scripts/fuentes.py            acceso a BYMA, Yahoo y el CCL
scripts/actualizar.py         baja, acumula y publica el dataset
data/precios.csv              historia acumulada de cierres (el log de git es la auditoría)
data/ccl.csv                  serie del contado con liquidación
data/tasa_libre_riesgo.csv    T-bill EE.UU. 13 semanas, para el Sharpe
data/no_son_etf.json          caché del barrido de altas de BYMA
docs/                         el sitio (GitHub Pages)
docs/cartera.js               frontera eficiente y perfiles de riesgo
docs/backtest.js              curvas walk-forward y sensibilidad al costo
docs/base100.js               vista de rendimiento acumulado, base 100
scripts/backtest.py           motor del walk-forward (precalcula el backtest)
data/backtest_pesos.csv       cache de los pesos de cada rebalanceo
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
| Tasa libre de riesgo | T-bill EE.UU. 13 semanas (`^IRX`), Yahoo Finance |

## Aviso

Es una herramienta de análisis, no una recomendación de inversión. Y una
advertencia sobre el número en sí: las correlaciones no se sostienen solas —
suelen dispararse justo cuando más falta hace que no lo hagan.
