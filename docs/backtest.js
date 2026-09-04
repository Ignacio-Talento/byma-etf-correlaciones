/* Walk-forward: que habria rendido cada estrategia de verdad.

   El backtest se precalcula en Python (scripts/backtest.py) porque necesita
   diez anios de precios y no tiene sentido mandarle eso al navegador. Aca solo
   se aplica el costo de transaccion y se miden las curvas.

   El costo es un control en vivo y no un parametro escondido a proposito: con
   294% de rotacion anual, el maximo Sharpe gana o pierde segun cuanto cueste
   operar. Es LA variable que decide el ranking, no un detalle de implementacion. */

'use strict';

const BT = {
  datos: null,
  costoPb: 50,        // puntos basicos por punta; en CEDEARs 50 es optimista
  escalaLog: true,
  verLW: false,
};

const ESTRATEGIAS_BT = [
  { id: 'maxsharpe',    nombre: 'Máx. Sharpe', color: '#002060', opt: true },
  { id: 'maxsharpe_lw', nombre: 'Máx. Sharpe + LW', color: '#0F4C68', opt: true, lw: true },
  { id: 'minvar',       nombre: 'Mín. varianza', color: '#145E81', opt: true },
  { id: 'minvar_lw',    nombre: 'Mín. var. + LW', color: '#3E8FB0', opt: true, lw: true },
  { id: 'erc',          nombre: 'Paridad de riesgo', color: '#00B0F0', opt: true },
  { id: 'equi',         nombre: '1/N', color: '#A7B2C8', opt: true },
  { id: 'spy',          nombre: 'SPY', color: '#6B7280', opt: false },
];

/** Las variantes con shrinkage se pueden ocultar: son siete curvas y el
    hallazgo no esta ahi. Quien quiera verlas, las prende. */
function visibles() {
  return ESTRATEGIAS_BT.filter((e) => BT.verLW || !e.lw);
}

/* ------------------------------------------------------------- calculo --- */

/** Curva neta de costos: en cada rebalanceo se descuenta turnover x 2 x costo. */
function navNeta(id) {
  const d = BT.datos;
  const bruta = d.nav[id];
  const to = d.rebalanceos.turnover[id];
  if (!to) return bruta.slice();                    // SPY no rebalancea
  const c = BT.costoPb / 10000;
  const idxs = d.rebalanceos.indices;
  const factor = new Array(bruta.length).fill(1);
  let acum = 1;
  let j = 0;
  for (let i = 0; i < bruta.length; i++) {
    while (j < idxs.length && idxs[j] === i) {
      acum *= (1 - to[j] * 2 * c);
      j++;
    }
    factor[i] = acum;
  }
  return bruta.map((v, i) => v * factor[i]);
}

function metricasNav(nav, rfAnual) {
  const rs = [];
  for (let i = 1; i < nav.length; i++) rs.push(Math.log(nav[i] / nav[i - 1]));
  const n = rs.length;
  const m = rs.reduce((a, b) => a + b, 0) / n;
  const v = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const vol = Math.sqrt(v * 252);
  const anios = n / 252;
  const cagr = Math.pow(nav[nav.length - 1] / nav[0], 1 / anios) - 1;

  const obj = rfAnual / 252;
  const abajo = rs.filter((r) => r < obj).map((r) => (r - obj) ** 2);
  const volAbajo = abajo.length ? Math.sqrt(abajo.reduce((a, b) => a + b, 0) / n * 252) : 0;

  let pico = nav[0], dd = 0;
  for (const x of nav) { pico = Math.max(pico, x); dd = Math.min(dd, x / pico - 1); }

  return {
    cagr, vol, maxDD: dd, final: nav[nav.length - 1] / nav[0],
    sharpe: vol > 0 ? (cagr - rfAnual) / vol : 0,
    sortino: volAbajo > 0 ? (cagr - rfAnual) / volAbajo : null,
  };
}

