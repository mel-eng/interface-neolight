// =========================================================
// public/js/main.js
// Entry point: inicializa módulos, maneja navegación y
// enruta al dashboard correcto según el rol
// =========================================================

import { $, state } from "./config.js";
import { initAuth, openAuthModal, doLogout, bootstrapFromStorage } from "./auth.js";
import { initSessions } from "./sessions.js";

// =========================================================
// NAVEGACIÓN
// =========================================================
export function setActiveNav(v) {
  document.querySelectorAll("#publicNav button[data-nav]").forEach(b =>
    b.classList.toggle("active", b.dataset.nav === v)
  );
}

export function navigate(viewName) {
  if (viewName === "login") { openAuthModal(); return; }
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const target = document.getElementById("view-" + viewName);
  if (target) target.classList.add("active");
  setActiveNav(viewName);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function setNavMode(mode) {
  const nav = $("publicNav"); if (!nav) return;
  nav.style.display = mode === "private" ? "none" : "";
}

// =========================================================
// DASHBOARD ROUTER
// =========================================================
function showDash(which) {
  const lb = $("logoutBtn"); if (lb) lb.style.display = "inline-flex";
  setNavMode("private");
  document.body.classList.toggle("superuser-mode", which === "superuser");
  const target = which === "patient"
    ? "dashboard-patient"
    : which === "superuser"
      ? "dashboard-superuser"
      : "dashboard-doctor";
  navigate(target);
}

export async function enterFromSession(data) {
  const role = data?.chosenRole || (data?.doctor ? "doctor" : data?.paciente ? "tutor" : null);
  if (!role) {
    doLogout(false);
    return;
  }
  state.currentRole = role;


  if (role === "superuser") {
    if (!data?.superuser) {
      doLogout(false);
      return;
    }
    state.currentUserId = data.superuser.id;
    state.currentSuperuserId = data.superuser.id;
    showDash("superuser");
    const { initSocket, socketIdentifySuperuser } = await import("./socket.js");
    initSocket();
    socketIdentifySuperuser(data.superuser.id);
    const { initSuperuserDashboard } = await import("./superuser-dashboard.js");
    await initSuperuserDashboard(data);
    return;
  }

  if (role === "doctor") {
    if (!data?.doctor) {
      doLogout(false);
      return;
    }
    showDash("doctor");
    const { initSocket, socketIdentifyDoctor } = await import("./socket.js");
    initSocket();
    socketIdentifyDoctor(data.doctor.id);
    const { initDoctorDashboard } = await import("./doctor-dashboard.js");
    initDoctorDashboard(data);
    return;
  }

  if (role !== "tutor" || !data?.paciente || !data?.tutor) {
    doLogout(false);
    return;
  }
  showDash("patient");

  // Cargar e inicializar socket antes del dashboard
  const { initSocket, socketIdentifyTutor } = await import("./socket.js");
  initSocket();
  socketIdentifyTutor(data.tutor.id, data.paciente.id);

  const { initPatientDashboard } = await import("./patient-dashboard.js");
  await initPatientDashboard(data);
}

// =========================================================
// BIND BOTONES DE NAVEGACIÓN
// =========================================================
function bindNavButtons() {
  // Brand / logo → home
  $("brandHome")?.addEventListener("click", () => navigate("home"));
  $("brandHome")?.addEventListener("keydown", e => { if (e.key === "Enter") navigate("home"); });

  // Nav links
  $("navHome")?.addEventListener("click",     () => navigate("home"));
  $("navLogin")?.addEventListener("click",    () => openAuthModal());
  $("topLoginBtn")?.addEventListener("click", () => openAuthModal());
  $("navHistoria")?.addEventListener("click", () => navigate("historia"));
  $("navContacto")?.addEventListener("click", () => navigate("contacto"));

  // Hero CTA
  $("heroLoginBtn")?.addEventListener("click",    () => openAuthModal());
  $("heroRegisterBtn")?.addEventListener("click", () => openAuthModal("registerChooserView"));
  $("historiaLoginBtn")?.addEventListener("click",() => openAuthModal("loginView"));

  // Footer links
  $("footerLogin")?.addEventListener("click",    () => openAuthModal());
  $("footerHistoria")?.addEventListener("click", () => navigate("historia"));
  $("footerContacto")?.addEventListener("click", () => navigate("contacto"));
  $("footerHome")?.addEventListener("click",     () => navigate("home"));
}

// =========================================================
// INIT
// =========================================================
async function init() {
  bindNavButtons();
  initAuth();
  initSessions();

  // Inicializar calculadora de tasa por defecto
  const planRate = $("planRate"), planIntensity = $("planIntensity");
  if (planRate && planIntensity) planRate.value = "0.15";

  // Navegar a home
  navigate("home");

  // El QR de la lámpara abre directo el teclado del acceso técnico.
  const openTechIfAsked = async () => {
    if (location.hash.toLowerCase() !== "#tecnico") return false;
    const { openTechAccess } = await import("./auth.js");
    if (state.currentRole) doLogout(false);
    openTechAccess();
    return true;
  };
  window.addEventListener("hashchange", openTechIfAsked);
  if (await openTechIfAsked()) return;

  // Restaurar sesión desde localStorage
  await bootstrapFromStorage();
}

// Arrancar cuando el DOM esté listo
document.addEventListener("DOMContentLoaded", init);
