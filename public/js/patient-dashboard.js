// =========================================================
// public/js/patient-dashboard.js
// Panel del tutor/paciente: datos, permisos, bloqueo UI,
// conexion ESP32, alarmas, exportacion y control de modo.
// =========================================================

import { $, state, STORAGE_KEY, normalizeMode, formatEdad, formatDoctorDisplayName } from "./config.js";
import { fetchControl, fetchCurrentTutorState, tutorRequestMode, fetchAlarms, fetchSessions, fetchEvents, exportExcel } from "./api.js";
import {
  socketEmitMute,
  socketEmitMove,
  socketIdentifyPatient,
  updateHUD,
  updateTemps,
  updateStatusCard,
  updateMuteButtonFromState,
  isAlarmsMuted,
  getSocket,
} from "./socket.js";
import { saveSession, initTimer } from "./sessions.js";
import { doLogout } from "./auth.js";

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
const sensorSeries = {
  light: [],
  distance: [],
  baby: [],
  ambient: [],
};

const MODE_ERROR_MESSAGES = {
  control_bloqueado: "El doctor mantiene bloqueado el cambio de modo.",
  solicitud_manual_pendiente: "Ya existe una solicitud de control manual pendiente.",
  permiso_expirado: "El permiso manual expiro. Solicita renovacion al doctor.",
  modo_invalido_para_tutor: "Este modo no esta disponible para el tutor.",
  falta_tutor_id: "No se pudo identificar la cuenta del tutor.",
  paciente_no_encontrado: "No se encontro el paciente asociado.",
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
  setText("patientClinicalState", paciente?.estado_clinico || paciente?.diagnostico || "-");
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
  setText("pacienteDispositivo", dispositivo?.estado || (dispositivo?.esp_online ? "online" : "offline"));
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

    btn.disabled = !permission.canChange || _modeRequestPending;
    btn.title = permission.canChange ? "" : permission.detail;
    btn.style.opacity = permission.canChange && !_modeRequestPending ? "1" : "0.45";
    btn.setAttribute("aria-disabled", String(!permission.canChange || _modeRequestPending));
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

export function showStatusOverlay(parentId, overlayId, config = {}) {
  const parent = $(parentId) || document.body;

  const overlay = ensureOverlay(parent, overlayId);
  overlay.hidden = false;
  overlay.style.display = "flex";
  overlay.dataset.kind = config.kind || "status";
  overlay.setAttribute("aria-hidden", "false");
  overlay.innerHTML = "";

  const ico = document.createElement("div");
  ico.className = "co-ico";
  ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  const strong = document.createElement("strong");
  strong.textContent = config.title || "Estado del panel";

  const paragraph = document.createElement("p");
  paragraph.textContent = config.message || "Operacion no disponible temporalmente.";

  overlay.append(ico, strong, paragraph);

  if (config.actionText) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "control-overlay-action";
    action.textContent = config.actionText;
    action.disabled = !!config.actionDisabled;
    if (typeof config.onAction === "function") action.addEventListener("click", config.onAction);
    overlay.appendChild(action);
  }

  return overlay;
}

export function showOverlay(parentId, overlayId, config = {}) {
  return showStatusOverlay(parentId, overlayId, config);
}

export function hideOverlay(overlayId) {
  const overlay = $(overlayId);
  if (!overlay) return;

  overlay.hidden = true;
  overlay.style.display = "none";
  overlay.setAttribute("aria-hidden", "true");
}

function ensureOverlay(parent, overlayId) {
  let overlay = $(overlayId);
  if (overlay) return overlay;

  if (!parent.style.position) parent.style.position = "relative";
  overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.className = "control-overlay";
  parent.appendChild(overlay);
  return overlay;
}

function showInlineMessage(id, { visible, message, kind = "status" }) {
  const msg = $(id);
  if (!msg) return;

  if (!visible) {
    msg.style.display = "none";
    return;
  }

  msg.textContent = message;
  msg.style.color = getMessageColor(kind);
  msg.style.display = "block";
}

function getMessageColor(kind) {
  if (kind === "ok") return "var(--ok)";
  if (kind === "warn") return "var(--warn)";
  if (kind === "danger") return "var(--danger)";
  return "var(--muted)";
}

