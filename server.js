// =========================================================
// server/server.js — NEOLIGHT API v3.2
// Fixes v3.2:
//   [1] ENUMs de eventos corregidos (solicitud_modo_aprobada/rechazada)
//   [2] control_autorizaciones limpiado al rechazar solicitud
//   [3] plan de terapia ahora incluye horas_por_dia y sesiones configurables
//   [4] tiempo_acumulado se actualiza por horas reales (sessions.duracion_s)
//   [5] logEvent tipo 'solicitud_modo_rechazada' → 'solicitud_rechazada'
//   [6] logEvent tipo 'solicitud_modo_aprobada' → 'solicitud_aceptada'
//   [7] endpoint GET /api/doctor/patients/:id/plan-history añadido
//   [8] alarmas y eventos siempre se registran aunque sesión sea nula
// =========================================================

import dotenv          from 'dotenv';
import express         from 'express';
import cors            from 'cors';
import mysql           from 'mysql2/promise';
import bcrypt          from 'bcryptjs';
import http            from 'http';
import https           from 'https';
import path            from 'path';
import os              from 'os';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import ExcelJS         from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const CONFIG = {
  PORT:             Number(process.env.PORT || 3000),
  DB_HOST:          process.env.DB_HOST          || '127.0.0.1',
  DB_USER:          process.env.DB_USER          || 'root',
  DB_PASS:          process.env.DB_PASS          || '',
  DB_NAME:          process.env.DB_NAME          || 'lampara',
  DB_PORT:          Number(process.env.DB_PORT   || 3306),
  HOSPITAL_CODE:    process.env.HOSPITAL_CODE    || '152436',
  ESP32_MASTER_URL: process.env.ESP32_MASTER_URL || null,
  PWM_MAX:          4095,
  ALARM_COOLDOWN_MS: 30_000,
};

const ACCOUNT_TABLE      = '`cuentas`';
const ACCOUNT_TABLE_NAME = 'cuentas';

// ===================== HELPERS ========================

const getLocalIp = () => {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        return i.address;
  return null;
};

const daysBetween = (d1, d2 = new Date()) => {
  const a = new Date(d1), b = new Date(d2);
  a.setHours(0,0,0,0); b.setHours(0,0,0,0);
  return Math.max(0, Math.floor((b - a) / 86_400_000));
};

const toNum  = v  => (v == null || v === '') ? null : Number(v);
const strip  = s  => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const clean  = s  => strip(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const isISO  = s  => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim());
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const normalizeCuentaGenero = v =>
  ['masculino','femenino','otro','no_especificado'].includes(String(v ?? '').toLowerCase().trim())
    ? String(v).toLowerCase().trim() : 'otro';
const normalizePacienteGenero = v =>
  ['masculino','femenino','no_especificado'].includes(String(v ?? '').toLowerCase().trim())
    ? String(v).toLowerCase().trim() : 'no_especificado';

function baseUsername(nombre, apellidos) {
  const first = clean(String(nombre).split(/\s+/)[0]   || '');
  const ap    = clean(String(apellidos).split(/\s+/)[0] || '');
  return (first + ap).slice(0, 10) || clean(nombre).slice(0, 6) || 'user';
}

async function uniqueUsername(base) {
  const [rows] = await pool.execute(
    `SELECT usuario FROM ${ACCOUNT_TABLE} WHERE usuario = ? OR usuario LIKE CONCAT(?, '%')`,
    [base, base]
  );
  if (!rows.length) return base;
  let max = rows.some(r => r.usuario === base) ? 0 : -1;
  const re = new RegExp(`^${base}(\\d+)$`);
  for (const r of rows) { const m = r.usuario.match(re); if (m) max = Math.max(max, +m[1]); }
  return `${base}${max + 1}`;
}

async function nextPatientCode() {
  const [rows] = await pool.query(
    `SELECT codigo FROM pacientes WHERE codigo LIKE 'NEO-%' ORDER BY id DESC LIMIT 200`
  );
  let max = 0;
  for (const row of rows) {
    const match = String(row.codigo || '').match(/^NEO-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (let n = max + 1; n < max + 10000; n++) {
    const codigo = `NEO-${String(n).padStart(4, '0')}`;
    const [dup] = await pool.execute('SELECT id FROM pacientes WHERE codigo = ? LIMIT 1', [codigo]);
    if (!dup.length) return codigo;
  }
  throw new Error('no_patient_code_available');
}

const VALID_MODES = ['reposo', 'convencional', 'intensivo', 'automatico'];
function normalizeMode(raw) {
  const m = String(raw ?? '').toLowerCase().trim();
  if (m === 'automatic') return 'automatico';
  return VALID_MODES.includes(m) ? m : null;
}

function secondsToHMS(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60;
  return { h, m, s: sec, label: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` };
}

const getDoctorIdFromReq = req =>
  Number(req.query.doctor_id || req.headers['x-doctor-id']) || null;

const getTutorIdFromReq = req =>
  Number(req.query.tutor_id || req.headers['x-tutor-id']) || null;

// FIX [1][5][6]: tipos de evento válidos según ENUM de la BD
const VALID_EVENT_TYPES = new Set([
  'login','logout',
  'inicio_sesion','pausa_sesion','fin_sesion',
  'cambio_modo','cambio_altura',
  'silencio_alarmas',
  'control_manual_habilitado','control_manual_bloqueado',
  'modo_automatico_habilitado','modo_bloqueado',
  'paciente_editado','diagnostico_editado',
  'paciente_dado_alta','paciente_archivado','paciente_restaurado',
  'paciente_eliminado_logico','paciente_desarchivado',
  'solicitud_aceptada','solicitud_rechazada',
  'plan_creado','plan_actualizado','plan_completado','plan_cancelado',
  'conexion_esp','desconexion_esp','fallo_esp',
]);

async function logEvent({ paciente_id = null, sesion_id = null, cuenta_id = null, tipo, descripcion = null, metadata = null }, conn = null) {
  // Guardar aunque el tipo no sea conocido (normalizar a uno válido cercano)
  let tipoFinal = tipo;
  if (!VALID_EVENT_TYPES.has(tipo)) {
    // Mapear tipos legacy a válidos
    const ALIAS = {
      'solicitud_modo_rechazada': 'solicitud_rechazada',
      'solicitud_modo_aprobada':  'solicitud_aceptada',
      'solicitud_control_manual': 'control_manual_habilitado',
      'solicitud_modo':           'cambio_modo',
      'plan_cancelado':           'plan_cancelado',
    };
    tipoFinal = ALIAS[tipo] || 'paciente_editado';
    console.warn(`[logEvent] tipo '${tipo}' normalizado a '${tipoFinal}'`);
  }
  const db   = conn || pool;
  const meta = metadata ? JSON.stringify(metadata) : null;
  await db.execute(
    `INSERT INTO eventos (paciente_id, sesion_id, cuenta_id, tipo, descripcion, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [paciente_id, sesion_id, cuenta_id, tipoFinal, descripcion, meta]
  );
}

function sendDbError(res, e, context = 'DB_ERROR') {
  console.error(context, e);
  if (e?.code === 'ER_NO_SUCH_TABLE')
    return res.status(500).json({ ok: false, error: 'schema_missing_table', message: `Falta tabla en BD ${CONFIG.DB_NAME}.` });
  if (e?.code === 'ER_BAD_FIELD_ERROR')
    return res.status(500).json({ ok: false, error: 'schema_mismatch', message: `Columna inexistente en ${ACCOUNT_TABLE_NAME}.` });
  return res.status(500).json({ ok: false, error: 'server_error', message: 'Error interno del servidor.' });
}

function sendServerError(res, e, context = 'SERVER_ERROR', safeMessage = 'No se pudo completar la operacion.') {
  console.error(context, e);
  if (e?.code?.startsWith?.('ER_')) return sendDbError(res, e, context);
  return res.status(500).json({ ok: false, error: 'server_error', message: safeMessage });
}

// ===================== APP / HTTP / SOCKET ========================

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*', methods: ['GET','POST','PUT'] } });

app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, filePath) => {
  if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
}}));
app.use(cors({ origin: true }));
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ===================== DB POOL ========================

let pool;

async function initDB() {
  const { DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT } = CONFIG;
  const root = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASS, port: DB_PORT, multipleStatements: true
  });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await root.end();
  pool = mysql.createPool({
    host: DB_HOST, user: DB_USER, password: DB_PASS,
    database: DB_NAME, port: DB_PORT,
    waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4',
  });
  await pool.query('SELECT 1');
  console.log(`[DB] Conectado a "${DB_NAME}"`);
}

// ===================== HELPERS DE NEGOCIO ========================

async function getActivePlan(paciente_id, conn = null) {
  const db = conn || pool;
  const [rows] = await db.execute(
    `SELECT * FROM planes_terapia WHERE paciente_id = ? AND estado = 'activo' ORDER BY created_at DESC LIMIT 1`,
    [paciente_id]
  );
  if (!rows.length) return null;
  const p = rows[0];
  return {
    ...p,
    tiempo_restante_s:  Math.max(0, p.meta_total_s - p.tiempo_acumulado_s),
    porcentaje_avance:  p.meta_total_s ? +(( p.tiempo_acumulado_s / p.meta_total_s) * 100).toFixed(2) : 0,
    horas_acumuladas:   +(p.tiempo_acumulado_s / 3600).toFixed(2),
    horas_meta:         +(p.meta_total_s        / 3600).toFixed(2),
    // FIX: calcular progreso real desde sesiones terminadas
    horas_por_dia:      p.horas_por_dia    || null,
    sesiones_por_dia:   p.sesiones_por_dia || null,
    duracion_sesion_min: p.duracion_sesion_min || null,
  };
}

async function getActiveSession(paciente_id, conn = null) {
  const db = conn || pool;
  const [rows] = await db.execute(
    `SELECT * FROM sesiones WHERE paciente_id = ? AND status IN ('active','paused') ORDER BY created_at DESC LIMIT 1`,
    [paciente_id]
  );
  return rows[0] || null;
}

