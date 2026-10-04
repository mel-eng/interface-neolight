// =========================================================
// public/js/patient-dashboard.js
// Panel del tutor/paciente: datos, permisos, bloqueo UI,
// conexion ESP32, alarmas, exportacion y control de modo.
// =========================================================

import { $, state, STORAGE_KEY, normalizeMode, formatEdad, formatDoctorDisplayName, API_URL, humanLabel } from "./config.js";
import { fetchControl, fetchCurrentTutorState, tutorRequestMode, exportExcel } from "./api.js";
import {
  socketEmitMute,
  socketEmitMove,
  socketEmitMode,
  socketIdentifyPatient,
  updateHUD,
  updateTemps,
  updateStatusCard,
  updateMuteButtonFromState,
  isAlarmsMuted,
  getSocket,
  showRealtimeToast,
} from "./socket.js";
import { saveSession, initTimer } from "./sessions.js";
import { doLogout } from "./auth.js";
import { downloadPatientPdfReport } from "./patient-report.js";
import { fetchPatientDoctorSignature } from "./signature.js";
import { bindCameraToggle } from "./patient-camera.js";
import { showStatusOverlay, hideOverlay, showInlineMessage } from "./patient-overlays.js";
import { loadRecentAlarms, loadPatientHistory, controlLabel, labelGenero } from "./patient-history.js";
import {
  clearPatientSensorCards,
  isPatientTelemetryVisible,
  renderPatientCharts,
  updatePatientSensorCards,
} from "./patient-telemetry.js";

// =========================================================
// ESTADO LOCAL DEL DASHBOARD
// =========================================================

const dashboardState = {
  pacienteId: null,
  control: null,
  modoActual: "reposo",
  dashboardLocked: true,
  explicitlyLocked: false,
  unlockVerifier: null,
  unlockTtlMs: null,
  unlockUntil: null,
  lampOnline: false,     // la lámpara está enviando datos
  lampManual: false,     // en el equipo se ingresó la clave física MODE-ARRIBA-ABAJO-MODE
  esp32: {
    connected: false,
    portOpen: false,
    label: "Conectando...",
    kind: "warn",
  },
};

const DOM = {
  modeByButton: {
    reposo: "pacBtnReposo",
    convencional: "pacBtnConvencional",
    intensivo: "pacBtnIntensivo",
  },
};

let _eventsBound = false;
let _controlRefreshBound = false;
let _socketUiRef = null;
let _realtimeRefreshTimer = null;
let _lastTutorStateRefresh = 0;
let _modeRequestPending = false;
let _manualControlRequestPending = false;
let _sectionsBound = false;

const MODE_ERROR_MESSAGES = {
  control_bloqueado: "El doctor mantiene bloqueado el cambio de modo.",
  solicitud_manual_pendiente: "Ya existe una solicitud de control manual pendiente.",
  permiso_expirado: "El permiso manual expiró. Solicita renovación al doctor.",
  modo_invalido_para_tutor: "Este modo no está disponible para el tutor.",
  falta_tutor_id: "No se pudo identificar la cuenta del tutor.",
  paciente_no_encontrado: "No se encontró el paciente asociado.",
};

// =========================================================
// INIT PATIENT DASHBOARD
// =========================================================

export async function initPatientDashboard(sessionSnapshot) {
  const { paciente, tutor, doctor, last_session, plan, session, control, dispositivo } = sessionSnapshot;

  setDashboardState({ paciente, tutor, control });
  renderPatientHeader(paciente, doctor);
  renderClinicalData(paciente, tutor, dispositivo, control);
  renderActivePlan(plan);
  renderSessionTimer(paciente, last_session, session);
  renderLastSessionTemps(last_session);
  renderPatientProfileRail(paciente, tutor, doctor);
  bindPatientSections();
  renderPatientCharts();

  applyControlUI(dashboardState.control);
  bindRightPanelTabs();
  bindCameraToggle();
  bindControlRefresh();

  const { initSocket } = await import("./socket.js");
  initSocket();
  if (paciente?.id) socketIdentifyPatient(paciente.id);
  bindSocketStatusUI();
  refreshESP32Status();

  bindPatientEvents(paciente?.id);
  loadPatientHistory(paciente?.id);
  // Firma del doctor a cargo, para el pie del reporte PDF.
  if (paciente?.id) fetchPatientDoctorSignature(paciente.id).then(doctorSignature => { state.patientDoctorSignature = doctorSignature; });
  scheduleTutorPolling();
}

