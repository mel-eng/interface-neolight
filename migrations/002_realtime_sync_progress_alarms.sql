-- NEOLIGHT migration 002
-- Refuerzo no destructivo para sincronizacion en tiempo real, progreso terapeutico y alarmas persistentes.
-- Ejecutar en la base existente. No borra tablas ni datos.

DELIMITER $$

DROP PROCEDURE IF EXISTS neolight_add_column_if_missing$$
DROP PROCEDURE IF EXISTS neolight_add_index_if_missing$$

CREATE PROCEDURE neolight_add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

CREATE PROCEDURE neolight_add_index_if_missing(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `', p_index, '` ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL neolight_add_column_if_missing('planes_terapia', 'horas_por_dia', '`horas_por_dia` DECIMAL(6,2) NULL AFTER `meta_total_s`');
CALL neolight_add_column_if_missing('planes_terapia', 'modo_programado', '`modo_programado` ENUM(''reposo'',''convencional'',''intensivo'',''automatico'') NULL AFTER `modo_recomendado`');
CALL neolight_add_column_if_missing('planes_terapia', 'sesiones_realizadas', '`sesiones_realizadas` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `tiempo_acumulado_s`');

UPDATE planes_terapia
SET modo_programado = COALESCE(modo_programado, modo_recomendado)
WHERE modo_programado IS NULL;

CALL neolight_add_column_if_missing('alarmas', 'paciente_id', '`paciente_id` INT NULL AFTER `sesion_id`');
CALL neolight_add_column_if_missing('alarmas', 'silenciada', '`silenciada` BOOLEAN NOT NULL DEFAULT FALSE');
CALL neolight_add_column_if_missing('alarmas', 'silenciada_por', '`silenciada_por` INT NULL');
CALL neolight_add_column_if_missing('alarmas', 'silenciada_hasta', '`silenciada_hasta` DATETIME NULL');
CALL neolight_add_index_if_missing('alarmas', 'idx_alarmas_paciente_created', '(`paciente_id`, `created_at`)');
CALL neolight_add_index_if_missing('alarmas', 'idx_alarmas_sesion', '(`sesion_id`)');

UPDATE alarmas SET tipo = 'distancia_fuera_rango' WHERE tipo IN ('distancia_baja','distancia_alta','distancia');
UPDATE alarmas SET tipo = 'sensor_fallo' WHERE tipo IN ('sensor_ultrasonico','sensor_temperatura','sensor');
UPDATE alarmas SET severidad = 'warning' WHERE severidad NOT IN ('info','warning','critical') OR severidad IS NULL;

ALTER TABLE alarmas
  MODIFY tipo ENUM(
    'temperatura_alta','temperatura_baja','distancia_fuera_rango','irradiancia_baja',
    'esp32_desconectado','sesion_interrumpida','modo_no_autorizado','sensor_fallo'
  ) NOT NULL,
  MODIFY severidad ENUM('info','warning','critical') NOT NULL DEFAULT 'warning';

CALL neolight_add_index_if_missing('eventos', 'idx_eventos_paciente_created', '(`paciente_id`, `created_at`)');
ALTER TABLE eventos
  MODIFY tipo ENUM(
    'login','paciente_editado','solicitud_aceptada','solicitud_rechazada',
    'paciente_dado_alta','paciente_archivado','paciente_restaurado','paciente_eliminado_logico',
    'diagnostico_editado','plan_creado','plan_actualizado','plan_completado',
    'inicio_sesion','pausa_sesion','fin_sesion','sesion_interrumpida',
    'solicitud_modo','solicitud_modo_aprobada','solicitud_modo_rechazada',
    'solicitud_control_manual','control_manual_habilitado','control_manual_bloqueado',
    'modo_automatico_habilitado','cambio_modo','cambio_altura','silencio_alarmas',
    'conexion_esp','desconexion_esp','alarma_registrada','sistema'
  ) NOT NULL;

CALL neolight_add_column_if_missing('estado_dispositivo', 'last_heartbeat_at', '`last_heartbeat_at` DATETIME NULL');
CALL neolight_add_column_if_missing('estado_dispositivo', 'puerto', '`puerto` VARCHAR(120) NULL');
CALL neolight_add_column_if_missing('estado_dispositivo', 'url', '`url` VARCHAR(255) NULL');
CALL neolight_add_index_if_missing('estado_dispositivo', 'idx_estado_dispositivo_seen', '(`last_seen_at`)');

CALL neolight_add_index_if_missing('sesiones', 'idx_sesiones_paciente_status', '(`paciente_id`, `status`)');
CALL neolight_add_index_if_missing('sesiones', 'idx_sesiones_plan_status', '(`plan_id`, `status`)');

DROP PROCEDURE neolight_add_column_if_missing;
DROP PROCEDURE neolight_add_index_if_missing;
