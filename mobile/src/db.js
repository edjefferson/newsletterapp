import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const sqlite = new SQLiteConnection(CapacitorSQLite);
let db = null;

export async function initDB() {
  const isConn = (await sqlite.isConnection('newsletters_db', false)).result;
  if (isConn) {
    db = await sqlite.retrieveConnection('newsletters_db', false);
  } else {
    db = await sqlite.createConnection('newsletters_db', false, 'no-encryption', 1, false);
  }
  await db.open();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS newsletters (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id       INTEGER UNIQUE NOT NULL,
      subject         TEXT NOT NULL DEFAULT '',
      sender          TEXT NOT NULL DEFAULT '',
      received_at     TEXT NOT NULL,
      body_html       TEXT,
      body_text       TEXT,
      is_read         INTEGER DEFAULT 0,
      scroll_position INTEGER DEFAULT 0,
      keep_offline    INTEGER DEFAULT 0
    );
  `);
  // Migration: add columns to existing installs
  await db.execute(`ALTER TABLE newsletters ADD COLUMN keep_offline INTEGER DEFAULT 0`).catch(() => {});
  await db.execute(`ALTER TABLE newsletters ADD COLUMN progress_dirty INTEGER DEFAULT 0`).catch(() => {});
  await db.execute(`ALTER TABLE newsletters ADD COLUMN subtitle TEXT`).catch(() => {});
  await db.execute(`ALTER TABLE newsletters ADD COLUMN author TEXT`).catch(() => {});
  await db.execute(`CREATE INDEX IF NOT EXISTS ix_newsletters_feed ON newsletters (received_at, server_id)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export async function upsertNewsletters(newsletters) {
  if (!newsletters.length) return;
  const statement = `
    INSERT INTO newsletters (server_id, subject, sender, received_at, body_html, body_text, is_read, subtitle, author)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      subject     = excluded.subject,
      sender      = excluded.sender,
      subtitle    = excluded.subtitle,
      author      = excluded.author,
      received_at = excluded.received_at,
      body_html   = COALESCE(excluded.body_html, newsletters.body_html),
      body_text   = COALESCE(excluded.body_text, newsletters.body_text),
      is_read     = CASE WHEN newsletters.progress_dirty = 1 THEN newsletters.is_read ELSE excluded.is_read END
  `;
  await db.executeSet(
    newsletters.map(n => ({
      statement,
      values: [
        n.id, n.subject, n.sender, n.received_at, n.body_html || null, n.body_text || null,
        n.is_read ? 1 : 0, n.subtitle || null, n.author || null,
      ],
    }))
  );
}

export async function getNewsletters({ unread = false, page = 1, pageSize = 50 } = {}) {
  const offset = (page - 1) * pageSize;
  const where = unread ? 'WHERE is_read = 0' : '';
  const result = await db.query(
    `SELECT * FROM newsletters ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  return result.values || [];
}

// Feed rows use the server id as their identity so positions match across devices
function toFeedItem(row) {
  return {
    id: row.server_id,
    subject: row.subject,
    subtitle: row.subtitle,
    sender: row.sender,
    author: row.author,
    received_at: row.received_at,
    body_html: row.body_html,
    body_text: row.body_text,
    is_read: !!row.is_read,
  };
}

// Newsletters in chronological order, relative to an anchor (see static/feed.js `source.load`)
export async function getFeed(anchorServerId, direction = 'forward', limit = 4, includeAnchor = false) {
  const forward = direction === 'forward';
  const order = forward ? 'ASC' : 'DESC';
  let where = '';
  let params = [];
  if (anchorServerId != null) {
    const anchor = (await db.query('SELECT received_at FROM newsletters WHERE server_id = ?', [anchorServerId])).values?.[0];
    if (!anchor) return [];
    const cmp = forward ? '>' : '<';
    const idCmp = includeAnchor ? `${cmp}=` : cmp;
    where = `WHERE received_at ${cmp} ? OR (received_at = ? AND server_id ${idCmp} ?)`;
    params = [anchor.received_at, anchor.received_at, anchorServerId];
  }
  const result = await db.query(
    `SELECT * FROM newsletters ${where} ORDER BY received_at ${order}, server_id ${order} LIMIT ?`,
    [...params, limit]
  );
  const rows = (result.values || []).map(toFeedItem);
  return forward ? rows : rows.reverse();
}

// First newsletter on/after `date`, or the newest one if there's nothing that recent
export async function getFirstServerIdFrom(date) {
  const first = await db.query(
    'SELECT server_id FROM newsletters WHERE received_at >= ? ORDER BY received_at ASC, server_id ASC LIMIT 1',
    [date.toISOString()]
  );
  if (first.values?.length) return first.values[0].server_id;
  const newest = await db.query('SELECT server_id FROM newsletters ORDER BY received_at DESC, server_id DESC LIMIT 1');
  return newest.values?.[0]?.server_id ?? null;
}

export async function getOldestUnreadServerId() {
  const result = await db.query(
    'SELECT server_id FROM newsletters WHERE is_read = 0 ORDER BY received_at ASC, server_id ASC LIMIT 1'
  );
  return result.values?.[0]?.server_id ?? null;
}

export async function markReadByServerId(serverId) {
  await db.run(
    'UPDATE newsletters SET is_read = 1, progress_dirty = 1 WHERE server_id = ?',
    [serverId]
  );
}

export async function getNewsletter(id) {
  const result = await db.query('SELECT * FROM newsletters WHERE id = ?', [id]);
  return result.values?.[0] || null;
}

export async function saveProgress(id, scrollPosition, isRead) {
  await db.run(
    'UPDATE newsletters SET scroll_position = ?, is_read = ?, progress_dirty = 1 WHERE id = ?',
    [scrollPosition, isRead ? 1 : 0, id]
  );
}

export async function getPendingProgress() {
  const result = await db.query(
    'SELECT server_id, scroll_position, is_read FROM newsletters WHERE progress_dirty = 1'
  );
  return result.values || [];
}

export async function markProgressSynced(serverId) {
  await db.run('UPDATE newsletters SET progress_dirty = 0 WHERE server_id = ?', [serverId]);
}

export async function applyServerProgress(updates) {
  if (!updates.length) return;
  // Only overwrite if not dirty (local unsynced change takes priority)
  await db.executeSet(
    updates.map(u => ({
      statement: `UPDATE newsletters SET is_read = ?, scroll_position = ? WHERE server_id = ? AND progress_dirty = 0`,
      values: [u.is_read ? 1 : 0, u.scroll_position, u.server_id],
    }))
  );
}

export async function getMaxServerId() {
  const result = await db.query('SELECT MAX(server_id) as max_id FROM newsletters');
  return result.values?.[0]?.max_id || 0;
}

export async function getSyncMeta(key) {
  const result = await db.query('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return result.values?.[0]?.value || null;
}

export async function setSyncMeta(key, value) {
  await db.run('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, String(value)]);
}

export async function markOldNewslettersRead(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const result = await db.run(
    `UPDATE newsletters SET is_read = 1, progress_dirty = 1
     WHERE is_read = 0 AND received_at < ?`,
    [cutoff.toISOString()]
  );
  return result.changes?.changes ?? 0;
}

// Clears body content from newsletters older than `days` unless keep_offline=1.
// Keeps the row (subject/sender/date) so the list still shows them.
export async function pruneOldContent(days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const result = await db.run(
    `UPDATE newsletters
     SET body_html = NULL, body_text = NULL
     WHERE received_at < ? AND keep_offline = 0
       AND (body_html IS NOT NULL OR body_text IS NOT NULL)`,
    [cutoff.toISOString()]
  );
  return result.changes?.changes ?? 0;
}

// Feed position: { newsletter_id (server id), offset (0–1), anchor (text snippet|null), updated_at (ISO), dirty }
export async function getFeedPosition() {
  const raw = await getSyncMeta('feed_position');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function setFeedPosition(pos) {
  await setSyncMeta('feed_position', JSON.stringify(pos));
}
