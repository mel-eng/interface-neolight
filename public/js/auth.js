// =========================================================
// public/js/auth.js
// Maneja: modal de auth, login, registro tutor, registro doctor,
// keypad de código, logout y restauración de sesión
// =========================================================

import { $, state, SESSION_KEY, LOGIN_KEY, DOCTOR_CODE_CACHE } from "./config.js";
import { verifyHospitalCode, fetchDoctors, registerDoctor, registerTutor, login, fetchCurrentDoctorState, fetchCurrentTutorState } from "./api.js";

// =========================================================
// REFERENCIAS DOM
// =========================================================
const authModal    = $("authModal");
const authBackdrop = $("authBackdrop");
const authCloseBtn = $("authCloseBtn");
let   lastFocusEl  = null;
let   authBound    = false;

const ERROR_MESSAGES = {
  faltan_credenciales:  "Ingresa usuario y contraseña.",
  credenciales_invalidas: "Usuario o contraseña incorrectos.",
  cuenta_inactiva:      "La cuenta está inactiva.",
  cuenta_sin_paciente:  "La cuenta de tutor no tiene paciente asociado.",
  faltan_campos:        "Completa todos los campos requeridos.",
  contrasena_minima_5:  "La contraseña debe tener al menos 5 caracteres.",
  usuario_ya_existe:    "El usuario ya existe.",
  correo_ya_existe:     "El correo ya está registrado.",
  doctor_no_encontrado: "Selecciona un doctor válido.",
  fecha_nac_invalida:   "La fecha de nacimiento no es válida.",
};

function friendlyError(data, fallback = "No se pudo completar la operación.") {
  if (data?.message) return data.message;
  return ERROR_MESSAGES[data?.error] || fallback;
}

function setButtonBusy(id, busy, text = null) {
  const btn = $(id);
  if (!btn) return;
  if (busy) {
    btn.dataset.prevText = btn.textContent;
    if (text) btn.textContent = text;
  } else if (btn.dataset.prevText) {
    btn.textContent = btn.dataset.prevText;
    delete btn.dataset.prevText;
  }
  btn.disabled = !!busy;
  btn.setAttribute("aria-busy", String(!!busy));
}

// =========================================================
// MODAL HELPERS
// =========================================================
function setAuthHeader(title, sub) {
  const t = $("authTitle"), s = $("authSub");
  if (t) t.textContent = title;
  if (s) s.textContent = sub || "";
}

export function showAuthView(idToShow) {
  const views = ["loginView","registerChooserView","doctorCodeView","registerTutorView","registerDoctorView"];
  views.forEach(id => {
    const el = $(id);
    if (el) el.style.display = id === idToShow ? "block" : "none";
  });
  if (idToShow === "loginView")           setAuthHeader("Iniciar sesión",  "Accede al sistema.");
  if (idToShow === "registerChooserView") setAuthHeader("Crear cuenta",    "Elige el tipo de registro.");
  if (idToShow === "doctorCodeView")      setAuthHeader("Código hospital", "Verificación para personal médico.");
  if (idToShow === "registerTutorView")   setAuthHeader("Crear cuenta",    "Registro Tutor / Paciente.");
  if (idToShow === "registerDoctorView")  setAuthHeader("Registrar doctor","Personal médico autorizado.");
}

export function openAuthModal(initialView = "loginView") {
  if (!authModal) return;
  lastFocusEl = document.activeElement;
  authModal.classList.add("open");
  authModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  showAuthView(initialView);
  setTimeout(() => { if (initialView === "loginView") $("usuario")?.focus(); }, 80);
}

export function closeAuthModal() {
  if (!authModal) return;
  authModal.classList.remove("open");
  authModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  try { lastFocusEl?.focus?.(); } catch (_) {}
}

// =========================================================
// EYE BUTTONS (toggle password visibility)
// =========================================================
function bindEyeButtons() {
  document.querySelectorAll(".eye-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isPass = input.type === "password";
      input.type      = isPass ? "text" : "password";
      btn.textContent = isPass ? "🙈" : "👁";
      input.focus();
    });
  });
}