// =========================================================
// STATE MANAGEMENT
// =========================================================

function setDashboardState({ paciente, tutor, control }) {
  state.currentUserId = paciente?.id ?? null;
  state.currentRole = "tutor";
  state.currentTutorId = tutor?.id ?? null;
  state.pacienteData = paciente;
  state.controlData = control;

  dashboardState.pacienteId = paciente?.id ?? null;
  dashboardState.control = control;
  dashboardState.modoActual = normalizeMode(control?.modo_actual) || dashboardState.modoActual;
  dashboardState.explicitlyLocked = false;
  syncDashboardLockState();
}

async function refreshTutorState(reason = "realtime") {
  const tutorId = state.currentTutorId;
  if (!tutorId) return;
  const now = Date.now();
  if (reason !== "poll" && now - _lastTutorStateRefresh < 600) return;
  _lastTutorStateRefresh = now;

  try {
    const { ok, data } = await fetchCurrentTutorState(tutorId);
    if (!ok) return;
    setDashboardState({ paciente: data.paciente, tutor: data.tutor, control: data.control });
    renderPatientHeader(data.paciente, data.doctor);
    renderClinicalData(data.paciente, data.tutor, data.dispositivo, data.control);
    renderActivePlan(data.plan);
    renderPatientProfileRail(data.paciente, data.tutor, data.doctor);
    applyControlUI(dashboardState.control);
    if (data.paciente?.id) {
      loadRecentAlarms(data.paciente.id);
      loadPatientHistory(data.paciente.id);
    }
  } catch (_) {}
}

function scheduleTutorPolling() {
  if (_realtimeRefreshTimer) return;
  _realtimeRefreshTimer = setInterval(() => refreshTutorState("poll"), 30000);
}

function setControlState(control) {
  dashboardState.control = control;
  state.controlData = control;
}

function setModeState(modo) {
  dashboardState.modoActual = modo;
  state.controlData = { ...(state.controlData || {}), modo_actual: modo };
}

function setDashboardLock(isLocked) {
  dashboardState.explicitlyLocked = !!isLocked;
  dashboardState.unlockUntil = isLocked ? null : dashboardState.unlockUntil;
  syncDashboardLockState();
  updateDashboardLockUI();
}

function setESP32State(next) {
  dashboardState.esp32 = { ...dashboardState.esp32, ...next };
  renderESP32Status();
}

export function configureDashboardUnlock({ verifier, ttlMs } = {}) {
  dashboardState.unlockVerifier = typeof verifier === "function" ? verifier : null;
  dashboardState.unlockTtlMs = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : null;
}

export function lockDashboard() {
  setDashboardLock(true);
  applyControlUI(dashboardState.control);
  showStatusOverlay("cardModo", "modoOverlay", {
    title: "Panel bloqueado",
    message: "Ingresa la clave autorizada para habilitar controles.",
    kind: "warn",
  });
}

export async function unlockDashboard(password, validator = null) {
  const verifier = typeof validator === "function" ? validator : dashboardState.unlockVerifier;
  if (!verifier) {
    showStatusOverlay("cardModo", "modoOverlay", {
      title: "Desbloqueo no configurado",
      message: "No hay verificador de clave disponible para este panel.",
      kind: "danger",
    });
    return false;
  }

  const ok = await verifier(password, {
    pacienteId: dashboardState.pacienteId,
    tutorId: state.currentTutorId,
    role: state.currentRole,
  });

  if (!ok) {
    setDashboardLock(true);
    showStatusOverlay("cardModo", "modoOverlay", {
      title: "Clave incorrecta",
      message: "No se pudieron habilitar los controles.",
      kind: "danger",
    });
    return false;
  }

  dashboardState.unlockUntil = dashboardState.unlockTtlMs
    ? Date.now() + dashboardState.unlockTtlMs
    : null;
  dashboardState.explicitlyLocked = false;
  syncDashboardLockState();
  updateDashboardLockUI();
  applyControlUI(dashboardState.control);
  return true;
}

