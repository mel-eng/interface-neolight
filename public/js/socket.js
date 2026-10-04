// =========================================================
// public/js/socket.js
// Maneja Socket.IO: conexión, telemetría, estado ESP32,
// pacientes online/offline y comandos de modo/altura
// =========================================================

import { API_URL, $ } from "./config.js";

let ioSocket = null;
let alarmsMutedUI = false;
let identifiedPatientId = null;
let identifiedDoctorId = null;
let identifiedTutorId = null;
let identifiedSuperuserId = null;

// =========================================================
// ALARMAS PEDIÁTRICAS: sonido suave + campanita
// =========================================================
let lastAlarmSoundAt = 0;
let alarmAudioCtx = null;

function playPediatricAlarmSound() {
  const now = Date.now();
  if (now - lastAlarmSoundAt < 2500) return;
  lastAlarmSoundAt = now;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    alarmAudioCtx = alarmAudioCtx || new AudioContextClass();
    const ctx = alarmAudioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const tone = (start, freq, duration, volume) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration + 0.04);
    };

    tone(0.00, 660, 0.20, 0.045);
    tone(0.27, 880, 0.20, 0.040);
  } catch (_) {}
}

function animatePatientAlarmUI(payload = {}, opts = {}) {
  const bell = $("patientBell") || document.querySelector("#view-dashboard-patient .pt-bell-btn");
  const badge = $("ptBellBadge");
  const card = $("ptAlertCard");
  const msg = $("ptAlertMsg");
  const cnt = $("ptAlertCount");

  bell?.classList.remove("ringing", "pt-has-alert");
  card?.classList.remove("pt-alert-pulse", "pt-has-alert");
  void bell?.offsetWidth;
  void card?.offsetWidth;

  bell?.classList.add("ringing", "pt-has-alert");
  card?.classList.add("pt-alert-pulse", "pt-has-alert");

  if (badge) {
    const current = Number(badge.textContent || "0") || 0;
    const next = payload?.active_count != null ? Number(payload.active_count) : current + 1;
    badge.textContent = String(Math.max(1, next));
    badge.classList.add("pt-badge-visible");
  }

  const alarmName = payload?.tipo || payload?.type || "alarma";
  if (msg) msg.textContent = `Alerta: ${alarmName}`;
  if (cnt) cnt.textContent = badge?.textContent || "1";

  if (opts.sound) playPediatricAlarmSound();
}

function shouldPlayAlarmSound(payload = {}) {
  const sev = String(payload?.severidad || payload?.severity || "").toLowerCase();
  const tipo = String(payload?.tipo || payload?.type || "").toLowerCase();
  const valor = Number(payload?.valor ?? payload?.valor_medido ?? payload?.value);

  if (sev === "critical") return true;

  if (tipo === "temperatura_baja") {
    return Number.isFinite(valor) ? valor < 34.8 : true;
  }

  if (tipo === "temperatura_alta") {
    return Number.isFinite(valor) ? valor > 38.0 : true;
  }

  return false;
}

// =========================================================
// ESTADO ESP32 Y HUD
// =========================================================

export function setESPStatus(text, kind) {
  const tag = $("espStatus"); if (!tag) return;
  tag.textContent = text;
  tag.style.color =
    kind === "ok"   ? "#15803d" :
    kind === "warn" ? "#b4560d" : "#c0152a";
}

export function updateHUD(data) {
  const cm  = Number(data?.cm  ?? data?.distance_cm ?? data?.distance);
  const pct = Number(data?.pct ?? data?.percent ?? data?.illumination_pct ?? data?.illumination);
  const hudDist = $("hudDist"), hudLux = $("hudLux"), altActual = $("pacAlturaActual");
  if (hudDist)   hudDist.textContent   = Number.isFinite(cm)  ? `${Math.round(cm)} cm`  : "—";
  if (hudLux)    hudLux.textContent    = Number.isFinite(pct) ? `${Math.round(pct)} %`  : "—";
  if (altActual && Number.isFinite(cm)) altActual.textContent = Math.round(cm) + " cm";
}

