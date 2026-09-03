/* Frontera eficiente de Markowitz sobre los ETFs de BYMA.

   Optimiza en DOLARES: el Sharpe necesita una tasa libre de riesgo y la que
   tenemos es la de EE.UU. (T-bill 13 semanas). Una version en pesos exigiria
   una libre de riesgo en pesos, que es otra discusion.

   Restricciones: solo largo (w >= 0) y tope por activo. Sin ellas, maximizar
   Sharpe sobre 50 activos con 252 observaciones concentra todo en dos o tres
   posiciones: optimo en la muestra, inservible fuera de ella. El tope es lo
   que hace que la cartera sea efectivamente diversificada.

   Los tres perfiles son tres puntos de la MISMA frontera, no tres modelos:
     conservador = minima varianza
     moderado    = maximo Sharpe (cartera tangente)
     audaz       = mitad de camino, en volatilidad, entre la tangente y el
                   extremo de maximo retorno alcanzable con el tope. */

'use strict';

const DIAS_ANIO = 252;

const CART = {
  lookback: 252,
  tope: 0.15,
  excluirApal: true,
  perfil: 'moderado',
  res: null,
};

const PERFILES = [
  { id: 'conservador', nombre: 'Conservador', color: '#1B9E5A' },
  { id: 'moderado',    nombre: 'Moderado',    color: '#E08E16' },
  { id: 'audaz',       nombre: 'Audaz',       color: '#C0392B' },
];

/* ------------------------------------------------------- estadisticas --- */

/** Media diaria y covarianza en la ventana. Solo ruedas donde TODOS tienen
    dato: la covarianza tiene que salir del mismo conjunto de fechas para
    todos, o deja de ser una matriz consistente. */
function estadisticas(tickers, ventana) {
  const d = estado.datos;
  const N = tickers.length;
  const largo = d.fechas.length;
  const desde = Math.max(0, largo - ventana);
  const series = tickers.map((tk) => d.etfs[tk].ret);

  const filas = [];
  for (let t = desde; t < largo; t++) {
    let ok = true;
    for (let i = 0; i < N; i++) if (series[i][t] === null) { ok = false; break; }
    if (ok) filas.push(t);
  }
  if (filas.length < 40) return null;

  const mu = new Array(N).fill(0);
  for (const t of filas) for (let i = 0; i < N; i++) mu[i] += series[i][t];
  for (let i = 0; i < N; i++) mu[i] /= filas.length;

  const cov = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let s = 0;
      for (const t of filas) s += (series[i][t] - mu[i]) * (series[j][t] - mu[j]);
      cov[i][j] = cov[j][i] = s / (filas.length - 1);
    }
  }

  // correlacion, para medir descorrelacion de la cartera
  const sd = cov.map((f, i) => Math.sqrt(Math.max(f[i], 1e-18)));
  const corr = cov.map((f, i) => f.map((v, j) => v / (sd[i] * sd[j])));

  const tasas = [];
  for (const t of filas) {
    const v = d.tasaLibreRiesgo.pct[t];
    if (v !== null && v !== undefined) tasas.push(v);
  }
  const rfAnual = tasas.length ? tasas.reduce((a, b) => a + b, 0) / tasas.length / 100 : 0;

  return { mu, cov, corr, n: filas.length, rfAnual, rfDiaria: rfAnual / DIAS_ANIO };
}

