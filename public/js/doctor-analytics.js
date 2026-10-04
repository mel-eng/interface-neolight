// =========================================================
// public/js/doctor-analytics.js
// Gráficos, distribución clínica y alertas del panel médico.
// =========================================================

import { $, escapeHtml, normalizeMode } from "./config.js";

export function renderDoctorCharts(patients = [], _requests = [], alerts = {}) {
  renderPatientStateChart(patients);
  renderSessionModeChart(alerts.sessions || []);
  renderAlertChart(alerts.recent || alerts.alarms || [], alerts.summary || null);
}

export function renderDoctorAlerts(alarms = []) {
  const box = $("doctorAlertsList");
  if (!box) return;
  if (!alarms.length) {
    box.innerHTML = `<div class="dp-empty">Sin alertas recientes.</div>`;
    return;
  }

  box.innerHTML = alarms.slice(0, 6).map(alarm => {
    const severity = String(alarm.severidad || "warning").toLowerCase();
    const cssClass = alarm.silenciada ? "muted" : (severity === "critical" ? "critical" : "warning");
    return `<div class="doc-alert-row">
      <span class="doc-alert-dot ${cssClass}"></span>
      <div>
        <div class="doc-alert-title">${escapeHtml(alarm.tipo || "Alerta")} · ${escapeHtml(alarm.patientCode || "—")}</div>
        <div class="doc-alert-sub">${escapeHtml(alarm.patientName || "Paciente")} · ${formatDate(alarm.created_at)}</div>
      </div>
    </div>`;
  }).join("");
}

function renderPatientStateChart(patients = []) {
  const box = $("chartPatientStates");
  if (!box) return;

  const counts = { ok: 0, observacion: 0, riesgo: 0, alta: 0 };
  patients.forEach(patient => {
    const key = normalizeClinicalState(patient.estado_clinico);
    counts[key] = (counts[key] || 0) + 1;
  });
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!total) return renderChartEmpty(box);

  const rows = [
    ["OK", counts.ok, "#79b88f"],
    ["Observación", counts.observacion, "#e6c86e"],
    ["Riesgo", counts.riesgo, "#e1849c"],
    ["Alta", counts.alta, "#8db9e8"],
  ];
  let offset = 25;
  const circles = rows.map(([, value, color]) => {
    const dash = (value / total) * 100;
    const segment = `<circle class="doc-donut-seg" r="15.9" cx="18" cy="18" style="stroke:${color};stroke-dasharray:${dash} ${100 - dash};stroke-dashoffset:${offset};"></circle>`;
    offset -= dash;
    return segment;
  }).join("");

  box.innerHTML = `
    <div class="doc-donut-wrap">
      <svg class="doc-donut" viewBox="0 0 36 36" aria-label="Distribución de pacientes por estado clínico">
        <circle class="doc-donut-bg" r="15.9" cx="18" cy="18"></circle>
        ${circles}
        <text x="18" y="19.5" text-anchor="middle">${total}</text>
      </svg>
      <div class="doc-chart-legend">
        ${rows.map(([label, value, color]) => `<span><i style="background:${color}"></i>${escapeHtml(label)} <b>${value}</b></span>`).join("")}
      </div>
    </div>`;
}

function renderSessionModeChart(sessions = []) {
  const box = $("chartSessionModes");
  if (!box) return;

  const counts = { reposo: 0, convencional: 0, intensivo: 0, automatico: 0 };
  sessions.forEach(session => {
    const mode = normalizeMode(session.modo_final || session.modo_programado || session.modo) || "reposo";
    counts[mode] = (counts[mode] || 0) + 1;
  });
  const max = Math.max(...Object.values(counts));
  if (!max) return renderChartEmpty(box);

  const rows = [
    ["Reposo", counts.reposo, "#b9c6d4"],
    ["Conv.", counts.convencional, "#99b8dd"],
    ["Intens.", counts.intensivo, "#b09af8"],
    ["Auto", counts.automatico, "#8dd4bd"],
  ];
  box.innerHTML = `<div class="doc-bars">${rows.map(([label, value, color]) => `
    <div class="doc-bar-item">
      <div class="doc-bar-track"><span style="height:${Math.max(8, (value / max) * 100)}%;background:${color}"></span></div>
      <strong>${value}</strong>
      <small>${escapeHtml(label)}</small>
    </div>`).join("")}</div>`;
}

function renderAlertChart(alarms = [], summary = null) {
  const box = $("chartRecentAlerts");
  if (!box) return;
  if (!alarms.length && !summary) return renderChartEmpty(box);

  const counts = alarms.reduce((acc, alarm) => {
    const severity = String(alarm.severidad || "").toLowerCase();
    if (alarm.silenciada) acc.silenciadas += 1;
    else if (["critical", "critica", "crítica"].includes(severity)) acc.criticas += 1;
    else acc.warning += 1;
    return acc;
  }, {
    criticas: Number(summary?.critical || 0),
    warning: Number(summary?.warning || 0),
    silenciadas: Number(summary?.silenced || 0),
  });

  box.innerHTML = `<div class="doc-alert-chips">
    <span class="doc-alert-chip critical"><b>${counts.criticas}</b> Críticas</span>
    <span class="doc-alert-chip warning"><b>${counts.warning}</b> Warning</span>
    <span class="doc-alert-chip muted"><b>${counts.silenciadas}</b> Silenciadas</span>
  </div>`;
}

function renderChartEmpty(box) {
  box.innerHTML = `<div class="doc-chart-empty">Sin datos suficientes</div>`;
}

function normalizeClinicalState(value) {
  const state = String(value || "ok").toLowerCase();
  if (state.includes("alta")) return "alta";
  if (state.includes("riesgo") || state.includes("peligro")) return "riesgo";
  if (state.includes("observ")) return "observacion";
  return "ok";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("es");
}