// =========================================================
// DOCTOR CODE KEYPAD
// =========================================================
let codeBuf = "";
const CODE_LEN = 6;

function renderDots() {
  document.querySelectorAll("#dots .dot").forEach((d, i) =>
    d.classList.toggle("filled", i < codeBuf.length)
  );
}

function codeKey(k) {
  if (k === "clear") { codeBuf = ""; renderDots(); return; }
  if (k === "back")  { codeBuf = codeBuf.slice(0, -1); renderDots(); return; }
  if (!/^\d$/.test(k) || codeBuf.length >= CODE_LEN) return;
  codeBuf += k; renderDots();
}

async function doVerifyCode() {
  const msg = $("codeMsg"); msg.textContent = "";
  if (codeBuf.length !== CODE_LEN) { msg.textContent = "Ingresa los 6 dígitos."; return false; }
  try {
    const { ok, data } = await verifyHospitalCode(codeBuf);
    if (!ok) { msg.textContent = data?.error || "Código inválido."; return false; }
    try { localStorage.setItem(DOCTOR_CODE_CACHE, "1"); } catch (_) {}
    return true;
  } catch (_) {
    msg.textContent = "No se pudo verificar (sin servidor).";
    return false;
  }
}

// =========================================================
// LOAD DOCTORS INTO SELECT
// =========================================================
async function loadDoctorsIntoSelect() {
  const sel = $("regDoctorSelect"); if (!sel) return;
  sel.innerHTML = `<option value="">Cargando doctores…</option>`;
  try {
    const { ok, data } = await fetchDoctors();
    const list = (ok && Array.isArray(data.doctors)) ? data.doctors : [];
    if (!list.length) { sel.innerHTML = `<option value="">No hay doctores disponibles</option>`; return; }
    sel.innerHTML = `<option value="">Selecciona un doctor</option>`;
    list.forEach(d => {
      const name = `${d.nombre || ""} ${d.apellidos || ""}`.trim() || "Doctor";
      const opt  = document.createElement("option");
      opt.value       = d.id ?? name;
      opt.textContent = name + (d.especialidad ? ` • ${d.especialidad}` : "");
      opt.dataset.name = name;
      sel.appendChild(opt);
    });
  } catch (_) {
    sel.innerHTML = `<option value="">No se pudieron cargar doctores</option>`;
  }
}

// =========================================================
// AUTO USERNAME
// =========================================================
function autoUserTutor() {
  const n = ($("regNombre")?.value || "").trim().toLowerCase().split(/\s+/)[0] || "";
  const parts = `${$("regApPat")?.value || ""} ${$("regApMat")?.value || ""}`
    .trim().toLowerCase().split(/\s+/);
  const a = (parts[0] || "").slice(0, 2);
  const b = (parts[1] || "").slice(0, 2);
  const u = $("regUser");
  const suggested = (n + a + b).replace(/[^a-z0-9]/g, "") || "—";
  if (u) u.textContent = suggested;
  const input = $("regUserInput");
  if (input && !input.dataset.userEdited) input.value = suggested === "—" ? "" : suggested;
}

function autoUserDoctor() {
  const n = ($("docNombre")?.value    || "").trim().toLowerCase().split(/\s+/)[0] || "";
  const a = ($("docApellidos")?.value || "").trim().toLowerCase().split(/\s+/)[0] || "";
  const u = $("docUser");
  if (u) u.textContent = (n + a.slice(0, 3)).replace(/[^a-z0-9]/g, "") || "—";
}

