import { $, state, escapeHtml, escapeAttr, normalizeMode, formatDoctorDisplayName, humanLabel } from "./config.js";
import {
  fetchRequests, decideRequest, fetchModeRequests, decideModeRequest,
  fetchPatients, fetchAlertsToday, searchPatients, fetchPatientDetail,
  updatePatient, updatePatientClinical, createPlan, updatePlan, cancelPlan,
  doctorSetMode, updateControl, fetchSessions, fetchAlarms, fetchEvents, exportExcel,
  dischargePatient, archivePatient,
} from "./api.js";
import { playNotificationSound, showRealtimeToast } from "./socket.js";
import { renderDoctorCharts, renderDoctorAlerts } from "./doctor-analytics.js";
import { renderDoctorPdfData, bindDoctorReportButton } from "./doctor-report.js";
import { bindDoctorSections, bindPlanCalculator } from "./doctor-navigation.js";

let doctorEventsBound = false;
let searchTimer = null;
let currentDoctor = null;
let currentDoctorReport = {
  patients: [],
  requests: [],
  modeRequests: [],
  alerts: { today: 0, recent: [], sessions: [], events: [] },
};

export function initDoctorDashboard(sessionSnapshot) {
  const { doctor } = sessionSnapshot;
  currentDoctor = doctor || null;
  state.currentRole = "doctor";
  state.doctorId = doctor?.id ?? null;
  state.currentUserId = doctor?.id ?? null;

  const hello = $("dashHelloDoctor");
  if (hello) hello.textContent = `Hola, ${formatDoctorDisplayName(doctor, "Dr(a). -")}`;
  renderDoctorProfile(doctor);

  loadDoctorDashboard();
  bindDoctorRealtimeEvents();

  if (!doctorEventsBound) {
    doctorEventsBound = true;
    $("dashSearchDoctor")?.addEventListener("input", e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(e.target.value.trim()), 300);
    });

    bindPlanCalculator();
    bindDoctorSections();
    bindDoctorReportButton(() => ({
      doctor: currentDoctor,
      patients: currentDoctorReport.patients,
      requests: [...currentDoctorReport.requests, ...currentDoctorReport.modeRequests],
      alerts: currentDoctorReport.alerts,
    }));
  }
}


let doctorRealtimeBound = false;
let doctorRealtimeRefreshTimer = null;

function scheduleDoctorRealtimeRefresh(reason = "realtime") {
  clearTimeout(doctorRealtimeRefreshTimer);
  doctorRealtimeRefreshTimer = window.setTimeout(() => {
    loadDoctorDashboard();
  }, reason === "resolved" ? 120 : 250);
}

function bindDoctorRealtimeEvents() {
  if (doctorRealtimeBound) return;
  doctorRealtimeBound = true;

  window.addEventListener("neolight:doctor-request-new", event => {
    const payload = event.detail || {};
    if (payload.doctor_id && state.doctorId && String(payload.doctor_id) !== String(state.doctorId)) return;
    playNotificationSound();
    showRealtimeToast("Nueva solicitud de ingreso", "info");
    showDoctorFeedback("Nueva solicitud recibida en tiempo real.", "ok");
    scheduleDoctorRealtimeRefresh("new");
  });

  window.addEventListener("neolight:mode-request-new", event => {
    const payload = event.detail || {};
    if (payload.doctor_id && state.doctorId && String(payload.doctor_id) !== String(state.doctorId)) return;
    playNotificationSound();
    const label = payload.request_type === "manual_control" ? "control manual" : `modo ${payload.mode || ""}`.trim();
    showRealtimeToast(`Nueva solicitud de ${label}`, "info");
    showDoctorFeedback(`Nueva solicitud de ${label}.`, "ok");
    scheduleDoctorRealtimeRefresh("new");
  });

  window.addEventListener("neolight:mode-request-resolved", () => scheduleDoctorRealtimeRefresh("resolved"));
  window.addEventListener("neolight:doctor-request-resolved", () => scheduleDoctorRealtimeRefresh("resolved"));
  window.addEventListener("neolight:session-started", () => scheduleDoctorRealtimeRefresh("session"));
  window.addEventListener("neolight:session-finished", () => scheduleDoctorRealtimeRefresh("session"));
  window.addEventListener("neolight:alarm-new", () => scheduleDoctorRealtimeRefresh("alarm"));

  window.addEventListener("neolight:telemetry", event => {
    const t = event.detail || {};
    updateLampState({
      online: t.esp32_connected !== false,
      modo: t.modo_actual || lampState.modo,
      cm: t.cm ?? t.distance_cm ?? null,
      led: t.pwm ?? t.pct ?? null,
      tamb: t.temp_ambiente ?? null,
    });
  });
  window.addEventListener("neolight:esp32-status", event => {
    const st = event.detail || {};
    updateLampState({ online: !!(st.open ?? st.connected) });
  });
}

async function loadDoctorDashboard() {
  try {
    const [resReq, resMode, resPat, resAlert] = await Promise.all([
      fetchRequests(), fetchModeRequests(), fetchPatients(), fetchAlertsToday(),
    ]);

    const requests = resReq.data?.requests || [];
    const modeRequests = resMode.data?.requests || [];
    const patients = resPat.data?.patients || [];
    const alerts = Number(resAlert.data?.count || 0);
    const alertSummary = {
      critical: Number(resAlert.data?.critical || 0),
      warning: Number(resAlert.data?.warning || 0),
      silenced: Number(resAlert.data?.silenced || 0),
    };
    const activeSessions = patients.filter(p => Number(p.sesiones_activas || 0) > 0).length;
    const clinicalActivity = await loadDoctorClinicalActivity(patients);
    const allRequests = [...requests, ...modeRequests];
    const alertData = { today: alerts, summary: alertSummary, ...clinicalActivity };

    currentDoctorReport = { patients, requests, modeRequests, alerts: alertData };

    setText("kpiPatients", patients.length);
    setText("kpiRequests", requests.length + modeRequests.length);
    setText("kpiAlerts", alerts);
    setText("kpiActiveSessions", activeSessions);

    renderRequests(requests, modeRequests);
    renderPatients(patients);
    renderDoctorMiniPatients(patients);
    renderDoctorPlansSummary(patients);
    renderDoctorAlerts(alertData.recent || []);
    renderDoctorCharts(patients, allRequests, alertData);
    renderDoctorPdfData({ doctor: currentDoctor, patients, requests: allRequests, alerts: alertData });
    renderDoctorRightRail(patients, alertData);
    renderDoctorHeroState(patients, alertData);
  } catch (_) {
    ["kpiPatients","kpiRequests","kpiAlerts","kpiActiveSessions"].forEach(id => setText(id, "—"));
    showDoctorFeedback("No se pudo cargar el panel del doctor.", "danger");
  }
}