/* ------------------------------------------------------------ algebra --- */

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function matVec(M, v) {
  const out = new Array(v.length).fill(0);
  for (let i = 0; i < v.length; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += M[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

const cuadratica = (M, v) => dot(v, matVec(M, v));

/** Proyeccion euclidea sobre {sum(w) = 1, 0 <= w <= tope}.
    Biseccion sobre el umbral tau tal que sum(clip(v - tau, 0, tope)) = 1;
    la suma es monotona decreciente en tau, con lo cual la biseccion converge. */
function proyectar(v, tope) {
  const n = v.length;
  if (tope * n < 1 - 1e-12) return null;
  const suma = (tau) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.min(Math.max(v[i] - tau, 0), tope);
    return s;
  };
  let lo = Math.min(...v) - 1, hi = Math.max(...v);
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (suma(mid) > 1) lo = mid; else hi = mid;
  }
  return v.map((x) => Math.min(Math.max(x - (lo + hi) / 2, 0), tope));
}

/** Ascenso de gradiente proyectado con backtracking. */
function ascender(w0, obj, grad, tope, iters = 700) {
  let w = w0.slice(), fw = obj(w), paso = 1;
  for (let k = 0; k < iters; k++) {
    const g = grad(w);
    let mejoro = false;
    for (let intento = 0; intento < 40; intento++) {
      const cand = proyectar(w.map((x, i) => x + paso * g[i]), tope);
      if (cand) {
        const fc = obj(cand);
        if (fc > fw + 1e-15) { w = cand; fw = fc; mejoro = true; paso *= 1.8; break; }
      }
      paso *= 0.5;
    }
    if (!mejoro) break;
  }
  return { w, f: fw };
}

/* -------------------------------------------------------- optimizacion --- */

/** max mu'w - lambda * w'Sigma w. Concavo: el gradiente proyectado llega al
    optimo global. Barriendo lambda se recorre la frontera entera. */
function puntoFrontera(mu, cov, tope, lam, w0) {
  const obj = (w) => dot(mu, w) - lam * cuadratica(cov, w);
  const grad = (w) => {
    const cw = matVec(cov, w);
    return mu.map((m, i) => m - 2 * lam * cw[i]);
  };
  const inicio = w0 || proyectar(new Array(mu.length).fill(1 / mu.length), tope);
  return inicio ? ascender(inicio, obj, grad, tope).w : null;
}

/** Cartera de maximo Sharpe (tangente), solo largo y con tope. */
function maxSharpe(mu, cov, rfDiaria, tope) {
  const n = mu.length;
  const exceso = mu.map((m) => m - rfDiaria);
  const obj = (w) => {
    const v = cuadratica(cov, w);
    return v <= 0 ? -Infinity : dot(exceso, w) / Math.sqrt(v);
  };
  const grad = (w) => {
    const cw = matVec(cov, w);
    const sig = Math.sqrt(Math.max(cuadratica(cov, w), 1e-18));
    const ew = dot(exceso, w);
    return exceso.map((e, i) => e / sig - (ew * cw[i]) / (sig ** 3));
  };

  // El Sharpe con restricciones no es concavo: arrancamos de varios lados
  // para no quedarnos en un optimo local.
  const arranques = [proyectar(new Array(n).fill(1 / n), tope)];
  const porRetorno = new Array(n).fill(0);
  exceso.map((e, i) => [e, i]).sort((a, b) => b[0] - a[0])
    .slice(0, Math.max(3, Math.ceil(1 / tope))).forEach(([, i]) => { porRetorno[i] = 1; });
  arranques.push(proyectar(porRetorno, tope));
  const inv = cov.map((f, i) => 1 / Math.sqrt(Math.max(f[i], 1e-12)));
  const sInv = inv.reduce((a, b) => a + b, 0);
  arranques.push(proyectar(inv.map((x) => x / sInv), tope));
  // y desde varios puntos de la propia frontera
  for (const lam of [1, 10, 100]) {
    const p = puntoFrontera(mu, cov, tope, lam);
    if (p) arranques.push(p);
  }

  let mejor = null;
  for (const a of arranques) {
    if (!a) continue;
    const r = ascender(a, obj, grad, tope);
    if (!mejor || r.f > mejor.f) mejor = r;
  }
  return mejor ? mejor.w : null;
}

function frontera(mu, cov, tope, puntos = 46) {
  const cruda = [];
  for (let k = 0; k < puntos; k++) {
    const lam = Math.pow(10, -1.5 + (k / (puntos - 1)) * 5);
    const w = puntoFrontera(mu, cov, tope, lam);
    if (w) cruda.push({ w, ret: dot(mu, w), var: cuadratica(cov, w) });
  }
  cruda.sort((a, b) => a.var - b.var);
  const efi = [];
  let mejorRet = -Infinity;
  for (const p of cruda) {
    if (p.ret > mejorRet + 1e-13) { efi.push(p); mejorRet = p.ret; }
  }
  return efi;
}

/* ------------------------------------------------------------ metricas --- */

function anualizar(retDiario, varDiaria, rfAnual) {
  const ret = retDiario * DIAS_ANIO;
  const vol = Math.sqrt(Math.max(varDiaria, 0) * DIAS_ANIO);
  return { ret, vol, sharpe: vol > 0 ? (ret - rfAnual) / vol : 0 };
}

/** Correlacion media entre las posiciones, ponderada por peso.
    Es la medida directa de cuanta descorrelacion tiene la cartera: dos ETFs
    que pesan mucho y se mueven igual cuentan mas que dos que pesan poco. */
function correlacionMedia(w, corr) {
  let num = 0, den = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = i + 1; j < w.length; j++) {
      const p = w[i] * w[j];
      if (p > 0) { num += p * corr[i][j]; den += p; }
    }
  }
  return den > 0 ? num / den : null;
}

