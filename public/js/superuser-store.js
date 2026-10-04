const STORAGE_KEY = "neolight_superuser_workspace_v1";

const defaults = {
  selectedEquipment: "neo-01",
  equipments: [
    {
      id: "neo-01",
      name: "NEOLIGHT-01",
      status: "operativo",
      description: "Prototipo principal conectado al sistema de monitoreo.",
      location: "Laboratorio de pruebas",
      sessions: 0,
      hours: 0,
      lastTest: null,
      notes: "Equipo principal disponible para diagnóstico.",
    },
    {
      id: "neo-02",
      name: "NEOLIGHT-02",
      status: "sin_verificar",
      description: "Segunda lámpara pendiente de encendido y revisión física.",
      location: "Almacenamiento",
      sessions: 0,
      hours: 0,
      lastTest: null,
      notes: "No se ha confirmado todavía su funcionamiento.",
    },
  ],
  maintenance: [],
  diagnosticTests: [],
  assignments: [],
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function loadWorkspace() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return clone(defaults);
    return {
      ...clone(defaults),
      ...stored,
      equipments: Array.isArray(stored.equipments) && stored.equipments.length ? stored.equipments : clone(defaults.equipments),
      maintenance: Array.isArray(stored.maintenance) ? stored.maintenance : [],
      diagnosticTests: Array.isArray(stored.diagnosticTests) ? stored.diagnosticTests : [],
      assignments: Array.isArray(stored.assignments) ? stored.assignments : [],
    };
  } catch (_) {
    return clone(defaults);
  }
}

export function saveWorkspace(workspace) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); } catch (_) {}
  return workspace;
}

export function getEquipment(workspace, id = workspace.selectedEquipment) {
  return workspace.equipments.find(item => item.id === id) || workspace.equipments[0];
}

export function updateEquipment(workspace, id, patch) {
  const index = workspace.equipments.findIndex(item => item.id === id);
  if (index < 0) return workspace;
  workspace.equipments[index] = { ...workspace.equipments[index], ...patch };
  return saveWorkspace(workspace);
}

export function addMaintenance(workspace, entry) {
  workspace.maintenance.unshift({
    id: `maint-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  workspace.maintenance = workspace.maintenance.slice(0, 100);
  return saveWorkspace(workspace);
}

export function addDiagnosticTest(workspace, entry) {
  workspace.diagnosticTests.unshift({
    id: `test-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  workspace.diagnosticTests = workspace.diagnosticTests.slice(0, 150);
  return saveWorkspace(workspace);
}

export function addAssignment(workspace, entry) {
  workspace.assignments.unshift({
    id: `assign-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });
  workspace.assignments = workspace.assignments.slice(0, 50);
  return saveWorkspace(workspace);
}
