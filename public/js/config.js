// =========================================================
// public/js/config.js
// Constantes, helpers y estado global compartido
// =========================================================

// URL base del API
export let API_URL = window.location.origin || "";
if (!API_URL || API_URL.startsWith("file:")) API_URL = "http://localhost:3000";


// URL del stream ESP32-S3-CAM. Se carga desde /api/client-config al iniciar el panel.
export let CAMERA_STREAM_URL = "http://192.168.4.50/stream";
export async function loadClientConfig() {
  try {
    const res = await fetch(`${API_URL}/api/client-config`);
    const data = await res.json();
    if (data?.camStreamUrl) CAMERA_STREAM_URL = data.camStreamUrl;
    return data || {};
  } catch (_) {
    return { camStreamUrl: CAMERA_STREAM_URL };
  }
}

// Storage keys
export const SESSION_KEY        = "fototerapia_session";
export const LOGIN_KEY          = "fototerapia_login";
export const DOCTOR_CODE_CACHE  = "neolight_doctor_code_ok";
export const STORAGE_KEY        = uid => `fototerapia_elapsed_ms_${uid}`;

// Estado de sesión compartido (mutable, exportado por referencia)
export const state = {
  currentUserId:  null,   // ID del paciente (tutor) o doctor
  currentRole:    null,   // 'doctor' | 'tutor' | 'admin'
  currentTutorId: null,   // ID de la cuenta tutor
  doctorId:       null,   // Doctor ID (cuando rol = doctor)
  currentSuperuserId: null, // Cuenta administradora (rol = admin)
  pacienteData:   null,   // objeto paciente completo
  controlData:    null,   // control_autorizaciones
  dashboardLocked:false,  // bloqueo local de controles del panel tutor
  token:          null,   // sesión entregada por el servidor
};

// =========================================================
// SESIÓN: el token que entrega el servidor al iniciar sesión
// =========================================================
const TOKEN_KEY = "neolight_token";

export function getToken() {
  if (state.token) return state.token;
  try { state.token = localStorage.getItem(TOKEN_KEY) || null; } catch (_) { state.token = null; }
  return state.token;
}

export function setToken(token) {
  state.token = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) {}
}

/** fetch hacia el servidor con la sesión incluida. Avisa si la sesión venció. */
export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (response.status === 401 && token)
    window.dispatchEvent(new CustomEvent("neolight:session-expired"));
  return response;
}

// =========================================================
// HELPERS DE UTILIDAD
// =========================================================

/** getElementById con alias corto */
export const $  = id => document.getElementById(id);

/** Escapa HTML para inserción segura en DOM */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])
  );
}

/** Escapa valor para atributos HTML */
export function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

/** Formatea edad en días a string legible */
export function formatEdad(dias) {
  dias = Number(dias);
  if (!Number.isFinite(dias) || dias < 0) return "—";
  const años  = Math.floor(dias / 365);
  const meses = Math.floor((dias % 365) / 30);
  const d     = dias % 30;
  const p = [];
  if (años  > 0) p.push(`${años} año${años  !== 1 ? "s" : ""}`);
  if (meses > 0) p.push(`${meses} mes${meses !== 1 ? "es" : ""}`);
  if (d > 0 || !p.length) p.push(`${d} día${d !== 1 ? "s" : ""}`);
  return p.join(", ");
}

/** Normaliza un modo de terapia a minúsculas válidas */
const VALID_MODES = ["reposo", "convencional", "intensivo", "automatico"];
export function normalizeMode(raw) {
  const m = String(raw ?? "").toLowerCase().trim();
  if (m === "automatic") return "automatico";
  return VALID_MODES.includes(m) ? m : null;
}

/** Retorna headers con doctor_id para llamadas del dashboard médico */
export function doctorHeaders(extra = {}) {
  return state.currentRole === "doctor" && state.doctorId
    ? { "x-doctor-id": String(state.doctorId), ...extra }
    : { ...extra };
}


/** Retorna headers con superuser_id para llamadas administrativas */
export function superuserHeaders(extra = {}) {
  return state.currentRole === "superuser" && state.currentSuperuserId
    ? { "x-superuser-id": String(state.currentSuperuserId), ...extra }
    : { ...extra };
}

/** Retorna headers con tutor_id para llamadas del dashboard paciente */
export function tutorHeaders(extra = {}) {
  return state.currentTutorId
    ? { "x-tutor-id": String(state.currentTutorId), ...extra }
    : { ...extra };
}

export function formatDoctorTitle(doctor = {}) {
  const genero = String(doctor?.genero || doctor?.doctor_genero || "").toLowerCase().trim();
  if (genero === "masculino") return "Dr.";
  if (genero === "femenino") return "Dra.";
  return "Dr(a).";
}

export function formatDoctorDisplayName(doctor = {}, fallback = "Dr(a). -") {
  const name = `${doctor?.nombre || doctor?.doctor_nombre || ""} ${doctor?.apellidos || doctor?.doctor_apellidos || ""}`.trim();
  return name ? `${formatDoctorTitle(doctor)} ${name}` : fallback;
}

// =========================================================
// ETIQUETAS LEGIBLES
// La base guarda códigos (distancia_alta, en_sesion, finished...).
// humanLabel los convierte en texto para mostrar a personas.
// =========================================================
const HUMAN_LABELS = {
  distancia_baja: "Distancia muy corta", distancia_alta: "Distancia muy larga", distancia_fuera_rango: "Distancia fuera de rango",
  temperatura_baja: "Temperatura baja", temperatura_alta: "Temperatura alta",
  sensor_ultrasonico: "Falla del sensor de distancia", sensor_temperatura: "Falla del sensor de temperatura", sensor_fallo: "Falla de sensor",
  irradiancia_baja: "Luz insuficiente", esp_desconectado: "Lámpara desconectada", esp32_desconectado: "Lámpara desconectada",
  sesion_interrumpida: "Sesión interrumpida", modo_no_autorizado: "Modo no autorizado", otro: "Otra alerta",
  critical: "Crítica", warning: "Aviso", info: "Informativa",
  ok: "Estable", observacion: "En observación", riesgo: "En riesgo", alta: "De alta",
  active: "En curso", paused: "En pausa", finished: "Finalizada", cancelled: "Cancelada",
  online: "Conectado", offline: "Sin conexión", en_sesion: "En sesión", fallo: "Con falla",
  reposo: "Reposo", convencional: "Convencional", intensivo: "Intensivo", automatico: "Automático",
  pending: "Pendiente", accepted: "Aceptada", rejected: "Rechazada",
};

export function humanLabel(value, fallback = "—") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const key = raw.toLowerCase();
  if (HUMAN_LABELS[key]) return HUMAN_LABELS[key];
  const text = raw.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