function calcularBT() {
  const d = BT.datos;
  const rf = d.metricas.equi.rf;
  const out = {};
  for (const e of ESTRATEGIAS_BT) {
    const nav = navNeta(e.id);
    out[e.id] = { nav, met: metricasNav(nav, rf), turnover: d.turnoverAnual[e.id] };
  }
  return { series: out, rf };
}

/* -------------------------------------------------------------- render --- */

const pctB = (x) => (x * 100).toFixed(1).replace('.', ',') + '%';
const num2B = (x) => (x === null || x === undefined ? '—' : x.toFixed(2).replace('.', ','));

function dibujarCurvas(r) {
  const svg = $('#g-backtest');
  svg.textContent = '';
  const W = Math.max(340, svg.parentElement.clientWidth), H = 320;
  const m = { t: 12, r: 96, b: 34, l: 46 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);

  const F = BT.datos.fechas;
  const todas = visibles().flatMap((e) => r.series[e.id].nav);
  const lo = Math.min(...todas), hi = Math.max(...todas);
  const Yv = BT.escalaLog ? (v) => Math.log(v) : (v) => v;
  const y0 = Yv(lo * 0.97), y1 = Yv(hi * 1.03);
  const X = (i) => m.l + (i / (F.length - 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((Yv(v) - y0) / (y1 - y0)) * (H - m.t - m.b);

  // grilla en multiplos del capital inicial, que es como se lee una curva asi
  const marcas = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10].filter((x) => x >= lo * 0.95 && x <= hi * 1.05);
  for (const v of marcas) {
    svg.appendChild(el('line', { x1: m.l, y1: Y(v), x2: W - m.r, y2: Y(v),
      stroke: 'var(--linea)', 'stroke-width': 1 }));
    const t = el('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'eje-lbl' });
    t.textContent = '×' + (v % 1 ? v.toFixed(1).replace('.', ',') : v);
    svg.appendChild(t);
  }
  // eje temporal: un tick por anio
  let anioPrev = null;
  F.forEach((f, i) => {
    const a = f.slice(0, 4);
    if (a !== anioPrev && (+a) % 2 === 0) {
      const t = el('text', { x: X(i), y: H - m.b + 15, 'text-anchor': 'middle', class: 'eje-lbl' });
      t.textContent = a; svg.appendChild(t);
    }
    if (a !== anioPrev) anioPrev = a;
  });

  // Los benchmarks van primero y mas finos: son la referencia, no el foco.
  const orden = visibles().slice().sort((a, b) => (a.opt === b.opt ? 0 : a.opt ? 1 : -1));
  const etiquetas = [];
  for (const e of orden) {
    const nav = r.series[e.id].nav;
    let d = '';
    // 1 punto cada 2 ruedas: la curva no cambia y el SVG pesa la mitad
    for (let i = 0; i < nav.length; i += 2) {
      d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(nav[i]).toFixed(1);
    }
    d += 'L' + X(nav.length - 1).toFixed(1) + ' ' + Y(nav[nav.length - 1]).toFixed(1);
    const esBench = !e.opt;
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: e.color,
      'stroke-width': esBench ? 1.5 : 2,
      'stroke-linejoin': 'round', 'stroke-opacity': esBench ? 0.85 : 1,
    }));
    const fin = nav[nav.length - 1];
    etiquetas.push({ e, y: Y(fin), yReal: Y(fin), fin });
  }

  // Con cinco curvas que terminan cerca, las etiquetas se pisan. Se separan
  // verticalmente lo minimo necesario y se les dibuja una guia hasta su curva,
  // para que se siga sabiendo cual es cual.
  const ALTO = 13;
  etiquetas.sort((a, b) => a.y - b.y);
  for (let i = 1; i < etiquetas.length; i++) {
    if (etiquetas[i].y - etiquetas[i - 1].y < ALTO) etiquetas[i].y = etiquetas[i - 1].y + ALTO;
  }
  const exceso = etiquetas[etiquetas.length - 1].y - (H - m.b);
  if (exceso > 0) for (const t of etiquetas) t.y -= exceso;

  for (const t of etiquetas) {
    if (Math.abs(t.y - t.yReal) > 2) {
      svg.appendChild(el('line', {
        x1: W - m.r + 1, y1: t.yReal, x2: W - m.r + 5, y2: t.y - 3,
        stroke: t.e.color, 'stroke-width': 1, 'stroke-opacity': .5,
      }));
    }
    const lab = el('text', { x: W - m.r + 7, y: t.y, class: 'serie-lbl', fill: t.e.color });
    lab.textContent = `${t.e.nombre} ×${t.fin.toFixed(1).replace('.', ',')}`;
    svg.appendChild(lab);
  }
}