async function updatePlanProgress(plan_id, duracion_s, conn) {
  await conn.execute(
    `UPDATE planes_terapia
     SET tiempo_acumulado_s = LEAST(meta_total_s, tiempo_acumulado_s + ?)
     WHERE id = ?`,
    [duracion_s, plan_id]
  );
  await conn.execute(
    `UPDATE planes_terapia SET estado = 'completado', fecha_fin = NOW()
     WHERE id = ? AND estado = 'activo' AND tiempo_acumulado_s >= meta_total_s`,
    [plan_id]
  );
  const [rows] = await conn.execute(
    `SELECT id, estado, paciente_id FROM planes_terapia WHERE id = ?`, [plan_id]
  );
  if (rows[0]?.estado === 'completado') {
    await logEvent({ paciente_id: rows[0].paciente_id, tipo: 'plan_completado',
                     descripcion: 'Plan completado al alcanzar la meta',
                     metadata: { plan_id } }, conn);
  }
}

async function ensurePatientBelongsToDoctor(patientId, doctorId) {
  const [rows] = await pool.execute(
    `SELECT doctor_id FROM pacientes WHERE id = ? LIMIT 1`, [patientId]
  );
  if (!rows.length) throw { status: 404, error: 'paciente_no_encontrado' };
  if (Number(rows[0].doctor_id) !== Number(doctorId))
    throw { status: 403, error: 'no_autorizado' };
  return true;
}

async function upsertDeviceStatus(paciente_id, esp_online, estado, conn = null) {
  const db = conn || pool;
  await db.execute(
    `INSERT INTO estado_dispositivo (paciente_id, esp_online, estado, last_seen_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       esp_online   = VALUES(esp_online),
       estado       = VALUES(estado),
       last_seen_at = IF(VALUES(esp_online) = TRUE, NOW(), last_seen_at)`,
    [paciente_id, esp_online ? 1 : 0, estado]
  );
}

async function sendCommandToESP(command) {
  if (!CONFIG.ESP32_MASTER_URL) {
    console.warn('[ESP32] ESP32_MASTER_URL no configurado — comando ignorado:', command);
    return { sent: false, reason: 'ESP32_MASTER_URL no configurado' };
  }
  try {
    const url  = `${CONFIG.ESP32_MASTER_URL}/cmd`;
    const body = JSON.stringify(command);
    const lib  = url.startsWith('https') ? https : http;
    await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 3000
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });
    return { sent: true };
  } catch (e) {
    console.error('[ESP32] Error enviando comando:', e.message);
    return { sent: false, reason: e.message };
  }
}

// ===================== TELEMETRÍA ESP32 ========================

let lastTelemetry = null;
let lastTemps     = null;
let lastStatus    = null;
let espOnline     = false;
let lastEspTs     = 0;
let currentLampMode = 'reposo';
const pendingModeRequests = new Map();
let pendingModeRequestSeq = 1;
const alarmCooldown = new Map();

async function setEspOnline(paciente_id = null) {
  const wasOnline = espOnline;
  espOnline = true;
  lastEspTs = Date.now();
  if (!wasOnline) {
    io.emit('lamp:port', { open: true, path: 'WiFi', baudRate: null });
    if (paciente_id) {
      await upsertDeviceStatus(paciente_id, true, 'online').catch(() => {});
      await logEvent({ paciente_id, tipo: 'conexion_esp', descripcion: 'ESP32 conectado por WiFi' }).catch(() => {});
    }
  }
}

setInterval(async () => {
  if (espOnline && Date.now() - lastEspTs > 10_000) {
    espOnline = false;
    io.emit('lamp:port', { open: false, path: 'WiFi', baudRate: null, error: 'Sin datos del ESP32' });
    await pool.execute(
      `UPDATE estado_dispositivo SET esp_online = FALSE, estado = 'offline'
       WHERE estado IN ('online','en_sesion') AND esp_online = TRUE`
    ).catch(() => {});
  }
}, 5000);

function parseTelemetryPayload(body) {
  const cm    = toNum(body.distance_cm ?? body.cm ?? body.dist_cm);
  const tBebe = toNum(body.temp_body_c ?? body.temp_c ?? body.temp_bebe ?? body.bebe ?? body.t_body);
  const tAmb  = toNum(body.temp_amb_c  ?? body.temp_ambiente ?? body.ambient_c ?? body.ta ?? body.ambiente ?? body.t_amb);
  let   pct   = toNum(body.illumination_pct ?? body.intensidad_led_pct ?? body.pct ?? body.percent ?? body.led_pct);
  const duty  = toNum(body.pwm_raw ?? body.duty);
  const pwm   = toNum(body.pwm ?? body.pwm_led);

  if (pct == null && body.bright != null)  pct = Math.round(Number(body.bright) * 100);
  if (pct == null && duty  != null)        pct = Math.round((1 - duty / CONFIG.PWM_MAX) * 100);
  if (pct == null && body.ldr1 != null) {
    const avg = (Number(body.ldr1) + Number(body.ldr2 ?? body.ldr1)) / 2;
    pct = Math.round(Math.max(0, Math.min(100, avg)));
  }

  const modo            = normalizeMode(body.mode ?? body.modo ?? body.modo_actual);
  const sensor_ultra_fail = Boolean(body.sensor_ultra_fail);
  const sensor_body_fail  = Boolean(body.sensor_body_fail);
  const sensor_amb_fail   = Boolean(body.sensor_amb_fail);
  const alarms_muted      = body.alarms_muted != null ? Boolean(body.alarms_muted) : null;
  const paciente_id       = toNum(body.paciente_id) || null;

  return { cm, tBebe, tAmb, pct, pwm, modo, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail, alarms_muted, paciente_id };
}

function evaluateStatusAndAlarms({ cm, tBebe, tAmb, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail }) {
  const alarms = [];
  let estado = 'sin_datos';

  if (sensor_ultra_fail) alarms.push({ tipo: 'sensor_ultrasonico', severidad: 'critical', valor: null, unidad: null });
  if (sensor_body_fail || sensor_amb_fail) alarms.push({ tipo: 'sensor_temperatura', severidad: 'critical', valor: null, unidad: null });

  if (sensor_ultra_fail || sensor_body_fail || sensor_amb_fail) {
    estado = 'alarma_sensor';
  } else if (cm != null && cm < 20) {
    alarms.push({ tipo: 'distancia_baja', severidad: 'critical', valor: cm, unidad: 'cm' });
    estado = 'peligro_distancia';
  } else if (cm != null && cm > 50) {
    alarms.push({ tipo: 'distancia_alta', severidad: 'warning', valor: cm, unidad: 'cm' });
  }

  if (tBebe != null) {
    if (tBebe < 36.5) alarms.push({ tipo: 'temperatura_baja', severidad: 'warning', valor: tBebe, unidad: '°C' });
    if (tBebe > 37.5) alarms.push({ tipo: 'temperatura_alta', severidad: 'warning', valor: tBebe, unidad: '°C' });
    if (!estado.startsWith('alarma') && !estado.startsWith('peligro')) {
      if (tBebe >= 36.5 && tBebe <= 37.5) estado = 'ok';
      else if (tBebe < 36.5) estado = 'frio';
      else estado = 'caliente';
    }
  }

  return { estado, alarms };
}

// ===================== ENDPOINT ESP32 ========================

