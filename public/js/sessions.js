// =========================================================
// public/js/sessions.js
// Cronómetro de la sesión en curso (panel del tutor).
//
// La sesión la abre y la cierra el servidor según lo que hace la lámpara:
// empieza cuando la lámpara entra en terapia y termina cuando se detiene
// o se desconecta. Aquí solo se muestra el tiempo transcurrido.
// =========================================================

import { $, state } from "./config.js";

// El cronómetro muestra el TIEMPO REAL DE TERAPIA (solo con la luz prendida).
// Si la lámpara pasa a reposo (STOP, antifaz, pausa) se congela y sigue cuando vuelve la luz.
let baseS = 0;            // segundos de terapia que informó el servidor
let baseTs = 0;           // cuándo los informó
let corriendo = false;    // la luz está prendida ahora
let enSesion = false;
let tick = null;
let activeSessionId = null;
let sessionsBound = false;

const format = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const segundos = () => baseS + (corriendo ? Math.max(0, (Date.now() - baseTs) / 1000) : 0);

function draw() {
  const el = $("tiempoTerapia");
  if (el) el.textContent = format(enSesion ? segundos() * 1000 : 0);
  const hero = $("patientHeroTime");
  if (hero && enSesion) hero.textContent = el?.textContent || "";
}

function setHint(text) {
  const hint = $("timerCard")?.querySelector("small");
  if (hint) hint.textContent = text;
}

function hintActual() {
  setHint(!enSesion ? "Empieza sola cuando la lámpara inicia la terapia"
    : corriendo ? "Sesión en curso" : "En pausa: la luz está apagada");
}

function set(efectivoS, estaCorriendo, sessionId) {
  enSesion = true;
  baseS = Math.max(0, Number(efectivoS) || 0);
  baseTs = Date.now();
  corriendo = !!estaCorriendo;
  if (sessionId) activeSessionId = sessionId;
  if (!tick) tick = setInterval(draw, 1000);
  draw();
  hintActual();
}

function stop() {
  clearInterval(tick);
  tick = null;
  enSesion = false;
  corriendo = false;
  baseS = 0;
  activeSessionId = null;
  draw();
  hintActual();
}

export function getActiveSessionId() { return activeSessionId; }
export function isRunning() { return enSesion && corriendo; }

/** Sincroniza el cronómetro con la sesión que informa el servidor (o la detiene si no hay). */
export function initTimer(session = null) {
  if (!session || !["active", "paused"].includes(session.status)) { stop(); return; }
  // Servidor nuevo: manda el tiempo efectivo. Servidor viejo: se cuenta desde el inicio.
  const ef = session.efectivo_s != null ? session.efectivo_s
    : session.started_at ? (Date.now() - new Date(session.started_at).getTime()) / 1000 : 0;
  set(ef, session.corriendo ?? true, session.id);
}

/** Se conserva por compatibilidad: salir del panel ya no cierra la sesión de la lámpara. */
export async function saveSession() {}

export function initSessions() {
  if (sessionsBound) return;
  sessionsBound = true;

  const isMine = payload => !payload?.paciente_id || String(payload.paciente_id) === String(state.currentUserId);

  window.addEventListener("neolight:session-started", event => {
    const payload = event.detail || {};
    if (state.currentRole === "tutor" && isMine(payload)) set(0, true, payload.sesion_id);
  });
  // Cada segundo el servidor dice cuánto tiempo de luz lleva la sesión y si está corriendo.
  window.addEventListener("neolight:sesion-tiempo", event => {
    const p = event.detail || {};
    if (state.currentRole === "tutor" && isMine(p)) set(p.efectivo_s, p.corriendo, p.sesion_id);
  });
  window.addEventListener("neolight:session-finished", event => {
    if (state.currentRole === "tutor" && isMine(event.detail)) stop();
  });
  stop();
}