function dibujarTablaBT(r) {
  const tb = $('#tabla-bt tbody');
  tb.textContent = '';
  const filas = visibles().map((e) => ({ e, ...r.series[e.id] }));
  const mejorSharpe = Math.max(...filas.map((f) => f.met.sharpe));
  for (const f of filas) {
    const tr = document.createElement('tr');
    const gana = Math.abs(f.met.sharpe - mejorSharpe) < 1e-9;
    tr.innerHTML =
      `<td><span class="serie-punto" style="background:${f.e.color}"></span>`
      + `<span class="tk">${f.e.nombre}</span></td>`
      + `<td class="num">${pctB(f.met.cagr)}</td>`
      + `<td class="num">${pctB(f.met.vol)}</td>`
      + `<td class="num ${gana ? 'destaca' : ''}">${num2B(f.met.sharpe)}</td>`
      + `<td class="num">${num2B(f.met.sortino)}</td>`
      + `<td class="num neg">${pctB(f.met.maxDD)}</td>`
      + `<td class="num">${f.turnover ? Math.round(f.turnover * 100) + '%' : '—'}</td>`;
    tb.appendChild(tr);
  }
}

/** Sharpe de cada estrategia a distintos costos. Es la tabla que decide. */
function dibujarSensibilidad() {
  const cuerpo = $('#tabla-sens tbody');
  cuerpo.textContent = '';
  const rf = BT.datos.metricas.equi.rf;
  const costos = [0, 20, 50, 100, 200];
  const guardado = BT.costoPb;
  const res = {};
  for (const c of costos) {
    BT.costoPb = c;
    for (const e of ESTRATEGIAS_BT) {
      (res[e.id] = res[e.id] || {})[c] = metricasNav(navNeta(e.id), rf).sharpe;
    }
  }
  BT.costoPb = guardado;

  for (const e of visibles()) {
    const tr = document.createElement('tr');
    let html = `<td><span class="serie-punto" style="background:${e.color}"></span>`
             + `<span class="tk">${e.nombre}</span></td>`;
    for (const c of costos) {
      const s = res[e.id][c];
      const mejor = Math.max(...visibles().map((x) => res[x.id][c]));
      const esMejor = Math.abs(s - mejor) < 1e-9;
      html += `<td class="num ${esMejor ? 'destaca' : ''} ${c === BT.costoPb ? 'col-activa' : ''}">${num2B(s)}</td>`;
    }
    tr.innerHTML = html;
    cuerpo.appendChild(tr);
  }
}

