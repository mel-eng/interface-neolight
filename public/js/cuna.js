// =========================================================
// public/js/cuna.js
// Tarjeta de la cuna balanza (equipo CUNA-01) en los paneles
// del tutor y del doctor: peso, talla y temperatura en vivo,
// y el botón para guardar la medición en la ficha.
// =========================================================

import { apiFetch } from "./config.js";

let role = null;
let getPatientId = () => null;
let lampPatientId = null;
let current = { online: false };
let bound = false;
let poll = null;

const fmt = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("es-BO", { maximumFractionDigits: d, minimumFractionDigits: d }));
const tempTone = t => t == null ? "" : t < 36.5 ? "is-low" : t > 37.5 ? "is-high" : "is-ok";
const tempText = t => t == null ? "" : t < 36.5 ? "Baja" : t > 37.5 ? "Alta" : "Normal";

function cardHtml() {
  return `
    <div class="cuna-card-head">
      <h3><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10h18v3a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z"/><path d="M6 19l-1 2M18 19l1 2M7 10V7a5 5 0 0 1 10 0v3"/></svg>Cuna</h3>
      <span class="cuna-pill" data-k="estado">Sin conexión</span>
    </div>
    <div class="cuna-grid">
      <div><small>Peso</small><b data-k="peso">—</b><em data-k="estable"></em></div>
      <div><small>Talla</small><b data-k="talla">—</b><em></em></div>
      <div><small>Temperatura</small><b data-k="temp">—</b><em data-k="tempEstado"></em></div>
    </div>
    <button type="button" class="cuna-save" data-k="guardar" disabled>Guardar en la ficha</button>
    <p class="cuna-note" data-k="nota" aria-live="polite"></p>`;
}

function mount() {
  const places = [
    { parent: document.querySelector("#view-dashboard-patient .patient-connection-card"), where: "beforebegin", id: "ptCunaCard" },
    { parent: document.getElementById("doctorSystemStatus")?.closest(".doctor-rail-card"), where: "afterend", id: "docCunaCard" },
  ];
  for (const p of places) {
    if (!p.parent || document.getElementById(p.id)) continue;
    const card = document.createElement("div");
    card.id = p.id;
    card.className = `cuna-card ${p.id === "docCunaCard" ? "doctor-rail-card" : ""}`;
    card.innerHTML = cardHtml();
    card.querySelector('[data-k="guardar"]').addEventListener("click", save);
    p.parent.insertAdjacentElement(p.where, card);
  }
}

function paint() {
  const c = current || {};
  document.querySelectorAll(".cuna-card").forEach(card => {
    const set = (k, v) => { const el = card.querySelector(`[data-k="${k}"]`); if (el) el.textContent = v; };
    card.dataset.online = c.online ? "1" : "0";
    set("estado", c.online ? "Conectada" : "Sin conexión");
    set("peso", c.online && c.peso_g != null ? `${fmt(c.peso_g / 1000, 2)} kg` : "—");
    set("estable", c.online && c.peso_g != null ? (c.estable === false ? "Midiendo…" : "Estable") : "");
    set("talla", c.online && c.talla_cm != null ? `${fmt(c.talla_cm, 1)} cm` : "—");
    set("temp", c.online && c.temp_c != null ? `${fmt(c.temp_c, 1)} °C` : "—");
    set("tempEstado", c.online ? tempText(c.temp_c) : "");
    const t = card.querySelector('[data-k="temp"]');
    if (t) t.className = c.online ? tempTone(c.temp_c) : "";
    const btn = card.querySelector('[data-k="guardar"]');
    if (btn) btn.disabled = !c.online || (c.peso_g == null && c.talla_cm == null) || c.estable === false || !patientId();
  });
}

function patientId() {
  return role === "doctor" ? lampPatientId : getPatientId();
}

async function save(event) {
  const card = event.currentTarget.closest(".cuna-card");
  const note = card.querySelector('[data-k="nota"]');
  const id = patientId();
  if (!id) { note.textContent = "No hay un paciente asignado a la lámpara."; return; }
  event.currentTarget.disabled = true;
  try {
    const res = await apiFetch(`/api/patients/${id}/antropometria`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origen: "cuna" }),
    });
    const data = await res.json().catch(() => ({}));
    note.textContent = res.ok
      ? `Guardado en la ficha: ${data.peso_g != null ? fmt(data.peso_g / 1000, 2) + " kg" : ""}${data.peso_g != null && data.talla_cm != null ? " · " : ""}${data.talla_cm != null ? fmt(data.talla_cm, 1) + " cm" : ""}`
      : (data.message || "No se pudo guardar.");
    note.dataset.ok = res.ok ? "1" : "0";
  } catch (_) {
    note.textContent = "Sin conexión con el servidor."; note.dataset.ok = "0";
  }
  paint();
}

async function refresh() {
  try {
    const res = await apiFetch("/api/cuna/estado");
    if (res.ok) { current = (await res.json()).cuna || { online: false }; paint(); }
  } catch (_) {}
}

export function initCuna(currentRole, { patientId: getter } = {}) {
  role = currentRole;
  if (role !== "tutor" && role !== "doctor") return;
  getPatientId = typeof getter === "function" ? getter : () => null;
  mount();
  if (!bound) {
    bound = true;
    window.addEventListener("neolight:cuna", e => { if (role) { current = e.detail || { online: false }; paint(); } });
    window.addEventListener("neolight:telemetry", e => {
      if (!role) return;
      if (e.detail?.paciente_id) lampPatientId = e.detail.paciente_id;
      if (e.detail?.cuna) { current = e.detail.cuna; paint(); }
    });
  }
  window.clearInterval(poll);
  poll = window.setInterval(() => { if (role) refresh(); }, 5000);   // detecta cuándo la cuna se desconecta
  refresh();
}

export function stopCuna() {
  role = null;
  window.clearInterval(poll);
}
