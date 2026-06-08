// =========================================================
// public/js/config.js
// Constantes, helpers y estado global compartido
// =========================================================

// URL base del API
export let API_URL = window.location.origin || "";
if (!API_URL || API_URL.startsWith("file:")) API_URL = "http://localhost:3000";

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
  pacienteData:   null,   // objeto paciente completo
  controlData:    null,   // control_autorizaciones
  dashboardLocked:false,  // bloqueo local de controles del panel tutor
};

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