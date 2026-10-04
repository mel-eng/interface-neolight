// =========================================================
// server/server.js — NEOLIGHT API v4.0
// Fixes v3.2:
//   [1] ENUMs de eventos corregidos (solicitud_modo_aprobada/rechazada)
//   [2] control_autorizaciones limpiado al rechazar solicitud
//   [3] plan de terapia ahora incluye horas_por_dia y sesiones configurables
//   [4] tiempo_acumulado se actualiza por horas reales (sessions.duracion_s)
//   [5] logEvent tipo 'solicitud_modo_rechazada' → 'solicitud_rechazada'
//   [6] logEvent tipo 'solicitud_modo_aprobada' → 'solicitud_aceptada'
//   [7] endpoint GET /api/doctor/patients/:id/plan-history añadido
//   [8] alarmas y eventos siempre se registran aunque sesión sea nula
//   [9] alarmas activas se resuelven al corregirse y se reinician al iniciar sesión
//   [10] modo recomendado del plan se aplica sin solicitud médica extra
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
import fs              from 'fs';
import crypto          from 'crypto';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import ExcelJS         from 'exceljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

// Zona horaria del sistema. En la nube el servidor corre en UTC; sin esto las
// horas de las sesiones saldrían 4 horas adelantadas respecto a Bolivia.
if (!process.env.TZ) process.env.TZ = 'America/La_Paz';

// Lee la conexión MySQL desde cualquiera de estas fuentes, en este orden:
//   1) MYSQL_URL / DATABASE_URL  (Railway y otros hostings)
//   2) MYSQLHOST, MYSQLUSER...    (variables que crea el servicio MySQL de Railway)
//   3) DB_HOST, DB_USER...        (archivo .env local, como siempre)
function readDbConfig(env) {
  const url = env.MYSQL_URL || env.DATABASE_URL || '';
  if (/^mysql:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username || 'root'),
        pass: decodeURIComponent(u.password || ''),
        name: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'lampara',
      };
    } catch { console.warn('[CONFIG] MYSQL_URL no es válida; se usan las variables sueltas.'); }
  }
  return {
    host: env.MYSQLHOST     || env.DB_HOST || '127.0.0.1',
    port: Number(env.MYSQLPORT || env.DB_PORT || 3306),
    user: env.MYSQLUSER     || env.DB_USER || 'root',
    pass: env.MYSQLPASSWORD ?? env.DB_PASS ?? '',
    name: env.MYSQLDATABASE || env.DB_NAME || 'lampara',
  };
}

const DB = readDbConfig(process.env);

const CONFIG = {
  PORT:             Number(process.env.PORT || 3000),
  DB_HOST:          DB.host,
  DB_USER:          DB.user,
  DB_PASS:          DB.pass,
  DB_NAME:          DB.name,
  DB_PORT:          DB.port,
  HOSPITAL_CODE:    process.env.HOSPITAL_CODE    || '152436',
  ESP32_MASTER_URL: process.env.ESP32_MASTER_URL || null,
  CAMERA_STREAM_URL: process.env.CAMERA_STREAM_URL || process.env.CAM_STREAM_URL || 'http://192.168.4.50/stream',
  // Clave que el equipo envía en la cabecera x-device-key. Obligatoria en la nube.
  DEVICE_KEY:       process.env.DEVICE_KEY || '',
  ALARM_COOLDOWN_MS: Number(process.env.ALARM_COOLDOWN_MS || 60_000),
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

function isTherapyMode(mode) {
  return ['convencional', 'intensivo', 'automatico'].includes(normalizeMode(mode));
}

function boolFromEsp(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return null;
  const t = String(v).toLowerCase().trim();
  if (['true','1','on','si','sí'].includes(t)) return true;
  if (['false','0','off','no'].includes(t)) return false;
  return Boolean(v);
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
  'login','logout','sistema','sesion_interrumpida','alarma_registrada',
  'solicitud_modo','solicitud_modo_aprobada','solicitud_modo_rechazada','solicitud_control_manual',
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
app.use(express.json({ limit: '1mb' }));     // la firma del doctor viaja como imagen
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/') && req.path !== '/api/esp32-data')
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===================== SESIONES DE ACCESO ========================
//
// Al iniciar sesión el servidor entrega un token. El navegador lo envía en cada
// petición (cabecera Authorization) y el servidor deduce de ahí quién es la
// persona y qué rol tiene. Ya no se confía en un número de usuario enviado por
// el navegador.

const TOKEN_DAYS = 7;
const tokenCache = new Map();          // hash → { auth, until }
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createLoginToken(cuenta) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.execute(
    `INSERT INTO sesiones_login (token_hash, cuenta_id, rol, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ${TOKEN_DAYS} DAY))`,
    [hashToken(token), cuenta.id, cuenta.rol]
  );
  pool.execute(`DELETE FROM sesiones_login WHERE expires_at < NOW()`).catch(() => {});
  return token;
}

async function resolveToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const hash = hashToken(token);
  const cached = tokenCache.get(hash);
  if (cached && cached.until > Date.now()) return cached.auth;
  const [rows] = await pool.execute(
    `SELECT s.cuenta_id, c.rol, c.estado
     FROM sesiones_login s JOIN ${ACCOUNT_TABLE} c ON c.id = s.cuenta_id
     WHERE s.token_hash = ? AND s.expires_at > NOW() LIMIT 1`, [hash]
  );
  if (!rows.length || rows[0].estado !== 'activo') { tokenCache.delete(hash); return null; }
  const auth = { id: Number(rows[0].cuenta_id), rol: rows[0].rol };
  tokenCache.set(hash, { auth, until: Date.now() + 60_000 });
  return auth;
}

async function canAccessPatient(auth, patientId) {
  const id = Number(patientId);
  if (!id) return false;
  if (auth.rol === 'admin') return true;
  const [rows] = await pool.execute(`SELECT doctor_id, tutor_id FROM pacientes WHERE id = ? LIMIT 1`, [id]);
  if (!rows.length) return auth.rol === 'doctor';      // que la ruta responda "no encontrado"
  return auth.rol === 'doctor' ? Number(rows[0].doctor_id) === auth.id
                               : Number(rows[0].tutor_id) === auth.id;
}

// Rutas que no necesitan sesión.
const PUBLIC_API = new Set([
  'POST /api/login', 'POST /api/register', 'POST /api/register-doctor',
  'POST /api/doctor/verify-code', 'GET /api/doctors', 'GET /api/health', 'GET /api/client-config',
  'POST /api/esp32-data', 'POST /api/esp32/telemetry',          // el equipo usa su propia clave
]);

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.has(`${req.method} ${req.path}`)) return next();
  try {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const auth = await resolveToken(bearer || String(req.query.t || ''));
    if (!auth) return res.status(401).json({ ok: false, error: 'sesion_requerida', message: 'Tu sesión venció. Inicia sesión nuevamente.' });
    req.auth = auth;

    // La identidad sale del token. Se descarta lo que el navegador haya querido declarar.
    for (const h of ['x-doctor-id', 'x-tutor-id', 'x-superuser-id']) delete req.headers[h];
    for (const q of ['doctor_id', 'tutor_id', 'superuser_id']) delete req.query[q];
    if (auth.rol === 'doctor') req.headers['x-doctor-id'] = String(auth.id);
    if (auth.rol === 'tutor')  req.headers['x-tutor-id'] = String(auth.id);
    if (auth.rol === 'admin')  req.headers['x-superuser-id'] = String(auth.id);

    const deny = () => res.status(403).json({ ok: false, error: 'no_autorizado', message: 'Tu cuenta no tiene acceso a esto.' });
    if (req.path.startsWith('/api/superuser/') && auth.rol !== 'admin') return deny();
    if (req.path.startsWith('/api/doctor/') && auth.rol !== 'doctor') return deny();

    // Rutas que tocan a un paciente: solo su tutor, su doctor o el superusuario.
    let patientId = null, m;
    if ((m = req.path.match(/^\/api\/(?:doctor\/)?patients?\/(\d+)/))) patientId = m[1];
    else if ((m = req.path.match(/^\/api\/export\/(\d+)/))) patientId = m[1];
    else if (['/api/sessions/start', '/api/eventos'].includes(req.path)) patientId = req.body?.paciente_id ?? null;
    else if ((m = req.path.match(/^\/api\/sessions\/(\d+)/))) {
      const [rows] = await pool.execute(`SELECT paciente_id FROM sesiones WHERE id = ? LIMIT 1`, [Number(m[1])]);
      patientId = rows[0]?.paciente_id ?? null;
      if (!patientId) return res.status(404).json({ ok: false, error: 'sesion_no_encontrada' });
    } else if ((m = req.path.match(/^\/api\/alarms\/(\d+)/))) {
      const [rows] = await pool.execute(`SELECT paciente_id FROM alarmas WHERE id = ? LIMIT 1`, [Number(m[1])]);
      patientId = rows[0]?.paciente_id ?? null;
      if (!patientId) return res.status(404).json({ ok: false, error: 'alarma_no_encontrada' });
    }
    if (patientId != null && !(await canAccessPatient(auth, patientId))) return deny();
    next();
  } catch (e) { return sendServerError(res, e, 'AUTH_MIDDLEWARE'); }
});

// ===================== DB POOL ========================

let pool;

// Diferencia horaria de Node (+HH:MM) para que MySQL use la misma hora en NOW().
function nodeUtcOffset() {
  const min = -new Date().getTimezoneOffset();
  const abs = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2,'0')}:${String(abs % 60).padStart(2,'0')}`;
}

async function initDB() {
  const { DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT } = CONFIG;
  const tz = nodeUtcOffset();
  const root = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASS, port: DB_PORT, multipleStatements: true
  });
  try {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } catch (e) {
    // En hostings la base ya existe y el usuario puede no tener permiso de crearla.
    console.warn('[DB] No se pudo crear la base (se asume que ya existe):', e.code || e.message);
  }
  await root.query(`USE \`${DB_NAME}\``);
  await root.query(`SET time_zone = '${tz}'`);
  await ensureBaseSchema(root);
  await root.end();

  pool = mysql.createPool({
    host: DB_HOST, user: DB_USER, password: DB_PASS,
    database: DB_NAME, port: DB_PORT,
    waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4',
  });
  // Cada conexión nueva usa la misma hora que Node.
  pool.on('connection', conn => conn.query(`SET time_zone = '${tz}'`));
  await pool.query('SELECT 1');
  await ensureSchemaCompatibility();
  console.log(`[DB] Conectado a "${DB_NAME}" en ${DB_HOST}:${DB_PORT} (hora ${tz})`);
}

// Crea las tablas que falten a partir de sql/schema.sql.
// Solo usa CREATE TABLE IF NOT EXISTS: nunca borra ni modifica datos existentes.
async function ensureBaseSchema(conn) {
  const file = path.join(__dirname, 'sql', 'schema.sql');
  if (!fs.existsSync(file)) { console.warn('[DB] Falta sql/schema.sql; no se verificaron las tablas.'); return; }
  const sql = fs.readFileSync(file, 'utf8');
  if (/\bDROP\s+(TABLE|DATABASE)\b/i.test(sql)) {
    throw new Error('sql/schema.sql contiene DROP: no se ejecuta para proteger los datos.');
  }
  const [before] = await conn.query('SHOW TABLES');
  await conn.query(sql);
  const [after] = await conn.query('SHOW TABLES');
  const created = after.length - before.length;
  if (created > 0) console.log(`[DB] Esquema: ${created} tabla(s) creada(s).`);
}

