# Sistema visual NEOLIGHT — paleta "Mezcla"

Pastel suave + cielo y coral. Pensada para pediatría: cálida y con color, pero con las alarmas siempre distinguibles.

## Dónde se cambia cada cosa

| Qué | Archivo |
|---|---|
| Colores y tipografía de todo el sistema | `public/css/modules/00-tokens.css` |
| Aspecto final de portada, acceso y los tres paneles | `public/css/modules/90-neolight-mezcla.css` |
| Tipografía (Nunito, alojada en el proyecto) | `public/fonts/` |
| Textos legibles de códigos de la base | `humanLabel` en `public/js/config.js` |

Los módulos `00` a `40` conservan la estructura (tamaños, rejillas, estados), pero ya no contienen colores sueltos: todos apuntan a los tokens.

## Colores

| Uso | Token | Color |
|---|---|---|
| Fondo de página | `--nl-bg` | `#fcf7f3` |
| Texto principal | `--nl-ink` | `#221b2e` |
| Botones y acentos | `--nl-accent` | `#7a57d1` |
| Lila (pacientes, tiempo) | `--nl-lila` | `#e6defb` |
| Coral (solicitudes, temperatura) | `--nl-coral` | `#f8c6bb` |
| Cielo (distancia, terapia) | `--nl-sky` | `#cfe0e8` |
| Amarillo (luz, alertas del día) | `--nl-sun` | `#fef0c0` |
| Crema (temperatura ambiente) | `--nl-cream` | `#f3d9c3` |

## Colores de estado (no decorativos)

| Estado | Token | Color |
|---|---|---|
| Correcto | `--nl-ok` | `#15803d` |
| Aviso | `--nl-warn` | `#b4560d` |
| Crítico | `--nl-danger` | `#c0152a` |

Regla: el rosa, el coral y el amarillo decorativos nunca se usan para indicar una alarma. Las alarmas usan solo los tres colores de estado.

## Transparencias

Cada color tiene una versión `-rgb` para usarlo con transparencia:

```css
background: rgb(var(--nl-accent-rgb) / .15);
```
