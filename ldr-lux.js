// =========================================================
// ldr-lux.js
// Calibración de los LDR contra un luxómetro.
// El maestro manda la luz como % (lectura del ADC). Con pares
// (% de la interfaz, lux del luxómetro) se arma una curva y la
// interfaz muestra debajo del % una estimación en lux.
// Es una estimación: el LDR no reemplaza al luxómetro ni a un radiómetro.
// =========================================================

const LUX_MIN_PCT = 20;   // por debajo de esto no se calcula el error en %

const r2 = (ys, preds) => {
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ssTot = ys.reduce((a, y) => a + (y - m) ** 2, 0);
  const ssRes = ys.reduce((a, y, i) => a + (y - preds[i]) ** 2, 0);
  return ssTot > 0 ? 1 - ssRes / ssTot : null;
};

function ajusteLineal(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!sxx) return null;
  const m = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const c = my - m * mx;
  return { m, c, f: x => m * x + c };
}

// Modelo con los puntos guardados.
function construirModelo(puntos) {
  // Varias mediciones con el mismo % se promedian (y se guarda su dispersión).
  const grupos = new Map();
  for (const p of puntos) {
    const k = Number(p.pct);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(Number(p.lux));
  }
  const curva = [...grupos.entries()].sort((a, b) => a[0] - b[0]).map(([pct, v]) => {
    const media = v.reduce((a, b) => a + b, 0) / v.length;
    const de = v.length > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - media) ** 2, 0) / (v.length - 1)) : null;
    return { pct, lux: media, n: v.length, de };
  });

  const estimar = pct => {
    const x = Number(pct);
    if (!Number.isFinite(x) || curva.length < 2) return null;
    const a = curva[0], z = curva[curva.length - 1];
    if (x <= a.pct) return { lux: Math.max(0, a.lux), fuera_rango: x < a.pct };
    if (x >= z.pct) return { lux: Math.max(0, z.lux), fuera_rango: x > z.pct };
    let i = 1;
    while (curva[i].pct < x) i++;
    const p0 = curva[i - 1], p1 = curva[i];
    const t = (x - p0.pct) / (p1.pct - p0.pct);
    return { lux: Math.max(0, p0.lux + t * (p1.lux - p0.lux)), fuera_rango: false };
  };

  // Ajustes para el documento (con todos los puntos, no con los promedios).
  const xs = puntos.map(p => Number(p.pct)), ys = puntos.map(p => Number(p.lux));
  const lin = ajusteLineal(xs, ys);
  const pos = puntos.filter(p => Number(p.pct) > 0 && Number(p.lux) > 0);
  const lnFit = ajusteLineal(pos.map(p => Math.log(Number(p.pct))), pos.map(p => Math.log(Number(p.lux))));
  const pot = lnFit ? { a: Math.exp(lnFit.c), b: lnFit.m, f: x => (x > 0 ? Math.exp(lnFit.c) * x ** lnFit.m : 0) } : null;

  const ajustes = {
    lineal: lin && xs.length >= 3 ? { m: lin.m, c: lin.c, r2: r2(ys, xs.map(lin.f)) } : null,
    potencia: pot && pos.length >= 3 ? { a: pot.a, b: pot.b, r2: r2(pos.map(p => Number(p.lux)), pos.map(p => pot.f(Number(p.pct)))) } : null,
  };

  const posE = puntos.filter(p => Number(p.lux) > 0);
  const expFit = construirExponencial(posE);
  ajustes.exponencial = expFit && posE.length >= 3
    ? { a: expFit.a, b: expFit.b, r2: r2(posE.map(p => Number(p.lux)), posE.map(p => expFit.f(Number(p.pct)))) } : null;

  // Se prueban tres formas de estimar y se usa la que menos se equivoca con puntos que no vio
  // (validación "dejando uno fuera": cada punto se estima con la curva hecha sin él).
  const metodos = {
    interpolacion: { nombre: 'Interpolación entre puntos', crear: pts => construirCurvaSimple(pts), min: 2 },
    exponencial:   { nombre: 'Curva exponencial', crear: pts => construirExponencial(pts.filter(q => Number(q.lux) > 0))?.f, min: 4 },
    potencia:      { nombre: 'Curva de potencia', crear: pts => construirPotencia(pts)?.f, min: 4 },
  };
  const evaluar = crear => puntos.map(p => {
    const otros = puntos.filter(q => q !== p);
    const f = otros.length >= 2 ? crear(otros) : null;
    const est = f ? Math.max(0, f(Number(p.pct))) : null;
    const lux = Number(p.lux);
    return { id: p.id, estimado: est, error: est != null ? est - lux : null,
             // Con muy poca luz (casi oscuro) el error en % no dice nada: 10 lux de diferencia sobre 2 lux es 500 %.
             error_pct: est != null && lux >= LUX_MIN_PCT ? ((est - lux) / lux) * 100 : null };
  });
  const resumir = errs => {
    const v = errs.filter(e => e.error != null), vp = v.filter(e => e.error_pct != null);
    return { mae: v.length ? v.reduce((a, e) => a + Math.abs(e.error), 0) / v.length : null,
             mape: vp.length ? vp.reduce((a, e) => a + Math.abs(e.error_pct), 0) / vp.length : null };
  };
  const evaluados = Object.entries(metodos)
    .filter(([, m]) => puntos.length >= m.min && m.crear(puntos))
    .map(([k, m]) => { const errores = evaluar(m.crear); return { k, nombre: m.nombre, errores, ...resumir(errores), f: m.crear(puntos) }; });
  const elegido = evaluados.filter(e => e.mae != null).sort((a, b) => a.mae - b.mae)[0] || evaluados[0] || null;

  const estimarFinal = pct => {
    if (!elegido || elegido.k === 'interpolacion') return estimar(pct);
    const x = Number(pct);
    if (!Number.isFinite(x)) return null;
    return { lux: Math.max(0, elegido.f(x)), fuera_rango: x < curva[0].pct || x > curva[curva.length - 1].pct };
  };
  const resumen = {
    puntos: puntos.length, niveles: curva.length,
    metodo: elegido ? elegido.k : null, metodo_nombre: elegido ? elegido.nombre : null,
    mae: elegido?.mae ?? null, mape: elegido?.mape ?? null,
    comparacion: evaluados.map(e => ({ metodo: e.k, nombre: e.nombre, mae: e.mae, mape: e.mape })),
  };
  return { curva, estimar: estimarFinal, ajustes, errores: elegido?.errores || [], resumen, listo: curva.length >= 2 };
}

