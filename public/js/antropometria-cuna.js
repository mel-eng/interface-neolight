// =========================================================
// public/js/antropometria-cuna.js
// Bloque "Antropometría (cuna)" dentro de Editar ficha del doctor.
// - Asignar la cuna a este paciente (la cuna muestra "Pac: <nombre>").
// - Ver en vivo peso, talla y temperatura de la cuna.
// - Actualizar antropometría: guarda lo que marca la cuna en la ficha.
// Cuando en la cuna se toca MEDIR, el peso se actualiza solo aquí.
// =========================================================

import { apiFetch } from "./config.js";

const fmt = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? "—"
  : Number(v).toLocaleString("es-BO", { maximumFractionDigits: d, minimumFractionDigits: d }));
const fecha = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" }); };

export function antropometriaCunaHtml() {
  return `
    <div class="antro-cuna" id="antroCuna">
      <div class="antro-cuna-head">
        <div class="panel-title">Antropometría (cuna)</div>
        <span class="antro-pill" data-a="estado">Buscando cuna…</span>
      </div>
      <div class="antro-grid">
        <div><small>Peso</small><b data-a="peso">—</b></div>
        <div><small>Talla</small><b data-a="talla">—</b></div>
        <div><small>Temperatura</small><b data-a="temp">—</b></div>
      </div>
      <p class="antro-asig" data-a="asig"></p>
      <div class="antro-btns">
        <button type="button" class="btn btn-secondary" data-a="asignar">Asignar cuna a este paciente</button>
        <button type="button" class="btn btn-primary" data-a="actualizar" disabled>Actualizar antropometría</button>
      </div>
      <p class="antro-msg" data-a="msg" aria-live="polite"></p>
      <p class="antro-ultima" data-a="ultima"></p>
    </div>`;
}

export function bindAntropometriaCuna(patient) {
  const box = document.getElementById("antroCuna");
  if (!box) return;
  const pid = Number(patient.id);
  const nombre = (patient.nombre || "este paciente").trim();
  const q = k => box.querySelector(`[data-a="${k}"]`);
  const set = (k, v) => { const el = q(k); if (el) el.textContent = v; };
  let cuna = { online: false };

  const msg = (text, ok) => { set("msg", text); q("msg").dataset.ok = ok ? "1" : "0"; };

  function paint() {
    const esMio = Number(cuna.paciente_id) === pid;
    box.dataset.online = cuna.online ? "1" : "0";
    set("estado", cuna.online ? (cuna.congelado ? "Medido en la cuna" : "Cuna conectada") : "Cuna sin conexión");
    set("peso", cuna.online && cuna.peso_g != null ? `${fmt(cuna.peso_g / 1000, 3)} kg` : "—");
    set("talla", cuna.online && cuna.talla_cm != null ? `${fmt(cuna.talla_cm, 1)} cm` : "—");
    set("temp", cuna.online && cuna.temp_c != null ? `${fmt(cuna.temp_c, 1)} °C` : "—");
    set("asig", esMio
      ? `La cuna está con ${nombre}. Al tocar MEDIR en la cuna se guarda aquí solo.`
      : cuna.paciente_id
        ? "La cuna está con otro paciente. Asígnala aquí para usarla con este."
        : "La cuna no tiene paciente asignado.");
    const asignar = q("asignar");
    asignar.textContent = esMio && cuna.paciente_asignado ? "Liberar cuna" : "Asignar cuna a este paciente";
    asignar.dataset.liberar = esMio && cuna.paciente_asignado ? "1" : "0";
    q("actualizar").disabled = !cuna.online || (cuna.peso_g == null && cuna.talla_cm == null) || cuna.estable === false;
  }

  async function cargarUltima() {
    try {
      const res = await apiFetch(`/api/patients/${pid}/antropometria`);
      const m = res.ok ? (await res.json()).mediciones?.[0] : null;
      set("ultima", m
        ? `Última en la ficha: ${m.peso_g != null ? fmt(m.peso_g / 1000, 3) + " kg" : "—"} · ${m.talla_cm != null ? fmt(m.talla_cm, 1) + " cm" : "—"}${m.temp_c != null ? " · " + fmt(m.temp_c, 1) + " °C" : ""} (${fecha(m.created_at)})`
        : "Todavía no hay medidas en la ficha.");
    } catch (_) {}
  }

  function ponerPeso(peso) {
    const inp = document.getElementById("editPesoActual");
    if (inp && peso != null) inp.value = Math.round(Number(peso));
  }

  q("asignar").addEventListener("click", async e => {
    const liberar = e.currentTarget.dataset.liberar === "1";
    e.currentTarget.disabled = true;
    try {
      const res = await apiFetch(`/api/patients/${pid}/cuna`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asignar: !liberar }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { cuna = { ...cuna, ...(data.cuna || {}) }; msg(liberar ? "Cuna liberada." : `Cuna asignada a ${nombre}.`, true); }
      else msg(data.message || "No se pudo asignar la cuna.", false);
    } catch (_) { msg("Sin conexión con el servidor.", false); }
    e.currentTarget.disabled = false;
    paint();
  });

  q("actualizar").addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    try {
      const res = await apiFetch(`/api/patients/${pid}/antropometria`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origen: "cuna" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { ponerPeso(data.peso_g); msg("Antropometría actualizada en la ficha.", true); cargarUltima(); }
      else msg(data.message || "No se pudo actualizar.", false);
    } catch (_) { msg("Sin conexión con el servidor.", false); }
    paint();
  });

  // En vivo mientras el modal esté abierto
  const ctrl = new AbortController();
  const vivo = () => { if (!document.body.contains(box)) { ctrl.abort(); return false; } return true; };
  window.addEventListener("neolight:cuna", e => { if (vivo()) { cuna = e.detail || { online: false }; paint(); } }, { signal: ctrl.signal });
  window.addEventListener("neolight:telemetry", e => { if (vivo() && e.detail?.cuna) { cuna = e.detail.cuna; paint(); } }, { signal: ctrl.signal });
  window.addEventListener("neolight:antropometria", e => {
    if (!vivo() || Number(e.detail?.paciente_id) !== pid) return;
    ponerPeso(e.detail.peso_g);
    if (e.detail.desde === "cuna") msg(`Guardado desde la cuna: ${e.detail.peso_g != null ? fmt(e.detail.peso_g / 1000, 3) + " kg" : "—"} · ${e.detail.talla_cm != null ? fmt(e.detail.talla_cm, 1) + " cm" : "—"}`, true);
    cargarUltima();
  }, { signal: ctrl.signal });

  apiFetch("/api/cuna/estado").then(r => r.ok ? r.json() : null).then(d => { if (d?.cuna && vivo()) { cuna = d.cuna; paint(); } }).catch(() => {});
  cargarUltima();
  paint();
}

