import { $, escapeHtml, loadClientConfig, state, humanLabel } from "./config.js";
import { registerDoctor } from "./api.js";
import {
  fetchSuperuserOverview,
  fetchSuperuserUsers,
  reassignPatient,
  updateDoctorStatus,
  fetchTelemetry,
  fetchHealth,
} from "./superuser-api.js";
import {
  loadWorkspace,
  hydrateWorkspace,
  createEquipment,
  isPrimaryEquipment,
  saveWorkspace,
  getEquipment,
  updateEquipment,
  addMaintenance,
  addDiagnosticTest,
  addAssignment,
} from "./superuser-store.js";
import { hydrateIcons, icon } from "./superuser-icons.js";
import { getSocket, socketEmitMode, socketEmitMove } from "./socket.js";

let initialized = false;
let pollTimer = null;
let sessionSnapshot = null;
let workspace = loadWorkspace();
let currentSection = "inicio";
let currentUsersTab = "doctors";
let currentDiagnosticTab = "sensors";
let maintenanceMode = "preventive";
let testMode = false;
let cameraUrl = "";
let serverState = {
  overview: null,
  doctors: [],
  patients: [],
  telemetry: null,
  health: null,
};

const sectionMeta = {
  inicio: ["Panel de control", "Inicio", "Resumen general del sistema NeoLight."],
  usuarios: ["Administración", "Usuarios", "Doctores, pacientes y asignaciones clínicas."],
  equipos: ["Inventario técnico", "Equipos", "Estado y seguimiento de las lámparas registradas."],
  diagnostico: ["Verificación funcional", "Diagnóstico", "Pruebas controladas de sensores, actuadores y salidas."],
  mantenimiento: ["Trazabilidad técnica", "Mantenimiento", "Revisiones preventivas, correctivas e historial."],
};

const maintenanceItems = {
  preventive: [
    ["Limpieza de sensores", "Inspección visual y limpieza superficial."],
    ["Verificación de distancia", "Respuesta y coherencia del sensor ultrasónico."],
    ["Revisión de temperatura", "Lectura corporal y ambiental."],
    ["Comprobación de LDR", "Respuesta de los sensores de luz."],
    ["Revisión de actuadores", "Movimiento vertical y lateral."],
    ["Prueba de cámara", "Transmisión y enfoque."],
    ["Verificación de alarmas", "Buzzer y avisos del sistema."],
  ],
  corrective: [
    ["Identificación de la falla", "Componente y síntoma reportado."],
    ["Aislamiento del equipo", "Evitar el uso durante la revisión."],
    ["Prueba del componente", "Confirmar la causa de la falla."],
    ["Acción correctiva", "Ajuste, reparación o sustitución."],
    ["Prueba posterior", "Verificar funcionamiento tras la intervención."],
    ["Observaciones finales", "Documentar hallazgos y recomendaciones."],
  ],
};

const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
const initials = (first = "", last = "") => `${String(first).trim()[0] || ""}${String(last).trim()[0] || ""}`.toUpperCase() || "SU";
const formatDateTime = value => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-BO", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(d);
};
const formatDate = value => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-BO", { day:"2-digit", month:"short", year:"numeric" }).format(d);
};
const formatHours = seconds => {
  const hours = Math.max(0, Number(seconds) || 0) / 3600;
  if (hours < 1 && hours > 0) return `${Math.round(hours * 60)} min`;
  return `${hours.toLocaleString("es-BO", { maximumFractionDigits:1 })} h`;
};
const normalizeTelemetry = payload => payload ? { ...(payload.data || {}), ...(payload.raw || {}), esp32_connected: !!payload.espOnline } : null;
const fullName = person => `${person?.nombre || ""} ${person?.apellidos || ""}`.trim() || "Sin nombre";
const doctorTitle = doctor => String(doctor?.genero || doctor?.doctor_genero || "").toLowerCase() === "femenino" ? "Dra." : "Dr.";
const doctorName = doctor => doctor ? `${doctorTitle(doctor)} ${fullName({ nombre:doctor.nombre || doctor.doctor_nombre, apellidos:doctor.apellidos || doctor.doctor_apellidos })}` : "Sin asignar";

async function ensureTemplate() {
  const mount = $("superuserMount");
  if (!mount) throw new Error("superuser_mount_missing");
  if (mount.dataset.loaded === "true") return;
  const response = await fetch("./partials/superuser-dashboard.html");
  if (!response.ok) throw new Error("superuser_template_unavailable");
  mount.innerHTML = await response.text();
  mount.dataset.loaded = "true";
  hydrateIcons(mount);
}

