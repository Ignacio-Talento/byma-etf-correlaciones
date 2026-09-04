/* Correlaciones de ETFs en BYMA
   El dataset trae los retornos diarios; las correlaciones se calculan aca,
   asi cambiar de ventana o de moneda es instantaneo y no hay que precomputar
   una matriz por cada combinacion. */

'use strict';

const MIN_RUEDAS = 20;      // por debajo de esto una correlacion no dice nada
const CELDA_MIN = 11;
const CELDA_MAX = 30;
const GUTTER = 66;          // lugar para las etiquetas de fila/columna

const estado = {
  datos: null,
  ventana: 126,
  ruedas: 'todas',        // 'todas' | 'estres' | 'diferencia'
  moneda: 'usd',
  orden: 'cluster',
  categorias: new Set(),
  busqueda: '',
  vista: 'mapa',
  soloSig: false,           // atenuar lo que no se distingue del ruido
  sel: null,                // [a, b] del par seleccionado
  ordenTabla: { col: 'rho', desc: true },
  tickers: [],              // orden vigente en el mapa
  matriz: null,
};

/* Los modulos (cartera, backtest, base 100) se cargan en scripts aparte y
   necesitan que el dataset ya este. Pero `iniciar()` es asincrona: al volver
   del fetch puede retomar ENTRE la ejecucion de dos de esos scripts, y
   entonces el que todavia no cargo se saltea sin ruido. Este registro
   funciona en los dos ordenes: el que llega tarde se ejecuta al registrarse. */
