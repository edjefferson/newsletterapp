/* ── Feed page (web) ──
 * Relies on the shared helpers from app.js (apiFetch, initSettingsMenu), which loads first.
 */
import { createFeed, createJumpControl, senderName } from "/static/feed.js";

const MODE_KEY = "feed_mode";

function getMode() {
  try { return localStorage.getItem(MODE_KEY) || "scroll"; } catch { return "scroll"; }
}

function setModeLabel(btn, mode) {
  btn.textContent = mode === "pages" ? "Pages" : "Scroll";
}

const source = {
  async getPosition() {
    // /?at=<id> comes from the index: jump there and make it the saved position
    const at = parseInt(new URLSearchParams(location.search).get("at"), 10);
    if (at) {
      history.replaceState(null, "", "/");
      await this.savePosition(at, 0);
      return { newsletter_id: at, offset: 0 };
    }
    return apiFetch("/api/feed/position");
  },
  async savePosition(id, offset) {
    try {
      await apiFetch("/api/feed/position", {
        method: "PUT",
        body: JSON.stringify({ newsletter_id: id, offset, updated_at: new Date().toISOString() }),
      });
    } catch (_) { /* next save will catch up */ }
  },
  load(anchorId, direction, limit, includeAnchor = false) {
    const params = new URLSearchParams({ direction, limit });
    if (anchorId != null) params.set("anchor", anchorId);
    if (includeAnchor) params.set("include_anchor", "true");
    return apiFetch(`/api/feed?${params}`);
  },
  async findFrom(date) {
    const params = new URLSearchParams({ since: date.toISOString(), limit: 1 });
    const [first] = await apiFetch(`/api/feed?${params}`);
    if (first) return first.id;
    // Nothing that recent: go to the newest newsletter
    const [newest] = await apiFetch("/api/feed?direction=backward&limit=1");
    return newest ? newest.id : null;
  },
  async markRead(n) {
    try {
      await apiFetch(`/api/newsletters/${n.id}/progress`, {
        method: "POST",
        body: JSON.stringify({ scroll_position: 0, is_read: true }),
      });
    } catch (_) {}
  },
};

// Run after app.js has applied the theme (its DOMContentLoaded handler is registered first)
document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector("header");
  const headerTitle = document.getElementById("header-title");
  const modeBtn = document.getElementById("mode-btn");

  let mode = getMode();
  setModeLabel(modeBtn, mode);

  const feed = createFeed(document.getElementById("feed-root"), source, {
    mode,
    topInset: () => header.getBoundingClientRect().height,
    onCurrent: (n) => {
      headerTitle.textContent = senderName(n.sender);
      document.title = n.subject;
    },
  });

  modeBtn.addEventListener("click", () => {
    mode = mode === "pages" ? "scroll" : "pages";
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    setModeLabel(modeBtn, mode);
    feed.setMode(mode);
  });

  const settingsPanel = document.getElementById("settings-panel");
  settingsPanel.appendChild(createJumpControl(async (date) => {
    settingsPanel.classList.remove("open");
    await feed.jumpToDate(date);
  }));

  initSettingsMenu();

  feed.ready.catch((err) => {
    document.getElementById("feed-root").innerHTML =
      `<p class="empty">Failed to load feed: ${escHtml(err.message)}</p>`;
  });
});
