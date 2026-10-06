// =========================================================
// public/js/patient-camera.js
// Botón "Cámara" del panel del tutor: muestra la imagen real
// de la lámpara o vuelve a la animación del bebé.
// =========================================================

import { $ } from "./config.js";
import { startCameraFeed } from "./camera-feed.js";

export async function bindCameraToggle() {
  const button = $("ptCamToggle");
  const heroVideo = document.querySelector("#ptHeroMedia .pt-hero-video");
  const cameraImage = $("ptCameraStream");
  const cameraError = $("ptCamError");
  if (!button || !cameraImage || button.dataset.bound === "1") return;
  button.dataset.bound = "1";

  let stopFeed = null;

  const showError = visible => {
    if (!cameraError) return;
    cameraError.style.display = visible ? "flex" : "none";
    visible ? cameraError.removeAttribute("aria-hidden") : cameraError.setAttribute("aria-hidden", "true");
  };

  const turnOff = () => {
    button.setAttribute("aria-pressed", "false");
    stopFeed?.();
    stopFeed = null;
    cameraImage.style.display = "none";
    showError(false);
    if (heroVideo) heroVideo.style.display = "";
  };

  const turnOn = () => {
    button.setAttribute("aria-pressed", "true");
    showError(false);
    stopFeed = startCameraFeed(cameraImage, {
      onState: state => {
        const live = state === "live";
        // Mientras no llegue una foto se deja la animación del bebé; sin cámara, el aviso.
        cameraImage.style.display = live ? "block" : "none";
        if (heroVideo) heroVideo.style.display = live || state !== "waiting" ? "none" : "";
        showError(state === "offline" || state === "denied");
      },
    });
  };

  button.addEventListener("click", () => {
    button.getAttribute("aria-pressed") === "true" ? turnOff() : turnOn();
  });

  // Al cerrar sesión se deja de pedir fotos.
  window.addEventListener("neolight:session-expired", turnOff);
}
