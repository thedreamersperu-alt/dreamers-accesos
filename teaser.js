/**
 * Aviso diario "Esto está pasando ahora en el VIP".
 *
 * Reglas:
 *  - Solo mira los mensajes de Gregory (VIP_AUTHOR_ID) en los canales VIP (VIP_CHANNEL_IDS).
 *  - Un solo aviso por día en total (día según TEASER_TZ, por defecto hora Perú/Colombia).
 *  - Siempre necesita TEXTO + IMAGEN:
 *      · los dos en el mismo mensaje → se publica al instante;
 *      · texto y luego imagen (o al revés) en el MISMO canal dentro de TEASER_WINDOW_MIN minutos → se juntan;
 *      · solo texto o solo imagen → no se publica y sigue esperando.
 *  - Publica en TEASER_CHANNEL_ID la captura difuminada con un candado y el botón "Únete ahora".
 */
import sharp from 'sharp';
import {
  Events, ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, MessageFlags,
} from 'discord.js';
import crypto from 'node:crypto';
import db from './db.js';

const AUTHOR_ID = process.env.VIP_AUTHOR_ID || '';
const CHANNEL_IDS = (process.env.VIP_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TARGET_ID = process.env.TEASER_CHANNEL_ID || '';
const JOIN_URL = process.env.TEASER_JOIN_URL || 'https://wa.link/kx9tzz';
const TZ = process.env.TEASER_TZ || 'America/Lima';
const WINDOW_MS = (Number(process.env.TEASER_WINDOW_MIN) || 5) * 60_000;

export const teaserEnabled = Boolean(AUTHOR_ID && CHANNEL_IDS.length && TARGET_ID);

db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS teaser_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, posted_at INTEGER, channel_id TEXT, text TEXT
);
CREATE TABLE IF NOT EXISTS teaser_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, at INTEGER, visitor TEXT
);
CREATE INDEX IF NOT EXISTS idx_teaser_clicks_post ON teaser_clicks(post_id);
`);

/* ---------- Clics del botón "Únete ahora" ---------- */
// El botón pasa por /go/aviso/<id> en tu servidor: se cuenta el clic y se redirige a WhatsApp.
const PUBLIC_URL = (process.env.TEASER_PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');
const BOT_UA = /bot|crawler|spider|preview|discord|facebookexternalhit|whatsapp|slack|telegram/i;

export function recordClick(postId, req) {
  const ua = req.get('user-agent') || '';
  if (BOT_UA.test(ua)) return JOIN_URL; // vistas previas automáticas no cuentan
  const visitor = crypto.createHash('sha256').update(`${req.ip}|${ua}`).digest('hex').slice(0, 16);
  db.prepare('INSERT INTO teaser_clicks (post_id, at, visitor) VALUES (?,?,?)').run(Number(postId) || 0, Date.now(), visitor);
  return JOIN_URL;
}

export function clickStats() {
  const posts = db.prepare(`
    SELECT p.id, p.day, p.posted_at, p.channel_id, p.text,
           COUNT(c.id) AS clicks, COUNT(DISTINCT c.visitor) AS uniques
    FROM teaser_posts p LEFT JOIN teaser_clicks c ON c.post_id = p.id
    GROUP BY p.id ORDER BY p.posted_at DESC LIMIT 120`).all();
  const tot = db.prepare('SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS uniques FROM teaser_clicks').get();
  const week = db.prepare('SELECT COUNT(*) AS n FROM teaser_clicks WHERE at >= ?').get(Date.now() - 7 * 864e5).n;
  return { posts, total: tot.clicks, uniques: tot.uniques, week, avisos: posts.length };
}
const kvGet = db.prepare('SELECT v FROM kv WHERE k=?');
const kvSet = db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
// La marca del día depende del autor y del canal destino: así una prueba no bloquea el aviso real
const DAY_KEY = `teaser_day:${AUTHOR_ID}:${TARGET_ID}`;
const postedToday = () => kvGet.get(DAY_KEY)?.v === today();

const pending = new Map(); // canal -> { text, textAt, image, imageAt, name, avatar }
let posting = false;

const isImage = (a) => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.name || '');

/* ---------- Imagen difuminada con candado ---------- */

const LOCK_SVG = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd257"/><stop offset="1" stop-color="#f0a02a"/>
    </linearGradient>
  </defs>
  <path d="M30 46 V32 a20 20 0 0 1 40 0 V46" fill="none" stroke="#b9c0cc" stroke-width="9" stroke-linecap="round"/>
  <rect x="18" y="44" width="64" height="48" rx="10" fill="url(#g)"/>
  <circle cx="50" cy="63" r="7" fill="#3b2a12"/>
  <rect x="46.5" y="64" width="7" height="15" rx="3" fill="#3b2a12"/>
</svg>`;