// =========================================================
// PERMISSIONS
// =========================================================

function getModePermission(ctrl = dashboardState.control) {
  const backend = getBackendPermission(ctrl);
  syncDashboardLockState(backend);

  if (!backend.canChange) return backend;

  if (dashboardState.explicitlyLocked) {
    return {
      canChange: false,
      reason: "dashboard_locked",
      title: "Panel bloqueado",
      detail: "Desbloquea el panel para modificar controles autorizados.",
    };
  }

  return backend;
}

function getBackendPermission(ctrl = dashboardState.control) {
  const modeControl = normalizeControlMode(ctrl?.modo_control);
  const manualEnabled = modeControl === "manual" && !!ctrl?.manual_habilitado;
  const expired = isPermissionExpired(ctrl);

  if (modeControl === "blocked") {
    return {
      canChange: false,
      reason: "locked",
      title: "Control bloqueado",
      detail: "Control manual bloqueado por el doctor.",
    };
  }

  if (modeControl === "automatic") {
    return {
      canChange: false,
      reason: "automatic",
      title: "Modo automatico",
      detail: "El modo automatico esta activo. Solicita control manual al doctor.",
    };
  }

  if (!manualEnabled) {
    return {
      canChange: false,
      reason: "manual_disabled",
      title: "Control no habilitado",
      detail: "Control manual bloqueado por el doctor.",
    };
  }

  if (expired) {
    return {
      canChange: false,
      reason: "expired",
      title: "Permiso expirado",
      detail: "Solicita al doctor que renueve el control manual.",
    };
  }

  return {
    canChange: true,
    reason: "manual",
    title: "Control manual habilitado",
    detail: "Puedes cambiar el modo de terapia autorizado.",
  };
}

function normalizeControlMode(value) {
  const mode = String(value ?? "").toLowerCase().trim();
  if (mode === "manual") return "manual";
  if (mode === "automatico" || mode === "automatic") return "automatic";
  if (mode === "bloqueado" || mode === "blocked") return "blocked";
  return "automatic";
}

function isPermissionExpired(ctrl) {
  return !!ctrl?.habilitado_hasta && new Date(ctrl.habilitado_hasta) < new Date();
}

function isUnlockExpired() {
  return !!dashboardState.unlockUntil && Date.now() > dashboardState.unlockUntil;
}

function refreshDashboardLockState() {
  if (!isUnlockExpired()) return;
  dashboardState.explicitlyLocked = true;
  dashboardState.unlockUntil = null;
}

function syncDashboardLockState(permission = null) {
  refreshDashboardLockState();
  const backend = permission || getBackendPermission(dashboardState.control);
  dashboardState.dashboardLocked = dashboardState.explicitlyLocked || !backend.canChange;
  state.dashboardLocked = dashboardState.dashboardLocked;
}

// =========================================================
// UI RENDERING
// =========================================================

function renderPatientHeader(paciente, doctor = null) {
  const fullName = `${paciente?.nombre || ""} ${paciente?.apellidos || ""}`.trim() || "-";
  const doctorName = formatDoctorDisplayName(doctor, "");

  setText("pacienteNombre", fullName);
  setText("pacienteNombreTop", fullName);
  setText("dashHelloPatient", `Hola, ${(paciente?.nombre || "-").trim()}`);
  setText("pacienteEdad", paciente?.dias_nacido != null ? formatEdad(paciente.dias_nacido) : "-");
  setText("pacienteDoctor", doctorName || (paciente?.doctor_id ? `Dr. ID ${paciente.doctor_id}` : "-"));
}

function renderPatientProfileRail(paciente, tutor, doctor) {
  const fullName = `${paciente?.nombre || ""} ${paciente?.apellidos || ""}`.trim() || "-";
  const initials = fullName.split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "BB";
  const tutorName = `${tutor?.nombre || ""} ${tutor?.apellidos || ""}`.trim() || "-";
  const doctorName = formatDoctorDisplayName(doctor, "-");
  setText("patientProfileAvatar", initials);
  setText("patientProfileName", fullName);
  setText("patientProfileCode", `Código ${paciente?.codigo || "-"}`);
  setText("patientProfileAge", paciente?.dias_nacido != null ? formatEdad(paciente.dias_nacido) : "-");
  setText("patientTutorName", tutorName);
  setText("patientDoctorName", doctorName);
  setText("patientClinicalState", humanLabel(paciente?.estado_clinico || paciente?.diagnostico, "-"));
}