async function loadDoctorClinicalActivity(patients = []) {
  const sample = patients.slice(0, 8).filter(p => p?.id);
  const empty = { sessions: [], alarms: [], events: [], recent: [] };
  if (!sample.length) return empty;

  const batches = await Promise.all(sample.map(async p => {
    try {
      const [sessionsRes, alarmsRes, eventsRes] = await Promise.all([
        fetchSessions(p.id),
        fetchAlarms(p.id),
        fetchEvents(p.id),
      ]);
      const patientName = `${p.nombre || ""} ${p.apellidos || ""}`.trim() || p.codigo || "Paciente";
      return {
        sessions: (sessionsRes.data?.sessions || []).map(s => ({ ...s, patientName, patientCode: p.codigo })),
        alarms: (alarmsRes.data?.alarms || []).map(a => ({ ...a, patientName, patientCode: p.codigo })),
        events: (eventsRes.data?.events || []).map(e => ({ ...e, patientName, patientCode: p.codigo })),
      };
    } catch (_) {
      return empty;
    }
  }));

  const sessions = batches.flatMap(b => b.sessions || []).sort(sortByRecent).slice(0, 16);
  const alarms = batches.flatMap(b => b.alarms || []).sort(sortByRecent).slice(0, 16);
  const events = batches.flatMap(b => b.events || []).sort(sortByRecent).slice(0, 16);
  return { sessions, alarms, events, recent: alarms };
}

function renderRequests(list, modeRequests = []) {
  const box = $("requestsList"); if (!box) return;
  if (!list?.length && !modeRequests?.length) {
    box.innerHTML = `<div class="dp-empty">Sin solicitudes pendientes · No hay altas ni cambios de modo por revisar.</div>`;
    return;
  }
  box.innerHTML = "";

  (list || []).forEach(req => {
    const name = `${req.nombre || ""} ${req.apellidos || ""}`.trim() || "Paciente";
    const tutor = `${req.tutor_nombre || ""} ${req.tutor_apellidos || ""}`.trim() || "—";
    const el = document.createElement("div");
    el.className = "dp-req-item";
    el.innerHTML = `
      <div class="dp-req-badge ingreso" title="Ingreso">BB</div>
      <div class="dp-req-body">
        <div class="dp-req-name">${escapeHtml(name)}</div>
        <div class="dp-req-sub">Ingreso · ${req.dias_nacido ?? "—"} días · Tutor: ${escapeHtml(tutor)}</div>
      </div>
      <div class="dp-req-btns">
        <button class="dp-req-accept" data-act="accept" data-id="${escapeAttr(req.id)}">Aceptar</button>
        <button class="dp-req-reject" data-act="reject" data-id="${escapeAttr(req.id)}">Rechazar</button>
      </div>`;
    box.appendChild(el);
  });

  (modeRequests || []).forEach(req => {
    const name = `${req.paciente_nombre || ""} ${req.paciente_apellidos || ""}`.trim() || "Paciente";
    const tutor = `${req.tutor_nombre || ""} ${req.tutor_apellidos || ""}`.trim() || "—";
    const rawMode = req.mode || req.modo;
    const isManualControl = rawMode === "manual_control" || req.request_type === "manual_control";
    const mode = normalizeMode(rawMode) || rawMode || "—";
    const title = isManualControl ? "Control manual" : "Cambio de modo";
    const detail = isManualControl
      ? `Solicitud de control manual - Tutor: ${escapeHtml(tutor)}${req.motivo ? ` - Motivo: ${escapeHtml(req.motivo)}` : ""}`
      : `Cambio de modo - ${escapeHtml(String(mode).toUpperCase())}`;
    const el = document.createElement("div");
    el.className = "dp-req-item";
    el.innerHTML = `
      <div class="dp-req-badge modo" title="${escapeAttr(title)}">${isManualControl ? "M" : "Modo"}</div>
      <div class="dp-req-body">
        <div class="dp-req-name">${escapeHtml(name)}</div>
        <div class="dp-req-sub">${detail}</div>
      </div>
      <div class="dp-req-btns">
        <button class="dp-req-accept" data-act="accept" data-mode-request-id="${escapeAttr(req.id)}">Aceptar</button>
        <button class="dp-req-reject" data-act="reject" data-mode-request-id="${escapeAttr(req.id)}">Rechazar</button>
      </div>`;
    box.appendChild(el);
  });

  box.querySelectorAll("button[data-id]").forEach(btn =>
    btn.addEventListener("click", () => handleDecision(btn.dataset.id, btn.dataset.act === "accept"))
  );
  box.querySelectorAll("button[data-mode-request-id]").forEach(btn =>
    btn.addEventListener("click", () => handleModeDecision(btn.dataset.modeRequestId, btn.dataset.act === "accept"))
  );
}

