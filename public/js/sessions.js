// =========================================================
// public/js/sessions.js
// Cronómetro de la sesión en curso (panel del tutor).
//
// La sesión la abre y la cierra el servidor según lo que hace la lámpara:
// empieza cuando la lámpara entra en terapia y termina cuando se detiene
// o se desconecta. Aquí solo se muestra el tiempo transcurrido.
// =========================================================

import { $, state } from "./config.js";

let startedAtMs = null;
let tick = null;
let activeSessionId = null;
let sessionsBound = false;

const format = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function draw() {
  const el = $("tiempoTerapia");
  if (el) el.textContent = format(startedAtMs ? Date.now() - startedAtMs : 0);
  const hero = $("patientHeroTime");
  if (hero && startedAtMs) hero.textContent = el?.textContent || "";
}

function setHint(text) {
  const hint = $("timerCard")?.querySelector("small");
  if (hint) hint.textContent = text;
}

function start(startedAt, sessionId) {
  const parsed = startedAt ? new Date(startedAt).getTime() : Date.now();
  startedAtMs = Number.isFinite(parsed) ? Math.min(parsed, Date.now()) : Date.now();
  activeSessionId = sessionId || null;
  clearInterval(tick);
  tick = setInterval(draw, 1000);
  draw();
  setHint("Sesión en curso");
}

function stop() {
  clearInterval(tick);
  tick = null;
  startedAtMs = null;
  activeSessionId = null;
  draw();
  setHint("Empieza sola cuando la lámpara inicia la terapia");
}

export function getActiveSessionId() { return activeSessionId; }
export function isRunning() { return !!startedAtMs; }

/** Sincroniza el cronómetro con la sesión que informa el servidor (o la detiene si no hay). */
export function initTimer(session = null) {
  if (session && ["active", "paused"].includes(session.status)) start(session.started_at, session.id);
  else stop();
}

/** Se conserva por compatibilidad: salir del panel ya no cierra la sesión de la lámpara. */
export async function saveSession() {}

export function initSessions() {
  if (sessionsBound) return;
  sessionsBound = true;

  const isMine = payload => !payload?.paciente_id || String(payload.paciente_id) === String(state.currentUserId);

  window.addEventListener("neolight:session-started", event => {
    const payload = event.detail || {};
    if (state.currentRole === "tutor" && isMine(payload)) start(null, payload.sesion_id);
  });
  window.addEventListener("neolight:session-finished", event => {
    if (state.currentRole === "tutor" && isMine(event.detail)) stop();
  });
  stop();
}
