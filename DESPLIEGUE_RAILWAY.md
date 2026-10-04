# Subir NEOLIGHT a Railway

## Qué cambió en el proyecto para la nube

- `server.js` lee la base de datos desde `MYSQL_URL` (Railway) o desde `DB_HOST`, `DB_USER`... (tu `.env` local). Local sigue funcionando igual.
- Al arrancar, el servidor crea las tablas que falten usando `sql/schema.sql`. Nunca borra datos.
- Las horas se guardan en hora de Bolivia aunque el servidor esté en otro país.
- `package-lock.json` corregido: 48 paquetes apuntaban a un registro privado inaccesible y la instalación habría fallado.
- `railway.json` indica a Railway cómo arrancar y cómo comprobar que el servidor está vivo.

## Paso 1 — Actualizar GitHub

Desde la carpeta del proyecto:

```bash
git rm -r --cached node_modules .env
git add -A
git commit -m "Preparar NEOLIGHT para Railway"
git push
```

La primera línea deja de subir `node_modules` y `.env`; no los borra de tu computadora.

## Paso 2 — Crear el proyecto en Railway

1. New Project → Deploy from GitHub repo → `interface-neolight`.
2. En el mismo proyecto: Create → Database → MySQL.
3. En el servicio de la interfaz → Variables, agregar:

| Variable | Valor |
|---|---|
| `MYSQL_URL` | `${{MySQL.MYSQL_URL}}` |
| `HOSPITAL_CODE` | un código nuevo, distinto al que estaba en GitHub |
| `DEVICE_KEY` | una clave larga inventada; la misma se pone en el firmware del maestro |

   No agregar `ESP32_MASTER_URL` ni `PORT`.
4. Settings → Networking → Generate Domain. Ese es el link de la interfaz.

## Paso 3 — Comprobar

- Abrir `https://TU-LINK/api/health` → debe responder `{"ok":true,...}`.
- En Deploy Logs debe aparecer `[DB] Esquema: 10 tabla(s) creada(s).` la primera vez.
- Registrar un doctor y entrar.

## Superusuario en la nube

La base nueva empieza vacía. Para tener superusuario: registrar una cuenta normal y luego, en el servicio MySQL → Data, ejecutar `sql/promover_superusuario.sql` con ese usuario.

## Todavía no funciona en la nube

- Telemetría y comandos de la lámpara: el servidor ya está listo (ver `PROTOCOLO_EQUIPO.md`); falta actualizar el firmware del maestro.
- Cámara: sigue siendo solo local.
