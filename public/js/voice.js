// =========================================================
// public/js/voice.js
// Saludo de bienvenida con voz al iniciar sesión.
// El servidor arma el texto y, si tiene ElevenLabs configurado, manda el audio.
// Si no hay audio, el navegador lee el texto con su propia voz.
// =========================================================

import { apiFetch } from "./config.js";

const VOICE_OFF_KEY = "neolight_voz_off";
// Un instante de silencio: sirve para que el celular permita reproducir audio después.
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
let player = null;

export const isVoiceOn = () => { try { return localStorage.getItem(VOICE_OFF_KEY) !== "1"; } catch (_) { return true; } };
export const setVoiceOn = on => { try { on ? localStorage.removeItem(VOICE_OFF_KEY) : localStorage.setItem(VOICE_OFF_KEY, "1"); } catch (_) {} };

/** Llamar dentro del clic de "Entrar": los navegadores solo dejan sonar audio que nace de un toque. */
export function primeVoice() {
  if (!isVoiceOn()) return;
  try {
    player = player || new Audio();
    player.src = SILENCE;
    player.play().catch(() => {});
  } catch (_) {}
}

function speakWithBrowser(text) {
  if (!("speechSynthesis" in window)) return;
  const say = new SpeechSynthesisUtterance(text);
  say.lang = "es-ES";
  const voice = speechSynthesis.getVoices().find(v => /^es/i.test(v.lang));
  if (voice) say.voice = voice;
  say.rate = 0.98;
  speechSynthesis.cancel();
  speechSynthesis.speak(say);
}

export function stopVoice() {
  try { player?.pause(); } catch (_) {}
  try { window.speechSynthesis?.cancel(); } catch (_) {}
}

/** Pide el saludo y lo reproduce. Nunca interrumpe el ingreso si algo falla. */
export async function playWelcome() {
  if (!isVoiceOn()) return;
  try {
    const res = await apiFetch("/api/voice/welcome");
    const data = await res.json();
    if (!data?.text) return;
    if (data.audio) {
      player = player || new Audio();
      player.src = `data:audio/mpeg;base64,${data.audio}`;
      await player.play().catch(() => speakWithBrowser(data.text));
    } else {
      speakWithBrowser(data.text);
    }
  } catch (_) {}
}