window.__datosListos = false;
window.__initPendientes = [];
window.alHaberDatos = function (fn) {
  if (window.__datosListos) fn();
  else window.__initPendientes.push(fn);
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ------------------------------------------------------------- color --- */
/* Interpolacion en OKLab: en RGB el punto medio de azul->gris->rojo se
   ensucia y los brazos no pesan igual. */

const srgbALineal = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linealASrgb = (c) => {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

function hexAOklab(hex) {
  const h = hex.trim().replace('#', '');
  const r = srgbALineal(parseInt(h.slice(0, 2), 16) / 255);
  const g = srgbALineal(parseInt(h.slice(2, 4), 16) / 255);
  const b = srgbALineal(parseInt(h.slice(4, 6), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabAHex(L, A, B) {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const px = (v) => Math.round(linealASrgb(v) * 255).toString(16).padStart(2, '0');
  return '#' + px(r) + px(g) + px(b);
}

let POLOS = null;
function leerPolos() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  POLOS = {
    neg: hexAOklab(v('--polo-neg')),
    pos: hexAOklab(v('--polo-pos')),
    medio: hexAOklab(v('--medio')),
    medioHex: v('--medio'),
  };
}

/** Hasta donde llega la escala. En modo diferencia los valores viven en un
    rango mucho mas chico que [-1,1]: con el dominio completo serian todos gris. */
function dominioEscala() {
  return estado.ruedas === 'diferencia' ? 0.5 : 1;
}

/** Color de una correlacion: gris neutro en 0, azul al polo negativo, rojo al positivo. */
function colorRho(rho) {
  if (rho === null || rho === undefined || Number.isNaN(rho)) return 'transparent';
  const k = Math.min(1, Math.abs(rho) / dominioEscala());
  const polo = rho < 0 ? POLOS.neg : POLOS.pos;
  const m = POLOS.medio;
  return oklabAHex(
    m[0] + (polo[0] - m[0]) * k,
    m[1] + (polo[1] - m[1]) * k,
    m[2] + (polo[2] - m[2]) * k,
  );
}

/** Luminosidad aproximada, para decidir tinta clara u oscura sobre la celda. */
function tintaSobre(hex) {
  const h = hex.replace('#', '');
  const lum = 0.2126 * srgbALineal(parseInt(h.slice(0, 2), 16) / 255)
            + 0.7152 * srgbALineal(parseInt(h.slice(2, 4), 16) / 255)
            + 0.0722 * srgbALineal(parseInt(h.slice(4, 6), 16) / 255);
  return lum > 0.35 ? '#002060' : '#FFFFFF';   // navy de marca, no negro
}

/* ------------------------------------------------------------ calculo --- */

/** Retornos del ticker en la moneda elegida.
    En pesos se compone con el CCL; como son logaritmicos, se suman. */
function retornos(tk) {
  const r = estado.datos.etfs[tk].ret;
  if (estado.moneda === 'usd') return r;
  const c = estado.datos.ccl.ret;
  const out = new Array(r.length);
  for (let i = 0; i < r.length; i++) {
    out[i] = (r[i] === null || c[i] === null) ? null : r[i] + c[i];
  }
  return out;
}

/** Pearson sobre un conjunto explicito de ruedas.
    Recibe indices en vez de un punto de inicio porque las ruedas de estres no
    son un tramo contiguo: son los peores dias del S&P, dispersos en el tiempo. */
function correlacion(xs, ys, indices) {
  let n = 0, sx = 0, sy = 0;
  for (const i of indices) {
    const a = xs[i], b = ys[i];
    if (a === null || b === null || a === undefined || b === undefined) continue;
    n++; sx += a; sy += b;
  }
  if (n < MIN_RUEDAS) return { rho: null, n };
  const mx = sx / n, my = sy / n;
  let vxy = 0, vx = 0, vy = 0;
  for (const i of indices) {
    const a = xs[i], b = ys[i];
    if (a === null || b === null || a === undefined || b === undefined) continue;
    const da = a - mx, db = b - my;
    vxy += da * db; vx += da * da; vy += db * db;
  }
  if (vx <= 0 || vy <= 0) return { rho: null, n };
  return { rho: vxy / Math.sqrt(vx * vy), n };
}

/* ------------------------------------------------- significancia --- */

/** Umbral por encima del cual una correlacion se distingue de cero al 95%.
    Sale de la transformada z de Fisher: z = atanh(rho) es aproximadamente
    normal con desvio 1/sqrt(n-3), asi que el umbral es tanh(1,96/sqrt(n-3)).
    Con 126 ruedas da 0,17: TODA celda entre -0,17 y +0,17 es, estadisticamente,
    indistinguible de que no haya ninguna relacion. */
function umbralRho(n) {
  if (!n || n < 5) return 1;
  return Math.tanh(1.96 / Math.sqrt(n - 3));
}

/** Intervalo de confianza al 95% de una correlacion, via Fisher. */
function intervaloRho(rho, n) {
  if (rho === null || !n || n < 5) return null;
  const z = Math.atanh(Math.max(-0.9999, Math.min(0.9999, rho)));
  const se = 1 / Math.sqrt(n - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/** En modo diferencia lo que se testea es si DOS correlaciones difieren, no
    si una difiere de cero. Es el test de Fisher para muestras independientes:
    las ruedas de estres y las de calma no se solapan. */
function difSignificativa(rhoA, nA, rhoB, nB) {
  if (rhoA === null || rhoB === null || nA < 5 || nB < 5) return false;
  const z = (r) => Math.atanh(Math.max(-0.9999, Math.min(0.9999, r)));
  const se = Math.sqrt(1 / (nA - 3) + 1 / (nB - 3));
  return Math.abs(z(rhoA) - z(rhoB)) / se > 1.96;
}

/** Indices [desde, fin) como array, para el caso normal de una ventana. */
function rango(desde, hasta) {
  const out = [];
  for (let i = desde; i < hasta; i++) out.push(i);
  return out;
}

/** Las ruedas del decil peor del S&P 500 sobre TODO el historico publicado.
    No se limita a la ventana elegida a proposito: en 126 ruedas el decil peor
    son 13 dias, con los que no se puede estimar una correlacion. Sobre los tres
    anios publicados son ~76, que ya es un numero con el que se puede trabajar. */
let _estres = null;
function ruedasDeEstres() {
  if (_estres) return _estres;
  const spy = estado.datos.etfs.SPY;
  if (!spy) return (_estres = { indices: [], umbral: null });
  const conDato = [];
  spy.ret.forEach((r, i) => { if (r !== null) conDato.push({ i, r }); });
  conDato.sort((a, b) => a.r - b.r);
  const corte = Math.max(MIN_RUEDAS, Math.round(conDato.length * 0.10));
  const peores = conDato.slice(0, corte);
  _estres = {
    indices: peores.map((p) => p.i).sort((a, b) => a - b),
    umbral: peores[peores.length - 1].r,
    peor: peores[0].r,
  };
  return _estres;
}

/** Las ruedas restantes del MISMO periodo: la comparacion contra el estres
    tiene que ser contra calma del mismo tramo, no contra la ventana elegida.
    Si no, la diferencia mezclaria el efecto crisis con el efecto periodo. */
let _calma = null;
function ruedasDeCalma() {
  if (_calma) return _calma;
  const est = new Set(ruedasDeEstres().indices);
  const spy = estado.datos.etfs.SPY;
  _calma = [];
  if (spy) spy.ret.forEach((r, i) => { if (r !== null && !est.has(i)) _calma.push(i); });
  return _calma;
}

/** Ruedas que entran en el calculo, segun el modo elegido. */
function indicesVigentes() {
  const largo = estado.datos.fechas.length;
  if (estado.ruedas === 'todas') return rango(Math.max(0, largo - estado.ventana), largo);
  return ruedasDeEstres().indices;
}

/** Matriz completa para los tickers dados. */
function matrizSobre(series, indices, diagonal) {
  const N = series.length;
  const rho = Array.from({ length: N }, () => new Array(N).fill(null));
  const cnt = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    rho[i][i] = diagonal;
    for (let j = i + 1; j < N; j++) {
      const r = correlacion(series[i], series[j], indices);
      rho[i][j] = rho[j][i] = r.rho;
      cnt[i][j] = cnt[j][i] = r.n;
    }
    cnt[i][i] = correlacion(series[i], series[i], indices).n;
  }
  return { rho, cnt };
}

/** Matriz completa para los tickers dados, segun el modo de ruedas elegido. */
function calcularMatriz(tickers) {
  const series = tickers.map(retornos);
  const largo = estado.datos.fechas.length;
  const enVentana = rango(Math.max(0, largo - estado.ventana), largo);

  const conSig = (m) => {
    const N = series.length;
    const sig = Array.from({ length: N }, () => new Array(N).fill(false));
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        sig[i][j] = m.rho[i][j] !== null && Math.abs(m.rho[i][j]) > umbralRho(m.cnt[i][j]);
      }
    }
    return { ...m, sig };
  };

  if (estado.ruedas === 'todas') return conSig(matrizSobre(series, enVentana, 1));

  const est = matrizSobre(series, ruedasDeEstres().indices, 1);
  if (estado.ruedas === 'estres') return conSig(est);

  // Diferencia: cuanto sube la correlacion cuando el mercado cae fuerte.
  // La base son las ruedas de calma del MISMO periodo, no la ventana elegida:
  // comparar contra otro tramo confundiria el efecto crisis con el del periodo.
  const todo = matrizSobre(series, ruedasDeCalma(), 1);
  const N = series.length;
  const rho = Array.from({ length: N }, () => new Array(N).fill(null));
  const sig = Array.from({ length: N }, () => new Array(N).fill(false));
  for (let i = 0; i < N; i++) {
    rho[i][i] = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      rho[i][j] = (est.rho[i][j] === null || todo.rho[i][j] === null)
        ? null : est.rho[i][j] - todo.rho[i][j];
      sig[i][j] = difSignificativa(est.rho[i][j], est.cnt[i][j],
                                   todo.rho[i][j], todo.cnt[i][j]);
    }
  }
  return { rho, cnt: est.cnt, sig, esDiferencia: true, base: todo, estres: est };
}

/** Correlacion movil del par, para ver si el numero de hoy es estable. */
function correlacionMovil(a, b, ventana, maxPuntos) {
  const xs = retornos(a), ys = retornos(b);
  const N = xs.length;
  const pts = [];
  const inicio = Math.max(ventana, N - maxPuntos);
  for (let t = inicio; t <= N; t++) {
    const { rho } = correlacion(xs, ys, rango(t - ventana, t));
    pts.push({ i: t - 1, rho });
  }
  return pts;
}

/* --------------------------------------------------- orden del mapa --- */

/** Clustering jerarquico de enlace promedio sobre distancia 1 - rho.
    Agrupa lo que se mueve junto, que es lo que hace legible un heatmap:
    sin esto la matriz es ruido ordenado alfabeticamente. */
function ordenPorSimilitud(tickers, rho) {
  const N = tickers.length;
  if (N < 3) return tickers.slice();

  let clusters = tickers.map((_, i) => ({ hojas: [i], miembros: [i] }));
  const dist = (A, B) => {
    let s = 0, n = 0;
    for (const i of A.miembros) for (const j of B.miembros) {
      const r = rho[i][j];
      if (r !== null) { s += 1 - r; n++; }
    }
    return n ? s / n : 1;
  };

  while (clusters.length > 1) {
    let mejor = Infinity, pa = 0, pb = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist(clusters[i], clusters[j]);
        if (d < mejor) { mejor = d; pa = i; pb = j; }
      }
    }
    const A = clusters[pa], B = clusters[pb];
    // Orientamos cada rama para que los extremos que se tocan sean los mas
    // parecidos: asi el degrade cruza el borde sin saltos.
    const ext = (c, cual) => c.hojas[cual === 'ini' ? 0 : c.hojas.length - 1];
    const d = (x, y) => (rho[x][y] === null ? 1 : 1 - rho[x][y]);
    const combos = [
      { v: d(ext(A, 'fin'), ext(B, 'ini')), a: A.hojas, b: B.hojas },
      { v: d(ext(A, 'fin'), ext(B, 'fin')), a: A.hojas, b: B.hojas.slice().reverse() },
      { v: d(ext(A, 'ini'), ext(B, 'ini')), a: A.hojas.slice().reverse(), b: B.hojas },
      { v: d(ext(A, 'ini'), ext(B, 'fin')), a: A.hojas.slice().reverse(), b: B.hojas.slice().reverse() },
    ].sort((x, y) => x.v - y.v)[0];

    clusters = clusters.filter((_, i) => i !== pa && i !== pb);
    clusters.push({ hojas: combos.a.concat(combos.b), miembros: A.miembros.concat(B.miembros) });
  }
  return clusters[0].hojas.map((i) => tickers[i]);
}

