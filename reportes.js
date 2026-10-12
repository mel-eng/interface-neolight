// =========================================================
// reportes.js
// Foto del paciente y reportes (Excel y PDF) en dos versiones:
//   - familiar: para los papás, en lenguaje sencillo
//   - medico:   respaldo clínico completo, con la firma del doctor
// El PDF es una página imprimible: el navegador la guarda como PDF.
// =========================================================

import fs from 'fs';
import path from 'path';

const MODOS = { reposo: 'Reposo', convencional: 'Convencional', intensivo: 'Intensivo', automatico: 'Automático' };
const MODOS_FAMILIA = { reposo: 'Lámpara en descanso', convencional: 'Luz normal', intensivo: 'Luz intensiva', automatico: 'Automático' };
const FIN_SESION = {
  completada: 'Completada', detenida_manual: 'Detenida por el personal', alarma: 'Detenida por una alarma',
  desconexion: 'Lámpara desconectada', salida_usuario: 'Cerrada al salir',
};
const ALARMAS = {
  distancia_baja: 'Lámpara demasiado cerca', distancia_alta: 'Lámpara demasiado lejos', distancia_fuera_rango: 'Distancia fuera de rango',
  temperatura_baja: 'Temperatura del bebé baja', temperatura_alta: 'Temperatura del bebé alta',
  sensor_ultrasonico: 'Falla del sensor de distancia', sensor_temperatura: 'Falla del sensor de temperatura', sensor_fallo: 'Falla de sensor',
  irradiancia_baja: 'Luz insuficiente', esp_desconectado: 'Lámpara desconectada', esp32_desconectado: 'Lámpara desconectada',
  sesion_interrumpida: 'Sesión interrumpida', modo_no_autorizado: 'Modo no autorizado', otro: 'Otro',
  antifaz_desplazado: 'Antifaz desplazado', ojos_expuestos: 'Ojos expuestos', antifaz_no_verificable: 'Antifaz no verificable',
  antifaz_sin_verificacion: 'Sin verificación del antifaz',
};
const ANTIFAZ_MOTIVOS = {
  ojos_expuestos: 'Ojos expuestos', desplazado: 'Antifaz desplazado', antifaz_ausente: 'Sin antifaz',
  nariz_cubierta: 'Nariz cubierta', no_verificable: 'No verificable', sin_camara: 'Sin cámara',
  sin_verificacion: 'Sin verificación', marcador_ausente: 'Marcador no visible',
};
const SEVERIDAD = { critical: 'Crítica', warning: 'Advertencia', info: 'Informativa' };
const ESTADO_CLINICO = { ok: 'Estable', observacion: 'En observación', riesgo: 'En riesgo', alta: 'Dado de alta' };
const ESTADO_PLAN = { activo: 'En curso', completado: 'Completado', pausado: 'Pausado', cancelado: 'Cancelado' };
const GENERO = { masculino: 'Masculino', femenino: 'Femenino', no_especificado: 'No especificado' };