app.post(['/api/esp32-data', '/api/esp32/telemetry'], async (req, res) => {
  if (!req.body || typeof req.body !== 'object')
    return res.status(400).json({ ok: false, error: 'body_invalido' });

  const parsed = parseTelemetryPayload(req.body);
  const { cm, tBebe, tAmb, pct, pwm, modo, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail, alarms_muted } = parsed;
  let { paciente_id } = parsed;

  if (!paciente_id) {
    try {
      const [rows] = await pool.execute(
        `SELECT paciente_id FROM sesiones WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
      );
      if (rows.length) paciente_id = rows[0].paciente_id;
    } catch {}
  }

  await setEspOnline(paciente_id);
  if (modo) currentLampMode = modo;

  if (cm != null || pct != null || pwm != null || sensor_ultra_fail) {
    lastTelemetry = {
      cm: cm ?? lastTelemetry?.cm ?? null,
      pct: pct ?? lastTelemetry?.pct ?? null,
      pwm: pwm ?? lastTelemetry?.pwm ?? null,
      modo: modo ?? lastTelemetry?.modo ?? null,
      ultraFail: sensor_ultra_fail,
      alarms_muted: alarms_muted ?? false,
      ts: Date.now()
    };
    io.emit('telemetry', {
      cm: lastTelemetry.cm, distance: lastTelemetry.cm, distance_cm: lastTelemetry.cm,
      pct: lastTelemetry.pct, illumination: lastTelemetry.pct, illumination_pct: lastTelemetry.pct,
      pwm: lastTelemetry.pwm, modo_actual: lastTelemetry.modo,
      temp_bebe: lastTemps?.bebe ?? null, temp_ambiente: lastTemps?.ambiente ?? null,
      estado: lastStatus?.estado ?? null, alarms_muted: lastTelemetry.alarms_muted,
    });
  }

  if (tBebe != null || tAmb != null || sensor_body_fail || sensor_amb_fail) {
    lastTemps = {
      bebe:     tBebe != null ? +tBebe.toFixed(1) : lastTemps?.bebe ?? null,
      ambiente: tAmb  != null ? +tAmb.toFixed(1)  : lastTemps?.ambiente ?? null,
      failBody: sensor_body_fail, failAmb: sensor_amb_fail, ts: Date.now()
    };
    io.emit('temps', { bebe: lastTemps.bebe, ambiente: lastTemps.ambiente, failBody: sensor_body_fail, failAmb: sensor_amb_fail });
  }

  const { estado, alarms } = evaluateStatusAndAlarms({
    cm: lastTelemetry?.cm ?? null, tBebe: lastTemps?.bebe ?? null,
    tAmb: lastTemps?.ambiente ?? null, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail
  });
  lastStatus = { estado, temp_bebe: lastTemps?.bebe ?? null, temp_ambiente: lastTemps?.ambiente ?? null,
                 distance_cm: lastTelemetry?.cm ?? null, illumination_pct: lastTelemetry?.pct ?? null,
                 sensor_ultra_fail, sensor_body_fail, sensor_amb_fail, ts: Date.now() };
  io.emit('status', lastStatus);

  if (paciente_id) {
    try {
      const sesion = await getActiveSession(paciente_id);
      const dispEstado = sesion ? 'en_sesion' : 'online';
      await upsertDeviceStatus(paciente_id, true, dispEstado);
      io.emit('patient:online', { id: String(paciente_id) });

      if (sesion) {
        await pool.execute(
          `INSERT INTO mediciones
             (sesion_id, paciente_id, distance_cm, temp_bebe_c, temp_ambiente_c,
              intensidad_led_pct, modo_actual, esp_online,
              sensor_ultra_fail, sensor_body_fail, sensor_amb_fail)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)`,
          [sesion.id, paciente_id,
           cm ?? null, tBebe ?? null, tAmb ?? null,
           pct ?? null, modo ?? null,
           sensor_ultra_fail ? 1 : 0, sensor_body_fail ? 1 : 0, sensor_amb_fail ? 1 : 0]
        );

        for (const alarm of alarms) {
          const key = `${paciente_id}:${alarm.tipo}`;
          const last = alarmCooldown.get(key) || 0;
          if (Date.now() - last >= CONFIG.ALARM_COOLDOWN_MS) {
            alarmCooldown.set(key, Date.now());
            await pool.execute(
              `INSERT INTO alarmas (sesion_id, paciente_id, tipo, severidad, valor_medido, unidad, mensaje)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [sesion.id, paciente_id, alarm.tipo, alarm.severidad,
               alarm.valor != null ? String(alarm.valor) : null,
               alarm.unidad ?? null, `Alarma automática: ${alarm.tipo}`]
            );
            io.emit('alarm:new', { paciente_id, tipo: alarm.tipo, severidad: alarm.severidad, valor: alarm.valor });
          }
        }
      } else {
        // FIX [8]: registrar alarmas críticas aunque no haya sesión activa
        for (const alarm of alarms.filter(a => a.severidad === 'critical')) {
          const key = `nosession:${paciente_id}:${alarm.tipo}`;
          const last = alarmCooldown.get(key) || 0;
          if (Date.now() - last >= CONFIG.ALARM_COOLDOWN_MS * 2) {
            alarmCooldown.set(key, Date.now());
            // Buscar última sesión para relacionar
            const [lastSes] = await pool.execute(
              `SELECT id FROM sesiones WHERE paciente_id = ? ORDER BY created_at DESC LIMIT 1`, [paciente_id]
            );
            if (lastSes.length) {
              await pool.execute(
                `INSERT INTO alarmas (sesion_id, paciente_id, tipo, severidad, valor_medido, unidad, mensaje)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [lastSes[0].id, paciente_id, alarm.tipo, alarm.severidad,
                 alarm.valor != null ? String(alarm.valor) : null,
                 alarm.unidad ?? null, `Alarma sin sesión activa: ${alarm.tipo}`]
              );
            }
            io.emit('alarm:new', { paciente_id, tipo: alarm.tipo, severidad: alarm.severidad, valor: alarm.valor });
          }
        }
      }
    } catch (e) { console.error('[ESP32-DATA] DB error:', e.message); }
  }

  res.json({ ok: true });
});

// ===================== HEALTH + LATEST ========================

app.get('/ping', (_req, res) => res.send('NEOLIGHT v3.2'));
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, mode: 'wifi', espOnline }); }
  catch { res.status(500).json({ ok: false, mode: 'wifi', espOnline }); }
});

/**
 * Configuración pública del cliente.
 * Solo expone variables que el navegador necesita y que no son sensibles.
 * Nunca incluir DB_PASS, HOSPITAL_CODE ni secretos aquí.
 */
app.get('/api/client-config', (_req, res) => {
  res.json({
    ok: true,
    camStreamUrl: process.env.CAM_STREAM_URL || 'http://10.26.0.74/stream',
  });
});

const buildLatestPayload = () => ({
  ok: true, mode: 'wifi', espOnline,
  data: lastTelemetry ? {
    cm: lastTelemetry.cm, distance: lastTelemetry.cm, distance_cm: lastTelemetry.cm,
    pct: lastTelemetry.pct, illumination: lastTelemetry.pct, illumination_pct: lastTelemetry.pct,
    pwm: lastTelemetry.pwm, modo_actual: lastTelemetry.modo,
    temp_bebe: lastTemps?.bebe ?? null, temp_ambiente: lastTemps?.ambiente ?? null,
    estado: lastStatus?.estado ?? null, ultraFail: lastTelemetry.ultraFail,
    alarms_muted: lastTelemetry.alarms_muted,
  } : null
});

app.get('/api/telemetry/latest', (_req, res) => res.json(buildLatestPayload()));
app.get('/api/esp32/latest',     (_req, res) => res.json(buildLatestPayload()));
app.get('/api/temps/latest', (_req, res) => res.json({
  ok: true, mode: 'wifi',
  data: lastTemps ? { bebe: lastTemps.bebe, ambiente: lastTemps.ambiente, failBody: lastTemps.failBody, failAmb: lastTemps.failAmb } : null
}));
app.get('/api/status/latest', (_req, res) => res.json({ ok: true, mode: 'wifi', data: lastStatus || null }));

// ===================== AUTH ========================

app.post('/api/doctor/verify-code', (req, res) => {
  const code = String(req.body?.code || '');
  res.json({ ok: code === String(CONFIG.HOSPITAL_CODE) });
});

app.get('/api/doctors', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, nombre, apellidos, especialidad, matricula FROM ${ACCOUNT_TABLE}
       WHERE rol = 'doctor' AND estado = 'activo' ORDER BY apellidos, nombre`
    );
    res.json({ ok: true, doctors: rows });
  } catch (e) { return sendDbError(res, e, 'DOCTORS_ERROR'); }
});

app.post('/api/register-doctor', async (req, res) => {
  try {
    const { nombre, apellidos, matricula, especialidad, usuario, contrasena, genero, telefono, correo } = req.body;
    const missing = [];
    for (const [key, value] of Object.entries({ nombre, apellidos, genero, telefono, correo, matricula, especialidad, usuario, contrasena })) {
      if (!String(value ?? '').trim()) missing.push(key);
    }
    if (missing.length)
      return res.status(400).json({ ok: false, error: 'faltan_campos', fields: missing });
    if (String(contrasena).length < 5)
      return res.status(400).json({ ok: false, error: 'contrasena_minima_5' });

    const [dupRows] = await pool.execute(
      `SELECT usuario, correo FROM ${ACCOUNT_TABLE} WHERE usuario = ? OR correo = ? LIMIT 1`,
      [String(usuario).trim(), String(correo).trim()]
    );
    if (dupRows.length) {
      const isCorreo = String(dupRows[0].correo || '').toLowerCase() === String(correo).trim().toLowerCase();
      return res.status(409).json({ ok: false, error: isCorreo ? 'correo_ya_existe' : 'usuario_ya_existe' });
    }

    const hashed = await bcrypt.hash(String(contrasena), 10);
    const [r] = await pool.execute(
      `INSERT INTO ${ACCOUNT_TABLE} (usuario, contrasena, rol, nombre, apellidos, genero, telefono, correo, matricula, especialidad, estado)
       VALUES (?, ?, 'doctor', ?, ?, ?, ?, ?, ?, ?, 'activo')`,
      [String(usuario).trim(), hashed,
       String(nombre).trim(), String(apellidos).trim(),
       normalizeCuentaGenero(genero),
       String(telefono).trim(), String(correo).trim(),
       String(matricula).trim(), String(especialidad).trim()]
    );
    res.json({ ok: true, doctor_id: r.insertId });
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'usuario_ya_existe' });
    return sendDbError(res, e, 'REGISTER_DOCTOR_ERROR');
  }
});