function categoriasOrdenadas() {
  const orden = ['Indice amplio EE.UU.', 'Factor / Estilo', 'Sectorial EE.UU.', 'Tematico',
                 'Internacional', 'Commodities y metales', 'Cripto', 'Apalancado / Inverso',
                 'Renta fija', 'Indice local'];
  const presentes = new Set(Object.values(estado.datos.etfs).map((e) => e.categoria));
  const out = orden.filter((c) => presentes.has(c));
  for (const c of presentes) if (!out.includes(c)) out.push(c);
  return out;
}

function tickersVisibles() {
  const E = estado.datos.etfs;
  return Object.keys(E)
    .filter((tk) => estado.categorias.has(E[tk].categoria))
    .sort();
}

function ordenarTickers(tickers, rho) {
  if (estado.orden === 'alfabetico') return tickers.slice().sort();
  if (estado.orden === 'categoria') {
    const cats = categoriasOrdenadas();
    return tickers.slice().sort((a, b) => {
      const da = cats.indexOf(estado.datos.etfs[a].categoria);
      const db = cats.indexOf(estado.datos.etfs[b].categoria);
      return da !== db ? da - db : a.localeCompare(b);
    });
  }
  return ordenPorSimilitud(tickers, rho);
}

/* ----------------------------------------------------------- formato --- */

const fmtRho = (r) => (r === null ? 's/d' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2));
const fmtRho3 = (r) => (r === null ? 's/d' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(3));