async function ensureSchemaCompatibility() {
  // Migraciones pequeñas y seguras para que el server no choque con esquemas viejos.
  // Sí, MySQL también necesita niñera, aparentemente.
  const safe = async (sql) => {
    try { await pool.query(sql); }
    catch (e) {
      // Columna o índice que ya existe: es lo esperado en una base al día.
      if (['ER_DUP_FIELDNAME','ER_DUP_KEYNAME'].includes(e.code)) return;
      console.warn('[DB-MIGRATION]', e.code || e.message);
    }
  };

  await safe(`ALTER TABLE planes_terapia ADD COLUMN horas_por_dia DECIMAL(5,2) NULL AFTER modo_recomendado`);
  await safe(`ALTER TABLE planes_terapia ADD COLUMN sesiones_por_dia INT NULL AFTER horas_por_dia`);
  await safe(`ALTER TABLE planes_terapia ADD COLUMN duracion_sesion_min INT NULL AFTER sesiones_por_dia`);

  // Las alarmas críticas deben poder guardarse aunque todavía no exista una sesión activa.
  await safe(`ALTER TABLE alarmas MODIFY COLUMN sesion_id INT NULL`);
  await safe(`ALTER TABLE alarmas ADD COLUMN silenciada BOOLEAN NOT NULL DEFAULT FALSE`);
  await safe(`ALTER TABLE alarmas ADD COLUMN silenciada_por INT NULL`);
  await safe(`ALTER TABLE alarmas ADD COLUMN silenciada_hasta DATETIME NULL`);
  await safe(`ALTER TABLE alarmas ADD INDEX ix_paciente_created_at (paciente_id, created_at)`);
  await safe(`ALTER TABLE alarmas ADD INDEX ix_alarmas_activas (paciente_id, silenciada, tipo)`);

  // Firma del doctor para los reportes.
  await safe(`ALTER TABLE cuentas ADD COLUMN firma_png MEDIUMTEXT NULL COMMENT 'Firma dibujada (PNG en base64)'`);

  // El sistema parte con una lámpara registrada.
  const [[eq]] = await pool.query(`SELECT COUNT(*) AS n FROM equipos`);
  if (!Number(eq.n)) {
    await pool.query(
      `INSERT INTO equipos (codigo, descripcion, ubicacion, estado, notas)
       VALUES ('NEOLIGHT-01', 'Prototipo principal de fototerapia neonatal', 'Laboratorio de pruebas', 'operativo', 'Equipo principal')`
    );
  }
  const [[first]] = await pool.query(`SELECT paciente_actual_id FROM equipos ORDER BY id ASC LIMIT 1`);
  activePatientId = first?.paciente_actual_id ? Number(first.paciente_actual_id) : null;
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

const AUTO_ALARM_TYPES = [
  'sensor_ultrasonico', 'sensor_temperatura',
  'distancia_baja', 'distancia_alta',
  'temperatura_baja', 'temperatura_alta'
];

async function resetActiveAlarmsForNewSession(paciente_id, conn = null) {
  if (!paciente_id) return;
  const db = conn || pool;
  await db.execute(
    `UPDATE alarmas
     SET silenciada = TRUE, silenciada_hasta = COALESCE(silenciada_hasta, NOW())
     WHERE paciente_id = ? AND silenciada = FALSE`,
    [paciente_id]
  );
  alarmCooldown.clear();
}

async function syncResolvedAutoAlarms(paciente_id, activeTypes = []) {
  if (!paciente_id) return;
  const types = [...new Set((activeTypes || []).filter(Boolean))];
  const autoPlaceholders = AUTO_ALARM_TYPES.map(() => '?').join(',');

  if (!types.length) {
    await pool.execute(
      `UPDATE alarmas
       SET silenciada = TRUE, silenciada_hasta = COALESCE(silenciada_hasta, NOW())
       WHERE paciente_id = ? AND silenciada = FALSE AND tipo IN (${autoPlaceholders})`,
      [paciente_id, ...AUTO_ALARM_TYPES]
    );
    return;
  }

  const activePlaceholders = types.map(() => '?').join(',');
  await pool.execute(
    `UPDATE alarmas
     SET silenciada = TRUE, silenciada_hasta = COALESCE(silenciada_hasta, NOW())
     WHERE paciente_id = ? AND silenciada = FALSE
       AND tipo IN (${autoPlaceholders})
       AND tipo NOT IN (${activePlaceholders})`,
    [paciente_id, ...AUTO_ALARM_TYPES, ...types]
  );
}

async function hasActiveAlarm(paciente_id, tipo) {
  const [rows] = await pool.execute(
    `SELECT id FROM alarmas WHERE paciente_id = ? AND tipo = ? AND silenciada = FALSE LIMIT 1`,
    [paciente_id, tipo]
  );
  return rows.length > 0;
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

// ===================== COMANDOS HACIA LA LÁMPARA ========================
//
// Hay dos formas de llegar al ESP32 maestro:
//
//  A) MODO LOCAL  (ESP32_MASTER_URL definido): la computadora está en la red
//     NEOLIGHT y el servidor le habla directo al maestro por HTTP.
//
//  B) MODO NUBE   (sin ESP32_MASTER_URL): el servidor no puede alcanzar al
//     maestro. El maestro es quien llama: envía su telemetría a
//     POST /api/esp32-data y en la respuesta recibe los comandos pendientes
//     en el campo "cmd", separados por punto y coma. Ejemplo:
//         {"ok":true,"cmd":"MODO=CONVENCIONAL;MOVER=STOP"}
//
// Comandos posibles:
//     MODO=REPOSO | MODO=CONVENCIONAL | MODO=INTENSIVO
//     MOVER=SUBIR | BAJAR | IZQ | DER | STOP
//     LOCK                 bloquea el control manual
//     MUTE=<segundos>      silencia el buzzer (0 lo reactiva)
//     BEEP                 hace sonar el buzzer una vez (prueba técnica)

const commandQueue = [];                 // [{ text, ts }]
const CMD_TTL_MS      = 8_000;           // un comando viejo es peligroso: se descarta
const CMD_TTL_STOP_MS = 30_000;          // el STOP y el LOCK se conservan más tiempo

function commandToText(command = {}) {
  const type = String(command.type || '').toLowerCase();

  if (type === 'mode') {
    const mode = normalizeMode(command.mode);
    if (!mode || mode === 'automatico') return null;   // el equipo regula la distancia solo en ambos modos
    return `MODO=${mode.toUpperCase()}`;
  }
  if (type === 'height' || type === 'move') {
    const raw = String(command.dir || command.direction || '').toLowerCase().trim();
    const map = {
      subir: 'SUBIR', up: 'SUBIR', u: 'SUBIR',
      bajar: 'BAJAR', down: 'BAJAR', d: 'BAJAR',
      izq: 'IZQ', izquierda: 'IZQ', left: 'IZQ', l: 'IZQ',
      der: 'DER', derecha: 'DER', right: 'DER', r: 'DER',
      stop: 'STOP', s: 'STOP'
    };
    return map[raw] ? `MOVER=${map[raw]}` : null;
  }
  if (type === 'lock') return 'LOCK';
  if (type === 'beep') return 'BEEP';
  if (type === 'mute') return `MUTE=${Math.max(0, Math.round(Number(command.seconds) || 0))}`;
  return null;
}

// Traduce el comando a la ruta HTTP del maestro (modo local).
function commandToLocalPath(text) {
  const [name, value = ''] = text.split('=');
  if (name === 'MODO')  return `/modo?m=${encodeURIComponent(value)}`;
  if (name === 'MOVER') return `/mover?dir=${encodeURIComponent(value)}`;
  if (name === 'LOCK')  return `/lock`;
  if (name === 'BEEP')  return `/beep`;
  if (name === 'MUTE')  return `/mute?s=${encodeURIComponent(value)}`;
  return null;
}

function requestEsp32(pathname, { method = 'GET', timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const base = String(CONFIG.ESP32_MASTER_URL || '').replace(/\/$/, '');
    const url = `${base}${pathname}`;
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, timeout }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function takePendingCommands() {
  const now = Date.now();
  const fresh = commandQueue.filter(c => now - c.ts <= (/(STOP|LOCK)$/.test(c.text) || c.text === 'LOCK' ? CMD_TTL_STOP_MS : CMD_TTL_MS));
  commandQueue.length = 0;
  return fresh.map(c => c.text);
}

/**
 * Envía un comando a la lámpara.
 * Devuelve { sent, reason?, queued? }. `sent:false` siempre trae el motivo
 * para que la interfaz pueda explicarlo en vez de fallar en silencio.
 */
async function sendCommandToESP(command) {
  const text = commandToText(command);
  if (!text) return { sent: false, reason: 'comando_no_compatible' };

  if (CONFIG.ESP32_MASTER_URL) {
    const pathname = commandToLocalPath(text);
    try {
      const result = await requestEsp32(pathname, { timeout: 3000 });
      if (result.statusCode === 403) return { sent: false, reason: 'requiere_clave_fisica', response: result.data };
      if (result.statusCode === 409) return { sent: false, reason: 'limite_de_seguridad', response: result.data };
      if (result.statusCode === 404) return { sent: false, reason: 'equipo_sin_esa_funcion' };
      if (result.statusCode < 200 || result.statusCode >= 300)
        return { sent: false, reason: `equipo_respondio_${result.statusCode}`, response: result.data };
      return { sent: true, response: result.data };
    } catch (e) {
      return { sent: false, reason: 'lampara_sin_conexion', detail: e.message };
    }
  }

  if (!espOnline) return { sent: false, reason: 'lampara_sin_conexion' };
  // Un STOP anula cualquier movimiento que todavía no salió.
  if (text === 'MOVER=STOP') {
    for (let i = commandQueue.length - 1; i >= 0; i--)
      if (commandQueue[i].text.startsWith('MOVER=')) commandQueue.splice(i, 1);
  }
  if (commandQueue.at(-1)?.text !== text) commandQueue.push({ text, ts: Date.now() });
  return { sent: true, queued: true };
}

// ===================== TELEMETRÍA ESP32 ========================

let lastTelemetry = null;      // última lectura completa, sin ocultar nada
let lastStatus    = null;
let espOnline     = false;
let lastEspTs     = 0;
let offlineSince  = 0;
let currentLampMode = 'reposo';
let activePatientId = null;    // paciente que está usando la lámpara (tabla equipos)
let inactiveSince   = 0;       // desde cuándo la lámpara no está dando terapia
const alarmCooldown = new Map();

const SESSION_IDLE_FINISH_MS    = Number(process.env.SESSION_IDLE_FINISH_S || 30) * 1000;      // sin terapia 30 s → la sesión se cierra sola
const SESSION_OFFLINE_FINISH_MS = Number(process.env.SESSION_OFFLINE_FINISH_S || 60) * 1000;   // sin conexión 60 s → se cierra por desconexión

// Ventanas de distancia segura. Deben coincidir con el firmware del maestro.
const DISTANCE_WINDOWS = {
  convencional: { min: 28, max: 40 },
  intensivo:    { min: 11, max: 25 },
};
const windowFor = mode => DISTANCE_WINDOWS[normalizeMode(mode)] || null;

async function setActivePatient(paciente_id) {
  const id = Number(paciente_id) || null;
  if (!id || id === activePatientId) return;
  activePatientId = id;
  await pool.execute(`UPDATE equipos SET paciente_actual_id = ? ORDER BY id ASC LIMIT 1`, [id]).catch(() => {});
}

async function resolveTelemetryPatientId(explicitId = null) {
  if (explicitId) return Number(explicitId);
  if (activePatientId) return activePatientId;

  // Sin paciente asignado todavía: si hay una sesión abierta, es de ese paciente.
  try {
    const [rows] = await pool.execute(
      `SELECT paciente_id FROM sesiones WHERE status IN ('active','paused') ORDER BY created_at DESC LIMIT 1`
    );
    if (rows.length) return Number(rows[0].paciente_id);
  } catch {}

  // Si el sistema tiene un único paciente activo, no hay ambigüedad.
  try {
    const [rows] = await pool.execute(
      `SELECT id FROM pacientes
       WHERE estado_registro = 'activo' AND doctor_request_status = 'accepted'
       ORDER BY id ASC LIMIT 2`
    );
    if (rows.length === 1) return Number(rows[0].id);
  } catch {}

  return null;
}

async function autoStartSessionForTelemetry(paciente_id, modo = null) {
  const mode = normalizeMode(modo) || currentLampMode || 'reposo';
  if (!paciente_id || !isTherapyMode(mode)) return null;

  const existing = await getActiveSession(paciente_id);
  if (existing) return existing;

  const plan = await getActivePlan(paciente_id).catch(() => null);
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const fecha = `${now.getFullYear()}-${p2(now.getMonth()+1)}-${p2(now.getDate())}`;
  const hora  = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await resetActiveAlarmsForNewSession(paciente_id, conn);
    const [r] = await conn.execute(
      `INSERT INTO sesiones (paciente_id, plan_id, fecha, hora_inicio, started_at, modo_programado, tipo_control, status, observaciones)
       VALUES (?, ?, ?, ?, NOW(), ?, 'automatico', 'active', 'Sesión iniciada al detectar terapia en la lámpara')`,
      [paciente_id, plan?.id || null, fecha, hora, mode]
    );
    await upsertDeviceStatus(paciente_id, true, 'en_sesion', conn);
    await logEvent({ paciente_id, sesion_id: r.insertId, tipo: 'inicio_sesion',
                     descripcion: 'Sesión iniciada al detectar terapia en la lámpara',
                     metadata: { modo: mode, origen: 'telemetria' } }, conn);
    await conn.commit();
    io.emit('session:started', { paciente_id, sesion_id: r.insertId, modo: mode, origen: 'telemetria' });
    return { id: r.insertId, paciente_id, plan_id: plan?.id || null, status: 'active', modo_programado: mode, started_at: now };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function insertAlarmRecord({ sesion_id = null, paciente_id, alarm }) {
  if (await hasActiveAlarm(paciente_id, alarm.tipo)) return null;

  const [r] = await pool.execute(
    `INSERT INTO alarmas (sesion_id, paciente_id, tipo, severidad, valor_medido, unidad, mensaje)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sesion_id || null, paciente_id, alarm.tipo, alarm.severidad,
     alarm.valor != null ? String(alarm.valor) : null,
     alarm.unidad ?? null,
     alarm.mensaje || null]
  );
  const [pRows] = await pool.execute(`SELECT doctor_id FROM pacientes WHERE id = ? LIMIT 1`, [paciente_id]);
  const payload = {
    id: r.insertId, sesion_id: sesion_id || null, paciente_id,
    doctor_id: pRows[0]?.doctor_id ?? null,
    tipo: alarm.tipo, severidad: alarm.severidad,
    valor: alarm.valor ?? null, unidad: alarm.unidad ?? null,
    mensaje: alarm.mensaje || null,
    created_at: new Date().toISOString(),
  };
  io.emit('alarm:new', payload);
  return payload;
}

function emitDoctor(_doctorId, event, payload = {}) { io.emit(event, payload); }       // cada cliente filtra por doctor_id
function emitPatient(_pacienteId, _tutorId, event, payload = {}) { io.emit(event, payload); }

async function setEspOnline(paciente_id = null) {
  const wasOnline = espOnline;
  espOnline = true;
  lastEspTs = Date.now();
  offlineSince = 0;
  if (!wasOnline) {
    io.emit('lamp:port', { open: true, path: 'WiFi' });
    await pool.execute(`UPDATE equipos SET last_seen_at = NOW() ORDER BY id ASC LIMIT 1`).catch(() => {});
    if (paciente_id) {
      await upsertDeviceStatus(paciente_id, true, 'online').catch(() => {});
      await logEvent({ paciente_id, tipo: 'conexion_esp', descripcion: 'Lámpara conectada' }).catch(() => {});
    }
  }
}

// Vigilante de conexión: marca la lámpara como desconectada y cierra la sesión abierta.
setInterval(async () => {
  if (!pool) return;
  const now = Date.now();
  if (espOnline && now - lastEspTs > 10_000) {
    espOnline = false;
    offlineSince = now;
    commandQueue.length = 0;
    io.emit('lamp:port', { open: false, path: 'WiFi', error: 'Sin datos de la lámpara' });
    io.emit('telemetry', visibleTelemetry());
    await pool.execute(
      `UPDATE estado_dispositivo SET esp_online = FALSE, estado = 'offline'
       WHERE estado IN ('online','en_sesion') AND esp_online = TRUE`
    ).catch(() => {});
    if (activePatientId)
      await logEvent({ paciente_id: activePatientId, tipo: 'desconexion_esp', descripcion: 'La lámpara dejó de enviar datos' }).catch(() => {});
  }
  if (!espOnline && offlineSince && now - offlineSince > SESSION_OFFLINE_FINISH_MS) {
    offlineSince = 0;
    await finishOpenSessions('desconexion').catch(e => console.warn('[SESION] cierre por desconexión:', e.message));
  }
}, 5000);

async function finishOpenSessions(motivo) {
  const [rows] = await pool.execute(`SELECT id FROM sesiones WHERE status IN ('active','paused')`);
  for (const row of rows) await finalizeSession(row.id, { motivo }).catch(e => console.warn('[SESION]', e.message));
}

function parseTelemetryPayload(body) {
  let cm = toNum(body.distance_cm ?? body.cm ?? body.dist_cm ?? body.distancia);
  // El maestro envía -1 cuando el ultrasonido no responde: eso es una falla, no una distancia.
  const ultraNoEcho = cm != null && cm <= 0;
  if (ultraNoEcho) cm = null;

  const tBebe = toNum(body.temp_body_c ?? body.tempBody ?? body.temp_bebe ?? body.bebe ?? body.t_body);
  const tAmb  = toNum(body.temp_amb_c ?? body.tempAmb ?? body.temp_ambiente ?? body.ambient_c ?? body.t_amb);
  const pct   = toNum(body.illumination_pct ?? body.ldr ?? body.ldr_pct);        // luz medida por los LDR
  const pwm   = toNum(body.pwm ?? body.pwm_led ?? body.intensidad_led_pct);      // intensidad ordenada a los LED
  const peso  = toNum(body.peso_g ?? body.peso);

  return {
    cm, tBebe, tAmb, pct, pwm, peso,
    modo:    normalizeMode(body.mode ?? body.modo ?? body.modo_actual ?? body.estado),
    pausado: boolFromEsp(body.pausado) === true,
    manual:  boolFromEsp(body.manual ?? body.manualHabilitado) === true,
    slave:   body.slave != null ? boolFromEsp(body.slave) === true : null,
    sensor_ultra_fail: ultraNoEcho || Boolean(body.sensor_ultra_fail),
    sensor_body_fail:  Boolean(body.sensor_body_fail),
    sensor_amb_fail:   Boolean(body.sensor_amb_fail),
    alarms_muted: body.alarms_muted != null ? boolFromEsp(body.alarms_muted) === true : null,
    paciente_id:  toNum(body.paciente_id) || null,
  };
}

function evaluateStatusAndAlarms({ cm, tBebe, modo, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail }) {
  const alarms = [];
  let estado = 'ok';
  const win = windowFor(modo);

  if (sensor_ultra_fail) {
    alarms.push({ tipo: 'sensor_ultrasonico', severidad: 'critical', mensaje: 'El sensor de distancia no responde' });
    estado = 'alarma_sensor';
  } else if (win && cm != null) {
    if (cm < win.min) {
      alarms.push({ tipo: 'distancia_baja', severidad: 'critical', valor: cm, unidad: 'cm',
                    mensaje: `Lámpara demasiado cerca: ${cm} cm (mínimo ${win.min} cm)` });
      estado = 'peligro_distancia';
    } else if (cm > win.max) {
      alarms.push({ tipo: 'distancia_alta', severidad: 'warning', valor: cm, unidad: 'cm',
                    mensaje: `Lámpara demasiado lejos: ${cm} cm (máximo ${win.max} cm)` });
      estado = 'distancia_alta';
    }
  }
  if (sensor_body_fail || sensor_amb_fail) {
    alarms.push({ tipo: 'sensor_temperatura', severidad: 'critical', mensaje: 'Un sensor de temperatura no responde' });
    estado = 'alarma_sensor';
  }
  if (tBebe != null) {
    if (tBebe < 34.8) { alarms.push({ tipo: 'temperatura_baja', severidad: 'warning', valor: tBebe, unidad: '°C', mensaje: `Temperatura del bebé baja: ${tBebe} °C` }); if (estado === 'ok') estado = 'frio'; }
    if (tBebe > 38.0) { alarms.push({ tipo: 'temperatura_alta', severidad: 'warning', valor: tBebe, unidad: '°C', mensaje: `Temperatura del bebé alta: ${tBebe} °C` }); if (estado === 'ok') estado = 'caliente'; }
  }
  return { estado, alarms };
}

/**
 * Lo que ve la interfaz. Fuera de terapia las lecturas se ocultan (se muestran
 * guiones), pero el estado de conexión, el modo y el permiso manual siempre viajan.
 */
function visibleTelemetry() {
  const t = lastTelemetry;
  const visible = !!(espOnline && t?.terapiaActiva);
  const win = windowFor(t?.modo);
  return {
    paciente_id: t?.paciente_id ?? activePatientId ?? null,
    cm: visible ? t.cm : null, distance_cm: visible ? t.cm : null,
    pct: visible ? t.pct : null, illumination_pct: visible ? t.pct : null,
    pwm: visible ? t.pwm : null,
    temp_bebe: visible ? t.tBebe : null,
    temp_ambiente: visible ? t.tAmb : null,
    peso_g: espOnline ? (t?.peso ?? null) : null,
    modo_actual: t?.modo || currentLampMode,
    estado: visible ? (lastStatus?.estado ?? 'ok') : 'sin_datos',
    ventana: win, en_ventana: visible && win && t.cm != null ? (t.cm >= win.min && t.cm <= win.max) : null,
    ultraFail: visible ? !!t.sensor_ultra_fail : false,
    pausado: !!t?.pausado,
    manual: espOnline ? !!t?.manual : false,
    slave: espOnline ? (t?.slave ?? null) : null,
    alarms_muted: !!t?.alarms_muted,
    terapiaActiva: visible,
    esp32_connected: espOnline,
  };
}

// ===================== ENDPOINT ESP32 ========================

async function processEsp32Telemetry(body = {}) {
  if (!body || typeof body !== 'object')
    return { status: 400, payload: { ok: false, error: 'body_invalido' } };

  const parsed = parseTelemetryPayload(body);
  const paciente_id = await resolveTelemetryPatientId(parsed.paciente_id);

  await setEspOnline(paciente_id);
  if (parsed.modo) currentLampMode = parsed.modo;

  const modo = parsed.modo || currentLampMode || 'reposo';
  const terapiaActiva = isTherapyMode(modo) && !parsed.pausado;

  lastTelemetry = {
    ...parsed, modo, paciente_id, terapiaActiva,
    tBebe: parsed.tBebe != null ? +parsed.tBebe.toFixed(1) : null,
    tAmb:  parsed.tAmb  != null ? +parsed.tAmb.toFixed(1)  : null,
    alarms_muted: parsed.alarms_muted ?? lastTelemetry?.alarms_muted ?? false,
    ts: Date.now(),
  };

  const { estado, alarms } = evaluateStatusAndAlarms({ ...lastTelemetry });
  lastStatus = { estado: terapiaActiva ? estado : 'sin_datos', esp32_connected: true, terapiaActiva, modo_actual: modo, ts: Date.now() };

  const view = visibleTelemetry();
  io.emit('telemetry', view);
  io.emit('status', { ...lastStatus, temp_bebe: view.temp_bebe, temp_ambiente: view.temp_ambiente, distance_cm: view.cm });

  if (!paciente_id) return { status: 200, payload: { ok: true, terapiaActiva } };

  try {
    await upsertDeviceStatus(paciente_id, true, terapiaActiva ? 'en_sesion' : 'online');

    if (!terapiaActiva) {
      await syncResolvedAutoAlarms(paciente_id, []).catch(e => console.warn('[ALARMAS] sync:', e.message));
      // Si la terapia lleva un rato detenida, la sesión abierta se cierra sola.
      if (!inactiveSince) inactiveSince = Date.now();
      if (Date.now() - inactiveSince > SESSION_IDLE_FINISH_MS) {
        const open = await getActiveSession(paciente_id);
        if (open) await finalizeSession(open.id, { motivo: parsed.pausado ? 'detenida_manual' : 'completada' });
        inactiveSince = Date.now();
      }
      return { status: 200, payload: { ok: true, terapiaActiva: false } };
    }
    inactiveSince = 0;

    await syncResolvedAutoAlarms(paciente_id, alarms.map(a => a.tipo)).catch(e => console.warn('[ALARMAS] sync:', e.message));
    let sesion = await getActiveSession(paciente_id);
    if (!sesion) sesion = await autoStartSessionForTelemetry(paciente_id, modo);

    if (sesion) {
      await pool.execute(
        `INSERT INTO mediciones
           (sesion_id, paciente_id, distance_cm, temp_bebe_c, temp_ambiente_c,
            intensidad_led_pct, ldr_pct, modo_actual, esp_online,
            sensor_ultra_fail, sensor_body_fail, sensor_amb_fail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?)`,
        [sesion.id, paciente_id,
         parsed.cm ?? null, parsed.tBebe ?? null, parsed.tAmb ?? null,
         parsed.pwm ?? null, parsed.pct ?? null, modo,
         parsed.sensor_ultra_fail ? 1 : 0, parsed.sensor_body_fail ? 1 : 0, parsed.sensor_amb_fail ? 1 : 0]
      );

      for (const alarm of alarms) {
        const key = `${paciente_id}:${alarm.tipo}`;
        if (Date.now() - (alarmCooldown.get(key) || 0) >= CONFIG.ALARM_COOLDOWN_MS) {
          alarmCooldown.set(key, Date.now());
          await insertAlarmRecord({ sesion_id: sesion.id, paciente_id, alarm });
        }
      }
    }
  } catch (e) { console.error('[TELEMETRÍA] error de base de datos:', e.message); }

  return { status: 200, payload: { ok: true, terapiaActiva } };
}

// El equipo envía aquí su telemetría. En la nube debe traer la clave del equipo.
app.post(['/api/esp32-data', '/api/esp32/telemetry'], async (req, res) => {
  if (CONFIG.DEVICE_KEY && req.headers['x-device-key'] !== CONFIG.DEVICE_KEY)
    return res.status(401).json({ ok: false, error: 'clave_de_equipo_invalida' });
  const result = await processEsp32Telemetry(req.body);
  res.status(result.status).json({ ...result.payload, cmd: takePendingCommands().join(';') });
});

// Modo local: el servidor consulta al maestro.
async function pollEsp32Telemetry() {
  if (!CONFIG.ESP32_MASTER_URL || !pool) return;
  try {
    const result = await requestEsp32('/data', { timeout: 2500 });
    if (result.statusCode < 200 || result.statusCode >= 300) return;
    await processEsp32Telemetry(JSON.parse(result.data || '{}'));
  } catch (e) { /* el vigilante de conexión marcará la lámpara como desconectada */ }
}
setInterval(pollEsp32Telemetry, 1500);

// ===================== HEALTH + LATEST ========================

app.get('/ping', (_req, res) => res.send('NEOLIGHT v4.0'));
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, espOnline }); }
  catch { res.status(500).json({ ok: false, espOnline }); }
});

/** Configuración pública del navegador. Nunca incluir secretos aquí. */
app.get('/api/client-config', (_req, res) => {
  res.json({ ok: true, camStreamUrl: CONFIG.CAMERA_STREAM_URL });
});

app.get(['/api/telemetry/latest', '/api/esp32/latest'], (req, res) => {
  const payload = { ok: true, espOnline, data: lastTelemetry ? visibleTelemetry() : null };
  // El diagnóstico técnico necesita las lecturas reales aunque la lámpara esté en reposo.
  if (req.auth?.rol === 'admin' && lastTelemetry && espOnline) {
    payload.raw = {
      cm: lastTelemetry.cm, pct: lastTelemetry.pct, pwm: lastTelemetry.pwm,
      temp_bebe: lastTelemetry.tBebe, temp_ambiente: lastTelemetry.tAmb, peso_g: lastTelemetry.peso,
      modo_actual: lastTelemetry.modo, manual: lastTelemetry.manual, slave: lastTelemetry.slave,
      ultraFail: lastTelemetry.sensor_ultra_fail,
    };
  }
  res.json(payload);
});
app.get('/api/status/latest', (_req, res) => res.json({ ok: true, data: lastStatus || null }));

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
    // La firma es obligatoria cuando el doctor se registra solo; el superusuario puede crearlo sin ella.
    const firma = cleanSignature(req.body?.firma);
    const createdByAdmin = (await resolveToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')))?.rol === 'admin';
    if (!createdByAdmin && String(req.body?.codigo || '') !== String(CONFIG.HOSPITAL_CODE))
      return res.status(403).json({ ok: false, error: 'codigo_invalido', message: 'El código de acceso hospitalario no es válido.' });
    if (!firma && !createdByAdmin)
      return res.status(400).json({ ok: false, error: 'falta_firma', message: 'Dibuja tu firma para completar el registro.' });
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
      `INSERT INTO ${ACCOUNT_TABLE} (usuario, contrasena, rol, nombre, apellidos, genero, telefono, correo, matricula, especialidad, firma_png, estado)
       VALUES (?, ?, 'doctor', ?, ?, ?, ?, ?, ?, ?, ?, 'activo')`,
      [String(usuario).trim(), hashed,
       String(nombre).trim(), String(apellidos).trim(),
       normalizeCuentaGenero(genero),
       String(telefono).trim(), String(correo).trim(),
       String(matricula).trim(), String(especialidad).trim(), firma]
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
      emitDoctor(Number(doctor_id), 'doctor-request:new', {
        id: cr.insertId, paciente_id: pacienteId, tutor_id: tutorId, doctor_id: Number(doctor_id),
        nombre: String(nombre).trim(), apellidos: String(apellidos).trim(), codigo,
        tutor_nombre: String(tutor_nombre || nombre).trim(),
        tutor_apellidos: String(tutor_apellidos || apellidos).trim(),
        created_at: new Date().toISOString(),
      });
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
    const token = await createLoginToken(c);

    if (c.rol === 'admin') {
      return res.json({
        ok: true, role: 'superuser', token,
        superuser: {
          id: c.id, usuario: c.usuario, rol: c.rol,
          nombre: c.nombre, apellidos: c.apellidos,
          genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '',
          matricula: c.matricula || '', especialidad: c.especialidad || '',
        },
        paciente: null, last_session: null,
      });
    }

    if (c.rol === 'doctor') {
      return res.json({
        ok: true, role: 'doctor', token,
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
      ok: true, role: 'tutor', token,
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


// ===================== SUPERUSUARIO ========================

async function requireSuperuser(req, res, next) {
  try {
    const id = Number(req.headers['x-superuser-id'] || req.query.superuser_id);
    if (!id) return res.status(401).json({ ok: false, error: 'falta_superuser_id' });
    const [rows] = await pool.execute(
      `SELECT id, usuario, rol, nombre, apellidos, estado
       FROM ${ACCOUNT_TABLE} WHERE id = ? LIMIT 1`,
      [id]
    );
    const account = rows[0];
    if (!account || account.rol !== 'admin' || account.estado !== 'activo')
      return res.status(403).json({ ok: false, error: 'superusuario_no_autorizado' });
    req.superuser = account;
    next();
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_AUTH'); }
}

app.get('/api/auth/current', async (req, res) => {
  try {
    const requestedRole = String(req.query.role || '').toLowerCase();
    if (requestedRole === 'superuser') {
      const id = Number(req.headers['x-superuser-id']);
      const [rows] = await pool.execute(
        `SELECT id, usuario, rol, nombre, apellidos, genero, matricula, especialidad,
                parentesco, correo, telefono, estado
         FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol = 'admin' LIMIT 1`, [id]
      );
      if (!rows.length || rows[0].estado !== 'activo')
        return res.status(404).json({ ok: false, error: 'superusuario_no_encontrado' });
      const c = rows[0];
      return res.json({ ok: true, role: 'superuser', superuser: {
        id: c.id, usuario: c.usuario, rol: c.rol, nombre: c.nombre, apellidos: c.apellidos,
        genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '',
        matricula: c.matricula || '', especialidad: c.especialidad || ''
      }});
    }

    if (requestedRole === 'doctor') {
      const id = Number(req.headers['x-doctor-id']);
      const [rows] = await pool.execute(
        `SELECT id, usuario, rol, nombre, apellidos, genero, matricula, especialidad,
                correo, telefono, estado, (firma_png IS NOT NULL) AS tiene_firma
         FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol = 'doctor' LIMIT 1`, [id]
      );
      if (!rows.length || rows[0].estado !== 'activo')
        return res.status(404).json({ ok: false, error: 'doctor_no_encontrado' });
      const c = rows[0];
      return res.json({ ok: true, role: 'doctor', doctor: {
        id: c.id, usuario: c.usuario, rol: c.rol, nombre: c.nombre, apellidos: c.apellidos,
        genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '',
        matricula: c.matricula || '', especialidad: c.especialidad || '', tiene_firma: !!c.tiene_firma
      }});
    }

    if (requestedRole === 'tutor') {
      const tutorId = Number(req.headers['x-tutor-id']);
      const [accountRows] = await pool.execute(
        `SELECT id, usuario, rol, nombre, apellidos, genero, parentesco, correo, telefono, estado
         FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol = 'tutor' LIMIT 1`, [tutorId]
      );
      if (!accountRows.length || accountRows[0].estado !== 'activo')
        return res.status(404).json({ ok: false, error: 'tutor_no_encontrado' });
      const c = accountRows[0];
      const [pRows] = await pool.execute(`SELECT * FROM pacientes WHERE tutor_id = ? LIMIT 1`, [tutorId]);
      if (!pRows.length) return res.status(404).json({ ok: false, error: 'cuenta_sin_paciente' });
      const p = pRows[0];
      const plan = await getActivePlan(p.id);
      const session = await getActiveSession(p.id);
      const [ssRows] = await pool.execute(`SELECT * FROM sesiones WHERE paciente_id = ? ORDER BY created_at DESC LIMIT 1`, [p.id]);
      const [ctrlRows] = await pool.execute(
        `SELECT modo_control, manual_habilitado, automatico_habilitado, habilitado_hasta, motivo
         FROM control_autorizaciones WHERE paciente_id = ? AND tutor_id = ? LIMIT 1`, [p.id, c.id]
      );
      const [devRows] = await pool.execute(
        `SELECT esp_online, estado, last_seen_at FROM estado_dispositivo WHERE paciente_id = ? LIMIT 1`, [p.id]
      );
      const [doctorRows] = await pool.execute(
        `SELECT id, usuario, nombre, apellidos, genero, matricula, especialidad
         FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol IN ('doctor','admin') LIMIT 1`, [p.doctor_id]
      );
      return res.json({
        ok: true, role: 'tutor',
        paciente: {
          id: p.id, codigo: p.codigo, nombre: p.nombre, apellidos: p.apellidos,
          fecha_nac: p.fecha_nac, dias_nacido: daysBetween(p.fecha_nac), genero: p.genero,
          peso_nacimiento_g: p.peso_nacimiento_g, peso_actual_g: p.peso_actual_g,
          edad_gestacional_sem: p.edad_gestacional_sem, fecha_ingreso: p.fecha_ingreso,
          fecha_alta: p.fecha_alta, doctor_id: p.doctor_id,
          doctor_request_status: p.doctor_request_status, estado_clinico: p.estado_clinico,
          estado_registro: p.estado_registro, diagnostico: p.diagnostico,
          observaciones: p.observaciones, nivel_bilirrubina_inicial: p.nivel_bilirrubina_inicial,
          nivel_bilirrubina_actual: p.nivel_bilirrubina_actual,
          grupo_sanguineo: p.grupo_sanguineo, factor_rh: p.factor_rh,
        },
        tutor: {
          id: c.id, usuario: c.usuario, nombre: c.nombre, apellidos: c.apellidos,
          genero: c.genero || '', telefono: c.telefono || '', correo: c.correo || '', parentesco: c.parentesco
        },
        plan: plan || null, session: session || null, last_session: ssRows[0] || null,
        control: ctrlRows[0] ? { ...ctrlRows[0], modo_actual: currentLampMode } : null,
        dispositivo: devRows[0] || null, doctor: doctorRows[0] || null,
      });
    }

    return res.status(400).json({ ok: false, error: 'rol_invalido' });
  } catch (e) { return sendServerError(res, e, 'AUTH_CURRENT'); }
});

app.get('/api/superuser/overview', requireSuperuser, async (_req, res) => {
  try {
    const [[doctorCount]] = await pool.query(
      `SELECT COUNT(*) AS total FROM ${ACCOUNT_TABLE} WHERE rol = 'doctor' AND estado = 'activo'`
    );
    const [[patientCount]] = await pool.query(
      `SELECT COUNT(*) AS total FROM pacientes WHERE estado_registro <> 'eliminado'`
    );
    const [[sessionStats]] = await pool.query(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(duracion_s),0) AS duration_s FROM sesiones WHERE status = 'finished'`
    );
    const [[alertCount]] = await pool.query(
      `SELECT COUNT(*) AS total FROM alarmas WHERE silenciada = FALSE AND DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`
    );
    const [usageDays] = await pool.query(
      `SELECT DATE(fecha) AS day, COUNT(*) AS sessions, COALESCE(SUM(duracion_s),0) AS duration_s
       FROM sesiones WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL 62 DAY)
       GROUP BY DATE(fecha) ORDER BY day ASC`
    );
    const [alerts] = await pool.query(
      `SELECT a.id, a.tipo, a.severidad, a.valor_medido, a.unidad, a.created_at,
              p.codigo, p.nombre AS patient_name, p.apellidos AS patient_lastname
       FROM alarmas a LEFT JOIN pacientes p ON p.id = a.paciente_id
       ORDER BY a.created_at DESC LIMIT 8`
    );
    res.json({
      ok: true,
      stats: {
        doctors: Number(doctorCount?.total || 0),
        patients: Number(patientCount?.total || 0),
        sessions: Number(sessionStats?.sessions || 0),
        duration_s: Number(sessionStats?.duration_s || 0),
        alerts: Number(alertCount?.total || 0),
      },
      usageDays,
      alerts,
      equipment: await (async () => {
        const [[e]] = await pool.query(`SELECT COUNT(*) AS total, SUM(estado IN ('operativo','en_uso')) AS operativos FROM equipos`);
        return { registered: Number(e.total || 0), operational: Number(e.operativos || 0), espOnline };
      })(),
    });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_OVERVIEW'); }
});

app.get('/api/superuser/users', requireSuperuser, async (_req, res) => {
  try {
    const [doctors] = await pool.query(
      `SELECT c.id, c.usuario, c.nombre, c.apellidos, c.genero, c.especialidad,
              c.matricula, c.correo, c.telefono, c.estado,
              COUNT(CASE WHEN p.estado_registro = 'activo' THEN 1 END) AS patient_count
       FROM ${ACCOUNT_TABLE} c
       LEFT JOIN pacientes p ON p.doctor_id = c.id
       WHERE c.rol = 'doctor'
       GROUP BY c.id
       ORDER BY c.estado DESC, c.apellidos, c.nombre`
    );
    const [patients] = await pool.query(
      `SELECT p.id, p.codigo, p.nombre, p.apellidos, p.estado_clinico, p.estado_registro,
              p.fecha_ingreso, p.doctor_id, p.doctor_request_status,
              d.nombre AS doctor_nombre, d.apellidos AS doctor_apellidos,
              d.genero AS doctor_genero, d.estado AS doctor_estado
       FROM pacientes p
       LEFT JOIN ${ACCOUNT_TABLE} d ON d.id = p.doctor_id
       WHERE p.estado_registro <> 'eliminado'
       ORDER BY p.apellidos, p.nombre`
    );
    res.json({ ok: true, doctors, patients });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_USERS'); }
});

app.post('/api/superuser/patients/:id/reassign', requireSuperuser, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const patientId = Number(req.params.id);
    const doctorId = Number(req.body?.doctor_id);
    const reason = String(req.body?.reason || '').trim();
    if (!patientId || !doctorId)
      return res.status(400).json({ ok: false, error: 'datos_invalidos' });
    await conn.beginTransaction();
    const [doctorRows] = await conn.execute(
      `SELECT id, nombre, apellidos FROM ${ACCOUNT_TABLE}
       WHERE id = ? AND rol = 'doctor' AND estado = 'activo' LIMIT 1`, [doctorId]
    );
    if (!doctorRows.length) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'doctor_no_disponible' }); }
    const [patientRows] = await conn.execute(`SELECT id, doctor_id, nombre, apellidos FROM pacientes WHERE id = ? LIMIT 1`, [patientId]);
    if (!patientRows.length) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' }); }
    const previousDoctorId = patientRows[0].doctor_id;
    await conn.execute(
      `UPDATE pacientes SET doctor_id = ?, doctor_request_status = 'accepted' WHERE id = ?`,
      [doctorId, patientId]
    );
    await conn.execute(`UPDATE control_autorizaciones SET doctor_id = ? WHERE paciente_id = ?`, [doctorId, patientId]);
    await logEvent({
      paciente_id: patientId, cuenta_id: req.superuser.id, tipo: 'paciente_editado',
      descripcion: `Paciente reasignado al doctor ${doctorRows[0].nombre} ${doctorRows[0].apellidos}`,
      metadata: { action: 'doctor_reassigned', previous_doctor_id: previousDoctorId, doctor_id: doctorId, reason }
    }, conn);
    await conn.commit();
    io.emit('patient:reassigned', { paciente_id: patientId, previous_doctor_id: previousDoctorId, doctor_id: doctorId });
    res.json({ ok: true, previous_doctor_id: previousDoctorId, doctor: doctorRows[0] });
  } catch (e) { await conn.rollback(); return sendServerError(res, e, 'SUPERUSER_REASSIGN'); }
  finally { conn.release(); }
});

