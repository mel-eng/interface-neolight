// =========================================================
// public/js/doctor-navigation.js
// Navegación interna y calculadora del plan terapéutico.
// =========================================================

import { $ } from "./config.js";

export function bindDoctorSections() {
  const navItems = document.querySelectorAll("#view-dashboard-doctor [data-section-target]");
  const sections = document.querySelectorAll("#view-dashboard-doctor .doctor-section[data-section]");
  if (!navItems.length || !sections.length) return;

  const showSection = sectionName => {
    sections.forEach(section => {
      section.classList.toggle("active", section.dataset.section === sectionName);
    });
    navItems.forEach(button => {
      button.classList.toggle("dp-nav-active", button.dataset.sectionTarget === sectionName);
    });
    const viewTop = $("view-dashboard-doctor")?.offsetTop || 0;
    window.scrollTo({ top: viewTop, behavior: "smooth" });
  };

  navItems.forEach(button => {
    button.style.cursor = "pointer";
    button.addEventListener("click", () => showSection(button.dataset.sectionTarget || "resumen"));
  });

  const initial = document.querySelector("#view-dashboard-doctor .doctor-section.active")?.dataset.section || "resumen";
  showSection(initial);
}

export function bindPlanCalculator() {
  const planIntensity = $("planIntensity");
  const planRate = $("planRate");
  const planResult = $("planResult");
  if (planRate && planIntensity) planRate.value = String(defaultRate(planIntensity.value));

  planIntensity?.addEventListener("change", () => {
    if (planRate) planRate.value = String(defaultRate(planIntensity.value));
  });

  $("calcPlanBtn")?.addEventListener("click", () => {
    const tsb = parseDecimal($("planTSB")?.value);
    const goal = parseDecimal($("planGoal")?.value);
    let rate = parseDecimal(planRate?.value);

    if (!Number.isFinite(tsb) || !Number.isFinite(goal) || tsb <= goal) {
      if (planResult) planResult.textContent = " ";
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      rate = defaultRate(planIntensity?.value);
      if (planRate) planRate.value = String(rate);
    }

    const totalMinutes = Math.max(0, Math.round(((tsb - goal) / rate) * 60));
    if (planResult) {
      planResult.textContent = `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m aprox.`;
    }
  });
}

function defaultRate(value) {
  return value === "int" ? 0.30 : 0.15;
}

function parseDecimal(value) {
  return Number(String(value ?? "").replace(",", "."));
}
