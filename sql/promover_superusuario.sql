-- NEOLIGHT: convertir una cuenta existente en superusuario.
-- Reemplaza TU_USUARIO antes de ejecutar.

UPDATE cuentas
SET rol = 'admin', estado = 'activo'
WHERE usuario = 'TU_USUARIO';

SELECT id, usuario, rol, nombre, apellidos, estado
FROM cuentas
WHERE usuario = 'TU_USUARIO';