export function updateTemps(data) {
  const bebe     = Number(data?.bebe     ?? data?.temp_body_c ?? data?.temp_bebe);
  const ambiente = Number(data?.ambiente ?? data?.temp_amb_c  ?? data?.temp_ambiente);
  const tb = $("tempBebe"), ta = $("tempAmbiente");
  if (tb) tb.textContent = Number.isFinite(bebe)     ? `${bebe.toFixed(1)} °C`     : "—";
  if (ta) ta.textContent = Number.isFinite(ambiente) ? `${ambiente.toFixed(1)} °C` : "—";
}

export function updateStatusCard(st) {
  const lbl  = $("statusLabel");
  const det  = $("statusDetail");
  const card = $("statusCard");
  if (!lbl || !det) return;

  if (!st) {
    lbl.textContent = "Sin datos";
    det.textContent = "Esperando lecturas del sistema…";
    card?.classList.remove("state-ok","state-warn","state-danger");
    return;
  }

  const map = {
    ok:                ["En rango óptimo",       "Temperatura del bebé estable.",                  "state-ok"],
    frio_leve:         ["Frío leve",              "Por debajo del rango objetivo, pero leve.",      "state-warn"],
    caliente_leve:     ["Caliente leve",          "Por encima del rango objetivo, pero leve.",      "state-warn"],
    frio:              ["Frío (riesgo)",           "Posible hipotermia. Verificar parámetros.",      "state-danger"],
    caliente:          ["Caliente (riesgo)",       "Posible hipertermia. Evaluar de inmediato.",     "state-danger"],
    peligro_distancia: ["Distancia insegura",      "Bebé demasiado cerca de la lámpara.",            "state-danger"],
    alarma_sensor:     ["Alarma de sensores",      "Revisar ultrasonido y termistores.",             "state-danger"],
  };

  const [txt, detail, cls] = map[st.estado] || ["Sin datos","Esperando lecturas del sistema…",""];
  lbl.textContent = txt;
  det.textContent = detail;
  card?.classList.remove("state-ok","state-warn","state-danger");
  if (cls) card?.classList.add(cls);
}

// =========================================================
// MUTE ALARMS UI
// =========================================================

export function updateMuteButtonFromState(muted) {
  alarmsMutedUI = !!muted;
  const btn = $("muteAlarmsBtn"); if (!btn) return;
  btn.textContent = alarmsMutedUI
    ? "Alarmas silenciadas (click para reactivar)"
    : "Silenciar alarmas (5 min)";
}

export function isAlarmsMuted() { return alarmsMutedUI; }
export function getSocket()     { return ioSocket; }

function dispatchRealtimeEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(`neolight:${name}`, { detail: detail || {} }));
}


// =========================================================
// NOTIFICACIONES EN TIEMPO REAL (tipo Facebook, sin refresh)
// =========================================================
let notificationAudioCtx = null;
let lastNotificationSoundAt = 0;

export function playNotificationSound() {
  const now = Date.now();
  if (now - lastNotificationSoundAt < 900) return;
  lastNotificationSoundAt = now;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    notificationAudioCtx = notificationAudioCtx || new AudioContextClass();
    const ctx = notificationAudioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(740, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(980, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

export function showRealtimeToast(message, kind = "status") {
  let stack = document.getElementById("neolightRealtimeToasts");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "neolightRealtimeToasts";
    stack.className = "neolight-toast-stack";
    document.body.appendChild(stack);
  }
  const toast = document.createElement("div");
  toast.className = `neolight-toast neolight-toast--${kind}`;
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 250);
  }, 4200);
}

function isPayloadForCurrentDoctor(payload = {}) {
  return !!identifiedDoctorId && (!payload?.doctor_id || String(payload.doctor_id) === String(identifiedDoctorId));
}

function isPayloadForCurrentPatient(payload = {}) {
  return !!identifiedPatientId && (!payload?.paciente_id || String(payload.paciente_id) === String(identifiedPatientId));
}

// =========================================================
// INIT SOCKET
// =========================================================

