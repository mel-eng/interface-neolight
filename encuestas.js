// =========================================================
// encuestas.js
// Encuesta de satisfacción por invitación.
//  - El superusuario crea una invitación (nombre + rol) y obtiene un link único.
//  - La persona abre /encuesta/<token> sin cuenta, responde y firma
//    (dibujando con el dedo o subiendo una foto de su firma).
//  - El superusuario ve las respuestas, los promedios y un PDF con las firmas.
// =========================================================

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export const PREGUNTAS = [
  'Claridad de la explicación sobre el funcionamiento del sistema.',
  'Facilidad para comprender la información presentada en la interfaz digital.',
  'Utilidad de las herramientas de supervisión disponibles.',
  'Claridad de los indicadores y avisos del sistema.',
  'Organización y presentación del equipo y sus controles.',
  'Satisfacción general con la experiencia de evaluación del sistema.',
];
export const DECLARACION = 'Declaro que participé en la evaluación del sistema NEOLIGHT y que las respuestas de esta encuesta reflejan mi opinión personal.';
const ROLES = { tutor: 'Tutor', doctor: 'Doctor', ingeniero: 'Ingeniero' };
const MAX_FIRMA = 700_000;   // caracteres del dataURL

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limpiarFirma = v => {
  const s = String(v || '').trim();
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length < 600 || s.length > MAX_FIRMA) return null;
  return s;
};