/** 1/HHI: a cuantas posiciones igualmente ponderadas equivale la cartera. */
const posicionesEfectivas = (w) => 1 / w.reduce((a, x) => a + x * x, 0);

function componer(w, tickers, st) {
  const m = anualizar(dot(st.mu, w), cuadratica(st.cov, w), st.rfAnual);
  const pesos = tickers.map((tk, i) => ({ tk, w: w[i], i }))
    .filter((p) => p.w > 0.002)
    .sort((a, b) => b.w - a.w);
  const porCat = {};
  for (const p of pesos) {
    const c = estado.datos.etfs[p.tk].categoria;
    porCat[c] = (porCat[c] || 0) + p.w;
  }
  return {
    w, ...m, pesos,
    corrMedia: correlacionMedia(w, st.corr),
    nEfectivo: posicionesEfectivas(w),
    porCategoria: Object.entries(porCat).sort((a, b) => b[1] - a[1]),
  };
}

function universoCartera() {
  const E = estado.datos.etfs;
  return Object.keys(E)
    .filter((tk) => !(CART.excluirApal && E[tk].categoria === 'Apalancado / Inverso'))
    .sort();
}

function calcularCartera() {
  const tickers = universoCartera();
  const st = estadisticas(tickers, CART.lookback);
  if (!st) return null;

  const fr = frontera(st.mu, st.cov, CART.tope);
  if (fr.length < 2) return null;

  const wTan = maxSharpe(st.mu, st.cov, st.rfDiaria, CART.tope);
  if (!wTan) return null;

  const volTan = Math.sqrt(cuadratica(st.cov, wTan) * DIAS_ANIO);
  const volMax = Math.sqrt(fr[fr.length - 1].var * DIAS_ANIO);

  // Conservador: minima varianza (el extremo izquierdo de la frontera).
  const wCons = fr[0].w;
  // Audaz: mitad de camino en volatilidad entre la tangente y el maximo.
  const objetivoVol = volTan + (volMax - volTan) * 0.5;
  let wAud = fr[fr.length - 1].w, mejorDist = Infinity;
  for (const p of fr) {
    const v = Math.sqrt(p.var * DIAS_ANIO);
    if (v >= volTan - 1e-9 && Math.abs(v - objetivoVol) < mejorDist) {
      mejorDist = Math.abs(v - objetivoVol); wAud = p.w;
    }
  }

  const eq = new Array(tickers.length).fill(1 / tickers.length);

  return {
    tickers, st, ruedas: st.n, rfAnual: st.rfAnual,
    carteras: {
      conservador: componer(wCons, tickers, st),
      moderado: componer(wTan, tickers, st),
      audaz: componer(wAud, tickers, st),
    },
    equi: componer(eq, tickers, st),
    frontera: fr.map((p) => ({ ...anualizar(p.ret, p.var, st.rfAnual) })),
    individuales: tickers.map((tk, i) => ({
      tk, ...anualizar(st.mu[i], st.cov[i][i], st.rfAnual),
      categoria: estado.datos.etfs[tk].categoria,
    })),
  };
}

/* ------------------------------------------------- estabilidad (bootstrap) --- */

/** Bootstrap por bloques circulares.
    Remuestrear ruedas sueltas destruiria el agrupamiento de volatilidad y la
    autocorrelacion, y daria una covarianza mas prolija que la real. Con
    bloques contiguos esa estructura sobrevive. */
function remuestrearBloques(filas, largoBloque, rnd) {
  const T = filas.length;
  const out = [];
  while (out.length < T) {
    const ini = Math.floor(rnd() * T);
    for (let k = 0; k < largoBloque && out.length < T; k++) {
      out.push(filas[(ini + k) % T]);
    }
  }
  return out;
}

