// =========================================================
// public/js/sessions.js
// Maneja: timer de sesión, inicio, pausa, fin, guardado
// =========================================================

import { $, state, STORAGE_KEY, normalizeMode } from "./config.js";
import { startSession, pauseSession, finishSession, saveSessionLegacy } from "./api.js";

// =========================================================
// TIMER
// =========================================================
let running = false;
let startMs = null;
let accMs   = 0;
let tick    = null;
let activeSessionId = null;  // ID de sesión activa en la BD
let sessionsBound = false;

const fmt = ms => {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

function draw() {
  const ms = running ? accMs + (Date.now() - startMs) : accMs;
  const el = $("tiempoTerapia");
  if (el) el.textContent = fmt(ms);
}

export function getActiveSessionId() { return activeSessionId; }
export function setActiveSessionId(id) { activeSessionId = id; }

export function isRunning() { return running; }
export function getAccMs()  { return running ? accMs + (Date.now() - startMs) : accMs; }

function currentTherapyMode() {
  const fromState = state.controlData?.modo_actual ?? state.controlData?.modo ?? state.controlData?.estado;
  const fromDom = $("pacModoActual")?.textContent;
  return normalizeMode(fromState) || normalizeMode(fromDom) || "reposo";
}

function isTherapyModeActive() {
  return ["convencional", "intensivo", "automatico"].includes(currentTherapyMode());
}

function canToggleTimerByTherapy() {
  return !!activeSessionId && isTherapyModeActive();
}

function setTimerHint(message = null) {
  const card = $("timerCard");
  const hint = card?.querySelector("small");
  if (!hint) return;

  if (message) {
    hint.textContent = message;
    return;
  }

  if (!activeSessionId) {
    hint.textContent = "Inicia terapia para activar";
  } else if (!isTherapyModeActive()) {
    hint.textContent = "En reposo: cronómetro pausado";
  } else {
    hint.textContent = running ? "Toca para pausar" : "Toca para reanudar";
  }
}

function pauseTimerLocalOnly() {
  if (!running) return;
  accMs += Date.now() - startMs;
  running = false;
  clearInterval(tick);
  tick = null;
  try { if (state.currentUserId) localStorage.setItem(STORAGE_KEY(state.currentUserId), String(accMs)); } catch (_) {}
  draw();
}

function syncTimerWithTherapyState() {
  if (!isTherapyModeActive()) pauseTimerLocalOnly();
  setTimerHint();
}

/** Inicializa el timer con milisegundos ya acumulados */
export function initTimer(initialMs = 0, sessionId = null) {
  if (running) { accMs += Date.now() - startMs; running = false; clearInterval(tick); tick = null; }
  accMs = initialMs;
  startMs = null;
  activeSessionId = sessionId || null;
  draw();
  setTimerHint();
}

/** Toggle play/pause del timer visual (no llama API) */
export function toggleTimer() {
  if (!state.currentUserId) return;
  if (running) {
    accMs += Date.now() - startMs;
    running = false;
    clearInterval(tick); tick = null;
    try { localStorage.setItem(STORAGE_KEY(state.currentUserId), String(accMs)); } catch (_) {}
    draw();
  } else {
    startMs = Date.now(); running = true;
    tick = setInterval(draw, 1000);
    draw();
  }
  setTimerHint();
}

// =========================================================
// SESIÓN EN BACKEND
// =========================================================

/** Inicia sesión en el backend y arranca timer */
export async function doStartSession(pacienteId, modoProgamado = "convencional") {
  if (activeSessionId) {
    if (!running) toggleTimer();
    return activeSessionId;
  }

  try {
    const { ok, data } = await startSession({ paciente_id: pacienteId, modo_programado: modoProgamado, tipo_control: "tutor" });
    if (ok && data.sesion_id) {
      activeSessionId = data.sesion_id;
      if (!running) toggleTimer();
      return data.sesion_id;
    }
    if (data?.error === "sesion_ya_activa") {
      activeSessionId = data.sesion_id;
      if (!running) toggleTimer();
      return data.sesion_id;
    }
  } catch (_) {}
  return null;
}

/** Pausa sesión en el backend */
export async function doPauseSession() {
  if (!activeSessionId) return;
  try { await pauseSession(activeSessionId); } catch (_) {}
  if (running) toggleTimer();
}

/** Finaliza sesión en el backend y actualiza plan */
export async function doFinishSession(motivo = "completada") {
  const durS = Math.floor(getAccMs() / 1000);
  if (activeSessionId) {
    try {
      await finishSession(activeSessionId, {
        duracion_s:           durS,
        tiempo_rango_s:       durS,  // se puede afinar con mediciones reales
        tiempo_fuera_rango_s: 0,
        motivo_fin:           motivo,
      });
    } catch (_) {}
  }
  if (running) { accMs += Date.now() - startMs; running = false; clearInterval(tick); tick = null; }
  activeSessionId = null;
  try {
    if (state.currentUserId) localStorage.setItem(STORAGE_KEY(state.currentUserId), "0");
  } catch (_) {}
  setTimerHint();
  return durS;
}

/** Guarda sesión (legacy + localStorage) sin detener el timer */
export async function saveSession() {
  if (!state.currentUserId) return;
  const totalMs = getAccMs();
  try { localStorage.setItem(STORAGE_KEY(state.currentUserId), String(totalMs)); } catch (_) {}

  // Si hay sesión activa en backend, finalizarla
  if (activeSessionId) {
    await doFinishSession("salida_usuario");
    return;
  }

  // Fallback legacy
  try {
    await saveSessionLegacy({
      paciente_id: state.currentUserId,
      duracion_s:  Math.floor(totalMs / 1000),
      tiempo_rango_s: 0,
      intensidad_promedio: null,
      observaciones: null,
    });
  } catch (_) {}
}

/** Guarda en localStorage antes de cerrar la pestaña (beacon) */
export function setupBeforeUnload() {
  window.addEventListener("beforeunload", () => {
    if (!state.currentUserId) return;
    const totalMs = getAccMs();
    try { localStorage.setItem(STORAGE_KEY(state.currentUserId), String(totalMs)); } catch (_) {}
    try {
      navigator.sendBeacon(
        `${window.location.origin}/api/sesiones`,
        new Blob([JSON.stringify({
          paciente_id: state.currentUserId,
          duracion_s: Math.floor(totalMs / 1000),
          tiempo_rango_s: 0,
          intensidad_promedio: null,
          observaciones: "auto-save-beforeunload",
        })], { type: "application/json" })
      );
    } catch (_) {}
  });
}

// =========================================================
// INIT SESSIONS
// =========================================================
export function initSessions() {
  if (sessionsBound) return;
  sessionsBound = true;

  $("timerCard")?.addEventListener("click", async () => {
    const mode = currentTherapyMode();

    // En REPOSO o sin modo terapéutico real, el cronómetro no arranca.
    if (!isTherapyModeActive()) {
      setTimerHint("No corre en modo reposo");
      window.setTimeout(() => setTimerHint(), 1400);
      return;
    }

    if (!state.currentUserId) {
      setTimerHint("Paciente no identificado");
      window.setTimeout(() => setTimerHint(), 1400);
      return;
    }

    // Si ya existe sesión activa, tocar la tarjeta pausa/reanuda.
    if (activeSessionId) {
      toggleTimer();
      return;
    }

    // Si el ESP ya está en CONVENCIONAL/INTENSIVO pero aún no hay sesión,
    // crearla aquí. Antes se quedaba diciendo “Primero inicia terapia”,
    // o sea, el reloj se volvió burócrata.
    setTimerHint("Iniciando terapia...");
    const id = await doStartSession(state.currentUserId, mode);
    if (!id) {
      setTimerHint("No se pudo iniciar la sesión");
      window.setTimeout(() => setTimerHint(), 1600);
      return;
    }
    setTimerHint();
  });

  ["neolight:telemetry", "neolight:control-updated", "neolight:lamp-command"].forEach(evt => {
    window.addEventListener(evt, syncTimerWithTherapyState);
  });

  window.addEventListener("neolight:session-started", event => {
    const payload = event.detail || {};
    if (payload.sesion_id) activeSessionId = payload.sesion_id;
    syncTimerWithTherapyState();
  });

  window.addEventListener("neolight:session-paused", syncTimerWithTherapyState);
  window.addEventListener("neolight:session-finished", () => {
    activeSessionId = null;
    pauseTimerLocalOnly();
    setTimerHint();
  });

  setupBeforeUnload();
  setTimerHint();
}