function construirExponencial(pts) {
  const f = ajusteLineal(pts.map(p => Number(p.pct)), pts.map(p => Math.log(Number(p.lux))));
  if (!f || pts.length < 2) return null;
  const a = Math.exp(f.c), b = f.m;
  return { a, b, f: x => a * Math.exp(b * x) };
}

function construirPotencia(pts) {
  const pos = pts.filter(p => Number(p.pct) > 0 && Number(p.lux) > 0);
  const f = ajusteLineal(pos.map(p => Math.log(Number(p.pct))), pos.map(p => Math.log(Number(p.lux))));
  if (!f || pos.length < 2) return null;
  const a = Math.exp(f.c), b = f.m;
  return { a, b, f: x => (x > 0 ? a * x ** b : 0) };
}

// Interpolación sola, para la validación dejando uno fuera.
function construirCurvaSimple(puntos) {
  const g = new Map();
  for (const p of puntos) { const k = Number(p.pct); g.set(k, [...(g.get(k) || []), Number(p.lux)]); }
  const c = [...g.entries()].sort((a, b) => a[0] - b[0]).map(([pct, v]) => ({ pct, lux: v.reduce((a, b) => a + b, 0) / v.length }));
  if (c.length < 2) return null;
  return x => {
    if (x <= c[0].pct) return c[0].lux;
    if (x >= c[c.length - 1].pct) return c[c.length - 1].lux;
    let i = 1; while (c[i].pct < x) i++;
    const t = (x - c[i - 1].pct) / (c[i].pct - c[i - 1].pct);
    return c[i - 1].lux + t * (c[i].lux - c[i - 1].lux);
  };
}