export function initSocket() {
  if (ioSocket) return ioSocket;
  try {
    ioSocket = io(API_URL, { transports: ["websocket"], reconnection: true });

    ioSocket.on("connect",    () => {
      setESPStatus("Esperando…", "warn");
      if (identifiedDoctorId) socketIdentifyDoctor(identifiedDoctorId);
      if (identifiedSuperuserId) socketIdentifySuperuser(identifiedSuperuserId);
      if (identifiedPatientId) ioSocket.emit("patient:identify", { id: identifiedPatientId });
      if (identifiedPatientId || identifiedTutorId) socketIdentifyTutor(identifiedTutorId, identifiedPatientId);
    });
    ioSocket.on("disconnect", () => {
      setESPStatus("Sin servidor", "err");
      updateHUD({});
      updateTemps({});
      updateStatusCard(null);
    });

    ioSocket.on("lamp:port", st => {
      setESPStatus(st?.open ? "Conectada" : "Sin conexión", st?.open ? "ok" : "warn");
      if (!st?.open) { updateHUD({}); updateTemps({}); }
      dispatchRealtimeEvent("esp32-status", st || {});
    });

    ioSocket.on("telemetry", payload => {
      updateHUD(payload || {});
      if (payload?.temp_bebe != null || payload?.temp_ambiente != null) updateTemps(payload || {});
      if (payload?.estado) updateStatusCard(payload || {});
      if (payload?.alarms_muted != null) updateMuteButtonFromState(!!payload.alarms_muted);
      setESPStatus(payload?.esp32_connected === false ? "Sin conexión" : "Conectada", payload?.esp32_connected === false ? "warn" : "ok");
      dispatchRealtimeEvent("telemetry", payload || {});
    });

    ioSocket.on("temps",  payload => { updateTemps(payload || {}); dispatchRealtimeEvent("temps", payload || {}); });
    ioSocket.on("status", payload => { updateStatusCard(payload); dispatchRealtimeEvent("status", payload || {}); });
    ioSocket.on("esp32:status", payload => {
      setESPStatus(payload?.connected ? "Conectada" : "Sin conexión", payload?.connected ? "ok" : "warn");
      dispatchRealtimeEvent("esp32-status", payload || {});
    });

    ioSocket.on("alarm:new", payload => {
      console.warn("[ALARM]", payload?.tipo, payload?.severidad);
      if (isPayloadForCurrentPatient(payload || {}) || isPayloadForCurrentDoctor(payload || {})) {
        const sev = String(payload?.severidad || "").toLowerCase();
        const shouldSound = shouldPlayAlarmSound(payload || {});
        animatePatientAlarmUI(payload || {}, { sound: shouldSound });
        const label = payload?.mensaje || payload?.tipo || "Alarma del sistema";
        showRealtimeToast(`Alerta: ${label}`, sev === "critical" ? "danger" : "warn");
      }
      dispatchRealtimeEvent("alarm-new", payload || {});
    });

    ioSocket.on("alarm", payload => {
      animatePatientAlarmUI(payload || {}, { sound: shouldPlayAlarmSound(payload || {}) });
      dispatchRealtimeEvent("alarm-new", payload || {});
    });
    ioSocket.on("alarma", payload => {
      animatePatientAlarmUI(payload || {}, { sound: shouldPlayAlarmSound(payload || {}) });
      dispatchRealtimeEvent("alarm-new", payload || {});
    });
    ioSocket.on("alarm:muted", payload => dispatchRealtimeEvent("alarm-muted", payload || {}));
    ioSocket.on("session:started",  payload => { console.log("[SESSION] started", payload); dispatchRealtimeEvent("session-started", payload || {}); });
    ioSocket.on("session:paused",   payload => { console.log("[SESSION] paused",  payload); dispatchRealtimeEvent("session-paused", payload || {}); });
    ioSocket.on("session:finished", payload => { console.log("[SESSION] finished",payload); dispatchRealtimeEvent("session-finished", payload || {}); });
    ioSocket.on("plan:updated", payload => dispatchRealtimeEvent("plan-updated", payload || {}));
    ioSocket.on("doctor-request:new", payload => {
      if (isPayloadForCurrentDoctor(payload || {})) {
        playNotificationSound();
        showRealtimeToast("Nueva solicitud de paciente", "info");
      }
      dispatchRealtimeEvent("doctor-request-new", payload || {});
    });
    ioSocket.on("doctor-request:resolved", payload => {
      if (isPayloadForCurrentPatient(payload || {})) {
        playNotificationSound();
        showRealtimeToast(payload?.status === "accepted" ? "Solicitud aceptada" : "Solicitud rechazada", payload?.status === "accepted" ? "ok" : "warn");
      }
      dispatchRealtimeEvent("doctor-request-resolved", payload || {});
    });
    ioSocket.on("patient:registered", payload => dispatchRealtimeEvent("patient-registered", payload || {}));
    ioSocket.on("mode-request:new", payload => {
      if (isPayloadForCurrentDoctor(payload || {})) {
        playNotificationSound();
        const label = payload?.request_type === "manual_control" ? "control manual" : `modo ${payload?.mode || ""}`.trim();
        showRealtimeToast(`Nueva solicitud de ${label}`, "info");
      }
      dispatchRealtimeEvent("mode-request-new", payload || {});
    });
    ioSocket.on("mode-request:resolved", payload => {
      if (isPayloadForCurrentPatient(payload || {})) {
        playNotificationSound();
        const ok = payload?.status === "accepted";
        const label = payload?.request_type === "manual_control" ? "control manual" : `modo ${payload?.mode || ""}`.trim();
        showRealtimeToast(`${ok ? "Aprobado" : "Rechazado"}: ${label}`, ok ? "ok" : "warn");
      }
      dispatchRealtimeEvent("mode-request-resolved", payload || {});
    });
    ioSocket.on("lamp:command", payload => dispatchRealtimeEvent("lamp-command", payload || {}));

    ioSocket.on("control:updated", payload => {
      dispatchRealtimeEvent("control-updated", payload || {});
    });

  } catch (_) {
    setESPStatus("Error", "err");
  }
  return ioSocket;
}

