import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as bot from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

/* ---------- Sesión simple con contraseña ---------- */

const SESSION_MS = 7 * 864e5;
const sessions = new Map(); // token -> vence
const failures = new Map(); // ip -> { n, until }

const cookieOf = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

  if (!process.env.ADMIN_PASSWORD || !safeEqual(req.body?.password || '', process.env.ADMIN_PASSWORD)) {
    const n = (f?.n || 0) + 1;
    failures.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60e3 : 0 });
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(cookieOf(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const t = cookieOf(req, 'sid');
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'No autorizado' });
  next();
});

app.use('/api', (req, res, next) => {
  if (!bot.isReady()) return res.status(503).json({ error: 'El bot aún se está conectando a Discord...' });
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

/* ---------- API ---------- */

app.get('/api/status', wrap((req, res) => {
  const g = bot.guild();
  res.json({ guild: g.name, icon: g.iconURL({ size: 64 }), stats: db.stats() });
}));

app.get('/api/members', wrap((req, res) => res.json(bot.searchMembers(req.query.q || '', 60))));
app.get('/api/roles', wrap((req, res) => res.json(bot.listRoles())));

app.post('/api/grants', wrap(async (req, res) => {
  const { userIds, roleIds, expiresAt, note } = req.body || {};
  if (!Array.isArray(userIds) || !userIds.length) throw new Error('Selecciona al menos un alumno.');
  if (!Array.isArray(roleIds) || !roleIds.length) throw new Error('Selecciona al menos un rol.');
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new Error('La fecha de vencimiento debe ser futura.');
  }
  res.json({ results: await bot.grantRoles({ userIds, roleIds, expiresAt: expiresAt ?? null, note }) });
}));

app.get('/api/grants', wrap((req, res) => {
  res.json(req.query.status === 'history' ? db.historyGrants() : db.activeGrants());
}));

app.patch('/api/grants/:id', wrap((req, res) => {
  const g = db.getGrant(Number(req.params.id));
  if (!g || g.status !== 'active') throw new Error('Acceso no encontrado o ya cerrado.');
  let { expiresAt, addDays } = req.body || {};
  if (addDays) expiresAt = Math.max(g.expires_at || Date.now(), Date.now()) + Number(addDays) * 864e5;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new Error('La fecha debe ser futura.');
  }
  db.setExpiry(g.id, expiresAt);
  res.json({ ok: true, expiresAt });
}));

app.delete('/api/grants/:id', wrap(async (req, res) => {
  const g = db.getGrant(Number(req.params.id));
  if (!g || g.status !== 'active') throw new Error('Acceso no encontrado o ya cerrado.');
  await bot.closeGrant(g, 'revoked');
  res.json({ ok: true });
}));

app.get('/api/packs', wrap((req, res) => res.json(db.listPacks())));
app.post('/api/packs', wrap((req, res) => {
  const { name, roleIds, days } = req.body || {};
  if (!name?.trim() || !roleIds?.length) throw new Error('El paquete necesita nombre y roles.');
  db.savePack(name.trim(), roleIds, days ? Number(days) : null);
  res.json({ ok: true });
}));
app.delete('/api/packs/:id', wrap((req, res) => { db.deletePack(Number(req.params.id)); res.json({ ok: true }); }));

/* ---------- Panel ---------- */

app.use(express.static(path.join(__dirname, '..', 'public')));

export function startServer() {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Panel en http://localhost:${port}`));
}