app.patch('/api/superuser/doctors/:id/status', requireSuperuser, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const doctorId = Number(req.params.id);
    const status = String(req.body?.status || '').toLowerCase();
    const reassignTo = Number(req.body?.reassign_to) || null;
    if (!doctorId || !['activo','inactivo'].includes(status))
      return res.status(400).json({ ok: false, error: 'datos_invalidos' });
    if (doctorId === Number(req.superuser.id))
      return res.status(400).json({ ok: false, error: 'no_puede_modificar_su_cuenta' });
    await conn.beginTransaction();
    const [[assigned]] = await conn.execute(
      `SELECT COUNT(*) AS total FROM pacientes WHERE doctor_id = ? AND estado_registro = 'activo'`, [doctorId]
    );
    const assignedCount = Number(assigned?.total || 0);
    if (status === 'inactivo' && assignedCount > 0 && !reassignTo) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: 'doctor_con_pacientes', assigned_count: assignedCount });
    }
    if (status === 'inactivo' && reassignTo) {
      if (reassignTo === doctorId) { await conn.rollback(); return res.status(400).json({ ok: false, error: 'doctor_reasignacion_invalido' }); }
      const [target] = await conn.execute(
        `SELECT id FROM ${ACCOUNT_TABLE} WHERE id = ? AND rol = 'doctor' AND estado = 'activo' LIMIT 1`, [reassignTo]
      );
      if (!target.length) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'doctor_destino_no_disponible' }); }
      await conn.execute(`UPDATE pacientes SET doctor_id = ?, doctor_request_status = 'accepted' WHERE doctor_id = ? AND estado_registro = 'activo'`, [reassignTo, doctorId]);
      await conn.execute(`UPDATE control_autorizaciones SET doctor_id = ? WHERE doctor_id = ?`, [reassignTo, doctorId]);
    }
    const [result] = await conn.execute(
      `UPDATE ${ACCOUNT_TABLE} SET estado = ? WHERE id = ? AND rol = 'doctor'`, [status, doctorId]
    );
    if (!result.affectedRows) { await conn.rollback(); return res.status(404).json({ ok: false, error: 'doctor_no_encontrado' }); }
    await conn.commit();
    res.json({ ok: true, status, reassigned: status === 'inactivo' ? assignedCount : 0 });
  } catch (e) { await conn.rollback(); return sendServerError(res, e, 'SUPERUSER_DOCTOR_STATUS'); }
  finally { conn.release(); }
});