// =========================================================
// ESP32 CONNECTION UI
// =========================================================

function bindSocketStatusUI() {
  const socket = getSocket();
  if (!socket || _socketUiRef === socket) return;

  _socketUiRef = socket;

  socket.on("connect", () => {
    setESP32State({ connected: true, label: "ESP32 online", kind: "ok" });
    setText("patientSocketStatus", "Conectado");
    setText("patientMasterStatus", "Online");
  });

  socket.on("disconnect", () => {
    setESP32State({ connected: false, portOpen: false, label: "ESP32 offline", kind: "err" });
    setText("patientSocketStatus", "Desconectado");
    setText("patientMasterStatus", "Offline");
  });

  socket.on("lamp:port", st => {
    setESP32State({
      portOpen: !!st?.open,
      label: st?.open ? "ESP32 conectado" : "ESP32 sin puerto",
      kind: st?.open ? "ok" : "warn",
    });
    setText("patientMasterStatus", st?.open ? "Online" : "Offline");
  });

  socket.on("telemetry", payload => {
    updateHUD(payload || {});
    updatePatientSensorCards(payload || {});
    if (payload?.temp_bebe != null || payload?.temp_ambiente != null) updateTemps(payload || {});
    if (payload?.estado) updateStatusCard(payload || {});
    setESP32State({ connected: true, portOpen: true, label: "ESP32 transmitiendo", kind: "ok" });
    setText("patientMasterStatus", "Online");
  });

  socket.on("temps", payload => {
    updateTemps(payload || {});
    updatePatientSensorCards(payload || {});
    setESP32State({ connected: true, label: "ESP32 transmitiendo", kind: "ok" });
  });

  socket.on("status", payload => {
    updateStatusCard(payload);
    if (payload?.esp32_connected == null) return;
    setESP32State({
      connected: !!payload.esp32_connected,
      label: payload.esp32_connected ? "ESP32 online" : "ESP32 offline",
      kind: payload.esp32_connected ? "ok" : "err",
    });
  });
}