app.post('/api/register', async (req, res) => {
  try {
    let {
      nombre, apellidos, fecha_nac, dob, doctor_id, codigo,
      genero, peso_nacimiento_g, edad_gestacional_sem, fecha_ingreso,
      diagnostico, observaciones, nivel_bilirrubina_inicial,
      grupo_sanguineo, factor_rh,
      usuario, contrasena,
      tutor_nombre, tutor_apellidos, tutor_genero, tutor_telefono, tutor_correo, parentesco,
    } = req.body;

    if (!fecha_nac && dob) fecha_nac = dob;
    const missing = [];
    for (const [key, value] of Object.entries({ nombre, apellidos, fecha_nac, doctor_id, usuario, contrasena })) {
      if (!String(value ?? '').trim()) missing.push(key);
    }
    if (missing.length) return res.status(400).json({ ok: false, error: 'faltan_campos', fields: missing });
    if (String(contrasena).length < 5) return res.status(400).json({ ok: false, error: 'contrasena_minima_5' });
    if (!isISO(fecha_nac)) return res.status(400).json({ ok: false, error: 'fecha_nac_invalida' });

    const [docRows] = await pool.execute(
      `SELECT id FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol = 'doctor' LIMIT 1`, [Number(doctor_id)]
    );
    if (!docRows.length) return res.status(404).json({ ok: false, error: 'doctor_no_encontrado' });

    codigo = String(codigo || '').trim();
    if (!codigo) codigo = await nextPatientCode();
    const [dup] = await pool.execute('SELECT id FROM pacientes WHERE codigo = ?', [codigo]);
    if (dup.length) return res.status(409).json({ ok: false, error: 'codigo_duplicado' });

    const preferred   = clean(usuario || '');
    const base        = preferred || baseUsername(nombre, apellidos);
    const usuarioFinal = await uniqueUsername(base);
    const hashed      = await bcrypt.hash(String(contrasena), 10);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [pr] = await conn.execute(
        `INSERT INTO pacientes
           (codigo, nombre, apellidos, fecha_nac, genero,
            peso_nacimiento_g, edad_gestacional_sem,
            fecha_ingreso, diagnostico, observaciones,
            nivel_bilirrubina_inicial, grupo_sanguineo, factor_rh,
            doctor_id, doctor_request_status, estado_clinico, estado_registro)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ok', 'activo')`,
        [codigo, String(nombre).trim(), String(apellidos).trim(), fecha_nac,
         normalizePacienteGenero(genero), toNum(peso_nacimiento_g), toNum(edad_gestacional_sem),
         isISO(fecha_ingreso) ? fecha_ingreso : todayISO(),
         diagnostico || null, observaciones || null,
         toNum(nivel_bilirrubina_inicial),
         String(grupo_sanguineo || '').trim().toUpperCase() || null,
         String(factor_rh || '').trim() || null,
         Number(doctor_id)]
      );
      const pacienteId = pr.insertId;

      const [cr] = await conn.execute(
        `INSERT INTO ${ACCOUNT_TABLE}
           (usuario, contrasena, rol, nombre, apellidos, genero, telefono, correo, parentesco)
         VALUES (?, ?, 'tutor', ?, ?, ?, ?, ?, ?)`,
        [usuarioFinal, hashed,
         String(tutor_nombre || nombre).trim(),
         String(tutor_apellidos || apellidos).trim(),
         normalizeCuentaGenero(tutor_genero),
         tutor_telefono || null, tutor_correo || null,
         parentesco || 'otro']
      );
      const tutorId = cr.insertId;

      await conn.execute(`UPDATE pacientes SET tutor_id = ? WHERE id = ?`, [tutorId, pacienteId]);

      await conn.execute(
        `INSERT INTO doctor_requests (paciente_id, doctor_id, tutor_id, status)
         VALUES (?, ?, ?, 'pending')`,
        [pacienteId, Number(doctor_id), tutorId]
      );

      await conn.execute(
        `INSERT INTO estado_dispositivo (paciente_id, esp_online, estado) VALUES (?, FALSE, 'offline')`,
        [pacienteId]
      );

      await conn.execute(
        `INSERT INTO control_autorizaciones
           (paciente_id, doctor_id, tutor_id, modo_control, manual_habilitado, automatico_habilitado, motivo)
         VALUES (?, ?, ?, 'bloqueado', FALSE, FALSE, 'Bloqueado por defecto al registrar paciente')`,
        [pacienteId, Number(doctor_id), tutorId]
      );

      await logEvent({
        paciente_id: pacienteId, cuenta_id: tutorId, tipo: 'paciente_editado',
        descripcion: 'Paciente registrado por tutor',
        metadata: { codigo, doctor_id }
      }, conn);

      await conn.commit();
      res.json({ ok: true, paciente_id: pacienteId, tutor_id: tutorId, usuario: usuarioFinal, codigo });
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'usuario_ya_existe' });
    return sendDbError(res, e, 'REGISTER_ERROR');
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena)
      return res.status(400).json({ ok: false, error: 'faltan_credenciales' });

    const [rows] = await pool.execute(
      `SELECT id, usuario, contrasena, rol, nombre, apellidos, genero,
              matricula, especialidad, parentesco, correo, telefono, estado
       FROM ${ACCOUNT_TABLE} WHERE usuario = ? LIMIT 1`,
      [String(usuario).trim()]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: 'credenciales_invalidas' });
    const c = rows[0];
    if (c.estado === 'inactivo') return res.status(403).json({ ok: false, error: 'cuenta_inactiva' });

    const match = await bcrypt.compare(String(contrasena), c.contrasena);
    if (!match) return res.status(401).json({ ok: false, error: 'credenciales_invalidas' });

    await logEvent({ cuenta_id: c.id, tipo: 'login', descripcion: `Login ${c.rol}` });

    if (c.rol === 'doctor' || c.rol === 'admin') {
      return res.json({
        ok: true, role: 'doctor',
        doctor: {
          id: c.id, usuario: c.usuario, rol: c.rol,
          nombre: c.nombre, apellidos: c.apellidos,
          genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '',
          matricula: c.matricula || '', especialidad: c.especialidad || '',
        },
        paciente: null, last_session: null,
      });
    }

    const [pRows] = await pool.execute(
      `SELECT * FROM pacientes WHERE tutor_id = ? LIMIT 1`, [c.id]
    );
    if (!pRows.length) return res.status(500).json({ ok: false, error: 'cuenta_sin_paciente' });
    const p = pRows[0];

    if (p.doctor_request_status !== 'accepted')
      return res.status(403).json({ ok: false, error: 'doctor_no_acepto', status: p.doctor_request_status });

    const plan    = await getActivePlan(p.id);
    const session = await getActiveSession(p.id);

    const [ssRows] = await pool.execute(
      `SELECT * FROM sesiones WHERE paciente_id = ? ORDER BY created_at DESC LIMIT 1`, [p.id]
    );
    const lastSession = ssRows[0] || null;

    const [ctrlRows] = await pool.execute(
      `SELECT modo_control, manual_habilitado, automatico_habilitado, habilitado_hasta, motivo
       FROM control_autorizaciones WHERE paciente_id = ? AND tutor_id = ? LIMIT 1`,
      [p.id, c.id]
    );
    const control = ctrlRows[0] ? { ...ctrlRows[0], modo_actual: currentLampMode } : null;

    const [devRows] = await pool.execute(
      `SELECT esp_online, estado, last_seen_at FROM estado_dispositivo WHERE paciente_id = ? LIMIT 1`, [p.id]
    );
    const [doctorRows] = await pool.execute(
      `SELECT id, usuario, nombre, apellidos, genero, matricula, especialidad
       FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol IN ('doctor','admin') LIMIT 1`,
      [p.doctor_id]
    );

    res.json({
      ok: true, role: 'tutor',
      paciente: {
        id: p.id, codigo: p.codigo, nombre: p.nombre, apellidos: p.apellidos,
        fecha_nac: p.fecha_nac, dias_nacido: daysBetween(p.fecha_nac),
        genero: p.genero, peso_nacimiento_g: p.peso_nacimiento_g, peso_actual_g: p.peso_actual_g,
        edad_gestacional_sem: p.edad_gestacional_sem, fecha_ingreso: p.fecha_ingreso,
        fecha_alta: p.fecha_alta, doctor_id: p.doctor_id,
        doctor_request_status: p.doctor_request_status,
        estado_clinico: p.estado_clinico, estado_registro: p.estado_registro,
        diagnostico: p.diagnostico, observaciones: p.observaciones,
        nivel_bilirrubina_inicial: p.nivel_bilirrubina_inicial,
        nivel_bilirrubina_actual: p.nivel_bilirrubina_actual,
        grupo_sanguineo: p.grupo_sanguineo, factor_rh: p.factor_rh,
      },
      tutor: {
        id: c.id, usuario: c.usuario, nombre: c.nombre, apellidos: c.apellidos,
        genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '',
        parentesco: c.parentesco
      },
      plan: plan || null, session: session || null, last_session: lastSession,
      control, dispositivo: devRows[0] || null, doctor: doctorRows[0] || null,
    });
  } catch (e) { return sendDbError(res, e, 'LOGIN_ERROR'); }
});

// ===================== DOCTOR DASHBOARD ========================