// ===================== FIRMA DEL DOCTOR ========================
// La firma se dibuja en pantalla y se guarda como imagen PNG (texto base64).
// Es una firma visual para los reportes; no es una firma digital con validez legal.

const MAX_FIRMA_BYTES = 400_000;
function cleanSignature(value) {
  const v = String(value || '').trim();
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
  if (v.length < 800 || v.length > MAX_FIRMA_BYTES) return null;   // vacía o demasiado grande
  return v;
}

app.get('/api/doctor/signature', async (req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT firma_png FROM ${ACCOUNT_TABLE} WHERE id = ? LIMIT 1`, [req.auth.id]);
    res.json({ ok: true, firma: rows[0]?.firma_png || null });
  } catch (e) { return sendServerError(res, e, 'SIGNATURE_GET'); }
});

app.put('/api/doctor/signature', async (req, res) => {
  try {
    const firma = cleanSignature(req.body?.firma);
    if (!firma) return res.status(400).json({ ok: false, error: 'firma_invalida', message: 'Dibuja tu firma antes de guardar.' });
    await pool.execute(`UPDATE ${ACCOUNT_TABLE} SET firma_png = ? WHERE id = ?`, [firma, req.auth.id]);
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'SIGNATURE_PUT'); }
});

// Firma del doctor a cargo de un paciente (para los reportes del tutor y del doctor).
app.get('/api/patients/:id/doctor-signature', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT d.nombre, d.apellidos, d.genero, d.matricula, d.especialidad, d.firma_png
       FROM pacientes p JOIN ${ACCOUNT_TABLE} d ON d.id = p.doctor_id
       WHERE p.id = ? LIMIT 1`, [Number(req.params.id)]
    );
    if (!rows.length) return res.json({ ok: true, doctor: null });
    const d = rows[0];
    res.json({ ok: true, doctor: {
      nombre: d.nombre, apellidos: d.apellidos, genero: d.genero,
      matricula: d.matricula, especialidad: d.especialidad, firma: d.firma_png || null,
    }});
  } catch (e) { return sendServerError(res, e, 'PATIENT_DOCTOR_SIGNATURE'); }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token) {
      tokenCache.delete(hashToken(token));
      await pool.execute(`DELETE FROM sesiones_login WHERE token_hash = ?`, [hashToken(token)]);
    }
    await logEvent({ cuenta_id: req.auth.id, tipo: 'logout', descripcion: `Logout ${req.auth.rol}` }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'LOGOUT'); }
});

