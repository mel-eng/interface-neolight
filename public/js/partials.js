// =========================================================
// public/js/partials.js
// Carga dinámica de fragmentos HTML (partials) en el DOM.
// Cada partial se inyecta una sola vez; llamadas repetidas
// retornan inmediatamente si el contenedor ya tiene contenido.
// =========================================================

const BASE = "/partials/";

// Registro de partials: { containerId, file }
const PARTIALS = [
  { id: "partial-patient-dashboard", file: "patient-dashboard.html" },
  { id: "partial-doctor-dashboard",  file: "doctor-dashboard.html"  },
  { id: "partial-auth-modal",        file: "auth-modal.html"        },
];

// Cache para evitar fetches duplicados
const _loaded = new Set();

/**
 * Carga un partial por nombre de archivo si no fue cargado antes.
 * @param {string} file — nombre del archivo en /partials/
 * @returns {Promise<void>}
 */
export async function loadPartial(file) {
  if (_loaded.has(file)) return;

  const entry = PARTIALS.find(p => p.file === file);
  if (!entry) {
    console.warn(`[partials] No existe configuración para: ${file}`);
    return;
  }

  const container = document.getElementById(entry.id);
  if (!container) {
    console.warn(`[partials] Contenedor no encontrado: #${entry.id}`);
    return;
  }

  // Ya tiene contenido (e.g. recarga en caliente)
  if (container.children.length > 0) {
    _loaded.add(file);
    return;
  }

  try {
    const res = await fetch(BASE + file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    container.innerHTML = html;
    _loaded.add(file);

    // Exponer openAuthModal en window tras inyectar el partial,
    // por si algún handler inline (onclick="openAuthModal()") lo necesita
    if (file === "auth-modal.html") {
      import("./auth.js").then(({ openAuthModal }) => {
        window.openAuthModal = openAuthModal;
      }).catch(err => {
        console.error("[partials] No se pudo exponer openAuthModal en window:", err);
      });
    }
  } catch (err) {
    if (file === "auth-modal.html") {
      console.error(
        `[partials] CRÍTICO: no se pudo cargar ${file}. ` +
        `El modal de login no funcionará. Error:`, err
      );
    } else {
      console.error(`[partials] Error cargando ${file}:`, err);
    }
    container.innerHTML = `<div style="padding:2rem;color:var(--danger)">
      Error cargando interfaz. Recarga la página.
    </div>`;
  }
}

/**
 * Precarga todos los partials en paralelo.
 * Útil para llamar durante el init si se quiere caché anticipada.
 * @returns {Promise<void>}
 */
export async function loadAllPartials() {
  await Promise.all(PARTIALS.map(p => loadPartial(p.file)));
}