/** Retorno por año calendario: el promedio esconde de dónde viene la ventaja. */
function dibujarPorAnio(r) {
  const F = BT.datos.fechas;
  const cuerpo = $('#tabla-anios tbody');
  const cab = $('#tabla-anios thead tr');
  cuerpo.textContent = '';
  cab.textContent = '';
  cab.innerHTML = '<th>Año</th>' + visibles().map((e) =>
    `<th class="num"><span class="serie-punto" style="background:${e.color}"></span>${e.nombre}</th>`).join('');

  const anios = [];
  let act = null;
  F.forEach((f, i) => {
    const a = f.slice(0, 4);
    if (a !== act) { anios.push({ a, ini: i }); act = a; }
  });
  anios.forEach((x, k) => { x.fin = (k + 1 < anios.length ? anios[k + 1].ini : F.length) - 1; });

  let ganadas = 0;
  for (const { a, ini, fin } of anios) {
    if (fin - ini < 20) continue;
    const tr = document.createElement('tr');
    let html = `<td class="tk">${a}</td>`;
    const vals = {};
    for (const e of visibles()) {
      const nav = r.series[e.id].nav;
      vals[e.id] = nav[fin] / nav[ini] - 1;
    }
    if (vals.maxsharpe > vals.equi) ganadas++;
    for (const e of visibles()) {
      const v = vals[e.id];
      html += `<td class="num ${v < 0 ? 'neg' : ''}">${pctB(v)}</td>`;
    }
    tr.innerHTML = html;
    cuerpo.appendChild(tr);
  }
  $('#nota-anios').innerHTML =
    `Máximo Sharpe le gana a la equiponderada en <strong>${ganadas} de ${cuerpo.children.length}</strong> años. `
    + `El promedio de la tabla de arriba esconde eso: la ventaja no es pareja, viene de pocos años buenos.`;
}

function veredicto(r) {
  const ms = r.series.maxsharpe.met.sharpe;
  const eq = r.series.equi.met.sharpe;
  const spy = r.series.spy.met.sharpe;
  const erc = r.series.erc.met.sharpe;
  const mejor = visibles().map((e) => ({ e, s: r.series[e.id].met.sharpe }))
    .sort((a, b) => b.s - a.s)[0];
  const to = Math.round((r.series.maxsharpe.turnover || 0) * 100);

  $('#veredicto').innerHTML =
    `<p>Con un costo de <strong>${BT.costoPb} pb por punta</strong>, la que mejor relación `
    + `riesgo-retorno tuvo fue <strong>${mejor.e.nombre}</strong> (Sharpe ${num2B(mejor.s)}). `
    + `Máximo Sharpe queda en ${num2B(ms)}, la equiponderada en ${num2B(eq)} y comprar SPY y `
    + `no hacer nada en ${num2B(spy)}.</p>`
    + `<p>El máximo Sharpe rota <strong>${to}% al año</strong>: es la estrategia más cara de `
    + `sostener y la única cuyo resultado cambia de signo según el costo. Movés el control de `
    + `arriba y se ve — a costo cero encabeza, y pasados los ~100 pb queda por debajo de no `
    + `hacer nada. Paridad de riesgo (${num2B(erc)}) y 1/N son mucho más indiferentes al costo `
    + `porque casi no rotan.</p>`
    + notaShrinkage(r);
}

/** Cuanto aporto el shrinkage, medido y no afirmado. */
function notaShrinkage(r) {
  const pares = [['maxsharpe', 'maxsharpe_lw'], ['minvar', 'minvar_lw']];
  const dif = pares.map(([a, b]) => r.series[b].met.sharpe - r.series[a].met.sharpe);
  const maxDif = Math.max(...dif.map(Math.abs));
  const toMv = r.series.minvar.turnover, toMvLw = r.series.minvar_lw.turnover;
  return `<p class="nota">El <strong>shrinkage de Ledoit-Wolf</strong> sobre la covarianza `
    + `mueve el Sharpe menos de ${maxDif.toFixed(2).replace('.', ',')} en ambas estrategias: `
    + `su aporte acá es marginal. Donde sí ayuda es en la rotación — baja la de mínima varianza `
    + `de ${Math.round(toMv * 100)}% a ${Math.round(toMvLw * 100)}% anual — y eso, con el costo `
    + `de por medio, es lo único que termina valiendo. Prendé la casilla para verlas en el gráfico.</p>`;
}

function recalcularBT() {
  const r = calcularBT();
  dibujarCurvas(r);
  dibujarTablaBT(r);
  dibujarSensibilidad();
  dibujarPorAnio(r);
  veredicto(r);
  $('#bt-costo-val').textContent = BT.costoPb + ' pb';
}

/* ---------------------------------------------------------------- init --- */