// ===================== SUPERUSUARIO: EQUIPOS, MANTENIMIENTO Y DIAGNÓSTICO ========================

const EQUIPO_ESTADOS = ['operativo','en_uso','sin_verificar','advertencia','mantenimiento','fuera_servicio','desconectado'];
const parseJson = v => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

app.get('/api/superuser/workspace', requireSuperuser, async (_req, res) => {
  try {
    const [equipos] = await pool.query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM sesiones s WHERE s.status = 'finished') AS sesiones_total,
              (SELECT COALESCE(SUM(duracion_s),0) FROM sesiones s WHERE s.status = 'finished') AS duracion_total_s
       FROM equipos e ORDER BY e.id ASC`
    );
    const [mant] = await pool.query(`SELECT * FROM mantenimientos ORDER BY created_at DESC LIMIT 100`);
    const [diag] = await pool.query(`SELECT * FROM pruebas_diagnostico ORDER BY created_at DESC LIMIT 150`);
    const [reas] = await pool.query(
      `SELECT e.created_at, e.descripcion, e.metadata, p.id AS patient_id, p.nombre, p.apellidos
       FROM eventos e LEFT JOIN pacientes p ON p.id = e.paciente_id
       WHERE e.tipo = 'paciente_editado' AND e.descripcion LIKE 'Paciente reasignado%'
       ORDER BY e.created_at DESC LIMIT 50`
    );
    res.json({
      ok: true,
      equipments: equipos.map((e, i) => ({
        id: String(e.id), name: e.codigo, status: e.estado,
        description: e.descripcion || '', location: e.ubicacion || '', notes: e.notas || '',
        // Por ahora hay una sola lámpara conectada: las sesiones pertenecen al primer equipo.
        sessions: i === 0 ? Number(e.sesiones_total) : 0,
        hours: i === 0 ? +(Number(e.duracion_total_s) / 3600).toFixed(1) : 0,
        lastTest: e.ultima_prueba_at, lastSeen: e.last_seen_at,
        online: i === 0 ? espOnline : false,
      })),
      maintenance: mant.map(m => ({ ...parseJson(m.detalle), id: `maint-${m.id}`, createdAt: m.created_at,
        equipmentId: String(m.equipo_id), type: m.tipo, result: m.resultado, responsible: m.responsable || '', notes: m.observaciones || '' })),
      diagnosticTests: diag.map(d => ({ ...parseJson(d.detalle), id: `test-${d.id}`, createdAt: d.created_at,
        equipmentId: String(d.equipo_id), type: d.tipo, result: d.resultado })),
      assignments: reas.map(r => ({ ...parseJson(r.metadata), createdAt: r.created_at,
        patientId: r.patient_id, patientName: `${r.nombre || ''} ${r.apellidos || ''}`.trim(), description: r.descripcion })),
    });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_WORKSPACE'); }
});

app.post('/api/superuser/equipments', requireSuperuser, async (req, res) => {
  try {
    const codigo = String(req.body?.name || req.body?.codigo || '').trim().toUpperCase();
    if (!codigo) return res.status(400).json({ ok: false, error: 'falta_codigo' });
    const estado = EQUIPO_ESTADOS.includes(req.body?.status) ? req.body.status : 'sin_verificar';
    const [r] = await pool.execute(
      `INSERT INTO equipos (codigo, descripcion, ubicacion, estado, notas) VALUES (?, ?, ?, ?, ?)`,
      [codigo, req.body?.description || null, req.body?.location || null, estado, req.body?.notes || null]
    );
    res.json({ ok: true, id: String(r.insertId) });
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'codigo_ya_existe', message: 'Ya existe un equipo con ese código.' });
    return sendServerError(res, e, 'SUPERUSER_EQUIPMENT_CREATE');
  }
});

app.put('/api/superuser/equipments/:id', requireSuperuser, async (req, res) => {
  try {
    const sets = [], values = [];
    const b = req.body || {};
    if (b.status !== undefined && EQUIPO_ESTADOS.includes(b.status)) { sets.push('estado = ?'); values.push(b.status); }
    if (b.description !== undefined) { sets.push('descripcion = ?'); values.push(b.description || null); }
    if (b.location !== undefined)    { sets.push('ubicacion = ?');   values.push(b.location || null); }
    if (b.notes !== undefined)       { sets.push('notas = ?');       values.push(b.notes || null); }
    if (b.lastTest !== undefined)    { sets.push('ultima_prueba_at = NOW()'); }
    if (!sets.length) return res.json({ ok: true });
    await pool.execute(`UPDATE equipos SET ${sets.join(', ')} WHERE id = ?`, [...values, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_EQUIPMENT_UPDATE'); }
});

app.post('/api/superuser/maintenance', requireSuperuser, async (req, res) => {
  try {
    const b = req.body || {};
    const equipoId = Number(b.equipmentId);
    if (!equipoId || !b.result) return res.status(400).json({ ok: false, error: 'datos_invalidos' });
    const { equipmentId, type, result, responsible, notes, ...detalle } = b;
    const [r] = await pool.execute(
      `INSERT INTO mantenimientos (equipo_id, cuenta_id, tipo, resultado, responsable, observaciones, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [equipoId, req.superuser.id, ['preventivo','correctivo','inspeccion'].includes(type) ? type : 'preventivo', String(result).slice(0, 40),
       responsible || null, notes || null, JSON.stringify(detalle)]
    );
    res.json({ ok: true, id: `maint-${r.insertId}` });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_MAINTENANCE'); }
});

