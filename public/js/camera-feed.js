// =========================================================
// public/js/camera-feed.js
// Imagen de la cámara de la lámpara.
// La cámara manda fotos al servidor; aquí se pide la última
// una y otra vez y se muestra en un <img>. Mientras alguien mira,
// el servidor le pide a la cámara fotos más seguidas para que se
// vea como video. Funciona desde cualquier lugar con internet.
// =========================================================

import { apiFetch } from "./config.js";

const PERIOD_MS = 150;        // se pregunta seguido; el servidor solo manda la foto si es nueva
const GIVE_UP_MS = 6000;      // sin fotos durante este tiempo = "sin cámara"

/**
 * Empieza a mostrar la cámara en `img`.
 *   onState("live" | "waiting" | "offline" | "denied")
 * Devuelve una función para detenerla.
 */
export function startCameraFeed(img, { onState } = {}) {
  let stopped = false;
  let timer = null;
  let lastUrl = null;
  let lastOk = 0;
  let lastN = 0;
  let state = "";
  const started = Date.now();

  const setState = next => { if (next !== state) { state = next; onState?.(next); } };
  setState("waiting");

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await apiFetch(`/api/cam/latest.jpg?after=${lastN}`, { cache: "no-store" });
      if (stopped) return;
      if (res.status === 204) {
        lastOk = Date.now();                 // la cámara sigue viva, solo no hay foto nueva todavía
      } else if (res.ok) {
        lastN = Number(res.headers.get("X-Frame-N")) || 0;
        const blob = await res.blob();
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        img.src = url;
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;
        lastOk = Date.now();
        setState("live");
      } else if (res.status === 403) {
        setState("denied");
      } else if (Date.now() - (lastOk || started) > GIVE_UP_MS) {
        setState("offline");
      }
    } catch (_) {
      if (Date.now() - (lastOk || started) > GIVE_UP_MS) setState("offline");
    }
    // Si no hay cámara se sigue preguntando, pero más despacio.
    if (!stopped) timer = window.setTimeout(tick, state === "live" || state === "waiting" ? PERIOD_MS : 3000);
  };
  tick();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = null;
    img.removeAttribute("src");
  };
}