/** Generador reproducible: dos visitas a la pagina tienen que dar lo mismo. */
function rngSemilla(s) {
  let a = s >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function estadisticasDe(filas) {
  const T = filas.length, N = filas[0].length;
  const mu = new Array(N).fill(0);
  for (const f of filas) for (let i = 0; i < N; i++) mu[i] += f[i];
  for (let i = 0; i < N; i++) mu[i] /= T;
  const cov = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let s = 0;
      for (const f of filas) s += (f[i] - mu[i]) * (f[j] - mu[j]);
      cov[i][j] = cov[j][i] = s / (T - 1);
    }
  }
  return { mu, cov };
}

/** Reoptimiza sobre muestras remuestreadas y devuelve, por ticker, cuanto
    se mueve su peso. Es la respuesta a "¿cuanto de este 15% es senal?". */
let TOKEN_BOOT = 0;

function bootstrapPesos(r, muestras, alListo, alProgreso) {
  const miToken = ++TOKEN_BOOT;
  const tickers = r.tickers;
  const N = tickers.length;
  const d = estado.datos;
  const largo = d.fechas.length;
  const desde = Math.max(0, largo - CART.lookback);

  const filas = [];
  for (let t = desde; t < largo; t++) {
    const fila = new Array(N);
    let ok = true;
    for (let i = 0; i < N; i++) {
      const v = d.etfs[tickers[i]].ret[t];
      if (v === null) { ok = false; break; }
      fila[i] = v;
    }
    if (ok) filas.push(fila);
  }
  if (filas.length < 60) { alListo(null); return; }

  const rnd = rngSemilla(20260903);
  const acum = tickers.map(() => []);
  const wBase = r.carteras[CART.perfil].w;
  let hecho = 0;

  function tanda() {
    if (miToken !== TOKEN_BOOT) return;   // arrancó otra corrida: esta se descarta
    const t0 = performance.now();
    while (hecho < muestras && performance.now() - t0 < 90) {
      const rem = remuestrearBloques(filas, 10, rnd);
      const { mu, cov } = estadisticasDe(rem);
      let w;
      if (CART.perfil === 'conservador') {
        const obj = (x) => -cuadratica(cov, x);
        const grad = (x) => matVec(cov, x).map((v) => -2 * v);
        w = ascender(wBase, obj, grad, CART.tope, 220).w;
      } else {
        const rfD = r.rfAnual / DIAS_ANIO;
        const ex = mu.map((m) => m - rfD);
        const obj = (x) => {
          const v = cuadratica(cov, x);
          return v <= 0 ? -Infinity : dot(ex, x) / Math.sqrt(v);
        };
        const grad = (x) => {
          const cw = matVec(cov, x);
          const sig = Math.sqrt(Math.max(cuadratica(cov, x), 1e-18));
          const ew = dot(ex, x);
          return ex.map((e, i) => e / sig - (ew * cw[i]) / (sig ** 3));
        };
        w = ascender(wBase, obj, grad, CART.tope, 220).w;
      }
      for (let i = 0; i < N; i++) acum[i].push(w[i]);
      hecho++;
    }
    alProgreso(hecho / muestras);
    if (hecho < muestras) {
      setTimeout(tanda, 0);        // devolvemos el hilo: la pagina no se traba
    } else {
      const pct = (arr, p) => {
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(p * s.length))];
      };
      alListo(tickers.map((tk, i) => ({
        tk,
        base: wBase[i],
        mediana: pct(acum[i], 0.5),
        p10: pct(acum[i], 0.10),
        p90: pct(acum[i], 0.90),
        frecuencia: acum[i].filter((x) => x > 0.01).length / acum[i].length,
      })));
    }
  }
  setTimeout(tanda, 0);
}

