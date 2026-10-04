# Cómo se comunica la lámpara con el servidor

Este documento es el contrato entre el firmware del ESP32 maestro y el servidor.
El firmware del maestro debe cumplirlo para que la interfaz en la nube funcione.

## Idea general

En la nube el servidor no puede llamar a la lámpara (está detrás del WiFi del lugar).
Por eso la lámpara es la que llama:

1. Cada segundo envía su telemetría al servidor.
2. En la respuesta recibe los comandos pendientes.

## Envío de telemetría

```
POST https://neolight.up.railway.app/api/esp32-data
Content-Type: application/json
x-device-key: <la clave configurada en DEVICE_KEY>
```

Cuerpo (los mismos campos que hoy entrega `/data` en el maestro):

| Campo | Tipo | Significado |
|---|---|---|
| `estado` | texto | `REPOSO`, `CONVENCIONAL` o `INTENSIVO` |
| `distancia` | número | cm medidos; `-1` si el ultrasonido no responde |
| `tempAmb` | número | temperatura ambiente en °C |
| `ldr` | número | luz medida, 0 a 100 |
| `pwm` | número | intensidad entregada a los LED, 0 a 100 |
| `pausado` | booleano | pausa por STOP físico |
| `manual` | booleano | la clave física fue ingresada en el esclavo |
| `slave` | booleano | el esclavo está conectado al maestro |
| `alarms_muted` | booleano | el buzzer está silenciado (opcional) |
| `peso_g` | número | peso de la cuna en gramos (opcional, para la balanza) |

## Respuesta con comandos

```json
{"ok":true,"terapiaActiva":true,"cmd":"MODO=CONVENCIONAL;MOVER=STOP"}
```

`cmd` trae cero o más comandos separados por `;`. Vacío significa que no hay nada que hacer.

| Comando | Qué debe hacer el maestro |
|---|---|
| `MODO=REPOSO` / `MODO=CONVENCIONAL` / `MODO=INTENSIVO` | Lo mismo que hoy hace `/modo?m=` |
| `MOVER=SUBIR` / `BAJAR` / `IZQ` / `DER` / `STOP` | Lo mismo que hoy hace `/mover?dir=` |
| `LOCK` | Bloquear el control manual (enviar `LOCK` al esclavo) |
| `MUTE=300` | Silenciar el buzzer esos segundos; `MUTE=0` lo reactiva |
| `BEEP` | Hacer sonar el buzzer una vez (prueba técnica) |

Reglas del servidor:

- Un comando que no se recoge en 8 segundos se descarta (30 s para `STOP` y `LOCK`).
- El servidor solo envía `MOVER` si la telemetría dice `manual: true`.
- Si la lámpara deja de enviar datos 10 segundos, figura como desconectada.

## Ventanas de distancia

El servidor usa las mismas ventanas que el firmware para alarmas y tiempo en rango.
Si se cambian en el maestro hay que cambiarlas también en `DISTANCE_WINDOWS` de `server.js`.

| Modo | Mínimo | Máximo |
|---|---|---|
| Convencional | 28 cm | 40 cm |
| Intensivo | 11 cm | 25 cm |

## Sesiones

Las abre y las cierra el servidor según la telemetría:

- Empieza cuando la lámpara entra en convencional o intensivo sin pausa.
- Termina cuando pasa 30 segundos en reposo o pausa, o 60 segundos sin conexión.
- Al cerrar se calculan duración, tiempo dentro de la ventana y promedios.

## Modo local

Si en el servidor se define `ESP32_MASTER_URL` (por ejemplo `http://192.168.4.1`), el
servidor vuelve a consultar `/data` y a llamar `/modo` y `/mover` directamente, como antes.
Para ese modo el maestro necesitaría además las rutas `/lock`, `/mute?s=` y `/beep`.


## Acceso técnico desde el panel (QR)

La combinación **MODE, DERECHA, MODE** en el panel hace que el esclavo muestre en su
pantalla un QR fijo que apunta a:

    https://neolight.up.railway.app/#tecnico

El QR por sí solo no da acceso. Mientras el QR está en pantalla, el maestro agrega a su
telemetría el campo `"tec": 1` (y `"tec": 0` el resto del tiempo). Cuando el servidor ve
que `tec` pasa de 0 a 1, habilita el teclado del acceso técnico durante `TECH_WINDOW_S`
segundos (120 por defecto). En ese tiempo, quien escriba el código de seguridad entra al
panel de superusuario sin usuario ni contraseña.

Reglas del servidor:

- Solo cuenta el paso de 0 a 1: una bandera que se queda en 1 no mantiene la puerta abierta.
- Cada combinación sirve para un solo ingreso.
- Cinco códigos incorrectos bloquean el teclado 5 minutos.
- En la nube el campo `tec` se ignora si no hay `DEVICE_KEY` configurada.

Firmware pendiente: esclavo → detectar la combinación, dibujar el QR y avisar al maestro
(por ejemplo con el mensaje `TEC`); maestro → enviar `"tec": 1` durante 2 minutos.