app.post('/api/superuser/diagnostics', requireSuperuser, async (req, res) => {
  try {
    const b = req.body || {};
    const equipoId = Number(b.equipmentId);
    if (!equipoId || !b.type) return res.status(400).json({ ok: false, error: 'datos_invalidos' });
    const { equipmentId, type, result, ...detalle } = b;
    const [r] = await pool.execute(
      `INSERT INTO pruebas_diagnostico (equipo_id, cuenta_id, tipo, resultado, detalle) VALUES (?, ?, ?, ?, ?)`,
      [equipoId, req.superuser.id, String(type).slice(0, 60), String(result || 'registrado').slice(0, 60), JSON.stringify(detalle)]
    );
    res.json({ ok: true, id: `test-${r.insertId}` });
  } catch (e) { return sendServerError(res, e, 'SUPERUSER_DIAGNOSTICS'); }
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
    emitPatient(r.paciente_id, r.tutor_id, 'doctor-request:resolved', {
      id: reqId, paciente_id: r.paciente_id, tutor_id: r.tutor_id, doctor_id: r.doctor_id, status: newStatus
    });
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

/**
 * Cierra una sesión y calcula sus resultados a partir de las mediciones guardadas:
 * duración real, tiempo dentro de la ventana segura y promedios.
 * La usan el botón de la interfaz y los cierres automáticos (lámpara detenida o desconectada).
 */
async function finalizeSession(sesionId, { motivo = 'completada', cuenta_id = null, duracion_cliente_s = null, observaciones = null } = {}) {
  const [sRows] = await pool.execute(
    `SELECT * FROM sesiones WHERE id = ? AND status IN ('active','paused') LIMIT 1`, [sesionId]
  );
  if (!sRows.length) return null;
  const s = sRows[0];

  const [[m]] = await pool.execute(
    `SELECT COUNT(*) AS n,
            MAX(created_at) AS ultima,
            AVG(intensidad_led_pct) AS led, AVG(distance_cm) AS dist,
            AVG(temp_bebe_c) AS tbebe, AVG(temp_ambiente_c) AS tamb,
            SUM(CASE
                  WHEN modo_actual = 'convencional' AND distance_cm BETWEEN ? AND ? THEN 1
                  WHEN modo_actual = 'intensivo'    AND distance_cm BETWEEN ? AND ? THEN 1
                  ELSE 0 END) AS en_rango
     FROM mediciones WHERE sesion_id = ?`,
    [DISTANCE_WINDOWS.convencional.min, DISTANCE_WINDOWS.convencional.max,
     DISTANCE_WINDOWS.intensivo.min, DISTANCE_WINDOWS.intensivo.max, sesionId]
  );
  const total = Number(m?.n || 0);

  // Duración: lo que realmente midió la lámpara. Sin mediciones se acepta el cronómetro de la interfaz.
  let durS = 0;
  if (total > 0 && s.started_at && m.ultima)
    durS = Math.max(0, Math.round((new Date(m.ultima).getTime() - new Date(s.started_at).getTime()) / 1000));
  else if (toNum(duracion_cliente_s) > 0)
    durS = Math.round(toNum(duracion_cliente_s));
  const rangoS = total > 0 ? Math.round(durS * Number(m.en_rango || 0) / total) : null;
  const round1 = v => (v == null ? null : +Number(v).toFixed(1));

  const motivoFinal = ['completada','detenida_manual','alarma','desconexion','salida_usuario'].includes(motivo) ? motivo : 'completada';
  const [[modoRow]] = await pool.execute(
    `SELECT modo_actual FROM mediciones WHERE sesion_id = ? ORDER BY id DESC LIMIT 1`, [sesionId]
  ).catch(() => [[null]]);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE sesiones SET
         status = 'finished', finished_at = NOW(), hora_fin = CURTIME(),
         duracion_s = ?, tiempo_rango_s = ?, tiempo_fuera_rango_s = ?,
         modo_final = ?, motivo_fin = ?,
         intensidad_promedio_pct = ?, distancia_promedio_cm = ?,
         temp_bebe_promedio_c = ?, temp_amb_promedio_c = ?,
         observaciones = COALESCE(?, observaciones)
       WHERE id = ?`,
      [durS, rangoS, rangoS == null ? null : Math.max(0, durS - rangoS),
       modoRow?.modo_actual || s.modo_programado, motivoFinal,
       round1(m?.led), round1(m?.dist), round1(m?.tbebe), round1(m?.tamb),
       observaciones || null, sesionId]
    );

    if (s.plan_id && durS > 0) {
      await updatePlanProgress(s.plan_id, durS, conn);
      await conn.execute(`UPDATE planes_terapia SET sesiones_realizadas = sesiones_realizadas + 1 WHERE id = ?`, [s.plan_id]);
    }

    await upsertDeviceStatus(s.paciente_id, espOnline, espOnline ? 'online' : 'offline', conn);

    // El permiso manual del tutor vale solo durante la sesión.
    await conn.execute(
      `UPDATE control_autorizaciones
       SET modo_control = 'bloqueado', manual_habilitado = 0, automatico_habilitado = 0,
           habilitado_hasta = NULL, bloqueado_at = NOW(), motivo = 'Bloqueado al terminar la sesión'
       WHERE paciente_id = ?`,
      [s.paciente_id]
    );

    await logEvent({ paciente_id: s.paciente_id, sesion_id: sesionId, cuenta_id,
                     tipo: 'fin_sesion', descripcion: `Sesión finalizada: ${motivoFinal}`,
                     metadata: { duracion_s: durS, tiempo_rango_s: rangoS, motivo_fin: motivoFinal, plan_id: s.plan_id } }, conn);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }

  await sendCommandToESP({ type: 'lock' });
  io.emit('session:finished', { paciente_id: s.paciente_id, sesion_id: sesionId, duracion_s: durS, motivo: motivoFinal });
  io.emit('control:updated', {
    paciente_id: s.paciente_id, modo_control: 'bloqueado',
    manual_habilitado: false, automatico_habilitado: false, modo_actual: currentLampMode, reason: 'session_finished'
  });
  return { paciente_id: s.paciente_id, plan_id: s.plan_id, duracion_s: durS, tiempo_rango_s: rangoS };
}

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

    await setActivePatient(paciente_id);
    const plan = await getActivePlan(paciente_id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await resetActiveAlarmsForNewSession(paciente_id, conn);
      const [r] = await conn.execute(
        `INSERT INTO sesiones (paciente_id, plan_id, fecha, hora_inicio, started_at, modo_programado, tipo_control, status)
         VALUES (?, ?, CURDATE(), CURTIME(), NOW(), ?, ?, 'active')`,
        [paciente_id, plan?.id || null, modo, ctrl]
      );
      const sesionId = r.insertId;
      await upsertDeviceStatus(paciente_id, espOnline, 'en_sesion', conn);
      await logEvent({ paciente_id, sesion_id: sesionId, cuenta_id: req.auth?.id || null, tipo: 'inicio_sesion',
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
    const sesionId = Number(req.params.id);
    await pool.execute(`UPDATE sesiones SET status = 'paused' WHERE id = ? AND status = 'active'`, [sesionId]);
    const [rows] = await pool.execute(`SELECT paciente_id FROM sesiones WHERE id = ?`, [sesionId]);
    await logEvent({ paciente_id: rows[0]?.paciente_id, sesion_id: sesionId, cuenta_id: req.auth?.id || null, tipo: 'pausa_sesion' });
    io.emit('session:paused', { sesion_id: sesionId, paciente_id: rows[0]?.paciente_id });
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'SESSION_PAUSE'); }
});

app.post('/api/sessions/:id/finish', async (req, res) => {
  try {
    const result = await finalizeSession(Number(req.params.id), {
      motivo: req.body?.motivo_fin || 'completada',
      cuenta_id: req.auth?.id || null,
      duracion_cliente_s: req.body?.duracion_s,
      observaciones: req.body?.observaciones,
    });
    if (!result) return res.status(404).json({ ok: false, error: 'sesion_no_encontrada_o_ya_finalizada' });
    const plan = result.plan_id ? await getActivePlan(result.paciente_id) : null;
    res.json({ ok: true, duracion_s: result.duracion_s, tiempo_rango_s: result.tiempo_rango_s,
               hms: secondsToHMS(result.duracion_s), plan: plan || null });
  } catch (e) { return sendServerError(res, e, 'SESSION_FINISH'); }
});

app.get('/api/patients/:id/sessions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, fecha, hora_inicio, hora_fin, duracion_s, tiempo_rango_s,
              modo_programado, modo_final, tipo_control, status, motivo_fin,
              intensidad_promedio_pct, distancia_promedio_cm, temp_bebe_promedio_c, temp_amb_promedio_c
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
  } catch (e) { return sendServerError(res, e, 'SESSION_GET'); }
});

app.get('/api/sessions/:id/measurements', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT distance_cm, temp_bebe_c, temp_ambiente_c, intensidad_led_pct, ldr_pct,
              modo_actual, sensor_ultra_fail, sensor_body_fail, sensor_amb_fail, created_at
       FROM mediciones WHERE sesion_id = ? ORDER BY created_at ASC`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, measurements: rows });
  } catch (e) { return sendServerError(res, e, 'SESSION_MEASUREMENTS'); }
});

