import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH || 'data.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS grants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  role_id     TEXT NOT NULL,
  role_name   TEXT,
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,              -- NULL = sin vencimiento
  status      TEXT NOT NULL DEFAULT 'active',  -- active | expired | revoked
  reminded    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  ended_at    INTEGER,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_status_exp ON grants(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_grants_user ON grants(user_id);

CREATE TABLE IF NOT EXISTS packs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  role_ids  TEXT NOT NULL,          -- JSON array
  days      INTEGER                 -- duración sugerida (opcional)
);
`);

const q = {
  activeFor: db.prepare(`SELECT * FROM grants WHERE user_id=? AND role_id=? AND status='active'`),
  insert: db.prepare(`INSERT INTO grants (user_id,user_name,role_id,role_name,granted_at,expires_at,note)
                      VALUES (@user_id,@user_name,@role_id,@role_name,@granted_at,@expires_at,@note)`),
  setExpiry: db.prepare(`UPDATE grants SET expires_at=?, reminded=0, note=COALESCE(?,note), last_error=NULL WHERE id=?`),
  get: db.prepare(`SELECT * FROM grants WHERE id=?`),
  end: db.prepare(`UPDATE grants SET status=?, ended_at=?, last_error=NULL WHERE id=?`),
  setError: db.prepare(`UPDATE grants SET last_error=? WHERE id=?`),
  due: db.prepare(`SELECT * FROM grants WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?`),
  toRemind: db.prepare(`SELECT * FROM grants WHERE status='active' AND reminded=0 AND expires_at IS NOT NULL
                        AND expires_at>? AND expires_at<=?`),
  markReminded: db.prepare(`UPDATE grants SET reminded=1 WHERE id=?`),
  activeList: db.prepare(`SELECT * FROM grants WHERE status='active' ORDER BY (expires_at IS NULL), expires_at`),
  history: db.prepare(`SELECT * FROM grants WHERE status!='active' ORDER BY ended_at DESC LIMIT ?`),
  activeByUser: db.prepare(`SELECT * FROM grants WHERE status='active' AND user_id=? ORDER BY expires_at`),
  stats: db.prepare(`SELECT
      SUM(status='active') AS active,
      COUNT(DISTINCT CASE WHEN status='active' THEN user_id END) AS students,
      COUNT(DISTINCT CASE WHEN status='active' AND expires_at IS NOT NULL AND expires_at <= ? THEN user_id END) AS expiring
    FROM grants`),
  packs: db.prepare(`SELECT * FROM packs ORDER BY name`),
  packUpsert: db.prepare(`INSERT INTO packs (name, role_ids, days) VALUES (?,?,?)
                          ON CONFLICT(name) DO UPDATE SET role_ids=excluded.role_ids, days=excluded.days`),
  packDelete: db.prepare(`DELETE FROM packs WHERE id=?`),
};

/** Crea el acceso o, si ya hay uno activo para ese alumno+rol, actualiza su vencimiento. */
export const upsertGrant = db.transaction((g) => {
  const existing = q.activeFor.get(g.user_id, g.role_id);
  if (existing) {
    q.setExpiry.run(g.expires_at, g.note || null, existing.id);
    return { id: existing.id, renewed: true };
  }
  const info = q.insert.run({ note: null, ...g });
  return { id: info.lastInsertRowid, renewed: false };
});

export const getGrant = (id) => q.get.get(id);
export const setExpiry = (id, expiresAt) => q.setExpiry.run(expiresAt, null, id);
export const endGrant = (id, status) => q.end.run(status, Date.now(), id);
export const setError = (id, msg) => q.setError.run(String(msg).slice(0, 300), id);
export const dueGrants = (now) => q.due.all(now);
export const grantsToRemind = (now, until) => q.toRemind.all(now, until);
export const markReminded = (id) => q.markReminded.run(id);
export const activeGrants = () => q.activeList.all();
export const historyGrants = (limit = 300) => q.history.all(limit);
export const activeByUser = (userId) => q.activeByUser.all(userId);
export const stats = (days = 3) => q.stats.get(Date.now() + days * 864e5);

export const listPacks = () => q.packs.all().map((p) => ({ ...p, role_ids: JSON.parse(p.role_ids) }));
export const savePack = (name, roleIds, days) => q.packUpsert.run(name, JSON.stringify(roleIds), days ?? null);
export const deletePack = (id) => q.packDelete.run(id);

export default db;