function refreshESP32Status() {
  const socket = getSocket();
  setESP32State({
    connected: !!socket?.connected,
    label: socket?.connected ? "ESP32 online" : "Conectando ESP32...",
    kind: socket?.connected ? "ok" : "warn",
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
    kind === "ok" ? "#4a7c3f" :
    kind === "warn" ? "#b87a2a" : "#c4462a";
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
    showModeMessage("Ese modo ya esta activo.", "status");
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
      showModeMessage(MODE_ERROR_MESSAGES[data?.error] || data?.message || "No se pudo solicitar el cambio de modo.", "danger");
      return;
    }

    showModeMessage(`Solicitud de modo ${normalizado} enviada al doctor.`, "ok");
  } catch (_) {
    showModeMessage("No se pudo enviar la solicitud al doctor.", "danger");
  } finally {
    _modeRequestPending = false;
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
    showModeMessage("Solicitud enviada al doctor", "ok");
  } catch (_) {
    showModeMessage("No se pudo enviar la solicitud al doctor.", "danger");
  } finally {
    _manualControlRequestPending = false;
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
  ["plan-updated","mode-request-resolved","doctor-request-resolved","session-started","session-paused","session-finished"].forEach(name => {
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

async function loadRecentAlarms(pacienteId) {
  try {
    const { ok, data } = await fetchAlarms(pacienteId);
    renderPatientAlarms(data.alarms || []);
    if (!ok || !data.alarms?.length) return;

    const criticals = data.alarms.filter(alarm => !alarm.silenciada && alarm.severidad === "critical");
    if (!criticals.length) return;

    const statusDet = $("statusDetail");
    if (statusDet) statusDet.textContent += ` - ${criticals.length} alarma(s) critica(s) activa(s).`;
  } catch (_) {}
}

async function loadPatientHistory(pacienteId) {
  if (!pacienteId) return;
  try {
    const [sessionsRes, eventsRes] = await Promise.all([
      fetchSessions(pacienteId),
      fetchEvents(pacienteId),
    ]);
    const sessions = sessionsRes.data?.sessions || [];
    const events = eventsRes.data?.events || [];
    renderHistoryRows(sessions, events);
  } catch (_) {}
}

function renderHistoryRows(sessions = [], events = []) {
  const tbody = $("patientHistoryRows");
  if (!tbody) return;

  const rows = [
    ...sessions.slice(0, 5).map(s => ({
      date: s.fecha || s.created_at,
      type: "Sesión",
      detail: `${s.modo_programado || "-"} · ${secondsLabel(s.duracion_s)} · ${s.status || "-"}`
    })),
    ...events.slice(0, 5).map(e => ({
      date: e.created_at,
      type: "Evento",
      detail: e.descripcion || e.tipo || "-"
    })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 8);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3">Sin datos</td></tr>`;
    const railTbody = $("patientRailHistoryRows");
    if (railTbody) railTbody.innerHTML = `<tr><td colspan="3">Sin datos</td></tr>`;
    return;
  }

  const _clk = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15.5,14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const _tagClass = t => /sesi/i.test(t) ? "sesion" : /lectur/i.test(t) ? "lectura" : /cambio/i.test(t) ? "cambio" : /ingres/i.test(t) ? "ingreso" : "evento";
  const _tagIco = {
    sesion:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h4"/></svg>',
    lectura: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
    cambio:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 4l3 3-3 3"/><path d="M20 7H8"/><path d="M7 20l-3-3 3-3"/><path d="M4 17h12"/></svg>',
    ingreso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    evento:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h4"/></svg>',
  };
  tbody.innerHTML = rows.map(r => {
    const _c = _tagClass(r.type);
    return `
    <tr>
      <td><span class="td-date">${_clk}${formatDate(r.date)}</span></td>
      <td><span class="tag ${_c}">${_tagIco[_c] || ""}${escapeText(r.type)}</span></td>
      <td>${escapeText(r.detail)}</td>
    </tr>`;
  }).join("");

  const railTbody = $("patientRailHistoryRows");
  if (railTbody) railTbody.innerHTML = tbody.innerHTML;
}

function renderPatientAlarms(alarms = []) {
  const box = $("patientAlarmsList");
  const railBox = $("patientRailAlarmsList");
  const emptyHtml = `<div class="empty-note">Sin alarmas · No hay registros recientes.</div>`;

  if (!alarms.length) {
    if (box) box.innerHTML = emptyHtml;
    if (railBox) railBox.innerHTML = emptyHtml;
    updateAlertCard(0);
    return;
  }

  const _triIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const _clkIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15.5,14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const _sevMap = s => { const v = String(s || "").toLowerCase(); if (v === "critical" || v === "critica" || v === "crit") return ["crit", "CRÍTICA"]; if (v === "warning" || v === "warn" || v === "advertencia") return ["warn", "ADVERTENCIA"]; return ["info", "INFO"]; };
  const html = alarms.slice(0, 5).map(a => {
    const [lvl, sevLbl] = _sevMap(a.severidad);
    const sil = a.silenciada ? `<span class="ar-silenced">SILENCIADA</span>` : "";
    return `<div class="alert-row ${lvl}">
      <div class="ar-ico">${_triIco}</div>
      <div class="ar-body">
        <div class="ar-title">${escapeText(a.tipo || "Alarma")}${sil}</div>
        <div class="ar-desc">${escapeText(a.mensaje || a.valor_medido || "")}</div>
        <div class="ar-time">${_clkIco}${formatDate(a.created_at)}</div>
      </div>
      <span class="ar-sev">${sevLbl}</span>
    </div>`;
  }).join("");

  if (box) box.innerHTML = html;
  if (railBox) railBox.innerHTML = html;

  const active = alarms.filter(a => !a.silenciada).length;
  updateAlertCard(active);
}

function updateAlertCard(count) {
  const card = $("ptAlertCard");
  const msg = $("ptAlertMsg");
  const cnt = $("ptAlertCount");
  const badge = $("ptBellBadge");

  if (count > 0) {
    card?.classList.add("pt-has-alert");
    if (msg) msg.textContent = `${count} alarma${count > 1 ? "s" : ""} activa${count > 1 ? "s" : ""}`;
    if (cnt) cnt.textContent = `${count} alarma${count > 1 ? "s" : ""}`;
    badge?.classList.add("pt-badge-visible");
  } else {
    card?.classList.remove("pt-has-alert");
    if (msg) msg.textContent = "Sin alarmas activas";
    if (cnt) cnt.textContent = "";
    badge?.classList.remove("pt-badge-visible");
  }
}

function controlLabel(control) {
  const mode = String(control?.modo_control || "bloqueado").toLowerCase();
  if (mode === "manual") return "Manual habilitado";
  if (mode === "automatico") return "Automático";
  return "Bloqueado";
}

function labelGenero(value) {
  const v = String(value || "").replace("_", " ");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "-";
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

function updatePatientSensorCards(data = {}) {
  console.log("[NEOLIGHT] telemetría recibida:", data);

  const cm      = Number(data.cm ?? data.distance_cm ?? data.distance);
  const light   = Number(data.pct ?? data.percent ?? data.illumination_pct ?? data.illumination ?? data.intensidad_led_pct);
  const baby    = Number(data.bebe ?? data.temp_bebe ?? data.temp_body_c);
  const ambient = Number(data.ambiente ?? data.temp_ambiente ?? data.temp_amb_c);
  const pwm     = Number(data.pwm ?? data.pwm_led);
  const modo    = data.modo_actual ?? data.modo ?? data.mode;

  if (Number.isFinite(light))   updatePatientLight(light);
  if (Number.isFinite(cm))      updatePatientDistance(cm);
  if (Number.isFinite(baby))    updatePatientBabyTemp(baby);
  if (Number.isFinite(ambient)) updatePatientAmbientTemp(ambient);
  if (Number.isFinite(pwm))     updatePatientPWM(pwm);
  if (modo) {
    const normalized = normalizeMode(modo);
    if (normalized) setModoUI(normalized);
    setText("patientMode", String(modo).toUpperCase());
  }
  renderPatientCharts();
}

function updatePatientPWM(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  setText("patientHeroPWM", `${pct} %`);
}

function updatePatientLight(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  setText("patientLightLevel", `${pct}%`);
  setText("patientLightStatus", pct >= 60 && pct <= 95 ? "Dentro del rango terapéutico" : "Revisar intensidad LED");
  setProgress("patientLightBar", pct);
  pushSeries(sensorSeries.light, pct);
}

function updatePatientDistance(value) {
  const cm = Math.round(value);
  setText("patientDistance", `${cm} cm`);
  const status = cm >= 25 && cm <= 45 ? "Distancia correcta" : cm < 20 ? "Peligro: muy cerca" : "Fuera de rango";
  setText("patientDistanceStatus", status);
  setProgress("patientDistanceBar", Math.max(0, Math.min(100, (cm / 60) * 100)));
  pushSeries(sensorSeries.distance, cm);
}

function updatePatientBabyTemp(value) {
  setText("patientBabyTemp", `${Number(value).toFixed(1)}°C`);
  setText("patientBabyTempStatus", value >= 36.5 && value <= 37.5 ? "Temperatura estable" : "Revisar temperatura");
  pushSeries(sensorSeries.baby, Number(value));
}

function updatePatientAmbientTemp(value) {
  setText("patientAmbientTemp", `${Number(value).toFixed(1)}°C`);
  setText("patientAmbientTempStatus", "Lectura ambiental");
  pushSeries(sensorSeries.ambient, Number(value));
}

function pushSeries(series, value) {
  series.push(Number(value));
  if (series.length > 24) series.shift();
}

function renderPatientCharts() {
  drawLineChart("patientLedChart", [sensorSeries.light], ["#7c6be8"], 0, 100);
  drawLineChart("patientDistanceChart", [sensorSeries.distance], ["#b9adff"], 0, 60);
  drawLineChart("patientTempChart", [sensorSeries.baby, sensorSeries.ambient], ["#f7a8c8", "#7c6be8"], 25, 40);
}

function drawLineChart(id, seriesList, colors, minY, maxY) {
  const canvas = $(id);
  if (!canvas?.getContext) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fbfaff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(124,107,232,.12)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(w - 12, y); ctx.stroke();
  }
  seriesList.forEach((series, idx) => {
    if (!series.length) {
      ctx.fillStyle = "#7b7b94";
      ctx.font = "12px Inter, sans-serif";
      ctx.fillText("Sin datos suficientes", 18, h / 2);
      return;
    }
    ctx.strokeStyle = colors[idx] || "#7c6be8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    series.forEach((value, i) => {
      const x = 16 + (i / Math.max(1, series.length - 1)) * (w - 32);
      const y = h - 16 - ((value - minY) / Math.max(1, maxY - minY)) * (h - 32);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

function downloadPatientPdfReport() {
  renderPatientPdfReport();
  const report = $("patientPdfReport");
  if (report) report.setAttribute("aria-hidden", "false");
  window.print();
  window.setTimeout(() => report?.setAttribute("aria-hidden", "true"), 500);
}

function renderPatientPdfReport() {
  const report = $("patientPdfReport");
  if (!report) return;
  const ledChart = canvasData("patientLedChart");
  const tempChart = canvasData("patientTempChart");
  const distanceChart = canvasData("patientDistanceChart");
  const progress = $("patientProgressChartText")?.textContent || "0%";
  report.innerHTML = `
    <div class="pdf-header">
      <div><div class="pdf-brand">NEOLIGHT</div><h1>Reporte de seguimiento paciente</h1><p>Generado: ${escapeText(new Date().toLocaleString("es"))}</p></div>
      <div class="pdf-doctor-box"><strong>${escapeText($("pacienteNombre")?.textContent || "-")}</strong><span>${escapeText($("pacienteCodigo")?.textContent || "-")}</span><span>${escapeText($("pacienteDoctor")?.textContent || "-")}</span></div>
    </div>
    <div class="pdf-kpi-grid">
      ${pdfKpi("Intensidad LED", $("patientLightLevel")?.textContent || "-")}
      ${pdfKpi("Distancia", $("patientDistance")?.textContent || "-")}
      ${pdfKpi("Temperatura bebé", $("patientBabyTemp")?.textContent || "-")}
      ${pdfKpi("Ambiente", $("patientAmbientTemp")?.textContent || "-")}
    </div>
    <section class="pdf-section"><h2>Graficos de seguimiento</h2>
      <div class="pdf-chart-grid">
        ${pdfChart("Intensidad LED vs tiempo", ledChart)}
        ${pdfChart("Temperatura bebe / ambiente", tempChart)}
        ${pdfChart("Distancia lampara", distanceChart)}
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

function bindCameraToggle() {
  const btn       = $("ptCamToggle");
  const heroVideo = document.querySelector("#ptHeroMedia .pt-hero-video");
  const camImg    = $("ptCameraStream");
  const camError  = $("ptCamError");
  if (!btn || !camImg) return;

  const STREAM_URL     = "http://10.26.0.74/stream";
  const ERROR_TIMEOUT  = 7000;   // ms sin primer frame → error
  let   errorTimer     = null;

  function setToggle(on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function hideError() {
    if (camError) { camError.style.display = "none"; camError.setAttribute("aria-hidden", "true"); }
  }

  function showError() {
    clearTimeout(errorTimer); errorTimer = null;
    camImg.src          = "";
    camImg.style.display = "none";
    camImg.onerror      = null;
    camImg.onload       = null;
    if (camError) { camError.style.display = "flex"; camError.removeAttribute("aria-hidden"); }
  }

  function turnOn() {
    setToggle(true);
    hideError();
    camImg.style.display = "none";    // oculto hasta que cargue primer frame
    if (heroVideo) heroVideo.style.display = "none";

    camImg.onerror = () => showError();
    camImg.onload  = () => {
      // Primer frame recibido — mostramos el stream
      clearTimeout(errorTimer); errorTimer = null;
      camImg.style.display = "block";
    };
    errorTimer = setTimeout(showError, ERROR_TIMEOUT);
    camImg.src = STREAM_URL;
  }

  function turnOff() {
    setToggle(false);
    clearTimeout(errorTimer); errorTimer = null;
    camImg.onerror       = null;
    camImg.onload        = null;
    camImg.src           = "";
    camImg.style.display = "none";
    hideError();
    if (heroVideo) heroVideo.style.display = "block";
  }

  btn.addEventListener("click", () => {
    btn.getAttribute("aria-pressed") === "true" ? turnOff() : turnOn();
  });
}

function secondsLabel(sec) {
  const n = Number(sec || 0);
  if (!Number.isFinite(n) || n <= 0) return "00:00:00";
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toLocaleDateString("es");
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])
  );
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}