function renderClinicalData(paciente, tutor, dispositivo, control) {
  setText("pacienteGenero", labelGenero(paciente?.genero));
  setText("pacienteCodigo", paciente?.codigo || "-");
  setText("pacienteDiagnostico", paciente?.diagnostico || "Pendiente de completar");
  const biliActual = paciente?.nivel_bilirrubina_actual ?? paciente?.nivel_bilirrubina_inicial;
  setText("pacienteBilirrubina", biliActual != null ? `${Number(biliActual).toFixed(2)} mg/dL` : "-");
  setText("pacientePeso", paciente?.peso_nacimiento_g != null ? `${Number(paciente.peso_nacimiento_g).toFixed(0)} g` : "-");
  setText("pacienteGestacional", paciente?.edad_gestacional_sem != null ? `${Number(paciente.edad_gestacional_sem).toFixed(1)} sem` : "-");
  const sangre = [paciente?.grupo_sanguineo, paciente?.factor_rh].filter(Boolean).join(" ");
  setText("pacienteSangre", sangre || "-");
  setText("pacienteDispositivo", humanLabel(dispositivo?.estado || (dispositivo?.esp_online ? "online" : "offline")));
  setText("pacientePermiso", controlLabel(control));
}

function renderActivePlan(plan) {
  // Terapia acumulada: lo que el plan lleva cumplido (lo calcula el servidor al cerrar cada sesión).
  setText("patientTherapyAccumulated", secondsLabel(Number(plan?.tiempo_acumulado_s || 0)));
  if (!plan) {
    setText("pacientePlan", "Sin plan activo");
    setText("pacienteProgreso", "-");
    setText("patientTherapyGoal", "Tiempo objetivo pendiente");
    setText("patientTherapyPct", "0%");
    setText("patientProgressChartText", "0%");
    setDonut("patientTherapyDonut", 0);
    setDonut("patientProgressChart", 0);
    setProgress("patientPlanProgressBar", 0);
    return;
  }

  const done = plan.horas_completadas ?? plan.horas_acumuladas ?? 0;
  const total = plan.horas_totales ?? plan.horas_meta ?? 0;
  const pct = plan.porcentaje_progreso ?? plan.porcentaje_avance ?? 0;
  const sessions = Number(plan.sesiones_realizadas || 0);
  setText("pacientePlan", `${total} h (${humanLabel(plan.modo_programado || plan.modo_recomendado)})`);
  setText("pacienteProgreso", `${done} / ${total} h (${pct}%) · ${sessions} ${sessions === 1 ? "sesión" : "sesiones"}`);
  setText("patientTherapyGoal", `${done}h / ${total}h`);
  setText("patientTherapyPct", `${Math.round(Number(plan.porcentaje_avance || 0))}%`);
  setText("patientProgressChartText", `${Math.round(Number(plan.porcentaje_avance || 0))}%`);
  setDonut("patientTherapyDonut", Number(plan.porcentaje_avance || 0));
  setDonut("patientProgressChart", Number(plan.porcentaje_avance || 0));
  setProgress("patientPlanProgressBar", Number(plan.porcentaje_avance || 0));
}

function renderSessionTimer(_paciente, _lastSession, session) {
  // El cronómetro muestra la sesión en curso según el servidor.
  initTimer(session || null);
}

function renderLastSessionTemps(lastSession) {
  if (!lastSession) return;

  const babyTemp = lastSession.temp_bebe_promedio_c ?? lastSession.temp_bebe_final;
  const roomTemp = lastSession.temp_amb_promedio_c ?? lastSession.temp_amb_final;

  if (babyTemp != null) setText("tempBebe", `${Number(babyTemp).toFixed(1)} C`);
  if (roomTemp != null) setText("tempAmbiente", `${Number(roomTemp).toFixed(1)} C`);
}

