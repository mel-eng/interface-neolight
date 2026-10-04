// =========================================================
// public/js/doctor-report.js
// Construcción y descarga del reporte imprimible del médico.
// =========================================================

import { $, escapeHtml, normalizeMode, formatDoctorDisplayName } from "./config.js";

export function renderDoctorPdfData({ doctor = null, patients = [], requests = [], alerts = {} } = {}) {
  const report = $("doctorPdfReport");
  if (!report) return;

  const doctorName = formatDoctorDisplayName(doctor, "Doctor");
  const activeSessions = patients.filter(patient => Number(patient.sesiones_activas || 0) > 0).length;
  const generatedAt = new Date().toLocaleString("es");
  const sessions = alerts.sessions || [];
  const events = alerts.events || [];
  const alarms = alerts.recent || [];
  const chartsHtml = renderPdfCharts(patients, sessions, alarms);
  const systemRows = [
    ["MySQL", "Conexión por API"],
    ["ESP32", "Sistema activo / pendiente de telemetría"],
    ["Socket.IO", "Tiempo real habilitado"],
  ];

  report.innerHTML = `
    <div class="pdf-header">
      <div>
        <div class="pdf-brand">NEOLIGHT</div>
        <h1>Resumen del perfil doctor</h1>
        <p>Generado: ${escapeHtml(generatedAt)}</p>
      </div>
      <div class="pdf-doctor-box">
        <strong>${escapeHtml(doctorName)}</strong>
        <span>${escapeHtml(doctor?.especialidad || "Especialidad no registrada")}</span>
        <span>Matrícula: ${escapeHtml(doctor?.matricula || doctor?.matricula_profesional || "—")}</span>
      </div>
    </div>

    <div class="pdf-kpi-grid">
      ${pdfKpi("Pacientes asignados", patients.length)}
      ${pdfKpi("Solicitudes pendientes", requests.length)}
      ${pdfKpi("Alertas del día", alerts.today || 0)}
      ${pdfKpi("Sesiones activas", activeSessions)}
    </div>

    <section class="pdf-section">
      <h2>Gráficos del resumen</h2>
      ${chartsHtml}
    </section>

    <section class="pdf-section">
      <h2>Pacientes recientes</h2>
      ${pdfTable(["Código", "Nombre", "Días nacido", "Estado clínico", "Tutor"], patients.slice(0, 12).map(patient => [
        patient.codigo || "—",
        `${patient.nombre || ""} ${patient.apellidos || ""}`.trim() || "Paciente",
        patient.dias_nacido ?? "—",
        patient.estado_clinico || "—",
        `${patient.tutor_nombre || ""} ${patient.tutor_apellidos || ""}`.trim() || "—",
      ]))}
    </section>

    <section class="pdf-section">
      <h2>Solicitudes pendientes</h2>
      ${pdfTable(["Paciente", "Tipo", "Detalle"], requests.slice(0, 10).map(request => [
        `${request.nombre || request.paciente_nombre || ""} ${request.apellidos || request.paciente_apellidos || ""}`.trim() || "Paciente",
        request.mode || request.modo ? "Cambio de modo" : "Ingreso",
        request.mode || request.modo || request.doctor_request_status || "Pendiente",
      ]))}
    </section>

    <section class="pdf-section">
      <h2>Últimos eventos disponibles</h2>
      ${pdfTable(["Fecha", "Paciente", "Tipo", "Detalle"], events.slice(0, 8).map(event => [
        formatDate(event.created_at),
        event.patientName || event.patientCode || "—",
        event.tipo || "—",
        event.descripcion || event.actor || "—",
      ]))}
    </section>

    <section class="pdf-section">
      <h2>Últimas sesiones</h2>
      ${pdfTable(["Fecha", "Paciente", "Modo", "Duración", "Estado"], sessions.slice(0, 8).map(session => [
        formatDate(session.fecha || session.created_at),
        session.patientName || session.patientCode || "—",
        session.modo_final || session.modo_programado || "—",
        secondsLabel(session.duracion_s),
        session.status || "—",
      ]))}
    </section>

    <section class="pdf-section">
      <h2>Alarmas recientes</h2>
      ${pdfTable(["Fecha", "Paciente", "Tipo", "Severidad", "Mensaje"], alarms.slice(0, 8).map(alarm => [
        formatDate(alarm.created_at),
        alarm.patientName || alarm.patientCode || "—",
        alarm.tipo || "—",
        alarm.severidad || "—",
        alarm.mensaje || alarm.valor_medido || "—",
      ]))}
    </section>

    <section class="pdf-section">
      <h2>Estado del sistema</h2>
      ${pdfTable(["Componente", "Estado"], systemRows)}
    </section>`;
}

