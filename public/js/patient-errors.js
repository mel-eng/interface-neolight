// =========================================================
// public/js/patient-errors.js
// Sistema de notificaciones de error para el dashboard paciente.
//
// Provee dos canales de feedback:
//   · Toast    — mensajes efímeros (3-5 s) para errores recuperables
//   · Banner   — barra persistente para condiciones de sistema
//                 (sin conexión, ESP32 offline)
//
// Uso:
//   import { toast, showBanner, clearBanner } from "./patient-errors.js";
//   toast("No se pudo cargar el historial.", "warn");
//   showBanner("esp32", "ESP32 sin conexión — sin telemetría en tiempo real.");
//   clearBanner("esp32");
// =========================================================

// ── Constantes ────────────────────────────────────────────

const TOAST_CONTAINER_ID = "pt-toast-container";
const BANNER_CONTAINER_ID = "pt-banner-container";

const TOAST_DURATION = {
  ok:      2800,
  info:    3200,
  warn:    4500,
  danger:  6000,
};

// ── Inicialización lazy de contenedores ───────────────────

function getToastContainer() {
  let el = document.getElementById(TOAST_CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOAST_CONTAINER_ID;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Notificaciones del sistema");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "false");
    document.body.appendChild(el);
  }
  return el;
}

function getBannerContainer() {
  // El banner va dentro del shell del patient dashboard
  // para que sea contextual y no interfiera con otras vistas.
  let el = document.getElementById(BANNER_CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = BANNER_CONTAINER_ID;
    el.className = "pt-banner-container";
    // Insertar antes del primer hijo del patient-shell
    const shell = document.querySelector(
      "#view-dashboard-patient .patient-shell"
    );
    if (shell) {
      shell.insertAdjacentElement("afterbegin", el);
    } else {
      document.body.appendChild(el);
    }
  }
  return el;
}

// ── TOAST ─────────────────────────────────────────────────

/**
 * Muestra un mensaje de notificación efímero.
 * @param {string} message  Texto visible para el usuario.
 * @param {"ok"|"warn"|"danger"|"info"} kind  Nivel de severidad.
 * @param {number} [duration]  Override de duración en ms.
 */
export function toast(message, kind = "info", duration) {
  if (!message) return;

  const container = getToastContainer();
  const ms = duration ?? TOAST_DURATION[kind] ?? 3500;

  const item = document.createElement("div");
  item.className = `pt-toast pt-toast--${kind}`;
  item.setAttribute("role", kind === "danger" ? "alert" : "status");
  item.setAttribute("aria-live", kind === "danger" ? "assertive" : "polite");

  const icon = _toastIcon(kind);
  item.innerHTML = `
    <span class="pt-toast__icon" aria-hidden="true">${icon}</span>
    <span class="pt-toast__msg">${_escapeHtml(message)}</span>
    <button class="pt-toast__close" aria-label="Cerrar notificación" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           width="14" height="14" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  // Botón de cierre manual
  item.querySelector(".pt-toast__close").addEventListener("click", () => _removeToast(item));

  container.appendChild(item);

  // Trigger CSS enter animation en el próximo frame
  requestAnimationFrame(() => item.classList.add("pt-toast--visible"));

  // Auto-dismiss
  const timer = setTimeout(() => _removeToast(item), ms);
  item._dismissTimer = timer;
}

function _removeToast(item) {
  clearTimeout(item._dismissTimer);
  item.classList.remove("pt-toast--visible");
  item.classList.add("pt-toast--exit");
  item.addEventListener("transitionend", () => item.remove(), { once: true });
  // Fallback en caso de que transitionend no dispare
  setTimeout(() => item.remove(), 400);
}

function _toastIcon(kind) {
  const icons = {
    ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16">
           <path d="M20 6L9 17l-5-5"/>
         </svg>`,
    warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
             <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
             <line x1="12" y1="9" x2="12" y2="13"/>
             <line x1="12" y1="17" x2="12.01" y2="17"/>
           </svg>`,
    danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
               <circle cx="12" cy="12" r="10"/>
               <line x1="12" y1="8" x2="12" y2="12"/>
               <line x1="12" y1="16" x2="12.01" y2="16"/>
             </svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
             <circle cx="12" cy="12" r="10"/>
             <line x1="12" y1="16" x2="12" y2="12"/>
             <line x1="12" y1="8" x2="12.01" y2="8"/>
           </svg>`,
  };
  return icons[kind] || icons.info;
}

// ── BANNER PERSISTENTE ────────────────────────────────────

// Mapa de banners activos: key → elemento DOM
const _activeBanners = new Map();

/**
 * Muestra (o actualiza) un banner persistente en el dashboard.
 * @param {string} key       Identificador único del banner (ej: "esp32", "socket", "api").
 * @param {string} message   Texto del banner.
 * @param {"warn"|"danger"|"info"} kind  Nivel de severidad.
 * @param {object} [opts]
 * @param {string} [opts.action]      Texto del botón de acción opcional.
 * @param {Function} [opts.onAction]  Callback al hacer click en el botón.
 */