function dibujarEstabilidad(filas) {
  const cont = $('#estabilidad');
  const E = estado.datos.etfs;
  if (!filas) { cont.innerHTML = '<p class="nota">Sin datos suficientes.</p>'; return; }

  const conPeso = filas.filter((f) => f.base > 0.002 || f.frecuencia > 0.2)
    .sort((a, b) => b.base - a.base || b.mediana - a.mediana);
  const maxX = Math.max(CART.tope, ...conPeso.map((f) => f.p90)) * 1.02;
  const col = colorPerfil(CART.perfil);

  const filasHtml = conPeso.map((f) => {
    const x = (v) => (v / maxX * 100).toFixed(2) + '%';
    const anchoRango = (f.p90 - f.p10) / maxX * 100;
    const seguro = f.frecuencia >= 0.8;
    return `<tr title="${(E[f.tk].driver || '').replace(/"/g, '')}">
      <td><span class="tk">${f.tk}</span></td>
      <td class="num">${pctC(f.base)}</td>
      <td class="celda-rango">
        <span class="rango-pista"></span>
        <span class="rango-barra" style="left:${x(f.p10)};width:${anchoRango.toFixed(2)}%;background:${col}"></span>
        <span class="rango-punto" style="left:${x(f.base)}"></span>
      </td>
      <td class="num tenue">${pctC(f.p10)}&nbsp;–&nbsp;${pctC(f.p90)}</td>
      <td class="num ${seguro ? '' : 'frag'}">${Math.round(f.frecuencia * 100)}%</td>
    </tr>`;
  }).join('');

  const frecMedia = conPeso.reduce((a, f) => a + f.frecuencia, 0) / (conPeso.length || 1);
  const firmes = conPeso.filter((f) => f.frecuencia >= 0.8).length;

  cont.innerHTML = `
    <table class="tabla-datos compacta tabla-estab">
      <thead><tr>
        <th>ETF</th><th class="num">Peso</th>
        <th>Rango del peso según la muestra (p10–p90)</th>
        <th class="num">Rango</th><th class="num">Aparece</th>
      </tr></thead>
      <tbody>${filasHtml}</tbody>
    </table>
    <p class="nota">Se remuestrea la ventana por bloques de 10 ruedas —para no romper el
      agrupamiento de volatilidad— y se reoptimiza 150 veces. <strong>Aparece</strong> es en
      qué porcentaje de esas muestras el ETF entra con más de 1%.
      Sólo <strong>${firmes} de ${conPeso.length}</strong> posiciones aparecen en 8 de cada 10
      muestras; la frecuencia media es ${Math.round(frecMedia * 100)}%.</p>`;
}

// El bootstrap tarda ~20 s. Cambiar de tema no cambia la cartera, asi que
// se cachea por configuracion y solo se recalcula cuando algo la afecta.
const CACHE_ESTAB = new Map();

function correrEstabilidad(r) {
  const cont = $('#estabilidad');
  const clave = [CART.perfil, CART.lookback, CART.tope, CART.excluirApal,
                 estado.datos.ultimaRueda].join('|');
  if (CACHE_ESTAB.has(clave)) { dibujarEstabilidad(CACHE_ESTAB.get(clave)); return; }
  cont.innerHTML = '<p class="nota calculando">Remuestreando la ventana y reoptimizando…</p>';
  bootstrapPesos(r, 150,
    (filas) => { CACHE_ESTAB.set(clave, filas); dibujarEstabilidad(filas); },
    (p) => {
      const n = cont.querySelector('.calculando');
      if (n) n.textContent = `Remuestreando la ventana y reoptimizando… ${Math.round(p * 100)}%`;
    });
}

/* -------------------------------------------------------------- render --- */

const pctC = (x) => (x * 100).toFixed(1).replace('.', ',') + '%';
const pct0C = (x) => Math.round(x * 100) + '%';
const num2 = (x) => x.toFixed(2).replace('.', ',');

function colorPerfil(id) {
  return (PERFILES.find((p) => p.id === id) || PERFILES[1]).color;
}