export function registrarLdrLux(app, { pool, ldrActual, ldrEnVivo }) {
  let puntos = [];
  let modelo = construirModelo([]);

  async function cargar() {
    try {
      const [rows] = await pool.query(
        `SELECT id, pct, lux, nota, DATE_FORMAT(created_at, '%d/%m/%Y %H:%i') AS fecha FROM calibracion_ldr ORDER BY pct, id`);
      puntos = rows.map(r => ({ ...r, pct: Number(r.pct), lux: Number(r.lux) }));
      modelo = construirModelo(puntos);
    } catch (e) { console.warn('[LDR] no se pudo leer la calibración:', e.message); }
  }

  const estado = () => ({
    ok: true, listo: modelo.listo, ahora: { pct: ldrActual(), en_vivo: ldrEnVivo() },
    puntos: puntos.map(p => ({ ...p, ...(modelo.errores.find(e => e.id === p.id) || {}) })),
    curva: modelo.curva, ajustes: modelo.ajustes, resumen: modelo.resumen,
  });

  app.get('/api/superuser/ldr-calibracion', (_req, res) => res.json(estado()));

  // Guarda un punto. Si no se manda el %, se usa la lectura actual de la lámpara.
  app.post('/api/superuser/ldr-calibracion', async (req, res) => {
    try {
      const lux = Number(String(req.body?.lux ?? '').replace(',', '.'));
      let pct = req.body?.pct;
      pct = pct === '' || pct == null ? ldrActual() : Number(String(pct).replace(',', '.'));
      if (!Number.isFinite(lux) || lux < 0 || lux > 200000)
        return res.status(400).json({ ok: false, message: 'Escribe los lux que marca el luxómetro.' });
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return res.status(400).json({ ok: false, message: 'No hay lectura de los LDR: enciende la lámpara o escribe el % a mano.' });
      await pool.execute(`INSERT INTO calibracion_ldr (pct, lux, nota) VALUES (?, ?, ?)`,
        [Math.round(pct * 10) / 10, lux, String(req.body?.nota || '').slice(0, 120) || null]);
      await cargar();
      res.json(estado());
    } catch (e) { console.error('[LDR]', e.message); res.status(500).json({ ok: false, error: 'server_error' }); }
  });

  app.delete('/api/superuser/ldr-calibracion/:id', async (req, res) => {
    try {
      if (req.params.id === 'todo') await pool.execute(`DELETE FROM calibracion_ldr`);
      else await pool.execute(`DELETE FROM calibracion_ldr WHERE id = ?`, [Number(req.params.id)]);
      await cargar();
      res.json(estado());
    } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
  });

  // Tabla para el documento de validación.
  app.get('/api/superuser/ldr-calibracion.csv', (_req, res) => {
    const f = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(d).replace('.', ','));
    const filas = [['N', 'Fecha', 'LDR (%)', 'Luxómetro (lux)', 'Estimado sin ese punto (lux)', 'Error (lux)', 'Error (%)', 'Nota']];
    estado().puntos.forEach((p, i) => filas.push([i + 1, p.fecha, f(p.pct), f(p.lux), f(p.estimado), f(p.error), f(p.error_pct), p.nota || '']));
    const a = modelo.ajustes;
    filas.push([]);
    if (a.lineal) filas.push(['Ajuste lineal', `lux = ${f(a.lineal.m, 3)} x % + ${f(a.lineal.c, 2)}`, `R2 = ${f(a.lineal.r2, 4)}`]);
    if (a.exponencial) filas.push(['Ajuste exponencial', `lux = ${f(a.exponencial.a, 4)} x e^(${f(a.exponencial.b, 5)} x %)`, `R2 = ${f(a.exponencial.r2, 4)}`]);
    if (a.potencia) filas.push(['Ajuste potencia', `lux = ${f(a.potencia.a, 4)} x %^${f(a.potencia.b, 4)}`, `R2 = ${f(a.potencia.r2, 4)}`]);
    filas.push(['Método usado en la interfaz', modelo.resumen.metodo_nombre || '']);
    (modelo.resumen.comparacion || []).forEach(c => filas.push([`Validación (dejando uno fuera): ${c.nombre}`, `${f(c.mae)} lux`, `${f(c.mape)} %`]));
    filas.push(['Error medio absoluto del método usado', `${f(modelo.resumen.mae)} lux`, 'Error medio', `${f(modelo.resumen.mape)} %`]);
    const csv = '﻿' + filas.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="calibracion_ldr_lux.csv"').send(csv);
  });

  return {
    // Lux estimados para un %; null si todavía no hay calibración.
    estimar: pct => (modelo.listo && pct != null ? modelo.estimar(pct) : null),
    recargar: cargar,
  };
}
