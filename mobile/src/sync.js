import { apiFetch } from './api.js';
import { upsertNewsletters, getMaxServerId, setSyncMeta, pruneOldContent, getPendingProgress, markProgressSynced, applyServerProgress } from './db.js';

const OFFLINE_DAYS = 30;

async function flushPendingProgress() {
  const pending = await getPendingProgress();
  await Promise.all(pending.map(async row => {
    try {
      await apiFetch(`/api/newsletters/${row.server_id}/progress`, {
        method: 'POST',
        body: JSON.stringify({ scroll_position: Math.floor(row.scroll_position), is_read: !!row.is_read }),
      });
      await markProgressSynced(row.server_id);
    } catch {
      // Still offline — leave dirty, will retry next sync
    }
  }));
}

async function pullProgressUpdates() {
  try {
    const updates = await apiFetch('/api/newsletters/progress');
    await applyServerProgress(updates);
  } catch {
    // Non-fatal — progress will sync next time
  }
}

export async function syncFromServer(onProgress = null) {
  await flushPendingProgress();

  const afterId = await getMaxServerId();

  // Only ask the server for newsletters within our offline window
  const since = new Date();
  since.setDate(since.getDate() - OFFLINE_DAYS);
  const sinceParam = since.toISOString();

  let page = 1;
  const pageSize = 200;
  let total = 0;

  while (true) {
    const newsletters = await apiFetch(
      `/api/newsletters?page=${page}&page_size=${pageSize}&full=true&after_id=${afterId}&since=${sinceParam}`
    );

    if (!newsletters.length) break;

    await upsertNewsletters(newsletters);
    total += newsletters.length;
    if (onProgress) onProgress(total);

    if (newsletters.length < pageSize) break;
    page++;
  }

  // Fetch all server-unread newsletters and upsert any missing from local DB.
  // This catches unread items that predate the offline window or the initial install.
  // We fetch summary only (no full=true) to avoid large payloads for old content.
  try {
    let unreadPage = 1;
    while (true) {
      const unread = await apiFetch(
        `/api/newsletters?page=${unreadPage}&page_size=200&unread=true`
      );
      if (!unread.length) break;
      await upsertNewsletters(unread);
      if (unread.length < pageSize) break;
      unreadPage++;
    }
  } catch {
    // Non-fatal — unread backfill will retry next sync
  }

  // Pull server read states last so they overwrite anything set by upsertNewsletters
  await pullProgressUpdates();

  // Clear body content from anything older than the window (respects keep_offline flag)
  await pruneOldContent(OFFLINE_DAYS);

  await setSyncMeta('last_sync', new Date().toISOString());
  return total;
}