async function blurredImage(url) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const base = sharp(buf).rotate().resize({ width: 1100, withoutEnlargement: true });
  const { info: { width, height } } = await base.clone().toBuffer({ resolveWithObject: true });
  const lock = Math.round(Math.min(width, height) * 0.22);
  return base
    .blur(Math.max(12, Math.round(width / 45)))
    .modulate({ brightness: 0.85 })
    .composite([{ input: Buffer.from(LOCK_SVG(lock)), gravity: 'center' }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

/* ---------- Publicar ---------- */

async function publish(client, { text, image, name, channel: p_channel }) {
  if (posting || postedToday()) return;
  posting = true;
  kvSet.run(DAY_KEY, today()); // se marca antes para no duplicar
  try {
    const file = new AttachmentBuilder(await blurredImage(image), { name: 'vip.jpg' });
    const postId = db.prepare('INSERT INTO teaser_posts (day, posted_at, channel_id, text) VALUES (?,?,?,?)')
      .run(today(), Date.now(), p_channel, text.slice(0, 300)).lastInsertRowid;
    const buttonUrl = PUBLIC_URL ? `${PUBLIC_URL}/go/aviso/${postId}` : JOIN_URL;
    const box = new ContainerBuilder()
      .setAccentColor(0x1f6bff)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('### 🔴 Esto está pasando ahora en el VIP'))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${name}**\n${text.slice(0, 1500)}`))
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://vip.jpg')))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(false))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('**🔥 ¿No quieres perderte lo de hoy?**\nEntra al VIP y ve el análisis completo de Gregory.'));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Únete ahora').setURL(buttonUrl),
    );
    const target = await client.channels.fetch(TARGET_ID);
    await target.send({
      flags: MessageFlags.IsComponentsV2,
      components: [box, row],
      files: [file],
      allowedMentions: { parse: [] },
    });
    pending.clear();
    console.log(`[aviso VIP] publicado en #${target.name}`);
  } catch (e) {
    kvSet.run(DAY_KEY, ''); // si falló, se puede volver a intentar hoy
    console.error('[aviso VIP] no se pudo publicar:', e?.message);
  } finally {
    posting = false;
  }
}

/* ---------- Escuchar a Gregory ---------- */

export function setupTeaser(client) {
  if (!teaserEnabled) {
    console.log('[aviso VIP] desactivado (faltan VIP_AUTHOR_ID, VIP_CHANNEL_IDS o TEASER_CHANNEL_ID)');
    return;
  }
  console.log(`[aviso VIP] activo: vigilando ${CHANNEL_IDS.length} canales`);

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author?.id !== AUTHOR_ID || !CHANNEL_IDS.includes(msg.channelId)) return;
    if (posting || postedToday()) return;

    const now = Date.now();
    const text = (msg.content || '').trim();
    const img = [...msg.attachments.values()].find(isImage);
    const name = msg.member?.displayName || msg.author.globalName || msg.author.username;

    const p = pending.get(msg.channelId) || {};
    if (text) Object.assign(p, { text, textAt: now });
    if (img) Object.assign(p, { image: img.url, imageAt: now });
    p.name = name;
    p.channel = msg.channelId;
    pending.set(msg.channelId, p);

    // ¿Hay texto e imagen, y están a menos de N minutos uno del otro?
    if (p.text && p.image && Math.abs(p.textAt - p.imageAt) <= WINDOW_MS) {
      console.log(`[aviso VIP] texto + imagen de ${name} en <#${msg.channelId}>, publicando…`);
      await publish(client, p);
    } else {
      console.log(`[aviso VIP] ${name} envió ${text ? 'texto' : ''}${text && img ? ' + ' : ''}${img ? 'imagen' : ''}${!text && !img ? 'otro contenido' : ''}; esperando la otra parte`);
    }
  });
}