async function handleDecision(id, accept) {
  try {
    const { ok, data } = await decideRequest(id, accept);
    if (!ok) showDoctorFeedback(data?.message || data?.error || "No se pudo procesar la solicitud.", "danger");
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
  loadDoctorDashboard();
}

async function handleModeDecision(id, accept) {
  try {
    const { ok, data } = await decideModeRequest(id, accept);
    if (!ok) {
      const message = data?.error === "esp32_manual_no_habilitado"
        ? "No se pudo activar el control manual porque el ESP32 esclavo no está conectado. La solicitud seguirá pendiente."
        : (data?.message || data?.error || "No se pudo resolver la solicitud de modo.");
      showDoctorFeedback(message, "danger");
    }
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
  loadDoctorDashboard();
}

function renderPatients(list) {
  const box = $("patientsList"); if (!box) return;
  if (!list?.length) {
    box.innerHTML = `<div class="dp-empty">Sin pacientes asignados · Acepta solicitudes para ver fichas.</div>`;
    return;
  }
  box.innerHTML = "";
  list.forEach(p => {
    const name = `${p.nombre || ""} ${p.apellidos || ""}`.trim() || "Paciente";
    const initials = name.split(" ").slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "P";
    const st = (p.estado_clinico || "ok").toLowerCase();
    const badge = st.includes("riesgo") || st.includes("peligro") ? "bad" : st.includes("observacion") || st.includes("advertencia") ? "warn" : "ok";
    const tutor = `${p.tutor_nombre || ""} ${p.tutor_apellidos || ""}`.trim() || "—";
    const hasSession = Number(p.sesiones_activas || 0) > 0;
    const pid = escapeAttr(p.id);
    const el = document.createElement("div");
    el.className = "dp-pat-card";
    el.innerHTML = `
      <div class="dp-pat-avatar">${escapeHtml(initials)}</div>
      <div class="dp-pat-info">
        <div class="dp-pat-name">${escapeHtml(name)}</div>
        <div class="dp-pat-meta">${escapeHtml(p.codigo || "—")} · ${p.dias_nacido ?? "—"}d · ${escapeHtml(tutor)}</div>
      </div>
      <div class="dp-pat-right">
        ${hasSession ? `<span class="dp-pat-badge session">Activa</span>` : ""}
        <span class="dp-pat-badge ${badge}">${escapeHtml(humanLabel(st))}</span>
        <div class="dp-pat-actions">
          <button class="dp-ficha-btn dp-btn-ficha" data-action="ficha"    data-patient-id="${pid}">Ficha</button>
          <button class="dp-ficha-btn dp-btn-edit"  data-action="editar"   data-patient-id="${pid}">Editar</button>
          <button class="dp-ficha-btn dp-btn-alta"  data-action="alta"     data-patient-id="${pid}">Alta</button>
          <button class="dp-ficha-btn dp-btn-arch"  data-action="archivar" data-patient-id="${pid}">Archivar</button>
        </div>
      </div>`;
    box.appendChild(el);
  });

  box.querySelectorAll("button[data-patient-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const pid = btn.dataset.patientId;
      switch (btn.dataset.action) {
        case "ficha":    openClinicalRecord(pid); break;
        case "editar":   openPatientDetail(pid); break;
        case "alta":     handleDischarge(pid); break;
        case "archivar": handleArchive(pid); break;
      }
    });
  });
}

function renderDoctorProfile(doctor = null) {
  const fullName = formatDoctorDisplayName(doctor, "Dr(a)");
  const initials = fullName.split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "DR";
  setText("doctorProfileAvatar", initials);
  setText("doctorProfileName", fullName);
  setText("doctorProfileSpecialty", doctor?.especialidad || "Especialidad no registrada");
  setText("doctorProfileLicense", `Matrícula: ${doctor?.matricula || doctor?.matricula_profesional || " "}`);
  setText("doctorProfileCenter", doctor?.centro || doctor?.hospital || "Centro médico neonatal");
}

function renderDoctorHeroState(patients = [], alerts = {}) {
  const activePatient = patients.find(p => Number(p.sesiones_activas || 0) > 0) || patients[0] || null;
  const activeName = activePatient ? `${activePatient.nombre || ""} ${activePatient.apellidos || ""}`.trim() : "Sin selección";
  setText("doctorSelectedPatient", activeName || "Sin selección");
  setText("doctorCurrentMode", (alerts.sessions || []).find(s => s.modo_final || s.modo_programado)?.modo_final || (alerts.sessions || []).find(s => s.modo_programado)?.modo_programado || "Sin datos");
}

function renderDoctorRightRail(patients = [], alerts = {}) {
  renderDoctorSystemStatus();
  renderDoctorRecentActivity(alerts);
  renderDoctorMiniSummary(patients, alerts);
}

// Estado real de la lámpara: se alimenta de la telemetría en vivo, no de textos fijos.
const lampState = { online: false, modo: null, cm: null, led: null, tamb: null };

function updateLampState(patch = {}) {
  Object.assign(lampState, patch);
  if (!lampState.online) Object.assign(lampState, { cm: null, led: null, tamb: null });
  renderDoctorSystemStatus();
}

function renderDoctorSystemStatus() {
  const reading = (value, unit) => {
    const n = Number(value);
    return value != null && Number.isFinite(n) ? `${Math.round(n * 10) / 10} ${unit}` : "—";
  };
  const modo = lampState.online && lampState.modo
    ? lampState.modo.charAt(0).toUpperCase() + lampState.modo.slice(1)
    : "—";

  const chip = $("doctorLampStatus");
  if (chip) {
    chip.textContent = lampState.online ? "Lámpara conectada" : "Lámpara sin conexión";
    chip.classList.toggle("is-on", lampState.online);
    chip.classList.toggle("is-off", !lampState.online);
  }
  if (lampState.online && lampState.modo) setText("doctorCurrentMode", modo);

  const box = $("doctorSystemStatus");
  if (!box) return;
  box.innerHTML = [
    ["Lámpara", lampState.online ? "Conectada" : "Sin conexión", lampState.online ? "is-ok" : "is-bad"],
    ["Modo", modo, ""],
    ["Distancia", reading(lampState.cm, "cm"), ""],
    ["Intensidad LED", reading(lampState.led, "%"), ""],
    ["Temp. ambiente", reading(lampState.tamb, "°C"), ""],
  ].map(([label, value, cls]) => `<span><b>${escapeHtml(label)}</b><em class="${cls}">${escapeHtml(value)}</em></span>`).join("");
}

