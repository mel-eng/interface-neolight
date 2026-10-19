// =========================================================
// public/js/ldr-calibracion.js
// Tarjeta del superusuario para calibrar los LDR con un luxómetro.
// =========================================================

import { $, escapeHtml } from "./config.js";
import { fetchLdrCalibracion, saveLdrPunto, deleteLdrPunto, downloadLdrCsv } from "./superuser-api.js";

let bound = false;
let timer = null;
let datos = null;

const n = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("es-BO", { minimumFractionDigits: d, maximumFractionDigits: d }));

function msg(text, kind = "") {
  const el = $("suLdrMsg");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function dibujar(d) {
  const svg = $("suLdrChart");
  if (!svg) return;
  const pts = d.puntos || [];
  if (!pts.length) { svg.innerHTML = `<text x="180" y="112" text-anchor="middle" class="su-ldr-empty">Sin puntos todavía</text>`; return; }
  const W = 360, H = 220, L = 46, R = 12, T = 12, B = 32;
  const maxLux = Math.max(...pts.map(p => p.lux), 1) * 1.08;
  const x = pct => L + (pct / 100) * (W - L - R);
  const y = lux => H - B - (lux / maxLux) * (H - T - B);
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map(f => f * maxLux);
  const curva = (d.curva || []).map(c => `${x(c.pct).toFixed(1)},${y(c.lux).toFixed(1)}`).join(" ");
  const expo = d.ajustes?.exponencial;
  const pot = d.ajustes?.potencia;
  let potPath = "";
  if (pot) {
    const xs = Array.from({ length: 41 }, (_, i) => Math.max(0.5, i * 2.5));
    potPath = xs.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(Math.min(maxLux, pot.a * p ** pot.b)).toFixed(1)}`).join(" ");
  }
  svg.innerHTML = `
    ${ticksY.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="su-ldr-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="su-ldr-axis">${n(v)}</text>`).join("")}
    ${[0, 25, 50, 75, 100].map(p => `<text x="${x(p)}" y="${H - B + 16}" text-anchor="middle" class="su-ldr-axis">${p}%</text>`).join("")}
    <text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" class="su-ldr-axis">Lectura de los LDR</text>
    ${potPath ? `<path d="${potPath}" class="su-ldr-pot"/>` : ""}
    ${expo ? `<path d="${Array.from({ length: 51 }, (_, i) => i * 2).map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(Math.min(maxLux, expo.a * Math.exp(expo.b * p))).toFixed(1)}`).join(" ")}" class="su-ldr-exp"/>` : ""}
    ${curva ? `<polyline points="${curva}" class="su-ldr-line"/>` : ""}
    ${pts.map(p => `<circle cx="${x(p.pct)}" cy="${y(p.lux)}" r="4" class="su-ldr-dot"><title>${n(p.pct, 1)} % → ${n(p.lux)} lux</title></circle>`).join("")}
    ${d.ahora?.pct != null ? `<line x1="${x(d.ahora.pct)}" x2="${x(d.ahora.pct)}" y1="${T}" y2="${H - B}" class="su-ldr-now-line"/>` : ""}`;
}

function render(d) {
  datos = d;
  const ahora = d.ahora?.pct;
  const est = d.estimado_ahora;
  $("suLdrAhora").textContent = ahora == null ? (d.ahora?.en_vivo ? "Sin lectura" : "Lámpara sin conexión") : `${n(ahora, 0)} %${est ? ` · ≈ ${n(est)} lux` : ""}`;
  const pill = $("suLdrEstado");
  pill.textContent = d.listo ? `Calibrado · ${d.resumen.puntos} puntos` : "Sin calibrar";
  pill.className = `su-status-pill ${d.listo ? "success" : "neutral"}`;

  const a = d.ajustes || {};
  const fila = [];
  if (a.lineal) fila.push(`<span>Lineal: lux = ${n(a.lineal.m, 2)}·% ${a.lineal.c < 0 ? "−" : "+"} ${n(Math.abs(a.lineal.c), 1)} · <b>R² = ${n(a.lineal.r2, 3)}</b></span>`);
  if (a.potencia) fila.push(`<span>Potencia: lux = ${n(a.potencia.a, 3)}·%<sup>${n(a.potencia.b, 3)}</sup> · <b>R² = ${n(a.potencia.r2, 3)}</b></span>`);
  if (a.exponencial) fila.push(`<span>Exponencial: lux = ${n(a.exponencial.a, 2)}·e<sup>${n(a.exponencial.b, 4)}·%</sup> · <b>R² = ${n(a.exponencial.r2, 3)}</b></span>`);
  if (d.resumen?.metodo_nombre) fila.push(`<span>La interfaz usa: <b>${escapeHtml(d.resumen.metodo_nombre)}</b> (la que menos se equivoca con puntos que no vio)</span>`);
  if (d.resumen?.mae != null) fila.push(`<span>Error medio: <b>${n(d.resumen.mae)} lux</b>${d.resumen.mape != null ? ` (${n(d.resumen.mape, 1)} %)` : ""}</span>`);
  $("suLdrFit").innerHTML = fila.length ? fila.join("") : d.listo ? "Con 3 puntos o más aparece el ajuste y el error."
    : "Necesitas al menos 2 niveles de luz distintos.";

  $("suLdrRows").innerHTML = (d.puntos || []).map((p, i) => `<tr>
      <td>${i + 1}</td><td>${n(p.pct, 1)} %</td><td>${n(p.lux)} lux</td><td>${p.estimado != null ? `${n(p.estimado)} lux` : "—"}</td>
      <td>${p.error_pct != null ? `${p.error_pct > 0 ? "+" : ""}${n(p.error_pct, 1)} %` : "—"}</td>
      <td>${escapeHtml(p.nota || "")}</td>
      <td><button type="button" class="su-ldr-del" data-ldr-del="${p.id}" aria-label="Borrar punto">×</button></td></tr>`).join("")
    || `<tr><td colspan="7" class="su-ldr-empty-row">Todavía no hay mediciones.</td></tr>`;
  dibujar(d);
}

// Estimación para la lectura actual con la misma interpolación que usa el servidor.
function estimarLocal(d, pct) {
  const c = d.curva || [];
  if (pct == null || c.length < 2) return null;
  if (pct <= c[0].pct) return c[0].lux;
  if (pct >= c[c.length - 1].pct) return c[c.length - 1].lux;
  let i = 1; while (c[i].pct < pct) i++;
  const t = (pct - c[i - 1].pct) / (c[i].pct - c[i - 1].pct);
  return c[i - 1].lux + t * (c[i].lux - c[i - 1].lux);
}

async function refrescar() {
  const card = $("suLdrCard");
  if (!card || !card.offsetParent) return;          // solo mientras se ve la pestaña
  const res = await fetchLdrCalibracion();
  if (!res.ok) return;
  render({ ...res.data, estimado_ahora: estimarLocal(res.data, res.data.ahora?.pct) });
}

export function initLdrCalibracion() {
  if (bound || !$("suLdrCard")) return;
  bound = true;

  $("suLdrGuardar").addEventListener("click", async () => {
    const lux = $("suLdrLux").value.trim();
    if (!lux) { msg("Escribe los lux que marca el luxómetro.", "warn"); return; }
    const res = await saveLdrPunto({ lux, pct: $("suLdrPct").value.trim(), nota: $("suLdrNota").value.trim() });
    if (!res.ok) { msg(res.data?.message || "No se pudo guardar.", "warn"); return; }
    const ultimo = [...(res.data.puntos || [])].sort((a, b) => b.id - a.id)[0];
    msg(ultimo ? `Guardado: ${n(ultimo.pct, 1)} % → ${n(ultimo.lux)} lux` : "Guardado.", "ok");
    $("suLdrLux").value = ""; $("suLdrPct").value = "";
    render({ ...res.data, estimado_ahora: estimarLocal(res.data, res.data.ahora?.pct) });
  });

  $("suLdrRows").addEventListener("click", async e => {
    const id = e.target.closest("[data-ldr-del]")?.dataset.ldrDel;
    if (!id) return;
    const res = await deleteLdrPunto(id);
    if (res.ok) render({ ...res.data, estimado_ahora: estimarLocal(res.data, res.data.ahora?.pct) });
  });

  $("suLdrBorrar").addEventListener("click", async () => {
    if (!datos?.puntos?.length || !window.confirm("¿Borrar todas las mediciones de calibración?")) return;
    const res = await deleteLdrPunto("todo");
    if (res.ok) { render({ ...res.data, estimado_ahora: null }); msg("Calibración borrada.", ""); }
  });

  $("suLdrCsv").addEventListener("click", () => downloadLdrCsv().catch(() => msg("No se pudo descargar la tabla.", "warn")));

  refrescar();
  clearInterval(timer);
  timer = setInterval(refrescar, 2000);
  window.addEventListener("neolight:session-expired", () => clearInterval(timer));
}