function fechaCorta(iso) {
  if (!iso) return '—';
  const [a, m, d] = iso.split('-');
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${+d} ${meses[+m - 1]} ${a}`;
}

function lecturaRho(r) {
  if (r === null) return 'sin datos suficientes';
  if (estado.ruedas === 'diferencia') {
    if (r >= 0.30) return 'la diversificacion se evapora en las caidas';
    if (r >= 0.15) return 'se juntan bastante cuando el mercado cae';
    if (r > -0.05) return 'se comportan parecido en calma y en caida';
    if (r > -0.15) return 'se separan un poco en las caidas';
    return 'se separan en las caidas: cubre mejor de lo que aparenta';
  }
  if (r >= 0.9) return 'practicamente el mismo activo';
  if (r >= 0.7) return 'se mueven muy parecido';
  if (r >= 0.4) return 'se acompanian bastante';
  if (r >= 0.15) return 'se acompanian poco';
  if (r > -0.15) return 'no se acompanian';
  if (r > -0.4) return 'se compensan un poco';
  if (r > -0.7) return 'se compensan bastante';
  return 'se mueven al reves';
}

function coincide(tk) {
  const q = estado.busqueda.trim().toLowerCase();
  if (!q) return true;
  const e = estado.datos.etfs[tk];
  return tk.toLowerCase().includes(q)
      || e.nombre.toLowerCase().includes(q)
      || e.categoria.toLowerCase().includes(q);
}

/* -------------------------------------------------------- render mapa --- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (n, attrs = {}) => {
  const x = document.createElementNS(SVG_NS, n);
  for (const k in attrs) x.setAttribute(k, attrs[k]);
  return x;
};

function dibujarMapa() {
  const svg = $('#mapa');
  svg.textContent = '';
  const tickers = estado.tickers;
  const N = tickers.length;
  if (!N) {
    $('#nota-mapa').textContent = 'No hay ETFs seleccionados. Activá al menos una categoría.';
    svg.setAttribute('width', 0); svg.setAttribute('height', 0);
    return;
  }

  const disp = $('#mapa-scroll').clientWidth || 900;
  const celda = Math.max(CELDA_MIN, Math.min(CELDA_MAX, Math.floor((disp - GUTTER - 8) / N)));
  const lado = celda * N;
  const W = GUTTER + lado + 4, H = GUTTER + lado + 4;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const { rho, cnt, sig } = estado.matriz;
  const hayBusqueda = estado.busqueda.trim() !== '';
  const marca = tickers.map(coincide);
  const mostrarValor = celda >= 24;

  // --- celdas
  const gCeldas = el('g');
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const r = rho[i][j];
      const col = colorRho(r);
      const rect = el('rect', {
        x: GUTTER + j * celda, y: GUTTER + i * celda,
        width: celda, height: celda, fill: col, class: 'celda',
      });
      if (r === null) {
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', 'var(--linea)');
      }
      if (hayBusqueda && !(marca[i] || marca[j])) rect.classList.add('apagada');
      // Lo que no se distingue de cero no puede pintarse igual que lo que si:
      // el color estaria afirmando una relacion que el dato no sostiene.
      if (estado.soloSig && sig && i !== j && !sig[i][j]) rect.classList.add('ruido');
      rect.dataset.i = i; rect.dataset.j = j;
      gCeldas.appendChild(rect);

      if (mostrarValor && r !== null && i !== j) {
        const t = el('text', {
          x: GUTTER + j * celda + celda / 2, y: GUTTER + i * celda + celda / 2 + 3,
          'text-anchor': 'middle', class: 'valor', fill: tintaSobre(col),
        });
        t.textContent = r.toFixed(2).replace('0.', '.').replace('-', '−');
        gCeldas.appendChild(t);
      }
    }
  }
  svg.appendChild(gCeldas);

  // --- separadores entre categorias (solo cuando el orden las agrupa)
  if (estado.orden === 'categoria') {
    const gs = el('g');
    for (let i = 1; i < N; i++) {
      if (estado.datos.etfs[tickers[i]].categoria !== estado.datos.etfs[tickers[i - 1]].categoria) {
        gs.appendChild(el('line', { x1: GUTTER, y1: GUTTER + i * celda, x2: GUTTER + lado, y2: GUTTER + i * celda, class: 'sep' }));
        gs.appendChild(el('line', { x1: GUTTER + i * celda, y1: GUTTER, x2: GUTTER + i * celda, y2: GUTTER + lado, class: 'sep' }));
      }
    }
    svg.appendChild(gs);
  }

  // --- etiquetas
  const gEtq = el('g');
  tickers.forEach((tk, i) => {
    const yf = el('text', {
      x: GUTTER - 6, y: GUTTER + i * celda + celda / 2 + 3.5,
      'text-anchor': 'end', class: 'etiqueta', 'data-fila': i,
    });
    yf.textContent = tk;
    if (hayBusqueda && !marca[i]) yf.classList.add('atenuada');
    gEtq.appendChild(yf);

    const xc = GUTTER + i * celda + celda / 2;
    const xf = el('text', {
      x: xc, y: GUTTER - 6, 'text-anchor': 'start', class: 'etiqueta',
      'data-col': i, transform: `rotate(-90 ${xc} ${GUTTER - 6})`,
    });
    xf.textContent = tk;
    if (hayBusqueda && !marca[i]) xf.classList.add('atenuada');
    gEtq.appendChild(xf);
  });
  svg.appendChild(gEtq);

  // --- capa de resaltado (cruz + marco), se mueve sin volver a dibujar
  const gHi = el('g', { id: 'capa-hi' });
  gHi.appendChild(el('rect', { id: 'banda-fila', class: 'banda-hi', width: 0, height: 0 }));
  gHi.appendChild(el('rect', { id: 'banda-col', class: 'banda-hi', width: 0, height: 0 }));
  gHi.appendChild(el('rect', { id: 'marco', class: 'marco', width: 0, height: 0 }));
  svg.appendChild(gHi);

  svg._geo = { celda, N, tickers, rho, cnt };
  pintarSeleccion();

  const pares = N * (N - 1) / 2;
  let sigN = 0, nMediana = 0;
  if (sig) {
    const ns = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (rho[i][j] === null) continue;
        if (sig[i][j]) sigN++;
        ns.push(cnt[i][j]);
      }
    }
    ns.sort((x, y) => x - y);
    nMediana = ns[Math.floor(ns.length / 2)] || 0;
  }
  const umb = umbralRho(nMediana);
  const falsos = Math.round(pares * 0.05);
  $('#nota-mapa').innerHTML =
    `${N} instrumentos, ${pares.toLocaleString('es-AR')} pares. La diagonal es cada uno consigo mismo. `
    + (mostrarValor ? '' : 'Pasá el mouse por una celda para ver el valor, o abrí la vista de tabla. ')
    + (sig && nMediana
      ? `<br>Con ${nMediana} ruedas, hace falta pasar de <strong>${fmtRho(umb).replace('+', '±')}</strong> `
        + `para distinguirse de cero al 95%: <strong>${sigN.toLocaleString('es-AR')}</strong> de `
        + `${pares.toLocaleString('es-AR')} pares lo logran. Ojo con el problema de las pruebas `
        + `múltiples: testeando tantos pares a la vez, unos ${falsos.toLocaleString('es-AR')} `
        + `pasarían el filtro por puro azar.`
      : '');
}

function moverResaltado(i, j) {
  const svg = $('#mapa'); const g = svg._geo;
  if (!g) return;
  const { celda, N } = g;
  const bf = $('#banda-fila'), bc = $('#banda-col'), mk = $('#marco');
  if (i === null) {
    [bf, bc, mk].forEach((x) => x && x.setAttribute('width', 0));
    $$('#mapa .etiqueta').forEach((t) => t.classList.remove('act'));
    return;
  }
  bf.setAttribute('x', GUTTER); bf.setAttribute('y', GUTTER + i * celda);
  bf.setAttribute('width', celda * N); bf.setAttribute('height', celda);
  bc.setAttribute('x', GUTTER + j * celda); bc.setAttribute('y', GUTTER);
  bc.setAttribute('width', celda); bc.setAttribute('height', celda * N);
  mk.setAttribute('x', GUTTER + j * celda); mk.setAttribute('y', GUTTER + i * celda);
  mk.setAttribute('width', celda); mk.setAttribute('height', celda);
  $$('#mapa .etiqueta').forEach((t) => {
    const f = t.dataset.fila, c = t.dataset.col;
    t.classList.toggle('act', (f !== undefined && +f === i) || (c !== undefined && +c === j));
  });
}

function celdaDesdeEvento(ev) {
  const svg = $('#mapa'); const g = svg._geo;
  if (!g) return null;
  const r = svg.getBoundingClientRect();
  const esc = r.width / (svg.viewBox.baseVal.width || r.width);
  const x = (ev.clientX - r.left) / esc, y = (ev.clientY - r.top) / esc;
  const j = Math.floor((x - GUTTER) / g.celda), i = Math.floor((y - GUTTER) / g.celda);
  if (i < 0 || j < 0 || i >= g.N || j >= g.N) return null;
  return { i, j };
}

/* --------------------------------------------------------- tooltip --- */

function mostrarTooltip(ev, i, j) {
  const g = $('#mapa')._geo;
  const a = g.tickers[i], b = g.tickers[j];
  const r = g.rho[i][j], n = g.cnt[i][j];
  const tt = $('#tooltip');
  const E = estado.datos.etfs;
  const esDif = estado.matriz.esDiferencia;
  const sg = estado.matriz.sig;
  let extra = '';
  if (i !== j && r !== null) {
    if (esDif) {
      const dif = sg && sg[i][j];
      extra = `<div class="tt-meta">${dif ? 'El cambio es significativo al 95%'
        : 'El cambio NO se distingue del ruido'}</div>`;
    } else {
      const ic = intervaloRho(r, n);
      const distinto = sg ? sg[i][j] : Math.abs(r) > umbralRho(n);
      extra = ic ? `<div class="tt-meta">Intervalo 95%: ${fmtRho(ic[0])} a ${fmtRho(ic[1])}`
        + `${distinto ? '' : ' — <strong>no se distingue de cero</strong>'}</div>` : '';
    }
  }
  tt.innerHTML = i === j
    ? `<div class="tt-par">${a}</div><div class="tt-meta">${E[a].nombre}</div>`
    : `<div class="tt-par">${a} <span style="opacity:.5">vs</span> ${b}</div>`
      + `<div class="tt-rho" style="color:${r === null ? 'inherit' : colorRho(r)}">${fmtRho(r)}</div>`
      + `<div class="tt-meta">${lecturaRho(r)} &middot; ${n} ruedas</div>` + extra;
  tt.hidden = false;
  const m = 14, w = tt.offsetWidth, h = tt.offsetHeight;
  let x = ev.clientX + m, y = ev.clientY + m;
  if (x + w > innerWidth - 8) x = ev.clientX - w - m;
  if (y + h > innerHeight - 8) y = ev.clientY - h - m;
  tt.style.left = x + 'px'; tt.style.top = y + 'px';
}

const ocultarTooltip = () => { $('#tooltip').hidden = true; };

/* --------------------------------------------------------- detalle --- */

function pintarSeleccion() {
  if (!estado.sel) return;
  const g = $('#mapa')._geo;
  if (!g) return;
  const i = g.tickers.indexOf(estado.sel[0]), j = g.tickers.indexOf(estado.sel[1]);
  if (i >= 0 && j >= 0) moverResaltado(i, j);
}

function seleccionar(a, b) {
  if (a === b) return;
  estado.sel = [a, b];
  const E = estado.datos.etfs;
  const xs = retornos(a), ys = retornos(b);
  const { rho, n } = correlacion(xs, ys, indicesVigentes());

  $('#detalle-vacio').hidden = true;
  $('#detalle').hidden = false;
  $('#det-a').textContent = a;
  $('#det-b').textContent = b;
  $('#det-a-desc').textContent = `${a} — ${E[a].nombre}`;
  $('#det-b-desc').textContent = `${b} — ${E[b].nombre}`;
  const c = $('#det-rho');
  c.textContent = fmtRho3(rho);
  c.style.color = rho === null ? 'var(--tinta-apagada)' : colorRho(rho);
  $('#det-lectura').textContent = lecturaRho(rho);
  $('#det-n').textContent = n;
  $('#det-ventana-lbl').textContent = `de ${estado.ventana} ruedas`;

  const pts = correlacionMovil(a, b, estado.ventana, 504);
  const vals = pts.map((p) => p.rho).filter((v) => v !== null);
  $('#det-min').textContent = vals.length ? fmtRho(Math.min(...vals)) : '—';
  $('#det-max').textContent = vals.length ? fmtRho(Math.max(...vals)) : '—';
  dibujarMovil(pts);
  pintarSeleccion();
}

function dibujarMovil(pts) {
  const svg = $('#movil');
  svg.textContent = '';
  const W = svg.clientWidth || 288, H = 88, pad = 4;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const validos = pts.filter((p) => p.rho !== null);
  if (validos.length < 2) return;

  const X = (k) => pad + (k / (pts.length - 1)) * (W - pad * 2);
  const Y = (r) => pad + ((1 - r) / 2) * (H - pad * 2);

  // linea del cero: la referencia que importa en una correlacion
  svg.appendChild(el('line', {
    x1: pad, y1: Y(0), x2: W - pad, y2: Y(0),
    stroke: 'var(--eje)', 'stroke-width': 1,
  }));

  let d = '';
  pts.forEach((p, k) => {
    if (p.rho === null) { d += ''; return; }
    d += (d === '' ? 'M' : 'L') + X(k).toFixed(1) + ' ' + Y(p.rho).toFixed(1);
  });
  svg.appendChild(el('path', {
    d, fill: 'none', stroke: 'var(--acento)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  const ult = validos[validos.length - 1];
  svg.appendChild(el('circle', {
    cx: X(pts.indexOf(ult)), cy: Y(ult.rho), r: 3.5,
    fill: colorRho(ult.rho), stroke: 'var(--superficie)', 'stroke-width': 2,
  }));

  const fechas = estado.datos.fechas;
  $('#movil-desde').textContent = fechaCorta(fechas[pts[0].i]);
  $('#movil-hasta').textContent = fechaCorta(fechas[ult.i]);
}

/* --------------------------------------------------------- extremos --- */

function pares() {
  const { rho, cnt, sig } = estado.matriz;
  const tk = estado.tickers;
  const out = [];
  for (let i = 0; i < tk.length; i++) {
    for (let j = i + 1; j < tk.length; j++) {
      if (rho[i][j] !== null) {
        out.push({ a: tk[i], b: tk[j], rho: rho[i][j], n: cnt[i][j],
                   sig: sig ? sig[i][j] : null, i, j });
      }
    }
  }
  return out;
}

function dibujarExtremos() {
  // Los apalancados e inversos quedan fuera de esta lista: SH contra SPY da
  // -1 por construccion, no porque diversifique, y si entran copan los dos
  // extremos y tapan los pares que si dicen algo. Siguen en el mapa y en la
  // tabla, que es donde corresponde verlos.
  const E = estado.datos.etfs;
  const mecanico = (tk) => E[tk].categoria === 'Apalancado / Inverso';
  const todos = pares();
  const ps = todos.filter((p) => !mecanico(p.a) && !mecanico(p.b))
                  .sort((x, y) => y.rho - x.rho);
  const excluidos = todos.length - ps.length;
  const pie = $('#nota-extremos');
  if (pie) {
    pie.textContent = excluidos
      ? `No se listan ${excluidos.toLocaleString('es-AR')} pares con apalancados o inversos: su correlación es mecánica.`
      : '';
  }
  const fila = (p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="par-tks">${p.a} <span class="sep-tk">/</span> ${p.b}</span>`
      + `<span class="pastilla" style="background:${colorRho(p.rho)};color:${tintaSobre(colorRho(p.rho))}">${fmtRho(p.rho)}</span>`;
    li.addEventListener('click', () => seleccionar(p.a, p.b));
    return li;
  };
  const alta = $('#lista-alta'), baja = $('#lista-baja');
  alta.textContent = ''; baja.textContent = '';
  ps.slice(0, 6).forEach((p) => alta.appendChild(fila(p)));
  ps.slice(-6).reverse().forEach((p) => baja.appendChild(fila(p)));
}

