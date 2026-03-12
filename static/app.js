/* ── Shared helpers ── */

const BASE = "";

function getToken() { return localStorage.getItem("auth_token"); }
function setToken(t) { localStorage.setItem("auth_token", t); }
function clearToken() { localStorage.removeItem("auth_token"); }

function requireAuth() {
  if (!getToken() && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { headers, ...options });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today - msgDay) / 86400000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ── Index page ── */

async function initIndex() {
  const listEl = document.getElementById("newsletter-list");
  const statusEl = document.getElementById("status");
  const syncBtn = document.getElementById("sync-btn");
  const filterBtns = document.querySelectorAll(".filter-btn");

  let currentFilter = "unread"; // "all" | "unread"
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let hasMore = true;
  let loading = false;

  function renderItem(n) {
    const li = document.createElement("li");
    li.className = `list-item${n.is_read ? " read" : ""}`;
    li.dataset.id = n.id;
    const isFuture = new Date(n.received_at) > new Date();
    li.innerHTML = `
      <span class="unread-dot${n.is_read ? " hidden" : n.scroll_position > 0 ? " in-progress" : ""}"></span>
      <span class="list-item-body">
        <span class="list-item-subject">${escHtml(n.subject)}</span>
        <span class="list-item-sender">${escHtml(n.sender)}</span>
      </span>
      <span class="list-item-date${isFuture ? " future" : ""}">${formatDate(n.received_at)}</span>`;
    li.addEventListener("click", () => {
      li.classList.add("read");
      li.querySelector(".unread-dot")?.classList.add("hidden");
      window.location.href = `/reader/${n.id}`;
    });
    return li;
  }

  async function loadPage(page) {
    if (loading) return;
    loading = true;
    if (page === 1) statusEl.textContent = "Loading…";
    try {
      const unreadParam = currentFilter === "unread" ? "&unread=true" : "";
      const newsletters = await apiFetch(
        `/api/newsletters?page=${page}&page_size=${PAGE_SIZE}${unreadParam}`
      );
      if (page === 1) {
        listEl.innerHTML = "";
        if (newsletters.length === 0) {
          listEl.innerHTML = `<li class="empty">No newsletters yet. Press Sync to fetch from Gmail.</li>`;
          hasMore = false;
          statusEl.textContent = "";
          return;
        }
      }
      newsletters.forEach((n) => listEl.appendChild(renderItem(n)));
      hasMore = newsletters.length === PAGE_SIZE;
      currentPage = page;
      statusEl.textContent = `${listEl.querySelectorAll(".list-item").length} newsletters${hasMore ? "+" : ""}`;
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loading = false;
    }
  }

  async function loadList() {
    currentPage = 1;
    hasMore = true;
    await loadPage(1);
  }

  // Infinite scroll
  window.addEventListener("scroll", () => {
    if (!hasMore || loading) return;
    if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 200) {
      loadPage(currentPage + 1);
    }
  });

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      loadList();
    });
  });

  let syncPollInterval = null;

  function stopSyncSpinner(msg) {
    clearInterval(syncPollInterval);
    syncPollInterval = null;
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync";
    if (msg) statusEl.textContent = msg;
  }

  async function pollSyncStatus() {
    try {
      const s = await apiFetch("/api/sync/status");
      if (!s.running) {
        if (s.last_error) {
          stopSyncSpinner(`Sync failed: ${s.last_error}`);
        } else {
          stopSyncSpinner(`Sync complete — ${s.last_inserted ?? 0} new`);
        }
        await loadList();
      }
    } catch (err) {
      stopSyncSpinner(`Sync error: ${err.message}`);
    }
  }

  syncBtn.addEventListener("click", async () => {
    if (syncPollInterval) return; // already running
    try {
      const result = await apiFetch("/api/sync", { method: "POST" });
      if (result.status === "already_running") {
        statusEl.textContent = "Sync already in progress…";
      }
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<span class="spinner"></span>Syncing…`;
      syncPollInterval = setInterval(pollSyncStatus, 3000);
    } catch (err) {
      statusEl.textContent = `Sync failed: ${err.message}`;
    }
  });

  await loadList();

  initSettingsMenu(async (btn, panel) => {
    btn.disabled = true;
    btn.textContent = "Marking…";
    try {
      const result = await apiFetch("/api/newsletters/mark-old-read", { method: "POST" });
      btn.textContent = `Marked ${result.marked} as read`;
      setTimeout(() => {
        btn.textContent = "Mark older than 1 week as read";
        btn.disabled = false;
        panel.classList.remove("open");
      }, 2000);
      await loadList();
    } catch (err) {
      btn.textContent = "Failed — try again";
      btn.disabled = false;
    }
  });

  // Re-fetch if browser restores this page from bfcache (e.g. after back navigation from reader)
  window.addEventListener("pageshow", (e) => { if (e.persisted) loadList(); });

  // Re-fetch when the tab regains focus (e.g. read something on mobile, switch back to web tab)
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadList(); });
}

/* ── Reader page ── */

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function initReader() {
  const newsletterId = window.location.pathname.split("/").pop();
  const subjectEl = document.getElementById("subject");
  const senderEl = document.getElementById("sender");
  const dateEl = document.getElementById("date");
  const frameWrap = document.getElementById("frame-wrap");
  const markReadBtn = document.getElementById("mark-read-btn");
  const headerTitle = document.getElementById("header-title");

  let isRead = false;
  let scrollPos = 0;

  try {
    const n = await apiFetch(`/api/newsletters/${newsletterId}`);
    document.title = n.subject;
    headerTitle.textContent = n.subject;
    subjectEl.textContent = n.subject;
    senderEl.textContent = n.sender;
    dateEl.textContent = new Date(n.received_at).toLocaleString();
    isRead = n.is_read;
    scrollPos = n.scroll_position || 0;
    updateMarkReadBtn(isRead);

    if (n.body_html) {
      const iframe = document.createElement("iframe");
      iframe.className = "reader-frame";
      iframe.sandbox = "allow-same-origin";
      iframe.scrolling = "no";
      frameWrap.appendChild(iframe);

      // Write HTML into iframe after it's in the DOM
      iframe.contentDocument.open();
      iframe.contentDocument.write(sanitizeHtml(n.body_html));
      iframe.contentDocument.close();

      // Intercept link clicks so they open in a new tab instead of being swallowed by the sandbox
      iframe.contentDocument.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', e => {
          const url = a.href;
          if (url.startsWith('http')) {
            e.preventDefault();
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        });
      });

      // Auto-resize iframe to content height
      function resizeIframe() {
        const h = iframe.contentDocument.documentElement.scrollHeight;
        iframe.style.height = h + "px";
      }
      iframe.addEventListener("load", resizeIframe);
      setTimeout(() => {
        resizeIframe();
        if (scrollPos > 0) window.scrollTo(0, scrollPos);
        // Short newsletters that fit without scrolling: mark as read immediately
        if (!isRead && window.scrollY + window.innerHeight >= document.body.scrollHeight - 50) {
          saveProgress(0, true);
        }
      }, 300);

      // Track scroll on outer window
      window.addEventListener(
        "scroll",
        debounce(() => {
          scrollPos = Math.floor(window.scrollY);
          const atBottom =
            window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
          saveProgress(scrollPos, atBottom || isRead);
        }, 500)
      );
    } else if (n.body_text) {
      const pre = document.createElement("pre");
      pre.className = "reader-text";
      pre.textContent = n.body_text;
      frameWrap.appendChild(pre);
      if (scrollPos > 0) window.scrollTo(0, scrollPos);
      window.addEventListener("scroll", debounce(() => {
        scrollPos = Math.floor(window.scrollY);
        const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
        saveProgress(scrollPos, atBottom || isRead);
      }, 500));
    } else {
      frameWrap.innerHTML = `<p class="empty">No content available.</p>`;
    }
  } catch (err) {
    frameWrap.innerHTML = `<p class="empty">Failed to load newsletter: ${escHtml(err.message)}</p>`;
  }

  async function saveProgress(pos, read) {
    isRead = read;
    updateMarkReadBtn(read);
    try {
      await apiFetch(`/api/newsletters/${newsletterId}/progress`, {
        method: "POST",
        body: JSON.stringify({ scroll_position: Math.floor(pos), is_read: read }),
      });
    } catch (_) { /* silent */ }
  }

  function updateMarkReadBtn(read) {
    markReadBtn.textContent = read ? "Read" : "Mark read";
    markReadBtn.className = `mark-read-btn${read ? " is-read" : ""}`;
  }

  markReadBtn.addEventListener("click", async () => {
    await saveProgress(scrollPos, !isRead);
  });

  document.getElementById("back-btn").addEventListener("click", async () => {
    // Check atBottom in case debounce hasn't fired yet
    const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
    await saveProgress(scrollPos, isRead || atBottom);
    history.length > 1 ? history.back() : (location.href = "/");
  });
}

/* ── Utilities ── */

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeHtml(html) {
  const dark = document.body.classList.contains("dark");
  // Inject a base style for comfortable reading inside the iframe.
  // Always use light colours — dark mode is handled by CSS invert() on the iframe element.
  const style = `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           font-size: 15px; line-height: 1.6; color: #1a1a1a;
           background: #ffffff;
           padding: 10px; max-width: 700px; margin: 0 auto; }
    img, table { max-width: 100% !important; }
    img { height: auto; ${dark ? "filter: invert(1) hue-rotate(180deg);" : ""} }
    td, th { word-break: break-word; }
    a { color: #2563eb; }
    body { overflow-x: hidden; }
  </style>`;
  // Strip <script> and on* attrs simply via regex (BSoup handled server-side already)
  return style + html;
}

/* ── Login page ── */

async function initLogin() {
  if (getToken()) { window.location.href = "/"; return; }

  const pwInput = document.getElementById("password");
  const pwToggle = document.getElementById("pw-toggle");
  const eyeIcon = document.getElementById("eye-icon");
  const eyeOffPath = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>`;
  const eyeOnPath = `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`;

  pwToggle.addEventListener("click", () => {
    const visible = pwInput.type === "text";
    pwInput.type = visible ? "password" : "text";
    eyeIcon.innerHTML = visible ? eyeOnPath : eyeOffPath;
    pwToggle.setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const password = document.getElementById("password").value;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 401) { errorEl.textContent = "Wrong password."; return; }
      if (!res.ok) { errorEl.textContent = `Server error (${res.status}) — check APP_PASSWORD and SECRET_KEY are set.`; return; }
      const data = await res.json();
      setToken(data.token);
      window.location.href = "/";
    } catch {
      errorEl.textContent = "Login failed. Try again.";
    }
  });
}

/* ── Dark mode ── */

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = dark ? "Light" : "Dark";
}

function initSettingsMenu(onMarkOldRead) {
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("settings-panel");
  if (!settingsBtn || !settingsPanel) return;

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove("open");
    }
  });

  const markOldReadBtn = document.getElementById("mark-old-read-btn");
  if (markOldReadBtn && onMarkOldRead) {
    markOldReadBtn.addEventListener("click", () => onMarkOldRead(markOldReadBtn, settingsPanel));
  }
}

function initTheme() {
  let savedDark;
  try {
    const saved = localStorage.getItem("theme");
    savedDark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    savedDark = false;
  }
  applyTheme(savedDark);
  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      const nowDark = !document.body.classList.contains("dark");
      try { localStorage.setItem("theme", nowDark ? "dark" : "light"); } catch {}
      applyTheme(nowDark);
    });
  }
}

/* ── Bootstrap ── */

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  if (document.getElementById("login-form")) { initLogin(); return; }
  requireAuth();
  if (document.getElementById("newsletter-list")) initIndex();
  if (document.getElementById("reader-root")) initReader();
});
