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

function updateFanUI(data = {}) {
  const on = data?.fanOn === true || String(data?.fanOn).toLowerCase() === "true";
  const mode = String(data?.fanMode || "AUTO").toUpperCase();
  const hot = data?.fanAutoHot === true || String(data?.fanAutoHot).toLowerCase() === "true";
  const btn = $("fanToggleBtn");
  const status = $("fanStatusText");
  if (btn) {
    btn.classList.toggle("is-on", on);
    btn.dataset.state = on ? "on" : "off";
    btn.textContent = on ? "Ventilador ON" : "Ventilador OFF";
  }
  if (status) status.textContent = `Ventilador: ${on ? "encendido" : "apagado"} · ${mode}${hot ? " · temp. alta" : ""}`;
}

async function setFanState(stateValue) {
  try {
    const res = await fetch(`${API_URL}/api/fan?state=${encodeURIComponent(stateValue)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) throw new Error(data?.error || "fan_error");
    showRealtimeToast(stateValue === "auto" ? "Ventilador en automático" : `Ventilador ${stateValue === "on" ? "encendido" : "apagado"}`, "ok");
  } catch (_) {
    showRealtimeToast("No se pudo controlar el ventilador", "warn");
  }
}

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
  setText("pacientePlan", `${total} h (${plan.modo_programado || plan.modo_recomendado})`);
  setText("pacienteProgreso", `${done} / ${total} h (${pct}%) - ${sessions} sesion(es)`);
  setText("patientTherapyGoal", `${done}h / ${total}h`);
  setText("patientTherapyPct", `${Math.round(Number(plan.porcentaje_avance || 0))}%`);
  setText("patientProgressChartText", `${Math.round(Number(plan.porcentaje_avance || 0))}%`);
  setDonut("patientTherapyDonut", Number(plan.porcentaje_avance || 0));
  setDonut("patientProgressChart", Number(plan.porcentaje_avance || 0));
  setProgress("patientPlanProgressBar", Number(plan.porcentaje_avance || 0));
}

function renderSessionTimer(paciente, lastSession, session) {
  const serverSecs = Number(lastSession?.duracion_s || 0);
  let localMs = 0;

  try {
    localMs = Number(localStorage.getItem(STORAGE_KEY(paciente?.id)) || "0");
  } catch (_) {}

  initTimer(Math.max(serverSecs * 1000, localMs), session?.id || null);
  const totalLabel = secondsLabel(Math.max(serverSecs, Math.floor(localMs / 1000)));
  setText("patientTherapyAccumulated", totalLabel);
  setText("patientHeroTime", totalLabel);
}

function renderLastSessionTemps(lastSession) {
  if (!lastSession) return;

  const babyTemp = lastSession.temp_bebe_promedio_c ?? lastSession.temp_bebe_final;
  const roomTemp = lastSession.temp_amb_promedio_c ?? lastSession.temp_amb_final;

  if (babyTemp != null) setText("tempBebe", `${Number(babyTemp).toFixed(1)} C`);
  if (roomTemp != null) setText("tempAmbiente", `${Number(roomTemp).toFixed(1)} C`);
  if (babyTemp != null) updatePatientBabyTemp(babyTemp);
  if (roomTemp != null) updatePatientAmbientTemp(roomTemp);
}

function applyControlUI(ctrl) {
  const controlMode = normalizeMode(ctrl?.modo_actual);
  if (controlMode) setModoUI(controlMode);

  const permission = getModePermission(ctrl);

  updateDashboardLockUI();
  renderModeControls(permission);
  renderControlOverlays(permission);
}

function renderModeControls(permission) {
  getModeButtons().forEach(btn => {
    if (!btn) return;

    const mode = normalizeMode(btn.dataset.modo);
    const reposoLibre = mode === "reposo";
    const disabled = _modeRequestPending || (!reposoLibre && !permission.canChange);

    btn.disabled = disabled;
    btn.title = disabled && !reposoLibre ? permission.detail : "";
    btn.style.opacity = disabled ? "0.45" : "1";
    btn.setAttribute("aria-disabled", String(disabled));
  });

  const cardAltura = $("cardAltura");
  if (cardAltura) cardAltura.style.display = "none";

  getManualControlButtons().forEach(btn => {
    btn.disabled = !permission.canChange;
    btn.setAttribute("aria-disabled", String(!permission.canChange));
    btn.title = permission.canChange ? "" : permission.detail;
  });
}

function getModeButtons() {
  return Array.from(document.querySelectorAll("[data-modo]"));
}

function getManualControlButtons() {
  return Array.from(document.querySelectorAll("[data-manual-move]"));
}

function updateDashboardLockUI() {
  const cardModo = $("cardModo");
  if (!cardModo) return;

  cardModo.classList.toggle("locked", dashboardState.dashboardLocked);
  cardModo.setAttribute("aria-disabled", String(dashboardState.dashboardLocked));
}

function renderControlOverlays(permission) {
  if (permission.canChange) {
    hideOverlay("modoOverlay");
  } else {
    showStatusOverlay("cardModo", "modoOverlay", {
      title: permission.title,
      message: permission.detail,
      kind: permission.reason === "expired" ? "warn" : "status",
      actionText: _manualControlRequestPending ? "Solicitud pendiente" : "Solicitar control manual",
      actionDisabled: _manualControlRequestPending,
      onAction: requestManualControl,
    });
  }

  showInlineMessage("pacModoMsg", {
    visible: !permission.canChange,
    message: permission.detail,
    kind: "status",
  });
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
    setESP32State({
      portOpen: !!st?.open,
      label: st?.open ? "Conectada" : "Sin conexión",
      kind: st?.open ? "ok" : "warn",
    });
    setText("patientMasterStatus", st?.open ? "Conectada" : "Sin conexión");
    if (!st?.open) clearPatientSensorCards("ESP desconectado");
  });

  socket.on("telemetry", payload => {
    const data = payload || {};
    updateFanUI(data);
    if (!isPatientTelemetryVisible(data, dashboardState.modoActual)) {
      clearPatientSensorCards(data?.esp32_connected === false ? "ESP desconectado" : "Sin terapia activa");
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
  setText("pacModoActual", modo.toUpperCase());
  setText("patientRailMode", modo.toUpperCase());

  Object.entries(DOM.modeByButton).forEach(([mode, id]) => {
    const btn = $(id);
    if (!btn) return;

    btn.classList.toggle("btn-primary", mode === modo);
    btn.classList.toggle("btn", mode !== modo);
  });
}

async function solicitarModo(modo) {
  const normalizado = normalizeMode(modo);
  if (_modeRequestPending) return;
  if (!normalizado) return;
  if (normalizado === dashboardState.modoActual) {
    showModeMessage("Ese modo ya está activo.", "status");
    return;
  }

  // Reposo es seguro: no requiere solicitud médica especial.
  if (normalizado === "reposo") {
    _modeRequestPending = true;
    renderModeControls(getModePermission());
    try {
      const { ok, data } = await tutorRequestMode(state.currentUserId, "reposo");
      if (!ok) {
        const sent = socketEmitMode("reposo");
        if (!sent) {
          showModeMessage(MODE_ERROR_MESSAGES[data?.error] || data?.message || "No se pudo enviar modo reposo.", "danger");
          return;
        }
      }
      setModoUI("reposo");
      showModeMessage("Modo reposo enviado.", "ok");
    } catch (_) {
      const sent = socketEmitMode("reposo");
      showModeMessage(sent ? "Modo reposo enviado." : "No se pudo enviar modo reposo.", sent ? "ok" : "danger");
    } finally {
      _modeRequestPending = false;
      renderModeControls(getModePermission());
    }
    return;
  }

  const permission = getModePermission();

  if (!permission.canChange) {
    showModeMessage(permission.detail, permission.reason === "expired" ? "warn" : "danger");
    renderControlOverlays(permission);
    return;
  }

  _modeRequestPending = true;
  renderModeControls(permission);
  try {
    const { ok, data } = await tutorRequestMode(state.currentUserId, normalizado);
    if (!ok) {
      _modeRequestPending = false;
      showModeMessage(MODE_ERROR_MESSAGES[data?.error] || data?.message || "No se pudo solicitar el cambio de modo.", "danger");
      renderModeControls(getModePermission());
      return;
    }

    showModeMessage(`Solicitud de modo ${normalizado} enviada al doctor.`, "ok");
  } catch (_) {
    _modeRequestPending = false;
    showModeMessage("No se pudo enviar la solicitud al doctor.", "danger");
    renderModeControls(getModePermission());
  }
}

async function requestManualControl() {
  if (_manualControlRequestPending) return;
  const pacienteId = dashboardState.pacienteId || state.currentUserId;
  if (!pacienteId) {
    showModeMessage("No se pudo identificar el paciente.", "danger");
    return;
  }

  _manualControlRequestPending = true;
  renderControlOverlays(getModePermission());
  try {
    const { ok, data } = await tutorRequestMode(pacienteId, "manual_control");
    if (!ok) {
      showModeMessage(MODE_ERROR_MESSAGES[data?.error] || data?.message || "No se pudo enviar la solicitud al doctor.", "danger");
      return;
    }
    showModeMessage("Solicitud enviada al doctor. Esperando aprobación en tiempo real.", "ok");
  } catch (_) {
    _manualControlRequestPending = false;
    showModeMessage("No se pudo enviar la solicitud al doctor.", "danger");
    renderControlOverlays(getModePermission());
  }
}

function sendManualMove(dir) {
  const permission = getModePermission();
  if (!permission.canChange) {
    showModeMessage(permission.detail, permission.reason === "expired" ? "warn" : "danger");
    renderControlOverlays(permission);
    return;
  }
  const sent = socketEmitMove(dir);
  showModeMessage(sent ? `Comando ${dir} enviado.` : "ESP32 no conectado.", sent ? "ok" : "warn");
}
function showModeMessage(message, kind) {
  showInlineMessage("pacModoMsg", { visible: true, message, kind });

  window.setTimeout(() => {
    if (getModePermission().canChange) {
      showInlineMessage("pacModoMsg", { visible: false, message: "", kind });
    }
  }, 3500);
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
    if (data.control?.modo_actual) {
      showModeMessage(`Modo actualizado: ${String(data.control.modo_actual).toUpperCase()}.`, "ok");
    }
  });
  window.addEventListener("neolight:mode-request-resolved", event => {
    const payload = event.detail || {};
    if (payload.paciente_id && dashboardState.pacienteId && String(payload.paciente_id) !== String(dashboardState.pacienteId)) return;

    _manualControlRequestPending = false;
    _modeRequestPending = false;

    const accepted = payload.status === "accepted";
    if (payload.request_type === "manual_control" || payload.mode === "manual_control") {
      showModeMessage(accepted ? "Control manual aprobado. Ya puedes usar los controles durante esta sesión." : "Solicitud de control manual rechazada.", accepted ? "ok" : "warn");
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

  $("muteAlarmsBtn")?.addEventListener("click", () => {
    const next = !isAlarmsMuted();
    socketEmitMute(next);
    updateMuteButtonFromState(next);
  });

  $("fanToggleBtn")?.addEventListener("click", () => {
    const currentlyOn = $("fanToggleBtn")?.classList.contains("is-on");
    setFanState(currentlyOn ? "off" : "on");
  });

  $("fanAutoBtn")?.addEventListener("click", () => setFanState("auto"));

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