function renderDoctorRecentActivity(alerts = {}) {
  const box = $("doctorRecentActivity");
  if (!box) return;
  const rows = [
    ...(alerts.recent || []).slice(0, 2).map(a => ({ type: "Alarma", text: `${humanLabel(a.tipo, "Alerta")} · ${a.patientCode || " "}` })),
    ...(alerts.sessions || []).slice(0, 2).map(s => ({ type: "Sesión", text: `${s.modo_final || s.modo_programado || "Terapia"} · ${s.patientCode || " - "}` })),
    ...(alerts.events || []).slice(0, 2).map(e => ({ type: "Evento", text: `${e.tipo || "Evento"} · ${e.patientCode || " "}` })),
  ].slice(0, 5);
  if (!rows.length) {
    box.innerHTML = `<div class="dp-empty">Sin actividad reciente.</div>`;
    return;
  }
  box.innerHTML = rows.map(row => `<div class="doctor-activity-row"><b>${escapeHtml(row.type)}</b><span>${escapeHtml(row.text)}</span></div>`).join("");
}

function renderDoctorMiniSummary(patients = [], alerts = {}) {
  const box = $("doctorMiniSummary");
  if (!box) return;
  const risk = patients.filter(p => normalizeClinicalState(p.estado_clinico) === "riesgo").length;
  const activePlans = patients.filter(p => Number(p.sesiones_activas || 0) > 0).length;
  const critical = (alerts.recent || []).filter(a => String(a.severidad || "").toLowerCase() === "critical").length;
  box.innerHTML = `
    <span><b>${risk}</b> Riesgo</span>
    <span><b>${activePlans}</b> Planes activos</span>
    <span><b>${critical}</b> Críticas</span>`;
}

