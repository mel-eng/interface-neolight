// =========================================================
// public/js/patient-camera.js
// Activación, apagado y manejo de errores del stream de cámara.
// =========================================================

import { $, CAMERA_STREAM_URL, loadClientConfig } from "./config.js";

export async function bindCameraToggle() {
  const button = $("ptCamToggle");
  const heroVideo = document.querySelector("#ptHeroMedia .pt-hero-video");
  const cameraImage = $("ptCameraStream");
  const cameraError = $("ptCamError");
  if (!button || !cameraImage) return;

  await loadClientConfig();
  const streamUrl = CAMERA_STREAM_URL || "http://192.168.4.50/stream";
  const errorTimeoutMs = 7000;
  let errorTimer = null;

  const setToggle = enabled => {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
  };

  const hideError = () => {
    if (!cameraError) return;
    cameraError.style.display = "none";
    cameraError.setAttribute("aria-hidden", "true");
  };

  const showError = () => {
    clearTimeout(errorTimer);
    errorTimer = null;
    cameraImage.src = "";
    cameraImage.style.display = "none";
    cameraImage.onerror = null;
    cameraImage.onload = null;
    if (cameraError) {
      cameraError.style.display = "flex";
      cameraError.removeAttribute("aria-hidden");
    }
  };

  const turnOn = () => {
    setToggle(true);
    hideError();
    cameraImage.style.display = "none";
    if (heroVideo) heroVideo.style.display = "none";

    cameraImage.onerror = showError;
    cameraImage.onload = () => {
      clearTimeout(errorTimer);
      errorTimer = null;
      cameraImage.style.display = "block";
    };
    errorTimer = window.setTimeout(showError, errorTimeoutMs);
    cameraImage.src = streamUrl;
  };

  const turnOff = () => {
    setToggle(false);
    clearTimeout(errorTimer);
    errorTimer = null;
    cameraImage.onerror = null;
    cameraImage.onload = null;
    cameraImage.src = "";
    cameraImage.style.display = "none";
    hideError();
    if (heroVideo) heroVideo.style.display = "";
  };

  button.addEventListener("click", () => {
    button.getAttribute("aria-pressed") === "true" ? turnOff() : turnOn();
  });
}