app.get('/api/doctor/requests', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const [rows] = await pool.execute(
      `SELECT r.id, r.paciente_id, r.tutor_id, r.created_at,
              p.nombre, p.apellidos, p.codigo, p.fecha_nac,
              TIMESTAMPDIFF(DAY, p.fecha_nac, CURDATE()) AS dias_nacido,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos, t.parentesco
       FROM doctor_requests r
       JOIN pacientes p ON p.id = r.paciente_id
       LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = r.tutor_id
       WHERE r.doctor_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [doctorId]
    );
    res.json({ ok: true, requests: rows });
  } catch (e) { return sendServerError(res, e, 'DOC_REQ_LIST'); }
});

// FIX [2]: al rechazar, limpiar control_autorizaciones huérfano
app.post('/api/doctor/requests/:id', async (req, res) => {
  const reqId    = Number(req.params.id);
  const decision = String(req.body?.decision || '').toLowerCase();
  const doctorId = getDoctorIdFromReq(req);
  if (!reqId) return res.status(400).json({ ok: false, error: 'id_invalido' });
  if (!['accept','reject'].includes(decision)) return res.status(400).json({ ok: false, error: 'decision_invalida' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rRows] = await conn.execute(`SELECT * FROM doctor_requests WHERE id = ? LIMIT 1`, [reqId]);
    if (!rRows.length) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'request_no_encontrado' }); }
    const r = rRows[0];
    if (r.status !== 'pending') { await conn.rollback(); return res.json({ ok: true, note: 'ya_procesado' }); }

    const newStatus = decision === 'accept' ? 'accepted' : 'rejected';
    await conn.execute(`UPDATE doctor_requests SET status = ?, respuesta_at = NOW() WHERE id = ?`, [newStatus, reqId]);
    await conn.execute(
      `UPDATE pacientes SET doctor_request_status = ?, doctor_id = ? WHERE id = ?`,
      [newStatus, newStatus === 'accepted' ? r.doctor_id : null, r.paciente_id]
    );

    if (newStatus === 'accepted') {
      await conn.execute(
        `INSERT IGNORE INTO estado_dispositivo (paciente_id, esp_online, estado) VALUES (?, FALSE, 'offline')`,
        [r.paciente_id]
      );
      await conn.execute(
        `INSERT IGNORE INTO control_autorizaciones
           (paciente_id, doctor_id, tutor_id, modo_control, manual_habilitado, automatico_habilitado)
         VALUES (?, ?, ?, 'bloqueado', FALSE, FALSE)`,
        [r.paciente_id, r.doctor_id, r.tutor_id]
      );
      await logEvent({ paciente_id: r.paciente_id, cuenta_id: doctorId || r.doctor_id,
                       tipo: 'solicitud_aceptada', descripcion: 'Doctor aceptó la solicitud' }, conn);
    } else {
      // FIX [2]: limpiar fila de control que quedó huérfana
      await conn.execute(
        `DELETE FROM control_autorizaciones WHERE paciente_id = ? AND tutor_id = ?`,
        [r.paciente_id, r.tutor_id]
      );
      await logEvent({ paciente_id: r.paciente_id, cuenta_id: doctorId || r.doctor_id,
                       tipo: 'solicitud_rechazada', descripcion: 'Doctor rechazó la solicitud' }, conn);
    }

    await conn.commit();
    res.json({ ok: true, status: newStatus });
  } catch (e) { await conn.rollback(); return sendServerError(res, e, 'DOC_REQ_DECIDE'); }
  finally { conn.release(); }
});

app.get('/api/doctor/patients', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const [rows] = await pool.execute(
      `SELECT p.id, p.codigo, p.nombre, p.apellidos, p.estado_clinico, p.diagnostico,
              p.genero, p.fecha_nac, p.fecha_ingreso, p.peso_nacimiento_g,
              p.edad_gestacional_sem, p.nivel_bilirrubina_inicial,
              p.nivel_bilirrubina_actual, p.grupo_sanguineo, p.factor_rh,
              TIMESTAMPDIFF(DAY, p.fecha_nac, CURDATE()) AS dias_nacido,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos, t.telefono AS tutor_telefono,
              ed.estado AS dispositivo, ed.last_seen_at,
              (SELECT COUNT(*) FROM sesiones s WHERE s.paciente_id = p.id AND s.status IN ('active','paused')) AS sesiones_activas,
              (SELECT MAX(finished_at) FROM sesiones s WHERE s.paciente_id = p.id AND s.status = 'finished') AS ultima_sesion,
              pt.id AS plan_id, pt.meta_total_s, pt.tiempo_acumulado_s,
              pt.modo_recomendado, pt.horas_por_dia, pt.sesiones_por_dia, pt.duracion_sesion_min,
              ROUND((pt.tiempo_acumulado_s / NULLIF(pt.meta_total_s,0)) * 100, 1) AS plan_pct
       FROM pacientes p
       LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = p.tutor_id
       LEFT JOIN estado_dispositivo ed ON ed.paciente_id = p.id
       LEFT JOIN planes_terapia pt ON pt.paciente_id = p.id AND pt.estado = 'activo'
       WHERE p.doctor_id = ? AND p.estado_registro = 'activo' AND p.doctor_request_status = 'accepted'
       ORDER BY p.apellidos, p.nombre`,
      [doctorId]
    );
    res.json({ ok: true, patients: rows });
  } catch (e) { return sendServerError(res, e, 'DOC_PATIENTS'); }
});

app.get('/api/doctor/patients/archived', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const [rows] = await pool.execute(
      `SELECT p.id, p.codigo, p.nombre, p.apellidos, p.estado_clinico, p.archived_at,
              TIMESTAMPDIFF(DAY, p.fecha_nac, CURDATE()) AS dias_nacido
       FROM pacientes p
       WHERE p.doctor_id = ? AND p.estado_registro = 'archivado'
       ORDER BY p.archived_at DESC`,
      [doctorId]
    );
    res.json({ ok: true, patients: rows });
  } catch (e) { return sendServerError(res, e, 'DOC_ARCHIVED_PATIENTS'); }
});

app.get('/api/doctor/patients/:id', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId || !patientId) return res.status(400).json({ ok: false, error: 'params_invalidos' });

    const [rows] = await pool.execute(
      `SELECT p.*,
              d.nombre AS doctor_nombre, d.apellidos AS doctor_apellidos, d.especialidad,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos, t.parentesco, t.telefono AS tutor_tel,
              ed.esp_online, ed.estado AS disp_estado, ed.last_seen_at
       FROM pacientes p
       LEFT JOIN ${ACCOUNT_TABLE} d  ON d.id = p.doctor_id
       LEFT JOIN ${ACCOUNT_TABLE} t  ON t.id = p.tutor_id
       LEFT JOIN estado_dispositivo ed ON ed.paciente_id = p.id
       WHERE p.id = ? LIMIT 1`,
      [patientId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' });
    const p = rows[0];
    if (Number(p.doctor_id) !== doctorId) return res.status(403).json({ ok: false, error: 'no_autorizado' });

    const plan = await getActivePlan(patientId);
    const [ctrlRows] = await pool.execute(
      `SELECT * FROM control_autorizaciones WHERE paciente_id = ? LIMIT 1`, [patientId]
    );
    res.json({ ok: true, patient: p, plan: plan || null, control: ctrlRows[0] || null });
  } catch (e) { return sendServerError(res, e, 'DOC_PATIENT_DETAIL'); }
});

app.put('/api/doctor/patients/:id', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId || !patientId) return res.status(400).json({ ok: false, error: 'params_invalidos' });
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    const allowed = ['nombre','apellidos','diagnostico','observaciones','estado_clinico',
      'peso_nacimiento_g','peso_actual_g','edad_gestacional_sem',
      'nivel_bilirrubina_inicial','nivel_bilirrubina_actual','grupo_sanguineo','factor_rh'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'sin_campos' });
    vals.push(patientId);
    await pool.execute(`UPDATE pacientes SET ${sets.join(', ')} WHERE id = ?`, vals);
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'paciente_editado',
                     descripcion: 'Datos del paciente editados', metadata: req.body });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PATIENT_EDIT');
  }
});

app.put('/api/doctor/patients/:id/clinical', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId || !patientId) return res.status(400).json({ ok: false, error: 'params_invalidos' });
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    const allowed = ['peso_nacimiento_g','peso_actual_g','edad_gestacional_sem',
      'diagnostico','observaciones','nivel_bilirrubina_inicial','nivel_bilirrubina_actual',
      'grupo_sanguineo','factor_rh'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'sin_campos' });
    vals.push(patientId);
    await pool.execute(`UPDATE pacientes SET ${sets.join(', ')} WHERE id = ?`, vals);
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'diagnostico_editado',
                     descripcion: 'Datos clínicos actualizados', metadata: req.body });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PATIENT_CLINICAL_EDIT');
  }
});

app.post('/api/doctor/patients/:id/discharge', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    await pool.execute(`UPDATE pacientes SET estado_clinico = 'alta', fecha_alta = NOW() WHERE id = ?`, [patientId]);
    await upsertDeviceStatus(patientId, false, 'offline');
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'paciente_dado_alta' });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/doctor/patients/:id/archive', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    await pool.execute(
      `UPDATE pacientes SET estado_registro = 'archivado', archived_at = NOW() WHERE id = ?`, [patientId]
    );
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'paciente_archivado' });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/doctor/patients/:id/restore', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    await pool.execute(
      `UPDATE pacientes SET estado_registro = 'activo', archived_at = NULL WHERE id = ?`, [patientId]
    );
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'paciente_restaurado' });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/doctor/search-patients', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const q = String(req.query.q || '').trim();
    const [rows] = await pool.execute(
      `SELECT p.id, p.codigo, p.nombre, p.apellidos, p.estado_clinico, p.estado_registro, p.diagnostico
       FROM pacientes p
       WHERE p.doctor_id = ? AND p.estado_registro != 'eliminado_logico'
         AND (p.nombre LIKE CONCAT('%',?,'%') OR p.apellidos LIKE CONCAT('%',?,'%')
           OR p.codigo LIKE CONCAT('%',?,'%') OR p.diagnostico LIKE CONCAT('%',?,'%'))
       ORDER BY p.apellidos, p.nombre LIMIT 50`,
      [doctorId, q, q, q, q]
    );
    res.json({ ok: true, results: rows });
  } catch (e) { return sendServerError(res, e, 'SEARCH_PATIENTS'); }
});

// ===================== PLANES DE TERAPIA ========================

app.get('/api/patients/:id/plan-active', async (req, res) => {
  try {
    const plan = await getActivePlan(Number(req.params.id));
    res.json({ ok: true, plan: plan || null });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// FIX [3]: plan ahora acepta horas_por_dia, sesiones_por_dia, duracion_sesion_min
app.post('/api/doctor/patients/:id/plan', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    let meta_total_s = toNum(req.body.meta_total_s);
    if (!meta_total_s && req.body.hours_target)
      meta_total_s = Math.round(Number(req.body.hours_target) * 3600);
    if (!meta_total_s || meta_total_s <= 0)
      return res.status(400).json({ ok: false, error: 'meta_invalida' });

    const modo            = normalizeMode(req.body.modo_recomendado) || 'convencional';
    const observaciones   = req.body.observaciones || null;
    const horas_por_dia   = toNum(req.body.horas_por_dia);
    const sesiones_por_dia = toNum(req.body.sesiones_por_dia);
    const duracion_sesion_min = toNum(req.body.duracion_sesion_min);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE planes_terapia SET estado = 'pausado' WHERE paciente_id = ? AND estado = 'activo'`,
        [patientId]
      );
      const [r] = await conn.execute(
        `INSERT INTO planes_terapia
           (paciente_id, doctor_id, meta_total_s, modo_recomendado, observaciones,
            horas_por_dia, sesiones_por_dia, duracion_sesion_min)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [patientId, doctorId, meta_total_s, modo, observaciones,
         horas_por_dia, sesiones_por_dia, duracion_sesion_min]
      );
      await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'plan_creado',
                       descripcion: 'Plan de terapia creado',
                       metadata: { plan_id: r.insertId, meta_total_s,
                                   horas: +(meta_total_s/3600).toFixed(2), modo,
                                   horas_por_dia, sesiones_por_dia, duracion_sesion_min } }, conn);
      await conn.commit();
      const plan = await getActivePlan(patientId);
      res.json({ ok: true, plan });
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PLAN_CREATE');
  }
});

app.put('/api/doctor/patients/:id/plan/:planId', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    const planId    = Number(req.params.planId);
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    const sets = [], vals = [];
    if (req.body.meta_total_s)        { sets.push('meta_total_s = ?');        vals.push(Number(req.body.meta_total_s)); }
    if (req.body.hours_target)        { sets.push('meta_total_s = ?');        vals.push(Math.round(Number(req.body.hours_target)*3600)); }
    if (req.body.modo_recomendado)    { sets.push('modo_recomendado = ?');     vals.push(normalizeMode(req.body.modo_recomendado)); }
    if (req.body.observaciones != null){ sets.push('observaciones = ?');       vals.push(req.body.observaciones); }
    if (req.body.horas_por_dia != null){ sets.push('horas_por_dia = ?');       vals.push(toNum(req.body.horas_por_dia)); }
    if (req.body.sesiones_por_dia != null){ sets.push('sesiones_por_dia = ?');  vals.push(toNum(req.body.sesiones_por_dia)); }
    if (req.body.duracion_sesion_min != null){ sets.push('duracion_sesion_min = ?'); vals.push(toNum(req.body.duracion_sesion_min)); }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'sin_campos' });
    vals.push(planId);
    await pool.execute(`UPDATE planes_terapia SET ${sets.join(', ')} WHERE id = ?`, vals);
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'plan_actualizado',
                     metadata: { plan_id: planId } });
    const plan = await getActivePlan(patientId);
    res.json({ ok: true, plan });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PLAN_UPDATE');
  }
});

app.post('/api/doctor/patients/:id/plan/:planId/cancel', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    const planId    = Number(req.params.planId);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    await pool.execute(
      `UPDATE planes_terapia SET estado = 'cancelado', fecha_fin = NOW() WHERE id = ? AND paciente_id = ?`,
      [planId, patientId]
    );
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'plan_cancelado',
                     descripcion: 'Plan cancelado por el doctor', metadata: { plan_id: planId } });
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PLAN_CANCEL');
  }
});

// FIX [7]: historial de planes
app.get('/api/doctor/patients/:id/plan-history', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    const [rows] = await pool.execute(
      `SELECT id, meta_total_s, tiempo_acumulado_s, modo_recomendado, estado,
              horas_por_dia, sesiones_por_dia, duracion_sesion_min,
              fecha_inicio, fecha_fin, observaciones, created_at,
              ROUND((tiempo_acumulado_s / NULLIF(meta_total_s,0)) * 100, 1) AS pct_avance,
              ROUND(tiempo_acumulado_s / 3600, 2) AS horas_acumuladas,
              ROUND(meta_total_s / 3600, 2) AS horas_meta
       FROM planes_terapia WHERE paciente_id = ? ORDER BY created_at DESC`,
      [patientId]
    );
    res.json({ ok: true, plans: rows });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'PLAN_HISTORY');
  }
});

// ===================== SESIONES ========================

app.post('/api/sessions/start', async (req, res) => {
  try {
    const { paciente_id, modo_programado, tipo_control } = req.body;
    if (!paciente_id) return res.status(400).json({ ok: false, error: 'falta_paciente_id' });
    const modo = normalizeMode(modo_programado) || 'convencional';
    const ctrl = ['manual','automatico','doctor'].includes(tipo_control) ? tipo_control : 'automatico';

    const [pRows] = await pool.execute(
      `SELECT id FROM pacientes WHERE id = ? AND estado_registro = 'activo' LIMIT 1`, [paciente_id]
    );
    if (!pRows.length) return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' });

    const existing = await getActiveSession(paciente_id);
    if (existing) return res.status(409).json({ ok: false, error: 'sesion_ya_activa', sesion_id: existing.id });

    const plan = await getActivePlan(paciente_id);
    const now  = new Date();
    const fecha = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const hora  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.execute(
        `INSERT INTO sesiones (paciente_id, plan_id, fecha, hora_inicio, started_at, modo_programado, tipo_control, status)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, 'active')`,
        [paciente_id, plan?.id || null, fecha, hora, modo, ctrl]
      );
      const sesionId = r.insertId;
      await upsertDeviceStatus(paciente_id, true, 'en_sesion', conn);
      await logEvent({ paciente_id, sesion_id: sesionId, tipo: 'inicio_sesion',
                       descripcion: 'Sesión iniciada',
                       metadata: { modo, tipo_control: ctrl, plan_id: plan?.id || null } }, conn);
      await conn.commit();
      io.emit('session:started', { paciente_id, sesion_id: sesionId, modo });
      res.json({ ok: true, sesion_id: sesionId, plan: plan || null });
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  } catch (e) { return sendServerError(res, e, 'SESSION_START'); }
});

app.post('/api/sessions/:id/pause', async (req, res) => {
  try {
    const sesionId  = Number(req.params.id);
    const cuenta_id = getDoctorIdFromReq(req) || getTutorIdFromReq(req);
    await pool.execute(
      `UPDATE sesiones SET status = 'paused' WHERE id = ? AND status = 'active'`, [sesionId]
    );
    const [rows] = await pool.execute(`SELECT paciente_id FROM sesiones WHERE id = ?`, [sesionId]);
    await logEvent({ paciente_id: rows[0]?.paciente_id, sesion_id: sesionId, cuenta_id, tipo: 'pausa_sesion' });
    io.emit('session:paused', { sesion_id: sesionId });
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'SESSION_PAUSE'); }
});

app.post('/api/sessions/:id/finish', async (req, res) => {
  try {
    const sesionId  = Number(req.params.id);
    const cuenta_id = getDoctorIdFromReq(req) || getTutorIdFromReq(req);
    const {
      duracion_s, tiempo_rango_s, tiempo_fuera_rango_s,
      modo_final, motivo_fin = 'completada',
      intensidad_promedio_pct, distancia_promedio_cm,
      temp_bebe_promedio_c, temp_amb_promedio_c, observaciones
    } = req.body;

    const [sRows] = await pool.execute(
      `SELECT * FROM sesiones WHERE id = ? AND status IN ('active','paused') LIMIT 1`, [sesionId]
    );
    if (!sRows.length)
      return res.status(404).json({ ok: false, error: 'sesion_no_encontrada_o_ya_finalizada' });
    const s = sRows[0];

    let durS = toNum(duracion_s);
    if (!durS && s.started_at) durS = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
    durS = Math.max(0, durS || 0);

    const now     = new Date();
    const hora_fin = now.toTimeString().slice(0,8);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        `UPDATE sesiones SET
           status = 'finished', finished_at = NOW(), hora_fin = ?,
           duracion_s = ?, tiempo_rango_s = ?, tiempo_fuera_rango_s = ?,
           modo_final = ?, motivo_fin = ?,
           intensidad_promedio_pct = ?, distancia_promedio_cm = ?,
           temp_bebe_promedio_c = ?, temp_amb_promedio_c = ?,
           observaciones = COALESCE(?, observaciones)
         WHERE id = ?`,
        [hora_fin, durS,
         toNum(tiempo_rango_s), toNum(tiempo_fuera_rango_s),
         normalizeMode(modo_final) || s.modo_programado, motivo_fin,
         toNum(intensidad_promedio_pct), toNum(distancia_promedio_cm),
         toNum(temp_bebe_promedio_c), toNum(temp_amb_promedio_c),
         observaciones || null, sesionId]
      );

      if (s.plan_id && durS > 0) {
        await updatePlanProgress(s.plan_id, durS, conn);
      }

      const isEspOn = espOnline;
      await upsertDeviceStatus(s.paciente_id, isEspOn, isEspOn ? 'online' : 'offline', conn);

      await logEvent({ paciente_id: s.paciente_id, sesion_id: sesionId, cuenta_id,
                       tipo: 'fin_sesion', descripcion: `Sesión finalizada: ${motivo_fin}`,
                       metadata: { duracion_s: durS, motivo_fin, plan_id: s.plan_id } }, conn);

      await conn.commit();
      io.emit('session:finished', { paciente_id: s.paciente_id, sesion_id: sesionId, duracion_s: durS });

      const plan = s.plan_id ? await getActivePlan(s.paciente_id) : null;
      res.json({ ok: true, duracion_s: durS, hms: secondsToHMS(durS), plan: plan || null });
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  } catch (e) { return sendServerError(res, e, 'SESSION_FINISH'); }
});

app.get('/api/patients/:id/sessions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, fecha, hora_inicio, hora_fin, duracion_s, tiempo_rango_s,
              modo_programado, modo_final, tipo_control, status, motivo_fin,
              intensidad_promedio_pct, temp_bebe_promedio_c, temp_amb_promedio_c
       FROM sesiones WHERE paciente_id = ? ORDER BY fecha DESC, id DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, sessions: rows });
  } catch (e) { return sendServerError(res, e, 'PATIENT_SESSIONS'); }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT * FROM sesiones WHERE id = ? LIMIT 1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'sesion_no_encontrada' });
    res.json({ ok: true, session: rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.get('/api/sessions/:id/measurements', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT distance_cm, temp_bebe_c, temp_ambiente_c, intensidad_led_pct,
              modo_actual, esp_online, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail, created_at
       FROM mediciones WHERE sesion_id = ? ORDER BY created_at ASC`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, measurements: rows });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// Legacy
