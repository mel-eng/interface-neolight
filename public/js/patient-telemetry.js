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
    clearPatientSensorCards(data?.esp32_connected === false ? "Lámpara sin conexión" : "Sin terapia activa");
    setRestingCard(data?.esp32_connected === false ? "offline" : data?.pausado ? "paused" : "resting");
    renderPatientCharts();
    return;
  }
  setRestingCard(null);

  // null significa "sin lectura": Number(null) daría 0 y mostraría un valor falso.
  const num = value => (value == null || value === "" ? NaN : Number(value));
  const distance = num(data.cm ?? data.distance_cm);
  const measuredLight = num(data.pct ?? data.illumination_pct);      // luz que miden los sensores LDR
  const pwm = num(data.pwm ?? data.pwm_led);                          // intensidad que la lámpara entrega a los LED
  const babyTemperature = num(data.temp_bebe ?? data.bebe);
  const ambientTemperature = num(data.temp_ambiente ?? data.ambiente);

  if (Number.isFinite(pwm)) updatePatientLight(pwm, measuredLight);
  else if (Number.isFinite(measuredLight)) updatePatientLight(measuredLight, NaN);
  if (data.ultraFail) {
    setText("patientDistance", "—");
    setText("patientDistanceStatus", "El sensor de distancia no responde");
    setProgress("patientDistanceBar", 0);
  } else if (Number.isFinite(distance)) updatePatientDistance(distance, data.ventana, data.en_ventana);
  if (Number.isFinite(babyTemperature)) updatePatientBabyTemp(babyTemperature);
  else { setText("patientBabyTemp", "—"); setText("patientBabyTempStatus", "Sin sensor de temperatura corporal"); }
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

// Con la lámpara en reposo (o sin conexión) las cuatro tarjetas se reemplazan por una sola,
// con unos ojitos dormidos, para que se entienda de un vistazo que no hay luz encendida.
const RESTING = {
  resting: { title: "Lámpara en reposo", text: "La luz está apagada. Las mediciones aparecen cuando inicia la terapia." },
  paused:  { title: "Terapia en pausa", text: "La luz está apagada por un momento. Las mediciones vuelven al reanudar." },
  offline: { title: "Lámpara sin conexión", text: "Cuando la lámpara se encienda y tenga internet, verás aquí sus mediciones." },
  other:   { title: "Lámpara en uso", text: "La lámpara está atendiendo a otro paciente en este momento." },
};
const SLEEPY_EYES = `
  <svg class="pt-rest-eyes" viewBox="0 0 160 70" aria-hidden="true">
    <path d="M18 34 Q42 54 66 34" />
    <path d="M94 34 Q118 54 142 34" />
    <path class="lash" d="M26 41 l-5 7 M38 46 l-2 8 M50 46 l2 8 M62 41 l5 7" />
    <path class="lash" d="M102 41 l-5 7 M114 46 l-2 8 M126 46 l2 8 M138 41 l5 7" />
    <text class="z z1" x="138" y="18">z</text><text class="z z2" x="148" y="9">z</text>
  </svg>`;
const OFFLINE_ICON = `
  <svg class="pt-rest-eyes is-offline" viewBox="0 0 160 70" aria-hidden="true">
    <path d="M58 22 v14 M74 22 v14 M50 36 h32 v8 a16 16 0 0 1 -32 0 z M66 60 v8" />
    <path d="M96 30 l24 24 M120 30 l-24 24" />
  </svg>`;

export function setRestingCard(kind) {
  const grid = document.querySelector("#view-dashboard-patient .pt-side-metric-grid");
  if (!grid) return;
  let card = grid.querySelector(".pt-rest-card");
  if (!kind) { grid.classList.remove("is-resting"); card?.remove(); return; }
  if (!card) {
    card = document.createElement("div");
    card.className = "pt-rest-card";
    card.setAttribute("role", "status");
    grid.appendChild(card);
  }
  if (card.dataset.kind !== kind) {
    const t = RESTING[kind];
    card.dataset.kind = kind;
    card.innerHTML = `${kind === "offline" ? OFFLINE_ICON : SLEEPY_EYES}<strong></strong><span></span>`;
    card.querySelector("strong").textContent = t.title;
    card.querySelector("span").textContent = t.text;
  }
  grid.classList.add("is-resting");
}

export function clearPatientSensorCards(reason = "Sin terapia activa") {
  setText("patientLightLevel", "—");
  setText("patientDistance", "—");
  setText("patientBabyTemp", "—");
  setText("patientAmbientTemp", "—");
  setText("patientHeroPWM", "—");
  setText("patientLightStatus", reason);
  setText("patientDistanceStatus", reason);
  setText("patientBabyTempStatus", reason);
  setText("patientAmbientTempStatus", reason);
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

function updatePatientLight(value, measured) {
  const percentage = clamp(Math.round(value), 0, 100);
  setText("patientLightLevel", `${percentage}%`);
  setText("patientLightStatus", percentage === 0
    ? "LED apagados: la lámpara está fuera de la distancia segura"
    : Number.isFinite(measured) ? `Luz medida por los sensores: ${Math.round(measured)} %` : "LED encendidos");
  setProgress("patientLightBar", percentage);
  pushSeries(sensorSeries.light, percentage);
}

// La ventana segura (mínimo y máximo) la envía el servidor según el modo de la lámpara.
function updatePatientDistance(value, ventana = null, enVentana = null) {
  const centimeters = Math.round(value);
  setText("patientDistance", `${centimeters} cm`);
  let status = "Distancia medida";
  if (ventana && enVentana === true) status = `Correcta (rango ${ventana.min}–${ventana.max} cm)`;
  else if (ventana && centimeters < ventana.min) status = `Muy cerca (mínimo ${ventana.min} cm)`;
  else if (ventana && centimeters > ventana.max) status = `Muy lejos (máximo ${ventana.max} cm)`;
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
  setText("patientAmbientTempStatus", temperature > 30 ? "Ambiente caluroso" : "Ambiente normal");
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
