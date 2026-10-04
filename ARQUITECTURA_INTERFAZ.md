# Mapa de la interfaz NEOLIGHT

## Flujo general

1. `main.js` inicia la página, configura la navegación y restaura la sesión guardada.
2. `auth.js` autentica al usuario y determina si entra como tutor, doctor o superusuario.
3. `main.js` carga dinámicamente el dashboard correspondiente.
4. `api.js` centraliza las solicitudes HTTP clínicas compartidas.
5. `socket.js` mantiene la comunicación en tiempo real con Socket.IO.
6. Cada dashboard coordina únicamente su propia vista y delega funciones especializadas a módulos auxiliares.

## JavaScript compartido

| Archivo | Responsabilidad |
|---|---|
| `config.js` | Configuración del cliente, estado global, IDs de roles y utilidades. |
| `api.js` | Llamadas HTTP compartidas por tutor y doctor. |
| `auth.js` | Login, registro, cierre y restauración de sesión para los tres roles. |
| `sessions.js` | Cronómetro e inicio, pausa, finalización y guardado de sesiones. |
| `socket.js` | Telemetría, estado ESP32, notificaciones y comandos en tiempo real. |
| `main.js` | Punto de entrada, navegación y selección del dashboard según el rol. |

## Panel del paciente o tutor

| Archivo | Responsabilidad |
|---|---|
| `patient-dashboard.js` | Coordina el panel, permisos, modos, controles y eventos. |
| `patient-telemetry.js` | Presenta sensores, conserva series y dibuja gráficas. |
| `patient-history.js` | Carga sesiones, eventos y alarmas. |
| `patient-camera.js` | Inicia y detiene el stream y controla errores de cámara. |
| `patient-overlays.js` | Bloqueos visuales y mensajes de estado. |
| `patient-report.js` | Construye e imprime el reporte del paciente. |

## Panel médico

| Archivo | Responsabilidad |
|---|---|
| `doctor-dashboard.js` | Coordina pacientes, solicitudes, ficha clínica y planes. |
| `doctor-analytics.js` | Gráficos de estados, modos y alertas. |
| `doctor-report.js` | Construcción e impresión del reporte médico. |
| `doctor-navigation.js` | Navegación interna y calculadora del plan. |

## Panel de superusuario

El panel se monta dinámicamente dentro de `#superuserMount`, evitando aumentar `index.html` con cientos de líneas adicionales.

| Archivo | Responsabilidad |
|---|---|
| `partials/superuser-dashboard.html` | Estructura semántica de Inicio, Usuarios, Equipos, Diagnóstico y Mantenimiento. |
| `superuser-dashboard.js` | Navegación, renderizado, modales, pruebas técnicas y coordinación general. |
| `superuser-api.js` | Endpoints administrativos y técnicos del superusuario. |
| `superuser-store.js` | Estado de equipos y registros temporales en `localStorage`. |
| `superuser-icons.js` | Íconos SVG reutilizables sin librerías externas. |
| `30-superuser-dashboard.css` | Sistema visual pastel, layout, componentes y diseño responsive. |

### Secciones del superusuario

1. **Inicio:** resumen, equipo activo, calendario de uso, alertas y asignaciones recientes.
2. **Usuarios:** doctores, pacientes, reasignación y estado de cuentas.
3. **Equipos:** ficha de NEOLIGHT-01, NEOLIGHT-02 y equipos locales futuros.
4. **Diagnóstico:** sensores, actuadores, matriz LED, cámara, ventilador y alarmas.
5. **Mantenimiento:** checklist preventivo o correctivo, formulario e historial.

## Backend administrativo

`server.js` incorpora rutas con prefijo `/api/superuser/` protegidas mediante la cabecera `x-superuser-id`. La cuenta se valida en la tabla `cuentas` y debe tener `rol = 'admin'` y `estado = 'activo'`.

Rutas principales:

- `GET /api/superuser/overview`
- `GET /api/superuser/users`
- `POST /api/superuser/patients/:id/reassign`
- `PATCH /api/superuser/doctors/:id/status`
- `GET /api/auth/current?role=superuser`

## CSS

`styles.css` funciona como manifiesto de módulos. El panel nuevo utiliza selectores prefijados con `.su-` para no modificar el aspecto de tutor o doctor.

- `00-foundations.css`: variables, reset y componentes base.
- `01-public-auth.css`: formularios y autenticación.
- `10-doctor-dashboard.css`: estructura principal médica.
- `11-doctor-reports.css`: reportes y analítica médica.
- `20-patient-dashboard.css`: base del panel del tutor.
- `21-clinical-record.css`: ficha clínica.
- `22-patient-layout.css`: distribución del panel del tutor.
- `23-accessibility-theme.css`: tipografía, accesibilidad y paleta.
- `24-patient-final.css`: diseño final del panel.
- `25-patient-responsive.css`: adaptación móvil y refinamientos.
- `30-superuser-dashboard.css`: interfaz pastel del superusuario.

## Cómo explicar la arquitectura durante la evaluación

La aplicación utiliza enrutamiento por roles. `main.js` decide qué panel cargar; `auth.js` conserva y restaura la sesión; `api.js` y `superuser-api.js` aíslan las llamadas HTTP; `socket.js` gestiona el tiempo real; y cada dashboard controla su propia vista. El panel de superusuario se divide en cinco secciones y separa estructura, estilo, lógica, API y almacenamiento temporal. Esta organización permite modificar una función sin mezclarla con las demás y facilita identificar qué archivo interviene en cada proceso.
