// =========================================================
// public/js/patient-report.js
// Reporte imprimible del seguimiento del paciente.
// =========================================================

import { $ } from "./config.js";

export function downloadPatientPdfReport() {
  renderPatientPdfReport();
  const report = $("patientPdfReport");
  if (report) report.setAttribute("aria-hidden", "false");
  window.print();
  window.setTimeout(() => report?.setAttribute("aria-hidden", "true"), 500);
}

export function renderPatientPdfReport() {
  const report = $("patientPdfReport");
  if (!report) return;

  const ledChart = canvasData("patientLedChart");
  const tempChart = canvasData("patientTempChart");
  const distanceChart = canvasData("patientDistanceChart");
  const progress = $("patientProgressChartText")?.textContent || "0%";

  report.innerHTML = `
    <div class="pdf-header">
      <div>
        <div class="pdf-brand">NEOLIGHT</div>
        <h1>Reporte de seguimiento paciente</h1>
        <p>Generado: ${escapeText(new Date().toLocaleString("es"))}</p>
      </div>
      <div class="pdf-doctor-box">
        <strong>${escapeText($("pacienteNombre")?.textContent || "-")}</strong>
        <span>${escapeText($("pacienteCodigo")?.textContent || "-")}</span>
        <span>${escapeText($("pacienteDoctor")?.textContent || "-")}</span>
      </div>
    </div>
    <div class="pdf-kpi-grid">
      ${pdfKpi("Intensidad LED", $("patientLightLevel")?.textContent || "-")}
      ${pdfKpi("Distancia", $("patientDistance")?.textContent || "-")}
      ${pdfKpi("Temperatura bebé", $("patientBabyTemp")?.textContent || "-")}
      ${pdfKpi("Ambiente", $("patientAmbientTemp")?.textContent || "-")}
    </div>
    <section class="pdf-section">
      <h2>Gráficos de seguimiento</h2>
      <div class="pdf-chart-grid">
        ${pdfChart("Intensidad LED vs tiempo", ledChart)}
        ${pdfChart("Temperatura bebé / ambiente", tempChart)}
        ${pdfChart("Distancia lámpara", distanceChart)}
        <div class="pdf-chart-card"><h3>Progreso terapia</h3><div class="pdf-progress-circle">${escapeText(progress)}</div></div>
      </div>
    </section>
    <section class="pdf-section"><h2>Progreso terapia</h2><div class="pdf-empty">${escapeText($("pacienteProgreso")?.textContent || "-")}</div></section>
    <section class="pdf-section"><h2>Historial</h2><table class="pdf-table">${$("patientHistoryRows")?.innerHTML || "<tr><td>Sin datos</td></tr>"}</table></section>
    <section class="pdf-section"><h2>Alertas</h2><div class="pdf-empty">${escapeText($("patientAlarmsList")?.innerText || "Sin alertas")}</div></section>`;
}

function pdfKpi(label, value) {
  return `<div class="pdf-kpi"><span>${escapeText(label)}</span><strong>${escapeText(value)}</strong></div>`;
}

function canvasData(id) {
  const canvas = $(id);
  if (!canvas?.toDataURL) return "";
  try {
    return canvas.toDataURL("image/png");
  } catch (_) {
    return "";
  }
}

function pdfChart(title, src) {
  return `<div class="pdf-chart-card"><h3>${escapeText(title)}</h3>${src ? `<img src="${src}" alt="${escapeText(title)}">` : `<div class="pdf-empty">Sin datos suficientes</div>`}</div>`;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}
