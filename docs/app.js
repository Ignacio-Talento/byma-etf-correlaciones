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
  moneda: 'usd',
  orden: 'cluster',
  categorias: new Set(),
  busqueda: '',
  vista: 'mapa',
  sel: null,                // [a, b] del par seleccionado
  ordenTabla: { col: 'rho', desc: true },
  tickers: [],              // orden vigente en el mapa
  matriz: null,
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

/** Color de una correlacion: gris neutro en 0, azul hacia -1, rojo hacia +1. */
function colorRho(rho) {
  if (rho === null || rho === undefined || Number.isNaN(rho)) return 'transparent';
  const k = Math.min(1, Math.abs(rho));
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

/** Pearson sobre las ruedas donde ambas series tienen dato. */
function correlacion(xs, ys, desde) {
  let n = 0, sx = 0, sy = 0;
  for (let i = desde; i < xs.length; i++) {
    const a = xs[i], b = ys[i];
    if (a === null || b === null) continue;
    n++; sx += a; sy += b;
  }
  if (n < MIN_RUEDAS) return { rho: null, n };
  const mx = sx / n, my = sy / n;
  let vxy = 0, vx = 0, vy = 0;
  for (let i = desde; i < xs.length; i++) {
    const a = xs[i], b = ys[i];
    if (a === null || b === null) continue;
    const da = a - mx, db = b - my;
    vxy += da * db; vx += da * da; vy += db * db;
  }
  if (vx <= 0 || vy <= 0) return { rho: null, n };
  return { rho: vxy / Math.sqrt(vx * vy), n };
}

/** Matriz completa para los tickers dados. */
function calcularMatriz(tickers) {
  const N = tickers.length;
  const series = tickers.map(retornos);
  const largo = estado.datos.fechas.length;
  const desde = Math.max(0, largo - estado.ventana);
  const rho = Array.from({ length: N }, () => new Array(N).fill(null));
  const cnt = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    rho[i][i] = 1;
    for (let j = i + 1; j < N; j++) {
      const r = correlacion(series[i], series[j], desde);
      rho[i][j] = rho[j][i] = r.rho;
      cnt[i][j] = cnt[j][i] = r.n;
    }
    cnt[i][i] = correlacion(series[i], series[i], desde).n;
  }
  return { rho, cnt };
}

/** Correlacion movil del par, para ver si el numero de hoy es estable. */
function correlacionMovil(a, b, ventana, maxPuntos) {
  const xs = retornos(a), ys = retornos(b);
  const N = xs.length;
  const pts = [];
  const inicio = Math.max(ventana, N - maxPuntos);
  for (let t = inicio; t <= N; t++) {
    const { rho } = correlacion(xs.slice(0, t), ys.slice(0, t), t - ventana);
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
                 'Internacional', 'Commodities y metales', 'Cripto', 'Apalancado / Inverso'];
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

  const { rho, cnt } = estado.matriz;
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
  $('#nota-mapa').textContent =
    `${N} ETFs, ${pares.toLocaleString('es-AR')} pares. La diagonal es cada ETF consigo mismo. `
    + (mostrarValor ? '' : 'Pasá el mouse por una celda para ver el valor, o abrí la vista de tabla.');
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
  tt.innerHTML = i === j
    ? `<div class="tt-par">${a}</div><div class="tt-meta">${E[a].nombre}</div>`
    : `<div class="tt-par">${a} <span style="opacity:.5">vs</span> ${b}</div>`
      + `<div class="tt-rho" style="color:${r === null ? 'inherit' : colorRho(r)}">${fmtRho(r)}</div>`
      + `<div class="tt-meta">${lecturaRho(r)} &middot; ${n} ruedas</div>`;
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
  const desde = Math.max(0, xs.length - estado.ventana);
  const { rho, n } = correlacion(xs, ys, desde);

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
  const { rho, cnt } = estado.matriz;
  const tk = estado.tickers;
  const out = [];
  for (let i = 0; i < tk.length; i++) {
    for (let j = i + 1; j < tk.length; j++) {
      if (rho[i][j] !== null) out.push({ a: tk[i], b: tk[j], rho: rho[i][j], n: cnt[i][j] });
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
    tr.innerHTML =
      `<td><span class="tk">${p.a}</span> <span class="tk-desc">${E[p.a].nombre}</span></td>`
      + `<td><span class="tk">${p.b}</span> <span class="tk-desc">${E[p.b].nombre}</span></td>`
      + `<td class="num"><span class="pastilla" style="background:${c};color:${tintaSobre(c)}">${fmtRho3(p.rho)}</span></td>`
      + `<td class="num">${p.n}</td>`;
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
  const paradas = [];
  for (let k = 0; k <= 20; k++) {
    const r = -1 + (k / 20) * 2;
    paradas.push(`${colorRho(r)} ${(k / 20 * 100).toFixed(0)}%`);
  }
  $('#leyenda-barra').style.background = `linear-gradient(to right, ${paradas.join(',')})`;
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
  $('#sub-mapa').textContent =
    `Retornos diarios en ${mon} — ${etq}, desde el ${fechaCorta(desde)}. `
    + (estado.orden === 'cluster' ? 'Ordenado por similitud: los bloques son grupos que se mueven juntos.'
      : estado.orden === 'categoria' ? 'Agrupado por categoría.' : 'Orden alfabético.');
}

function recalcular() {
  const visibles = tickersVisibles();
  // El clustering necesita la matriz, y la matriz depende del orden: la
  // calculamos alfabetica, ordenamos, y reindexamos con ese orden.
  const base = visibles.slice().sort();
  const m0 = calcularMatriz(base);
  estado.tickers = ordenarTickers(base, m0.rho);
  const idx = estado.tickers.map((t) => base.indexOf(t));
  estado.matriz = {
    rho: idx.map((i) => idx.map((j) => m0.rho[i][j])),
    cnt: idx.map((i) => idx.map((j) => m0.cnt[i][j])),
  };

  encabezadoMapa();
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
  $('#f-moneda').addEventListener('change', (e) => { estado.moneda = e.target.value; recalcular(); });
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
    if (estado.vista === 'tabla') dibujarTabla(); else dibujarMapa();
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

  $('#conteo-etfs').textContent = Object.keys(d.etfs).length;
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
  if (window.iniciarCartera) window.iniciarCartera();
  if (window.iniciarBacktest) window.iniciarBacktest();
}

iniciar();