function renderDoctorMiniPatients(list = []) {
  const box = $("doctorMiniPatients");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="dp-empty">Sin pacientes recientes.</div>`;
    return;
  }
  box.innerHTML = list.slice(0, 5).map(p => {
    const name = `${p.nombre || ""} ${p.apellidos || ""}`.trim() || "Paciente";
    const state = p.estado_clinico || "ok";
    return `<div class="doctor-mini-row">
      <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(p.codigo || "-")} · ${p.dias_nacido ?? "—"}d</span></div>
      <em>${escapeHtml(humanLabel(state))}</em>
    </div>`;
  }).join("");
}

function renderDoctorPlansSummary(list = []) {
  const box = $("doctorPlansSummary");
  if (!box) return;
  const withSessions = list.filter(p => Number(p.sesiones_activas || 0) > 0);
  if (!withSessions.length) {
    box.innerHTML = `<div class="dp-empty">Sin sesiones activas registradas para planes.</div>`;
    return;
  }
  box.innerHTML = withSessions.slice(0, 6).map(p => {
    const name = `${p.nombre || ""} ${p.apellidos || ""}`.trim() || "Paciente";
    return `<div class="doctor-mini-row">
      <div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(p.codigo || "-")} · terapia en curso</span></div>
      <em>${Number(p.sesiones_activas || 0)} activa(s)</em>
    </div>`;
  }).join("");
}

async function doSearch(q) {
  if (!q) { loadDoctorDashboard(); return; }
  try {
    const { ok, data } = await searchPatients(q);
    if (ok) renderPatients(data.results || []);
  } catch (_) {}
}

async function openPatientDetail(patientId) {
  if (!patientId) return;
  try {
    const [detailRes, sessionsRes, alarmsRes, eventsRes] = await Promise.all([
      fetchPatientDetail(patientId),
      fetchSessions(patientId),
      fetchAlarms(patientId),
      fetchEvents(patientId),
    ]);
    if (!detailRes.ok) {
      showDoctorFeedback(detailRes.data?.message || "No se pudo cargar el detalle.", "danger");
      return;
    }
    showPatientDetailModal({
      patient: detailRes.data.patient,
      plan: detailRes.data.plan,
      control: detailRes.data.control,
      sessions: sessionsRes.data?.sessions || [],
      alarms: alarmsRes.data?.alarms || [],
      events: eventsRes.data?.events || [],
    });
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
}

/* =========================================================
   FICHA CLÍNICA PREMIUM
   ========================================================= */
async function openClinicalRecord(patientId) {
  if (!patientId) return;
  try {
    const [detailRes, sessionsRes, alarmsRes, eventsRes] = await Promise.all([
      fetchPatientDetail(patientId),
      fetchSessions(patientId),
      fetchAlarms(patientId),
      fetchEvents(patientId),
    ]);
    if (!detailRes.ok) {
      showDoctorFeedback(detailRes.data?.message || "No se pudo cargar la ficha clínica.", "danger");
      return;
    }
    showClinicalRecordModal({
      patient: detailRes.data.patient,
      plan: detailRes.data.plan,
      sessions: sessionsRes.data?.sessions || [],
      alarms: alarmsRes.data?.alarms || [],
      events: eventsRes.data?.events || [],
    });
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
}

function showClinicalRecordModal({ patient, plan, sessions, alarms, events }) {
  document.getElementById("clinicalRecordModal")?.remove();

  const fullName = `${patient.nombre || ""} ${patient.apellidos || ""}`.trim() || "Paciente";
  const initials = fullName.split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "P";
  const doctorName = currentDoctor ? formatDoctorDisplayName(currentDoctor, "—") : "—";

  const planPct  = Math.max(0, Math.min(100, Math.round(Number(plan?.porcentaje_avance || 0))));
  const planAcum = Number(plan?.horas_acumuladas || 0);
  const planMeta = Number(plan?.horas_meta || 0);

  const totalSecs   = sessions.reduce((s, x) => s + Number(x.duracion_s || 0), 0);
  const totalTime   = secondsLabel(totalSecs);
  const sessionCount = sessions.length;
  const activeCount  = sessions.filter(s => String(s.status || "").toLowerCase().includes("activ")).length;

  const modeCounts = { reposo: 0, convencional: 0, intensivo: 0, automatico: 0 };
  sessions.forEach(s => {
    const m = normalizeMode(s.modo_final || s.modo_programado) || "reposo";
    modeCounts[m] = (modeCounts[m] || 0) + 1;
  });
  const modeMax = Math.max(1, ...Object.values(modeCounts));
  let dominantMode = "reposo";
  let maxCount = 0;
  Object.entries(modeCounts).forEach(([m, c]) => { if (c > maxCount) { maxCount = c; dominantMode = m; } });

  const alarmCounts = { criticas: 0, warning: 0, silenciadas: 0 };
  alarms.forEach(a => {
    const sev = String(a.severidad || "").toLowerCase();
    if (a.silenciada) alarmCounts.silenciadas++;
    else if (sev.includes("criti")) alarmCounts.criticas++;
    else alarmCounts.warning++;
  });

  const stateColorMap = { ok: "#15803d", observacion: "#b4560d", riesgo: "#c0152a", alta: "#5f3fb8" };
  const stateColor = stateColorMap[normalizeClinicalState(patient.estado_clinico)] || "#5f3fb8";

  const timeline = [
    ...sessions.slice(0, 6).map(s => ({
      date: s.fecha || s.created_at,
      type: "Sesión",
      detail: `${(normalizeMode(s.modo_final || s.modo_programado) || "—").toUpperCase()} · ${secondsLabel(s.duracion_s)}`,
      cls: "tl-session",
    })),
    ...events.slice(0, 4).map(e => ({
      date: e.created_at, type: e.tipo || "Evento",
      detail: e.descripcion || e.actor || "—", cls: "tl-event",
    })),
    ...alarms.slice(0, 3).map(a => {
      const sev = String(a.severidad || "").toLowerCase();
      const sub = a.silenciada ? "muted" : sev.includes("criti") ? "critical" : "warn";
      return { date: a.created_at, type: "Alarma", detail: `${humanLabel(a.tipo)} · ${humanLabel(a.severidad)}`, cls: `tl-alarm ${sub}` };
    }),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 10);

  const r    = 28;
  const circ = +(2 * Math.PI * r).toFixed(2);
  const dash = +((planPct / 100) * circ).toFixed(2);
  const off  = +(circ / 4).toFixed(2);

  const modeRows = [
    ["Reposo",  modeCounts.reposo,      "#cfc8dc"],
    ["Conv.",   modeCounts.convencional, "#6f9db3"],
    ["Intens.", modeCounts.intensivo,    "#7a57d1"],
    ["Auto",    modeCounts.automatico,   "#e3b23c"],
  ];
  const ledBadge = dominantMode === "intensivo" ? "badge-warn" : dominantMode === "convencional" ? "badge-ok" : "badge-neutral";

  const modal = document.createElement("div");
  modal.id = "clinicalRecordModal";
  modal.className = "cr-overlay";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  modal.innerHTML = `
    <div class="cr-backdrop" data-close="1"></div>
    <div class="cr-panel">

      <div class="cr-topbar">
        <div class="cr-topbar-brand">
          <img src="./img/logo.png" alt="NEOLIGHT" class="cr-topbar-logo" />
          NEOLIGHT · Ficha Clínica
        </div>
        <div class="cr-topbar-actions">
          <button class="cr-print-btn" id="crPrintBtn" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Imprimir / PDF
          </button>
          <button class="cr-close-btn" data-close="1" aria-label="Cerrar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div class="cr-hero">
        <div class="cr-hero-left">
          <div class="cr-avatar">${escapeHtml(initials)}</div>
          <div class="cr-hero-info">
            <div class="cr-hero-name">${escapeHtml(fullName)}</div>
            <div class="cr-hero-code">${escapeHtml(patient.codigo || "Sin código")}</div>
            <div class="cr-hero-tags">
              <span class="cr-tag cr-tag-state" style="--state-color:${stateColor}">${escapeHtml(humanLabel(patient.estado_clinico || "ok"))}</span>
              <span class="cr-tag">${patient.dias_nacido != null ? `${patient.dias_nacido} días de vida` : "Edad no registrada"}</span>
              ${plan ? `<span class="cr-tag">${escapeHtml((plan.modo_recomendado || "—").toUpperCase())}</span>` : ""}
            </div>
            <div class="cr-hero-meta-grid">
              <div class="cr-hmeta"><span>Doctor</span><b title="${escapeAttr(doctorName)}">${escapeHtml(doctorName)}</b></div>
              <div class="cr-hmeta"><span>Diagnóstico</span><b title="${escapeAttr(patient.diagnostico || "—")}">${escapeHtml(patient.diagnostico || "—")}</b></div>
              <div class="cr-hmeta"><span>Bilirrubina</span><b>${escapeHtml(String(patient.nivel_bilirrubina_actual ?? patient.nivel_bilirrubina_inicial ?? "—"))} mg/dL</b></div>
              <div class="cr-hmeta"><span>Peso</span><b>${escapeHtml(String(patient.peso_actual_g ?? patient.peso_nacimiento_g ?? "—"))} g</b></div>
            </div>
          </div>
        </div>
        <div class="cr-hero-right">
          <div class="cr-hero-progress-wrap">
            <svg class="cr-progress-ring" viewBox="0 0 72 72" aria-label="Progreso ${planPct}%">
              <circle class="cr-ring-bg"   cx="36" cy="36" r="${r}" />
              <circle class="cr-ring-fill" cx="36" cy="36" r="${r}"
                stroke-dasharray="${dash} ${circ - dash}"
                stroke-dashoffset="${off}" />
              <text x="36" y="42" text-anchor="middle"
                font-size="10" font-weight="800" fill="#221b2e" font-family="Nunito,system-ui">${planPct}%</text>
            </svg>
            <div class="cr-hero-time-wrap">
              <div class="cr-hero-time-label">Terapia acumulada</div>
              <div class="cr-hero-time-val">${planAcum > 0 ? planAcum + "h" : totalTime}</div>
              ${planMeta > 0 ? `<div class="cr-hero-time-goal">Meta: ${planMeta}h</div>` : ""}
            </div>
          </div>
          <div class="ficha-hero-neo">
            <img src="./img/neo.png" alt="Sistema NEOLIGHT" />
          </div>
        </div>
      </div>

      <div class="cr-widgets-grid">
        <div class="cr-widget">
          <div class="neo-widget-icon"><img src="./img/foco.png" alt="Intensidad LED" /></div>
          <div class="cr-widget-body">
            <div class="cr-widget-title">Intensidad LED</div>
            <div class="cr-widget-val">${escapeHtml(dominantMode.charAt(0).toUpperCase() + dominantMode.slice(1))}</div>
            <div class="cr-widget-sub">${sessionCount} sesión(es) registradas</div>
          </div>
          <span class="cr-widget-badge ${ledBadge}">${escapeHtml(dominantMode)}</span>
        </div>
        <div class="cr-widget">
          <div class="neo-widget-icon"><img src="./img/temp_body.png" alt="Temperatura bebé" /></div>
          <div class="cr-widget-body">
            <div class="cr-widget-title">Temperatura</div>
            <div class="cr-widget-val">—</div>
            <div class="cr-widget-sub">Bebé / Ambiente · Tiempo real</div>
          </div>
          <span class="cr-widget-badge badge-neutral">En vivo</span>
        </div>
        <div class="cr-widget">
          <div class="neo-widget-icon"><img src="./img/distancia.png" alt="Distancia lámpara" /></div>
          <div class="cr-widget-body">
            <div class="cr-widget-title">Distancia lámpara</div>
            <div class="cr-widget-val">— cm</div>
            <div class="cr-widget-sub">Óptimo: 30–45 cm · HC-SR04</div>
          </div>
          <span class="cr-widget-badge badge-neutral">Sensor</span>
        </div>
        <div class="cr-widget">
          <div class="neo-widget-icon"><img src="./img/reloj.png" alt="Tiempo terapia" /></div>
          <div class="cr-widget-body">
            <div class="cr-widget-title">Tiempo terapia</div>
            <div class="cr-widget-val">${totalTime}</div>
            <div class="cr-widget-sub">${sessionCount} sesion(es)· ${activeCount} activa(s)</div>
          </div>
          <span class="cr-widget-badge badge-session">Acumulado</span>
        </div>
      </div>

      <div class="cr-charts-section">
        <div class="cr-chart-card">
          <div class="cr-chart-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Progreso terapia
          </div>
          <div class="cr-progress-chart">
            <div class="cr-progress-bar-wrap">
              <div class="cr-progress-bar-track">
                <div class="cr-progress-bar-fill" style="width:${Math.max(0, planPct)}%"></div>
              </div>
              <div class="cr-progress-legend">
                <span>${planAcum}h acum.</span><span>${planPct}%</span><span>${planMeta ? "Meta: " + planMeta + "h" : "Sin meta"}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="cr-chart-card">
          <div class="cr-chart-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>
            Sesiones por modo
          </div>
          <div class="cr-bar-chart">
            ${modeRows.map(([label, count, color]) => `
              <div class="cr-bar-item">
                <div class="cr-bar-track">
                  <div class="cr-bar-fill" style="height:${Math.max(4, Math.round((count / modeMax) * 72))}px;background:${color}"></div>
                </div>
                <div class="cr-bar-count">${count}</div>
                <div class="cr-bar-label">${escapeHtml(label)}</div>
              </div>`).join("")}
          </div>
        </div>

        <div class="cr-chart-card">
          <div class="cr-chart-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
            Alarmas registradas
          </div>
          ${alarms.length ? `
            <div class="cr-alarm-dist-chips">
              <div class="cr-adchip critica"><span>Críticas</span><b>${alarmCounts.criticas}</b></div>
              <div class="cr-adchip warning"><span>Avisos</span><b>${alarmCounts.warning}</b></div>
              <div class="cr-adchip silenciada"><span>Resueltas</span><b>${alarmCounts.silenciadas}</b></div>
            </div>` : `<div class="cr-chart-empty">Sin alarmas registradas</div>`}
        </div>
      </div>

      <div class="cr-section">
        <div class="cr-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Alertas recientes
        </div>
        <div class="cr-alarms-list">
          ${alarms.length ? alarms.slice(0, 5).map(a => {
            const sev = String(a.severidad || "").toLowerCase();
            const dot = a.silenciada ? "cr-aldot-muted" : sev.includes("criti") ? "cr-aldot-critical" : "cr-aldot-warn";
            const badge = a.silenciada ? "cr-albadge-muted" : sev.includes("criti") ? "cr-albadge-critical" : "cr-albadge-warn";
            return `<div class="cr-alarm-row">
              <span class="cr-al-dot ${dot}"></span>
              <div class="cr-al-body">
                <div class="cr-al-name">${escapeHtml(humanLabel(a.tipo, "Alerta"))}</div>
                <div class="cr-al-detail">${escapeHtml(a.mensaje || a.valor_medido || "—")} · ${formatDate(a.created_at)}</div>
              </div>
              <span class="cr-al-sev ${badge}">${escapeHtml(a.severidad || "—")}</span>
            </div>`;
          }).join("") : `<div class="cr-empty">Sin alarmas registradas.</div>`}
        </div>
      </div>

      <div class="cr-section">
        <div class="cr-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          Historial clínico
        </div>
        <div class="cr-timeline">
          ${timeline.length ? timeline.map(item => `
            <div class="cr-tl-item ${escapeHtml(item.cls)}">
              <div class="cr-tl-dot"></div>
              <div class="cr-tl-body">
                <span class="cr-tl-type">${escapeHtml(item.type)}</span>
                <span class="cr-tl-detail">${escapeHtml(item.detail)}</span>
                <span class="cr-tl-date">${formatDate(item.date)}</span>
              </div>
            </div>`).join("") : `<div class="cr-empty">Sin historial disponible.</div>`}
        </div>
      </div>

      <div class="cr-footer">
        <span>NEOLIGHT· ${escapeHtml(fullName)} · ${new Date().toLocaleDateString("es")}</span>
        <button class="cr-print-btn-sm" id="crPrintBtnFoot" type="button">Imprimir PDF</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => modal.remove()));

  const doPrint = () => {
    modal.classList.add("cr-printing");
    window.print();
    setTimeout(() => modal.classList.remove("cr-printing"), 1000);
  };
  document.getElementById("crPrintBtn")?.addEventListener("click", doPrint);
  document.getElementById("crPrintBtnFoot")?.addEventListener("click", doPrint);
}

