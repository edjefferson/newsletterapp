import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { getNewsletters, getSyncMeta } from '../db.js';
import { syncFromServer } from '../sync.js';

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
  const diff = Date.now() - d;
  const days = Math.floor(diff / 86400000);
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
  app.innerHTML = `
    <header>
      <div class="container header-inner">
        <h1>Newsletters</h1>
        <button class="theme-btn" id="theme-btn">Dark</button>
        <button class="btn-primary" id="sync-btn">Sync</button>
      </div>
    </header>
    <main class="container">
      <div class="filter-bar">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="unread">Unread</button>
      </div>
      <div class="status-bar" id="status"></div>
      <ul class="list" id="list"></ul>
    </main>
  `;

  const listEl = document.getElementById('list');
  const statusEl = document.getElementById('status');
  const syncBtn = document.getElementById('sync-btn');
  const filterBtns = document.querySelectorAll('.filter-btn');

  let filter = 'all';
  let page = 1;
  let hasMore = true;
  let loading = false;
  const PAGE_SIZE = 50;

  async function loadPage(p) {
    if (loading) return;
    loading = true;
    try {
      const items = await getNewsletters({ unread: filter === 'unread', page: p, pageSize: PAGE_SIZE });
      if (p === 1) {
        listEl.innerHTML = '';
        if (!items.length) {
          listEl.innerHTML = '<li class="empty">No newsletters. Tap Sync to fetch.</li>';
          statusEl.textContent = '';
          hasMore = false;
          return;
        }
      }
      items.forEach(n => {
        const li = document.createElement('li');
        li.className = `list-item${n.is_read ? ' read' : ''}`;
        li.innerHTML = `
          <span class="unread-dot${n.is_read ? ' hidden' : ''}"></span>
          <span class="list-item-body">
            <span class="list-item-subject">${esc(n.subject)}</span>
            <span class="list-item-sender">${esc(n.sender)}</span>
          </span>
          <span class="list-item-date">${formatDate(n.received_at)}</span>`;
        li.addEventListener('click', () => { window.location.hash = `#/reader/${n.id}`; });
        listEl.appendChild(li);
      });
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
    page = 1; hasMore = true;
    loadPage(1);
  }));

  window.addEventListener('scroll', () => {
    if (!hasMore || loading) return;
    if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 200) loadPage(page + 1);
  });

  async function doSync() {
    const net = await Network.getStatus();
    if (!net.connected) { statusEl.textContent = 'Offline — showing cached newsletters.'; return; }
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<span class="spinner"></span>Syncing…';
    try {
      const count = await syncFromServer(n => { statusEl.textContent = `Synced ${n}…`; });
      statusEl.textContent = count > 0 ? `${count} new newsletters` : 'Up to date';
      await loadPage(1);
    } catch (err) {
      statusEl.textContent = `Sync failed: ${err.message}`;
    } finally {
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
