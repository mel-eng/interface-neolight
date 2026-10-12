// =========================================================
// public/js/patient-photo.js
// Foto del paciente para la ficha y los reportes (Excel y PDF).
// Se toma de la cámara de la lámpara o se sube desde el celular/PC.
// =========================================================

import { savePatientPhoto, fetchPatientPhotoUrl } from "./api.js";
import { showRealtimeToast } from "./socket.js";

const urls = new Map();   // pacienteId -> object URL vigente

/** Reduce la imagen a 800 px como máximo y la pasa a JPEG (pesa ~100 KB). */
function fileToJpeg(file, max = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("imagen_invalida")); };
    img.src = src;
  });
}

/** Pinta la foto como fondo de los elementos indicados (avatar). Devuelve true si hay foto. */
export async function paintPatientPhoto(pacienteId, elements = []) {
  if (!pacienteId) return false;
  const url = await fetchPatientPhotoUrl(pacienteId).catch(() => null);
  if (urls.has(pacienteId)) URL.revokeObjectURL(urls.get(pacienteId));
  if (url) urls.set(pacienteId, url); else urls.delete(pacienteId);
  elements.filter(Boolean).forEach(el => {
    el.classList.toggle("has-photo", !!url);
    // Variable CSS: algunos estilos del panel fuerzan el fondo del avatar con !important.
    if (url) el.style.setProperty("--nl-foto", `url("${url}")`); else el.style.removeProperty("--nl-foto");
  });
  return !!url;
}

async function afterSave(result, pacienteId, elements) {
  if (!result.ok) {
    showRealtimeToast(result.data?.message || "No se pudo guardar la foto.", "warn");
    return false;
  }
  showRealtimeToast("Foto guardada. Saldrá en los reportes.", "ok");
  await paintPatientPhoto(pacienteId, elements);
  return true;
}

/** Guarda lo que está viendo la cámara de la lámpara en este momento. */
export async function savePhotoFromCamera(pacienteId, elements = []) {
  if (!pacienteId) return false;
  return afterSave(await savePatientPhoto(pacienteId, { origen: "camara" }), pacienteId, elements);
}

/** Abre el selector de archivos (en el celular ofrece la cámara) y sube la foto elegida. */
export function pickPhotoFile(pacienteId, elements = []) {
  if (!pacienteId) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imagen = await fileToJpeg(file);
      await afterSave(await savePatientPhoto(pacienteId, { imagen }), pacienteId, elements);
    } catch (_) {
      showRealtimeToast("No se pudo leer esa imagen.", "warn");
    }
  });
  input.click();
}
