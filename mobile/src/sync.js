import { apiFetch } from './api.js';
import {
  upsertNewsletters, getMaxServerId, setSyncMeta, pruneOldContent, getPendingProgress, markProgressSynced,
  applyServerProgress, getFeedPosition, setFeedPosition, getFeed,
} from './db.js';

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

// Push the local feed position if it hasn't reached the server yet. The server ignores it
// if another device has saved a newer one.
export async function pushFeedPosition() {
  const pos = await getFeedPosition();
  if (!pos?.dirty) return;
  try {
    await apiFetch('/api/feed/position', {
      method: 'PUT',
      body: JSON.stringify({ newsletter_id: pos.newsletter_id, offset: pos.offset, updated_at: pos.updated_at }),
    });
    const latest = await getFeedPosition();
    // Only clear the flag if the reader hasn't moved on while the request was in flight
    if (latest?.updated_at === pos.updated_at) await setFeedPosition({ ...latest, dirty: false });
  } catch {
    // Offline — stays dirty, retried on next sync
  }
}

// Adopt the server's position if it's newer than ours (e.g. read further on the web).
// Skipped while ours has unsent progress, or if that newsletter isn't downloaded yet
// (the next full sync brings it down and adopts the position then).
export async function pullFeedPosition() {
  try {
    const server = await apiFetch('/api/feed/position');
    if (!server?.saved) return;
    const local = await getFeedPosition();
    if (local?.dirty) return;
    if (!(await getFeed(server.newsletter_id, 'forward', 1, true)).length) return;
    // With no unsent progress here, our position is the last one we saved or adopted,
    // so a server save with a different timestamp came from another device. (Comparing
    // which is later would depend on the two devices' clocks agreeing.)
    // (Compared as instants: the server returns e.g. ".242000Z" for our ".242Z".)
    if (!local || new Date(server.updated_at).getTime() !== new Date(local.updated_at).getTime()) {
      await setFeedPosition({
        newsletter_id: server.newsletter_id,
        offset: server.offset,
        updated_at: server.updated_at,
        dirty: false,
      });
    }
  } catch {
    // Non-fatal
  }
}

export async function syncFromServer(onProgress = null) {
  await flushPendingProgress();
  await pushFeedPosition();

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
  await pullFeedPosition();

  // Clear body content from anything older than the window (respects keep_offline flag)
  await pruneOldContent(OFFLINE_DAYS);

  await setSyncMeta('last_sync', new Date().toISOString());
  return total;
}