function showPatientDetailModal({ patient, plan, control, sessions, alarms, events }) {
  $("doctorPatientModal")?.remove();
  const fullName = `${patient.nombre || ""} ${patient.apellidos || ""}`.trim() || "Paciente";
  const planPct = Number(plan?.porcentaje_avance || 0);

  const modal = document.createElement("div");
  modal.className = "modal open clinical-modal";
  modal.id = "doctorPatientModal";
  modal.setAttribute("aria-hidden", "false");
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel modal-wide" role="dialog" aria-modal="true" aria-label="Ficha clínica">
      <div class="modal-head">
        <div>
          <div class="modal-title">${escapeHtml(fullName)}</div>
          <div class="modal-sub">${escapeHtml(patient.codigo || "Sin código")} · Tutor: ${escapeHtml(`${patient.tutor_nombre || ""} ${patient.tutor_apellidos || ""}`.trim() || "—")} · Lámpara: ${escapeHtml(humanLabel(patient.disp_estado || "offline"))}</div>
        </div>
        <button class="modal-close" type="button" data-close="1" aria-label="Cerrar">x</button>
      </div>

      <div class="clinical-layout">
        <section>
          <div class="panel-title">Datos clínicos</div>
          <div class="form-grid two">
            ${input("editNombre", "Nombre", patient.nombre)}
            ${input("editApellidos", "Apellidos", patient.apellidos)}
          </div>
          <div class="form-grid three">
            ${input("editPesoNacimiento", "Peso nacimiento (g)", patient.peso_nacimiento_g, "number", "1")}
            ${input("editPesoActual", "Peso actual (g)", patient.peso_actual_g, "number", "1")}
            ${input("editEdadGestacional", "Edad gestacional", patient.edad_gestacional_sem, "number", "0.1")}
          </div>
          ${input("editDiagnostico", "Diagnóstico", patient.diagnostico)}
          ${textarea("editObservaciones", "Observaciones", patient.observaciones)}
          <div class="form-grid three">
            ${input("editBiliInicial", "Bilirrubina inicial", patient.nivel_bilirrubina_inicial, "number", "0.01")}
            ${input("editBiliActual", "Bilirrubina actual", patient.nivel_bilirrubina_actual, "number", "0.01")}
            ${select("editEstadoClinico", "Estado clínico", ["ok","observacion","riesgo","alta"], patient.estado_clinico)}
          </div>
          <div class="form-grid two">
            ${select("editGrupoSanguineo", "Grupo sanguíneo", ["","A","B","AB","O"], patient.grupo_sanguineo)}
            ${select("editFactorRh", "Factor RH", ["","+","-"], patient.factor_rh)}
          </div>
          <button class="btn btn-primary btn-full" id="savePatientClinicalBtn">Guardar ficha clínica</button>
          <div id="patientEditMsg" class="error" aria-live="polite"></div>
        </section>

        <aside>
          <div class="panel-title">Plan de terapia</div>
          <div class="hint-box"><strong>${plan ? "Plan activo" : "Sin plan activo"}</strong><br><small>${plan ? `${plan.horas_acumuladas} / ${plan.horas_meta} h · ${humanLabel(plan.modo_recomendado)}` : "Define una meta para activar seguimiento."}</small></div>
          <div class="progress-track"><span style="width:${Math.max(0, Math.min(100, planPct))}%"></span></div>
          <div class="form-grid two">
            ${input("planHoras", "Meta total (h)", plan?.horas_meta || "", "number", "0.25")}
            ${select("planModo", "Modo recomendado", ["convencional","intensivo"], plan?.modo_recomendado || "convencional")}
          </div>
          ${textarea("planObs", "Observaciones del plan", plan?.observaciones)}
          <button class="btn btn-primary btn-full" id="savePlanBtn">${plan ? "Actualizar plan" : "Crear plan"}</button>
          ${plan ? `<button class="btn btn-secondary btn-full" id="cancelPlanBtn">Cancelar plan</button>` : ""}

          <div class="panel-title spaced">Permisos del tutor</div>
          ${select("controlMode", "Permiso tutor", ["bloqueado","manual","automatico"], control?.modo_control || "bloqueado")}
          ${input("controlUntil", "Habilitado hasta", toDatetimeLocal(control?.habilitado_hasta), "datetime-local")}
          ${input("controlReason", "Motivo", control?.motivo)}
          <button class="btn btn-secondary btn-full" id="saveControlBtn">Guardar permisos</button>
          <div class="panel-title spaced">Cambiar modo de la lámpara</div>
          <div class="mode-row">
            ${["reposo","convencional","intensivo"].map(m => `<button class="btn-mini" data-doctor-mode="${m}">${humanLabel(m)}</button>`).join("")}
          </div>
          <button class="btn btn-secondary btn-full" id="exportPatientBtn">Exportar Excel</button>
        </aside>
      </div>

      <div class="clinical-layout history-layout">
        ${historyTable("Sesiones", sessions.map(s => [formatDate(s.fecha || s.created_at), humanLabel(s.modo_programado, "-"), secondsLabel(s.duracion_s), humanLabel(s.status, "-")]))}
        ${historyTable("Alarmas", alarms.map(a => [formatDate(a.created_at), humanLabel(a.tipo, "-"), humanLabel(a.severidad, "-"), a.mensaje || a.valor_medido || "-"]))}
        ${historyTable("Eventos", events.map(e => [formatDate(e.created_at), humanLabel(e.tipo, "-"), e.cuenta_nombre || "-", e.descripcion || "-"]))}
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => modal.remove()));
  $("savePatientClinicalBtn")?.addEventListener("click", () => savePatientClinical(patient.id));
  $("savePlanBtn")?.addEventListener("click", () => savePlan(patient.id, plan?.id || null));
  $("cancelPlanBtn")?.addEventListener("click", () => doCancelPlan(patient.id, plan.id));
  $("saveControlBtn")?.addEventListener("click", () => saveControl(patient.id, patient.tutor_id));
  $("exportPatientBtn")?.addEventListener("click", () => exportExcel(patient.id).catch(() => showDoctorFeedback("No se pudo exportar Excel.", "danger")));
  modal.querySelectorAll("[data-doctor-mode]").forEach(btn =>
    btn.addEventListener("click", () => setDoctorMode(patient.id, btn.dataset.doctorMode))
  );
}