function dibujarFronteraSVG(r) {
  const svg = $('#g-frontera');
  svg.textContent = '';
  const W = Math.max(320, svg.parentElement.clientWidth), H = 330;
  const m = { t: 12, r: 14, b: 42, l: 54 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);

  const xs = r.individuales.map((p) => p.vol).concat(r.frontera.map((p) => p.vol), [0]);
  const ys = r.individuales.map((p) => p.ret).concat(r.frontera.map((p) => p.ret), [r.rfAnual]);
  const x1 = Math.max(...xs) * 1.05;
  const y0 = Math.min(...ys, 0) * 1.1, y1 = Math.max(...ys) * 1.08;
  const X = (v) => m.l + (v / x1) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);

  for (let i = 0; i <= 5; i++) {
    const v = y0 + (i / 5) * (y1 - y0);
    svg.appendChild(el('line', { x1: m.l, y1: Y(v), x2: W - m.r, y2: Y(v),
      stroke: 'var(--linea)', 'stroke-width': 1 }));
    const t = el('text', { x: m.l - 7, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'eje-lbl' });
    t.textContent = pct0C(v); svg.appendChild(t);
    const vx = (i / 5) * x1;
    const tx = el('text', { x: X(vx), y: H - m.b + 15, 'text-anchor': 'middle', class: 'eje-lbl' });
    tx.textContent = pct0C(vx); svg.appendChild(tx);
  }
  const tt = el('text', { x: (m.l + W - m.r) / 2, y: H - 8, 'text-anchor': 'middle', class: 'eje-tit' });
  tt.textContent = 'Volatilidad anualizada'; svg.appendChild(tt);
  const ty = el('text', { x: 13, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'eje-tit',
    transform: `rotate(-90 13 ${(m.t + H - m.b) / 2})` });
  ty.textContent = 'Retorno anualizado'; svg.appendChild(ty);

  // ETFs sueltos: el punto de comparacion es que la frontera queda arriba
  // y a la izquierda de casi todos ellos.
  for (const p of r.individuales) {
    const c = el('circle', { cx: X(p.vol), cy: Y(p.ret), r: 3.2,
      fill: 'var(--steel-gray)', 'fill-opacity': .7 });
    const ti = el('title');
    ti.textContent = `${p.tk} · retorno ${pctC(p.ret)} · vol ${pctC(p.vol)} · Sharpe ${num2(p.sharpe)}`;
    c.appendChild(ti); svg.appendChild(c);
  }

  // Linea del mercado de capitales: su pendiente ES el Sharpe de la tangente.
  const tan = r.carteras.moderado;
  svg.appendChild(el('line', {
    x1: X(0), y1: Y(r.rfAnual),
    x2: X(x1), y2: Y(r.rfAnual + (tan.ret - r.rfAnual) * (x1 / Math.max(tan.vol, 1e-9))),
    stroke: 'var(--steel-gray)', 'stroke-width': 1.5, 'stroke-opacity': .9,
  }));

  let d = '';
  r.frontera.forEach((p, i) => { d += (i ? 'L' : 'M') + X(p.vol).toFixed(1) + ' ' + Y(p.ret).toFixed(1); });
  svg.appendChild(el('path', { d, fill: 'none', stroke: 'var(--trazo)', 'stroke-width': 2.5,
    'stroke-linejoin': 'round' }));

  const eq = r.equi;
  svg.appendChild(el('circle', { cx: X(eq.vol), cy: Y(eq.ret), r: 4.5,
    fill: 'var(--superficie)', stroke: 'var(--label-gray)', 'stroke-width': 2 }));
  const le = el('text', { x: X(eq.vol) + 8, y: Y(eq.ret) + 12, class: 'pt-lbl' });
  le.textContent = 'Equiponderada'; svg.appendChild(le);

  for (const perf of PERFILES) {
    const c = r.carteras[perf.id];
    const activo = perf.id === CART.perfil;
    svg.appendChild(el('circle', { cx: X(c.vol), cy: Y(c.ret), r: activo ? 8 : 5.5,
      fill: perf.color, stroke: 'var(--superficie)', 'stroke-width': 2 }));
    if (activo) {
      const l = el('text', { x: X(c.vol) + 12, y: Y(c.ret) + 4, class: 'pt-lbl destacado' });
      l.textContent = perf.nombre; svg.appendChild(l);
    }
  }
}