export async function crearTablasEncuesta(safe) {
  await safe(`CREATE TABLE IF NOT EXISTS encuesta_invitaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token CHAR(32) NOT NULL UNIQUE,
      nombre VARCHAR(120) NOT NULL,
      rol ENUM('tutor','doctor','ingeniero') NOT NULL,
      creada_por INT NULL,
      usada_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await safe(`CREATE TABLE IF NOT EXISTS encuesta_respuestas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invitacion_id INT NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      ci VARCHAR(30) NOT NULL,
      rol ENUM('tutor','doctor','ingeniero') NOT NULL,
      fecha_evaluacion DATE NOT NULL,
      p1 TINYINT NOT NULL, p2 TINYINT NOT NULL, p3 TINYINT NOT NULL,
      p4 TINYINT NOT NULL, p5 TINYINT NOT NULL, p6 TINYINT NOT NULL,
      mejora TEXT NULL,
      declaracion TINYINT(1) NOT NULL DEFAULT 1,
      firma_nombre VARCHAR(120) NOT NULL,
      firma MEDIUMTEXT NOT NULL,
      firma_tipo ENUM('dibujada','foto') NOT NULL DEFAULT 'dibujada',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_resp_inv (invitacion_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export function registrarEncuestas(app, { pool, baseDir, requireSuperuser }) {
  const LOGO = (() => {
    try { return 'data:image/png;base64,' + fs.readFileSync(path.join(baseDir, 'excel_assets', 'logo_univalle.png')).toString('base64'); }
    catch { return null; }
  })();

  // ---------- Página pública ----------
  app.get('/encuesta/:token', (_req, res) => res.sendFile(path.join(baseDir, 'public', 'encuesta.html')));

  const buscarInvitacion = async token => {
    if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
    const [r] = await pool.execute(`SELECT * FROM encuesta_invitaciones WHERE token = ? LIMIT 1`, [token]);
    return r[0] || null;
  };

  app.get('/api/encuesta/:token', async (req, res) => {
    try {
      const inv = await buscarInvitacion(req.params.token);
      if (!inv) return res.status(404).json({ ok: false, message: 'Este link de encuesta no existe.' });
      res.json({ ok: true, nombre: inv.nombre, rol: inv.rol, rol_txt: ROLES[inv.rol], respondida: !!inv.usada_at,
                 preguntas: PREGUNTAS, declaracion: DECLARACION });
    } catch (e) { res.status(500).json({ ok: false, message: 'Error del servidor.' }); }
  });

  app.post('/api/encuesta/:token', async (req, res) => {
    try {
      const inv = await buscarInvitacion(req.params.token);
      if (!inv) return res.status(404).json({ ok: false, message: 'Este link de encuesta no existe.' });
      if (inv.usada_at) return res.status(409).json({ ok: false, message: 'Esta encuesta ya fue respondida. ¡Gracias!' });
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim().slice(0, 120);
      const ci = String(b.ci || '').trim().slice(0, 30);
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null;
      const notas = PREGUNTAS.map((_, i) => Number(b[`p${i + 1}`]));
      const firmaNombre = String(b.firma_nombre || '').trim().slice(0, 120);
      const firma = limpiarFirma(b.firma);
      if (nombre.length < 3) return res.status(400).json({ ok: false, message: 'Escribe tu nombre completo.' });
      if (ci.length < 4) return res.status(400).json({ ok: false, message: 'Escribe tu C.I.' });
      if (!fecha) return res.status(400).json({ ok: false, message: 'Elige la fecha de evaluación.' });
      if (notas.some(n => !Number.isInteger(n) || n < 1 || n > 5)) return res.status(400).json({ ok: false, message: 'Responde todas las preguntas del 1 al 5.' });
      if (b.declaracion !== true) return res.status(400).json({ ok: false, message: 'Acepta la declaración para enviar.' });
      if (firmaNombre.length < 3) return res.status(400).json({ ok: false, message: 'Escribe tu nombre completo junto a la firma.' });
      if (!firma) return res.status(400).json({ ok: false, message: 'Dibuja tu firma o sube una foto de ella.' });
      const tipo = b.firma_tipo === 'foto' ? 'foto' : 'dibujada';

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [u] = await conn.execute(`UPDATE encuesta_invitaciones SET usada_at = NOW() WHERE id = ? AND usada_at IS NULL`, [inv.id]);
        if (!u.affectedRows) { await conn.rollback(); return res.status(409).json({ ok: false, message: 'Esta encuesta ya fue respondida.' }); }
        await conn.execute(
          `INSERT INTO encuesta_respuestas (invitacion_id, nombre, ci, rol, fecha_evaluacion, p1, p2, p3, p4, p5, p6, mejora, declaracion, firma_nombre, firma, firma_tipo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [inv.id, nombre, ci, inv.rol, fecha, ...notas, String(b.mejora || '').trim().slice(0, 2000) || null, firmaNombre, firma, tipo]);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; }
      finally { conn.release(); }
      res.json({ ok: true });
    } catch (e) { console.error('[ENCUESTA]', e.message); res.status(500).json({ ok: false, message: 'No se pudo guardar. Intenta de nuevo.' }); }
  });

  // ---------- Superusuario ----------
  app.get('/api/superuser/encuestas', requireSuperuser, async (_req, res) => {
    try {
      const [inv] = await pool.query(
        `SELECT i.id, i.token, i.nombre, i.rol, i.usada_at, i.created_at, r.id AS respuesta_id,
                r.p1, r.p2, r.p3, r.p4, r.p5, r.p6, r.mejora, r.nombre AS r_nombre, r.ci, DATE_FORMAT(r.fecha_evaluacion, '%Y-%m-%d') AS fecha
         FROM encuesta_invitaciones i LEFT JOIN encuesta_respuestas r ON r.invitacion_id = i.id
         ORDER BY i.created_at DESC`);
      const resp = inv.filter(i => i.respuesta_id);
      const promedios = PREGUNTAS.map((_, k) => resp.length ? resp.reduce((a, r) => a + r[`p${k + 1}`], 0) / resp.length : null);
      res.json({ ok: true, preguntas: PREGUNTAS, invitaciones: inv, promedios, respondidas: resp.length });
    } catch (e) { res.status(500).json({ ok: false, message: 'Error del servidor.' }); }
  });

  app.post('/api/superuser/encuestas', requireSuperuser, async (req, res) => {
    try {
      const nombre = String(req.body?.nombre || '').trim().slice(0, 120);
      const rol = ROLES[req.body?.rol] ? req.body.rol : null;
      if (nombre.length < 3 || !rol) return res.status(400).json({ ok: false, message: 'Escribe el nombre y elige el rol.' });
      const token = crypto.randomBytes(16).toString('hex');
      await pool.execute(`INSERT INTO encuesta_invitaciones (token, nombre, rol, creada_por) VALUES (?, ?, ?, ?)`, [token, nombre, rol, req.auth?.id || null]);
      res.json({ ok: true, token });
    } catch (e) { res.status(500).json({ ok: false, message: 'No se pudo crear la invitación.' }); }
  });

  app.delete('/api/superuser/encuestas/:id', requireSuperuser, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await pool.execute(`DELETE FROM encuesta_respuestas WHERE invitacion_id = ?`, [id]);
      await pool.execute(`DELETE FROM encuesta_invitaciones WHERE id = ?`, [id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, message: 'No se pudo borrar.' }); }
  });

  // PDF (página imprimible) con una respuesta o con todas
  app.get('/api/superuser/encuestas/pdf', requireSuperuser, async (req, res) => {
    try {
      const id = req.query.id ? Number(req.query.id) : null;
      const [rows] = await pool.execute(
        `SELECT r.*, DATE_FORMAT(r.fecha_evaluacion, '%d/%m/%Y') AS fecha_txt, DATE_FORMAT(r.created_at, '%d/%m/%Y %H:%i') AS enviada
         FROM encuesta_respuestas r ${id ? 'WHERE r.invitacion_id = ?' : ''} ORDER BY FIELD(r.rol,'tutor','doctor','ingeniero'), r.created_at`, id ? [id] : []);
      if (!rows.length) return res.status(404).json({ ok: false, message: 'Todavía no hay respuestas.' });
      res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(htmlEncuestas(rows, !id, LOGO));
    } catch (e) { console.error('[ENCUESTA PDF]', e); res.status(500).json({ ok: false, message: 'Error del servidor.' }); }
  });
}

function htmlEncuestas(rows, resumen, LOGO) {
  const prom = PREGUNTAS.map((_, k) => rows.reduce((a, r) => a + r[`p${k + 1}`], 0) / rows.length);
  const general = prom.reduce((a, b) => a + b, 0) / prom.length;
  const coma = (v, d = 1) => Number(v).toFixed(d).replace('.', ',');
  const escala = n => [1, 2, 3, 4, 5].map(i => `<span class="pt ${i === n ? 'sel' : ''}">${i}</span>`).join('');
  const ficha = r => `
    <section class="ficha">
      <h2>Encuesta de satisfacción del sistema</h2>
      <p class="sub">Marque su nivel de satisfacción en cada aspecto, donde 1 = Muy insatisfecho y 5 = Muy satisfecho.</p>
      <div class="datos">
        <div><span>Nombre completo</span><b>${esc(r.nombre)}</b></div>
        <div><span>C.I.</span><b>${esc(r.ci)}</b></div>
        <div><span>Rol</span><b>${esc(ROLES[r.rol])}</b></div>
        <div><span>Fecha de evaluación</span><b>${esc(r.fecha_txt)}</b></div>
      </div>
      <table class="preg"><tbody>
        ${PREGUNTAS.map((p, i) => `<tr><td class="num">${i + 1}.</td><td>${esc(p)}</td><td class="esc"><small>Muy insatisfecho</small>${escala(r[`p${i + 1}`])}<small>Muy satisfecho</small></td></tr>`).join('')}
      </tbody></table>
      <div class="mejora"><span>7. ¿Qué aspecto considera que debería mejorarse?</span><p>${r.mejora ? esc(r.mejora) : '—'}</p></div>
      <div class="decl"><b>Declaración.</b> ${esc(DECLARACION)} <span class="ok">✔ Aceptada</span></div>
      <div class="firma"><img src="${r.firma}" alt="Firma"><div class="linea"></div><b>${esc(r.firma_nombre)}</b>
        <span>C.I. ${esc(r.ci)} · ${esc(ROLES[r.rol])} · enviada el ${esc(r.enviada)}</span></div>
    </section>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Encuesta de satisfacción · NEOLIGHT</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}
body{margin:0;font-family:Poppins,system-ui,sans-serif;color:#2e2442;background:#f4f1fa;font-size:12px}
.hoja{max-width:820px;margin:0 auto;background:#fff;padding:22px 26px}
header{display:flex;align-items:center;gap:16px;background:#a99bc9;color:#fff;border-radius:14px;padding:14px 18px;margin-bottom:14px}
header img{width:58px;height:58px}header h1{margin:0;font-size:17px}header p{margin:2px 0 0;font-size:11px}
.ficha{break-inside:avoid;page-break-after:always;padding-top:4px}.ficha:last-child{page-break-after:auto}
h2{font-size:15px;color:#3b2a63;margin:0 0 2px}.sub{margin:0 0 10px;color:#6b6475;font-size:11px}
.datos{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px}
.datos div{background:#f7f3ff;border-radius:10px;padding:7px 9px}.datos span{display:block;font-size:9.5px;color:#7a7385}.datos b{font-size:12px}
.preg{width:100%;border-collapse:collapse}.preg td{padding:7px 6px;border-bottom:1px solid #ece6f6;vertical-align:middle}
.preg .num{width:22px;color:#8e7cc3;font-weight:700}.esc{white-space:nowrap;text-align:right}.esc small{font-size:8.5px;color:#8a80a3;margin:0 5px}
.pt{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;border:1.5px solid #d4cbe8;margin:0 1px;font-size:10px;color:#8a80a3}
.pt.sel{background:#7c4dff;border-color:#7c4dff;color:#fff;font-weight:700}
.mejora{margin-top:10px}.mejora span{font-weight:600}.mejora p{margin:4px 0 0;background:#f7f3ff;border-radius:10px;padding:8px 10px;min-height:34px}
.decl{margin-top:10px;font-size:11px;color:#4a4060}.ok{color:#15803d;font-weight:700;margin-left:6px}
.firma{display:flex;flex-direction:column;align-items:center;margin-top:16px}.firma img{max-height:90px;max-width:300px;object-fit:contain}
.linea{width:300px;border-top:1.5px solid #3b2a63;margin:2px 0 6px}.firma span{color:#6b6475;font-size:10.5px}
.resumen{page-break-after:always}.kpi{display:flex;gap:10px;margin:8px 0 12px}.kpi div{flex:1;background:#f7f3ff;border-radius:12px;padding:10px}
.kpi span{display:block;color:#7a7385;font-size:10px}.kpi b{font-size:20px;color:#5f3fb8}
table.res{width:100%;border-collapse:collapse;font-size:11px}table.res th{background:#8e7cc3;color:#fff;text-align:left;padding:6px}
table.res td{padding:6px;border-bottom:1px solid #ece6f6}.barra{height:9px;background:#ece6f6;border-radius:9px;overflow:hidden;min-width:120px}.barra i{display:block;height:100%;background:#8e7cc3}
.imprimir{position:sticky;top:0;display:flex;justify-content:center;padding:10px;background:#3b2a63}
.imprimir button{border:0;border-radius:99px;padding:9px 18px;font:600 13px Poppins,sans-serif;background:#fff;color:#3b2a63;cursor:pointer}
@media print{body{background:#fff}.hoja{padding:0;max-width:none}.imprimir{display:none}
header,.datos div,.pt.sel,.mejora p,.kpi div,table.res th,.barra i{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="imprimir"><button onclick="print()">Guardar como PDF / Imprimir</button></div>
<div class="hoja">
<header>${LOGO ? `<img src="${LOGO}" alt="">` : ''}<div><h1>NEOLIGHT · Encuesta de satisfacción</h1><p>Sistema automatizado de fototerapia neonatal · Clínica Rengel</p></div></header>
${resumen ? `<section class="resumen"><h2>Resumen de resultados</h2>
  <div class="kpi"><div><span>Encuestas respondidas</span><b>${rows.length}</b></div><div><span>Satisfacción promedio</span><b>${coma(general, 2)} / 5</b></div>
  <div><span>Participantes</span><b style="font-size:13px">${rows.map(r => esc(ROLES[r.rol])).join(' · ')}</b></div></div>
  <table class="res"><thead><tr><th>#</th><th>Aspecto evaluado</th>${rows.map(r => `<th>${esc(ROLES[r.rol])}</th>`).join('')}<th>Promedio</th><th></th></tr></thead><tbody>
  ${PREGUNTAS.map((p, k) => `<tr><td>${k + 1}</td><td>${esc(p)}</td>${rows.map(r => `<td>${r[`p${k + 1}`]}</td>`).join('')}<td><b>${coma(prom[k], 2)}</b></td><td><div class="barra"><i style="width:${prom[k] / 5 * 100}%"></i></div></td></tr>`).join('')}
  </tbody></table></section>` : ''}
${rows.map(ficha).join('')}
</div><script>window.addEventListener('load',()=>setTimeout(()=>{try{print()}catch(e){}},700));</script></body></html>`;
}
