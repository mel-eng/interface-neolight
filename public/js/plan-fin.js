// =========================================================
// public/js/plan-fin.js
// Fin de terapia: cuando el bebé cumple las horas del plan, la lámpara
// se apaga sola y aquí se muestra la estrellita (tutor y doctor).
// =========================================================

import { escapeHtml } from "./config.js";

let bound = false;
let audioCtx = null;

const STAR_SVG = `
<svg class="nl-fin-star" viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <linearGradient id="nlFinGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd76a"/><stop offset="1" stop-color="#f5a524"/>
    </linearGradient>
  </defs>
  <circle cx="60" cy="60" r="56" class="nl-fin-halo"/>
  <path d="M60 14l13.2 28.6 31.3 3.6-23.3 21.2 6.4 30.8L60 82.6 32.4 98.2l6.4-30.8L15.5 46.2l31.3-3.6z"
        fill="url(#nlFinGrad)" stroke="#e08e0b" stroke-width="3" stroke-linejoin="round"/>
  <path d="M47 60c2.5 3 5.5 4.5 13 4.5s10.5-1.5 13-4.5" fill="none" stroke="#8a4b00" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="49" cy="51" r="3.2" fill="#8a4b00"/><circle cx="71" cy="51" r="3.2" fill="#8a4b00"/>
</svg>`;

// Campanita alegre en el navegador (la lámpara toca su propia melodía).
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    const ctx = audioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    [[0, 1047], [0.14, 1319], [0.28, 1568], [0.42, 2093], [0.86, 1568], [1.0, 2093]].forEach(([t, f], i, all) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const dur = i === all.length - 1 ? 0.5 : i === 3 ? 0.3 : 0.13;
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + dur + 0.05);
    });
  } catch (_) {}
}

function horasTxt(h) {
  const n = Number(h || 0);
  if (n < 1) return `${Math.round(n * 60)} min`;
  return `${String(+n.toFixed(2)).replace(".", ",")} h`;
}

export function showPlanCompletado(payload = {}, role = "tutor") {
  document.getElementById("nlFinOverlay")?.remove();
  const nombre = escapeHtml(payload.paciente || "el bebé");
  const horas = horasTxt(payload.horas);
  const doctor = role === "doctor";
  const el = document.createElement("div");
  el.id = "nlFinOverlay";
  el.className = "nl-fin-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `
    <div class="nl-fin-card">
      <div class="nl-fin-sparkles" aria-hidden="true">${"<i></i>".repeat(10)}</div>
      ${STAR_SVG}
      <h2>¡Terapia completada!</h2>
      <p class="nl-fin-main">${doctor
        ? `<b>${nombre}</b> cumplió las ${horas} de fototerapia del plan.`
        : `<b>${nombre}</b> terminó sus ${horas} de fototerapia. ¡Muy bien!`}</p>
      <p class="nl-fin-sub">${doctor
        ? "La lámpara se apagó sola. Revisa la ficha y decide: dar el alta o indicar un nuevo plan."
        : "La lámpara se apagó sola. El doctor revisará a tu bebé y decidirá si le da el alta o si continúa la terapia."}</p>
      <button type="button" class="nl-fin-btn">${doctor ? "Ver pacientes" : "Entendido"}</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".nl-fin-btn").addEventListener("click", () => el.remove());
  el.addEventListener("click", e => { if (e.target === el) el.remove(); });
  chime();
}

export function initPlanFin(role) {
  if (bound) return;
  bound = true;
  window.addEventListener("neolight:plan-completado", e => {
    const p = e.detail || {};
    if (role === "doctor" && p.forDoctor) showPlanCompletado(p, "doctor");
    else if (role === "tutor" && p.forPatient) showPlanCompletado(p, "tutor");
  });
}
