// =========================================================
// public/js/signature.js
// Firma del doctor: recuadro para dibujarla, guardado y bloque
// que la muestra en los reportes imprimibles.
// Es una firma visual, no una firma digital con validez legal.
// =========================================================

import { apiFetch, escapeHtml, formatDoctorDisplayName } from "./config.js";

const INK = "#221b2e";

/**
 * Convierte un <canvas> en un recuadro de firma (dedo, lápiz o mouse).
 * Devuelve { clear, isEmpty, toDataURL }.
 */
export function createSignaturePad(canvas) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let strokes = 0;
  let last = null;

  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;

  // El canvas tiene un tamaño interno fijo; en pantalla se estira con CSS.
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  canvas.addEventListener("pointerdown", event => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    drawing = true;
    last = point(event);
    ctx.beginPath();
    ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);   // un punto también cuenta
    ctx.fillStyle = INK;
    ctx.fill();
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    event.preventDefault();
    const next = point(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    strokes += Math.hypot(next.x - last.x, next.y - last.y);
    last = next;
  });
  const stop = () => { drawing = false; last = null; };
  ["pointerup", "pointercancel", "pointerleave"].forEach(name => canvas.addEventListener(name, stop));

  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); strokes = 0; },
    // Una firma real tiene trazo; un toque accidental no alcanza.
    isEmpty() { return strokes < 60; },
    toDataURL() { return canvas.toDataURL("image/png"); },
  };
}

// ---------- servidor ----------

export async function fetchMySignature() {
  try {
    const res = await apiFetch("/api/doctor/signature");
    const data = await res.json();
    return data?.firma || null;
  } catch (_) { return null; }
}

export async function saveMySignature(firma) {
  const res = await apiFetch("/api/doctor/signature", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firma }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, message: data?.message };
}

/** Doctor a cargo de un paciente, con su firma: { nombre, apellidos, genero, matricula, especialidad, firma } */
export async function fetchPatientDoctorSignature(patientId) {
  try {
    const res = await apiFetch(`/api/patients/${patientId}/doctor-signature`);
    const data = await res.json();
    return data?.doctor || null;
  } catch (_) { return null; }
}

// ---------- reportes ----------

/** Bloque de firma para el pie de un reporte. Lleva sus estilos para que imprima igual en todos. */
export function signatureBlockHtml(doctor = null) {
  if (!doctor) return "";
  const name = formatDoctorDisplayName(doctor, "Médico tratante");
  const image = doctor.firma
    ? `<img src="${doctor.firma}" alt="Firma de ${escapeHtml(name)}" style="height:74px;max-width:260px;object-fit:contain;display:block;margin:0 auto;">`
    : `<div style="height:74px;display:flex;align-items:flex-end;justify-content:center;color:#6a6377;font-size:11px;">Firma no registrada</div>`;
  return `
    <section class="pdf-signature" style="margin-top:28px;display:flex;justify-content:flex-end;break-inside:avoid;page-break-inside:avoid;">
      <div style="width:280px;text-align:center;font-family:inherit;">
        ${image}
        <div style="border-top:1.5px solid #221b2e;margin-top:4px;padding-top:6px;">
          <strong style="display:block;font-size:13px;color:#221b2e;">${escapeHtml(name)}</strong>
          <span style="display:block;font-size:11px;color:#6a6377;">${escapeHtml(doctor.especialidad || "Médico tratante")}</span>
          <span style="display:block;font-size:11px;color:#6a6377;">Matrícula: ${escapeHtml(doctor.matricula || "—")}</span>
        </div>
      </div>
    </section>`;
}

// ---------- ventana para registrar o cambiar la firma ----------

/** Abre una ventana con el recuadro. Llama a onSaved(firma) cuando se guarda. */
export function openSignatureDialog({ onSaved } = {}) {
  document.getElementById("signatureDialog")?.remove();
  const modal = document.createElement("div");
  modal.className = "modal open";
  modal.id = "signatureDialog";
  modal.setAttribute("aria-hidden", "false");
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-label="Mi firma">
      <div class="modal-head">
        <div>
          <div class="modal-title">Mi firma</div>
          <div class="modal-sub">Aparecerá al pie de los reportes que emitas.</div>
        </div>
        <button class="modal-close" type="button" data-close="1" aria-label="Cerrar">✕</button>
      </div>
      <div class="sig-field">
        <canvas class="sig-pad" id="signatureDialogPad" width="600" height="220" aria-label="Dibuja tu firma aquí"></canvas>
        <div class="sig-actions"><span>Firma con el dedo o el mouse</span><button type="button" class="btn-mini" id="signatureDialogClear">Borrar</button></div>
      </div>
      <button class="btn btn-primary btn-full" id="signatureDialogSave" type="button">Guardar firma</button>
      <div class="error" id="signatureDialogMsg" aria-live="polite"></div>
    </div>`;
  document.body.appendChild(modal);

  const pad = createSignaturePad(modal.querySelector("#signatureDialogPad"));
  const close = () => modal.remove();
  modal.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", close));
  modal.querySelector("#signatureDialogClear").addEventListener("click", () => pad.clear());
  modal.querySelector("#signatureDialogSave").addEventListener("click", async () => {
    const msg = modal.querySelector("#signatureDialogMsg");
    if (pad.isEmpty()) { msg.textContent = "Dibuja tu firma antes de guardar."; return; }
    const firma = pad.toDataURL();
    const result = await saveMySignature(firma);
    if (!result.ok) { msg.textContent = result.message || "No se pudo guardar la firma."; return; }
    close();
    onSaved?.(firma);
  });
}
