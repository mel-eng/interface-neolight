import { API_URL, superuserHeaders } from "./config.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function req(path, options = {}) {
  try {
    const response = await fetch(`${API_URL}${path}`, options);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    return { ok: response.ok && data?.ok !== false, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: "network_error", message: error?.message || "Sin conexión" } };
  }
}

export const fetchSuperuserOverview = () =>
  req("/api/superuser/overview", { headers: superuserHeaders() });

export const fetchSuperuserUsers = () =>
  req("/api/superuser/users", { headers: superuserHeaders() });

export const reassignPatient = (patientId, doctorId, reason = "") =>
  req(`/api/superuser/patients/${encodeURIComponent(patientId)}/reassign`, {
    method: "POST",
    headers: superuserHeaders(JSON_HEADERS),
    body: JSON.stringify({ doctor_id: doctorId, reason }),
  });

export const updateDoctorStatus = (doctorId, status, reassignTo = null) =>
  req(`/api/superuser/doctors/${encodeURIComponent(doctorId)}/status`, {
    method: "PATCH",
    headers: superuserHeaders(JSON_HEADERS),
    body: JSON.stringify({ status, reassign_to: reassignTo }),
  });

export const fetchTelemetry = () => req("/api/telemetry/latest");
export const fetchHealth = () => req("/api/health");
export const setFanState = state => req("/api/fan", {
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify({ state }),
});
