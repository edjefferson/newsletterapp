import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { getNewsletters, getSyncMeta, markOldNewslettersRead } from '../db.js';
import { syncFromServer } from '../sync.js';
import { apiFetch } from '../api.js';

async function getTheme() {
  const { value } = await Preferences.get({ key: 'theme' });
  return value;
}
async function setTheme(value) {
  await Preferences.set({ key: 'theme', value });
}
async function initTheme() {
  const saved = await getTheme();
  let dark;
  try {
    dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    dark = false;
  }
  applyTheme(dark);
}
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = dark ? 'Light' : 'Dark';
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today - msgDay) / 86400000);
  if (days < 0) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function renderList(app) {
  const gearSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  app.innerHTML = `
    <header>
      <div class="container header-inner">
        <h1>Newsletters</h1>
        <div class="settings-menu-wrap">
          <button class="settings-btn" id="settings-btn" aria-label="Settings">${gearSvg}</button>
          <div class="settings-panel" id="settings-panel">
            <div class="settings-row">
              <span class="settings-row-label">Appearance</span>
              <button class="theme-toggle-btn" id="theme-btn">Dark</button>
            </div>
            <div class="settings-divider"></div>
            <button class="settings-action-btn" id="mark-old-read-btn">Mark older than 1 week as read</button>
          </div>
        </div>
        <button class="btn-primary" id="sync-btn">Sync</button>
      </div>
    </header>
    <main class="container">
      <div class="filter-bar">
        <button class="filter-btn active" data-filter="unread">Unread</button>
        <button class="filter-btn" data-filter="all">All</button>
      </div>
      <div class="status-bar" id="status"></div>
      <ul class="list" id="list"></ul>
    </main>
  `;

  const listEl = document.getElementById('list');
  const statusEl = document.getElementById('status');
  const syncBtn = document.getElementById('sync-btn');
  const filterBtns = document.querySelectorAll('.filter-btn');

  let filter = 'unread';
  let page = 1;
  let hasMore = true;
  let loading = false;
  const PAGE_SIZE = 50;
  const cacheKey = () => `nl_list_cache_${filter}`;

  function renderItem(n) {
    const li = document.createElement('li');
    li.className = `list-item${n.is_read ? ' read' : ''}`;
    const isFuture = new Date(n.received_at) > new Date();
    li.innerHTML = `
      <span class="unread-dot${n.is_read ? ' hidden' : n.scroll_position > 0 ? ' in-progress' : ''}"></span>
      <span class="list-item-body">
        <span class="list-item-subject">${esc(n.subject)}</span>
        <span class="list-item-sender">${esc(n.sender)}</span>
      </span>
      <span class="list-item-date${isFuture ? ' future' : ''}">${formatDate(n.received_at)}</span>`;
    li.addEventListener('click', () => {
      li.classList.add('read');
      li.querySelector('.unread-dot')?.classList.add('hidden');
      window.location.hash = `#/reader/${n.id}`;
    });
    return li;
  }

  // Render cached items instantly so back-navigation feels immediate
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey()) || '[]');
    if (cached.length > 0) {
      const frag = document.createDocumentFragment();
      cached.forEach(n => frag.appendChild(renderItem(n)));
      listEl.appendChild(frag);
      statusEl.textContent = `${cached.length} newsletter${cached.length !== 1 ? 's' : ''}`;
    }
  } catch (_) {}

  async function loadPage(p) {
    if (loading) return;
    loading = true;
    try {
      const items = await getNewsletters({ unread: filter === 'unread', page: p, pageSize: PAGE_SIZE });
      if (p === 1) {
        window.scrollTo(0, 0);
        listEl.innerHTML = '';
        if (!items.length) {
          sessionStorage.removeItem(cacheKey());
          listEl.innerHTML = '<li class="empty">No newsletters. Tap Sync to fetch.</li>';
          statusEl.textContent = '';
          hasMore = false;
          return;
        }
        try { sessionStorage.setItem(cacheKey(), JSON.stringify(items)); } catch (_) {}
        const frag = document.createDocumentFragment();
        items.forEach(n => frag.appendChild(renderItem(n)));
        listEl.appendChild(frag);
      } else {
        items.forEach(n => listEl.appendChild(renderItem(n)));
      }
      hasMore = items.length === PAGE_SIZE;
      page = p;
      const count = listEl.querySelectorAll('.list-item').length;
      statusEl.textContent = `${count} newsletter${count !== 1 ? 's' : ''}${hasMore ? '+' : ''}`;
    } finally {
      loading = false;
    }
  }

  filterBtns.forEach(btn => btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    sessionStorage.removeItem(cacheKey());
    listEl.innerHTML = '';
    page = 1; hasMore = true;
    loadPage(1);
  }));

  const listCtrl = new AbortController();
  const { signal } = listCtrl;

  window.addEventListener('scroll', () => {
    if (!hasMore || loading) return;
    if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 200) loadPage(page + 1);
  }, { signal });

  let syncing = false;
  async function doSync() {
    if (syncing) return;
    syncing = true;
    const net = await Network.getStatus();
    if (!net.connected) { statusEl.textContent = 'Offline — showing cached newsletters.'; syncing = false; return; }
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<span class="spinner"></span>Syncing…';
    try {
      const count = await syncFromServer(n => { statusEl.textContent = `Synced ${n}…`; });
      statusEl.textContent = count > 0 ? `${count} new newsletters` : 'Up to date';
      await loadPage(1);
    } catch (err) {
      statusEl.textContent = `Sync failed: ${err.message}`;
    } finally {
      syncing = false;
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync';
    }
  }

  syncBtn.addEventListener('click', doSync);

  await initTheme();
  document.getElementById('theme-btn').addEventListener('click', async () => {
    const nowDark = !document.body.classList.contains('dark');
    await setTheme(nowDark ? 'dark' : 'light');
    applyTheme(nowDark);
  });

  // Settings panel
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
    }
  }, { signal });

  const markOldReadBtn = document.getElementById('mark-old-read-btn');
  markOldReadBtn.addEventListener('click', async () => {
    markOldReadBtn.disabled = true;
    markOldReadBtn.textContent = 'Marking…';
    try {
      const localCount = await markOldNewslettersRead(7);
      // Flush to server in background (best effort)
      try { await apiFetch('/api/newsletters/mark-old-read', { method: 'POST' }); } catch {}
      markOldReadBtn.textContent = `Marked ${localCount} as read`;
      setTimeout(() => {
        markOldReadBtn.textContent = 'Mark older than 1 week as read';
        markOldReadBtn.disabled = false;
        settingsPanel.classList.remove('open');
      }, 2000);
      page = 1; hasMore = true;
      await loadPage(1);
    } catch (err) {
      markOldReadBtn.textContent = 'Failed — try again';
      markOldReadBtn.disabled = false;
    }
  });

  // Pull-to-refresh
  const ptr = document.createElement('div');
  ptr.className = 'ptr-indicator';
  ptr.innerHTML = '<div class="ptr-spinner"></div><span class="ptr-label">Pull to refresh</span>';
  document.body.prepend(ptr);
  const ptrLabel = ptr.querySelector('.ptr-label');

  let ptrStartY = 0;
  let ptrActive = false;
  const PTR_THRESHOLD = 72;

  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0) ptrStartY = e.touches[0].clientY;
    else ptrStartY = 0;
  }, { passive: true, signal });

  document.addEventListener('touchmove', e => {
    if (!ptrStartY) return;
    const dy = Math.min(e.touches[0].clientY - ptrStartY, PTR_THRESHOLD * 1.5);
    if (dy <= 0) { ptrStartY = 0; return; }
    const h = Math.min(dy * 0.5, PTR_THRESHOLD);
    ptr.style.height = h + 'px';
    ptrActive = h >= PTR_THRESHOLD * 0.9;
    ptr.classList.toggle('ptr-ready', ptrActive);
    ptrLabel.textContent = ptrActive ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true, signal });

  document.addEventListener('touchend', async () => {
    if (!ptrStartY) return;
    ptrStartY = 0;
    if (ptrActive) {
      ptrActive = false;
      ptr.classList.remove('ptr-ready');
      ptr.classList.add('ptr-loading');
      ptrLabel.textContent = 'Refreshing…';
      await doSync();
      ptr.classList.remove('ptr-loading');
    }
    ptr.style.height = '0';
    ptrLabel.textContent = 'Pull to refresh';
  }, { signal });

  // Abort all document listeners and remove PTR element when navigating away
  window.addEventListener('hashchange', () => {
    listCtrl.abort();
    ptr.remove();
  }, { once: true });

  // Load local data immediately, then sync in background
  await loadPage(1);
  const lastSync = await getSyncMeta('last_sync');
  if (!lastSync) {
    // First launch — prompt sync
    statusEl.textContent = 'First launch — tap Sync to download your newsletters.';
  } else {
    doSync(); // background refresh
  }
}
