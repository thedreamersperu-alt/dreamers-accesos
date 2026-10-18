# Dreamers · Accesos Discord

Bot + panel web para dar roles temporales a los alumnos. Al vencer la fecha, el bot quita los roles solo.

## Qué hace
- Busca entre **todos** los miembros del servidor (nombre, usuario o ID).
- Da uno, varios o **todos** los roles a uno o varios alumnos a la vez.
- Plazo: 7/15/30/60/90 días, 6 meses, 1 año, sin vencimiento o fecha exacta.
- **Paquetes** guardados (ej. Gold, Platinum, Centurion) con sus roles y días.
- Si le das de nuevo un rol que ya tiene activo, **renueva** la fecha (no duplica).
- Revisa cada minuto: quita los roles vencidos y avisa por DM al alumno X días antes.
- Pestaña de activos: +7 d, +30 d, cambiar fecha o quitar al instante.
- Historial de accesos vencidos/revocados.
- Comandos en Discord: `/mi-acceso` (el alumno ve cuándo vence) y `/acceso @alumno` (staff).

## 1. Crear el bot
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → *Reset Token* → copia el token.
3. En **Bot**, activa **Server Members Intent**.
4. **OAuth2 → URL Generator**: marca `bot` y `applications.commands`; en permisos marca **Manage Roles**. Abre el link e invítalo a tu servidor.
5. **Importante:** en *Ajustes del servidor → Roles*, arrastra el rol del bot **por encima** de todos los roles que quieras que asigne.

## 2. Configurar
```bash
cp .env.example .env
```
Rellena `DISCORD_TOKEN`, `GUILD_ID` (clic derecho al servidor → Copiar ID, con Modo desarrollador activado) y `ADMIN_PASSWORD`.

## 3. Ejecutar
Requiere Node 18+.
```bash
npm install
npm start
```
Abre `http://localhost:3000`.

## 4. Dejarlo 24/7
El bot tiene que estar encendido siempre para quitar los roles a tiempo (si se apaga, al volver quita los que vencieron mientras tanto). Opciones:
- **Railway / Render**: sube la carpeta, pon las variables del `.env` y añade un volumen persistente para `data.db` (`DB_PATH=/data/data.db`).
- **VPS** (Hostinger, DigitalOcean, Contabo): `npm install -g pm2 && pm2 start src/index.js --name accesos && pm2 save`.

Con dominio y HTTPS, pon `COOKIE_SECURE=true`.

Respaldos: todo está en `data.db`; copia ese archivo.
