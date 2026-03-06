/* ── Shared helpers ── */

const BASE = "";

async function apiFetch(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const diff = now - d;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  let currentFilter = "all"; // "all" | "unread"
  const PAGE_SIZE = 50;
  let currentPage = 1;
  let hasMore = true;
  let loading = false;

  function renderItem(n) {
    const li = document.createElement("li");
    li.className = `list-item${n.is_read ? " read" : ""}`;
    li.dataset.id = n.id;
    li.innerHTML = `
      <span class="unread-dot${n.is_read ? " hidden" : ""}"></span>
      <span class="list-item-body">
        <span class="list-item-subject">${escHtml(n.subject)}</span>
        <span class="list-item-sender">${escHtml(n.sender)}</span>
      </span>
      <span class="list-item-date">${formatDate(n.received_at)}</span>`;
    li.addEventListener("click", () => { window.location.href = `/reader/${n.id}`; });
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

      // Auto-resize iframe to content height
      function resizeIframe() {
        const h = iframe.contentDocument.documentElement.scrollHeight;
        iframe.style.height = h + "px";
      }
      iframe.addEventListener("load", resizeIframe);
      setTimeout(resizeIframe, 200); // fallback

      // Restore scroll on the outer window
      if (scrollPos > 0) window.scrollTo(0, scrollPos);

      // Track scroll on outer window
      window.addEventListener(
        "scroll",
        debounce(() => {
          scrollPos = window.scrollY;
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
        body: JSON.stringify({ scroll_position: pos, is_read: read }),
      });
    } catch (_) { /* silent */ }
  }

  function updateMarkReadBtn(read) {
    markReadBtn.textContent = read ? "Read" : "Mark read";
    markReadBtn.className = `mark-read-btn${read ? " is-read" : ""}`;
  }

  markReadBtn.addEventListener("click", () => {
    saveProgress(scrollPos, !isRead);
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
  // Inject a base style for comfortable reading inside the iframe
  const style = `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           font-size: 15px; line-height: 1.6; color: #1a1a1a; padding: 20px;
           max-width: 700px; margin: 0 auto; }
    img { max-width: 100%; height: auto; }
    a { color: #2563eb; }
  </style>`;
  // Strip <script> and on* attrs simply via regex (BSoup handled server-side already)
  return style + html;
}

/* ── Bootstrap ── */

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("newsletter-list")) initIndex();
  if (document.getElementById("reader-root")) initReader();
});