export function disconnectSocket() {
  identifiedPatientId = null;
  identifiedDoctorId = null;
  identifiedTutorId = null;
  identifiedSuperuserId = null;
  if (ioSocket) { ioSocket.disconnect(); ioSocket = null; }
}

// =========================================================
// COMANDOS SOCKET DESDE FRONTEND
// =========================================================

export function socketEmitMode(mode) {
  if (!ioSocket?.connected) return false;
  ioSocket.emit("lamp:mode", { mode });
  return true;
}

export function socketEmitMove(dir) {
  if (!ioSocket?.connected) return false;
  ioSocket.emit("lamp:move", { dir });
  return true;
}

export function socketEmitMute(mute) {
  if (!ioSocket?.connected) return false;
  ioSocket.emit("alarms:mute", { mute });
  return true;
}

export function socketIdentifyPatient(patientId) {
  identifiedPatientId = patientId ? String(patientId) : null;
  if (!ioSocket?.connected || !identifiedPatientId) return;
  ioSocket.emit("patient:identify", { id: identifiedPatientId });
  ioSocket.emit("client:identify", { role: "patient", paciente_id: identifiedPatientId, tutor_id: identifiedTutorId });
}

export function socketIdentifyDoctor(doctorId) {
  identifiedDoctorId = doctorId ? String(doctorId) : null;
  if (!ioSocket?.connected || !identifiedDoctorId) return;
  ioSocket.emit("client:identify", { role: "doctor", doctor_id: identifiedDoctorId });
}

export function socketIdentifyTutor(tutorId, pacienteId = identifiedPatientId) {
  identifiedTutorId = tutorId ? String(tutorId) : null;
  identifiedPatientId = pacienteId ? String(pacienteId) : identifiedPatientId;
  if (!ioSocket?.connected || !identifiedPatientId) return;
  ioSocket.emit("client:identify", { role: "tutor", tutor_id: identifiedTutorId, paciente_id: identifiedPatientId });
}

export function socketIdentifySuperuser(superuserId) {
  identifiedSuperuserId = superuserId ? String(superuserId) : null;
  if (!ioSocket?.connected || !identifiedSuperuserId) return;
  ioSocket.emit("client:identify", { role: "superuser", superuser_id: identifiedSuperuserId });
}