// =========================================================
// REGISTER TUTOR
// =========================================================
async function doRegisterTutor() {
  const msg    = $("regMsg"); msg.textContent = "";
  const nombre = ($("regNombre")?.value || "").trim();
  const apPat  = ($("regApPat")?.value  || "").trim();
  const apMat  = ($("regApMat")?.value  || "").trim();
  const dob    = $("regDob")?.value    || "";
  const pass   = $("regPass")?.value   || "";
  const tutorNombre    = ($("regTutorNombre")?.value    || "").trim();
  const tutorApellidos = ($("regTutorApellidos")?.value || "").trim();
  const sel    = $("regDoctorSelect");
  const doctorId   = sel?.value || "";
  const doctorName = sel?.selectedOptions?.[0]?.dataset?.name || sel?.selectedOptions?.[0]?.textContent || "—";
  const usuario    = (($("regUserInput")?.value || "").trim() || ($("regUser")?.textContent || "").trim()).replace(/\s+/g, "");

  if (!nombre || !apPat || !apMat || !dob) {
    msg.textContent = "Completa los datos del paciente.";
    return;
  }
  if (!tutorNombre || !tutorApellidos) {
    msg.textContent = "Completa los datos del tutor.";
    return;
  }
  if (!usuario || usuario === "—") { msg.textContent = "Define un usuario para el tutor."; return; }
  if (pass.length < 5)   { msg.textContent = "La contraseña debe tener al menos 5 caracteres."; return; }
  if (!doctorId)         { msg.textContent = "Selecciona un doctor a cargo."; return; }

  setButtonBusy("registerTutorBtn", true, "Creando...");
  try {
    const { ok, data } = await registerTutor({
      nombre,
      apellidos: `${apPat} ${apMat}`,
      fecha_nac: dob,
      genero: $("regGeneroPaciente")?.value || "no_especificado",
      peso_nacimiento_g: numberOrNull("regPesoNacimiento"),
      edad_gestacional_sem: numberOrNull("regEdadGestacional"),
      fecha_ingreso: $("regFechaIngreso")?.value || undefined,
      diagnostico: ($("regDiagnostico")?.value || "").trim() || null,
      observaciones: ($("regObservaciones")?.value || "").trim() || null,
      nivel_bilirrubina_inicial: numberOrNull("regBiliInicial"),
      grupo_sanguineo: $("regGrupoSanguineo")?.value || null,
      factor_rh: $("regFactorRh")?.value || null,
      doctor_id: doctorId, doctor: doctorName,
      tutor_nombre: tutorNombre,
      tutor_apellidos: tutorApellidos,
      tutor_genero: $("regTutorGenero")?.value || "no_especificado",
      tutor_telefono: ($("regTutorTelefono")?.value || "").trim() || null,
      tutor_correo: ($("regTutorCorreo")?.value || "").trim() || null,
      parentesco: ($("regParentesco")?.value || "").trim() || "otro",
      usuario, contrasena: pass, rol: "tutor",
    });
    if (!ok) { msg.textContent = friendlyError(data, "No se pudo registrar."); return; }
    const u = $("usuario");
    if (u) u.value = data.usuario || usuario;
    showAuthView("loginView");
    const lm = $("loginMsg");
    if (lm) lm.textContent = `Cuenta creada. Usuario: ${data.usuario || usuario}. Solicitud pendiente.`;
  } catch (_) {
    msg.textContent = "No se pudo conectar al servidor.";
  } finally {
    setButtonBusy("registerTutorBtn", false);
  }
}

