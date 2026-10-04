# Reporte de implementación — Panel de superusuario NEOLIGHT

## Objetivo

Añadir un tercer nivel de acceso que combine administración de usuarios y supervisión técnica de las lámparas NeoLight, manteniendo la estética pediátrica pastel del sistema y evitando una pantalla única saturada.

## Resultado visual

Se implementaron cinco ventanas independientes con una barra lateral común:

1. Inicio
2. Usuarios
3. Equipos
4. Diagnóstico
5. Mantenimiento

La interfaz utiliza fondos claros, lavanda, azul pastel, verde menta y rosa suave. Todos los selectores del panel utilizan el prefijo `.su-`, por lo que no alteran los dashboards existentes.

## Funciones implementadas

### Inicio

- indicadores generales;
- selector global de equipo;
- calendario mensual con días de uso, alertas y mantenimiento;
- alertas técnicas recientes;
- reasignaciones recientes;
- estado de conexión del servidor y del equipo.

### Usuarios

- listado de doctores;
- listado de pacientes;
- búsqueda local;
- registro de doctor;
- reasignación de paciente;
- desactivación sin eliminación histórica;
- reasignación obligatoria antes de desactivar un doctor con pacientes;
- reactivación de cuentas.

### Equipos

- NEOLIGHT-01 como equipo principal;
- NEOLIGHT-02 como equipo sin verificar;
- selección del equipo a inspeccionar;
- estado, ubicación, sesiones, horas y última prueba;
- registro local de equipos adicionales.

### Diagnóstico

- lectura de distancia, temperatura corporal, temperatura ambiente y luz;
- modo de prueba con bloqueo inicial;
- controles de movimiento por Socket.IO;
- visualización de niveles LED;
- prueba de cámara;
- control del ventilador;
- prueba sonora local;
- registro local de cada prueba.

### Mantenimiento

- checklist preventivo y correctivo;
- registro de resultado, responsable y observaciones;
- historial por equipo;
- actualización del estado del equipo si una revisión no es aprobada.

## Cambios de autenticación

- Las cuentas con rol `admin` ahora ingresan como `superuser`.
- La sesión guarda el objeto `superuser` de forma independiente al doctor.
- Se añadió restauración de sesión para los tres roles.
- Se añadió un botón de cierre de sesión dentro del panel privado.

## Decisiones de seguridad y trazabilidad

- Los doctores se desactivan en lugar de eliminarse.
- Un doctor con pacientes no puede desactivarse sin elegir un reemplazo.
- Los controles de actuadores y LED permanecen bloqueados hasta activar el modo de prueba.
- NEOLIGHT-02 no habilita controles técnicos mientras permanezca sin verificar.
- No se inventan datos individuales de LDR: si el firmware no los envía, la interfaz muestra `No enviado`.

## Limitaciones conocidas

- Los registros de equipos, diagnósticos y mantenimientos se guardan temporalmente en `localStorage` hasta crear sus tablas MySQL.
- Los niveles LED intermedios requieren un endpoint PWM directo en el firmware.
- La prueba del buzzer físico requiere un comando específico; la versión actual comprueba únicamente el sonido de la interfaz.
- La autenticación sigue el modelo existente basado en IDs enviados en cabeceras. Para producción debe migrarse a sesiones firmadas o tokens.

## Validaciones realizadas

- validación de sintaxis de todos los archivos JavaScript;
- revisión de dos archivos HTML y 291 IDs únicos;
- comprobación de referencias locales;
- prueba de renderizado de las cinco ventanas con datos simulados;
- prueba de navegación entre secciones;
- prueba de habilitación del modo técnico;
- prueba de selección de nivel LED;
- verificación de que tutor y doctor conservan sus rutas y archivos originales.