function applyControlUI(ctrl) {
  const controlMode = normalizeMode(ctrl?.modo_actual);
  if (controlMode) setModoUI(controlMode);

  const permission = getModePermission(ctrl);

  updateDashboardLockUI();
  renderModeControls(permission);
  renderControlOverlays(permission);
}

function renderModeControls() {
  // Los modos se pueden pedir siempre que la lámpara esté conectada:
  // reposo y el modo del plan se aplican de inmediato; otro modo va como solicitud al doctor.
  getModeButtons().forEach(btn => {
    const disabled = _modeRequestPending || !dashboardState.lampOnline;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.5" : "1";
    btn.title = !dashboardState.lampOnline ? "La lámpara no está conectada." : "";
    btn.setAttribute("aria-disabled", String(disabled));
  });

  const cardAltura = $("cardAltura");
  if (cardAltura) cardAltura.style.display = "none";

  const manual = getManualState();
  getManualControlButtons().forEach(btn => {
    // Detener siempre está disponible con la lámpara conectada.
    const isStop = btn.dataset.manualMove === "stop";
    const disabled = isStop ? !dashboardState.lampOnline : !manual.ready;
    btn.disabled = disabled;
    btn.setAttribute("aria-disabled", String(disabled));
    btn.title = disabled ? manual.detail : "";
  });
}

function getModeButtons() {
  return Array.from(document.querySelectorAll("[data-modo]"));
}

function getManualControlButtons() {
  return Array.from(document.querySelectorAll("[data-manual-move]"));
}

function updateDashboardLockUI() {
  $("cardModo")?.classList.remove("locked");
}

/**
 * El control manual necesita dos cosas: que el doctor lo autorice y que en el
 * equipo se ingrese la clave física. Esta función dice en qué paso se está.
 */
function getManualState() {
  const permission = getBackendPermission();
  if (!dashboardState.lampOnline)
    return { ready: false, step: "offline", title: "Lámpara sin conexión", detail: "Los controles se habilitan cuando la lámpara vuelva a conectarse.", canRequest: false };
  if (!permission.canChange)
    return { ready: false, step: "request", title: permission.reason === "expired" ? "La autorización venció" : "Control manual bloqueado",
             detail: "El doctor debe autorizar el control manual.", canRequest: true };
  if (!dashboardState.lampManual)
    return { ready: false, step: "key", title: "Autorizado por el doctor",
             detail: "Ahora activa el control en el equipo: presiona MODE, ARRIBA, ABAJO y MODE.", canRequest: false };
  return { ready: true, step: "ready", title: "Control manual activo", detail: "Puedes mover la lámpara. El equipo se detiene solo en los límites de distancia segura.", canRequest: false };
}

function renderControlOverlays() {
  hideOverlay("modoOverlay");                       // la tarjeta ya no se tapa: los modos siempre se pueden pedir
  const manual = getManualState();
  const box = $("manualStatusBox");
  if (box) {
    box.dataset.step = manual.step;
    const title = box.querySelector("strong"), detail = box.querySelector("span"), action = $("manualRequestBtn");
    if (title) title.textContent = manual.title;
    if (detail) detail.textContent = manual.detail;
    if (action) {
      action.hidden = !manual.canRequest;
      action.disabled = _manualControlRequestPending;
      action.textContent = _manualControlRequestPending ? "Solicitud enviada, esperando al doctor" : "Solicitar control manual";
    }
  }
  showInlineMessage("pacModoMsg", { visible: false, message: "", kind: "status" });
}

// =========================================================
// ESP32 CONNECTION UI
// =========================================================

function applyPatientTelemetry(data = {}) {
  updatePatientSensorCards(data, {
    getCurrentMode: () => dashboardState.modoActual,
    onModeChange: setModoUI,
  });
}