function dibujarPesos(c) {
  const cuerpo = $('#tabla-pesos tbody');
  cuerpo.textContent = '';
  const E = estado.datos.etfs;
  const maxW = c.pesos.length ? c.pesos[0].w : 1;
  const col = colorPerfil(CART.perfil);
  for (const p of c.pesos) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="tk">${p.tk}</span> <span class="tk-desc">${E[p.tk].nombre}</span></td>`
      + `<td class="cat-cel">${E[p.tk].categoria}</td>`
      + `<td class="num">${pctC(p.w)}</td>`
      + `<td class="barra-cel"><span class="barra" style="width:${(p.w / maxW * 100).toFixed(1)}%;background:${col}"></span></td>`;
    tr.title = E[p.tk].driver || '';
    cuerpo.appendChild(tr);
  }
}

function dibujarMezcla(c) {
  const cont = $('#mezcla');
  cont.textContent = '';
  const total = c.porCategoria.reduce((a, [, v]) => a + v, 0) || 1;
  for (const [cat, v] of c.porCategoria) {
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.style.width = (v / total * 100).toFixed(2) + '%';
    seg.style.background = colorCategoria(cat);
    seg.title = `${cat}: ${pctC(v)}`;
    cont.appendChild(seg);
  }
  const leyenda = $('#mezcla-leyenda');
  leyenda.textContent = '';
  for (const [cat, v] of c.porCategoria) {
    const s = document.createElement('span');
    s.className = 'mz-item';
    s.innerHTML = `<span class="mz-punto" style="background:${colorCategoria(cat)}"></span>`
      + `${cat} <strong>${pctC(v)}</strong>`;
    leyenda.appendChild(s);
  }
}

/* Secuencia de data-viz de la marca, asignada por categoria en orden fijo:
   el color sigue a la categoria, nunca a su posicion en el ranking. */
const SEC_CAT = ['#002060', '#145E81', '#00B0F0', '#A7B2C8', '#0F4C68', '#6B7280', '#1B9E5A', '#E08E16'];
const ORDEN_CAT = ['Indice amplio EE.UU.', 'Factor / Estilo', 'Sectorial EE.UU.', 'Tematico',
                   'Internacional', 'Commodities y metales', 'Cripto', 'Apalancado / Inverso'];
const colorCategoria = (c) => SEC_CAT[Math.max(0, ORDEN_CAT.indexOf(c)) % SEC_CAT.length];

/* --------------------------------------------------------- comentario --- */

const TEXTO_PERFIL = {
  conservador: 'Es la cartera de <strong>mínima varianza</strong>: el punto donde la frontera '
    + 'dobla a la izquierda. No busca el mayor retorno sino el menor movimiento, y llega ahí '
    + 'apoyándose en activos cuyos drivers no coinciden.',
  moderado: 'Es la <strong>cartera tangente</strong>: la que maximiza el Sharpe, o sea el retorno '
    + 'por unidad de riesgo. Es el punto donde la recta que sale de la tasa libre de riesgo toca '
    + 'la frontera; ninguna otra combinación de estos ETFs tuvo mejor relación en la ventana.',
  audaz: 'Está sobre la frontera pero a la derecha de la tangente: acepta más volatilidad a cambio '
    + 'de más retorno esperado. Por definición su Sharpe es menor que el del perfil moderado — '
    + 'no es una cartera mejor, es una más agresiva.',
};

function comentario(r, c) {
  const E = estado.datos.etfs;
  const partes = [];

  partes.push(`<p>${TEXTO_PERFIL[CART.perfil]}</p>`);

  // Por que esta descorrelacionada, con el numero adelante
  const univ = r.equi.corrMedia;
  partes.push(
    `<p><strong>Por qué está descorrelacionada.</strong> La correlación media entre las posiciones, `
    + `ponderada por peso, es <strong>${num2(c.corrMedia)}</strong>, contra ${num2(univ)} `
    + `del universo entero equiponderado. Eso no sale de una regla que se lo pida: el optimizador `
    + `minimiza <em>w'Σw</em>, y la covarianza baja justamente cuando los activos no se mueven `
    + `juntos. Buscar poca varianza es buscar descorrelación.</p>`);

  // Que sectores
  const mezcla = c.porCategoria.map(([cat, v]) => `${cat} ${pct0C(v)}`).join(' · ');
  partes.push(
    `<p><strong>Qué sectores.</strong> ${mezcla}. Reparte en `
    + `<strong>${c.nEfectivo.toFixed(1)} posiciones efectivas</strong> `
    + `(1/HHI: a cuántas posiciones de igual peso equivale esta concentración) sobre `
    + `${c.pesos.length} ETFs con peso, con un tope de ${pct0C(CART.tope)} por activo.</p>`);

  // A que drivers reacciona cada posicion
  const top = c.pesos.slice(0, 6);
  partes.push('<p><strong>A qué reacciona cada posición.</strong></p><ul class="drivers">'
    + top.map((p) => `<li><span class="dv-tk">${p.tk}</span> <span class="dv-w">${pctC(p.w)}</span>`
      + `<span class="dv-txt">${E[p.tk].driver || E[p.tk].nombre}</span></li>`).join('')
    + '</ul>'
    + (c.pesos.length > top.length
      ? `<p class="nota">Las otras ${c.pesos.length - top.length} posiciones tienen su driver en el tooltip de la tabla.</p>`
      : ''));

  // El par mas descorrelacionado de la cartera, como evidencia concreta
  let peor = null;
  for (let a = 0; a < c.pesos.length; a++) {
    for (let b = a + 1; b < c.pesos.length; b++) {
      const rho = r.st.corr[c.pesos[a].i][c.pesos[b].i];
      if (!peor || rho < peor.rho) peor = { rho, a: c.pesos[a].tk, b: c.pesos[b].tk };
    }
  }
  if (peor) {
    partes.push(
      `<p><strong>El par que más se compensa.</strong> ${peor.a} contra ${peor.b}, correlación `
      + `<strong>${num2(peor.rho)}</strong> en la ventana. Ese es el tipo de pareja que le baja `
      + `la volatilidad al conjunto sin resignar retorno.</p>`);
  }

  $('#comentario').innerHTML = partes.join('');
}

