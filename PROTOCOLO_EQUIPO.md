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

    HTTPS://NEOLIGHT.UP.RAILWAY.APP/T

(en mayúsculas para que el QR sea pequeño y entre en la pantalla; el servidor lo
redirige a `/#tecnico`).

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

El esclavo avisa al maestro con `TEC_ON` (lo repite cada 5 s) y `TEC_OFF` al cerrar el QR.

## Peso de la cuna

La cuna se conecta al WiFi `NEOLIGHT` y llama una vez por segundo a
`http://192.168.4.1/peso?g=<gramos>`. El maestro lo incluye en su telemetría como
`"peso_g"` (o `null` si no llegó peso en los últimos 8 s).


## Fotos de la cámara

La ESP32-S3-CAM sigue conectada al WiFi `NEOLIGHT` (IP 192.168.4.50) y sale a internet a
través del maestro, que comparte su conexión (NAPT). Manda cada foto con:

    POST https://neolight.up.railway.app/api/cam/frame
    Content-Type: image/jpeg
    x-device-key: <DEVICE_KEY>
    (cuerpo: el JPEG)

El servidor responde `{"ok":true,"ms":500}`: `ms` es cuánto debe esperar la cámara antes de
la siguiente foto (500 con terapia en curso, 1000 en reposo; variables `CAM_MS_TERAPIA` y
`CAM_MS_REPOSO`). Si pasan 6 s sin fotos, la interfaz muestra "sin cámara".

La interfaz pide la última foto en `GET /api/cam/latest.jpg` (requiere sesión).
Ajustes de imagen de la cámara (luz azul): `http://192.168.4.50/ajuste`, desde el WiFi NEOLIGHT.


## Verificación del antifaz

El servidor analiza las fotos de la cámara. Si confirma peligro (ojos visibles, antifaz
ausente, nariz cubierta) envía `MODO=REPOSO` y `BEEP` por el canal normal de órdenes.

Además, con la supervisión activada y terapia en curso, cada respuesta a la telemetría
incluye `VIGIA=15`. El maestro debe recibirlo de forma continua: si pasan 15 s sin
`VIGIA` durante una terapia, pasa solo a reposo (se cayó internet, el servidor o la
verificación). `VIGIA=0` desarma el vigía (supervisión desactivada). Mientras el servidor
no lo arme por primera vez tras encender, el vigía no actúa: sin internet la lámpara
funciona como siempre.

Después de un apagado por seguridad nada vuelve a encender la lámpara de forma
automática: lo hace una persona desde la interfaz o el panel.
