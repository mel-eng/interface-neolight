# NEOLIGHT — Interfaz, servidor y panel de superusuario

Sistema web para el prototipo automatizado de fototerapia neonatal NEOLIGHT. Incluye autenticación, panel del tutor, panel médico, panel de superusuario, telemetría en tiempo real con Socket.IO, control del ESP32, sesiones terapéuticas, alarmas y exportación de reportes.

## Roles disponibles

- **Tutor / paciente:** seguimiento de la terapia, visualización de sensores, historial y controles autorizados.
- **Doctor:** gestión clínica de pacientes, planes de terapia, solicitudes y reportes.
- **Superusuario:** administración de doctores y asignaciones, inventario de equipos, diagnóstico técnico y mantenimiento.

## Puesta en marcha

Requisitos: Node.js 20 o superior y MySQL con la base de datos del proyecto.

```bash
npm install
```

Copia `.env.example` como `.env` y configura MySQL, ESP32 y cámara. En Windows:

```bat
copy .env.example .env
```

Inicia el sistema:

```bash
npm start
```

La consola mostrará una dirección local y otra de red. Para abrir la interfaz desde otro teléfono o computadora, ambos dispositivos deben estar conectados a la misma red y debe utilizarse la dirección de red, por ejemplo `http://192.168.1.20:3000`. `localhost` funciona únicamente en la computadora que ejecuta el servidor.

Para consultar las direcciones disponibles:

```bash
npm run network
```

Si otro dispositivo no puede conectarse, permite Node.js en el Firewall de Windows para redes privadas y verifica que la red no tenga aislamiento entre clientes.

## Activar una cuenta de superusuario

El nuevo panel se abre cuando la cuenta tiene el rol `admin`. El archivo `sql/promover_superusuario.sql` contiene una consulta preparada para actualizar una cuenta existente. Debe reemplazarse `TU_USUARIO` por el usuario real antes de ejecutarla.

```sql
UPDATE cuentas
SET rol = 'admin', estado = 'activo'
WHERE usuario = 'TU_USUARIO';
```

No se creó una tabla nueva para esta etapa. El sistema utiliza el rol `admin` que el servidor ya contemplaba.

## Verificación

```bash
npm run check
```

La verificación comprueba:

- sintaxis de todos los archivos JavaScript;
- IDs duplicados en `index.html` y parciales HTML;
- referencias locales de imágenes, scripts y estilos;
- módulos CSS faltantes;
- archivos de interfaz que superen 1.000 líneas.

## Persistencia actual del superusuario

Las funciones se dividieron según los datos que ya existen en MySQL y los que se incorporarán en una etapa posterior:

### Conectado a la base de datos existente

- listado de doctores y pacientes;
- conteos generales;
- reasignación de pacientes;
- activación y desactivación de doctores;
- sesiones, horas de uso y alertas registradas.

### Guardado local temporal

- inventario adicional de equipos;
- historial de diagnóstico técnico;
- registros de mantenimiento;
- actividad administrativa mostrada en Inicio.

Estos registros temporales se guardan en `localStorage` con la clave `neolight_superuser_workspace_v1`. La interfaz ya está preparada para migrarlos a tablas MySQL sin rediseñar las pantallas.

## Integración técnica disponible

- **Sensores:** lee la telemetría real de `/api/telemetry/latest`.
- **Actuadores:** envía comandos mediante Socket.IO durante el modo de prueba.
- **Matriz LED:** 0 % envía reposo y 100 % envía modo intensivo. Los niveles 25 %, 50 % y 75 % quedan preparados visualmente hasta disponer de un endpoint PWM directo en el firmware.
- **Cámara:** utiliza `CAMERA_STREAM_URL` o `CAM_STREAM_URL` del archivo `.env`.
- **Ventilador:** utiliza el endpoint real `/api/fan`.
- **Buzzer:** por ahora ejecuta una prueba sonora en el navegador; el buzzer físico requiere un comando dedicado en el firmware.

## Organización principal

- `server.js`: API principal, MySQL, ESP32 y Socket.IO.
- `public/index.html`: vistas públicas, autenticación y puntos de montaje de dashboards.
- `public/partials/superuser-dashboard.html`: estructura de las cinco ventanas del superusuario.
- `public/js/superuser-dashboard.js`: coordinación e interacción del panel.
- `public/js/superuser-api.js`: llamadas administrativas al backend.
- `public/js/superuser-store.js`: persistencia local temporal.
- `public/js/superuser-icons.js`: biblioteca de íconos SVG.
- `public/css/modules/30-superuser-dashboard.css`: diseño pastel pediátrico y adaptación responsive.
- `ARQUITECTURA_INTERFAZ.md`: mapa detallado para estudiar el sistema.
- `REPORTE_SUPERUSUARIO.md`: alcance, decisiones y pruebas de esta implementación.
- `GUIA_SUPERUSUARIO.md`: instrucciones de uso y preparación para demostraciones.

## Archivos excluidos del repositorio

`node_modules`, `.git`, reportes generados, respaldos y credenciales no deben subirse a GitHub. Las dependencias se reconstruyen con `npm install`.