function bindSocketStatusUI() {
  const socket = getSocket();
  if (!socket || _socketUiRef === socket) return;

  _socketUiRef = socket;
  // Si el socket ya estaba conectado al enlazar, el evento "connect" no vuelve a dispararse.
  if (socket.connected) setText("patientSocketStatus", "Conectado");

  socket.on("connect", () => {
    setESP32State({ connected: true, label: "Esperando…", kind: "warn" });
    setText("patientSocketStatus", "Conectado");
  });

  socket.on("disconnect", () => {
    setESP32State({ connected: false, portOpen: false, label: "Sin servidor", kind: "err" });
    setText("patientSocketStatus", "Sin conexión");
    setText("patientMasterStatus", "Sin conexión");
  });

  socket.on("lamp:port", st => {
    setLampState({ online: !!st?.open, manual: st?.open ? dashboardState.lampManual : false });
    setESP32State({
      portOpen: !!st?.open,
      label: st?.open ? "Conectada" : "Sin conexión",
      kind: st?.open ? "ok" : "warn",
    });
    setText("patientMasterStatus", st?.open ? "Conectada" : "Sin conexión");
    if (!st?.open) clearPatientSensorCards("Lámpara sin conexión");
  });

  socket.on("telemetry", payload => {
    const data = payload || {};
    setLampState({ online: data.esp32_connected !== false, manual: !!data.manual });
    const otherPatient = data.paciente_id && dashboardState.pacienteId && String(data.paciente_id) !== String(dashboardState.pacienteId);
    if (otherPatient) {
      // La lámpara está en uso con otro paciente: sus lecturas no corresponden a este panel.
      clearPatientSensorCards("Lámpara en uso con otro paciente");
      updateHUD({});
    } else if (!isPatientTelemetryVisible(data, dashboardState.modoActual)) {
      clearPatientSensorCards(data?.esp32_connected === false ? "Lámpara sin conexión" : "Sin terapia activa");
      updateHUD({});
      updateTemps({});
    } else {
      updateHUD(data);
      applyPatientTelemetry(data);
      if (data?.temp_bebe != null || data?.temp_ambiente != null) updateTemps(data);
    }
    if (data?.estado) updateStatusCard(data);
    setESP32State({ connected: true, portOpen: true, label: "Conectada", kind: "ok" });
    setText("patientMasterStatus", "Conectada");
  });

  socket.on("temps", payload => {
    const data = payload || {};
    if (data?.terapiaActiva === false) {
      updateTemps({});
      return;
    }
    updateTemps(data);
    applyPatientTelemetry(data);
    setESP32State({ connected: true, label: "Conectada", kind: "ok" });
  });

  socket.on("status", payload => {
    updateStatusCard(payload);
    if (payload?.esp32_connected == null) return;
    setESP32State({
      connected: !!payload.esp32_connected,
      label: payload.esp32_connected ? "Conectada" : "Sin conexión",
      kind: payload.esp32_connected ? "ok" : "err",
    });
  });
}

function setLampState({ online, manual }) {
  const changed = online !== dashboardState.lampOnline || manual !== dashboardState.lampManual;
  dashboardState.lampOnline = !!online;
  dashboardState.lampManual = !!manual;
  setText("patientSlaveStatus", !online ? "Sin conexión" : manual ? "Control manual" : "Automáticos");
  if (changed) { renderModeControls(); renderControlOverlays(); }
}

function refreshESP32Status() {
  const socket = getSocket();
  setESP32State({
    connected: !!socket?.connected,
    label: socket?.connected ? (dashboardState.esp32?.portOpen ? "Conectada" : "Esperando…") : "Conectando…",
    kind: socket?.connected && dashboardState.esp32?.portOpen ? "ok" : "warn",
  });
}

function renderESP32Status() {
  const dot = $("espDot");
  const status = $("espStatus");
  const { label, kind } = dashboardState.esp32;

  if (dot) {
    dot.dataset.status = kind;
    dot.classList.toggle("is-connected", kind === "ok");
    dot.classList.toggle("is-warning", kind === "warn");
    dot.classList.toggle("is-disconnected", kind === "err");
  }

  if (!status) return;

  status.textContent = label;
  status.dataset.status = kind;
  status.style.color =
    kind === "ok" ? "#15803d" :
    kind === "warn" ? "#b4560d" : "#c0152a";
  status.title = kind === "ok"
    ? "Conexion activa con el ESP32"
    : kind === "warn"
      ? "Esperando conexion o puerto del ESP32"
      : "Sin conexion con el ESP32";
}

// =========================================================
// MODO ACTIVO
// =========================================================

