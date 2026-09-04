/* Vista base 100: comparar rendimientos acumulados.

   La matriz de correlacion dice como se mueven JUNTOS; no dice cual rindio
   mas. Son preguntas distintas y hacen falta las dos: dos activos pueden
   correlacionar 0,95 y haber dado retornos completamente distintos.

   Convencion: normalizado = valor / base x 100, con la base en el primer dia
   de la ventana elegida. Respeta la ventana y la moneda del tablero, asi que
   en pesos incluye el CCL. */

'use strict';

// Secuencia de data-viz de la marca. Se corta en 6 a proposito: mas lineas
// sobre el mismo grafico dejan de distinguirse, y la salida no es inventar
// colores nuevos sino sacar series.
const COLORES_B100 = ['#002060', '#00B0F0', '#145E81', '#A7B2C8', '#0F4C68', '#6B7280'];
const MAX_SERIES = 6;

const B100 = {
  sel: ['SPY', 'MERVAL', 'GLD', 'QQQ'],
  hover: null,
};

/** Serie normalizada a 100 en el primer dia de la ventana.
    Los dias sin dato no mueven el indice: la posicion se mantiene quieta. */
function serieBase100(tk, indices) {
  const r = retornos(tk);
  const out = [];
  let acum = 0;
  for (let k = 0; k < indices.length; k++) {
    // El primer dia ES la base: vale 100. Su retorno mide el movimiento contra
    // la rueda anterior, que esta fuera de la ventana, asi que no cuenta.
    if (k > 0) {
      const v = r[indices[k]];
      if (v !== null && v !== undefined) acum += v;
    }
    out.push(100 * Math.exp(acum));
  }
  return out;
}

function metricasB100(serie) {
  const v = serie.filter((x) => x !== null);
  if (v.length < 5) return null;
  const total = v[v.length - 1] / v[0] - 1;
  const rets = [];
  for (let i = 1; i < v.length; i++) rets.push(Math.log(v[i] / v[i - 1]));
  const n = rets.length, m = rets.reduce((a, b) => a + b, 0) / n;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) * 252);
  let pico = v[0], dd = 0;
  for (const x of v) { pico = Math.max(pico, x); dd = Math.min(dd, x / pico - 1); }
  return { total, vol, maxDD: dd, final: v[v.length - 1] };
}

/* -------------------------------------------------------------- render --- */

