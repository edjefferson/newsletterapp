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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export async function upsertNewsletters(newsletters) {
  const sql = `
    INSERT INTO newsletters (server_id, subject, sender, received_at, body_html, body_text, is_read)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      subject     = excluded.subject,
      sender      = excluded.sender,
      received_at = excluded.received_at,
      body_html   = COALESCE(excluded.body_html, newsletters.body_html),
      body_text   = COALESCE(excluded.body_text, newsletters.body_text),
      is_read     = CASE WHEN newsletters.progress_dirty = 1 THEN newsletters.is_read ELSE excluded.is_read END
  `;
  for (const n of newsletters) {
    await db.run(sql, [
      n.id,
      n.subject,
      n.sender,
      n.received_at,
      n.body_html || null,
      n.body_text || null,
      n.is_read ? 1 : 0,
    ]);
  }
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
  for (const u of updates) {
    // Only overwrite if not dirty (local unsynced change takes priority)
    await db.run(
      `UPDATE newsletters SET is_read = ?, scroll_position = ?
       WHERE server_id = ? AND progress_dirty = 0`,
      [u.is_read ? 1 : 0, u.scroll_position, u.server_id]
    );
  }
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
