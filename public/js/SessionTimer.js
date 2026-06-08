// =========================================================
// public/js/SessionTimer.js
// Clase que encapsula el timer de sesión de terapia.
//
// Responsabilidades:
//   · Tick visual cada segundo → actualiza #tiempoTerapia
//   · Persistencia en localStorage con fallback in-memory
//   · Sincronización inicial con tiempo acumulado del servidor
//   · beforeunload: guarda el estado antes de cerrar la pestaña
//   · API pública limpia para iniciar, pausar, guardar y reset
//
// Uso:
//   const timer = new SessionTimer("uid-123");
//   timer.init(serverMs, sessionId);  // restaura estado
//   timer.start();
//   timer.pause();
//   const ms = timer.elapsed;         // milisegundos totales
//   timer.persist();                  // guarda en storage
//   timer.destroy();                  // limpia listeners
// =========================================================

// ── Storage adapter con fallback in-memory ────────────────

/**
 * Wrapper sobre localStorage que nunca lanza excepciones.
 * Si localStorage no está disponible (modo privado, iframe
 * con restricciones, storage lleno) usa un Map en memoria
 * como fallback, de modo que el timer sigue funcionando
 * correctamente durante la sesión aunque no persista.
 */
class StorageAdapter {
  #available = null;   // bool | null (lazy check)
  #fallback  = new Map();
  #prefix    = "neolight:";

  /** Detecta disponibilidad de localStorage (se cachea). */
  get isAvailable() {
    if (this.#available !== null) return this.#available;
    try {
      const probe = "__neolight_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      this.#available = true;
    } catch {
      this.#available = false;
    }
    return this.#available;
  }

  /**
   * Lee un valor del storage.
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    const k = this.#prefix + key;
    if (this.isAvailable) {
      try { return localStorage.getItem(k); } catch { /* fall through */ }
    }
    return this.#fallback.get(k) ?? null;
  }

  /**
   * Escribe un valor en el storage.
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    const k = this.#prefix + key;
    if (this.isAvailable) {
      try {
        localStorage.setItem(k, String(value));
        return;
      } catch { /* fall through */ }
    }
    this.#fallback.set(k, String(value));
  }

  /**
   * Elimina una clave del storage.
   * @param {string} key
   */
  remove(key) {
    const k = this.#prefix + key;
    if (this.isAvailable) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
    this.#fallback.delete(k);
  }
}

// Instancia singleton — compartida entre todos los SessionTimers
const storage = new StorageAdapter();

// ── SessionTimer ──────────────────────────────────────────

export class SessionTimer {
  // ── Campos privados ─────────────────────────────────────
  #uid;           // string — ID del paciente, usado como clave de storage
  #accMs  = 0;   // milisegundos acumulados antes del último start()
  #startMs = null; // timestamp Date.now() del último start(), null si pausado
  #tick   = null; // ID del setInterval del tick visual
  #sessionId = null; // ID de sesión activa en el backend
  #domId  = "tiempoTerapia"; // ID del elemento que muestra el timer
  #unloadHandler = null; // referencia para poder removerla en destroy()

  // ── Constantes ───────────────────────────────────────────
  static #TICK_MS = 1000;
  static #storageKey = uid => `elapsed_ms_${uid}`;

  /**
   * @param {string} uid  ID único del paciente. Se usa como clave de storage.
   * @param {string} [domId]  ID del elemento DOM donde se muestra el timer.
   */
  constructor(uid, domId = "tiempoTerapia") {
    if (!uid) throw new Error("SessionTimer: uid es requerido");
    this.#uid   = String(uid);
    this.#domId = domId;
  }

  // ── Getters públicos ─────────────────────────────────────

  /** Milisegundos totales (incluyendo el intervalo activo si corre). */
  get elapsed() {
    return this.#running
      ? this.#accMs + (Date.now() - this.#startMs)
      : this.#accMs;
  }

  /** Segundos totales, truncados. */
  get elapsedSeconds() {
    return Math.floor(this.elapsed / 1000);
  }

  /** True si el timer está corriendo actualmente. */
  get isRunning() {
    return this.#running;
  }

