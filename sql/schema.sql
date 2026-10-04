-- ============================================================
-- NEOLIGHT — Esquema base (versión NO destructiva)
-- El servidor ejecuta este archivo al arrancar.
-- Solo crea las tablas que falten: nunca borra ni modifica datos.
-- No agregar DROP aquí; el servidor se niega a ejecutarlo si lo encuentra.
-- ============================================================

-- 1. CUENTAS
CREATE TABLE IF NOT EXISTS cuentas (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  usuario      VARCHAR(50)  NOT NULL,
  contrasena   VARCHAR(255) NOT NULL COMMENT 'Hash bcrypt, nunca texto plano',
  rol          ENUM('doctor','tutor','admin') NOT NULL,

  nombre       VARCHAR(80)  NOT NULL,
  apellidos    VARCHAR(120) NOT NULL,
  genero       ENUM('masculino','femenino','otro','no_especificado') NOT NULL DEFAULT 'no_especificado',
  telefono     VARCHAR(30)  NULL,
  correo       VARCHAR(120) NULL,
  estado       ENUM('activo','inactivo') NOT NULL DEFAULT 'activo',

  matricula    VARCHAR(40)  NULL,
  especialidad VARCHAR(80)  NULL,
  parentesco   VARCHAR(60)  NULL,

  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_creacion TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_usuario (usuario),
  UNIQUE KEY uq_correo  (correo),
  KEY ix_rol_estado     (rol, estado),
  KEY ix_nombre         (nombre),
  KEY ix_apellidos      (apellidos)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Usuarios del sistema: doctores, tutores y administradores';

-- 2. PACIENTES
CREATE TABLE IF NOT EXISTS pacientes (
  id                         INT AUTO_INCREMENT PRIMARY KEY,
  codigo                     VARCHAR(20)     NOT NULL,
  nombre                     VARCHAR(80)     NOT NULL,
  apellidos                  VARCHAR(120)    NOT NULL,
  fecha_nac                  DATE            NOT NULL,
  genero                     ENUM('masculino','femenino','no_especificado') NOT NULL DEFAULT 'no_especificado',

  peso_nacimiento_g          DECIMAL(6,2)    NULL,
  peso_actual_g              DECIMAL(6,2)    NULL,
  edad_gestacional_sem       DECIMAL(4,1)    NULL,
  fecha_ingreso              DATE            NOT NULL,
  diagnostico                TEXT            NULL,
  observaciones              TEXT            NULL,

  nivel_bilirrubina_inicial  DECIMAL(5,2)    NULL,
  nivel_bilirrubina_actual   DECIMAL(5,2)    NULL,
  grupo_sanguineo            ENUM('A','B','AB','O') NULL,
  factor_rh                  ENUM('+','-')          NULL,

  doctor_id                  INT             NULL,
  tutor_id                   INT             NULL,

  doctor_request_status      ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  estado_clinico             ENUM('ok','observacion','riesgo','alta') NOT NULL DEFAULT 'ok',
  estado_registro            ENUM('activo','archivado','eliminado_logico') NOT NULL DEFAULT 'activo',

  fecha_alta                 DATETIME        NULL,
  archived_at                DATETIME        NULL,
  deleted_at                 DATETIME        NULL,

  created_at                 TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_codigo            (codigo),
  KEY ix_doctor_id                (doctor_id),
  KEY ix_tutor_id                 (tutor_id),
  KEY ix_estado_clinico           (estado_clinico),
  KEY ix_estado_registro          (estado_registro),
  KEY ix_request_status           (doctor_request_status),
  KEY ix_nombre                   (nombre),
  KEY ix_apellidos                (apellidos),
  KEY ix_doctor_registro          (doctor_id, estado_registro),
  KEY ix_doctor_request_registro  (doctor_id, doctor_request_status, estado_registro),

  CONSTRAINT fk_pac_doctor FOREIGN KEY (doctor_id) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_pac_tutor FOREIGN KEY (tutor_id) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Pacientes neonatales registrados en NEOLIGHT';

-- 3. DOCTOR REQUESTS
CREATE TABLE IF NOT EXISTS doctor_requests (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id  INT NOT NULL,
  doctor_id    INT NOT NULL,
  tutor_id     INT NOT NULL,
  status       ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  respuesta_at DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_doctor_status (doctor_id, status),
  KEY ix_paciente      (paciente_id),
  KEY ix_tutor         (tutor_id),

  CONSTRAINT fk_req_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_req_doctor FOREIGN KEY (doctor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_req_tutor FOREIGN KEY (tutor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Solicitudes de vinculación entre tutor y doctor';

-- 4. PLANES DE TERAPIA
CREATE TABLE IF NOT EXISTS planes_terapia (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id           INT          NOT NULL,
  doctor_id             INT          NOT NULL,

  meta_total_s          INT UNSIGNED NOT NULL COMMENT 'Meta acumulativa efectiva en segundos',
  horas_por_dia         DECIMAL(6,2) NULL COMMENT 'Guía clínica/UI: horas planificadas por día',
  sesiones_por_dia      INT UNSIGNED NULL COMMENT 'Guía/UI: sesiones por día',
  duracion_sesion_min   INT UNSIGNED NULL COMMENT 'Guía/UI: duración estimada por bloque',

  tiempo_acumulado_s    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Tiempo efectivo acumulado',
  sesiones_realizadas   INT UNSIGNED NOT NULL DEFAULT 0,

  modo_recomendado      ENUM('reposo','convencional','intensivo','automatico') NOT NULL DEFAULT 'convencional',
  modo_programado       ENUM('reposo','convencional','intensivo','automatico') NULL,

  fecha_inicio          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_fin             DATETIME     NULL,
  estado                ENUM('activo','completado','pausado','cancelado') NOT NULL DEFAULT 'activo',
  observaciones         TEXT         NULL,

  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY ix_paciente_estado (paciente_id, estado),
  KEY ix_doctor_estado   (doctor_id, estado),

  CONSTRAINT fk_plan_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_plan_doctor FOREIGN KEY (doctor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT chk_plan_tiempos CHECK (meta_total_s > 0 AND tiempo_acumulado_s <= meta_total_s)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Plan acumulativo de fototerapia definido por el doctor';

-- 5. SESIONES
CREATE TABLE IF NOT EXISTS sesiones (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id             INT          NOT NULL,
  plan_id                 INT          NULL,

  fecha                   DATE         NOT NULL,
  hora_inicio             TIME         NOT NULL,
  hora_fin                TIME         NULL,
  started_at              DATETIME     NULL,
  finished_at             DATETIME     NULL,

  duracion_s              INT UNSIGNED NULL,
  tiempo_rango_s          INT UNSIGNED NULL,
  tiempo_fuera_rango_s    INT UNSIGNED NULL,

  modo_programado         ENUM('reposo','convencional','intensivo','automatico') NOT NULL DEFAULT 'reposo',
  modo_final              ENUM('reposo','convencional','intensivo','automatico') NULL,
  tipo_control            ENUM('manual','automatico','doctor') NOT NULL DEFAULT 'automatico',

  intensidad_promedio_pct DECIMAL(5,2) NULL,
  distancia_promedio_cm   DECIMAL(5,1) NULL,
  temp_bebe_promedio_c    DECIMAL(4,2) NULL,
  temp_amb_promedio_c     DECIMAL(4,2) NULL,

  motivo_fin              ENUM('completada','detenida_manual','alarma','desconexion','salida_usuario') NULL,
  status                  ENUM('active','paused','finished','cancelled') NOT NULL DEFAULT 'active',
  observaciones           TEXT         NULL,

  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY ix_paciente_fecha   (paciente_id, fecha),
  KEY ix_plan             (plan_id),
  KEY ix_status           (status),
  KEY ix_paciente_status  (paciente_id, status),
  KEY ix_plan_status      (plan_id, status),
  KEY ix_finished_at      (finished_at),

  CONSTRAINT fk_ses_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ses_plan FOREIGN KEY (plan_id) REFERENCES planes_terapia(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Sesiones individuales de fototerapia';

-- 6. MEDICIONES
CREATE TABLE IF NOT EXISTS mediciones (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  sesion_id          INT          NOT NULL,
  paciente_id        INT          NOT NULL,

  distance_cm        DECIMAL(5,1) NULL,
  temp_bebe_c        DECIMAL(4,2) NULL,
  temp_ambiente_c    DECIMAL(4,2) NULL,
  intensidad_led_pct DECIMAL(5,2) NULL,
  ldr_pct            DECIMAL(5,2) NULL,

  modo_actual        ENUM('reposo','convencional','intensivo','automatico') NULL,
  esp_online         BOOLEAN      NOT NULL DEFAULT TRUE,
  sensor_ultra_fail  BOOLEAN      NOT NULL DEFAULT FALSE,
  sensor_body_fail   BOOLEAN      NOT NULL DEFAULT FALSE,
  sensor_amb_fail    BOOLEAN      NOT NULL DEFAULT FALSE,

  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_sesion_time    (sesion_id, created_at),
  KEY ix_paciente_time  (paciente_id, created_at),
  KEY ix_created_at     (created_at),

  CONSTRAINT fk_med_sesion FOREIGN KEY (sesion_id) REFERENCES sesiones(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_med_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Lecturas periódicas de sensores durante una sesión';

-- 7. ALARMAS
CREATE TABLE IF NOT EXISTS alarmas (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  sesion_id         INT    NULL,
  paciente_id       INT    NOT NULL,

  tipo              ENUM(
                      'distancia_baja','distancia_alta','distancia_fuera_rango',
                      'temperatura_baja','temperatura_alta',
                      'sensor_ultrasonico','sensor_temperatura','sensor_fallo',
                      'irradiancia_baja',
                      'esp_desconectado','esp32_desconectado',
                      'sesion_interrumpida','modo_no_autorizado',
                      'otro'
                    ) NOT NULL,
  severidad         ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  valor_medido      VARCHAR(60)  NULL,
  unidad            VARCHAR(20)  NULL,
  mensaje           VARCHAR(255) NULL,
  accion_tomada     VARCHAR(255) NULL,

  silenciada        BOOLEAN      NOT NULL DEFAULT FALSE,
  silenciada_por    INT          NULL,
  silenciada_hasta  DATETIME     NULL,

  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_sesion_tipo       (sesion_id, tipo),
  KEY ix_paciente          (paciente_id),
  KEY ix_paciente_created  (paciente_id, created_at),
  KEY ix_severidad         (severidad),
  KEY ix_sesion_silenciada (sesion_id, silenciada),
  KEY ix_created_at        (created_at),

  CONSTRAINT fk_ala_sesion FOREIGN KEY (sesion_id) REFERENCES sesiones(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ala_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ala_silenciada_por FOREIGN KEY (silenciada_por) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Alarmas generadas durante sesiones de fototerapia';

-- 8. EVENTOS
CREATE TABLE IF NOT EXISTS eventos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id  INT  NULL,
  sesion_id    INT  NULL,
  cuenta_id    INT  NULL,

  tipo         ENUM(
                 'login','logout','sistema',
                 'inicio_sesion','pausa_sesion','fin_sesion','sesion_interrumpida',
                 'cambio_modo','cambio_altura',
                 'silencio_alarmas','alarma_registrada',
                 'control_manual_habilitado','control_manual_bloqueado',
                 'modo_automatico_habilitado','modo_bloqueado',
                 'paciente_editado','diagnostico_editado',
                 'paciente_dado_alta','paciente_archivado','paciente_restaurado',
                 'paciente_eliminado_logico','paciente_desarchivado',
                 'solicitud_aceptada','solicitud_rechazada',
                 'solicitud_modo','solicitud_modo_aprobada','solicitud_modo_rechazada',
                 'solicitud_control_manual',
                 'plan_creado','plan_actualizado','plan_completado','plan_cancelado',
                 'conexion_esp','desconexion_esp','fallo_esp'
               ) NOT NULL,

  descripcion  TEXT NULL,
  metadata     JSON NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_paciente (paciente_id),
  KEY ix_sesion   (sesion_id),
  KEY ix_cuenta   (cuenta_id),
  KEY ix_tipo     (tipo),
  KEY ix_pac_time (paciente_id, created_at),

  CONSTRAINT fk_ev_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ev_sesion FOREIGN KEY (sesion_id) REFERENCES sesiones(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_ev_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Auditoría y trazabilidad completa del sistema';

-- 9. CONTROL AUTORIZACIONES
CREATE TABLE IF NOT EXISTS control_autorizaciones (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id           INT      NOT NULL,
  doctor_id             INT      NOT NULL,
  tutor_id              INT      NOT NULL,

  modo_control          ENUM('bloqueado','manual','automatico') NOT NULL DEFAULT 'bloqueado',
  manual_habilitado     BOOLEAN  NOT NULL DEFAULT FALSE,
  automatico_habilitado BOOLEAN  NOT NULL DEFAULT FALSE,

  habilitado_desde      DATETIME NULL,
  habilitado_hasta      DATETIME NULL,
  bloqueado_at          DATETIME NULL,
  motivo                VARCHAR(255) NULL,

  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_ctrl (paciente_id, doctor_id, tutor_id),
  KEY ix_doctor       (doctor_id),
  KEY ix_tutor        (tutor_id),
  KEY ix_modo_control (modo_control),

  CONSTRAINT fk_ctrl_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ctrl_doctor FOREIGN KEY (doctor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ctrl_tutor FOREIGN KEY (tutor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Permisos de control otorgados por doctor al tutor';

-- 10. ESTADO DISPOSITIVO
CREATE TABLE IF NOT EXISTS estado_dispositivo (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id       INT      NOT NULL,
  esp_online        BOOLEAN  NOT NULL DEFAULT FALSE,
  estado            ENUM('online','offline','en_sesion','fallo') NOT NULL DEFAULT 'offline',
  last_seen_at      DATETIME NULL,
  last_heartbeat_at DATETIME NULL,
  puerto            VARCHAR(120) NULL,
  url               VARCHAR(255) NULL,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_paciente (paciente_id),
  KEY ix_estado          (estado),
  KEY ix_last_seen       (last_seen_at),

  CONSTRAINT fk_disp_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Estado técnico de conexión del ESP32 por paciente';

-- 11. EQUIPOS (lámparas registradas)
CREATE TABLE IF NOT EXISTS equipos (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  codigo             VARCHAR(40)  NOT NULL,
  descripcion        VARCHAR(255) NULL,
  ubicacion          VARCHAR(120) NULL,
  estado             ENUM('operativo','en_uso','sin_verificar','advertencia','mantenimiento','fuera_servicio','desconectado')
                     NOT NULL DEFAULT 'sin_verificar',
  notas              TEXT         NULL,
  paciente_actual_id INT          NULL COMMENT 'Paciente que está usando la lámpara ahora',
  ultima_prueba_at   DATETIME     NULL,
  last_seen_at       DATETIME     NULL COMMENT 'Última vez que el equipo envió datos',
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_equipo_codigo (codigo),
  KEY ix_equipo_paciente (paciente_actual_id),

  CONSTRAINT fk_equipo_paciente FOREIGN KEY (paciente_actual_id) REFERENCES pacientes(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Inventario de lámparas NEOLIGHT';

-- 12. MANTENIMIENTOS
CREATE TABLE IF NOT EXISTS mantenimientos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  equipo_id     INT          NOT NULL,
  cuenta_id     INT          NULL,
  tipo          ENUM('preventivo','correctivo','inspeccion') NOT NULL DEFAULT 'preventivo',
  resultado     VARCHAR(40)  NOT NULL,
  responsable   VARCHAR(120) NULL,
  observaciones TEXT         NULL,
  detalle       JSON         NULL COMMENT 'Lista de control y datos adicionales',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_mant_equipo_time (equipo_id, created_at),

  CONSTRAINT fk_mant_equipo FOREIGN KEY (equipo_id) REFERENCES equipos(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_mant_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Revisiones preventivas y correctivas de cada equipo';

-- 13. PRUEBAS DE DIAGNÓSTICO
CREATE TABLE IF NOT EXISTS pruebas_diagnostico (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  equipo_id  INT         NOT NULL,
  cuenta_id  INT         NULL,
  tipo       VARCHAR(60) NOT NULL,
  resultado  VARCHAR(60) NOT NULL,
  detalle    JSON        NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_diag_equipo_time (equipo_id, created_at),

  CONSTRAINT fk_diag_equipo FOREIGN KEY (equipo_id) REFERENCES equipos(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_diag_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Pruebas técnicas ejecutadas desde el panel de superusuario';

-- 14. SOLICITUDES DE MODO Y DE CONTROL MANUAL
CREATE TABLE IF NOT EXISTS solicitudes_modo (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  paciente_id  INT NOT NULL,
  doctor_id    INT NOT NULL,
  tutor_id     INT NOT NULL,
  modo         VARCHAR(30) NOT NULL COMMENT 'reposo, convencional, intensivo o manual_control',
  tipo         ENUM('mode_change','manual_control') NOT NULL DEFAULT 'mode_change',
  motivo       VARCHAR(255) NULL,
  status       ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at  DATETIME  NULL,

  KEY ix_sol_doctor_status (doctor_id, status),
  KEY ix_sol_paciente (paciente_id),

  CONSTRAINT fk_sol_paciente FOREIGN KEY (paciente_id) REFERENCES pacientes(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_sol_doctor FOREIGN KEY (doctor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_sol_tutor FOREIGN KEY (tutor_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Solicitudes del tutor que el doctor aprueba o rechaza';

-- 15. SESIONES DE ACCESO (login)
CREATE TABLE IF NOT EXISTS sesiones_login (
  token_hash   CHAR(64)  NOT NULL PRIMARY KEY COMMENT 'SHA-256 del token; el token real nunca se guarda',
  cuenta_id    INT       NOT NULL,
  rol          ENUM('doctor','tutor','admin') NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME  NOT NULL,

  KEY ix_login_cuenta (cuenta_id),
  KEY ix_login_expira (expires_at),

  CONSTRAINT fk_login_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Sesiones iniciadas. Permiten comprobar quién hace cada petición';
