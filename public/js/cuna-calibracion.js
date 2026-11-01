// =========================================================
// public/js/cuna-calibracion.js
// Superusuario > Diagnóstico > Cuna: lecturas crudas de la cuna
// y calibración de balanza, talla y temperatura desde la interfaz.
// =========================================================

import { $ } from "./config.js";
import { fetchCunaDiagnostico, sendCunaOrden } from "./superuser-api.js";

let bound = false;
let timer = null;
let ultimoMsgId = null;
let esperando = null;      // { orden, ts } mientras la cuna no responde

const n = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("es-BO", { minimumFractionDigits: d, maximumFractionDigits: d }));
const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

function mostrarMsg(texto, tono = "info") {
  const el = $("suCunaMsg");
  if (!el) return;
  el.hidden = !texto;
  el.textContent = texto || "";
  el.dataset.tono = tono;
}

function render(data) {
  const c = data.cuna;
  const online = data.online;
  const k = c?.crudo || null;
  const pill = $("suCunaEstado");
  if (pill) {
    pill.textContent = !online ? "Sin conexión" : !c.fw ? "Firmware viejo" : c.simulado ? "Datos simulados" : `Conectada · ${c.fw}`;
    pill.className = `su-status-pill ${!online ? "danger" : !c.fw || c.simulado ? "warning" : "success"}`;
  }
  set("suCunaInfo", !online
    ? "La cuna no está mandando datos. Revisa que esté encendida, con WiFi, con la misma DEVICE_KEY que Railway y con CUNA_HABILITAR_NUBE en 1."
    : !c.fw ? "La cuna manda datos pero tiene un firmware anterior: carga cuna-2.0 para poder calibrar desde aquí."
    : `Última lectura hace ${n(c.hace_s)} s · ${c.estado || ""}`);

  // Balanza
  set("suCunaPeso", !online ? "—" : k?.tarando ? "Tarando…" : c.peso_g != null ? `${n(c.peso_g)} g` : "—");
  set("suCunaPesoEst", !online ? "—" : k && !k.hx ? "HX711 sin señal" : !k?.tara ? "Falta tarar" : c.estable ? "Estable" : "Moviéndose");
  set("suCunaNeto", k ? n(k.neto) : "—");
  set("suCunaFactor", k ? n(k.factor, 3) : "—");

  // Talla
  set("suCunaTalla", !online ? "—" : c.talla_cm != null ? `${n(c.talla_cm, 1)} cm` : "Sin medir");
  set("suCunaD1", k?.d1 != null ? `${n(k.d1)} mm` : "—");
  set("suCunaD2", k?.d2 != null ? `${n(k.d2)} mm` : "—");
  set("suCunaLargo", k ? `${n(k.largo)} mm` : "—");
  set("suCunaVl", k ? `${k.vl1 ? "1 OK" : "1 FALLA"} · ${k.vl2 ? "2 OK" : "2 FALLA"}` : "—");

  // Temperatura (se muestra la lectura sin filtrar para poder calibrar con temperatura ambiente)
  const t = k?.t_cruda ?? c?.temp_c;
  set("suCunaTemp", !online ? "—" : t != null ? `${n(t, 1)} °C` : "Sin lectura");
  if (k && k.t_a != null) {            // firmware 2.2: corrección lineal sobre tu fórmula
    set("suCunaR", k.adc != null ? n(k.adc) : "—");
    set("suCunaGnd", k.t_sin_corr != null ? `${n(k.t_sin_corr, 1)} °C` : "—");
    set("suCunaRB", `× ${n(k.t_a, 3)} ${k.t_b < 0 ? "−" : "+"} ${n(Math.abs(k.t_b), 1)} °C`);
  } else {                               // firmware 2.0 / 2.1
    set("suCunaR", k?.r_ntc != null ? `${n(k.r_ntc / 1000, 2)} kΩ` : k ? "NTC suelto o en corto" : "—");
    set("suCunaGnd", k ? (k.ntc_gnd ? "NTC a GND" : "NTC a 3,3 V") : "—");
    set("suCunaRB", k ? `${n(k.r25 / 1000, 2)} kΩ / ${n(k.beta)}` : "—");
  }
  set("suCunaPts", k ? `${k.tpts} de 2` : "—");

  // Respuesta de la cuna a la última orden
  if (c?.msg_id != null && c.msg_id !== ultimoMsgId) {
    if (ultimoMsgId !== null && c.msg) {
      const malo = /no |falla|revisa|rara|primero|espera|desconocida|no cuadran/i.test(c.msg);
      mostrarMsg(c.msg, malo ? "warn" : "ok");
      esperando = null;
    }
    ultimoMsgId = c.msg_id;
  }
  if (esperando && Date.now() - esperando.ts > 12000) {
    mostrarMsg("La cuna no respondió a la orden. Revisa que siga conectada.", "warn");
    esperando = null;
  }
  document.querySelectorAll("[data-cuna-orden]").forEach(b => { b.disabled = !online || !c?.fw; });
}

async function refrescar() {
  const panel = $("suCunaPanel");
  if (!panel || !panel.offsetParent) return;
  const res = await fetchCunaDiagnostico();
  if (res.ok) render(res.data);
}

export function initCunaCalibracion() {
  if (bound || !$("suCunaPanel")) return;
  bound = true;
  $("suCunaPanel").addEventListener("click", async e => {
    const btn = e.target.closest("[data-cuna-orden]");
    if (!btn) return;
    const orden = btn.dataset.cunaOrden;
    const input = btn.dataset.cunaValor ? $(btn.dataset.cunaValor) : null;
    const valor = input ? input.value.trim() : "";
    if (input && !valor) { mostrarMsg("Escribe el valor de referencia primero.", "warn"); input.focus(); return; }
    if (orden === "borrar_temp" && !window.confirm("¿Borrar la calibración de temperatura?")) return;
    const res = await sendCunaOrden(orden, valor);
    if (!res.ok) { mostrarMsg(res.data?.message || "No se pudo enviar la orden.", "warn"); return; }
    esperando = { orden, ts: Date.now() };
    mostrarMsg(orden === "tara" ? "Tarando… no toques la cuna." : "Orden enviada a la cuna…", "info");
    if (input) input.value = "";
  });
  refrescar();
  clearInterval(timer);
  timer = setInterval(refrescar, 1000);
  window.addEventListener("neolight:session-expired", () => clearInterval(timer));
}