export function downloadDoctorPdfReport(context = {}) {
  renderDoctorPdfData(context);
  const report = $("doctorPdfReport");
  if (report) report.setAttribute("aria-hidden", "false");
  window.print();
  window.setTimeout(() => report?.setAttribute("aria-hidden", "true"), 500);
}

export function bindDoctorReportButton(getContext) {
  $("downloadDoctorPdfBtn")?.addEventListener("click", () => {
    const context = typeof getContext === "function" ? getContext() : {};
    downloadDoctorPdfReport(context);
  });
}

function renderPdfCharts(patients = [], sessions = [], alarms = []) {
  const stateCounts = { ok: 0, observacion: 0, riesgo: 0, alta: 0 };
  patients.forEach(patient => { stateCounts[normalizeClinicalState(patient.estado_clinico)] += 1; });

  const modeCounts = { reposo: 0, convencional: 0, intensivo: 0, automatico: 0 };
  sessions.forEach(session => {
    const mode = normalizeMode(session.modo_final || session.modo_programado || session.modo) || "reposo";
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;
  });

  const alertCounts = alarms.reduce((acc, alarm) => {
    const severity = String(alarm.severidad || "").toLowerCase();
    if (alarm.silenciada) acc.silenciadas += 1;
    else if (["critical", "critica", "crítica"].includes(severity)) acc.criticas += 1;
    else acc.warning += 1;
    return acc;
  }, { criticas: 0, warning: 0, silenciadas: 0 });

  return `<div class="pdf-chart-grid">
    ${pdfBarChart("Estados clínicos", [
      ["OK", stateCounts.ok],
      ["Observación", stateCounts.observacion],
      ["Riesgo", stateCounts.riesgo],
      ["Alta", stateCounts.alta],
    ])}
    ${pdfBarChart("Sesiones por modo", [
      ["Reposo", modeCounts.reposo],
      ["Conv.", modeCounts.convencional],
      ["Intens.", modeCounts.intensivo],
      ["Auto", modeCounts.automatico],
    ])}
    ${pdfBarChart("Alertas recientes", [
      ["Críticas", alertCounts.criticas],
      ["Avisos", alertCounts.warning],
      ["Resueltas", alertCounts.silenciadas],
    ])}
  </div>`;
}

function pdfBarChart(title, rows) {
  const max = Math.max(1, ...rows.map(([, value]) => Number(value) || 0));
  return `<div class="pdf-chart-card">
    <h3>${escapeHtml(title)}</h3>
    <div class="pdf-bars">
      ${rows.map(([label, value]) => `<div class="pdf-bar-row">
        <span>${escapeHtml(label)}</span>
        <div><i style="width:${Math.max(4, (Number(value || 0) / max) * 100)}%"></i></div>
        <b>${escapeHtml(value)}</b>
      </div>`).join("")}
    </div>
  </div>`;
}

function pdfKpi(label, value) {
  return `<div class="pdf-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function pdfTable(headers, rows) {
  if (!rows.length) return `<div class="pdf-empty">Sin datos disponibles.</div>`;
  return `<table class="pdf-table">
    <thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}

function secondsLabel(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = Math.floor(total % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString("es");
}

function normalizeClinicalState(value) {
  const state = String(value || "ok").toLowerCase();
  if (state.includes("alta")) return "alta";
  if (state.includes("riesgo") || state.includes("peligro")) return "riesgo";
  if (state.includes("observ")) return "observacion";
  return "ok";
}