// ===================== CONTROL Y MODOS ========================

// Aplica un modo a la lámpara para un paciente y lo deja como paciente activo del equipo.
async function applyLampMode(paciente_id, modo) {
  await setActivePatient(paciente_id);
  const result = await sendCommandToESP({ type: 'mode', mode: modo });
  if (result.sent) {
    currentLampMode = modo;
    io.emit('lamp:command', { type: 'mode', mode: modo, paciente_id });
    io.emit('control:updated', { paciente_id, modo_actual: currentLampMode });
  }
  return result;
}

const LAMP_ERRORS = {
  lampara_sin_conexion: 'La lámpara no está conectada.',
  requiere_clave_fisica: 'Primero hay que activar el control manual en el equipo: MODE, ARRIBA, ABAJO, MODE.',
  limite_de_seguridad: 'El equipo detuvo el movimiento por el límite de distancia segura.',
  equipo_sin_esa_funcion: 'El firmware de la lámpara todavía no tiene esa función.',
  comando_no_compatible: 'La lámpara no reconoce ese comando.',
};
const lampErrorMessage = reason => LAMP_ERRORS[reason] || 'La lámpara no aceptó el comando.';

app.get('/api/patient/:id/control', async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    const [rows] = await pool.execute(
      `SELECT modo_control, manual_habilitado, automatico_habilitado,
              habilitado_desde, habilitado_hasta, motivo
       FROM control_autorizaciones WHERE paciente_id = ? LIMIT 1`, [patientId]
    );
    res.json({ ok: true, control: rows[0] ? {
      ...rows[0], modo_actual: currentLampMode,
      lampara_manual: espOnline ? !!lastTelemetry?.manual : false,     // clave física ingresada en el equipo
      lampara_conectada: espOnline,
    } : null });
  } catch (e) { return sendServerError(res, e, 'PATIENT_CONTROL_GET'); }
});

// El doctor autoriza o bloquea el control manual del tutor.
// Autorizar no desbloquea el equipo: por seguridad el movimiento solo se habilita
// con la clave física (MODE, ARRIBA, ABAJO, MODE). Bloquear sí corta el manual de inmediato.
app.post('/api/doctor/patients/:id/control', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    await ensurePatientBelongsToDoctor(patientId, doctorId);

    let { modo_control, habilitado_hasta, motivo } = req.body;
    if (modo_control === 'automatic') modo_control = 'automatico';
    if (modo_control === 'blocked')   modo_control = 'bloqueado';
    if (!['bloqueado','manual','automatico'].includes(modo_control))
      return res.status(400).json({ ok: false, error: 'modo_control_invalido' });

    const manualH = modo_control === 'manual' ? 1 : 0;
    const autoH   = modo_control === 'automatico' ? 1 : 0;
    await pool.execute(
      `UPDATE control_autorizaciones
       SET modo_control = ?, manual_habilitado = ?, automatico_habilitado = ?,
           habilitado_desde = ?, habilitado_hasta = ?, bloqueado_at = ?, motivo = ?
       WHERE paciente_id = ?`,
      [modo_control, manualH, autoH,
       modo_control !== 'bloqueado' ? new Date() : null, habilitado_hasta || null,
       modo_control === 'bloqueado' ? new Date() : null, motivo || null, patientId]
    );
    const esp = modo_control === 'bloqueado' ? await sendCommandToESP({ type: 'lock' }) : null;

    await logEvent({ paciente_id: patientId, cuenta_id: doctorId,
                     tipo: modo_control === 'bloqueado' ? 'control_manual_bloqueado'
                         : modo_control === 'manual'    ? 'control_manual_habilitado' : 'modo_automatico_habilitado',
                     descripcion: `Permiso del tutor: ${modo_control}`,
                     metadata: { modo_control, habilitado_hasta } });
    io.emit('control:updated', { paciente_id: patientId, modo_control,
                                 manual_habilitado: !!manualH, automatico_habilitado: !!autoH });
    res.json({ ok: true, modo_control, esp });
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
    if (!modo || modo === 'automatico') return res.status(400).json({ ok: false, error: 'modo_invalido' });

    const result = await applyLampMode(patientId, modo);
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'cambio_modo',
                     descripcion: `Doctor cambió modo a ${modo}`, metadata: { modo, enviado: result.sent, motivo: result.reason || null } });
    if (!result.sent)
      return res.status(503).json({ ok: false, error: result.reason, message: lampErrorMessage(result.reason) });
    res.json({ ok: true, mode: modo });
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
    const isManual = requestedMode === 'manual_control';
    const modo = isManual ? 'manual_control' : normalizeMode(requestedMode);
    if (!modo || modo === 'automatico') return res.status(400).json({ ok: false, error: 'modo_invalido_para_tutor' });

    const [patientRows] = await pool.execute(
      `SELECT p.id, p.nombre, p.apellidos, p.doctor_id,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos
       FROM pacientes p LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = p.tutor_id
       WHERE p.id = ? AND p.tutor_id = ? LIMIT 1`,
      [patientId, tutorId]
    );
    if (!patientRows.length) return res.status(404).json({ ok: false, error: 'paciente_no_encontrado' });
    const pat = patientRows[0];

    // Reposo siempre se permite; el modo que el doctor dejó en el plan no necesita pedir permiso otra vez.
    const activePlan = await getActivePlan(patientId);
    const allowedByPlan = !isManual && modo === normalizeMode(activePlan?.modo_recomendado);
    if (!isManual && (modo === 'reposo' || allowedByPlan)) {
      const result = await applyLampMode(patientId, modo);
      await logEvent({ paciente_id: patientId, cuenta_id: tutorId, tipo: 'cambio_modo',
                       descripcion: modo === 'reposo' ? 'Tutor puso la lámpara en reposo' : `Tutor activó el modo del plan: ${modo}`,
                       metadata: { modo, plan_id: activePlan?.id || null, enviado: result.sent, motivo: result.reason || null } });
      if (!result.sent)
        return res.status(503).json({ ok: false, error: result.reason, message: lampErrorMessage(result.reason) });
      return res.json({ ok: true, status: 'applied', mode: modo, reason: allowedByPlan ? 'plan_recomendado' : 'reposo' });
    }

    const tipo = isManual ? 'manual_control' : 'mode_change';
    const [dup] = await pool.execute(
      `SELECT id FROM solicitudes_modo WHERE paciente_id = ? AND tutor_id = ? AND modo = ? AND status = 'pending' LIMIT 1`,
      [patientId, tutorId, modo]
    );
    if (dup.length) return res.json({ ok: true, status: 'pending', request_id: String(dup[0].id), mode: modo });

    const [r] = await pool.execute(
      `INSERT INTO solicitudes_modo (paciente_id, doctor_id, tutor_id, modo, tipo, motivo) VALUES (?, ?, ?, ?, ?, ?)`,
      [patientId, pat.doctor_id, tutorId, modo, tipo, req.body?.motivo || null]
    );
    await logEvent({ paciente_id: patientId, cuenta_id: tutorId,
                     tipo: isManual ? 'solicitud_control_manual' : 'solicitud_modo',
                     descripcion: isManual ? 'Tutor solicitó control manual' : `Tutor solicitó modo ${modo}`,
                     metadata: { modo, request_id: r.insertId } });
    emitDoctor(pat.doctor_id, 'mode-request:new', {
      id: String(r.insertId), paciente_id: patientId, doctor_id: Number(pat.doctor_id), tutor_id: tutorId,
      mode: modo, request_type: tipo, motivo: req.body?.motivo || null,
      paciente_nombre: pat.nombre, paciente_apellidos: pat.apellidos,
      tutor_nombre: pat.tutor_nombre, tutor_apellidos: pat.tutor_apellidos,
      created_at: new Date().toISOString(),
    });
    return res.json({ ok: true, status: 'pending', request_id: String(r.insertId), mode: modo });
  } catch (e) { return sendServerError(res, e, 'TUTOR_MODE_REQUEST'); }
});

app.get('/api/doctor/mode-requests', async (req, res) => {
  try {
    const doctorId = getDoctorIdFromReq(req);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    const [rows] = await pool.execute(
      `SELECT s.id, s.paciente_id, s.doctor_id, s.tutor_id, s.modo AS mode, s.tipo AS request_type,
              s.motivo, s.status, s.created_at,
              p.nombre AS paciente_nombre, p.apellidos AS paciente_apellidos,
              t.nombre AS tutor_nombre, t.apellidos AS tutor_apellidos
       FROM solicitudes_modo s
       JOIN pacientes p ON p.id = s.paciente_id
       LEFT JOIN ${ACCOUNT_TABLE} t ON t.id = s.tutor_id
       WHERE s.doctor_id = ? AND s.status = 'pending' ORDER BY s.created_at ASC`,
      [doctorId]
    );
    res.json({ ok: true, requests: rows.map(r => ({ ...r, id: String(r.id) })) });
  } catch (e) { return sendServerError(res, e, 'FETCH_MODE_REQUESTS'); }
});