function setModoUI(modo) {
  setModeState(modo);
  setText("pacModoActual", humanLabel(modo));
  setText("pacModoBadge", humanLabel(modo));
  setText("patientRailMode", humanLabel(modo));

  Object.entries(DOM.modeByButton).forEach(([mode, id]) => {
    const btn = $(id);
    if (!btn) return;
    btn.classList.add("btn");
    btn.classList.toggle("btn-primary", mode === modo);
    btn.setAttribute("aria-pressed", String(mode === modo));
  });
}

async function solicitarModo(modo) {
  const normalizado = normalizeMode(modo);
  if (_modeRequestPending || !normalizado) return;
  if (normalizado === dashboardState.modoActual) {
    showModeMessage("Ese modo ya está activo.", "status");
    return;
  }

  _modeRequestPending = true;
  renderModeControls();
  try {
    const { ok, data } = await tutorRequestMode(state.currentUserId, normalizado);
    if (!ok) {
      showModeMessage(data?.message || MODE_ERROR_MESSAGES[data?.error] || "No se pudo cambiar el modo.", "danger");
    } else if (data.status === "applied") {
      setModoUI(normalizado);
      showModeMessage(`Modo ${humanLabel(normalizado).toLowerCase()} enviado a la lámpara.`, "ok");
    } else {
      showModeMessage(`Solicitud de modo ${humanLabel(normalizado).toLowerCase()} enviada al doctor.`, "ok");
    }
  } catch (_) {
    showModeMessage("No se pudo conectar con el servidor.", "danger");
  } finally {
    _modeRequestPending = false;
    renderModeControls();
  }
}

async function requestManualControl() {
  if (_manualControlRequestPending) return;
  const pacienteId = dashboardState.pacienteId || state.currentUserId;
  if (!pacienteId) return;

  _manualControlRequestPending = true;
  renderControlOverlays();
  try {
    const { ok, data } = await tutorRequestMode(pacienteId, "manual_control");
    if (!ok) {
      _manualControlRequestPending = false;
      showModeMessage(data?.message || MODE_ERROR_MESSAGES[data?.error] || "No se pudo enviar la solicitud al doctor.", "danger");
    } else {
      showModeMessage("Solicitud enviada. Te avisaremos cuando el doctor responda.", "ok");
    }
  } catch (_) {
    _manualControlRequestPending = false;
    showModeMessage("No se pudo enviar la solicitud al doctor.", "danger");
  }
  renderControlOverlays();
}

function sendManualMove(dir) {
  const manual = getManualState();
  if (dir !== "stop" && !manual.ready) {
    showModeMessage(manual.detail, "warn");
    return;
  }
  const sent = socketEmitMove(dir);
  if (!sent) showModeMessage("No hay conexión con el servidor.", "warn");
}
function showModeMessage(message, kind) {
  showInlineMessage("pacModoMsg", { visible: true, message, kind });
  window.clearTimeout(showModeMessage.timer);
  showModeMessage.timer = window.setTimeout(() => showInlineMessage("pacModoMsg", { visible: false, message: "", kind }), 4500);
}

// =========================================================
// EVENT BINDINGS
// =========================================================

function bindControlRefresh() {
  if (_controlRefreshBound) return;
  _controlRefreshBound = true;

  window.addEventListener("neolight:control-updated", async () => {
    const pacienteId = dashboardState.pacienteId;
    if (!pacienteId) return;

    let data = null;
    try {
      ({ data } = await fetchControl(pacienteId));
    } catch (_) {
      showModeMessage("No se pudo actualizar el estado de permisos.", "warn");
      return;
    }

    if (!data?.control) {
      showModeMessage("Permisos no disponibles temporalmente.", "warn");
      return;
    }

    setControlState(data.control);
    applyControlUI(dashboardState.control);
    if (normalizeMode(data.control?.modo_actual)) setModoUI(normalizeMode(data.control.modo_actual));
  });
  window.addEventListener("neolight:mode-request-resolved", event => {
    const payload = event.detail || {};
    if (payload.paciente_id && dashboardState.pacienteId && String(payload.paciente_id) !== String(dashboardState.pacienteId)) return;

    _manualControlRequestPending = false;
    _modeRequestPending = false;

    const accepted = payload.status === "accepted";
    if (payload.request_type === "manual_control" || payload.mode === "manual_control") {
      showModeMessage(accepted ? "El doctor autorizó el control manual. Falta activar la clave en el equipo." : "El doctor rechazó la solicitud de control manual.", accepted ? "ok" : "warn");
      showRealtimeToast(accepted ? "Control manual aprobado" : "Control manual rechazado", accepted ? "ok" : "warn");
    } else if (payload.mode) {
      showModeMessage(accepted ? `Cambio a modo ${payload.mode} aprobado.` : `Cambio a modo ${payload.mode} rechazado.`, accepted ? "ok" : "warn");
    }

    refreshTutorState("mode-request-resolved");
  });

  ["plan-updated","doctor-request-resolved","session-started","session-paused","session-finished"].forEach(name => {
    window.addEventListener(`neolight:${name}`, () => refreshTutorState(name));
  });
  window.addEventListener("neolight:alarm-new", () => {
    if (dashboardState.pacienteId) loadRecentAlarms(dashboardState.pacienteId);
  });
}

