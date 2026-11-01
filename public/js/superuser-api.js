import { apiFetch, superuserHeaders } from "./config.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function req(path, options = {}) {
  try {
    const response = await apiFetch(path, options);
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

// Calibración de los LDR contra un luxómetro
export const fetchLdrCalibracion = () => req("/api/superuser/ldr-calibracion", { headers: superuserHeaders() });
export const saveLdrPunto = body => req("/api/superuser/ldr-calibracion", { method: "POST", headers: superuserHeaders(JSON_HEADERS), body: JSON.stringify(body) });
export const deleteLdrPunto = id => req(`/api/superuser/ldr-calibracion/${encodeURIComponent(id)}`, { method: "DELETE", headers: superuserHeaders() });
export async function downloadLdrCsv() {
  const res = await apiFetch("/api/superuser/ldr-calibracion.csv", { headers: superuserHeaders() });
  if (!res.ok) throw new Error("csv");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = "calibracion_ldr_lux.csv";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Cuna: lecturas crudas y órdenes de calibración
export const fetchCunaDiagnostico = () => req("/api/superuser/cuna", { headers: superuserHeaders() });
export const sendCunaOrden = (orden, valor = "") =>
  req("/api/superuser/cuna/orden", { method: "POST", headers: superuserHeaders(JSON_HEADERS), body: JSON.stringify({ orden, valor }) });

// Encuesta de satisfacción
export const fetchEncuestas = () => req("/api/superuser/encuestas", { headers: superuserHeaders() });
export const crearInvitacion = (nombre, rol) =>
  req("/api/superuser/encuestas", { method: "POST", headers: superuserHeaders(JSON_HEADERS), body: JSON.stringify({ nombre, rol }) });
export const borrarInvitacion = id =>
  req(`/api/superuser/encuestas/${encodeURIComponent(id)}`, { method: "DELETE", headers: superuserHeaders() });
export async function abrirPdfEncuestas(id = null) {
  const win = window.open("", "_blank");
  if (win) win.document.write('<p style="font-family:sans-serif;padding:24px;color:#555">Preparando el PDF…</p>');
  const res = await apiFetch(`/api/superuser/encuestas/pdf${id ? `?id=${encodeURIComponent(id)}` : ""}`, { headers: superuserHeaders() });
  if (!res.ok) { win?.close(); throw new Error("pdf"); }
  const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/html" }));
  if (win) win.location.href = url; else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