function dibujarMetricas(r, c) {
  $('#m-ret').textContent = pctC(c.ret);
  $('#m-vol').textContent = pctC(c.vol);
  $('#m-sharpe').textContent = num2(c.sharpe);
  $('#m-corr').textContent = num2(c.corrMedia);
  $('#m-npos').textContent = c.nEfectivo.toFixed(1);
  $('#m-sharpe').style.color = colorPerfil(CART.perfil);

  const eq = r.equi;
  $('#advertencia').innerHTML =
    `Estos números son <strong>dentro de la muestra</strong>: la cartera se eligió sabiendo cómo `
    + `terminó el período que después se usa para calificarla, así que el Sharpe de `
    + `${num2(c.sharpe)} está inflado por construcción y no es una expectativa. `
    + `Como referencia sin optimizar, la equiponderada de los mismos ${r.tickers.length} ETFs dio `
    + `Sharpe <strong>${num2(eq.sharpe)}</strong> (retorno ${pctC(eq.ret)}, volatilidad ${pctC(eq.vol)}). `
    + `La diferencia es lo que ganó el optimizador mirando el pasado, no lo que se puede esperar hacia adelante.`;
}

function recalcularCartera() {
  const r = calcularCartera();
  CART.res = r;
  const err = $('#cartera-error');
  if (!r) { err.hidden = false; return; }
  err.hidden = true;
  const c = r.carteras[CART.perfil];
  dibujarMetricas(r, c);
  dibujarPesos(c);
  dibujarMezcla(c);
  comentario(r, c);
  dibujarFronteraSVG(r);
  correrEstabilidad(r);
  $('#ruedas-usadas').textContent = r.ruedas;
  $('#rf-usada').textContent = pctC(r.rfAnual);
}

/* ---------------------------------------------------------------- init --- */

function conectarCartera() {
  const barra = $('#perfil-barra');
  PERFILES.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'perfil-btn' + (p.id === CART.perfil ? ' activo' : '');
    b.dataset.perfil = p.id;
    b.style.setProperty('--c', p.color);
    b.innerHTML = `<span class="pf-punto"></span><span class="pf-nombre">${p.nombre}</span>`
      + `<span class="pf-sub">${['menor riesgo', 'mejor Sharpe', 'mayor retorno'][i]}</span>`;
    b.addEventListener('click', () => {
      CART.perfil = p.id;
      $$('.perfil-btn').forEach((x) => x.classList.toggle('activo', x.dataset.perfil === p.id));
      recalcularCartera();
    });
    barra.appendChild(b);
  });

  $('#c-lookback').addEventListener('change', (e) => { CART.lookback = +e.target.value; recalcularCartera(); });
  $('#c-tope').addEventListener('change', (e) => { CART.tope = +e.target.value; recalcularCartera(); });
  $('#c-apal').addEventListener('change', (e) => { CART.excluirApal = e.target.checked; recalcularCartera(); });

  $('#descargar-cartera').addEventListener('click', () => {
    const r = CART.res;
    if (!r) return;
    const E = estado.datos.etfs;
    const filas = [['perfil', 'ticker', 'nombre', 'categoria', 'peso']];
    for (const id of ['conservador', 'moderado', 'audaz']) {
      for (const p of r.carteras[id].pesos) {
        filas.push([id, p.tk, `"${E[p.tk].nombre}"`, `"${E[p.tk].categoria}"`, p.w.toFixed(6)]);
      }
    }
    const url = URL.createObjectURL(new Blob([filas.map((f) => f.join(',')).join('\n')],
      { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `carteras-markowitz-${estado.datos.ultimaRueda}-${CART.lookback}r.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (CART.res) dibujarFronteraSVG(CART.res); }, 200);
  });
}

window.iniciarCartera = function () { conectarCartera(); recalcularCartera(); };
window.redibujarCartera = function () { if (CART.res) recalcularCartera(); };