function showToast(message, type = "success") {
  const stack = $("suToastStack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = `su-toast ${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function setSection(name) {
  if (!sectionMeta[name]) return;
  currentSection = name;
  qa("[data-su-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.suPanel === name));
  qa("[data-su-section]").forEach(button => button.classList.toggle("active", button.dataset.suSection === name));
  const [eyebrow, title, subtitle] = sectionMeta[name];
  $("suSectionEyebrow").textContent = eyebrow;
  $("suSectionTitle").textContent = title;
  $("suSectionSubtitle").textContent = subtitle;
  $("suSidebar")?.classList.remove("open");
  window.scrollTo({ top:0, behavior:"smooth" });
}

function setUsersTab(name) {
  currentUsersTab = name;
  qa("[data-users-tab]").forEach(button => button.classList.toggle("active", button.dataset.usersTab === name));
  qa("[data-users-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.usersPanel === name));
  const newButton = $("suNewDoctorBtn");
  if (newButton) newButton.style.display = name === "doctors" ? "inline-flex" : "none";
  filterUserTables();
}

function setDiagnosticTab(name) {
  currentDiagnosticTab = name;
  qa("[data-diagnostic-tab]").forEach(button => button.classList.toggle("active", button.dataset.diagnosticTab === name));
  qa("[data-diagnostic-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.diagnosticPanel === name));
}

function setSelectedEquipment(id) {
  if (!workspace.equipments.some(item => item.id === id)) return;
  workspace.selectedEquipment = id;
  saveWorkspace(workspace);
  const select = $("suGlobalEquipment");
  if (select) select.value = id;
  updateSelectedEquipmentUI();
  renderEquipmentList();
  renderSensors();
  renderMaintenance();
  disableUnsafeControls();
}

function selectedEquipment() { return getEquipment(workspace); }

function statusPresentation(status) {
  const map = {
    operativo: ["Operativo", "success"],
    en_uso: ["En uso", "success"],
    sin_verificar: ["Sin verificar", "warning"],
    advertencia: ["Con advertencias", "warning"],
    mantenimiento: ["En mantenimiento", "warning"],
    fuera_servicio: ["Fuera de servicio", "danger"],
    desconectado: ["Sin conexión", "neutral"],
  };
  return map[status] || ["Sin verificar", "neutral"];
}

function updateSelectedEquipmentUI() {
  const equipment = selectedEquipment();
  if (!equipment) return;
  const [statusLabel, statusClass] = statusPresentation(equipment.status);
  $("suSelectedEquipmentLabel").textContent = equipment.name;
  $("suHomeEquipmentName").textContent = equipment.name;
  $("suDiagnosticEquipmentName").textContent = equipment.name;
  $("suMaintenanceEquipment").textContent = equipment.name;
  $("suHomeEquipmentDescription").textContent = equipment.description;
  const status = $("suHomeEquipmentStatus");
  status.textContent = statusLabel;
  status.className = `su-status-pill ${statusClass}`;
  $("suHomeLastTest").textContent = equipment.lastTest ? formatDateTime(equipment.lastTest) : "No registrada";
  if (isPrimaryEquipment(workspace, equipment)) {
    const online = !!serverState.telemetry?.esp32_connected || !!serverState.overview?.equipment?.espOnline;
    $("suHomeConnection").textContent = online ? "Conectado" : "Sin conexión";
    $("suHomeLastSeen").textContent = online ? "Ahora" : "—";
  } else {
    $("suHomeConnection").textContent = "No verificado";
    $("suHomeLastSeen").textContent = "—";
  }
}

function setHint(id, text) { const el = $(id); if (el) el.textContent = text; }

function renderOverview() {
  const overview = serverState.overview;
  const stats = overview?.stats || {};
  $("suStatEquipment").textContent = `${overview?.equipment?.operational ?? 0} de ${overview?.equipment?.registered ?? workspace.equipments.length}`;
  const pending = workspace.equipments.filter(item => !["operativo","en_uso"].includes(item.status)).length;
  setHint("suStatEquipmentHint", pending ? `${pending} pendiente${pending === 1 ? "" : "s"} de verificación` : "Todos verificados");
  $("suStatHours").textContent = formatHours(stats.duration_s || 0);
  $("suStatPatients").textContent = String(stats.patients || 0);
  $("suStatAlerts").textContent = String(stats.alerts || 0);
  $("suNotificationBadge").textContent = String(stats.alerts || 0);
  $("suNotificationBadge").dataset.empty = stats.alerts ? "false" : "true";


  renderCalendar();
  renderAlerts();
  renderAssignments();
  updateSelectedEquipmentUI();
}

function renderCalendar() {
  const grid = $("suCalendarGrid");
  if (!grid) return;
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  $("suCalendarMonth").textContent = new Intl.DateTimeFormat("es-BO", { month:"long", year:"numeric" }).format(today);
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const previousDays = new Date(year, month, 0).getDate();
  const usage = new Map((serverState.overview?.usageDays || []).map(row => [String(row.day).slice(0,10), row]));
  const alerts = new Set((serverState.overview?.alerts || []).map(row => String(row.created_at || "").slice(0,10)));
  const maintenance = new Set(workspace.maintenance.map(row => String(row.createdAt || "").slice(0,10)));
  const cells = [];
  for (let i = offset - 1; i >= 0; i--) cells.push({ day:previousDays - i, month:month - 1, muted:true });
  for (let day = 1; day <= daysInMonth; day++) cells.push({ day, month, muted:false });
  while (cells.length % 7) cells.push({ day:cells.length - offset - daysInMonth + 1, month:month + 1, muted:true });
  grid.innerHTML = cells.map(cell => {
    const d = new Date(year, cell.month, cell.day);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const classes = [cell.muted ? "muted" : "", iso === new Date(year,month,today.getDate()).toISOString().slice(0,10) ? "today" : "", usage.has(iso) ? "used" : "", alerts.has(iso) ? "has-alert" : "", maintenance.has(iso) ? "maint" : ""].filter(Boolean).join(" ");
    const entry = usage.get(iso);
    const title = entry ? `${entry.sessions} sesión(es), ${formatHours(entry.duration_s)}` : "Sin sesiones registradas";
    return `<button type="button" class="${classes}" data-calendar-day="${iso}" title="${escapeHtml(title)}">${cell.day}</button>`;
  }).join("");
}

function alertPresentation(alert) {
  const severity = String(alert?.severidad || alert?.severity || "info").toLowerCase();
  const kind = severity === "critical" || severity === "critica" ? "danger" : severity === "warning" || severity === "advertencia" ? "warn" : "info";
  const labels = {
    temperatura_alta:"Temperatura corporal elevada",
    temperatura_baja:"Temperatura corporal baja",
    distancia_fuera_rango:"Distancia fuera del rango",
    sensor_ultra_fail:"Sensor de distancia sin respuesta",
    sensor_body_fail:"Sensor corporal sin respuesta",
    sensor_amb_fail:"Sensor ambiental sin respuesta",
    luz_baja:"Lectura lumínica baja",
  };
  const raw = String(alert?.tipo || alert?.type || "Alerta técnica");
  return { kind, label:labels[raw] || humanLabel(raw) };
}

function renderAlerts() {
  const alerts = serverState.overview?.alerts || [];
  const home = $("suHomeAlerts");
  const drawer = $("suNotificationList");
  if (!home || !drawer) return;
  if (!alerts.length) {
    home.innerHTML = `<div class="su-empty-row">No hay alertas técnicas recientes.</div>`;
    drawer.innerHTML = `<div class="su-empty-row">No hay notificaciones pendientes.</div>`;
    return;
  }
  const html = alert => {
    const view = alertPresentation(alert);
    const patient = [alert.codigo, `${alert.patient_name || ""} ${alert.patient_lastname || ""}`.trim()].filter(Boolean).join(" · ") || "Sistema NeoLight";
    return `<div class="su-list-item" data-alert-kind="technical">
      <span class="su-list-item-icon ${view.kind}">${icon(view.kind === "danger" ? "alert" : view.kind === "warn" ? "wrench" : "info")}</span>
      <div class="su-list-item-copy"><b>${escapeHtml(view.label)}</b><span>${escapeHtml(patient)}</span></div>
      <time>${escapeHtml(formatDateTime(alert.created_at))}</time>
    </div>`;
  };
  home.innerHTML = alerts.slice(0,3).map(html).join("");
  const admin = workspace.assignments.slice(0,5).map(entry => `<div class="su-list-item" data-alert-kind="admin"><span class="su-list-item-icon info">${icon("swap")}</span><div class="su-list-item-copy"><b>Paciente reasignado</b><span>${escapeHtml(entry.patientName)} → ${escapeHtml(entry.doctorName)}</span></div><time>${escapeHtml(formatDateTime(entry.createdAt))}</time></div>`);
  drawer.innerHTML = alerts.map(html).concat(admin).join("");
}

function renderAssignments() {
  const host = $("suHomeAssignments");
  if (!host) return;
  const entries = workspace.assignments.slice(0,3);
  if (!entries.length) {
    host.innerHTML = `<div class="su-empty-row">Las reasignaciones futuras aparecerán aquí.</div>`;
    return;
  }
  host.innerHTML = entries.map(entry => `<div class="su-list-item"><span class="su-list-item-icon info">${icon("swap")}</span><div class="su-list-item-copy"><b>${escapeHtml(entry.patientName)}</b><span>${escapeHtml(entry.previousDoctorName || "Sin médico")} → ${escapeHtml(entry.doctorName)}</span></div><time>${escapeHtml(formatDateTime(entry.createdAt))}</time></div>`).join("");
}

function renderDoctors() {
  const body = $("suDoctorsTableBody");
  if (!body) return;
  const doctors = serverState.doctors;
  $("suDoctorsCount").textContent = `${doctors.length} doctor${doctors.length === 1 ? "" : "es"}`;
  if (!doctors.length) {
    body.innerHTML = `<div class="su-empty-row">No se pudieron cargar doctores o todavía no existen registros.</div>`;
    return;
  }
  body.innerHTML = doctors.map(doctor => {
    const active = doctor.estado === "activo";
    return `<div class="su-table-row" data-search-row="${escapeHtml(`${fullName(doctor)} ${doctor.especialidad || ""}`.toLowerCase())}">
      <div class="su-table-person"><span class="su-person-avatar">${escapeHtml(initials(doctor.nombre,doctor.apellidos))}</span><div><b>${escapeHtml(doctorName(doctor))}</b><small>${escapeHtml(doctor.correo || doctor.usuario || "Sin correo")}</small></div></div>
      <span class="su-table-cell">${escapeHtml(doctor.especialidad || "No registrada")}</span>
      <span class="su-table-cell">${Number(doctor.patient_count || 0)}</span>
      <span><i class="su-status-pill ${active ? "success" : "neutral"}">${active ? "Activo" : "Inactivo"}</i></span>
      <span class="su-table-actions"><button class="su-mini-button" type="button" data-edit-doctor="${doctor.id}">Ver</button><button class="su-mini-button ${active ? "danger" : ""}" type="button" data-toggle-doctor="${doctor.id}">${active ? "Desactivar" : "Reactivar"}</button></span>
    </div>`;
  }).join("");
}

function renderPatients() {
  const body = $("suPatientsTableBody");
  if (!body) return;
  const patients = serverState.patients;
  $("suPatientsCount").textContent = `${patients.length} paciente${patients.length === 1 ? "" : "s"}`;
  if (!patients.length) {
    body.innerHTML = `<div class="su-empty-row">No se pudieron cargar pacientes o todavía no existen registros.</div>`;
    return;
  }
  body.innerHTML = patients.map(patient => `<div class="su-table-row" data-search-row="${escapeHtml(`${fullName(patient)} ${patient.codigo || ""} ${patient.doctor_nombre || ""} ${patient.doctor_apellidos || ""}`.toLowerCase())}">
    <div class="su-table-person"><span class="su-person-avatar">${escapeHtml(initials(patient.nombre,patient.apellidos))}</span><div><b>${escapeHtml(fullName(patient))}</b><small>${escapeHtml(patient.codigo || `ID ${patient.id}`)}</small></div></div>
    <span class="su-table-cell">${escapeHtml(doctorName({ nombre:patient.doctor_nombre, apellidos:patient.doctor_apellidos, genero:patient.doctor_genero }))}</span>
    <span><i class="su-status-pill ${patient.estado_registro === "activo" ? "success" : "neutral"}">${escapeHtml(patient.estado_clinico || patient.estado_registro || "Sin estado")}</i></span>
    <span class="su-table-cell">${escapeHtml(formatDate(patient.fecha_ingreso))}</span>
    <span class="su-table-actions"><button class="su-mini-button" type="button" data-reassign-patient="${patient.id}">Cambiar médico</button></span>
  </div>`).join("");
}

function filterUserTables() {
  const term = String($("suUserSearch")?.value || "").trim().toLowerCase();
  qa("[data-search-row]").forEach(row => {
    const belongs = currentUsersTab === "doctors" ? row.closest("[data-users-panel='doctors']") : row.closest("[data-users-panel='patients']");
    if (!belongs) return;
    row.style.display = !term || row.dataset.searchRow.includes(term) ? "grid" : "none";
  });
}

function renderEquipmentList() {
  const host = $("suEquipmentList");
  if (!host) return;
  host.innerHTML = workspace.equipments.map(equipment => {
    const [label, cls] = statusPresentation(equipment.status);
    const selected = equipment.id === workspace.selectedEquipment;
    const online = isPrimaryEquipment(workspace, equipment) && (!!serverState.telemetry?.esp32_connected || !!serverState.overview?.equipment?.espOnline);
    return `<article class="su-equipment-card ${selected ? "selected" : ""}">
      <div class="su-device-illustration"><span class="su-device-light"></span><span class="su-device-arm"></span><span class="su-device-base"></span></div>
      <div class="su-equipment-card-main">
        <h3>${escapeHtml(equipment.name)} <span class="su-status-pill ${cls}">${label}</span></h3>
        <p>${escapeHtml(equipment.description)}</p>
        <div class="su-equipment-detail-grid"><span><small>Ubicación</small><b>${escapeHtml(equipment.location || "Sin definir")}</b></span><span><small>Horas de uso</small><b>${Number(equipment.hours || 0).toLocaleString("es-BO",{maximumFractionDigits:1})} h</b></span><span><small>Sesiones</small><b>${Number(equipment.sessions || 0)}</b></span><span><small>Última prueba</small><b>${equipment.lastTest ? escapeHtml(formatDate(equipment.lastTest)) : "No realizada"}</b></span></div>
        <div class="su-equipment-health"><div class="su-health-item"><span>${icon("ruler")}</span><b>Sensores</b><small>${isPrimaryEquipment(workspace, equipment) ? (online ? "En línea" : "Sin datos") : "No verificados"}</small></div><div class="su-health-item"><span>${icon("activity")}</span><b>Actuadores</b><small>${isPrimaryEquipment(workspace, equipment) ? "Configurados" : "Pendientes"}</small></div><div class="su-health-item"><span>${icon("sun")}</span><b>Matriz LED</b><small>${isPrimaryEquipment(workspace, equipment) ? "Disponible" : "Pendiente"}</small></div><div class="su-health-item"><span>${icon("camera")}</span><b>Cámara</b><small>${isPrimaryEquipment(workspace, equipment) ? "Configurable" : "Pendiente"}</small></div></div>
      </div>
      <div class="su-equipment-card-actions"><button class="su-button primary" type="button" data-select-equipment="${equipment.id}" data-open-diagnostic>Inspeccionar equipo</button><button class="su-button ghost" type="button" data-equipment-details="${equipment.id}">Ver detalles</button></div>
    </article>`;
  }).join("");
  hydrateIcons(host);
}

function sensorDefinitions() {
  const t = serverState.telemetry || {};
  const online = !!t.esp32_connected;
  const num = value => (value == null || value === "" ? NaN : Number(value));
  const reading = (value, digits, unit) => Number.isFinite(num(value)) ? `${num(value).toFixed(digits)} ${unit}` : "Sin lectura";
  return [
    { name:"Distancia", icon:"ruler", value:t.ultraFail ? "Sin eco" : reading(t.cm ?? t.distance_cm, 0, "cm"), ok:online && !t.ultraFail && Number.isFinite(num(t.cm ?? t.distance_cm)), meta:"Ultrasonido HC-SR04" },
    { name:"Temp. ambiente", icon:"thermometer", value:reading(t.temp_ambiente, 1, "°C"), ok:online && Number.isFinite(num(t.temp_ambiente)), meta:"Termistor NTC" },
    { name:"Luz medida", icon:"sun", value:reading(t.pct ?? t.illumination_pct, 0, "%"), ok:online && Number.isFinite(num(t.pct ?? t.illumination_pct)), meta:"Promedio de los dos LDR" },
    { name:"Intensidad LED", icon:"activity", value:reading(t.pwm, 0, "%"), ok:online && Number.isFinite(num(t.pwm)), meta:"Salida PWM a la matriz" },
    { name:"Actuadores", icon:"activity", value:t.slave === true ? "Conectados" : t.slave === false ? "Sin respuesta" : "Sin lectura", ok:online && t.slave === true, meta:"ESP32 esclavo" },
    { name:"Control manual", icon:"ruler", value:!online ? "Sin lectura" : t.manual ? "Activo (clave ingresada)" : "Bloqueado", ok:online, meta:"Clave física en el equipo" },
  ];
}

function renderSensors() {
  const host = $("suSensorGrid");
  if (!host) return;
  const available = isPrimaryEquipment(workspace, selectedEquipment());
  const defs = sensorDefinitions().map(sensor => available ? sensor : { ...sensor, value:"No verificado", ok:false });
  host.innerHTML = defs.map(sensor => `<article class="su-sensor-card ${sensor.ok ? "" : "error"}"><div class="su-sensor-card-head"><span class="su-sensor-icon">${icon(sensor.icon)}</span><span class="su-sensor-state"><i></i>${sensor.ok ? "Detectado" : "Sin dato"}</span></div><h3>${escapeHtml(sensor.name)}</h3><strong class="su-sensor-value">${escapeHtml(sensor.value)}</strong><div class="su-sensor-meta"><span>${escapeHtml(sensor.meta)}</span><span>${sensor.ok ? "Correcto" : "Pendiente"}</span></div></article>`).join("");
  $("suLedAverage").textContent = defs.find(item => item.name === "Luz medida")?.value || "—";
  $("suLedPwm").textContent = defs.find(item => item.name === "Intensidad LED")?.value || "—";
  const temp = defs.find(item => item.name === "Temp. ambiente");
  $("suLedTemp").textContent = temp?.value || "—";
}

function renderMaintenance() {
  const equipment = selectedEquipment();
  const list = $("suMaintenanceChecklist");
  if (!list || !equipment) return;
  const items = maintenanceItems[maintenanceMode] || maintenanceItems.preventive;
  $("suMaintenanceChecklistTitle").textContent = maintenanceMode === "preventive" ? "Revisión preventiva" : "Revisión correctiva";
  $("suMaintenanceType").value = maintenanceMode === "preventive" ? "preventivo" : "correctivo";
  list.innerHTML = items.map(([title, detail], index) => `<label class="su-check-option"><input type="checkbox" data-maintenance-check="${index}"><span class="su-check-box">${icon("check")}</span><p><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></p></label>`).join("");
  updateMaintenanceProgress();
  renderMaintenanceHistory();
}

function updateMaintenanceProgress() {
  const checks = qa("[data-maintenance-check]");
  const done = checks.filter(input => input.checked).length;
  $("suMaintenanceProgress").textContent = `${done}/${checks.length}`;
}

function renderMaintenanceHistory() {
  const host = $("suMaintenanceHistory");
  if (!host) return;
  const records = workspace.maintenance.filter(entry => entry.equipmentId === workspace.selectedEquipment).slice(0,5);
  if (!records.length) {
    host.innerHTML = `<div class="su-empty-row">No hay mantenimientos registrados para este equipo.</div>`;
    return;
  }
  host.innerHTML = records.map(entry => {
    const failed = entry.result === "no_aprobado";
    return `<div class="su-list-item"><span class="su-list-item-icon ${failed ? "danger" : "ok"}">${icon(failed ? "alert" : "wrench")}</span><div class="su-list-item-copy"><b>${escapeHtml(entry.typeLabel || entry.type)}</b><span>${escapeHtml(entry.responsible || "Sin responsable")} · ${escapeHtml(entry.resultLabel || entry.result)}</span></div><time>${escapeHtml(formatDateTime(entry.createdAt))}</time></div>`;
  }).join("");
}

function disableUnsafeControls() {
  const isPrimary = isPrimaryEquipment(workspace, selectedEquipment());
  qa("[data-move]").forEach(button => button.disabled = !(testMode && isPrimary));
  qa("[data-led]").forEach(button => button.disabled = !(testMode && isPrimary));
  $("suAutomaticLedTest").disabled = !(testMode && isPrimary);
  const status = $("suActuatorStatus");
  if (status) {
    status.textContent = testMode && isPrimary ? "Modo de prueba" : "Bloqueados";
    status.className = `su-status-pill ${testMode && isPrimary ? "success" : "neutral"}`;
  }
}

function toggleTestMode() {
  const equipment = selectedEquipment();
  if (!isPrimaryEquipment(workspace, equipment)) {
    showToast("Este equipo está sin verificar. Selecciona NEOLIGHT-01 para habilitar controles.", "warn");
    return;
  }
  testMode = !testMode;
  const button = $("suTestModeBtn");
  button.classList.toggle("active", testMode);
  button.querySelector("span").innerHTML = icon(testMode ? "unlock" : "lock");
  button.querySelector("b").textContent = testMode ? "Desactivar modo de prueba" : "Activar modo de prueba";
  button.querySelector("small").textContent = testMode ? "Controles habilitados" : "Controles bloqueados";
  if (!testMode) socketEmitMove("stop");
  disableUnsafeControls();
  showToast(testMode ? "Modo de prueba habilitado para NEOLIGHT-01." : "Controles técnicos bloqueados.", testMode ? "success" : "warn");
}

function openModal({ kicker="Administración", title="Detalle", body="", actions=[] }) {
  $("suModalKicker").textContent = kicker;
  $("suModalTitle").textContent = title;
  $("suModalBody").innerHTML = body;
  const actionHost = $("suModalActions");
  actionHost.innerHTML = "";
  actions.forEach(action => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `su-button ${action.className || "ghost"}`;
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    actionHost.appendChild(button);
  });
  hydrateIcons($("suModal"));
  $("suModal").classList.add("open");
  $("suModal").setAttribute("aria-hidden", "false");
}

function closeModal() {
  $("suModal")?.classList.remove("open");
  $("suModal")?.setAttribute("aria-hidden", "true");
}

function openNewDoctorModal() {
  openModal({
    kicker:"Usuarios",
    title:"Registrar nuevo doctor",
    body:`<p class="su-modal-copy">La cuenta se registrará en la base existente. El superusuario podrá desactivarla más adelante sin borrar su historial.</p><div class="su-form su-modal-grid"><label><span>Nombre(s)</span><input id="suDocFirstName"></label><label><span>Apellidos</span><input id="suDocLastName"></label><label><span>Género</span><select id="suDocGender"><option value="no_especificado">No especificado</option><option value="femenino">Femenino</option><option value="masculino">Masculino</option><option value="otro">Otro</option></select></label><label><span>Especialidad</span><input id="suDocSpecialty" value="Neonatología"></label><label><span>Matrícula</span><input id="suDocLicense"></label><label><span>Teléfono</span><input id="suDocPhone"></label><label><span>Correo</span><input id="suDocEmail" type="email"></label><label><span>Usuario</span><input id="suDocUsername"></label><label><span>Contraseña</span><input id="suDocPassword" type="password" minlength="5"></label></div>`,
    actions:[
      { label:"Cancelar", onClick:closeModal },
      { label:"Registrar doctor", className:"primary", onClick:submitNewDoctor },
    ],
  });
}

async function submitNewDoctor() {
  const payload = {
    nombre:$("suDocFirstName")?.value.trim(), apellidos:$("suDocLastName")?.value.trim(),
    genero:$("suDocGender")?.value, especialidad:$("suDocSpecialty")?.value.trim(),
    matricula:$("suDocLicense")?.value.trim(), telefono:$("suDocPhone")?.value.trim(),
    correo:$("suDocEmail")?.value.trim(), usuario:$("suDocUsername")?.value.trim(),
    contrasena:$("suDocPassword")?.value,
  };
  if (Object.values(payload).some(value => !String(value || "").trim())) {
    showToast("Completa todos los datos del doctor.", "warn");
    return;
  }
  const result = await registerDoctor(payload);
  if (!result.ok) {
    showToast(result.data?.message || "No se pudo registrar el doctor.", "error");
    return;
  }
  closeModal();
  showToast("Doctor registrado correctamente.");
  await loadUsers();
}

function openReassignModal(patientId) {
  const patient = serverState.patients.find(item => Number(item.id) === Number(patientId));
  const activeDoctors = serverState.doctors.filter(item => item.estado === "activo" && Number(item.id) !== Number(patient?.doctor_id));
  if (!patient) return;
  if (!activeDoctors.length) { showToast("No hay otro doctor activo disponible para la reasignación.", "warn"); return; }
  openModal({
    kicker:"Asignación clínica",
    title:`Reasignar a ${fullName(patient)}`,
    body:`<p class="su-modal-copy">Médico actual: <strong>${escapeHtml(doctorName({nombre:patient.doctor_nombre,apellidos:patient.doctor_apellidos,genero:patient.doctor_genero}))}</strong>. El cambio conservará los registros previos.</p><div class="su-form"><label><span>Nuevo médico</span><select id="suReassignDoctor">${activeDoctors.map(doctor => `<option value="${doctor.id}">${escapeHtml(doctorName(doctor))} · ${escapeHtml(doctor.especialidad || "Sin especialidad")}</option>`).join("")}</select></label><label><span>Motivo</span><textarea id="suReassignReason" rows="4" placeholder="Ej.: finalización de contrato, cambio de turno o redistribución de pacientes."></textarea></label></div>`,
    actions:[
      { label:"Cancelar", onClick:closeModal },
      { label:"Confirmar reasignación", className:"primary", onClick:async() => {
        const doctorId = Number($("suReassignDoctor")?.value);
        const target = serverState.doctors.find(item => Number(item.id) === doctorId);
        const result = await reassignPatient(patient.id, doctorId, $("suReassignReason")?.value.trim());
        if (!result.ok) { showToast(result.data?.message || "No se pudo reasignar al paciente.", "error"); return; }
        addAssignment(workspace, { patientId:patient.id, patientName:fullName(patient), previousDoctorName:doctorName({nombre:patient.doctor_nombre,apellidos:patient.doctor_apellidos,genero:patient.doctor_genero}), doctorId, doctorName:doctorName(target), reason:$("suReassignReason")?.value.trim() });
        closeModal(); showToast("Paciente reasignado correctamente."); await loadUsers(); renderAssignments(); renderAlerts();
      }},
    ],
  });
}

function openDoctorDetails(doctorId) {
  const doctor = serverState.doctors.find(item => Number(item.id) === Number(doctorId));
  if (!doctor) return;
  openModal({ kicker:"Personal médico", title:doctorName(doctor), body:`<div class="su-form su-modal-grid"><label><span>Estado</span><input value="${escapeHtml(doctor.estado || "—")}" disabled></label><label><span>Especialidad</span><input value="${escapeHtml(doctor.especialidad || "—")}" disabled></label><label><span>Matrícula</span><input value="${escapeHtml(doctor.matricula || "—")}" disabled></label><label><span>Pacientes activos</span><input value="${Number(doctor.patient_count || 0)}" disabled></label><label><span>Correo</span><input value="${escapeHtml(doctor.correo || "—")}" disabled></label><label><span>Teléfono</span><input value="${escapeHtml(doctor.telefono || "—")}" disabled></label></div>`, actions:[{label:"Cerrar",onClick:closeModal}] });
}

function openDoctorStatusModal(doctorId) {
  const doctor = serverState.doctors.find(item => Number(item.id) === Number(doctorId));
  if (!doctor) return;
  const activating = doctor.estado !== "activo";
  const alternatives = serverState.doctors.filter(item => item.estado === "activo" && Number(item.id) !== Number(doctor.id));
  const patientCount = Number(doctor.patient_count || 0);
  openModal({
    kicker:"Gestión de cuenta",
    title:activating ? `Reactivar a ${doctorName(doctor)}` : `Desactivar a ${doctorName(doctor)}`,
    body:activating
      ? `<p class="su-modal-copy">La cuenta recuperará acceso al panel médico. Sus registros anteriores se conservan.</p>`
      : `<p class="su-modal-copy">La cuenta quedará inactiva, pero no se eliminará ningún antecedente.</p>${patientCount ? `<div class="su-inline-notice">Este doctor tiene ${patientCount} paciente(s) activo(s). Debes elegir un médico receptor antes de desactivarlo.</div><div class="su-form" style="margin-top:12px"><label><span>Reasignar pacientes a</span><select id="suDoctorReplacement"><option value="">Selecciona un doctor</option>${alternatives.map(item => `<option value="${item.id}">${escapeHtml(doctorName(item))}</option>`).join("")}</select></label></div>` : ""}`,
    actions:[
      { label:"Cancelar", onClick:closeModal },
      { label:activating ? "Reactivar cuenta" : "Desactivar cuenta", className:activating ? "primary" : "ghost", onClick:async() => {
        const replacement = patientCount ? Number($("suDoctorReplacement")?.value) || null : null;
        if (!activating && patientCount && !replacement) { showToast("Selecciona el doctor que recibirá los pacientes.", "warn"); return; }
        const result = await updateDoctorStatus(doctor.id, activating ? "activo" : "inactivo", replacement);
        if (!result.ok) { showToast(result.data?.message || "No se pudo actualizar la cuenta.", "error"); return; }
        closeModal(); showToast(activating ? "Cuenta reactivada." : "Cuenta desactivada y pacientes reasignados."); await loadUsers();
      }},
    ],
  });
}

function openEquipmentDetails(id) {
  const equipment = getEquipment(workspace,id);
  if (!equipment) return;
  const [label] = statusPresentation(equipment.status);
  openModal({ kicker:"Ficha técnica", title:equipment.name, body:`<div class="su-form su-modal-grid"><label><span>Estado</span><input value="${escapeHtml(label)}" disabled></label><label><span>Ubicación</span><input value="${escapeHtml(equipment.location || "—")}" disabled></label><label><span>Sesiones</span><input value="${Number(equipment.sessions || 0)}" disabled></label><label><span>Horas acumuladas</span><input value="${Number(equipment.hours || 0).toFixed(1)} h" disabled></label></div><p class="su-modal-copy" style="margin-top:14px">${escapeHtml(equipment.notes || equipment.description)}</p>`, actions:[{label:"Cerrar",onClick:closeModal},{label:"Abrir diagnóstico",className:"primary",onClick:()=>{closeModal();setSelectedEquipment(equipment.id);setSection("diagnostico");}}] });
}

function openHistoryModal() {
  const usage = serverState.overview?.usageDays || [];
  const equipment = selectedEquipment();
  const rows = usage.slice().reverse().slice(0,20);
  openModal({ kicker:"Historial de uso", title:equipment.name, body:rows.length ? `<div class="su-list">${rows.map(row => `<div class="su-list-item"><span class="su-list-item-icon info">${icon("calendar")}</span><div class="su-list-item-copy"><b>${escapeHtml(formatDate(row.day))}</b><span>${Number(row.sessions || 0)} sesión(es)</span></div><time>${escapeHtml(formatHours(row.duration_s))}</time></div>`).join("")}</div>` : `<div class="su-empty-row">Todavía no hay sesiones registradas.</div>`, actions:[{label:"Cerrar",onClick:closeModal}] });
}

async function testSensors() {
  const button = $("suTestAllSensors");
  button.disabled = true; button.textContent = "Comprobando...";
  const result = await fetchTelemetry();
  button.disabled = false; button.innerHTML = `${icon("play")}Iniciar prueba`;
  if (!result.ok || !result.data?.espOnline) {
    addDiagnosticTest(workspace,{equipmentId:workspace.selectedEquipment,type:"sensores",result:"sin_respuesta"});
    showToast("No se recibieron lecturas del equipo.", "warn");
    return;
  }
  serverState.telemetry = normalizeTelemetry(result.data);
  renderSensors(); updateSelectedEquipmentUI();
  const values = sensorDefinitions();
  const passed = values.filter(item => item.ok).length;
  addDiagnosticTest(workspace,{equipmentId:workspace.selectedEquipment,type:"sensores",result:passed === values.length ? "aprobado" : "observacion",passed,total:values.length});
  updateEquipment(workspace,workspace.selectedEquipment,{lastTest:new Date().toISOString()});
  showToast(`Prueba completada: ${passed} de ${values.length} lecturas disponibles.`, passed >= 3 ? "success" : "warn");
}

function runMovement(direction) {
  if (!testMode) { showToast("Activa primero el modo de prueba.", "warn"); return; }
  const sent = socketEmitMove(direction);
  if (!sent) { showToast("Sin conexión con el servidor; no se envió el movimiento.", "error"); return; }
  addDiagnosticTest(workspace,{equipmentId:workspace.selectedEquipment,type:"actuador",direction,result:"comando_enviado"});
  showToast(direction === "stop" ? "Orden de detener enviada." : `Orden ${direction} enviada. Si el equipo la rechaza, verás el motivo.`);
}

// La lámpara tiene tres niveles reales: reposo (0 %), convencional (80 %) e intensivo (100 %).
function setLedLevel(level) {
  if (!testMode) { showToast("Activa primero el modo de prueba.", "warn"); return; }
  const mode = level === 0 ? "reposo" : level === 80 ? "convencional" : "intensivo";
  qa("[data-led]").forEach(button => button.classList.toggle("active", Number(button.dataset.led) === level));
  $("suLedRays").classList.toggle("active", level > 0);
  $("suLedRays").style.opacity = String(Math.max(.08,level/100));
  $("suLedStatus").textContent = level ? `${level} % · modo ${mode}` : "En reposo";
  $("suLedStatus").className = `su-status-pill ${level ? "success" : "neutral"}`;
  if (!socketEmitMode(mode)) { showToast("Sin conexión con el servidor; no se envió el modo.", "error"); return; }
  addDiagnosticTest(workspace,{equipmentId:workspace.selectedEquipment,type:"matriz_led",level,mode,result:"comando_enviado"});
}

async function automaticLedTest() {
  if (!testMode) { showToast("Activa primero el modo de prueba.", "warn"); return; }
  const button = $("suAutomaticLedTest");
  button.disabled = true;
  for (const level of [80,100,0]) {
    setLedLevel(level);
    await new Promise(resolve => setTimeout(resolve,4000));     // tiempo para que la lámpara cambie y se vea
  }
  button.disabled = false;
  updateEquipment(workspace,workspace.selectedEquipment,{lastTest:new Date().toISOString()});
  showToast("Secuencia terminada: convencional, intensivo y reposo.", "success");
}

async function startCamera() {
  const img = $("suCameraPreview");
  if (!cameraUrl) {
    const config = await loadClientConfig();
    cameraUrl = config?.camStreamUrl || "";
  }
  if (!cameraUrl) { showToast("No existe una URL de cámara configurada.", "warn"); return; }
  $("suCameraStatus").textContent = "Conectando";
  img.onload = () => { img.classList.add("active"); $("suCameraPlaceholder").style.display="none"; $("suCameraStatus").textContent="Activa"; $("suCameraStatus").className="su-status-pill success"; };
  img.onerror = () => { img.classList.remove("active"); $("suCameraPlaceholder").style.display="block"; $("suCameraStatus").textContent="Sin respuesta"; $("suCameraStatus").className="su-status-pill warning"; showToast("La cámara no respondió.","warn"); };
  img.src = `${cameraUrl}${cameraUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function stopCamera() {
  const img = $("suCameraPreview");
  img.src = ""; img.classList.remove("active");
  $("suCameraPlaceholder").style.display = "block";
  $("suCameraStatus").textContent = "Detenida";
  $("suCameraStatus").className = "su-status-pill neutral";
}

function handleOutputTest(kind) {
  if (!testMode) { showToast("Activa el modo de prueba antes de controlar salidas.", "warn"); return; }
  if (kind !== "buzzer") return;
  const socket = getSocket();
  if (!socket?.connected) { showToast("Sin conexión con el servidor.", "error"); return; }
  socket.emit("lamp:beep");
  addDiagnosticTest(workspace,{equipmentId:workspace.selectedEquipment,type:"buzzer",result:"comando_enviado"});
  showToast("Orden enviada: el buzzer de la lámpara debe sonar.");
}

function submitMaintenance(event) {
  event.preventDefault();
  const checks = qa("[data-maintenance-check]");
  const checked = checks.filter(item => item.checked).length;
  if (!checked) { showToast("Marca al menos un punto revisado.", "warn"); return; }
  const type = $("suMaintenanceType").value;
  const result = $("suMaintenanceResult").value;
  const responsible = $("suMaintenanceResponsible").value.trim();
  if (!responsible) { showToast("Indica quién realizó el mantenimiento.", "warn"); return; }
  const typeLabels = {preventivo:"Mantenimiento preventivo",correctivo:"Mantenimiento correctivo",inspeccion:"Inspección general"};
  const resultLabels = {aprobado:"Aprobado",observacion:"Aprobado con observaciones",no_aprobado:"No aprobado"};
  addMaintenance(workspace,{equipmentId:workspace.selectedEquipment,type,typeLabel:typeLabels[type],result,resultLabel:resultLabels[result],responsible,notes:$("suMaintenanceNotes").value.trim(),checked,total:checks.length});
  if (result === "no_aprobado") updateEquipment(workspace,workspace.selectedEquipment,{status:"advertencia",lastTest:new Date().toISOString()});
  else updateEquipment(workspace,workspace.selectedEquipment,{lastTest:new Date().toISOString()});
  event.currentTarget.reset();
  renderMaintenance(); renderCalendar(); renderEquipmentList(); updateSelectedEquipmentUI();
  showToast("Mantenimiento guardado.");
}

function openRegisterEquipmentModal() {
  openModal({
    kicker:"Inventario", title:"Registrar equipo",
    body:`<p class="su-modal-copy">El equipo queda guardado en el sistema, pendiente de verificación.</p><div class="su-form"><label><span>Código del equipo</span><input id="suEquipmentCode" placeholder="NEOLIGHT-02"></label><label><span>Ubicación</span><input id="suEquipmentLocation" placeholder="Laboratorio de pruebas"></label><label><span>Observaciones</span><textarea id="suEquipmentNotes" rows="4"></textarea></label></div>`,
    actions:[
      { label:"Cancelar", onClick:closeModal },
      { label:"Registrar equipo", className:"primary", onClick:async () => {
        const name = $("suEquipmentCode")?.value.trim().toUpperCase();
        if (!name) { showToast("Ingresa un código de equipo.", "warn"); return; }
        const result = await createEquipment(workspace, {
          name, status:"sin_verificar", description:"Equipo pendiente de verificación.",
          location:$("suEquipmentLocation")?.value.trim() || "", notes:$("suEquipmentNotes")?.value.trim() || "",
        });
        if (!result.ok) { showToast(result.data?.message || "No se pudo registrar el equipo.", "error"); return; }
        closeModal(); setupEquipmentSelector(); renderEquipmentList(); updateSelectedEquipmentUI();
        showToast("Equipo registrado.");
      } },
    ],
  });
}

function bindEvents() {
  qa("[data-su-section]").forEach(button => button.addEventListener("click", () => setSection(button.dataset.suSection)));
  qa("[data-go-section]").forEach(button => button.addEventListener("click", () => setSection(button.dataset.goSection)));
  $("suMobileMenu")?.addEventListener("click", () => $("suSidebar")?.classList.toggle("open"));
  $("suGlobalEquipment")?.addEventListener("change", event => setSelectedEquipment(event.target.value));
  qa("[data-users-tab]").forEach(button => button.addEventListener("click", () => setUsersTab(button.dataset.usersTab)));
  qa("[data-diagnostic-tab]").forEach(button => button.addEventListener("click", () => setDiagnosticTab(button.dataset.diagnosticTab)));
  qa("[data-maintenance-tab]").forEach(button => button.addEventListener("click", () => { maintenanceMode=button.dataset.maintenanceTab; qa("[data-maintenance-tab]").forEach(item=>item.classList.toggle("active",item===button)); renderMaintenance(); }));
  $("suUserSearch")?.addEventListener("input", filterUserTables);
  $("suNewDoctorBtn")?.addEventListener("click", openNewDoctorModal);
  $("suRegisterEquipmentBtn")?.addEventListener("click", openRegisterEquipmentModal);
  $("suTestModeBtn")?.addEventListener("click", toggleTestMode);
  $("suTestAllSensors")?.addEventListener("click", testSensors);
  $("suAutomaticLedTest")?.addEventListener("click", automaticLedTest);
  $("suTestCamera")?.addEventListener("click", startCamera);
  $("suStopCamera")?.addEventListener("click", stopCamera);
  $("suMaintenanceForm")?.addEventListener("submit", submitMaintenance);
  $("suCompleteChecklist")?.addEventListener("click", () => { qa("[data-maintenance-check]").forEach(input=>input.checked=true); updateMaintenanceProgress(); });
  $("suMaintenanceChecklist")?.addEventListener("change", updateMaintenanceProgress);
  $("suExpandHistory")?.addEventListener("click", openHistoryModal);
  $("suFullMaintenanceHistory")?.addEventListener("click", () => openModal({kicker:"Mantenimiento",title:"Historial completo",body:workspace.maintenance.length?`<div class="su-list">${workspace.maintenance.map(entry=>`<div class="su-list-item"><span class="su-list-item-icon ok">${icon("wrench")}</span><div class="su-list-item-copy"><b>${escapeHtml(entry.typeLabel||entry.type)}</b><span>${escapeHtml(getEquipment(workspace,entry.equipmentId)?.name||entry.equipmentId)} · ${escapeHtml(entry.responsible||"")}</span></div><time>${escapeHtml(formatDateTime(entry.createdAt))}</time></div>`).join("")}</div>`:`<div class="su-empty-row">No hay registros todavía.</div>`,actions:[{label:"Cerrar",onClick:closeModal}]}));

  $("suNotificationsBtn")?.addEventListener("click", openNotifications);
  $("suLogoutBtn")?.addEventListener("click", () => $("logoutBtn")?.click());
  $("suViewAllAlerts")?.addEventListener("click", openNotifications);
  $("suCloseNotifications")?.addEventListener("click", closeNotifications);
  $("suDrawerBackdrop")?.addEventListener("click", closeNotifications);
  qa("[data-alert-filter]").forEach(button => button.addEventListener("click", () => filterNotifications(button)));
  qa("[data-close-su-modal]").forEach(button => button.addEventListener("click", closeModal));
  window.addEventListener("keydown", event => { if (event.key === "Escape") { closeModal(); closeNotifications(); } });

  $("superuserApp")?.addEventListener("click", event => {
    const reassign = event.target.closest("[data-reassign-patient]"); if (reassign) return openReassignModal(reassign.dataset.reassignPatient);
    const editDoctor = event.target.closest("[data-edit-doctor]"); if (editDoctor) return openDoctorDetails(editDoctor.dataset.editDoctor);
    const toggleDoctor = event.target.closest("[data-toggle-doctor]"); if (toggleDoctor) return openDoctorStatusModal(toggleDoctor.dataset.toggleDoctor);
    const selectEquipmentButton = event.target.closest("[data-select-equipment]"); if (selectEquipmentButton) { setSelectedEquipment(selectEquipmentButton.dataset.selectEquipment); if (selectEquipmentButton.hasAttribute("data-open-diagnostic")) setSection("diagnostico"); return; }
    const details = event.target.closest("[data-equipment-details]"); if (details) return openEquipmentDetails(details.dataset.equipmentDetails);
    const movement = event.target.closest("[data-move]"); if (movement) return runMovement(movement.dataset.move);
    const led = event.target.closest("[data-led]"); if (led) return setLedLevel(Number(led.dataset.led));
    const output = event.target.closest("[data-output-test]"); if (output) return handleOutputTest(output.dataset.outputTest);
    const calendar = event.target.closest("[data-calendar-day]"); if (calendar) showToast(`${calendar.dataset.calendarDay}: ${calendar.title}`, "success");
  });

  window.addEventListener("neolight:telemetry", event => {
    // En vivo llegan las lecturas visibles; las de reposo (diagnóstico) vienen de la consulta periódica.
    const live = Object.fromEntries(Object.entries(event.detail || {}).filter(([, value]) => value != null));
    serverState.telemetry = { ...(serverState.telemetry || {}), ...live };
    renderSensors(); updateSelectedEquipmentUI(); updateSyncStatus();
  });
  window.addEventListener("neolight:esp32-status", event => {
    serverState.telemetry = { ...(serverState.telemetry || {}), esp32_connected:!!event.detail?.connected || !!event.detail?.open };
    updateSelectedEquipmentUI(); updateSyncStatus();
  });
}

function openNotifications() {
  $("suNotificationDrawer")?.classList.add("open");
  $("suNotificationDrawer")?.setAttribute("aria-hidden","false");
  $("suDrawerBackdrop")?.classList.add("open");
}
function closeNotifications() {
  $("suNotificationDrawer")?.classList.remove("open");
  $("suNotificationDrawer")?.setAttribute("aria-hidden","true");
  $("suDrawerBackdrop")?.classList.remove("open");
}
function filterNotifications(button) {
  qa("[data-alert-filter]").forEach(item => item.classList.toggle("active", item === button));
  const filter = button.dataset.alertFilter;
  qa("#suNotificationList [data-alert-kind]").forEach(item => item.style.display = filter === "all" || item.dataset.alertKind === filter ? "flex" : "none");
}

function updateSyncStatus() {
  const host = $("suSyncStatus");
  if (!host) return;
  const backend = serverState.health?.ok;
  const equipmentOnline = !!serverState.telemetry?.esp32_connected;
  host.classList.remove("online","offline");
  if (backend && equipmentOnline) { host.classList.add("online"); host.querySelector("span").textContent="Servidor y equipo sincronizados"; }
  else if (backend) { host.querySelector("span").textContent="Servidor activo · equipo sin conexión"; }
  else { host.classList.add("offline"); host.querySelector("span").textContent="Servidor sin respuesta"; }
  const slave = serverState.telemetry?.slave;
  $("suSlaveConnection").textContent = !equipmentOnline ? "Lámpara sin conexión" : slave === true ? "Esclavo conectado" : slave === false ? "Esclavo sin respuesta" : "Sin datos";
}

async function loadUsers() {
  const result = await fetchSuperuserUsers();
  if (result.ok) {
    serverState.doctors = Array.isArray(result.data.doctors) ? result.data.doctors : [];
    serverState.patients = Array.isArray(result.data.patients) ? result.data.patients : [];
  } else {
    serverState.doctors = [];
    serverState.patients = [];
  }
  renderDoctors(); renderPatients();
}

async function refreshTelemetry() {
  const [telemetryResult, healthResult] = await Promise.all([fetchTelemetry(),fetchHealth()]);
  if (telemetryResult.ok) serverState.telemetry = normalizeTelemetry(telemetryResult.data);
  serverState.health = healthResult.data || {ok:false};
  renderSensors(); updateSelectedEquipmentUI(); updateSyncStatus();
}

async function loadRemoteData() {
  const [overviewResult] = await Promise.all([fetchSuperuserOverview(),loadUsers(),refreshTelemetry(),hydrateWorkspace(workspace)]);
  setupEquipmentSelector();
  if (overviewResult.ok) serverState.overview = overviewResult.data;
  else showToast("No se pudieron cargar los datos administrativos.", "warn");
  renderOverview(); renderEquipmentList(); renderMaintenance();
}

function applySessionUser(data) {
  const user = data?.superuser || {};
  state.currentUserId = user.id || null;
  state.currentSuperuserId = user.id || null;
  const name = fullName(user);
  $("suUserName").textContent = name;
  $("suAvatar").textContent = initials(user.nombre,user.apellidos);
  $("suMaintenanceResponsible").value = name === "Sin nombre" ? "" : name;
}

function setupEquipmentSelector() {
  const select = $("suGlobalEquipment");
  select.innerHTML = workspace.equipments.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  select.value = workspace.selectedEquipment;
}

export async function initSuperuserDashboard(data) {
  sessionSnapshot = data;
  await ensureTemplate();
  applySessionUser(data);
  if (!initialized) {
    initialized = true;
    setupEquipmentSelector();
    bindEvents();
    setSection("inicio"); setUsersTab("doctors"); setDiagnosticTab("sensors");
  }
  workspace = loadWorkspace();
  setupEquipmentSelector();
  updateSelectedEquipmentUI(); renderEquipmentList(); renderMaintenance(); renderSensors(); disableUnsafeControls();
  await loadRemoteData();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshTelemetry,5000);
}
