// =========================================================
// public/js/encuestas-panel.js
// Superusuario > Encuestas: invitaciones con link único,
// promedios y PDF con las firmas.
// =========================================================

import { $, escapeHtml } from "./config.js";
import { fetchEncuestas, crearInvitacion, borrarInvitacion, abrirPdfEncuestas } from "./superuser-api.js";
import { showRealtimeToast } from "./socket.js";

const ROL = { tutor: "Tutor", doctor: "Doctor", ingeniero: "Ingeniero" };
let bound = false;

const linkDe = token => `${location.origin}/encuesta/${token}`;
const n2 = v => (v == null ? "—" : Number(v).toFixed(2).replace(".", ","));

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); showRealtimeToast("Link copiado", "ok"); }
  catch (_) { window.prompt("Copia el link:", texto); }
}

function render(d) {
  $("suEncConteo").textContent = `${d.respondidas} respondida${d.respondidas === 1 ? "" : "s"}`;
  $("suEncConteo").className = `su-status-pill ${d.respondidas ? "success" : "neutral"}`;
  $("suEncPromedios").innerHTML = d.respondidas
    ? d.preguntas.map((p, i) => `<div class="su-enc-fila"><span>${i + 1}. ${escapeHtml(p)}</span><div class="su-enc-barra"><i style="width:${(d.promedios[i] || 0) / 5 * 100}%"></i></div><b>${n2(d.promedios[i])}</b></div>`).join("")
    : `<p class="su-ldr-help">Todavía no hay respuestas.</p>`;
  $("suEncPdfTodo").disabled = !d.respondidas;

  $("suEncLista").innerHTML = d.invitaciones.length ? d.invitaciones.map(inv => {
    const link = linkDe(inv.token);
    const wsp = `https://wa.me/?text=${encodeURIComponent(`Hola ${inv.nombre}, te invito a llenar la encuesta de satisfacción del sistema NEOLIGHT. Toma 2 minutos y al final se firma desde el celular: ${link}`)}`;
    const prom = inv.respuesta_id ? [1, 2, 3, 4, 5, 6].reduce((a, k) => a + inv[`p${k}`], 0) / 6 : null;
    return `<div class="su-enc-item">
      <div class="su-enc-info"><b>${escapeHtml(inv.nombre)}</b><span>${ROL[inv.rol]} · ${inv.respuesta_id ? `respondió · promedio ${n2(prom)}` : "pendiente"}</span></div>
      <span class="su-status-pill ${inv.respuesta_id ? "success" : "warning"}">${inv.respuesta_id ? "Respondida" : "Pendiente"}</span>
      <div class="su-enc-acciones">
        ${inv.respuesta_id
          ? `<button class="su-button primary" type="button" data-enc-pdf="${inv.id}">Ver PDF</button>`
          : `<button class="su-button ghost" type="button" data-enc-copiar="${escapeHtml(link)}">Copiar link</button><a class="su-button primary" href="${wsp}" target="_blank" rel="noopener">WhatsApp</a>`}
        <button class="su-button ghost su-enc-borrar" type="button" data-enc-borrar="${inv.id}" title="Borrar invitación">×</button>
      </div></div>`;
  }).join("") : `<p class="su-ldr-help">Todavía no creaste invitaciones.</p>`;
}

async function refrescar() {
  const r = await fetchEncuestas();
  if (r.ok) render(r.data);
}

export function initEncuestas() {
  if (bound || !$("suEncCrear")) return;
  bound = true;
  $("suEncCrear").addEventListener("click", async () => {
    const nombre = $("suEncNombre").value.trim();
    const r = await crearInvitacion(nombre, $("suEncRol").value);
    if (!r.ok) { showRealtimeToast(r.data?.message || "No se pudo crear.", "warn"); return; }
    $("suEncNombre").value = "";
    await refrescar();
    copiar(linkDe(r.data.token));
  });
  $("suEncPdfTodo").addEventListener("click", () => abrirPdfEncuestas().catch(() => showRealtimeToast("No se pudo abrir el PDF.", "warn")));
  $("suEncLista").addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.encCopiar) copiar(b.dataset.encCopiar);
    if (b.dataset.encPdf) abrirPdfEncuestas(b.dataset.encPdf).catch(() => showRealtimeToast("No se pudo abrir el PDF.", "warn"));
    if (b.dataset.encBorrar && window.confirm("¿Borrar esta invitación y su respuesta?")) { await borrarInvitacion(b.dataset.encBorrar); refrescar(); }
  });
  document.querySelector('[data-su-section="encuestas"]')?.addEventListener("click", refrescar);
  refrescar();
}