/* ------------------------------------------------------------ tabla --- */

function dibujarTabla() {
  const cuerpo = $('#tabla-pares tbody');
  cuerpo.textContent = '';
  const { col, desc } = estado.ordenTabla;
  const ps = pares().sort((x, y) => {
    const v = (col === 'rho' || col === 'n') ? x[col] - y[col] : String(x[col]).localeCompare(String(y[col]));
    return desc ? -v : v;
  });
  const E = estado.datos.etfs;
  const frag = document.createDocumentFragment();
  for (const p of ps) {
    const tr = document.createElement('tr');
    const c = colorRho(p.rho);
    const ic = estado.matriz.esDiferencia ? null : intervaloRho(p.rho, p.n);
    if (estado.soloSig && p.sig === false) tr.classList.add('fila-ruido');
    tr.innerHTML =
      `<td><span class="tk">${p.a}</span> <span class="tk-desc">${E[p.a].nombre}</span></td>`
      + `<td><span class="tk">${p.b}</span> <span class="tk-desc">${E[p.b].nombre}</span></td>`
      + `<td class="num"><span class="pastilla" style="background:${c};color:${tintaSobre(c)}">${fmtRho3(p.rho)}</span></td>`
      + `<td class="num">${p.n}</td>`
      + `<td class="num tenue">${ic ? `${fmtRho(ic[0])} a ${fmtRho(ic[1])}` : '—'}`
        + `${p.sig === false ? ' <span class="marca-ruido">ruido</span>' : ''}</td>`;
    tr.addEventListener('click', () => seleccionar(p.a, p.b));
    frag.appendChild(tr);
  }
  cuerpo.appendChild(frag);
  $('#nota-tabla').textContent =
    `${ps.length.toLocaleString('es-AR')} pares, ventana de ${estado.ventana} ruedas, `
    + `en ${estado.moneda === 'usd' ? 'dolares' : 'pesos'}. Clic en el encabezado para reordenar.`;
}