function bindPatientEvents(pacienteId) {
  if (_eventsBound) {
    if (pacienteId) loadRecentAlarms(pacienteId);
    return;
  }

  _eventsBound = true;

  getModeButtons().forEach(btn => {
    btn.addEventListener("click", () => solicitarModo(btn.dataset.modo));
  });

  getManualControlButtons().forEach(btn => {
    btn.addEventListener("click", () => sendManualMove(btn.dataset.manualMove));
  });
  $("manualRequestBtn")?.addEventListener("click", requestManualControl);

  $("muteAlarmsBtn")?.addEventListener("click", () => {
    const next = !isAlarmsMuted();
    socketEmitMute(next);
    updateMuteButtonFromState(next);
  });

  $("saveExitBtn")?.addEventListener("click", async () => {
    await saveSession();
    doLogout(true);
  });

  $("exportBtn")?.addEventListener("click", async () => {
    if (!dashboardState.pacienteId) return;

    try {
      await exportExcel(dashboardState.pacienteId);
    } catch (_) {
      alert("Error exportando datos. Intenta de nuevo.");
    }
  });

  $("downloadPatientPdfBtn")?.addEventListener("click", downloadPatientPdfReport);
  $("downloadPatientPdfBtnTop")?.addEventListener("click", downloadPatientPdfReport);
  $("exportBtnTop")?.addEventListener("click", async () => {
    if (!dashboardState.pacienteId) return;
    try {
      await exportExcel(dashboardState.pacienteId);
    } catch (_) {
      alert("Error exportando datos. Intenta de nuevo.");
    }
  });
  $("patientSidebarLogout")?.addEventListener("click", async () => {
    await saveSession();
    doLogout(false);
  });

  if (pacienteId) loadRecentAlarms(pacienteId);
}

function bindPatientSections() {
  if (_sectionsBound) return;
  _sectionsBound = true;
  const buttons = document.querySelectorAll("#view-dashboard-patient [data-section-target]");
  const sections = document.querySelectorAll("#view-dashboard-patient .patient-section[data-section]");
  const show = name => {
    sections.forEach(section => section.classList.toggle("active", section.dataset.section === name));
    buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.sectionTarget === name));
    $("view-dashboard-patient")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  buttons.forEach(btn => btn.addEventListener("click", () => show(btn.dataset.sectionTarget || "inicio")));
}

function setProgress(id, pct) {
  const el = $(id);
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function setDonut(id, pct) {
  const el = $(id);
  if (!el) return;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.setProperty("--pct", `${value}`);
}

// =========================================================
// RIGHT PANEL TABS
// =========================================================

function bindRightPanelTabs() {
  const tabs = document.querySelectorAll("#view-dashboard-patient .pt-tab");
  const panes = document.querySelectorAll("#view-dashboard-patient .pt-tab-pane");
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.rtab;
      tabs.forEach(t => t.classList.toggle("active", t.dataset.rtab === target));
      panes.forEach(p => p.classList.toggle("active", p.dataset.rtabPane === target));
    });
  });
}

// =========================================================
// CAMERA TOGGLE
// =========================================================

function secondsLabel(sec) {
  const n = Number(sec || 0);
  if (!Number.isFinite(n) || n <= 0) return "00:00:00";
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}