async function savePatientClinical(patientId) {
  const msg = $("patientEditMsg"); if (msg) msg.textContent = "";
  const common = {
    nombre: value("editNombre"),
    apellidos: value("editApellidos"),
    estado_clinico: value("editEstadoClinico"),
  };
  const clinical = {
    diagnostico: value("editDiagnostico"),
    observaciones: value("editObservaciones"),
    peso_nacimiento_g: numberOrNull("editPesoNacimiento"),
    peso_actual_g: numberOrNull("editPesoActual"),
    edad_gestacional_sem: numberOrNull("editEdadGestacional"),
    nivel_bilirrubina_inicial: numberOrNull("editBiliInicial"),
    nivel_bilirrubina_actual: numberOrNull("editBiliActual"),
    grupo_sanguineo: value("editGrupoSanguineo") || null,
    factor_rh: value("editFactorRh") || null,
  };
  try {
    const [r1, r2] = await Promise.all([updatePatient(patientId, common), updatePatientClinical(patientId, clinical)]);
    if (!r1.ok || !r2.ok) { if (msg) msg.textContent = "No se pudo guardar la ficha."; return; }
    $("doctorPatientModal")?.remove();
    loadDoctorDashboard();
  } catch (_) {
    if (msg) msg.textContent = "No se pudo conectar al servidor.";
  }
}

