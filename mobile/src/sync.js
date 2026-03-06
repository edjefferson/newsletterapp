import { apiFetch } from './api.js';
import { upsertNewsletters, getMaxServerId, setSyncMeta, pruneOldContent } from './db.js';

const OFFLINE_DAYS = 30;

export async function syncFromServer(onProgress = null) {
  const afterId = await getMaxServerId();

  // Only ask the server for newsletters within our offline window
  const since = new Date();
  since.setDate(since.getDate() - OFFLINE_DAYS);
  const sinceParam = since.toISOString();

  let page = 1;
  const pageSize = 50;
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

  // Clear body content from anything older than the window (respects keep_offline flag)
  await pruneOldContent(OFFLINE_DAYS);

  await setSyncMeta('last_sync', new Date().toISOString());
  return total;
}
