// =========================================================
// public/js/antifaz.js
// Verificación del antifaz: indicador en vivo y alarma.
//  - Tutor: una etiqueta simple (sin datos técnicos).
//  - Doctor: estado en vivo y alarma.
//  - Superusuario: el detalle completo de cada lectura.
// =========================================================

import { $, apiFetch } from "./config.js";

// tono: ok | warn | bad | off
const TONES = {
  ok: "ok", revisando: "off", en_espera: "off", inactivo: "off",
  ojos_expuestos: "bad", antifaz_ausente: "bad", desplazado: "bad", nariz_cubierta: "bad",
  no_verificable: "warn", sin_camara: "warn", sin_verificacion: "warn",
};
// Lo que lee la familia: corto y sin tecnicismos.
const FAMILY_TEXT = {
  ok: "Antifaz verificado", revisando: "Revisando antifaz", en_espera: "Supervisión de antifaz lista",
  ojos_expuestos: "Revisar antifaz: lámpara apagada", antifaz_ausente: "Revisar antifaz: lámpara apagada",
  desplazado: "Revisar antifaz: lámpara apagada", nariz_cubierta: "Revisar antifaz: lámpara apagada",
  no_verificable: "No se ve el rostro del bebé", sin_camara: "Cámara sin imagen", sin_verificacion: "Antifaz sin verificar",
};

let current = null;
let role = null;
let bound = false;
let pollTimer = null;

export const getAntifaz = () => current;

function paint() {
  const a = current;
  const tone = a ? (TONES[a.estado] || "off") : "off";

  const family = $("ptAntifazChip");
  if (family) {
    family.hidden = !a || a.estado === "inactivo";
    family.dataset.tone = tone;
    family.textContent = a ? (FAMILY_TEXT[a.estado] || a.etiqueta) : "";
  }

  const doctor = $("doctorAntifazStatus");
  if (doctor) {
    doctor.hidden = !a;
    doctor.dataset.tone = tone;
    doctor.textContent = a ? `Antifaz: ${a.estado === "inactivo" ? "supervisión desactivada" : a.etiqueta.replace(/^Antifaz /, "").toLowerCase()}` : "";
    if (a?.bloqueo && TONES[a.estado] !== "bad") doctor.textContent += " · lámpara apagada por seguridad";
  }

  window.dispatchEvent(new CustomEvent("neolight:antifaz", { detail: a || {} }));
}

export async function refreshAntifaz() {
  try {
    const res = await apiFetch("/api/antifaz/estado");
    if (!res.ok) return current;
    const data = await res.json();
    current = data?.antifaz || null;
    paint();
  } catch (_) {}
  return current;
}

// ---------- Alarma ----------

let alarmAudioCtx = null;
function alarmSound(times = 3) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    alarmAudioCtx = alarmAudioCtx || new Ctx();
    const ctx = alarmAudioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    for (let i = 0; i < times; i++) {
      const t = ctx.currentTime + i * 0.42;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.32);
    }
  } catch (_) {}
}

function showAlarm(payload) {
  const apagado = !!payload.apagado;
  document.getElementById("antifazAlarm")?.remove();
  const box = document.createElement("div");
  box.id = "antifazAlarm";
  box.className = `antifaz-alarm ${apagado ? "is-critical" : "is-warning"}`;
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-live", "assertive");
  box.innerHTML = `
    <div class="antifaz-alarm-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    </div>
    <div class="antifaz-alarm-text">
      <strong></strong>
      <span></span>
      <small></small>
    </div>
    <button type="button" class="antifaz-alarm-btn">Entendido</button>`;
  box.querySelector("strong").textContent = apagado ? "Lámpara apagada por seguridad" : "Revisar al bebé";
  box.querySelector("span").textContent = payload.mensaje || payload.etiqueta || "";
  box.querySelector("small").textContent = apagado
    ? "Acomoda el antifaz. La lámpara no se enciende sola: el personal debe reanudar la terapia."
    : "La lámpara sigue encendida. Verifica la posición del bebé y del antifaz.";
  box.querySelector("button").addEventListener("click", () => box.remove());
  document.body.appendChild(box);
  alarmSound(apagado ? 4 : 2);
  if (!apagado) window.setTimeout(() => box.remove(), 20000);
}

// ---------- Inicio ----------

export function initAntifaz(currentRole) {
  role = currentRole;
  if (!bound) {
    bound = true;
    window.addEventListener("neolight:antifaz-estado", event => {
      if (!role) return;
      // El aviso por socket trae el resumen; el detalle (doctor/superusuario) se pide aparte.
      current = { ...(current || {}), ...event.detail };
      paint();
      if (role !== "tutor") refreshAntifaz();
    });
    window.addEventListener("neolight:antifaz-alarma", event => {
      if (!role) return;
      current = { ...(current || {}), ...event.detail };
      paint();
      showAlarm(event.detail || {});
    });
  }
  window.clearInterval(pollTimer);
  // Respaldo por si se pierde algún aviso en vivo.
  pollTimer = window.setInterval(() => { if (role) refreshAntifaz(); }, role === "superuser" ? 2500 : 8000);
  refreshAntifaz();
}

export function stopAntifaz() {
  role = null;
  current = null;
  window.clearInterval(pollTimer);
  document.getElementById("antifazAlarm")?.remove();
  paint();
}

export async function setSupervision(on) {
  const res = await apiFetch("/api/antifaz/supervision", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.antifaz) { current = data.antifaz; paint(); }
  return { ok: res.ok, message: data?.message };
}

export async function testAI() {
  const res = await apiFetch("/api/antifaz/probar", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.antifaz) { current = data.antifaz; paint(); }
  return { ok: res.ok, lectura: data?.lectura, etiqueta: data?.etiqueta, message: data?.message };
}