function dibujarB100() {
  const svg = $('#g-base100');
  if (!svg) return;
  svg.textContent = '';
  const idx = indicesVigentes();
  const fechas = estado.datos.fechas;

  const series = B100.sel.map((tk, k) => ({
    tk, color: COLORES_B100[k % COLORES_B100.length], v: serieBase100(tk, idx),
  }));
  const datos = series.flatMap((s) => s.v.filter((x) => x !== null));
  if (!datos.length) return;

  const W = Math.max(340, svg.parentElement.clientWidth), H = 340;
  const m = { t: 12, r: 92, b: 34, l: 48 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);

  const lo = Math.min(...datos, 100), hi = Math.max(...datos, 100);
  const pad = (hi - lo) * 0.06 || 5;
  const y0 = lo - pad, y1 = hi + pad;
  const X = (k) => m.l + (k / Math.max(1, idx.length - 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);

  // grilla
  const paso = Math.max(5, Math.round((y1 - y0) / 5 / 5) * 5);
  for (let v = Math.ceil(y0 / paso) * paso; v <= y1; v += paso) {
    svg.appendChild(el('line', { x1: m.l, y1: Y(v), x2: W - m.r, y2: Y(v),
      stroke: 'var(--linea)', 'stroke-width': 1 }));
    const t = el('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'eje-lbl' });
    t.textContent = v; svg.appendChild(t);
  }
  // la base es la referencia: si una serie esta abajo de 100, perdio
  if (y0 < 100 && y1 > 100) {
    svg.appendChild(el('line', { x1: m.l, y1: Y(100), x2: W - m.r, y2: Y(100),
      stroke: 'var(--eje)', 'stroke-width': 1.5 }));
  }
  // eje temporal
  let ultimo = null;
  idx.forEach((i, k) => {
    const et = fechas[i].slice(0, 7);
    if (et !== ultimo && (k === 0 || k > idx.length * 0.12)) {
      if (ultimo === null || k % Math.ceil(idx.length / 5) === 0) {
        const t = el('text', { x: X(k), y: H - m.b + 15, 'text-anchor': 'middle', class: 'eje-lbl' });
        t.textContent = fechaCorta(fechas[i]).replace(/^\d+ /, '');
        svg.appendChild(t);
      }
      ultimo = et;
    }
  });

  const etiquetas = [];
  for (const s of series) {
    let d = '';
    s.v.forEach((v, k) => {
      if (v === null) return;
      d += (d ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(v).toFixed(1);
    });
    svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round' }));
    const fin = s.v.filter((x) => x !== null).pop();
    etiquetas.push({ s, y: Y(fin), fin });
  }

  // etiquetas directas al final, separadas para que no se pisen
  etiquetas.sort((a, b) => a.y - b.y);
  for (let i = 1; i < etiquetas.length; i++) {
    if (etiquetas[i].y - etiquetas[i - 1].y < 13) etiquetas[i].y = etiquetas[i - 1].y + 13;
  }
  for (const t of etiquetas) {
    const l = el('text', { x: W - m.r + 7, y: t.y + 3, class: 'serie-lbl', fill: t.s.color });
    l.textContent = `${t.s.tk} ${t.fin.toFixed(0)}`;
    svg.appendChild(l);
  }

  // capa de hover: cruz vertical + tooltip con todas las series a esa fecha
  const cruz = el('line', { id: 'b100-cruz', y1: m.t, y2: H - m.b,
    stroke: 'var(--eje)', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(cruz);
  const puntos = series.map((s) => {
    const c = el('circle', { r: 3.5, fill: s.color, stroke: 'var(--superficie)',
      'stroke-width': 1.5, opacity: 0 });
    svg.appendChild(c);
    return c;
  });

  svg._b100 = { X, Y, series, idx, W, m, cruz, puntos };
}

function hoverB100(ev) {
  const svg = $('#g-base100');
  const g = svg && svg._b100;
  if (!g) return;
  const r = svg.getBoundingClientRect();
  const esc = r.width / (svg.viewBox.baseVal.width || r.width);
  const x = (ev.clientX - r.left) / esc;
  const k = Math.round(((x - g.m.l) / (g.W - g.m.l - g.m.r)) * (g.idx.length - 1));
  if (k < 0 || k >= g.idx.length) return ocultarB100();

  g.cruz.setAttribute('x1', g.X(k)); g.cruz.setAttribute('x2', g.X(k));
  g.cruz.setAttribute('opacity', 1);
  const filas = [];
  g.series.forEach((s, i) => {
    const v = s.v[k];
    if (v === null) { g.puntos[i].setAttribute('opacity', 0); return; }
    g.puntos[i].setAttribute('cx', g.X(k)); g.puntos[i].setAttribute('cy', g.Y(v));
    g.puntos[i].setAttribute('opacity', 1);
    filas.push({ tk: s.tk, color: s.color, v });
  });
  filas.sort((a, b) => b.v - a.v);
  const tt = $('#tooltip');
  tt.innerHTML = `<div class="tt-par">${fechaCorta(estado.datos.fechas[g.idx[k]])}</div>`
    + filas.map((f) => `<div class="tt-fila"><span class="serie-punto" style="background:${f.color}"></span>`
      + `${f.tk} <strong>${f.v.toFixed(1)}</strong> `
      + `<span class="tt-meta">${f.v >= 100 ? '+' : '−'}${Math.abs(f.v - 100).toFixed(1)}%</span></div>`).join('');
  tt.hidden = false;
  const mg = 14, w = tt.offsetWidth, h = tt.offsetHeight;
  let px = ev.clientX + mg, py = ev.clientY + mg;
  if (px + w > innerWidth - 8) px = ev.clientX - w - mg;
  if (py + h > innerHeight - 8) py = ev.clientY - h - mg;
  tt.style.left = px + 'px'; tt.style.top = py + 'px';
}

function ocultarB100() {
  const svg = $('#g-base100');
  const g = svg && svg._b100;
  if (g) { g.cruz.setAttribute('opacity', 0); g.puntos.forEach((p) => p.setAttribute('opacity', 0)); }
  $('#tooltip').hidden = true;
}

/** Tabla: el equivalente legible sin depender del color. */
function tablaB100() {
  const cuerpo = $('#tabla-b100 tbody');
  cuerpo.textContent = '';
  const idx = indicesVigentes();
  const E = estado.datos.etfs;
  const filas = B100.sel.map((tk, k) => ({
    tk, color: COLORES_B100[k % COLORES_B100.length],
    m: metricasB100(serieBase100(tk, idx)),
  })).filter((f) => f.m);
  filas.sort((a, b) => b.m.total - a.m.total);
  for (const f of filas) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="serie-punto" style="background:${f.color}"></span>`
      + `<span class="tk">${f.tk}</span> <span class="tk-desc">${E[f.tk].nombre}</span></td>`
      + `<td class="num">${f.m.final.toFixed(1)}</td>`
      + `<td class="num ${f.m.total < 0 ? 'neg' : ''}">${(f.m.total >= 0 ? '+' : '−')}${Math.abs(f.m.total * 100).toFixed(1)}%</td>`
      + `<td class="num">${(f.m.vol * 100).toFixed(1)}%</td>`
      + `<td class="num neg">${(f.m.maxDD * 100).toFixed(1)}%</td>`;
    cuerpo.appendChild(tr);
  }
}

function chipsB100() {
  const cont = $('#b100-chips');
  cont.textContent = '';
  B100.sel.forEach((tk, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-serie';
    b.innerHTML = `<span class="punto" style="background:${COLORES_B100[k % COLORES_B100.length]}"></span>`
      + `${tk}<span class="quitar">&times;</span>`;
    b.title = 'Quitar del gráfico';
    b.addEventListener('click', () => {
      B100.sel = B100.sel.filter((x) => x !== tk);
      recalcularB100();
    });
    cont.appendChild(b);
  });
  const aviso = $('#b100-aviso');
  aviso.textContent = B100.sel.length >= MAX_SERIES
    ? `Máximo ${MAX_SERIES} series: más líneas dejan de distinguirse. Quitá una para agregar otra.`
    : '';
  $('#b100-add').disabled = B100.sel.length >= MAX_SERIES;
}

function encabezadoB100() {
  const idx = indicesVigentes();
  const f = estado.datos.fechas;
  const mon = estado.moneda === 'usd' ? 'dólares' : 'pesos (incluye el CCL)';
  const desde = f[idx[0]];
  $('#b100-sub').textContent = estado.ruedas === 'todas'
    ? `Base 100 = ${fechaCorta(desde)}, en ${mon}. Cada línea muestra cuánto valdrían 100 invertidos ese día.`
    : `Base 100 sobre las ${idx.length} ruedas del modo elegido, en ${mon}. `
      + `Ojo: no son días consecutivos, así que la curva no es una serie de tiempo continua.`;
}

function recalcularB100() {
  if (!estado.datos) return;
  chipsB100();
  encabezadoB100();
  dibujarB100();
  tablaB100();
}

/* ---------------------------------------------------------------- init --- */

window.iniciarB100 = function () {
  const sel = $('#b100-ticker');
  const lista = Object.keys(estado.datos.etfs).sort();
  sel.innerHTML = '<option value="">Agregar serie…</option>'
    + lista.map((tk) => `<option value="${tk}">${tk} — ${estado.datos.etfs[tk].nombre}</option>`).join('');

  $('#b100-add').addEventListener('click', () => {
    const tk = sel.value;
    if (!tk || B100.sel.includes(tk) || B100.sel.length >= MAX_SERIES) return;
    B100.sel.push(tk);
    sel.value = '';
    recalcularB100();
  });
  sel.addEventListener('change', () => { if (sel.value) $('#b100-add').click(); });

  $('#b100-cartera').addEventListener('click', () => {
    // Ojo: `const CART` en un script clasico NO cuelga de window, asi que
    // preguntar por window.CART daba siempre undefined y el boton no hacia
    // nada, en silencio.
    const hay = typeof CART !== 'undefined' && CART.res;
    if (!hay) { $('#b100-aviso').textContent = 'La cartera todavía se está calculando.'; return; }
    const c = CART.res.carteras[CART.perfil];
    B100.sel = c.pesos.slice(0, MAX_SERIES).map((p) => p.tk);
    recalcularB100();
  });
  $('#b100-limpiar').addEventListener('click', () => {
    B100.sel = ['SPY'];
    recalcularB100();
  });

  const svg = $('#g-base100');
  svg.addEventListener('mousemove', hoverB100);
  svg.addEventListener('mouseleave', ocultarB100);

  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (estado.vista === 'base100') dibujarB100(); }, 200);
  });

  recalcularB100();
};

window.redibujarB100 = function () { if (estado.datos) recalcularB100(); };
window.alHaberDatos(window.iniciarB100);