app.post('/api/doctor/mode-requests/:id', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const requestId = Number(req.params.id);
    const decision  = String(req.body?.decision || '').toLowerCase();
    const accept = ['accept','accepted','aprobar'].includes(decision);
    const reject = ['reject','rejected','rechazar'].includes(decision);
    if (!doctorId) return res.status(400).json({ ok: false, error: 'falta_doctor_id' });
    if (!accept && !reject) return res.status(400).json({ ok: false, error: 'decision_invalida' });

    const [rows] = await pool.execute(
      `SELECT * FROM solicitudes_modo WHERE id = ? AND doctor_id = ? AND status = 'pending' LIMIT 1`, [requestId, doctorId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'solicitud_no_encontrada' });
    const request = rows[0];
    const isManual = request.tipo === 'manual_control';
    const resolved = status => ({
      id: String(requestId), paciente_id: request.paciente_id, tutor_id: request.tutor_id,
      doctor_id: request.doctor_id, status, mode: request.modo, request_type: request.tipo,
    });

    if (reject) {
      await pool.execute(`UPDATE solicitudes_modo SET status = 'rejected', resolved_at = NOW() WHERE id = ?`, [requestId]);
      await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId, tipo: 'solicitud_rechazada',
                       descripcion: isManual ? 'Doctor rechazó el control manual' : `Doctor rechazó el modo ${request.modo}`,
                       metadata: { request_id: requestId, mode: request.modo } });
      emitPatient(request.paciente_id, request.tutor_id, 'mode-request:resolved', resolved('rejected'));
      return res.json({ ok: true, status: 'rejected' });
    }

    await ensurePatientBelongsToDoctor(request.paciente_id, doctorId);

    if (isManual) {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.execute(
        `UPDATE control_autorizaciones
         SET modo_control = 'manual', manual_habilitado = 1, automatico_habilitado = 0,
             habilitado_desde = NOW(), habilitado_hasta = ?, bloqueado_at = NULL, motivo = ?
         WHERE paciente_id = ?`,
        [until, request.motivo || 'Control manual autorizado por el doctor', request.paciente_id]
      );
      await pool.execute(`UPDATE solicitudes_modo SET status = 'accepted', resolved_at = NOW() WHERE id = ?`, [requestId]);
      await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId, tipo: 'solicitud_aceptada',
                       descripcion: 'Doctor autorizó el control manual del tutor', metadata: { request_id: requestId } });
      emitPatient(request.paciente_id, request.tutor_id, 'control:updated', {
        paciente_id: request.paciente_id, modo_control: 'manual', manual_habilitado: true, automatico_habilitado: false
      });
      emitPatient(request.paciente_id, request.tutor_id, 'mode-request:resolved', resolved('accepted'));
      return res.json({ ok: true, status: 'accepted', mode: request.modo });
    }

    // Cambio de modo: solo se da por aceptado si la lámpara lo recibió. Si no, queda pendiente para reintentar.
    const result = await applyLampMode(request.paciente_id, request.modo);
    if (!result.sent)
      return res.status(503).json({ ok: false, error: result.reason, message: lampErrorMessage(result.reason) });
    await pool.execute(`UPDATE solicitudes_modo SET status = 'accepted', resolved_at = NOW() WHERE id = ?`, [requestId]);
    await logEvent({ paciente_id: request.paciente_id, cuenta_id: doctorId, tipo: 'solicitud_aceptada',
                     descripcion: `Doctor aprobó el modo ${request.modo}`, metadata: { request_id: requestId, mode: request.modo } });
    emitPatient(request.paciente_id, request.tutor_id, 'mode-request:resolved', resolved('accepted'));
    res.json({ ok: true, status: 'accepted', mode: request.modo });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'DECIDE_MODE_REQUEST');
  }
});

// Movimiento de la lámpara pedido por el doctor. Requiere la clave física en el equipo.
app.post('/api/doctor/patients/:id/height', async (req, res) => {
  try {
    const doctorId  = getDoctorIdFromReq(req);
    const patientId = Number(req.params.id);
    await ensurePatientBelongsToDoctor(patientId, doctorId);
    const dir = String(req.body.dir || '').toLowerCase();
    if (!['subir','bajar','izq','der','stop'].includes(dir)) return res.status(400).json({ ok: false, error: 'dir_invalido' });
    if (dir !== 'stop' && !lastTelemetry?.manual)
      return res.status(409).json({ ok: false, error: 'requiere_clave_fisica', message: lampErrorMessage('requiere_clave_fisica') });

    const result = await sendCommandToESP({ type: 'move', dir });
    await logEvent({ paciente_id: patientId, cuenta_id: doctorId, tipo: 'cambio_altura',
                     descripcion: `Doctor movió la lámpara: ${dir}`, metadata: { dir, enviado: result.sent, motivo: result.reason || null } });
    if (!result.sent)
      return res.status(503).json({ ok: false, error: result.reason, message: lampErrorMessage(result.reason) });
    res.json({ ok: true, dir });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, error: e.error });
    return sendServerError(res, e, 'DOCTOR_MOVE');
  }
});

// ===================== ALARMAS ========================

app.post('/api/patients/:id/alarms/reset-active', async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    await resetActiveAlarmsForNewSession(patientId);
    io.emit('alarm:reset', { paciente_id: patientId });
    res.json({ ok: true });
  } catch (e) { return sendServerError(res, e, 'RESET_ACTIVE_ALARMS'); }
});

app.get('/api/patients/:id/alarms', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT a.*, s.fecha AS sesion_fecha, (a.silenciada = FALSE) AS activa
       FROM alarmas a
       LEFT JOIN sesiones s ON s.id = a.sesion_id
       WHERE a.paciente_id = ?
       ORDER BY a.silenciada ASC, a.created_at DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, alarms: rows });
  } catch (e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/api/alarms/:id/mute', async (req, res) => {
  try {
    const alarmId   = Number(req.params.id);
    const cuenta_id = req.auth?.id || null;
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
    const { paciente_id, sesion_id, tipo, descripcion, metadata } = req.body;
    const cuenta_id = req.auth?.id || null;
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
      `SELECT
          SUM(CASE WHEN a.silenciada = FALSE THEN 1 ELSE 0 END) AS count,
          SUM(CASE WHEN a.silenciada = FALSE AND LOWER(a.severidad) = 'critical' THEN 1 ELSE 0 END) AS critical,
          SUM(CASE WHEN a.silenciada = FALSE AND LOWER(a.severidad) <> 'critical' THEN 1 ELSE 0 END) AS warning,
          SUM(CASE WHEN a.silenciada = TRUE THEN 1 ELSE 0 END) AS silenced
       FROM alarmas a
       JOIN pacientes p ON p.id = a.paciente_id
       WHERE p.doctor_id = ? AND DATE(a.created_at) = CURDATE()`,
      [doctorId]
    );
    res.json({ ok: true,
      count: Number(rows[0]?.count || 0),
      critical: Number(rows[0]?.critical || 0),
      warning: Number(rows[0]?.warning || 0),
      silenced: Number(rows[0]?.silenced || 0)
    });
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
       FROM alarmas a LEFT JOIN sesiones s ON s.id = a.sesion_id
       WHERE a.paciente_id = ? ORDER BY a.created_at`,
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

// Solo entra quien inició sesión: el token viaja en la conexión.
io.use(async (socket, next) => {
  try {
    const auth = await resolveToken(socket.handshake.auth?.token);
    if (!auth) return next(new Error('sesion_requerida'));
    socket.data.auth = auth;
    next();
  } catch (e) { next(new Error('sesion_requerida')); }
});

// ¿Puede esta conexión mover la lámpara ahora mismo?
async function canMoveLamp(auth) {
  if (!espOnline) return 'lampara_sin_conexion';
  if (!lastTelemetry?.manual) return 'requiere_clave_fisica';
  if (auth.rol === 'tutor') {
    const [rows] = await pool.execute(
      `SELECT c.manual_habilitado, c.habilitado_hasta
       FROM control_autorizaciones c JOIN pacientes p ON p.id = c.paciente_id
       WHERE p.tutor_id = ? LIMIT 1`, [auth.id]
    );
    const c = rows[0];
    if (!c || !c.manual_habilitado) return 'sin_autorizacion_del_doctor';
    if (c.habilitado_hasta && new Date(c.habilitado_hasta) < new Date()) return 'autorizacion_vencida';
  }
  return null;
}

io.on('connection', socket => {
  const auth = socket.data.auth;
  if (lastTelemetry) socket.emit('telemetry', visibleTelemetry());
  if (lastStatus)    socket.emit('status', { ...lastStatus, esp32_connected: espOnline });
  socket.emit('lamp:port', { open: espOnline, path: 'WiFi' });
  for (const [pid] of onlinePatients) socket.emit('patient:online', { id: pid });

  socket.on('patient:identify', payload => {
    const pid = String(payload?.id || '');
    if (!pid || auth.rol !== 'tutor') return;
    socket.data.patientId = pid;
    if (!onlinePatients.has(pid)) onlinePatients.set(pid, new Set());
    onlinePatients.get(pid).add(socket.id);
    if (onlinePatients.get(pid).size === 1) io.emit('patient:online', { id: pid });
  });

  // Silenciar el buzzer de la lámpara durante 5 minutos (o reactivarlo).
  socket.on('alarms:mute', async payload => {
    const mute = !!payload?.mute;
    const result = await sendCommandToESP({ type: 'mute', seconds: mute ? 300 : 0 });
    if (!result.sent) return socket.emit('lamp:denied', { action: 'mute', reason: result.reason, message: lampErrorMessage(result.reason) });
    if (lastTelemetry) lastTelemetry.alarms_muted = mute;
    if (activePatientId)
      await logEvent({ paciente_id: activePatientId, cuenta_id: auth.id, tipo: 'silencio_alarmas',
                       descripcion: mute ? 'Alarmas silenciadas por 5 minutos' : 'Alarmas reactivadas' }).catch(() => {});
    io.emit('telemetry', visibleTelemetry());
  });

  // Cambio de modo directo: solo doctor y superusuario. El tutor usa su solicitud.
  socket.on('lamp:mode', async payload => {
    const mode = normalizeMode(payload?.mode);
    if (!mode || mode === 'automatico') return;
    if (!['doctor','admin'].includes(auth.rol))
      return socket.emit('lamp:denied', { action: 'mode', reason: 'sin_permiso', message: 'Tu cuenta no puede cambiar el modo directamente.' });
    const result = await sendCommandToESP({ type: 'mode', mode });
    if (!result.sent) return socket.emit('lamp:denied', { action: 'mode', reason: result.reason, message: lampErrorMessage(result.reason) });
    currentLampMode = mode;
    io.emit('lamp:command', { type: 'mode', mode });
    io.emit('control:updated', { modo_actual: currentLampMode });
  });

  // Prueba del buzzer desde el diagnóstico técnico.
  socket.on('lamp:beep', async () => {
    if (auth.rol !== 'admin') return;
    const result = await sendCommandToESP({ type: 'beep' });
    if (!result.sent) socket.emit('lamp:denied', { action: 'beep', reason: result.reason, message: lampErrorMessage(result.reason) });
  });

  socket.on('lamp:move', async payload => {
    const raw = String(payload?.dir || '').toLowerCase().trim();
    const map = {
      subir: 'subir', up: 'subir', u: 'subir', bajar: 'bajar', down: 'bajar', d: 'bajar',
      izq: 'izq', izquierda: 'izq', left: 'izq', l: 'izq', der: 'der', derecha: 'der', right: 'der', r: 'der',
      stop: 'stop', s: 'stop'
    };
    const dir = map[raw];
    if (!dir) return;
    // Detener siempre se permite. Mover exige autorización y la clave física en el equipo.
    if (dir !== 'stop') {
      const denied = await canMoveLamp(auth).catch(() => 'error_interno');
      if (denied) {
        const messages = {
          sin_autorizacion_del_doctor: 'El doctor todavía no autorizó el control manual.',
          autorizacion_vencida: 'La autorización del doctor venció. Solicítala de nuevo.',
        };
        return socket.emit('lamp:denied', { action: 'move', reason: denied, message: messages[denied] || lampErrorMessage(denied) });
      }
    }
    const result = await sendCommandToESP({ type: 'move', dir });
    if (!result.sent) return socket.emit('lamp:denied', { action: 'move', reason: result.reason, message: lampErrorMessage(result.reason) });
    io.emit('lamp:command', { type: 'move', dir });
  });

  socket.on('disconnect', () => {
    const pid = socket.data.patientId;
    if (!pid) return;
    const sockets = onlinePatients.get(pid);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) { onlinePatients.delete(pid); io.emit('patient:offline', { id: pid }); }
    }
  });
});

// ===================== INICIO ========================

initDB()
  .then(() => {
    server.listen(CONFIG.PORT, '0.0.0.0', () => {
      const ip = getLocalIp() || 'localhost';
      console.log('======================================================');
      console.log(`  NEOLIGHT Server v4.0`);
      console.log(`  Local:   http://localhost:${CONFIG.PORT}`);
      console.log(`  Red:     http://${ip}:${CONFIG.PORT}`);
      console.log(`  ESP32:   backend recibe POST http://${ip}:${CONFIG.PORT}/api/esp32-data`);
      console.log(CONFIG.ESP32_MASTER_URL
        ? `  ESP32:   backend consulta GET ${CONFIG.ESP32_MASTER_URL}/data`
        : '  ESP32:   consulta directa desactivada (sin ESP32_MASTER_URL); se espera que el equipo envíe datos');
      console.log('======================================================');
    });
  })
  .catch(err => { console.error('[FATAL] Error inicializando DB:', err); process.exit(1); });