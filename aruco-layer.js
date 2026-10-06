// =========================================================
// aruco-layer.js
// Capa 1 de la verificación del antifaz: busca el marcador
// ArUco (diccionario 4x4, n.º 0) pegado al antifaz.
// Es rápida (milisegundos) y no usa ningún servicio externo.
// =========================================================

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const { AR } = require('js-aruco2');
require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');

export const MARKER_ID = 0;
const detector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000', maxHammingDistance: 2 });

// Convierte la foto a gris y estira el contraste. Hay dos formas de sacar el gris:
//  "luma": el brillo normal de la foto (conserva el detalle fino del JPEG).
//  "max":  el canal más fuerte de cada punto (útil con la luz azul de la fototerapia,
//          donde casi toda la señal está en el canal azul).
function toGrey(src, width, height, mode) {
  const n = width * height;
  const g = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = mode === 'max'
      ? Math.max(src[p], src[p + 1], src[p + 2])
      : (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
    g[i] = v;
    hist[v]++;
  }
  // Percentiles 1 y 99 para ignorar brillos y sombras extremas.
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  const scale = hi > lo ? 255 / (hi - lo) : 1;
  for (let i = 0; i < n; i++) g[i] = (g[i] - lo) * scale;
  return g;
}

// Agranda al doble (interpolando) para que un marcador pequeño tenga más puntos por cuadro.
function upscale2(g, width, height) {
  const W = width * 2, H = height * 2;
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(height - 1, y / 2), y0 = fy | 0, y1 = Math.min(height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(width - 1, x / 2), x0 = fx | 0, x1 = Math.min(width - 1, x0 + 1), wx = fx - x0;
      const a = g[y0 * width + x0], b = g[y0 * width + x1], c = g[y1 * width + x0], d = g[y1 * width + x1];
      out[y * W + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

function greyToRGBA(g) {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) { out[p] = out[p + 1] = out[p + 2] = g[i]; out[p + 3] = 255; }
  return out;
}

/**
 * Busca el marcador en un JPEG.
 * Devuelve { encontrado, cx, cy, lado, angulo, w, h, ms } con el centro y el lado
 * expresados como fracción del ancho de la foto (0 a 1), para que no dependan de la resolución.
 */
export function detectarMarcador(buffer) {
  const t0 = Date.now();
  const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 64 });
  const { width: w, height: h } = img;

  // Se intenta de varias maneras, de la más rápida a la más lenta, y se usa la primera que lo encuentre.
  let found = [], factor = 1, pasada = '';
  for (const mode of ['luma', 'max']) {
    const g = toGrey(img.data, w, h, mode);
    found = detector.detect({ width: w, height: h, data: greyToRGBA(g) }).filter(m => m.id === MARKER_ID);
    if (found.length) { factor = 1; pasada = mode; break; }
    found = detector.detect({ width: w * 2, height: h * 2, data: greyToRGBA(upscale2(g, w, h)) }).filter(m => m.id === MARKER_ID);
    if (found.length) { factor = 2; pasada = `${mode} x2`; break; }
  }
  if (!found.length) return { encontrado: false, w, h, ms: Date.now() - t0 };
  for (const m of found) for (const p of m.corners) { p.x /= factor; p.y /= factor; }

  // Si hubiera más de uno, el más grande.
  const side = m => Math.hypot(m.corners[1].x - m.corners[0].x, m.corners[1].y - m.corners[0].y);
  const m = found.sort((a, b) => side(b) - side(a))[0];
  const c = m.corners;
  const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
  const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
  const lado = (side(m) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
  const angulo = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x) * 180 / Math.PI;
  return {
    encontrado: true,
    cx: +(cx / w).toFixed(4), cy: +(cy / w).toFixed(4), lado: +(lado / w).toFixed(4),
    angulo: +angulo.toFixed(1), lado_px: Math.round(lado), distancia_bits: m.hammingDistance,
    esquinas: c.map(p => [+(p.x / w).toFixed(4), +(p.y / w).toFixed(4)]),
    pasada, w, h, ms: Date.now() - t0,
  };
}