app.post('/api/sesiones', async (req, res) => {
  const { paciente_id, duracion_s } = req.body;
  if (!paciente_id) return res.status(400).json({ ok: false, error: 'falta_paciente_id' });
  const sesion = await getActiveSession(paciente_id);
  if (!sesion) {
    const now = new Date();
    const dur = Number(duracion_s) || 0;
    const toMySQL = d => {
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const fecha     = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const horaFin   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const startedAt = toMySQL(new Date(now.getTime() - dur * 1000));
    const [r] = await pool.execute(
      `INSERT INTO sesiones (paciente_id, fecha, hora_inicio, hora_fin, started_at, finished_at,
         duracion_s, modo_programado, status, motivo_fin)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, 'convencional', 'finished', 'completada')`,
      [paciente_id, fecha, horaFin, horaFin, startedAt, dur]
    );
    return res.json({ ok: true, sesion_id: r.insertId });
  }
  req.params = { id: String(sesion.id) };
  res.redirect(307, `/api/sessions/${sesion.id}/finish`);
});

// ===================== CONTROL Y MODOS ========================

app.get('/api/patient/:id/control', async (req, res) => {
  try {
    const tutorId   = getTutorIdFromReq(req);
    const patientId = Number(req.params.id);
    const [rows] = await pool.execute(
      `SELECT modo_control, manual_habilitado, automatico_habilitado,
              habilitado_desde, habilitado_hasta, motivo
       FROM control_autorizaciones WHERE paciente_id = ? ${tutorId ? 'AND tutor_id = ?' : ''} LIMIT 1`,
      tutorId ? [patientId, tutorId] : [patientId]
    );
    res.json({ ok: true, control: rows[0] ? { ...rows[0], modo_actual: currentLampMode } : null });
  } catch (e) { return sendServerError(res, e, 'PATIENT_CONTROL_GET'); }
});

app.post('/api/doctor/patients/:id/control', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    let { modo_control, habilitado_hasta, motivo, tutor_id } = req.body;
    if (modo_control === 'automatic' || modo_control === 'blocked')
      modo_control = modo_control === 'automatic' ? 'automatico' : 'bloqueado';
    if (!['bloqueado','manual','automatico'].includes(modo_control))
      return res.status(400).json({ ok: false, error: 'modo_control_invalido' });

    const manualH  = modo_control === 'manual'     ? 1 : 0;
    const autoH    = modo_control === 'automatico' ? 1 : 0;
    const bloqAt   = modo_control === 'bloqueado'  ? new Date() : null;
    const habDesde = modo_control !== 'bloqueado'  ? new Date() : null;

    await pool.execute(
      `UPDATE control_autorizaciones
       SET modo_control = ?, manual_habilitado = ?, automatico_habilitado = ?,
           habilitado_desde = ?, habilitado_hasta = ?, bloqueado_at = ?, motivo = ?
       WHERE paciente_id = ? ${tutor_id ? 'AND tutor_id = ?' : ''}`,
      [modo_control, manualH, autoH, habDesde, habilitado_hasta || null, bloqAt, motivo || null,
       patientId, ...(tutor_id ? [tutor_id] : [])]
    );

    const tipoEvento = modo_control === 'bloqueado'   ? 'control_manual_bloqueado'
                     : modo_control === 'manual'       ? 'control_manual_habilitado'
                     :                                   'modo_automatico_habilitado';
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: tipoEvento,
                     descripcion: `Control cambiado a: ${modo_control}`,
                     metadata: { modo_control, habilitado_hasta } });

    io.emit('control:updated', { paciente_id: patientId, modo_control,
                                  manual_habilitado: !!manualH, automatico_habilitado: !!autoH });
    res.json({ ok: true, modo_control });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'DOCTOR_CONTROL_UPDATE');
  }
});

