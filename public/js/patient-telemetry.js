// =========================================================
// public/js/patient-telemetry.js
// Render de sensores, series temporales y gráficas del paciente.
// =========================================================

import { $, normalizeMode } from "./config.js";

const THERAPY_MODES = new Set(["convencional", "intensivo", "automatico"]);
const sensorSeries = {
  light: [],
  distance: [],
  baby: [],
  ambient: [],
};

export function updatePatientSensorCards(data = {}, { getCurrentMode, onModeChange } = {}) {
  const modeRaw = data.modo_actual ?? data.modo ?? data.mode;
  if (modeRaw) {
    const normalized = normalizeMode(modeRaw);
    if (normalized && typeof onModeChange === "function") onModeChange(normalized);
    setText("patientMode", String(modeRaw).toUpperCase());
  }

  const currentMode = normalizeMode(modeRaw) || normalizeMode(getCurrentMode?.()) || "reposo";

  if (!isPatientTelemetryVisible(data, currentMode)) {
    clearPatientSensorCards(data?.esp32_connected === false ? "ESP desconectado" : "Sin terapia activa");
    renderPatientCharts();
    return;
  }

  const distance = Number(data.cm ?? data.distance_cm ?? data.distance);
  const light = Number(data.pct ?? data.percent ?? data.illumination_pct ?? data.illumination ?? data.intensidad_led_pct);
  const babyTemperature = Number(data.bebe ?? data.temp_bebe ?? data.temp_body_c);
  const ambientTemperature = Number(data.ambiente ?? data.temp_ambiente ?? data.temp_amb_c);
  const pwm = Number(data.pwm ?? data.pwm_led);

  if (Number.isFinite(light)) updatePatientLight(light);
  if (Number.isFinite(distance)) updatePatientDistance(distance);
  if (Number.isFinite(babyTemperature)) updatePatientBabyTemp(babyTemperature);
  if (Number.isFinite(ambientTemperature)) updatePatientAmbientTemp(ambientTemperature);
  if (Number.isFinite(pwm)) updatePatientPWM(pwm);
  renderPatientCharts();
}

export function isPatientTelemetryVisible(data = {}, currentMode = "reposo") {
  const payloadMode = normalizeMode(data.modo_actual ?? data.modo ?? data.mode);
  const mode = payloadMode || normalizeMode(currentMode) || "reposo";
  return data?.esp32_connected !== false
    && data?.terapiaActiva !== false
    && THERAPY_MODES.has(mode);
}

export function clearPatientSensorCards(reason = "Sin terapia activa") {
  setText("patientLightLevel", "—");
  setText("patientDistance", "—");
  setText("patientBabyTemp", "—");
  setText("patientAmbientTemp", "—");
  setText("patientHeroPWM", "—");
  setText("patientLightStatus", reason);
  setText("patientDistanceStatus", reason);
  setText("patientBabyTempStatus", reason === "ESP desconectado" ? "Sin lectura" : reason);
  setText("patientAmbientTempStatus", reason === "ESP desconectado" ? "Sin lectura" : reason);
  setProgress("patientLightBar", 0);
  setProgress("patientDistanceBar", 0);
}

export function renderPatientCharts() {
  drawLineChart("patientLedChart", [sensorSeries.light], ["#e3b23c"], 0, 100);
  drawLineChart("patientDistanceChart", [sensorSeries.distance], ["#6f9db3"], 0, 60);
  drawLineChart("patientTempChart", [sensorSeries.baby, sensorSeries.ambient], ["#e88f7c", "#7a57d1"], 25, 40);
}

function updatePatientPWM(value) {
  const percentage = clamp(Math.round(value), 0, 100);
  setText("patientHeroPWM", `${percentage} %`);
}

function updatePatientLight(value) {
  const percentage = clamp(Math.round(value), 0, 100);
  setText("patientLightLevel", `${percentage}%`);
  setText("patientLightStatus", percentage >= 60 && percentage <= 95 ? "Dentro del rango terapéutico" : "Revisar intensidad LED");
  setProgress("patientLightBar", percentage);
  pushSeries(sensorSeries.light, percentage);
}

function updatePatientDistance(value) {
  const centimeters = Math.round(value);
  setText("patientDistance", `${centimeters} cm`);
  const status = centimeters >= 25 && centimeters <= 45
    ? "Distancia correcta"
    : centimeters < 20 ? "Peligro: muy cerca" : "Fuera de rango";
  setText("patientDistanceStatus", status);
  setProgress("patientDistanceBar", clamp((centimeters / 60) * 100, 0, 100));
  pushSeries(sensorSeries.distance, centimeters);
}

function updatePatientBabyTemp(value) {
  const temperature = Number(value);
  setText("patientBabyTemp", `${temperature.toFixed(1)}°C`);
  setText("patientBabyTempStatus", temperature >= 34.8 && temperature <= 38.0 ? "Temperatura en rango" : "Revisar temperatura");
  pushSeries(sensorSeries.baby, temperature);
}

function updatePatientAmbientTemp(value) {
  const temperature = Number(value);
  setText("patientAmbientTemp", `${temperature.toFixed(1)}°C`);
  setText("patientAmbientTempStatus", temperature > 30 ? "Ambiente elevado · activar ventilación" : "Lectura ambiental");
  pushSeries(sensorSeries.ambient, temperature);
}

function pushSeries(series, value) {
  series.push(Number(value));
  if (series.length > 24) series.shift();
}

function drawLineChart(id, seriesList, colors, minY, maxY) {
  const canvas = $(id);
  if (!canvas?.getContext) return;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbf6f1";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(122,87,209,.12)";
  context.lineWidth = 1;

  for (let index = 1; index < 4; index += 1) {
    const y = (height / 4) * index;
    context.beginPath();
    context.moveTo(12, y);
    context.lineTo(width - 12, y);
    context.stroke();
  }

  seriesList.forEach((series, seriesIndex) => {
    if (!series.length) {
      context.fillStyle = "#6a6377";
      context.font = "12px Inter, sans-serif";
      context.fillText("Sin datos suficientes", 18, height / 2);
      return;
    }
    context.strokeStyle = colors[seriesIndex] || "#7a57d1";
    context.lineWidth = 3;
    context.beginPath();
    series.forEach((value, valueIndex) => {
      const x = 16 + (valueIndex / Math.max(1, series.length - 1)) * (width - 32);
      const y = height - 16 - ((value - minY) / Math.max(1, maxY - minY)) * (height - 32);
      if (valueIndex === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  });
}

function setProgress(id, percentage) {
  const element = $(id);
  if (element) element.style.width = `${clamp(percentage, 0, 100)}%`;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