window.iniciarBacktest = async function () {
  let d;
  try {
    const resp = await fetch('data/backtest.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    d = await resp.json();
  } catch (e) {
    $('#panel-backtest').hidden = true;
    return;
  }
  BT.datos = d;
  const p = d.protocolo;
  $('#bt-sub').innerHTML =
    `Rebalanceo mensual con ventana de ${p.lookback} ruedas y tope de `
    + `${Math.round(p.tope * 100)}% por activo, entre ${fechaCorta(p.desde)} y `
    + `${fechaCorta(p.hasta)}: <strong>${p.rebalanceos} rebalanceos</strong> a lo largo de `
    + `${p.anios.toFixed(1).replace('.', ',')} años.`;

  const sel = $('#bt-costo');
  sel.value = String(BT.costoPb);
  sel.addEventListener('input', () => { BT.costoPb = +sel.value; recalcularBT(); });
  $('#bt-escala').addEventListener('change', (e) => {
    BT.escalaLog = e.target.checked;
    recalcularBT();
  });
  $('#bt-lw').addEventListener('change', (e) => { BT.verLW = e.target.checked; recalcularBT(); });
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (BT.datos) dibujarCurvas(calcularBT()); }, 200);
  });
  recalcularBT();
};

/** Sharpe fuera de muestra de una estrategia al costo que se le pida.
    Lo consume el panel de cartera: sin esto, la cartera propone y el backtest
    juzga en otra parte de la pagina, y el lector tiene que unir los dos. */
window.sharpeNetoDe = function (estrategia, costoPb) {
  if (!BT.datos || !BT.datos.nav[estrategia]) return null;
  const guardado = BT.costoPb;
  BT.costoPb = costoPb;
  const m = metricasNav(navNeta(estrategia), BT.datos.metricas.equi.rf);
  BT.costoPb = guardado;
  return { ...m, turnover: BT.datos.turnoverAnual[estrategia] };
};

/** A partir de que costo por punta la estrategia deja de superar a un
    referente. Es mucho mas robusto que evaluar el Sharpe a un costo puntual:
    con rotaciones altas, meter una punta ancha en el modelo lineal da numeros
    absurdos (Sharpe muy negativo) que describen un escenario que nadie
    operaria. El punto de quiebre no depende de esa extrapolacion. */
window.costoDeQuiebre = function (estrategia, referente) {
  if (!BT.datos) return null;
  const ref = window.sharpeNetoDe(referente || 'spy', 0);
  const cero = window.sharpeNetoDe(estrategia, 0);
  if (!ref || !cero) return null;

  // Si ni siquiera sin costos le gana al referente, no hay punto de quiebre
  // que buscar: la respuesta es que nunca conviene.
  if (cero.sharpe <= ref.sharpe) {
    return { nuncaSupera: true, sharpeBruto: cero.sharpe, sharpeRef: ref.sharpe,
             turnover: cero.turnover, pb: 0 };
  }

  // Biseccion sobre el calculo REAL, no sobre una aproximacion lineal: el
  // costo se compone en cada rebalanceo y ademas cambia la volatilidad, asi
  // que restar turnover x 2 x costo del CAGR no da exactamente lo mismo.
  let lo = 0, hi = 1000;
  if (window.sharpeNetoDe(estrategia, hi).sharpe > ref.sharpe) {
    return { pb: hi, superaSiempre: true, sharpeBruto: cero.sharpe,
             sharpeRef: ref.sharpe, turnover: cero.turnover };
  }
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (window.sharpeNetoDe(estrategia, mid).sharpe > ref.sharpe) lo = mid; else hi = mid;
  }
  return { pb: (lo + hi) / 2, sharpeBruto: cero.sharpe, sharpeRef: ref.sharpe,
           turnover: cero.turnover };
};

/** Cuantos anios y rebalanceos hay detras de ese numero. */
window.protocoloBacktest = function () { return BT.datos ? BT.datos.protocolo : null; };

window.redibujarBacktest = function () { if (BT.datos) recalcularBT(); };
window.alHaberDatos(window.iniciarBacktest);
