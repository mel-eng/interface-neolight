// =========================================================
// public/js/superuser-store.js
// Datos del panel de superusuario: equipos, mantenimiento,
// pruebas de diagnóstico y reasignaciones.
//
// Todo se guarda en MySQL (tablas equipos, mantenimientos y
// pruebas_diagnostico). En el navegador solo se recuerda qué
// equipo estaba seleccionado.
// =========================================================

import { apiFetch } from "./config.js";

const SELECTED_KEY = "neolight_superuser_selected_equipment";

const emptyWorkspace = () => ({
  selectedEquipment: null,
  equipments: [],
  maintenance: [],
  diagnosticTests: [],
  assignments: [],
});

async function send(path, method, body) {
  try {
    const response = await apiFetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, data };
  } catch (_) {
    return { ok: false, data: { message: "Sin conexión con el servidor." } };
  }
}

function rememberSelection(workspace) {
  const exists = workspace.equipments.some(item => item.id === workspace.selectedEquipment);
  if (!exists) workspace.selectedEquipment = workspace.equipments[0]?.id || null;
  try { if (workspace.selectedEquipment) localStorage.setItem(SELECTED_KEY, workspace.selectedEquipment); } catch (_) {}
  return workspace;
}

/** Espacio vacío para pintar la pantalla mientras llegan los datos reales. */
export function loadWorkspace() {
  const workspace = emptyWorkspace();
  try { workspace.selectedEquipment = localStorage.getItem(SELECTED_KEY) || null; } catch (_) {}
  return workspace;
}

/** Trae del servidor los equipos y sus registros. */
export async function hydrateWorkspace(workspace) {
  try {
    const response = await apiFetch("/api/superuser/workspace");
    const data = await response.json();
    if (!response.ok || data.ok === false) return workspace;
    workspace.equipments = data.equipments || [];
    workspace.maintenance = data.maintenance || [];
    workspace.diagnosticTests = data.diagnosticTests || [];
    workspace.assignments = data.assignments || [];
  } catch (_) {}
  return rememberSelection(workspace);
}

export function saveWorkspace(workspace) { return rememberSelection(workspace); }

export function getEquipment(workspace, id = workspace.selectedEquipment) {
  return workspace.equipments.find(item => item.id === id) || workspace.equipments[0] || null;
}

/** El primer equipo es la lámpara conectada al sistema. */
export function isPrimaryEquipment(workspace, equipment) {
  return !!equipment && equipment.id === workspace.equipments[0]?.id;
}

export function updateEquipment(workspace, id, patch) {
  const index = workspace.equipments.findIndex(item => item.id === id);
  if (index < 0) return workspace;
  workspace.equipments[index] = { ...workspace.equipments[index], ...patch };
  send(`/api/superuser/equipments/${encodeURIComponent(id)}`, "PUT", patch);
  return workspace;
}

export async function createEquipment(workspace, entry) {
  const result = await send("/api/superuser/equipments", "POST", entry);
  if (result.ok) {
    workspace.equipments.push({ sessions: 0, hours: 0, lastTest: null, online: false, ...entry, id: result.data.id });
    rememberSelection(workspace);
  }
  return result;
}

export function addMaintenance(workspace, entry) {
  workspace.maintenance.unshift({ id: `maint-${Date.now()}`, createdAt: new Date().toISOString(), ...entry });
  return send("/api/superuser/maintenance", "POST", entry);
}

export function addDiagnosticTest(workspace, entry) {
  workspace.diagnosticTests.unshift({ id: `test-${Date.now()}`, createdAt: new Date().toISOString(), ...entry });
  send("/api/superuser/diagnostics", "POST", entry);
  return workspace;
}

/** Las reasignaciones las registra el servidor al reasignar; aquí solo se reflejan en pantalla. */
export function addAssignment(workspace, entry) {
  workspace.assignments.unshift({ id: `assign-${Date.now()}`, createdAt: new Date().toISOString(), ...entry });
  return workspace;
}
