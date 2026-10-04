// =========================================================
// public/js/patient-overlays.js
// Overlays de bloqueo y mensajes breves del dashboard paciente.
// =========================================================

import { $ } from "./config.js";

export function showStatusOverlay(parentId, overlayId, config = {}) {
  const parent = $(parentId) || document.body;
  const overlay = ensureOverlay(parent, overlayId);
  overlay.hidden = false;
  overlay.style.display = "flex";
  overlay.dataset.kind = config.kind || "status";
  overlay.setAttribute("aria-hidden", "false");
  overlay.innerHTML = "";

  const icon = document.createElement("div");
  icon.className = "co-ico";
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  const title = document.createElement("strong");
  title.textContent = config.title || "Estado del panel";

  const message = document.createElement("p");
  message.textContent = config.message || "Operación no disponible temporalmente.";

  overlay.append(icon, title, message);

  if (config.actionText) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "control-overlay-action";
    action.textContent = config.actionText;
    action.disabled = Boolean(config.actionDisabled);
    if (typeof config.onAction === "function") action.addEventListener("click", config.onAction);
    overlay.appendChild(action);
  }

  return overlay;
}

export function showOverlay(parentId, overlayId, config = {}) {
  return showStatusOverlay(parentId, overlayId, config);
}

export function hideOverlay(overlayId) {
  const overlay = $(overlayId);
  if (!overlay) return;
  overlay.hidden = true;
  overlay.style.display = "none";
  overlay.setAttribute("aria-hidden", "true");
}

export function showInlineMessage(id, { visible, message, kind = "status" }) {
  const element = $(id);
  if (!element) return;
  if (!visible) {
    element.style.display = "none";
    return;
  }
  element.textContent = message;
  element.style.color = messageColor(kind);
  element.style.display = "block";
}

function ensureOverlay(parent, overlayId) {
  let overlay = $(overlayId);
  if (overlay) return overlay;
  if (!parent.style.position) parent.style.position = "relative";
  overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.className = "control-overlay";
  parent.appendChild(overlay);
  return overlay;
}

function messageColor(kind) {
  if (kind === "ok") return "var(--ok)";
  if (kind === "warn") return "var(--warn)";
  if (kind === "danger") return "var(--danger)";
  return "var(--muted)";
}