function numberOrNull(id) {
  const raw = ($(id)?.value || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// =========================================================
// REGISTER DOCTOR
// =========================================================
async function doRegisterDoctor() {
  const msg         = $("docMsg"); msg.textContent = "";
  const nombre      = ($("docNombre")?.value      || "").trim();
  const apellidos   = ($("docApellidos")?.value   || "").trim();
  const genero      = ($("docGenero")?.value      || "").trim();
  const telefono    = ($("docTelefono")?.value    || "").trim();
  const correo      = ($("docCorreo")?.value      || "").trim();
  const matricula   = ($("docMatricula")?.value   || "").trim();
  const especialidad= ($("docEspecialidad")?.value || "").trim();
  const usuario     = ($("docUser")?.textContent  || "").trim();
  const pass        = ($("docPass")?.value        || "").trim();

  if (!nombre || !apellidos || !genero || !telefono || !correo || !matricula || !especialidad || !pass) {
    msg.textContent = "Completa los datos personales y profesionales.";
    return;
  }
  if (!usuario || usuario === "—") { msg.textContent = "No se pudo generar usuario."; return; }
  if (pass.length < 5) { msg.textContent = "La contraseña debe tener al menos 5 caracteres."; return; }

  let okCache = "0";
  try { okCache = localStorage.getItem(DOCTOR_CODE_CACHE) || "0"; } catch (_) {}
  if (okCache !== "1") { msg.textContent = "Acceso no autorizado (verifica código)."; return; }

  setButtonBusy("registerDoctorBtn", true, "Registrando...");
  try {
    const { ok, data } = await registerDoctor({
      nombre, apellidos, genero, telefono, correo,
      matricula, especialidad, usuario, contrasena: pass,
    });
    if (!ok) { msg.textContent = friendlyError(data, "No se pudo registrar doctor."); return; }
    const u = $("usuario"); if (u) u.value = usuario;
    showAuthView("loginView");
    const lm = $("loginMsg"); if (lm) lm.textContent = `Doctor registrado. Usuario: ${usuario}`;
  } catch (_) {
    msg.textContent = "No se pudo conectar al servidor.";
  } finally {
    setButtonBusy("registerDoctorBtn", false);
  }
}

// =========================================================
// LOGIN
// =========================================================
export async function doLogin() {
  const user = ($("usuario")?.value    || "").trim();
  const pass = ($("contrasena")?.value || "").trim();
  const msg  = $("loginMsg"); msg.textContent = "";

  setButtonBusy("loginBtn", true, "Ingresando...");

  try {
    const { ok, status, data } = await login(user, pass);
    if (!ok) {
      if (status === 403 && data?.error === "doctor_no_acepto") {
        msg.textContent = data.status === "pending"
          ? "Tu solicitud está pendiente. El doctor aún no aceptó."
          : "Tu solicitud fue rechazada por el doctor.";
        return;
      }
      msg.textContent = friendlyError(data, "Credenciales inválidas.");
      return;
    }
    const resolvedRole = data.role === "doctor" || data.role === "admin"
      ? "doctor"
      : data.role === "tutor"
        ? "tutor"
        : data.paciente ? "tutor" : (data.doctor ? "doctor" : null);
    if (!resolvedRole) { msg.textContent = "Respuesta inválida del servidor."; return; }

    const snapshot = {
      paciente:     data.paciente     || null,
      tutor:        data.tutor        || null,
      doctor:       data.doctor       || null,
      last_session: data.last_session || null,
      plan:         data.plan         || null,
      session:      data.session      || null,
      control:      data.control      || null,
      dispositivo:  data.dispositivo  || null,
      chosenRole:   resolvedRole,
    };

    try { localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot)); } catch (_) {}
    if ($("rememberMe")?.checked) {
      try { localStorage.setItem(LOGIN_KEY, JSON.stringify({ usuario: user })); } catch (_) {}
    }

    closeAuthModal();
    // Importado dinámicamente para evitar dependencia circular
    const { enterFromSession } = await import("./main.js");
    enterFromSession(snapshot);
  } catch (_) {
    msg.textContent = "No se pudo conectar al servidor";
  } finally {
    setButtonBusy("loginBtn", false);
  }
}

// =========================================================
// LOGOUT
// =========================================================
export function doLogout(showMsg = false) {
  state.currentUserId  = null;
  state.currentRole    = null;
  state.currentTutorId = null;
  state.doctorId       = null;
  state.pacienteData   = null;
  state.controlData    = null;

  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}

  const lb = $("logoutBtn"); if (lb) lb.style.display = "none";
  closeAuthModal();
  import("./main.js").then(({ setNavMode, navigate }) => {
    setNavMode("public");
    navigate("home");
  }).catch(() => {});

  import("./socket.js").then(({ disconnectSocket }) => disconnectSocket()).catch(() => {});

  void showMsg;
  // Logout returns to Home; login modal is only opened by explicit login actions.
  if (false && showMsg) {
    const lm = $("loginMsg"); if (lm) lm.textContent = "Sesión guardada.";
  }
}

