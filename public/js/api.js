// =========================================================
// public/js/api.js
// Centraliza TODAS las llamadas fetch al backend
// =========================================================

import { API_URL, doctorHeaders, tutorHeaders } from "./config.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Wrapper base fetch → devuelve { ok, data, status } */
async function req(url, opts = {}) {
  const res  = await fetch(`${API_URL}${url}`, opts);
  const text = await res.text().catch(() => "");
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  return { ok: res.ok && (data.ok !== false), status: res.status, data };
}

// =========================================================
// AUTH
// =========================================================

export const verifyHospitalCode = code =>
  req("/api/doctor/verify-code", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code }) });

export const fetchDoctors = () =>
  req("/api/doctors");

export const registerDoctor = payload =>
  req("/api/register-doctor", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

export const registerTutor = payload =>
  req("/api/register", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

export const login = (usuario, contrasena) =>
  req("/api/login", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ usuario, contrasena }) });

export const fetchCurrentDoctorState = doctorId =>
  req(`/api/auth/current?role=doctor`, { headers: { "x-doctor-id": String(doctorId || "") } });

export const fetchCurrentTutorState = tutorId =>
  req(`/api/auth/current?role=tutor`, { headers: { "x-tutor-id": String(tutorId || "") } });

// =========================================================
// DOCTOR DASHBOARD
// =========================================================

export const fetchRequests = () =>
  req("/api/doctor/requests", { headers: doctorHeaders() });

export const decideRequest = (id, decision) =>
  req(`/api/doctor/requests/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify({ decision: decision ? "accept" : "reject" }),
  });

export const fetchModeRequests = () =>
  req("/api/doctor/mode-requests", { headers: doctorHeaders() });

export const decideModeRequest = (id, decision) =>
  req(`/api/doctor/mode-requests/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify({ decision: decision ? "accept" : "reject" }),
  });

export const fetchPatients = () =>
  req("/api/doctor/patients", { headers: doctorHeaders() });

export const fetchArchivedPatients = () =>
  req("/api/doctor/patients/archived", { headers: doctorHeaders() });

export const fetchPatientDetail = patientId =>
  req(`/api/doctor/patients/${patientId}`, { headers: doctorHeaders() });

export const updatePatient = (patientId, payload) =>
  req(`/api/doctor/patients/${patientId}`, {
    method: "PUT",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify(payload),
  });

export const updatePatientClinical = (patientId, payload) =>
  req(`/api/doctor/patients/${patientId}/clinical`, {
    method: "PUT",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify(payload),
  });

export const searchPatients = q =>
  req(`/api/doctor/search-patients?q=${encodeURIComponent(q)}`, { headers: doctorHeaders() });

export const fetchAlertsToday = () =>
  req("/api/doctor/alerts/today", { headers: doctorHeaders() });

export const dischargePatient = patientId =>
  req(`/api/doctor/patients/${patientId}/discharge`, { method: "POST", headers: doctorHeaders(JSON_HEADERS), body: JSON.stringify({}) });

export const archivePatient = patientId =>
  req(`/api/doctor/patients/${patientId}/archive`, { method: "POST", headers: doctorHeaders(JSON_HEADERS), body: JSON.stringify({}) });

export const restorePatient = patientId =>
  req(`/api/doctor/patients/${patientId}/restore`, { method: "POST", headers: doctorHeaders(JSON_HEADERS), body: JSON.stringify({}) });

// =========================================================
// PLANES DE TERAPIA
// =========================================================

export const fetchActivePlan = pacienteId =>
  req(`/api/patients/${pacienteId}/plan-active`);

export const createPlan = (patientId, payload) =>
  req(`/api/doctor/patients/${patientId}/plan`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify(payload),
  });

export const updatePlan = (patientId, planId, payload) =>
  req(`/api/doctor/patients/${patientId}/plan/${planId}`, {
    method: "PUT",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify(payload),
  });

export const cancelPlan = (patientId, planId) =>
  req(`/api/doctor/patients/${patientId}/plan/${planId}/cancel`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify({}),
  });

// =========================================================
// SESIONES
// =========================================================

export const startSession = payload =>
  req("/api/sessions/start", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

export const pauseSession = sesionId =>
  req(`/api/sessions/${sesionId}/pause`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) });

export const finishSession = (sesionId, payload) =>
  req(`/api/sessions/${sesionId}/finish`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

export const fetchSessions = pacienteId =>
  req(`/api/patients/${pacienteId}/sessions`);

export const fetchSessionDetail = sesionId =>
  req(`/api/sessions/${sesionId}`);

export const fetchMeasurements = sesionId =>
  req(`/api/sessions/${sesionId}/measurements`);

/** Compatibilidad legacy: guarda sesión sin start/finish explícito */
export const saveSessionLegacy = payload =>
  req("/api/sesiones", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

// =========================================================
// CONTROL Y MODOS
// =========================================================

export const fetchControl = pacienteId =>
  req(`/api/patient/${pacienteId}/control`, { headers: tutorHeaders() });

export const tutorRequestMode = (pacienteId, mode) =>
  req(`/api/patient/${pacienteId}/mode-request`, {
    method: "POST",
    headers: tutorHeaders(JSON_HEADERS),
    body: JSON.stringify({ mode }),
  });

export const doctorSetMode = (patientId, mode) =>
  req(`/api/doctor/patients/${patientId}/mode`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify({ mode }),
  });

export const doctorSetHeight = (patientId, dir) =>
  req(`/api/doctor/patients/${patientId}/height`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify({ dir }),
  });

export const updateControl = (patientId, payload) =>
  req(`/api/doctor/patients/${patientId}/control`, {
    method: "POST",
    headers: doctorHeaders(JSON_HEADERS),
    body: JSON.stringify(payload),
  });

// =========================================================
// ALARMAS
// =========================================================

export const fetchAlarms = pacienteId =>
  req(`/api/patients/${pacienteId}/alarms`);

export const muteAlarm = (alarmId, until = null) =>
  req(`/api/alarms/${alarmId}/mute`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ until }) });

// =========================================================
// EVENTOS
// =========================================================

export const fetchEvents = pacienteId =>
  req(`/api/patients/${pacienteId}/events`);

export const fetchESP32State = () =>
  req("/api/esp32/state");

export const registerAlarm = payload =>
  req("/api/alarmas", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });

// =========================================================
// EXPORTACIÓN EXCEL
// =========================================================

export async function exportExcel(pacienteId) {
  const res = await fetch(`${API_URL}/api/export/${pacienteId}`);
  if (!res.ok) throw new Error("export_failed");
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `datos_fototerapia_${pacienteId}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