export function showBanner(key, message, kind = "warn", opts = {}) {
  if (!message || !key) return;

  const container = getBannerContainer();

  // Si ya existe un banner con esta key, actualizarlo
  if (_activeBanners.has(key)) {
    const existing = _activeBanners.get(key);
    existing.querySelector(".pt-banner__msg").textContent = message;
    existing.dataset.kind = kind;
    existing.className = `pt-banner pt-banner--${kind}`;
    return;
  }

  const banner = document.createElement("div");
  banner.className = `pt-banner pt-banner--${kind}`;
  banner.dataset.bannerKey = key;
  banner.setAttribute("role", kind === "danger" ? "alert" : "status");
  banner.setAttribute("aria-live", kind === "danger" ? "assertive" : "polite");

  const icon = _toastIcon(kind);
  let actionHtml = "";
  if (opts.action) {
    actionHtml = `<button class="pt-banner__action" type="button">${_escapeHtml(opts.action)}</button>`;
  }

  banner.innerHTML = `
    <span class="pt-banner__icon" aria-hidden="true">${icon}</span>
    <span class="pt-banner__msg">${_escapeHtml(message)}</span>
    ${actionHtml}
    <button class="pt-banner__close" aria-label="Cerrar aviso" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           width="13" height="13" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  if (opts.action && typeof opts.onAction === "function") {
    banner.querySelector(".pt-banner__action")
      .addEventListener("click", opts.onAction);
  }

  banner.querySelector(".pt-banner__close")
    .addEventListener("click", () => clearBanner(key));

  container.appendChild(banner);
  _activeBanners.set(key, banner);

  // Enter animation
  requestAnimationFrame(() => banner.classList.add("pt-banner--visible"));
}

/**
 * Remueve un banner persistente por su key.
 * @param {string} key
 */
export function clearBanner(key) {
  const banner = _activeBanners.get(key);
  if (!banner) return;

  banner.classList.remove("pt-banner--visible");
  banner.classList.add("pt-banner--exit");
  banner.addEventListener("transitionend", () => {
    banner.remove();
    _activeBanners.delete(key);
  }, { once: true });
  setTimeout(() => { banner.remove(); _activeBanners.delete(key); }, 400);
}

/**
 * Devuelve true si hay un banner activo con esa key.
 * @param {string} key
 */
export function hasBanner(key) {
  return _activeBanners.has(key);
}

// ── WRAPPERS SEMÁNTICOS ───────────────────────────────────
// Funciones de conveniencia para los casos de uso del dashboard.

/**
 * Notifica un error de carga de datos clínicos.
 * Se usa cuando fetchCurrentTutorState, fetchAlarms, fetchSessions falla.
 */
export function notifyDataError(context = "datos clínicos") {
  toast(`No se pudo actualizar ${context}. Se reintentará automáticamente.`, "warn");
}

/**
 * Activa el banner de desconexión de Socket.IO.
 */
export function notifySocketDisconnected() {
  showBanner(
    "socket",
    "Sin conexión al servidor — los datos en tiempo real están pausados.",
    "warn",
    {
      action: "Reconectar",
      onAction: () => window.location.reload(),
    }
  );
}

/**
 * Limpia el banner de desconexión cuando Socket.IO reconecta.
 */
export function notifySocketReconnected() {
  clearBanner("socket");
  toast("Conexión restaurada.", "ok");
}

/**
 * Activa el banner de ESP32 offline.
 * @param {"offline"|"no-port"|"timeout"} reason
 */
export function notifyESP32Offline(reason = "offline") {
  const messages = {
    offline:  "ESP32 sin conexión — sin telemetría de sensores.",
    "no-port": "ESP32 conectado pero sin puerto serie activo.",
    timeout:  "ESP32 no responde — sin datos de sensores.",
  };
  showBanner(
    "esp32",
    messages[reason] || messages.offline,
    "warn"
  );
}

/**
 * Limpia el banner de ESP32 cuando vuelve a transmitir.
 */
export function notifyESP32Online() {
  if (hasBanner("esp32")) {
    clearBanner("esp32");
    toast("ESP32 conectado — telemetría activa.", "ok");
  }
}

/**
 * Muestra un toast de error al exportar.
 * @param {"excel"|"pdf"} format
 */
export function notifyExportError(format = "excel") {
  const label = format === "pdf" ? "PDF" : "Excel";
  toast(`No se pudo exportar el reporte ${label}. Verifica la conexión e intenta de nuevo.`, "danger");
}

/**
 * Error crítico de inicialización — datos de sesión faltantes.
 * Se muestra una sola vez al cargar el dashboard.
 */
export function notifyInitError(field = "sesión") {
  showBanner(
    "init-error",
    `Error al cargar ${field}. Algunos datos pueden estar incompletos.`,
    "danger",
    {
      action: "Recargar",
      onAction: () => window.location.reload(),
    }
  );
}

// ── HELPER PRIVADO ────────────────────────────────────────

function _escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