  /** ID de sesión activa en el backend (puede ser null). */
  get sessionId() {
    return this.#sessionId;
  }
  set sessionId(id) {
    this.#sessionId = id ?? null;
  }

  get #running() {
    return this.#startMs !== null;
  }

  // ── API pública ──────────────────────────────────────────

  /**
   * Inicializa el timer con el estado guardado.
   * Combina el tiempo del servidor con lo que haya en storage,
   * tomando el mayor de los dos (el servidor es la fuente de verdad,
   * pero el storage puede tener un valor más reciente no sincronizado).
   *
   * @param {number} [serverMs=0]    Milisegundos acumulados según el backend.
   * @param {string|null} [sessionId]  ID de sesión activa en el backend.
   */
  init(serverMs = 0, sessionId = null) {
    this.#stop();   // detener cualquier tick previo
    const storedMs = this.#readStorage();
    this.#accMs    = Math.max(Number(serverMs) || 0, storedMs);
    this.#sessionId = sessionId ?? null;
    this.#draw();
    this.#setupBeforeUnload();
  }

  /**
   * Arranca el timer. Si ya estaba corriendo, no hace nada.
   */
  start() {
    if (this.#running) return;
    this.#startMs = Date.now();
    this.#tick = setInterval(() => this.#draw(), SessionTimer.#TICK_MS);
    this.#draw();
  }

  /**
   * Pausa el timer y persiste el tiempo acumulado.
   * Si ya estaba pausado, no hace nada.
   */
  pause() {
    if (!this.#running) return;
    this.#accMs += Date.now() - this.#startMs;
    this.#stop();
    this.persist();
    this.#draw();
  }

  /**
   * Alterna entre play y pause.
   */
  toggle() {
    this.#running ? this.pause() : this.start();
  }

  /**
   * Guarda el tiempo actual en storage sin detener el timer.
   */
  persist() {
    storage.set(SessionTimer.#storageKey(this.#uid), String(this.elapsed));
  }

  /**
   * Reinicia el timer a cero, limpia storage y detiene el tick.
   */
  reset() {
    this.#stop();
    this.#accMs    = 0;
    this.#sessionId = null;
    storage.remove(SessionTimer.#storageKey(this.#uid));
    this.#draw();
  }

  /**
   * Formatea el tiempo actual como "HH:MM:SS".
   * @returns {string}
   */
  format() {
    return SessionTimer.#fmt(this.elapsed);
  }

  /**
   * Limpia el timer completamente: detiene tick y remueve
   * el listener de beforeunload. Llamar antes de destruir.
   */
  destroy() {
    this.#stop();
    if (this.#unloadHandler) {
      window.removeEventListener("beforeunload", this.#unloadHandler);
      this.#unloadHandler = null;
    }
  }

  /**
   * Indica si localStorage está disponible en este entorno.
   * Útil para mostrar advertencias en la UI si no lo está.
   * @returns {boolean}
   */
  static get storageAvailable() {
    return storage.isAvailable;
  }

  // ── Privados ─────────────────────────────────────────────

  #stop() {
    this.#startMs = null;
    if (this.#tick) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
  }

  #draw() {
    const el = document.getElementById(this.#domId);
    if (el) el.textContent = this.format();
  }

  #readStorage() {
    const raw = storage.get(SessionTimer.#storageKey(this.#uid));
    const n   = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  #setupBeforeUnload() {
    // Remover handler anterior si existe (evitar duplicados en reinits)
    if (this.#unloadHandler) {
      window.removeEventListener("beforeunload", this.#unloadHandler);
    }
    this.#unloadHandler = () => this.persist();
    window.addEventListener("beforeunload", this.#unloadHandler);
  }

  static #fmt(ms) {
    const n = Math.max(0, Math.floor(ms));
    const h = Math.floor(n / 3_600_000);
    const m = Math.floor((n % 3_600_000) / 60_000);
    const s = Math.floor((n % 60_000) / 1_000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
}

// ── Exportar también el storage adapter para uso en sessions.js ──
export { storage as timerStorage, StorageAdapter };