function descargarCSV() {
  const filas = [['etf_a', 'etf_b', 'correlacion', 'ruedas', 'ventana', 'moneda', 'ultimo_cierre']];
  for (const p of pares()) {
    filas.push([p.a, p.b, p.rho.toFixed(6), p.n, estado.ventana, estado.moneda, estado.datos.ultimaRueda]);
  }
  const csv = filas.map((f) => f.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `correlaciones-etf-byma-${estado.datos.ultimaRueda}-${estado.ventana}r-${estado.moneda}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------ chrome --- */

function dibujarLeyenda() {
  const d = dominioEscala();
  const paradas = [];
  for (let k = 0; k <= 20; k++) {
    const r = -d + (k / 20) * 2 * d;
    paradas.push(`${colorRho(r)} ${(k / 20 * 100).toFixed(0)}%`);
  }
  $('#leyenda-barra').style.background = `linear-gradient(to right, ${paradas.join(',')})`;
  const ticks = $('.leyenda-ticks');
  const fmt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toString().replace('.', ',');
  if (ticks) ticks.innerHTML = `<span>${fmt(-d)}</span><span>0</span><span>${fmt(d)}</span>`;
  const cap = $('.leyenda figcaption');
  const pie = $('.leyenda-pie');
  if (estado.ruedas === 'diferencia') {
    if (cap) cap.textContent = 'Cambio de correlacion';
    if (pie) pie.textContent = 'Se separan en las caidas · igual · se juntan en las caidas';
  } else {
    if (cap) cap.textContent = 'Correlacion';
    if (pie) pie.textContent = 'Se mueven al reves · sin relacion · se mueven juntos';
  }
}

function dibujarChips() {
  const cont = $('#f-categorias');
  cont.textContent = '';
  const E = estado.datos.etfs;
  for (const cat of categoriasOrdenadas()) {
    const n = Object.values(E).filter((e) => e.categoria === cat).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', estado.categorias.has(cat));
    b.innerHTML = `<span class="punto"></span>${cat} <span class="cuenta">${n}</span>`;
    b.addEventListener('click', () => {
      if (estado.categorias.has(cat)) {
        if (estado.categorias.size === 1) return;   // nunca dejar el mapa vacio
        estado.categorias.delete(cat);
      } else {
        estado.categorias.add(cat);
      }
      b.setAttribute('aria-pressed', estado.categorias.has(cat));
      recalcular();
    });
    cont.appendChild(b);
  }
}

/** Volatilidad anualizada en % a partir de log-retornos diarios. */
function volAnual(serie, desde) {
  const s = serie.slice(desde).filter((x) => x !== null);
  if (s.length < 3) return null;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const v = s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

/** Cuanto pesa el CCL en la ventana vigente, comparado con un ETF de referencia.
    Sin este numero, "el CCL infla las correlaciones" es una frase suelta. */
function notaCCL() {
  const nodo = $('#metodo-ccl');
  if (!nodo) return;
  const d = estado.datos;
  const desde = Math.max(0, d.fechas.length - estado.ventana);
  const vc = volAnual(d.ccl.ret, desde);
  const vs = d.etfs.SPY ? volAnual(d.etfs.SPY.ret, desde) : null;
  if (vc === null) { nodo.textContent = ''; return; }
  if (vs === null) {
    nodo.textContent = `En esta ventana el CCL tuvo una volatilidad anualizada de ${vc.toFixed(0)}%.`;
    return;
  }
  const ratio = vc / vs;
  const juicio = ratio < 0.35 ? 'casi no mueve el resultado'
    : ratio < 0.8 ? 'aporta una parte apreciable del movimiento'
    : 'domina el movimiento';
  nodo.textContent = `En esta ventana el CCL tuvo una volatilidad anualizada de ${vc.toFixed(0)}%, `
    + `contra ${vs.toFixed(0)}% del SPY: el tipo de cambio ${juicio}.`;
}

function encabezadoMapa() {
  const mon = estado.moneda === 'usd' ? 'dólares' : 'pesos (incluye el CCL)';
  const sel = $('#f-ventana');
  const etq = sel.options[sel.selectedIndex].textContent.replace(/\s*\(.*\)/, '');
  const f = estado.datos.fechas;
  const desde = f[Math.max(0, f.length - estado.ventana)];
  const est = ruedasDeEstres();
  const orden = estado.orden === 'cluster'
    ? 'Ordenado por similitud: los bloques son grupos que se mueven juntos.'
    : estado.orden === 'categoria' ? 'Agrupado por categoría.' : 'Orden alfabético.';

  let base;
  if (estado.ruedas === 'todas') {
    base = `Retornos diarios en ${mon} — ${etq}, desde el ${fechaCorta(desde)}. `;
  } else if (estado.ruedas === 'estres') {
    base = `Retornos en ${mon}, sólo las ${est.indices.length} ruedas en que más cayó el `
      + `S&P 500 (peor que ${(est.umbral * 100).toFixed(1).replace('.', ',')}% en el día), `
      + `sobre los ${f.length} días publicados. `;
  } else {
    base = `Cuánto sube la correlación en las ${est.indices.length} peores ruedas del S&P 500 `
      + `frente a las ${ruedasDeCalma().length} tranquilas del mismo período. `
      + `Rojo = el par se junta justo cuando el mercado cae. `;
  }
  $('#sub-mapa').textContent = base + orden;
}

/** Titular del efecto crisis: la afirmacion de que las correlaciones se
    disparan en las caidas, medida en vez de repetida. */
function titularCrisis() {
  const nodo = $('#titular-crisis');
  if (!nodo) return;
  const tks = estado.tickers;
  if (tks.length < 4) { nodo.hidden = true; return; }
  const series = tks.map(retornos);
  const largo = estado.datos.fechas.length;
  const est = ruedasDeEstres();
  const mTodo = matrizSobre(series, ruedasDeCalma(), 1);
  const mEst = matrizSobre(series, est.indices, 1);

  const prom = (M) => {
    let s = 0, n = 0;
    for (let i = 0; i < tks.length; i++) {
      for (let j = i + 1; j < tks.length; j++) {
        if (M.rho[i][j] !== null) { s += M.rho[i][j]; n++; }
      }
    }
    return n ? s / n : null;
  };
  const a = prom(mTodo), b = prom(mEst);
  if (a === null || b === null) { nodo.hidden = true; return; }

  // Par que mas se desarma: diversifica en calma y deja de hacerlo en la caida.
  // Los apalancados e inversos quedan afuera —su salto es mecanico— y tambien
  // contamos cuantos pares dan un salto grande, que es el dato de fondo.
  const E = estado.datos.etfs;
  const mecanico = (tk) => E[tk].categoria === 'Apalancado / Inverso';
  let peor = null, saltones = 0, saltonesSig = 0, cambiosSig = 0, comparables = 0;
  for (let i = 0; i < tks.length; i++) {
    for (let j = i + 1; j < tks.length; j++) {
      const t = mTodo.rho[i][j], e = mEst.rho[i][j];
      if (t === null || e === null) continue;
      if (mecanico(tks[i]) || mecanico(tks[j])) continue;
      comparables++;
      const esSig = difSignificativa(e, mEst.cnt[i][j], t, mTodo.cnt[i][j]);
      if (esSig) cambiosSig++;
      if (e - t >= 0.25) {
        saltones++;
        if (esSig) saltonesSig++;
      }
      if (t > 0.35) continue;
      const salto = e - t;
      if (!peor || salto > peor.salto) peor = { salto, a: tks[i], b: tks[j], t, e };
    }
  }

  nodo.hidden = false;
  const sube = b > a;
  nodo.innerHTML =
    `<strong>La correlación media del panel pasa de ${fmtRho(a)} en las `
    + `${ruedasDeCalma().length} ruedas tranquilas a ${fmtRho(b)} en las `
    + `${est.indices.length} peores del S&P 500</strong> (mismo período, para que la `
    + `comparación no mezcle el efecto crisis con el del momento). `
    + (sube
      ? `Es el efecto que hace que la diversificación falle justo cuando se la necesita: `
        + `los activos se juntan en las caídas.`
      : `Acá no se cumple el patrón habitual: en este panel la correlación no sube en las caídas.`)
    + (peor
      ? ` Pero el promedio tapa lo que pasa par a par: <strong>${saltones}</strong> de `
        + `${comparables.toLocaleString('es-AR')} pares suben más de 0,25, y el caso más marcado `
        + `es <strong>${peor.a} / ${peor.b}</strong>, que pasa de ${fmtRho(peor.t)} a `
        + `${fmtRho(peor.e)}: diversifica en calma y deja de hacerlo justo en la caída.`
        + ` <br>Los saltos grandes aguantan la prueba: <strong>${saltonesSig} de los ${saltones}</strong> `
        + `son significativos al 95%. Lo que no aguanta es el resto del mapa — sobre los `
        + `${comparables.toLocaleString('es-AR')} pares, sólo `
        + `<strong>${Math.round(cambiosSig / comparables * 100)}%</strong> de los cambios se `
        + `distingue del ruido. Con ${est.indices.length} ruedas de caída alcanza para detectar `
        + `un efecto grande, no uno chico.`
      : '');
}

function recalcular() {
  const visibles = tickersVisibles();
  // El clustering necesita la matriz, y la matriz depende del orden: la
  // calculamos alfabetica, ordenamos, y reindexamos con ese orden.
  const base = visibles.slice().sort();
  const m0 = calcularMatriz(base);
  estado.tickers = ordenarTickers(base, m0.rho);
  const idx = estado.tickers.map((t) => base.indexOf(t));
  // Reindexar al orden del mapa tiene que arrastrar TODO lo que trae la
  // matriz, no solo rho y cnt: la significancia se calcula sobre el orden
  // alfabetico y se perdia en esta reconstruccion.
  estado.matriz = {
    rho: idx.map((i) => idx.map((j) => m0.rho[i][j])),
    cnt: idx.map((i) => idx.map((j) => m0.cnt[i][j])),
    sig: m0.sig ? idx.map((i) => idx.map((j) => m0.sig[i][j])) : null,
    esDiferencia: !!m0.esDiferencia,
  };

  if (window.redibujarB100 && estado.vista === 'base100') redibujarB100();
  encabezadoMapa();
  titularCrisis();
  notaCCL();
  dibujarMapa();
  dibujarExtremos();
  if (estado.vista === 'tabla') dibujarTabla();
  if (estado.sel) {
    const [a, b] = estado.sel;
    if (estado.tickers.includes(a) && estado.tickers.includes(b)) seleccionar(a, b);
  }
}

function aplicarTema(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tema', t); } catch (e) { /* modo privado */ }
  leerPolos();
  dibujarLeyenda();
  logoSegunTema();
  if (estado.datos) recalcular();
  if (window.redibujarCartera) window.redibujarCartera();
  if (window.redibujarBacktest) window.redibujarBacktest();
}

/** El wordmark del pie va navy sobre claro y blanco sobre navy. */
function logoSegunTema() {
  const img = $('#logo-pie');
  if (!img) return;
  const oscuro = temaActual() === 'dark';
  img.src = oscuro ? 'marca/balanz_wordmark_white.png' : 'marca/balanz_wordmark_navy.png';
}

function temaActual() {
  const stamp = document.documentElement.getAttribute('data-theme');
  if (stamp) return stamp;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* -------------------------------------------------------------- init --- */

function conectar() {
  $('#f-ventana').addEventListener('change', (e) => { estado.ventana = +e.target.value; recalcular(); });
  $('#f-ruedas').addEventListener('change', (e) => {
    estado.ruedas = e.target.value;
    dibujarLeyenda();
    recalcular();
  });
  $('#f-moneda').addEventListener('change', (e) => { estado.moneda = e.target.value; recalcular(); });
  $('#f-sig').addEventListener('change', (e) => { estado.soloSig = e.target.checked; dibujarMapa(); dibujarTabla(); });
  $('#f-orden').addEventListener('change', (e) => { estado.orden = e.target.value; recalcular(); });

  let deb;
  $('#f-buscar').addEventListener('input', (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { estado.busqueda = e.target.value; dibujarMapa(); }, 120);
  });

  $$('.segmentado button').forEach((b) => b.addEventListener('click', () => {
    $$('.segmentado button').forEach((x) => x.classList.toggle('activo', x === b));
    estado.vista = b.dataset.vista;
    $('#panel-mapa').hidden = estado.vista !== 'mapa';
    $('#panel-tabla').hidden = estado.vista !== 'tabla';
    $('#panel-base100').hidden = estado.vista !== 'base100';
    if (estado.vista === 'tabla') dibujarTabla();
    else if (estado.vista === 'base100') { if (window.redibujarB100) redibujarB100(); }
    else dibujarMapa();
  }));

  $$('#tabla-pares th').forEach((th) => th.addEventListener('click', () => {
    const c = th.dataset.col;
    estado.ordenTabla = { col: c, desc: estado.ordenTabla.col === c ? !estado.ordenTabla.desc : true };
    dibujarTabla();
  }));

  $('#descargar').addEventListener('click', descargarCSV);
  $('#tema').addEventListener('click', () => aplicarTema(temaActual() === 'dark' ? 'light' : 'dark'));

  const svg = $('#mapa');
  svg.addEventListener('mousemove', (ev) => {
    const c = celdaDesdeEvento(ev);
    if (!c) { ocultarTooltip(); if (!estado.sel) moverResaltado(null); else pintarSeleccion(); return; }
    moverResaltado(c.i, c.j);
    mostrarTooltip(ev, c.i, c.j);
  });
  svg.addEventListener('mouseleave', () => { ocultarTooltip(); if (estado.sel) pintarSeleccion(); else moverResaltado(null); });
  svg.addEventListener('click', (ev) => {
    const c = celdaDesdeEvento(ev);
    if (c && c.i !== c.j) seleccionar(svg._geo.tickers[c.i], svg._geo.tickers[c.j]);
  });

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (estado.datos) dibujarMapa(); }, 150); });
}

async function iniciar() {
  try { const t = localStorage.getItem('tema'); if (t) document.documentElement.setAttribute('data-theme', t); }
  catch (e) { /* modo privado */ }
  leerPolos();
  dibujarLeyenda();
  logoSegunTema();

  let d;
  try {
    const resp = await fetch('data/dataset.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    d = await resp.json();
  } catch (e) {
    $('#nota-mapa').textContent = 'No se pudo cargar el dataset: ' + e.message;
    return;
  }
  estado.datos = d;

  // El conteo tiene que distinguir: no todo lo que esta en el mapa es un ETF.
  const nEtf = Object.values(d.etfs).filter((e) => e.tipo !== 'indice').length;
  const nIdx = Object.keys(d.etfs).length - nEtf;
  $('#conteo-etfs').textContent = nEtf;
  const extra = $('#conteo-extra');
  if (extra) {
    extra.innerHTML = nIdx
      ? `, más <strong>${nIdx}</strong> índice local en dólares como referencia`
      : '';
  }
  $('#ultima-rueda').textContent = fechaCorta(d.ultimaRueda);
  $('#generado').textContent = new Date(d.generado).toLocaleString('es-AR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  $('#pie-fuentes').textContent =
    `Universo: ${d.fuentes.universo}. Precios: ${d.fuentes.precios}. CCL: ${d.fuentes.ccl}.`;

  const fueraByma = Object.entries(d.etfs).filter(([, e]) => e.enByma === false).map(([tk]) => tk);
  const avisos = (d.avisos || []).slice();
  if (fueraByma.length) {
    avisos.push(`Estos ya no figuran en el panel de BYMA: <strong>${fueraByma.join(', ')}</strong>. Siguen en el mapa hasta confirmar la baja.`);
  }
  if (avisos.length) {
    $('#avisos').hidden = false;
    $('#avisos').innerHTML = avisos.map((a) => `<p>${a}</p>`).join('');
  }

  categoriasOrdenadas().forEach((c) => estado.categorias.add(c));
  dibujarChips();
  conectar();
  recalcular();
  seleccionar('SPY', 'GLD');
  window.__datosListos = true;
  const pendientes = window.__initPendientes.slice();
  window.__initPendientes = [];
  for (const fn of pendientes) {
    try { fn(); } catch (e) { console.error('Fallo al iniciar un modulo:', e); }
  }
}

iniciar();