async function savePlan(patientId, planId) {
  const payload = {
    hours_target: numberOrNull("planHoras"),
    modo_recomendado: value("planModo"),
    observaciones: value("planObs") || null,
  };
  if (!payload.hours_target || payload.hours_target <= 0) return showDoctorFeedback("Define una meta de horas válida.", "warn");
  const res = planId ? await updatePlan(patientId, planId, payload) : await createPlan(patientId, payload);
  if (!res.ok) return showDoctorFeedback(res.data?.message || "No se pudo guardar el plan.", "danger");
  $("doctorPatientModal")?.remove();
  loadDoctorDashboard();
}

async function doCancelPlan(patientId, planId) {
  const res = await cancelPlan(patientId, planId);
  if (!res.ok) return showDoctorFeedback(res.data?.message || "No se pudo cancelar el plan.", "danger");
  $("doctorPatientModal")?.remove();
  loadDoctorDashboard();
}

async function saveControl(patientId, tutorId) {
  const res = await updateControl(patientId, {
    modo_control: value("controlMode"),
    habilitado_hasta: value("controlUntil") || null,
    motivo: value("controlReason") || null,
    tutor_id: tutorId || null,
  });
  if (!res.ok) {
    const message = res.data?.error === "esp32_manual_no_habilitado"
      ? "No se pudo habilitar el control manual porque el ESP32 esclavo no está conectado."
      : (res.data?.message || "No se pudieron guardar permisos.");
    return showDoctorFeedback(message, "danger");
  }
  showDoctorFeedback("Permisos actualizados.", "ok");
}

async function setDoctorMode(patientId, mode) {
  const res = await doctorSetMode(patientId, mode);
  showDoctorFeedback(res.ok ? `Modo ${mode} enviado.` : (res.data?.message || "No se pudo cambiar el modo."), res.ok ? "ok" : "danger");
}

function numberOrNull(id) {
  const raw = value(id);
  return raw === "" ? null : Number(raw);
}

function value(id) {
  return ($(id)?.value || "").trim();
}

function input(id, label, val = "", type = "text", step = null) {
  return `<div class="input-group"><label>${label}</label><input id="${id}" class="input" type="${type}" ${step ? `step="${step}"` : ""} value="${escapeAttr(val ?? "")}"></div>`;
}

function textarea(id, label, val = "") {
  return `<div class="input-group"><label>${label}</label><textarea id="${id}" class="input textarea" rows="3">${escapeHtml(val || "")}</textarea></div>`;
}

function select(id, label, options, selected) {
  return `<div class="input-group"><label>${label}</label><div class="input-wrapper select-wrapper"><select id="${id}" class="select">${options.map(o => `<option value="${escapeAttr(o)}" ${String(o) === String(selected || "") ? "selected" : ""}>${o ? escapeHtml(humanLabel(o)) : "—"}</option>`).join("")}</select></div></div>`;
}

function historyTable(title, rows) {
  const body = rows.length
    ? rows.slice(0, 8).map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="4">Sin datos</td></tr>`;
  return `<section><div class="panel-title">${title}</div><div class="table-wrap"><table class="clinical-table"><tbody>${body}</tbody></table></div></section>`;
}

function toDatetimeLocal(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function secondsLabel(sec) {
  const n = Number(sec || 0);
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).slice(0, 10) : d.toLocaleDateString("es");
}

function sortByRecent(a, b) {
  return new Date(b.created_at || b.fecha || 0) - new Date(a.created_at || a.fecha || 0);
}

function normalizeClinicalState(value) {
  const st = String(value || "ok").toLowerCase();
  if (st.includes("alta")) return "alta";
  if (st.includes("riesgo") || st.includes("peligro")) return "riesgo";
  if (st.includes("observ")) return "observacion";
  return "ok";
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value ?? "—");
}

function showDoctorFeedback(message, kind = "status") {
  const box = $("requestsList") || $("patientsList");
  if (!box) return;
  $("doctorDashboardMsg")?.remove();
  const msg = document.createElement("div");
  msg.id = "doctorDashboardMsg";
  msg.className = `feedback-msg ${kind}`;
  msg.textContent = message;
  box.prepend(msg);
  window.setTimeout(() => msg.remove(), 4500);
}

async function handleDischarge(patientId) {
  if (!confirm("¿Dar de alta a este paciente?")) return;
  try {
    const { ok, data } = await dischargePatient(patientId);
    if (!ok) showDoctorFeedback(data?.message || "No se pudo dar de alta.", "danger");
    else showDoctorFeedback("Paciente dado de alta.", "ok");
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
  loadDoctorDashboard();
}

async function handleArchive(patientId) {
  if (!confirm("¿Archivar este paciente?")) return;
  try {
    const { ok, data } = await archivePatient(patientId);
    if (!ok) showDoctorFeedback(data?.message || "No se pudo archivar.", "danger");
    else showDoctorFeedback("Paciente archivado.", "ok");
  } catch (_) {
    showDoctorFeedback("No se pudo conectar con el servidor.", "danger");
  }
  loadDoctorDashboard();
}