app.post('/api/doctor/patients/:id/mode', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    const modo = normalizeMode(req.body.mode);
    if (!modo) return res.status(400).json({ ok: false, error: 'modo_invalido' });

    const result = await sendCommandToESP({ type: 'mode', mode: modo.toUpperCase() });
    currentLampMode = modo;
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'cambio_modo',
                     descripcion: `Doctor cambió modo a ${modo}`, metadata: { modo, esp_sent: result.sent } });
    io.emit('lamp:command', { type: 'mode', mode: modo, paciente_id: patientId });
    io.emit('control:updated', { paciente_id: patientId, modo_actual: currentLampMode });
    res.json({ ok: true, mode: modo, esp: result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'DOCTOR_SET_MODE');
  }
});

app.post('/api/patient/:id/mode-request', async (req, res) => {
  try {
    const tutorId   = getTutorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!tutorId) return res.status(400).json({ ok: false, error: 'falta_tutor_id' });

    const requestedMode = String(req.body?.mode || '').toLowerCase().trim();
    const isManualControlRequest = requestedMode === 'manual_control';
    const modo = isManualControlRequest ? 'manual_control' : normalizeMode(requestedMode);
    if (!modo || modo === 'automatico') return res.status(400).json({ ok: false, error: 'modo_invalido_para_tutor' });

    if (!isManualControlRequest) {
      const [ctrlRows] = await pool.execute(
        `SELECT modo_control, manual_habilitado, habilitado_hasta
         FROM control_autorizaciones WHERE paciente_id = ? AND tutor_id = ? LIMIT 1`,
        [patientId, tutorId]
      );
      const ctrl = ctrlRows[0];
      if (!ctrl || ctrl.modo_control !== 'manual' || !ctrl.manual_habilitado)
        return res.status(403).json({ ok: false, error: 'control_bloqueado' });
      if (ctrl.habilitado_hasta && new Date(ctrl.habilitado_hasta) < new Date())
        return res.status(403).json({ ok: false, error: 'permiso_expirado' });
    }

    const [patientRows] = await pool.execute(
      `SELECT p.id, p.nombre, p.apellidos, p.doctor_id,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos
       FROM pacientes p
       LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = p.tutor_id
       WHERE p.id = ? AND p.tutor_id = ? LIMIT 1`,
      [patientId, tutorId]
    );
    if (!patientRows.length) return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' });

    const duplicate = Array.from(pendingModeRequests.values()).find(r =>
      r.status === 'pending' && Number(r.paciente_id) === Number(patientId) &&
      Number(r.tutor_id) === Number(tutorId) && r.mode === modo
    );
    if (duplicate) return res.json({ ok: true, status: 'pending', request_id: duplicate.id, mode: modo });

    const requestId = String(pendingModeRequestSeq++);
    pendingModeRequests.set(requestId, {
      id: requestId, paciente_id: patientId,
      doctor_id: Number(patientRows[0].doctor_id), tutor_id: tutorId,
      mode: modo, request_type: isManualControlRequest ? 'manual_control' : 'mode_change',
      motivo: req.body?.motivo || null, status: 'pending',
      created_at: new Date().toISOString(),
      paciente_nombre: patientRows[0].nombre, paciente_apellidos: patientRows[0].apellidos,
      tutor_nombre: patientRows[0].tutor_nombre, tutor_apellidos: patientRows[0].tutor_apellidos,
    });

    await logEvent({ paciente_id: patientId, cuenta_id: tutorId,
                     tipo: isManualControlRequest ? 'control_manual_habilitado' : 'cambio_modo',
                     descripcion: isManualControlRequest ? 'Tutor solicitó control manual' : `Tutor solicitó modo ${modo}`,
                     metadata: { modo, request_id: requestId } });
    io.emit('mode-request:new', { id: requestId, paciente_id: patientId, mode: modo,
                                   request_type: isManualControlRequest ? 'manual_control' : 'mode_change' });
    return res.json({ ok: true, status: 'pending', request_id: requestId, mode: modo });
  } catch (e) { return sendServerError(res, e, 'TUTOR_MODE_REQUEST'); }
});

app.get('/api/doctor/mode-requests', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const requests = Array.from(pendingModeRequests.values())
      .filter(r => r.status === 'pending' && Number(r.doctor_id) === Number(doctorId));
    res.json({ ok: true, requests });
  } catch (e) { return sendServerError(res, e, 'FETCH_MODE_REQUESTS'); }
});

// FIX [5][6]: tipos de evento correctos al aprobar/rechazar solicitudes de modo
app.post('/api/doctor/mode-requests/:id', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const requestId = String(req.params.id || '');
    const decision  = String(req.body?.decision || '').toLowerCase();
    const accept = ['accept','accepted','aprobar'].includes(decision);
    const reject = ['reject','rejected','rechazar'].includes(decision);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    if (!accept && !reject) return res.status(400).json({ ok: false, error: 'decision_invalida' });

    const request = pendingModeRequests.get(requestId);
    if (!request || request.status !== 'pending' || Number(request.doctor_id) !== Number(doctorId))
      return res.status(404).json({ ok: false, error: 'solicitud_no_encontrada' });

    if (reject) {
      pendingModeRequests.delete(requestId);
      // FIX [5]: usar 'solicitud_rechazada' en lugar de 'solicitud_modo_rechazada'
      await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId,
                       tipo: 'solicitud_rechazada',
                       descripcion: `Doctor rechazó solicitud de modo ${request.mode}`,
                       metadata: { request_id: requestId, mode: request.mode } });
      io.emit('mode-request:resolved', { id: requestId, paciente_id: request.paciente_id, status: 'rejected', mode: request.mode });
      return res.json({ ok: true, status: 'rejected' });
    }

    await ensurePatientBelongsToDoctor(request.paciente_id, doctorId);

    if (request.mode === 'manual_control' || request.request_type === 'manual_control') {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.execute(
        `UPDATE control_autorizaciones
         SET modo_control = 'manual', manual_habilitado = 1, automatico_habilitado = 0,
             habilitado_desde = NOW(), habilitado_hasta = ?, bloqueado_at = NULL, motivo = ?
         WHERE paciente_id = ? AND tutor_id = ?`,
        [until, request.motivo || 'Control manual aprobado por doctor', request.paciente_id, request.tutor_id]
      );
      pendingModeRequests.delete(requestId);
      // FIX [6]: usar 'solicitud_aceptada' en lugar de 'solicitud_modo_aprobada'
      await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId,
                       tipo: 'solicitud_aceptada',
                       descripcion: 'Doctor aprobó control manual solicitado por tutor',
                       metadata: { request_id: requestId } });
      io.emit('control:updated', { paciente_id: request.paciente_id, modo_control: 'manual',
                                    manual_habilitado: true, automatico_habilitado: false });
      io.emit('mode-request:resolved', { id: requestId, paciente_id: request.paciente_id, status: 'accepted', mode: request.mode });
      return res.json({ ok: true, status: 'accepted', mode: request.mode });
    }

    const result = await sendCommandToESP({ type: 'mode', mode: request.mode.toUpperCase() });
    currentLampMode = request.mode;
    pendingModeRequests.delete(requestId);
    // FIX [6]
    await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId,
                     tipo: 'solicitud_aceptada',
                     descripcion: `Doctor aprobó modo ${request.mode}`,
                     metadata: { request_id: requestId, mode: request.mode, esp_sent: result.sent } });
    io.emit('lamp:command', { type: 'mode', mode: request.mode, paciente_id: request.paciente_id });
    io.emit('control:updated', { paciente_id: request.paciente_id, modo_actual: currentLampMode });
    io.emit('mode-request:resolved', { id: requestId, paciente_id: request.paciente_id, status: 'accepted', mode: request.mode });
    res.json({ ok: true, status: 'accepted', mode: request.mode, esp: result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'DECIDE_MODE_REQUEST');
  }
});