// =========================================================
// BOOTSTRAP DESDE STORAGE
// =========================================================
export async function bootstrapFromStorage() {
  try {
    const sl = JSON.parse(localStorage.getItem(LOGIN_KEY) || "null");
    if (sl?.usuario) {
      const u = $("usuario"); if (u) u.value = sl.usuario;
      const rm = $("rememberMe"); if (rm) rm.checked = true;
    }
  } catch (_) {}

  // Restaurar sesión
  try {
    const ss = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (ss) {
      let fresh = null;
      if (ss.chosenRole === "doctor" && ss.doctor?.id) {
        const res = await fetchCurrentDoctorState(ss.doctor.id);
        if (res.ok) fresh = { ...res.data, chosenRole: "doctor" };
      } else if (ss.chosenRole === "tutor" && ss.tutor?.id) {
        const res = await fetchCurrentTutorState(ss.tutor.id);
        if (res.ok) fresh = { ...res.data, chosenRole: "tutor" };
      }
      if (!fresh) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      localStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
      const { enterFromSession } = await import("./main.js");
      enterFromSession(fresh);
    }
  } catch (_) {}
}

// =========================================================
// INIT — enlaza todos los eventos del modal
// =========================================================
export function initAuth() {
  if (authBound) return;
  authBound = true;
  bindEyeButtons();

  authBackdrop?.addEventListener("click", closeAuthModal);
  authCloseBtn?.addEventListener("click", closeAuthModal);
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && authModal?.classList.contains("open")) closeAuthModal();
  });

  // Keypad del código
  document.querySelectorAll("#keypad .key").forEach(btn =>
    btn.addEventListener("click", () => codeKey(btn.dataset.k))
  );
  $("verifyCodeBtn")?.addEventListener("click", async () => {
    const ok = await doVerifyCode();
    if (ok) { codeBuf = ""; renderDots(); showAuthView("registerDoctorView"); setTimeout(() => $("docNombre")?.focus(), 60); }
  });

  // Navegación entre vistas del modal
  $("showRegister")?.addEventListener("click",  () => showAuthView("registerChooserView"));
  $("backToLogin1")?.addEventListener("click",  () => showAuthView("loginView"));
  $("backToChooser")?.addEventListener("click", () => showAuthView("registerChooserView"));
  $("backToChooser2")?.addEventListener("click",() => showAuthView("registerChooserView"));
  $("backToChooser3")?.addEventListener("click",() => showAuthView("registerChooserView"));

  $("goRegister")?.addEventListener("click", async () => {
    const role = $("regRole")?.value || "tutor";
    const cm = $("chooserMsg"); if (cm) cm.textContent = "";
    if (role === "doctor") {
      showAuthView("doctorCodeView"); codeBuf = ""; renderDots();
    } else {
      showAuthView("registerTutorView");
      await loadDoctorsIntoSelect();
      setTimeout(() => $("regNombre")?.focus(), 60);
    }
  });

  $("regUserInput")?.addEventListener("input", e => { e.currentTarget.dataset.userEdited = "1"; });
  ["regNombre","regApPat","regApMat"].forEach(id => $(id)?.addEventListener("input", autoUserTutor));
  ["docNombre","docApellidos"].forEach(id => $(id)?.addEventListener("input", autoUserDoctor));

  $("registerTutorBtn")?.addEventListener("click", doRegisterTutor);
  $("registerDoctorBtn")?.addEventListener("click", doRegisterDoctor);

  $("loginBtn")?.addEventListener("click", doLogin);
  ["usuario","contrasena"].forEach(id => $(id)?.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); }));

  $("logoutBtn")?.addEventListener("click", async () => {
    const { saveSession } = await import("./sessions.js");
    await saveSession();
    doLogout(false);
  });
}
