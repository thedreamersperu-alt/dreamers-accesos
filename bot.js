import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import * as db from './db.js';

const GUILD_ID = process.env.GUILD_ID;
const REMINDER_DAYS = Number(process.env.REMINDER_DAYS ?? 3);
const RENEW_TEXT = process.env.RENEW_TEXT || '';

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

let ready = false;
export const isReady = () => ready;

export function guild() {
  const g = client.guilds.cache.get(GUILD_ID);
  if (!g) throw new Error('El bot no está en el servidor configurado (GUILD_ID).');
  return g;
}

const memberName = (m) => m.displayName || m.user.globalName || m.user.username;

/* ---------- Miembros y roles ---------- */

export function searchMembers(text = '', limit = 50) {
  const g = guild();
  const t = text.trim().toLowerCase();
  const out = [];
  for (const m of g.members.cache.values()) {
    if (m.user.bot) continue;
    if (t) {
      const hay = [m.user.username, m.user.globalName, m.nickname, m.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(t)) continue;
    }
    out.push({
      id: m.id,
      name: memberName(m),
      username: m.user.username,
      avatar: m.user.displayAvatarURL({ size: 64 }),
      roles: m.roles.cache.filter((r) => r.id !== g.id).map((r) => r.id),
    });
    if (out.length >= limit) break;
  }
  return { results: out, total: g.members.cache.filter((m) => !m.user.bot).size };
}

export function listRoles() {
  const g = guild();
  return g.roles.cache
    .filter((r) => r.id !== g.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.hexColor === '#000000' ? null : r.hexColor,
      // editable = el bot puede darlo/quitarlo (está por debajo del rol del bot y no es de una integración)
      assignable: r.editable && !r.managed,
      members: r.members.size,
    }));
}

/* ---------- Dar / quitar ---------- */

export async function grantRoles({ userIds, roleIds, expiresAt, note }) {
  const g = guild();
  const roles = roleIds.map((id) => g.roles.cache.get(id)).filter(Boolean);
  const blocked = roles.filter((r) => !r.editable || r.managed);
  if (blocked.length) {
    throw new Error(`El bot no puede gestionar: ${blocked.map((r) => r.name).join(', ')}. ` +
      'Sube el rol del bot por encima de esos roles en Ajustes del servidor > Roles.');
  }
  if (!roles.length) throw new Error('No se seleccionó ningún rol válido.');

  const results = [];
  for (const uid of userIds) {
    try {
      const member = await g.members.fetch(uid);
      await member.roles.add(roles, note ? `Panel: ${note}` : 'Acceso temporal (panel)');
      let renewed = 0;
      for (const r of roles) {
        const res = db.upsertGrant({
          user_id: member.id, user_name: memberName(member),
          role_id: r.id, role_name: r.name,
          granted_at: Date.now(), expires_at: expiresAt ?? null, note: note || null,
        });
        if (res.renewed) renewed++;
      }
      results.push({ userId: uid, name: memberName(member), ok: true, renewed });
    } catch (e) {
      results.push({ userId: uid, ok: false, error: friendlyError(e) });
    }
  }
  return results;
}

/** Quita el rol de un acceso y lo cierra con el estado indicado. */
export async function closeGrant(grant, status) {
  const g = guild();
  try {
    const member = await g.members.fetch(grant.user_id);
    if (member.roles.cache.has(grant.role_id)) {
      await member.roles.remove(grant.role_id,
        status === 'expired' ? 'Acceso vencido' : 'Acceso revocado desde el panel');
    }
  } catch (e) {
    // 10007 = Unknown Member (salió del servidor), 10011 = Unknown Role (rol borrado): igual se cierra
    if (e?.code !== 10007 && e?.code !== 10011) {
      db.setError(grant.id, friendlyError(e));
      throw e;
    }
  }
  db.endGrant(grant.id, status);
}

function friendlyError(e) {
  if (e?.code === 10007) return 'El usuario no está en el servidor';
  if (e?.code === 50013) return 'Faltan permisos: el rol del bot debe estar por encima';
  return e?.message || String(e);
}

/* ---------- Tareas automáticas ---------- */

async function expireDue() {
  for (const grant of db.dueGrants(Date.now())) {
    try {
      await closeGrant(grant, 'expired');
      console.log(`[vence] ${grant.user_name} pierde ${grant.role_name}`);
    } catch (e) {
      console.error(`[vence] error con acceso #${grant.id}:`, e.message);
    }
  }
}

async function sendReminders() {
  if (!REMINDER_DAYS) return;
  const now = Date.now();
  const list = db.grantsToRemind(now, now + REMINDER_DAYS * 864e5);
  const byUser = new Map();
  for (const gr of list) byUser.set(gr.user_id, [...(byUser.get(gr.user_id) || []), gr]);

  for (const [userId, items] of byUser) {
    const lines = items.map((i) => `• **${i.role_name}** vence <t:${Math.floor(i.expires_at / 1000)}:F> (<t:${Math.floor(i.expires_at / 1000)}:R>)`);
    try {
      const user = await client.users.fetch(userId);
      await user.send(`Hola 👋 tu acceso en **${guild().name}** está por vencer:\n${lines.join('\n')}\n\n${RENEW_TEXT}`.trim());
    } catch { /* DMs cerrados: se ignora */ }
    items.forEach((i) => db.markReminded(i.id));
  }
}

let ticking = false;
async function tick() {
  if (!ready || ticking) return;
  ticking = true;
  try {
    await expireDue();
    await sendReminders();
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    ticking = false;
  }
}

/* ---------- Comando /mi-acceso para alumnos ---------- */

const commands = [
  new SlashCommandBuilder()
    .setName('mi-acceso')
    .setDescription('Mira tus accesos activos y cuándo vencen'),
  new SlashCommandBuilder()
    .setName('acceso')
    .setDescription('Ver los accesos activos de un alumno (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('alumno').setDescription('Alumno').setRequired(true)),
].map((c) => c.toJSON());

function describeAccess(userId) {
  const items = db.activeByUser(userId);
  if (!items.length) return 'No hay accesos temporales activos.';
  return items.map((i) => i.expires_at
    ? `• **${i.role_name}** — vence <t:${Math.floor(i.expires_at / 1000)}:F> (<t:${Math.floor(i.expires_at / 1000)}:R>)`
    : `• **${i.role_name}** — sin vencimiento`).join('\n');
}

client.on(Events.InteractionCreate, async (it) => {
  if (!it.isChatInputCommand()) return;
  if (it.commandName === 'mi-acceso') {
    await it.reply({ content: describeAccess(it.user.id), flags: MessageFlags.Ephemeral });
  } else if (it.commandName === 'acceso') {
    const u = it.options.getUser('alumno', true);
    await it.reply({ content: `**${u.username}**\n${describeAccess(u.id)}`, flags: MessageFlags.Ephemeral });
  }
});

/* ---------- Arranque ---------- */

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot conectado como ${c.user.tag}`);
  const g = guild();
  console.log(`Cargando miembros de "${g.name}"...`);
  await g.members.fetch();
  console.log(`${g.memberCount} miembros cargados.`);
  try {
    await g.commands.set(commands);
  } catch (e) {
    console.warn('No se pudieron registrar los comandos /:', e.message);
  }
  ready = true;
  await tick();
  setInterval(tick, 60_000);
});

export function startBot() {
  if (!process.env.DISCORD_TOKEN || !GUILD_ID) {
    console.error('Falta DISCORD_TOKEN o GUILD_ID en .env');
    return;
  }
  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    console.error('No se pudo conectar el bot:', e.message);
  });
}