const txt = v => (v == null || v === '' ? '—' : String(v));
const num = (v, d = 1) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(d));
const coma = (v, d = 1) => { const n = num(v, d); return n == null ? '—' : n.toFixed(d).replace('.', ','); };
const hms = s => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = n % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(x).padStart(2, '0')} s` : `${x} s`;
};
const horas = s => coma((Number(s) || 0) / 3600, 2);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tituloDoctor = d => (/^f/i.test(String(d?.genero || '')) ? 'Dra.' : 'Dr.');
const nombreDoctor = d => (d?.nombre ? `${tituloDoctor(d)} ${d.nombre} ${d.apellidos || ''}`.trim() : '—');

export function registrarReportes(app, deps) {
  const { pool, ACCOUNT_TABLE, daysBetween, getActivePlan, getCamFrame, camOnline, ExcelJS, baseDir, logEvent } = deps;

  const LOGO = (() => {
    try { return 'data:image/png;base64,' + fs.readFileSync(path.join(baseDir, 'excel_assets', 'logo_univalle.png')).toString('base64'); }
    catch { return null; }
  })();

  // ---------------- FOTO DEL PACIENTE ----------------

  const leerFoto = async id => {
    const [rows] = await pool.execute(`SELECT foto, foto_at, foto_origen FROM pacientes WHERE id = ? LIMIT 1`, [id]);
    return rows[0]?.foto ? rows[0] : null;
  };

  app.get('/api/patients/:id/foto', async (req, res) => {
    try {
      const f = await leerFoto(Number(req.params.id));
      if (!f) return res.status(404).json({ ok: false, error: 'sin_foto' });
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(f.foto);
    } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
  });

  // Guarda la foto que se usa en los reportes: la imagen actual de la cámara o una imagen subida.
  app.post('/api/patients/:id/foto', async (req, res) => {
    try {
      const id = Number(req.params.id);
      let buf = null, origen = 'subida';
      if (req.body?.origen === 'camara') {
        const frame = getCamFrame();
        if (!camOnline() || !frame || Date.now() - frame.ts > 10_000)
          return res.status(409).json({ ok: false, error: 'sin_camara', message: 'La cámara no está enviando imagen. Enciéndela e intenta de nuevo.' });
        buf = frame.buf; origen = 'camara';
      } else {
        const m = String(req.body?.imagen || '').match(/^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return res.status(400).json({ ok: false, error: 'imagen_invalida', message: 'Elige una foto JPG.' });
        buf = Buffer.from(m[1], 'base64');
      }
      if (buf.length < 200 || buf[0] !== 0xff || buf[1] !== 0xd8)
        return res.status(400).json({ ok: false, error: 'imagen_invalida', message: 'La imagen no es válida.' });
      if (buf.length > 900_000) return res.status(413).json({ ok: false, error: 'imagen_grande', message: 'La foto es muy grande.' });
      await pool.execute(`UPDATE pacientes SET foto = ?, foto_at = NOW(), foto_origen = ? WHERE id = ?`, [buf, origen, id]);
      await logEvent({ paciente_id: id, cuenta_id: req.auth?.id || null, tipo: 'paciente_editado',
        descripcion: `Foto del paciente actualizada (${origen === 'camara' ? 'cámara' : 'imagen subida'})` }).catch(() => {});
      res.json({ ok: true, origen, bytes: buf.length });
    } catch (e) { console.error('[FOTO]', e.message); res.status(500).json({ ok: false, error: 'server_error' }); }
  });

  // ---------------- DATOS DEL REPORTE ----------------

  async function datosReporte(pacienteId) {
    const [pRows] = await pool.execute(
      `SELECT p.*, DATE_FORMAT(p.fecha_nac, '%d/%m/%Y') AS nac_txt, DATE_FORMAT(p.fecha_ingreso, '%d/%m/%Y') AS ingreso_txt,
              DATE_FORMAT(p.fecha_alta, '%d/%m/%Y') AS alta_txt, DATE_FORMAT(p.foto_at, '%d/%m/%Y %H:%i') AS foto_txt,
              d.nombre AS d_nombre, d.apellidos AS d_apellidos, d.genero AS d_genero, d.especialidad AS d_especialidad,
              d.matricula AS d_matricula, d.firma_png AS d_firma,
              t.nombre AS t_nombre, t.apellidos AS t_apellidos, t.telefono AS t_telefono, t.correo AS t_correo, t.parentesco AS t_parentesco
       FROM pacientes p
       LEFT JOIN ${ACCOUNT_TABLE} d ON d.id = p.doctor_id
       LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = p.tutor_id
       WHERE p.id = ? LIMIT 1`, [pacienteId]);
    if (!pRows.length) return null;
    const p = pRows[0];

    const [[medida]] = await pool.execute(
      `SELECT peso_g, talla_cm, temp_c, DATE_FORMAT(created_at, '%d/%m/%Y %H:%i') AS fecha
       FROM antropometria WHERE paciente_id = ? ORDER BY created_at DESC LIMIT 1`, [pacienteId]).catch(() => [[null]]);
    const [[talla]] = await pool.execute(
      `SELECT talla_cm FROM antropometria WHERE paciente_id = ? AND talla_cm IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [pacienteId]).catch(() => [[null]]);

    const [planes] = await pool.execute(
      `SELECT id, meta_total_s, tiempo_acumulado_s, sesiones_realizadas, modo_recomendado, horas_por_dia, sesiones_por_dia,
              estado, observaciones, DATE_FORMAT(fecha_inicio, '%d/%m/%Y') AS inicio_txt, DATE_FORMAT(fecha_fin, '%d/%m/%Y %H:%i') AS fin_txt
       FROM planes_terapia WHERE paciente_id = ? ORDER BY created_at`, [pacienteId]);
    const vivo = await getActivePlan(pacienteId).catch(() => null);
    const plan = vivo || planes.at(-1) || null;
    const avance = plan ? Math.min(100, Math.round((Number(plan.tiempo_acumulado_s) / Math.max(1, Number(plan.meta_total_s))) * 100)) : 0;

    const [sesiones] = await pool.execute(
      `SELECT id, DATE_FORMAT(COALESCE(started_at, fecha), '%d/%m/%Y') AS fecha_txt,
              TIME_FORMAT(hora_inicio, '%H:%i') AS ini, TIME_FORMAT(hora_fin, '%H:%i') AS fin,
              modo_programado, modo_final, duracion_s, tiempo_rango_s, intensidad_promedio_pct, distancia_promedio_cm,
              temp_bebe_promedio_c, temp_amb_promedio_c, motivo_fin, status, observaciones
       FROM sesiones WHERE paciente_id = ? ORDER BY COALESCE(started_at, fecha), id`, [pacienteId]);

    const [alarmas] = await pool.execute(
      `SELECT sesion_id, tipo, severidad, valor_medido, unidad, mensaje, accion_tomada, silenciada,
              DATE_FORMAT(created_at, '%d/%m/%Y') AS fecha_txt, DATE_FORMAT(created_at, '%H:%i:%s') AS hora_txt
       FROM alarmas WHERE paciente_id = ? ORDER BY created_at`, [pacienteId]);

    const [antifaz] = await pool.execute(
      `SELECT id, sesion_id, tipo, motivo, capa, mensaje, respuesta_ms, (foto IS NOT NULL) AS con_foto,
              DATE_FORMAT(created_at, '%d/%m/%Y') AS fecha_txt, DATE_FORMAT(created_at, '%H:%i:%s') AS hora_txt
       FROM antifaz_eventos WHERE paciente_id = ? AND tipo <> 'ensayo' ORDER BY created_at`, [pacienteId]).catch(() => [[]]);

    const foto = await leerFoto(pacienteId).catch(() => null);
    const terminadas = sesiones.filter(s => s.status === 'finished');
    const totalS = terminadas.reduce((a, s) => a + (Number(s.duracion_s) || 0), 0);
    const rangoS = terminadas.reduce((a, s) => a + (Number(s.tiempo_rango_s) || 0), 0);
    const prom = k => {
      const v = terminadas.filter(s => s[k] != null).map(s => Number(s[k])).filter(Number.isFinite);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };

    return {
      p, medida: medida || null, talla_cm: talla?.talla_cm ?? null, planes, plan, avance, sesiones, alarmas, antifaz,
      foto: foto?.foto || null, foto_txt: p.foto_txt,
      doctor: { nombre: p.d_nombre, apellidos: p.d_apellidos, genero: p.d_genero, especialidad: p.d_especialidad,
                matricula: p.d_matricula, firma: p.d_firma },
      tutor: { nombre: `${p.t_nombre || ''} ${p.t_apellidos || ''}`.trim(), telefono: p.t_telefono, correo: p.t_correo, parentesco: p.t_parentesco },
      resumen: {
        sesiones: terminadas.length, total_s: totalS, rango_pct: totalS ? Math.round((rangoS / totalS) * 100) : null,
        led: prom('intensidad_promedio_pct'), dist: prom('distancia_promedio_cm'), tbebe: prom('temp_bebe_promedio_c'), tamb: prom('temp_amb_promedio_c'),
        alarmas_criticas: alarmas.filter(a => a.severidad === 'critical').length, alarmas: alarmas.length,
        apagados_antifaz: antifaz.filter(a => a.tipo === 'apagado').length,
      },
      generado: new Date().toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' }),
    };
  }

  const pesoTxt = d => {
    const g = d.medida?.peso_g ?? d.p.peso_actual_g;
    return g != null ? `${coma(Number(g) / 1000, 2)} kg` : '—';
  };
  const planTxt = d => (d.plan
    ? `${horas(d.plan.tiempo_acumulado_s)} de ${horas(d.plan.meta_total_s)} h (${d.avance} %)`
    : 'Sin plan registrado');
  const estadoTerapia = d => {
    if (d.p.estado_clinico === 'alta') return 'Dado de alta';
    if (!d.plan) return 'Sin plan de terapia';
    if (d.plan.estado === 'completado') return 'Terapia completada';
    return d.plan.estado === 'activo' ? 'En terapia' : (ESTADO_PLAN[d.plan.estado] || d.plan.estado);
  };

  // ---------------- EXCEL ----------------

  const copiarEstilo = (de, a) => { a.style = JSON.parse(JSON.stringify(de.style || {})); };

  function fotoEnHoja(wb, ws, buf, { col = 7, row = 12, alto = 210, anchoMax = 430 } = {}) {
    if (!buf) return false;
    // Tamaño real del JPEG (marcador SOF) para no deformar la foto.
    let w = 4, h = 3;
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    let hh = alto, ww = Math.round(alto * w / h);
    if (ww > anchoMax) { ww = anchoMax; hh = Math.round(anchoMax * h / w); }
    const id = wb.addImage({ buffer: buf, extension: 'jpeg' });
    ws.addImage(id, { tl: { col: col + 0.6, row: row + 0.3 }, ext: { width: ww, height: hh }, editAs: 'oneCell' });
    return true;
  }

  async function excel(d, tipo) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(baseDir, 'excel', 'Plantilla_Fototerapia_Neonatal.xlsx'));
    const h1 = wb.getWorksheet('Hoja de Vida del Paciente');
    const h2 = wb.getWorksheet('Historial de Terapia');
    const h3 = wb.getWorksheet('Alarmas y Eventos');
    const medico = tipo === 'medico';
    const p = d.p;

    // ----- Hoja 1 -----
    h1.getCell('B9').value = medico ? 'Hoja de Vida del Paciente · Reporte médico' : 'Resumen de la terapia · Para la familia';
    const filas = medico ? [
      ['ID Paciente', p.codigo || p.id],
      ['Nombre completo', `${p.nombre} ${p.apellidos}`.trim()],
      ['Fecha de nacimiento', txt(p.nac_txt)],
      ['Edad (días)', p.fecha_nac ? daysBetween(p.fecha_nac) : '—'],
      ['Sexo', GENERO[p.genero] || '—'],
      ['Edad gestacional', p.edad_gestacional_sem != null ? `${coma(p.edad_gestacional_sem)} semanas` : '—'],
      ['Peso al nacer', p.peso_nacimiento_g != null ? `${coma(Number(p.peso_nacimiento_g) / 1000, 2)} kg` : '—'],
      ['Peso actual', pesoTxt(d) + (d.medida?.peso_g != null ? ` (cuna, ${d.medida.fecha})` : '')],
      ['Talla', d.talla_cm != null ? `${coma(d.talla_cm)} cm` : '—'],
      ['Grupo sanguíneo', [p.grupo_sanguineo, p.factor_rh].filter(Boolean).join(' ') || '—'],
      ['Diagnóstico', txt(p.diagnostico)],
      ['Bilirrubina inicial / actual', `${p.nivel_bilirrubina_inicial != null ? coma(p.nivel_bilirrubina_inicial, 2) : '—'} / ${p.nivel_bilirrubina_actual != null ? coma(p.nivel_bilirrubina_actual, 2) : '—'} mg/dL`],
      ['Estado clínico', ESTADO_CLINICO[p.estado_clinico] || txt(p.estado_clinico)],
      ['Fecha de ingreso / alta', `${txt(p.ingreso_txt)} / ${txt(p.alta_txt)}`],
      ['Médico a cargo', `${nombreDoctor(d.doctor)}${d.doctor.especialidad ? ` · ${d.doctor.especialidad}` : ''}`],
      ['Matrícula profesional', txt(d.doctor.matricula)],
      ['Contacto de emergencia', d.tutor.nombre ? `${d.tutor.nombre}${d.tutor.parentesco ? ` (${d.tutor.parentesco})` : ''} · ${txt(d.tutor.telefono)}` : '—'],
      ['Plan de fototerapia', d.plan ? `${horas(d.plan.meta_total_s)} h · modo ${MODOS[d.plan.modo_recomendado] || '—'} · ${ESTADO_PLAN[d.plan.estado] || d.plan.estado}` : 'Sin plan'],
      ['Avance del plan', planTxt(d)],
      ['Sesiones realizadas', `${d.resumen.sesiones} · ${hms(d.resumen.total_s)} en total`],
      ['Tiempo en rango de distancia', d.resumen.rango_pct != null ? `${d.resumen.rango_pct} %` : '—'],
      ['Alarmas registradas', `${d.resumen.alarmas} (${d.resumen.alarmas_criticas} críticas)`],
      ['Apagados por el antifaz', String(d.resumen.apagados_antifaz)],
      ['Observaciones médicas', txt(p.observaciones)],
    ] : [
      ['Bebé', `${p.nombre} ${p.apellidos}`.trim()],
      ['Código', p.codigo || p.id],
      ['Fecha de nacimiento', txt(p.nac_txt)],
      ['Días de vida', p.fecha_nac ? daysBetween(p.fecha_nac) : '—'],
      ['Peso', pesoTxt(d)],
      ['Talla', d.talla_cm != null ? `${coma(d.talla_cm)} cm` : '—'],
      ['Motivo de la terapia', txt(p.diagnostico)],
      ['Médico tratante', nombreDoctor(d.doctor)],
      ['Estado', estadoTerapia(d)],
      ['Avance de la terapia', planTxt(d)],
      ['Sesiones de luz', `${d.resumen.sesiones} sesiones · ${hms(d.resumen.total_s)} en total`],
      ['Avisos de seguridad', d.resumen.alarmas
        ? `${d.resumen.alarmas} avisos durante la terapia, registrados y revisados por el equipo médico`
        : 'Sin avisos durante la terapia'],
      ['Responsable', d.tutor.nombre ? `${d.tutor.nombre}${d.tutor.parentesco ? ` (${d.tutor.parentesco})` : ''}` : '—'],
    ];

    // Las filas 13 a 20 vienen con formato; las demás copian el formato de la fila 20.
    const base = h1.getRow(20);
    filas.forEach(([label, value], i) => {
      const r = 13 + i;
      const row = h1.getRow(r);
      if (r > 20) {
        for (let c = 2; c <= 7; c++) copiarEstilo(base.getCell(c), row.getCell(c));
        try { h1.mergeCells(`B${r}:C${r}`); } catch {}
        try { h1.mergeCells(`D${r}:G${r}`); } catch {}
      }
      row.height = 21;
      row.getCell('B').value = label;
      const v = row.getCell('D');
      v.value = value;
      v.alignment = { ...(v.alignment || {}), wrapText: true, vertical: 'middle' };
    });
    const ultima = 12 + filas.length;

    // Foto
    h1.getCell('H13').value = null;
    if (!fotoEnHoja(wb, h1, d.foto, { col: 7, row: 12, alto: 190, anchoMax: 330 })) {
      h1.getCell('H13').value = 'Sin foto del paciente.\nSe guarda desde el panel con el botón «Guardar foto».';
    } else if (d.foto_txt) {
      h1.getCell(`H${Math.min(ultima, 22)}`).value = `Foto: ${d.foto_txt}`;
    }

    // Firma (reporte médico)
    let r = ultima + 3;
    if (medico) {
      h1.getCell(`B${r}`).value = 'Firma del médico tratante';
      h1.getCell(`B${r}`).font = { bold: true, size: 11, color: { argb: 'FF3B2A63' } };
      const m = String(d.doctor.firma || '').match(/^data:image\/png;base64,(.+)$/);
      if (m) {
        const id = wb.addImage({ base64: m[1], extension: 'png' });
        h1.addImage(id, { tl: { col: 3.2, row: r }, ext: { width: 230, height: 80 }, editAs: 'oneCell' });
      } else {
        h1.getCell(`D${r + 2}`).value = '(Sin firma registrada)';
      }
      r += 5;
      h1.getCell(`D${r}`).value = '______________________________';
      h1.getCell(`D${r + 1}`).value = nombreDoctor(d.doctor);
      h1.getCell(`D${r + 1}`).font = { bold: true, size: 11 };
      h1.getCell(`D${r + 2}`).font = { size: 10 };
      h1.getCell(`D${r + 3}`).font = { size: 9, color: { argb: 'FF6B6475' } };
      h1.getCell(`D${r + 2}`).value = `${txt(d.doctor.especialidad)} · Mat. ${txt(d.doctor.matricula)}`;
      h1.getCell(`D${r + 3}`).value = `Generado el ${d.generado} por NEOLIGHT`;
      h1.getCell(`D${r + 4}`).value = 'Firma dibujada en el sistema: respaldo visual, no es firma digital certificada.';
      h1.getCell(`D${r + 4}`).font = { italic: true, size: 8, color: { argb: 'FF7A7385' } };
    } else {
      h1.getCell(`B${r}`).value = 'Este resumen es informativo. Ante cualquier duda, consulte al médico tratante.';
      h1.getCell(`B${r}`).font = { italic: true, size: 10, color: { argb: 'FF6B6475' } };
      h1.getCell(`B${r + 1}`).value = `Generado el ${d.generado} por NEOLIGHT`;
      h1.getCell(`B${r + 1}`).font = { size: 9, color: { argb: 'FF7A7385' } };
    }

    // ----- Hoja 2: sesiones -----
    const cab = (ws, fila, titulos, desde = 2, hasta = 11) => {
      const modelo = ws.getRow(fila).getCell(desde);
      for (let c = desde; c <= hasta; c++) {
        const cell = ws.getRow(fila).getCell(c);
        const t = titulos[c - desde];
        if (t == null) { cell.value = null; cell.style = {}; continue; }
        copiarEstilo(modelo, cell);
        cell.value = t;
      }
    };
    const filaDatos = (ws, fila, valores, desde = 2) => {
      const row = ws.getRow(fila);
      valores.forEach((v, i) => {
        const cell = row.getCell(desde + i);
        cell.value = v;
        cell.border = { top: { style: 'thin', color: { argb: 'FFD9D2E9' } }, bottom: { style: 'thin', color: { argb: 'FFD9D2E9' } },
                        left: { style: 'thin', color: { argb: 'FFD9D2E9' } }, right: { style: 'thin', color: { argb: 'FFD9D2E9' } } };
        cell.alignment = { vertical: 'middle', horizontal: typeof v === 'number' ? 'right' : 'left', wrapText: true };
        cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF2E2442' } };
      });

    };

    [['B', 13], ['C', 9], ['D', 9], ['E', 14], ['F', 15], ['G', 16]].forEach(([c, w]) => { h2.getColumn(c).width = w; });
    if (medico) {
      cab(h2, 6, ['Fecha', 'Inicio', 'Fin', 'Modo', 'Duración', 'Tiempo en rango', 'Intensidad prom. (%)', 'Temp. bebé prom. (°C)', 'Temp. amb. prom. (°C)', 'Fin de la sesión']);
      d.sesiones.forEach((s, i) => filaDatos(h2, 7 + i, [
        s.fecha_txt, txt(s.ini), txt(s.fin), MODOS[s.modo_final || s.modo_programado] || '—',
        s.duracion_s != null ? hms(s.duracion_s) : (s.status === 'finished' ? '—' : 'En curso'),
        s.tiempo_rango_s != null ? hms(s.tiempo_rango_s) : '—',
        num(s.intensidad_promedio_pct) ?? '—', num(s.temp_bebe_promedio_c) ?? 'Sin sensor', num(s.temp_amb_promedio_c) ?? '—',
        s.status === 'finished' ? (FIN_SESION[s.motivo_fin] || '—') : 'En curso',
      ]));
      const t = 7 + d.sesiones.length + 1;
      h2.getCell(`B${t}`).value = 'Total';
      h2.getCell(`B${t}`).font = { bold: true };
      h2.getCell(`F${t}`).value = hms(d.resumen.total_s);
      h2.getCell(`F${t}`).font = { bold: true };
    } else {
      h2.name = 'Sesiones de terapia';
      h2.getCell('B2').value = 'Sesiones de luz de tu bebé';
      cab(h2, 6, ['Fecha', 'Empezó', 'Terminó', 'Tipo de luz', 'Duración', null, null, null, null, null]);
      d.sesiones.forEach((s, i) => filaDatos(h2, 7 + i, [
        s.fecha_txt, txt(s.ini), txt(s.fin), MODOS_FAMILIA[s.modo_final || s.modo_programado] || '—',
        s.duracion_s != null ? hms(s.duracion_s) : 'En curso',
      ]));
    }

    // ----- Hoja 3: alarmas (solo médico) -----
    if (medico) {
      cab(h3, 6, ['Fecha', 'Hora', 'Sesión', 'Alarma', 'Valor medido', 'Severidad', 'Detalle'], 2, 8);
      d.alarmas.forEach((a, i) => filaDatos(h3, 7 + i, [
        a.fecha_txt, a.hora_txt, a.sesion_id || '—', ALARMAS[a.tipo] || a.tipo,
        a.valor_medido != null ? `${a.valor_medido} ${a.unidad || ''}`.trim() : '—',
        SEVERIDAD[a.severidad] || a.severidad || '—', a.accion_tomada || a.mensaje || '—',
      ]));
      h3.getColumn('H').width = 60;

      // Hoja 4: eventos del antifaz
      const h4 = wb.addWorksheet('Antifaz', { views: [{ showGridLines: false }] });
      h4.getColumn(1).width = 3;
      [14, 11, 10, 18, 22, 14, 16, 60].forEach((w, i) => { h4.getColumn(i + 2).width = w; });
      h4.getCell('B2').value = 'Verificación del antifaz';
      h4.getCell('B2').font = { bold: true, size: 16, color: { argb: 'FF3B2A63' } };
      h4.getCell('B3').value = 'Apagados y avisos generados por la cámara (marcador e IA). Apoyo a la supervisión de enfermería.';
      h4.getCell('B3').font = { italic: true, size: 9, color: { argb: 'FF6B6475' } };
      const head = ['Fecha', 'Hora', 'Sesión', 'Acción', 'Motivo', 'Detectó', 'Respuesta (s)', 'Mensaje'];
      head.forEach((t, i) => {
        const c = h4.getRow(5).getCell(i + 2);
        c.value = t;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E7CC3' } };
        c.alignment = { vertical: 'middle' };
      });
      if (!d.antifaz.length) h4.getCell('B6').value = 'Sin eventos registrados.';
      d.antifaz.forEach((a, i) => filaDatos(h4, 6 + i, [
        a.fecha_txt, a.hora_txt, a.sesion_id || '—', a.tipo === 'apagado' ? 'Luz apagada' : 'Aviso',
        ANTIFAZ_MOTIVOS[a.motivo] || a.motivo, a.capa === 'ia' ? 'IA de visión' : a.capa === 'marcador' ? 'Marcador' : 'Sistema',
        a.respuesta_ms != null ? +(a.respuesta_ms / 1000).toFixed(1) : '—', a.mensaje || '—',
      ]));
    } else {
      wb.removeWorksheet(h3.id);
    }
    // Que al imprimir cada hoja entre a lo ancho de la página.
    wb.worksheets.forEach(ws => {
      ws.pageSetup = { ...(ws.pageSetup || {}), paperSize: 9, orientation: ws === h1 ? 'portrait' : 'landscape',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
      ws.pageSetup.printArea = undefined;
    });
    return wb;
  }

  app.get('/api/export/:pacienteId', async (req, res) => {
    try {
      const id = Number(req.params.pacienteId);
      const tipo = req.query.tipo === 'medico' ? 'medico' : req.query.tipo === 'familiar' ? 'familiar'
        : (req.auth?.rol === 'tutor' ? 'familiar' : 'medico');
      if (tipo === 'medico' && req.auth?.rol === 'tutor')
        return res.status(403).json({ ok: false, error: 'solo_personal_medico' });
      const d = await datosReporte(id);
      if (!d) return res.status(404).json({ error: 'paciente_no_encontrado' });
      const wb = await excel(d, tipo);
      const nombre = `${tipo === 'medico' ? 'reporte_medico' : 'resumen_familia'}_${d.p.codigo || d.p.id}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { console.error('EXPORT_ERROR', e); res.status(500).json({ error: 'error_exportando' }); }
  });

  // ---------------- PDF (página imprimible) ----------------

  function html(d, tipo) {
    const medico = tipo === 'medico';
    const p = d.p;
    const nombre = `${p.nombre} ${p.apellidos}`.trim();
    const foto = d.foto ? `data:image/jpeg;base64,${d.foto.toString('base64')}` : null;
    const firma = /^data:image\/png;base64,/.test(String(d.doctor.firma || '')) ? d.doctor.firma : null;
    const dato = (k, v) => `<div class="dato"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    const maxDur = Math.max(1, ...d.sesiones.map(s => Number(s.duracion_s) || 0));

    const datos = medico ? [
      ['Código', p.codigo || p.id], ['Fecha de nacimiento', txt(p.nac_txt)],
      ['Edad', p.fecha_nac ? `${daysBetween(p.fecha_nac)} días` : '—'], ['Sexo', GENERO[p.genero] || '—'],
      ['Edad gestacional', p.edad_gestacional_sem != null ? `${coma(p.edad_gestacional_sem)} sem` : '—'],
      ['Grupo sanguíneo', [p.grupo_sanguineo, p.factor_rh].filter(Boolean).join(' ') || '—'],
      ['Peso al nacer', p.peso_nacimiento_g != null ? `${coma(Number(p.peso_nacimiento_g) / 1000, 2)} kg` : '—'],
      ['Peso actual', pesoTxt(d)], ['Talla', d.talla_cm != null ? `${coma(d.talla_cm)} cm` : '—'],
      ['Bilirrubina inicial', p.nivel_bilirrubina_inicial != null ? `${coma(p.nivel_bilirrubina_inicial, 2)} mg/dL` : '—'],
      ['Bilirrubina actual', p.nivel_bilirrubina_actual != null ? `${coma(p.nivel_bilirrubina_actual, 2)} mg/dL` : '—'],
      ['Estado clínico', ESTADO_CLINICO[p.estado_clinico] || '—'],
      ['Ingreso', txt(p.ingreso_txt)], ['Alta', txt(p.alta_txt)],
      ['Contacto', d.tutor.nombre ? `${d.tutor.nombre}${d.tutor.parentesco ? ` (${d.tutor.parentesco})` : ''} · ${txt(d.tutor.telefono)}` : '—'],
      ['Diagnóstico', txt(p.diagnostico)],
    ] : [
      ['Fecha de nacimiento', txt(p.nac_txt)], ['Días de vida', p.fecha_nac ? daysBetween(p.fecha_nac) : '—'],
      ['Peso', pesoTxt(d)], ['Talla', d.talla_cm != null ? `${coma(d.talla_cm)} cm` : '—'],
      ['Motivo de la terapia', txt(p.diagnostico)], ['Médico tratante', nombreDoctor(d.doctor)],
    ];

    const filasSesiones = d.sesiones.map(s => medico ? `<tr>
        <td>${esc(s.fecha_txt)}</td><td>${esc(txt(s.ini))}–${esc(txt(s.fin))}</td><td>${esc(MODOS[s.modo_final || s.modo_programado] || '—')}</td>
        <td>${s.duracion_s != null ? hms(s.duracion_s) : 'En curso'}</td><td>${s.tiempo_rango_s != null ? hms(s.tiempo_rango_s) : '—'}</td>
        <td>${coma(s.intensidad_promedio_pct)}</td><td>${s.temp_bebe_promedio_c != null ? coma(s.temp_bebe_promedio_c) : 'Sin sensor'}</td>
        <td>${coma(s.temp_amb_promedio_c)}</td><td>${esc(s.status === 'finished' ? (FIN_SESION[s.motivo_fin] || '—') : 'En curso')}</td></tr>`
      : `<tr><td>${esc(s.fecha_txt)}</td><td>${esc(txt(s.ini))} a ${esc(txt(s.fin))}</td>
        <td>${esc(MODOS_FAMILIA[s.modo_final || s.modo_programado] || '—')}</td>
        <td><div class="barra"><i style="width:${Math.max(3, Math.round((Number(s.duracion_s) || 0) / maxDur * 100))}%"></i></div></td>
        <td>${s.duracion_s != null ? hms(s.duracion_s) : 'En curso'}</td></tr>`).join('');

    const completo = d.plan?.estado === 'completado';
    const progreso = `
      <section class="progreso ${completo ? 'hecho' : ''}">
        <div>
          <h2>${completo ? '⭐ Terapia completada' : 'Avance de la terapia'}</h2>
          <p>${d.plan ? `${horas(d.plan.tiempo_acumulado_s)} de ${horas(d.plan.meta_total_s)} horas indicadas por el médico` : 'Todavía no hay un plan de terapia.'}</p>
        </div>
        <div class="pct">${d.avance}%</div>
        <div class="barra grande"><i style="width:${d.avance}%"></i></div>
      </section>`;

    const alarmas = medico ? `
      <section><h2>Alarmas</h2>${d.alarmas.length ? `<table><thead><tr><th>Fecha</th><th>Hora</th><th>Alarma</th><th>Valor</th><th>Severidad</th><th>Detalle</th></tr></thead><tbody>
        ${d.alarmas.map(a => `<tr class="${a.severidad === 'critical' ? 'crit' : ''}"><td>${esc(a.fecha_txt)}</td><td>${esc(a.hora_txt)}</td><td>${esc(ALARMAS[a.tipo] || a.tipo)}</td>
          <td>${esc(a.valor_medido != null ? `${a.valor_medido} ${a.unidad || ''}` : '—')}</td><td>${esc(SEVERIDAD[a.severidad] || a.severidad)}</td><td>${esc(a.accion_tomada || a.mensaje || '—')}</td></tr>`).join('')}
        </tbody></table>` : '<p class="vacio">Sin alarmas registradas.</p>'}</section>
      <section><h2>Verificación del antifaz</h2>${d.antifaz.length ? `<table><thead><tr><th>Fecha</th><th>Hora</th><th>Acción</th><th>Motivo</th><th>Detectó</th><th>Respuesta</th></tr></thead><tbody>
        ${d.antifaz.map(a => `<tr class="${a.tipo === 'apagado' ? 'crit' : ''}"><td>${esc(a.fecha_txt)}</td><td>${esc(a.hora_txt)}</td><td>${a.tipo === 'apagado' ? 'Luz apagada' : 'Aviso'}</td>
          <td>${esc(ANTIFAZ_MOTIVOS[a.motivo] || a.motivo)}</td><td>${a.capa === 'ia' ? 'IA de visión' : a.capa === 'marcador' ? 'Marcador' : 'Sistema'}</td>
          <td>${a.respuesta_ms != null ? `${coma(a.respuesta_ms / 1000)} s` : '—'}</td></tr>`).join('')}
        </tbody></table>` : '<p class="vacio">Sin eventos del antifaz.</p>'}
        <p class="nota">El sistema del antifaz es un apoyo a la supervisión de enfermería; no la reemplaza.</p></section>` : `
      <section class="aviso-familia"><h2>Seguridad durante la terapia</h2>
        <p>${d.resumen.alarmas ? `El equipo registró <b>${d.resumen.alarmas}</b> avisos de seguridad (por ejemplo, distancia de la lámpara o posición del antifaz). Todos quedan guardados y los revisa el equipo médico.` : 'No hubo avisos de seguridad durante la terapia.'}</p>
        <p>La lámpara controla sola su distancia y su luz, y una cámara revisa que el antifaz proteja los ojos de tu bebé.</p></section>`;

    const resumenMedico = medico ? `
      <section class="kpis">
        <div><span>Sesiones</span><b>${d.resumen.sesiones}</b></div>
        <div><span>Tiempo total</span><b>${hms(d.resumen.total_s)}</b></div>
        <div><span>En rango</span><b>${d.resumen.rango_pct != null ? `${d.resumen.rango_pct}%` : '—'}</b></div>
        <div><span>Intensidad prom.</span><b>${d.resumen.led != null ? `${coma(d.resumen.led)}%` : '—'}</b></div>
        <div><span>Temp. bebé prom.</span><b>${d.resumen.tbebe != null ? `${coma(d.resumen.tbebe)} °C` : '—'}</b></div>
        <div><span>Alarmas críticas</span><b>${d.resumen.alarmas_criticas}</b></div>
      </section>
      ${d.plan ? `<p class="plan">Plan: ${horas(d.plan.meta_total_s)} h · modo ${esc(MODOS[d.plan.modo_recomendado] || '—')} · ${esc(ESTADO_PLAN[d.plan.estado] || d.plan.estado)}${d.plan.inicio_txt ? ` · desde ${esc(d.plan.inicio_txt)}` : ''}${d.plan.fin_txt ? ` · cumplido ${esc(d.plan.fin_txt)}` : ''}</p>` : ''}
      ${p.observaciones ? `<p class="plan"><b>Observaciones:</b> ${esc(p.observaciones)}</p>` : ''}` : '';

    const pie = medico ? `
      <section class="firma">
        <div class="firma-caja">${firma ? `<img src="${firma}" alt="Firma">` : '<div class="sin-firma">Sin firma registrada</div>'}
          <div class="linea"></div><b>${esc(nombreDoctor(d.doctor))}</b>
          <span>${esc(txt(d.doctor.especialidad))} · Mat. ${esc(txt(d.doctor.matricula))}</span></div>
        <p class="nota">Firma dibujada en el sistema: respaldo visual, no es una firma digital certificada.</p>
      </section>` : `<p class="nota final">Este resumen es informativo. Ante cualquier duda, consulte con su médico tratante, ${esc(nombreDoctor(d.doctor))}.</p>`;

    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${medico ? 'Reporte médico' : 'Resumen para la familia'} · ${esc(nombre)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page{size:A4;margin:12mm}
  *{box-sizing:border-box}
  body{margin:0;font-family:Poppins,system-ui,sans-serif;color:#2e2442;background:#f4f1fa;font-size:12px}
  .hoja{max-width:820px;margin:0 auto;background:#fff;padding:22px 26px}
  header{display:flex;align-items:center;gap:16px;background:#a99bc9;color:#fff;border-radius:14px;padding:14px 18px}
  header img{width:62px;height:62px}
  header h1{margin:0;font-size:17px;letter-spacing:.3px} header p{margin:2px 0 0;font-size:11px;opacity:.95}
  .tipo{margin-left:auto;text-align:right;font-size:11px} .tipo b{display:block;font-size:13px}
  .paciente{display:grid;grid-template-columns:170px 1fr;gap:18px;margin:18px 0 6px;align-items:start}
  .foto{width:170px;height:170px;border-radius:14px;background:#efeaf8 center/cover no-repeat;display:grid;place-items:center;color:#8a80a3;font-size:11px;text-align:center;padding:10px}
  .paciente h2{margin:0 0 8px;font-size:20px;color:#3b2a63}
  .datos{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px}
  .dato{border-bottom:1px solid #ece6f6;padding:3px 0;display:flex;justify-content:space-between;gap:10px}
  .dato span{color:#7a7385} .dato b{text-align:right;font-weight:600}
  section{margin-top:16px;break-inside:avoid} h2{font-size:14px;color:#3b2a63;margin:0 0 8px}
  .progreso{display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:center;background:#f7f3ff;border-radius:14px;padding:14px 16px}
  .progreso.hecho{background:#fff6dc} .progreso p{margin:0;color:#6b6475} .pct{font-size:28px;font-weight:700;color:#5f3fb8}
  .progreso.hecho .pct{color:#b7791f}
  .barra{height:10px;border-radius:99px;background:#ece6f6;overflow:hidden;min-width:90px} .barra i{display:block;height:100%;background:#8e7cc3;border-radius:99px}
  .barra.grande{grid-column:1/-1;height:14px} .progreso.hecho .barra i{background:#f5a524}
  table{width:100%;border-collapse:collapse;font-size:10.5px} th{background:#8e7cc3;color:#fff;text-align:left;padding:6px;font-weight:600}
  td{padding:5px 6px;border-bottom:1px solid #ece6f6;vertical-align:middle} tr.crit td{background:#fdf0f2}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px} .kpis div{background:#f7f3ff;border-radius:10px;padding:8px}
  .kpis span{display:block;color:#7a7385;font-size:10px} .kpis b{font-size:14px;color:#3b2a63}
  .plan{margin:8px 0 0;color:#4a4060} .vacio{color:#8a80a3;margin:0}
  .nota{font-size:9.5px;color:#8a80a3;font-style:italic;margin:6px 0 0} .final{margin-top:22px;text-align:center}
  .aviso-familia{background:#f2fbf6;border-radius:14px;padding:12px 16px} .aviso-familia p{margin:4px 0}
  .firma{display:flex;flex-direction:column;align-items:center;margin-top:30px}
  .firma-caja{display:flex;flex-direction:column;align-items:center;min-width:280px} .firma img{height:80px;max-width:280px;object-fit:contain}
  .sin-firma{height:80px;display:grid;place-items:center;color:#aaa} .linea{width:280px;border-top:1.5px solid #3b2a63;margin:2px 0 6px}
  .firma span{color:#6b6475;font-size:11px}
  .barra-imprimir{position:sticky;top:0;display:flex;gap:10px;justify-content:center;padding:10px;background:#3b2a63}
  .barra-imprimir button{border:0;border-radius:99px;padding:9px 18px;font:600 13px Poppins,sans-serif;cursor:pointer;background:#fff;color:#3b2a63}
  @media print{body{background:#fff}.hoja{padding:0;max-width:none}.barra-imprimir{display:none}
    header,th,.progreso,.kpis div,.barra i,tr.crit td,.aviso-familia{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  @media (max-width:640px){.paciente{grid-template-columns:1fr}.datos{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<div class="barra-imprimir"><button onclick="print()">Guardar como PDF / Imprimir</button></div>
<div class="hoja">
  <header>${LOGO ? `<img src="${LOGO}" alt="">` : ''}
    <div><h1>NEOLIGHT · Fototerapia neonatal</h1><p>Clínica Rengel · Centro de Especialidades Médicas</p></div>
    <div class="tipo"><b>${medico ? 'Reporte médico' : 'Resumen para la familia'}</b>${esc(d.generado)}</div>
  </header>
  <div class="paciente">
    <div class="foto" ${foto ? `style="background-image:url('${foto}')"` : ''}>${foto ? '' : 'Sin foto todavía'}</div>
    <div><h2>${esc(nombre)}${medico ? '' : ''}</h2><div class="datos">${datos.map(([k, v]) => dato(k, v)).join('')}</div></div>
  </div>
  ${progreso}
  ${resumenMedico}
  <section><h2>${medico ? 'Sesiones de fototerapia' : 'Sesiones de luz'}</h2>
    ${d.sesiones.length ? `<table><thead><tr>${medico
      ? '<th>Fecha</th><th>Horario</th><th>Modo</th><th>Duración</th><th>En rango</th><th>LED %</th><th>T. bebé</th><th>T. amb.</th><th>Fin</th>'
      : '<th>Fecha</th><th>Horario</th><th>Tipo de luz</th><th></th><th>Duración</th>'}</tr></thead><tbody>${filasSesiones}</tbody></table>`
      : '<p class="vacio">Todavía no hay sesiones.</p>'}
  </section>
  ${alarmas}
  ${pie}
</div>
<script>window.addEventListener('load',()=>setTimeout(()=>{try{print()}catch(e){}},600));</script>
</body></html>`;
  }

  app.get('/api/patients/:id/reporte', async (req, res) => {
    try {
      const tipo = req.query.tipo === 'medico' ? 'medico' : 'familiar';
      if (tipo === 'medico' && req.auth?.rol === 'tutor')
        return res.status(403).json({ ok: false, error: 'solo_personal_medico' });
      const d = await datosReporte(Number(req.params.id));
      if (!d) return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' });
      res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html(d, tipo));
    } catch (e) { console.error('[REPORTE]', e); res.status(500).json({ ok: false, error: 'server_error' }); }
  });
}
