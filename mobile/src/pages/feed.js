import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { createFeed, createJumpControl, senderName } from '../../../static/feed.js';
import {
  getFeed, getFeedPosition, setFeedPosition, getOldestUnreadServerId, getFirstServerIdFrom, markReadByServerId,
  markProgressSynced, getSyncMeta,
} from '../db.js';
import { apiFetch } from '../api.js';
import { syncFromServer, pushFeedPosition } from '../sync.js';
import { initTheme, applyTheme, setTheme } from './list.js';

const gearSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

async function getMode() {
  const { value } = await Preferences.get({ key: 'feed_mode' });
  return value || 'scroll';
}

const source = {
  async getPosition() {
    const pos = await getFeedPosition();
    if (pos?.newsletter_id != null) return pos;
    const first = await getOldestUnreadServerId();
    return first != null ? { newsletter_id: first, offset: 0 } : null;
  },
  async savePosition(id, offset) {
    await setFeedPosition({ newsletter_id: id, offset, updated_at: new Date().toISOString(), dirty: true });
    pushFeedPosition(); // best effort; stays dirty for the next sync if offline
  },
  load(anchorId, direction, limit, includeAnchor = false) {
    return getFeed(anchorId, direction, limit, includeAnchor);
  },
  findFrom(date) {
    return getFirstServerIdFrom(date);
  },
  async markRead(n) {
    await markReadByServerId(n.id);
    try {
      await apiFetch(`/api/newsletters/${n.id}/progress`, {
        method: 'POST',
        body: JSON.stringify({ scroll_position: 0, is_read: true }),
      });
      await markProgressSynced(n.id);
    } catch {
      // Offline — flushed on next sync
    }
  },
};

export async function renderFeed(app) {
  app.innerHTML = `
    <header>
      <div class="container header-inner">
        <button class="btn-ghost" id="index-btn">Index</button>
        <h1 id="header-title">Newsletters</h1>
        <div class="settings-menu-wrap">
          <button class="settings-btn" id="settings-btn" aria-label="Settings">${gearSvg}</button>
          <div class="settings-panel" id="settings-panel">
            <div class="settings-row">
              <span class="settings-row-label">Appearance</span>
              <button class="theme-toggle-btn" id="theme-btn">Dark</button>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Reading</span>
              <button class="theme-toggle-btn" id="mode-btn">Scroll</button>
            </div>
            <div class="settings-divider"></div>
            <button class="settings-action-btn" id="sync-btn">Sync now</button>
          </div>
        </div>
      </div>
    </header>
    <main class="container" id="feed-root"></main>
  `;

  await initTheme();

  const header = app.querySelector('header');
  const headerTitle = document.getElementById('header-title');
  const modeBtn = document.getElementById('mode-btn');
  const syncBtn = document.getElementById('sync-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');

  let mode = await getMode();
  modeBtn.textContent = mode === 'pages' ? 'Pages' : 'Scroll';

  const feed = createFeed(document.getElementById('feed-root'), source, {
    mode,
    topInset: () => header.getBoundingClientRect().height,
    openLink: (url) => window.open(url, '_system'),
    onCurrent: (n) => { headerTitle.textContent = senderName(n.sender); },
  });

  const pageCtrl = new AbortController();
  window.addEventListener('hashchange', () => {
    pageCtrl.abort();
    feed.destroy();
  }, { once: true });

  document.getElementById('index-btn').addEventListener('click', () => {
    window.location.hash = '#/list';
  });

  document.getElementById('theme-btn').addEventListener('click', async () => {
    const nowDark = !document.body.classList.contains('dark');
    await setTheme(nowDark ? 'dark' : 'light');
    applyTheme(nowDark);
  });

  modeBtn.addEventListener('click', async () => {
    mode = mode === 'pages' ? 'scroll' : 'pages';
    await Preferences.set({ key: 'feed_mode', value: mode });
    modeBtn.textContent = mode === 'pages' ? 'Pages' : 'Scroll';
    feed.setMode(mode);
  });

  settingsPanel.insertBefore(
    createJumpControl(async (date) => {
      settingsPanel.classList.remove('open');
      await feed.jumpToDate(date);
    }),
    settingsPanel.querySelector('.settings-divider')
  );

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) settingsPanel.classList.remove('open');
  }, { signal: pageCtrl.signal });

  let syncing = false;
  async function doSync() {
    if (syncing) return;
    const net = await Network.getStatus();
    if (!net.connected) return;
    syncing = true;
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    try {
      const count = await syncFromServer();
      syncBtn.textContent = count > 0 ? `${count} new` : 'Up to date';
      await feed.refresh();
    } catch (err) {
      syncBtn.textContent = 'Sync failed';
      console.error(err);
    } finally {
      syncing = false;
      setTimeout(() => { syncBtn.textContent = 'Sync now'; syncBtn.disabled = false; }, 2000);
    }
  }
  syncBtn.addEventListener('click', doSync);

  try {
    await feed.ready;
  } catch (err) {
    document.getElementById('feed-root').innerHTML =
      `<p class="empty" style="padding:24px">Failed to load: ${err.message}</p>`;
  }

  if (!(await getSyncMeta('last_sync'))) {
    // First launch: download everything, then start the feed from the top
    await doSync();
    await feed.jumpTo(null);
  } else {
    // Background refresh. If it brings a newer position from another device (and the
    // reader hasn't moved here meanwhile), reopen the feed there.
    const before = await getFeedPosition();
    await doSync();
    const after = await getFeedPosition();
    if (after && !after.dirty && after.updated_at !== before?.updated_at) await feed.jumpTo(null);
  }
}
