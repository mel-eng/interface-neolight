// =========================================================
// public/js/patient-history.js
// Historial de sesiones, eventos y alarmas del paciente.
// =========================================================

import { $ } from "./config.js";
import { fetchAlarms, fetchEvents, fetchSessions } from "./api.js";

export async function loadRecentAlarms(patientId) {
  try {
    const { ok, data } = await fetchAlarms(patientId);
    const alarms = data?.alarms || [];
    renderPatientAlarms(alarms);
    if (!ok || !alarms.length) return;

    const criticals = alarms.filter(alarm => !alarm.silenciada && alarm.severidad === "critical");
    if (!criticals.length) return;
    const statusDetail = $("statusDetail");
    if (statusDetail) statusDetail.textContent += ` - ${criticals.length} alarma(s) crítica(s) activa(s).`;
  } catch (_) {
    renderPatientAlarms([]);
  }
}

export async function loadPatientHistory(patientId) {
  if (!patientId) return;
  try {
    const [sessionsResponse, eventsResponse] = await Promise.all([
      fetchSessions(patientId),
      fetchEvents(patientId),
    ]);
    renderHistoryRows(sessionsResponse.data?.sessions || [], eventsResponse.data?.events || []);
  } catch (_) {
    renderHistoryRows([], []);
  }
}

export function controlLabel(control) {
  const mode = String(control?.modo_control || "bloqueado").toLowerCase();
  if (mode === "manual") return "Manual habilitado";
  if (mode === "automatico") return "Automático";
  return "Bloqueado";
}

export function labelGenero(value) {
  const normalized = String(value || "").replace("_", " ");
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "-";
}

function renderHistoryRows(sessions = [], events = []) {
  const tableBody = $("patientHistoryRows");
  if (!tableBody) return;

  const rows = [
    ...sessions.slice(0, 5).map(session => ({
      date: session.fecha || session.created_at,
      type: "Sesión",
      detail: `${session.modo_programado || "-"} · ${secondsLabel(session.duracion_s)} · ${session.status || "-"}`,
    })),
    ...events.slice(0, 5).map(event => ({
      date: event.created_at,
      type: "Evento",
      detail: event.descripcion || event.tipo || "-",
    })),
  ].sort((first, second) => new Date(second.date || 0) - new Date(first.date || 0)).slice(0, 8);

  const railTableBody = $("patientRailHistoryRows");
  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="3">Sin datos</td></tr>`;
    if (railTableBody) railTableBody.innerHTML = tableBody.innerHTML;
    return;
  }

  const clockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15.5,14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const tagIcons = {
    sesion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h4"/></svg>',
    lectura: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
    cambio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 4l3 3-3 3"/><path d="M20 7H8"/><path d="M7 20l-3-3 3-3"/><path d="M4 17h12"/></svg>',
    ingreso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    evento: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h4"/></svg>',
  };

  tableBody.innerHTML = rows.map(row => {
    const cssClass = tagClass(row.type);
    return `<tr>
      <td><span class="td-date">${clockIcon}${formatDate(row.date)}</span></td>
      <td><span class="tag ${cssClass}">${tagIcons[cssClass] || ""}${escapeText(row.type)}</span></td>
      <td>${escapeText(row.detail)}</td>
    </tr>`;
  }).join("");

  if (railTableBody) railTableBody.innerHTML = tableBody.innerHTML;
}

function renderPatientAlarms(alarms = []) {
  const mainContainer = $("patientAlarmsList");
  const railContainer = $("patientRailAlarmsList");
  const emptyHtml = `<div class="empty-note">Sin alarmas · No hay registros recientes.</div>`;

  if (!alarms.length) {
    if (mainContainer) mainContainer.innerHTML = emptyHtml;
    if (railContainer) railContainer.innerHTML = emptyHtml;
    updateAlertCard(0);
    return;
  }

  const triangleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const clockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15.5,14" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const html = alarms.slice(0, 5).map(alarm => {
    const [level, severityLabel] = severityInfo(alarm.severidad);
    const silenced = alarm.silenciada ? `<span class="ar-silenced">SILENCIADA</span>` : "";
    return `<div class="alert-row ${level}">
      <div class="ar-ico">${triangleIcon}</div>
      <div class="ar-body">
        <div class="ar-title">${escapeText(alarm.tipo || "Alarma")}${silenced}</div>
        <div class="ar-desc">${escapeText(alarm.mensaje || alarm.valor_medido || "")}</div>
        <div class="ar-time">${clockIcon}${formatDate(alarm.created_at)}</div>
      </div>
      <span class="ar-sev">${severityLabel}</span>
    </div>`;
  }).join("");

  if (mainContainer) mainContainer.innerHTML = html;
  if (railContainer) railContainer.innerHTML = html;
  updateAlertCard(alarms.filter(alarm => !alarm.silenciada).length);
}

function updateAlertCard(count) {
  const card = $("ptAlertCard");
  const message = $("ptAlertMsg");
  const counter = $("ptAlertCount");
  const badge = $("ptBellBadge");

  if (count > 0) {
    card?.classList.add("pt-has-alert");
    const label = `${count} alarma${count > 1 ? "s" : ""} activa${count > 1 ? "s" : ""}`;
    if (message) message.textContent = label;
    if (counter) counter.textContent = `${count} alarma${count > 1 ? "s" : ""}`;
    badge?.classList.add("pt-badge-visible");
    return;
  }

  card?.classList.remove("pt-has-alert");
  if (message) message.textContent = "Sin alarmas activas";
  if (counter) counter.textContent = "";
  badge?.classList.remove("pt-badge-visible");
}

function severityInfo(value) {
  const severity = String(value || "").toLowerCase();
  if (["critical", "critica", "crítica", "crit"].includes(severity)) return ["crit", "CRÍTICA"];
  if (["warning", "warn", "advertencia"].includes(severity)) return ["warn", "ADVERTENCIA"];
  return ["info", "INFO"];
}

function tagClass(value) {
  if (/sesi/i.test(value)) return "sesion";
  if (/lectur/i.test(value)) return "lectura";
  if (/cambio/i.test(value)) return "cambio";
  if (/ingres/i.test(value)) return "ingreso";
  return "evento";
}

function secondsLabel(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return "00:00:00";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = Math.floor(total % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("es");
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}