app.post('/api/doctor/patients/:id/height', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    const dir = String(req.body.dir || '').toLowerCase();
    if (!['subir','bajar'].includes(dir)) return res.status(400).json({ ok: false, error: 'dir_invalido' });

    const result = await sendCommandToESP({ type: 'height', dir });
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'cambio_altura',
                     descripcion: `Doctor movió altura: ${dir}`, metadata: { dir, esp_sent: result.sent } });
    io.emit('lamp:command', { type: 'height', dir, paciente_id: patientId });
    res.json({ ok: true, dir, esp: result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ===================== ALARMAS ========================

app.get('/api/patients/:id/alarms', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT a.*, s.fecha AS sesion_fecha FROM alarmas a
       LEFT JOIN sesiones s ON s.id = a.sesion_id
       WHERE a.paciente_id = ? ORDER BY a.created_at DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, alarms: rows });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/api/alarms/:id/mute', async (req, res) => {
  try {
    const alarmId   = Number(req.params.id);
    const cuenta_id = getDoctorIdFromReq(req) || getTutorIdFromReq(req);
    const until     = req.body.until ? new Date(req.body.until) : new Date(Date.now() + 300_000);

    await pool.execute(
      `UPDATE alarmas SET silenciada = TRUE, silenciada_por = ?, silenciada_hasta = ? WHERE id = ?`,
      [cuenta_id || null, until, alarmId]
    );
    const [rows] = await pool.execute(`SELECT paciente_id, sesion_id FROM alarmas WHERE id = ?`, [alarmId]);
    if (rows[0]) {
      await logEvent({ paciente_id: rows[0].paciente_id, sesion_id: rows[0].sesion_id,
                       cuenta_id, tipo: 'silencio_alarmas', metadata: { alarm_id: alarmId, until } });
    }
    io.emit('alarm:muted', { alarm_id: alarmId, until });
    res.json({ ok: true, silenciada_hasta: until });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// ===================== EVENTOS ========================

app.get('/api/patients/:id/events', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.tipo, e.descripcion, e.metadata, e.created_at,
              c.nombre AS actor, c.rol AS actor_rol
       FROM eventos e
       LEFT JOIN ${ACCOUNT_TABLE} c ON c.id = e.cuenta_id
       WHERE e.paciente_id = ? ORDER BY e.created_at DESC LIMIT 200`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, events: rows });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/api/eventos', async (req, res) => {
  try {
    const { paciente_id, sesion_id, cuenta_id, tipo, descripcion, metadata } = req.body;
    if (!tipo) return res.status(400).json({ ok: false, error: 'falta_tipo' });
    await logEvent({ paciente_id, sesion_id, cuenta_id, tipo, descripcion, metadata });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// ===================== ALERTAS DEL DÍA ========================

app.get('/api/doctor/alerts/today', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM alarmas a
       JOIN sesiones s ON s.id = a.sesion_id
       JOIN pacientes p ON p.id = s.paciente_id
       WHERE p.doctor_id = ? AND DATE(a.created_at) = CURDATE()`,
      [doctorId]
    );
    res.json({ ok: true, count: Number(rows[0]?.count || 0) });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// ===================== EXPORTACIÓN EXCEL ========================

app.get('/api/export/:pacienteId', async (req, res) => {
  try {
    const pacienteId = Number(req.params.pacienteId);
    if (!pacienteId) return res.status(400).json({ error: 'falta_pacienteId' });

    const plantillaPath = path.join(__dirname, 'excel', 'Plantilla_Fototerapia_Neonatal.xlsx');
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.readFile(plantillaPath); }
    catch { return res.status(500).json({ error: 'plantilla_no_encontrada', path: plantillaPath }); }

    const [pRows] = await pool.execute(
      `SELECT p.*, d.nombre AS doctor_nombre, d.apellidos AS doctor_apellidos, d.especialidad
       FROM pacientes p LEFT JOIN ${ACCOUNT_TABLE} d ON d.id = p.doctor_id WHERE p.id = ?`,
      [pacienteId]
    );
    if (!pRows.length) return res.status(404).json({ error: 'paciente_no_encontrado' });
    const p = pRows[0];

    const [sesiones] = await pool.execute(
      `SELECT fecha, hora_inicio, hora_fin, modo_programado, modo_final,
              duracion_s, tiempo_rango_s, intensidad_promedio_pct,
              temp_bebe_promedio_c, temp_amb_promedio_c, observaciones, status
       FROM sesiones WHERE paciente_id = ? ORDER BY fecha, hora_inicio, id`,
      [pacienteId]
    );
    const [alarmas] = await pool.execute(
      `SELECT a.sesion_id, a.tipo, a.severidad, a.valor_medido, a.unidad,
              a.mensaje, a.accion_tomada, a.created_at
       FROM alarmas a JOIN sesiones s ON s.id = a.sesion_id
       WHERE s.paciente_id = ? ORDER BY a.created_at`,
      [pacienteId]
    );
    const [planes] = await pool.execute(
      `SELECT meta_total_s, tiempo_acumulado_s, modo_recomendado,
              horas_por_dia, sesiones_por_dia, duracion_sesion_min,
              estado, fecha_inicio, fecha_fin
       FROM planes_terapia WHERE paciente_id = ? ORDER BY created_at`,
      [pacienteId]
    );

    const toExcelTime = s => { const n = Number(s); return Number.isFinite(n) && n >= 0 ? n / 86400 : null; };

    const hojaPaciente  = workbook.getWorksheet('Hoja de Vida del Paciente');
    const hojaHistorial = workbook.getWorksheet('Historial de Terapia');
    const hojaAlarmas   = workbook.getWorksheet('Alarmas y Eventos');

    if (!hojaPaciente || !hojaHistorial || !hojaAlarmas)
      return res.status(500).json({ error: 'plantilla_hojas_incorrectas' });

    const nacStr = p.fecha_nac ? (() => { const d = new Date(p.fecha_nac); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })() : '';
    hojaPaciente.getCell('D13').value = p.codigo || p.id;
    hojaPaciente.getCell('D14').value = `${p.nombre} ${p.apellidos}`.trim();
    hojaPaciente.getCell('D15').value = nacStr;
    hojaPaciente.getCell('D16').value = p.fecha_nac ? daysBetween(p.fecha_nac) : '';
    hojaPaciente.getCell('D17').value = `${p.doctor_nombre || ''} ${p.doctor_apellidos || ''}`.trim();
    hojaPaciente.getCell('D18').value = p.especialidad || '';
    hojaPaciente.getCell('D19').value = p.diagnostico  || '';
    hojaPaciente.getCell('D20').value = p.nivel_bilirrubina_actual || '';

    const planActivo = planes.find(pl => pl.estado === 'activo') || planes.at(-1);
    if (planActivo) {
      hojaPaciente.getCell('D21').value = +(planActivo.meta_total_s / 3600).toFixed(2);
      hojaPaciente.getCell('D22').value = +(planActivo.tiempo_acumulado_s / 3600).toFixed(2);
      hojaPaciente.getCell('D23').value = planActivo.horas_por_dia || '';
      hojaPaciente.getCell('D24').value = planActivo.sesiones_por_dia || '';
    }

    hojaHistorial.getColumn('F').numFmt = 'hh:mm:ss';
    hojaHistorial.getColumn('G').numFmt = 'hh:mm:ss';
    sesiones.forEach((s, i) => {
      const row = hojaHistorial.getRow(7 + i);
      row.getCell('B').value = s.fecha || '';
      row.getCell('C').value = s.hora_inicio || '';
      row.getCell('D').value = s.hora_fin    || '';
      row.getCell('E').value = s.modo_final  || s.modo_programado || '';
      row.getCell('F').value = toExcelTime(s.duracion_s);
      row.getCell('G').value = toExcelTime(s.tiempo_rango_s);
      row.getCell('H').value = s.intensidad_promedio_pct ?? null;
      row.getCell('I').value = s.temp_bebe_promedio_c    ?? null;
      row.getCell('J').value = s.temp_amb_promedio_c     ?? null;
      row.getCell('K').value = s.observaciones           || '';
    });

    hojaAlarmas.getColumn('G').numFmt = 'hh:mm:ss';
    alarmas.forEach((a, i) => {
      const row = hojaAlarmas.getRow(7 + i);
      const ts = new Date(a.created_at);
      row.getCell('B').value = ts.toISOString().slice(0,10);
      row.getCell('C').value = ts.toTimeString().slice(0,8);
      row.getCell('D').value = a.sesion_id    || '';
      row.getCell('E').value = a.tipo         || '';
      row.getCell('F').value = `${a.valor_medido || ''} ${a.unidad || ''}`.trim();
      row.getCell('G').value = a.severidad    || '';
      row.getCell('H').value = a.accion_tomada|| '';
    });

    const permitidas = new Set(['Hoja de Vida del Paciente','Historial de Terapia','Alarmas y Eventos']);
    workbook.worksheets.slice().forEach(ws => { if (!permitidas.has(ws.name)) workbook.removeWorksheet(ws.id); });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_${p.codigo || p.id}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { console.error('EXPORT_ERROR', e); res.status(500).json({ error: 'error_exportando' }); }
});

// ===================== SOCKET.IO ========================

const onlinePatients = new Map();

function notifyOnline(pid, isOnline) {
  io.emit(isOnline ? 'patient:online' : 'patient:offline', { id: String(pid) });
}

io.on('connection', socket => {
  if (lastTelemetry) socket.emit('telemetry', {
    cm: lastTelemetry.cm, distance: lastTelemetry.cm, distance_cm: lastTelemetry.cm,
    pct: lastTelemetry.pct, illumination: lastTelemetry.pct, illumination_pct: lastTelemetry.pct,
    pwm: lastTelemetry.pwm, modo_actual: lastTelemetry.modo,
    temp_bebe: lastTemps?.bebe ?? null, temp_ambiente: lastTemps?.ambiente ?? null,
    estado: lastStatus?.estado ?? null, alarms_muted: lastTelemetry.alarms_muted,
  });
  if (lastTemps)  socket.emit('temps', { bebe: lastTemps.bebe, ambiente: lastTemps.ambiente, failBody: lastTemps.failBody, failAmb: lastTemps.failAmb });
  if (lastStatus) socket.emit('status', lastStatus);
  socket.emit('lamp:port', { open: espOnline, path: 'WiFi', baudRate: null });
  for (const [pid] of onlinePatients) socket.emit('patient:online', { id: pid });

  socket.on('patient:identify', payload => {
    const pid = String(payload?.id || '');
    if (!pid) return;
    socket.data.patientId = pid;
    if (!onlinePatients.has(pid)) onlinePatients.set(pid, new Set());
    onlinePatients.get(pid).add(socket.id);
    if (onlinePatients.get(pid).size === 1) notifyOnline(pid, true);
  });

  socket.on('alarms:mute', payload => {
    const muted = !!(payload?.mute);
    if (lastTelemetry) lastTelemetry.alarms_muted = muted;
    io.emit('telemetry', {
      cm: lastTelemetry?.cm ?? null, distance: lastTelemetry?.cm ?? null,
      distance_cm: lastTelemetry?.cm ?? null,
      pct: lastTelemetry?.pct ?? null, illumination: lastTelemetry?.pct ?? null,
      illumination_pct: lastTelemetry?.pct ?? null, pwm: lastTelemetry?.pwm ?? null,
      modo_actual: lastTelemetry?.modo ?? null,
      temp_bebe: lastTemps?.bebe ?? null, temp_ambiente: lastTemps?.ambiente ?? null,
      estado: lastStatus?.estado ?? null, alarms_muted: muted,
    });
  });

  socket.on('lamp:mode', async payload => {
    const mode = normalizeMode(payload?.mode);
    if (!mode) return;
    await sendCommandToESP({ type: 'mode', mode: mode.toUpperCase() });
    currentLampMode = mode;
    io.emit('lamp:command', { type: 'mode', mode });
    io.emit('control:updated', { modo_actual: currentLampMode });
  });

  socket.on('lamp:move', async payload => {
    const dir = String(payload?.dir || '').toLowerCase();
    if (!['subir','bajar'].includes(dir)) return;
    await sendCommandToESP({ type: 'height', dir });
    io.emit('lamp:command', { type: 'height', dir });
  });

  socket.on('disconnect', () => {
    const pid = socket.data.patientId;
    if (!pid) return;
    const sockets = onlinePatients.get(pid);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) { onlinePatients.delete(pid); notifyOnline(pid, false); }
    }
  });
});

// ===================== INICIO ========================

initDB()
  .then(() => {
    server.listen(CONFIG.PORT, '0.0.0.0', () => {
      const ip = getLocalIp() || 'localhost';
      console.log('======================================================');
      console.log(`  NEOLIGHT Server v3.2`);
      console.log(`  Local:   http://localhost:${CONFIG.PORT}`);
      console.log(`  Red:     http://${ip}:${CONFIG.PORT}`);
      console.log(`  ESP32:   POST http://${ip}:${CONFIG.PORT}/api/esp32-data`);
      console.log('======================================================');
    });
  })
  .catch(err => { console.error('[FATAL] Error inicializando DB:', err); process.exit(1); });