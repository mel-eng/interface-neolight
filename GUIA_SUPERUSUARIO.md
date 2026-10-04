# Guía rápida del panel de superusuario NEOLIGHT

## Acceso

El panel se habilita para cuentas con `rol = 'admin'` y `estado = 'activo'` en la tabla `cuentas`. Después de iniciar sesión, el servidor devuelve el rol de interfaz `superuser` y carga automáticamente el panel administrativo.

## Navegación principal

El menú lateral contiene cinco secciones:

1. **Inicio:** resumen general, equipo seleccionado, calendario de uso, alertas y actividad reciente.
2. **Usuarios:** gestión de doctores, pacientes y asignaciones.
3. **Equipos:** consulta y selección de las lámparas registradas.
4. **Diagnóstico:** comprobación de sensores, actuadores, matriz LED, cámara, ventilador y alarmas.
5. **Mantenimiento:** registro preventivo o correctivo e historial técnico.

El selector de equipo ubicado en la barra superior determina sobre qué lámpara se muestran los datos y se ejecutan las pruebas.

## Gestión de doctores y pacientes

### Desactivar un doctor

1. Abra **Usuarios** y seleccione la pestaña **Doctores**.
2. Abra el menú del doctor.
3. Seleccione **Desactivar**.
4. Si tiene pacientes activos, el sistema solicitará un doctor de reemplazo antes de continuar.

La cuenta se conserva como inactiva para mantener la trazabilidad de sesiones y asignaciones anteriores.

### Reasignar un paciente

1. Abra **Usuarios** y seleccione **Pacientes y asignaciones**.
2. Busque al paciente.
3. Presione **Reasignar**.
4. Seleccione el nuevo doctor y confirme.

La operación actualiza la asignación actual y registra la actividad para mostrarla en Inicio.

## Diagnóstico técnico

### Habilitar controles

Los controles técnicos permanecen bloqueados inicialmente. Seleccione un equipo operativo y active **Modo de prueba** antes de ejecutar movimientos o pruebas de iluminación.

### Sensores

La vista utiliza la telemetría disponible para mostrar:

- distancia;
- temperatura corporal;
- temperatura ambiente;
- nivel de luz;
- conectividad de cámara y controladores.

Una lectura ausente se presenta como no enviada; no se generan valores ficticios para completar la interfaz.

### Actuadores

Los botones de movimiento envían comandos mediante Socket.IO. El botón **Detener** debe utilizarse para interrumpir inmediatamente cualquier prueba.

### Matriz LED

- **0 %:** envía el equipo a reposo.
- **100 %:** utiliza el modo intensivo disponible.
- **25 %, 50 % y 75 %:** quedan registrados como selección visual hasta incorporar un comando PWM directo en el firmware.

### Cámara, ventilador y alarma

- La cámara utiliza la URL configurada en `.env`.
- El ventilador utiliza el endpoint de control existente.
- La prueba sonora actual valida la alerta de la interfaz; el buzzer físico necesita un comando dedicado en el firmware.

## Mantenimiento

1. Seleccione el equipo.
2. Elija **Preventivo** o **Correctivo**.
3. Complete el checklist.
4. Ingrese responsable, resultado y observaciones.
5. Guarde el registro.

Mientras no se creen las tablas técnicas, estos registros se conservan localmente en el navegador. Para no perderlos, no elimine los datos del sitio ni utilice navegación privada durante las pruebas.

## Estados de equipo

- **Operativo:** habilitado para diagnóstico y uso.
- **En uso:** existe una sesión activa.
- **Sin verificar:** todavía no se ha comprobado su funcionamiento.
- **Con advertencias:** alguna prueba requiere revisión.
- **En mantenimiento:** temporalmente no disponible.
- **Fuera de servicio:** no debe utilizarse.
- **Sin conexión:** no responde al sistema.

## Verificación antes de una demostración

1. Inicie MySQL.
2. Ejecute `npm install` si las dependencias no están instaladas.
3. Ejecute `npm run check`.
4. Inicie el servidor con `npm start`.
5. Compruebe el acceso desde la computadora.
6. Para otro dispositivo, utilice la IP mostrada por `npm run network` y permita Node.js en el firewall de la red privada.
7. Verifique que ESP32 y cámara estén en la red esperada antes de habilitar el modo de prueba.
