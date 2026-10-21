/* ── Continuous feed view ──
 *
 * Shared by the web app (loaded as an ES module from /static/feed.js) and the
 * Capacitor app (imported and bundled by Vite). All data access goes through a
 * `source` object so each client can back it with the API or local SQLite:
 *
 *   source.getPosition()                 → { newsletter_id, offset } | null
 *   source.savePosition(id, offset)      → persist where the reader is
 *   source.load(anchorId, direction, n, includeAnchor)
 *                                        → newsletters in chronological order
 *                                          ('forward' = after anchor, 'backward' = before;
 *                                           anchorId null + 'forward' = from the start)
 *   source.markRead(newsletter)          → persist read state
 *
 * Options:
 *   mode:       'scroll' | 'pages'
 *   topInset:   () => px hidden under the sticky header
 *   openLink:   (url) => void
 *   onCurrent:  (newsletter) => void   called when the article at the top changes
 */

const BATCH = 4;
const LOAD_MARGIN = 2500; // px from either end before fetching more
const SAVE_DELAY = 800;

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Popbitch <popbitch@substack.com>" → "Popbitch" */
export function senderName(sender) {
  const name = String(sender ?? "").replace(/\s*<[^>]*>\s*$/, "").replace(/^"(.*)"$/, "$1").trim();
  return name || String(sender ?? "");
}

export function articleStyle(dark) {
  // Always light colours — dark mode is handled by CSS invert() on the iframe element.
  return `<style>
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
}

/**
 * Where the reader is: the article under the top of the viewport and how far
 * through it (0–1). `sections` is [{ id, top, height }] in document coordinates.
 */
export function positionAt(sections, viewTop) {
  if (!sections.length) return null;
  let current = sections[0];
  for (const s of sections) {
    if (s.top <= viewTop) current = s;
    else break;
  }
  const offset = current.height > 0 ? (viewTop - current.top) / current.height : 0;
  return { newsletter_id: current.id, offset: Math.min(1, Math.max(0, offset)) };
}

/** Document scroll target for a saved position. */
export function scrollTargetFor(section, offset, inset) {
  return Math.max(0, Math.round(section.top + section.height * offset - inset));
}

/** True once the bottom of an article has come into view. */
export function hasReachedEnd(section, viewBottom) {
  return section.top + section.height <= viewBottom + 4;
}

function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  return d;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString([], {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

export function createFeed(root, source, options = {}) {
  const opts = {
    mode: "scroll",
    topInset: () => 0,
    openLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    onCurrent: () => {},
    ...options,
  };

  const list = document.createElement("div");
  list.className = "feed";
  const topSentinel = document.createElement("div");
  topSentinel.className = "feed-edge";
  const bottomSentinel = document.createElement("div");
  bottomSentinel.className = "feed-edge";
  root.replaceChildren(topSentinel, list, bottomSentinel);

  const items = []; // { n, el } in chronological order
  let atStart = false;
  let atEnd = false;
  let loadingBefore = false;
  let loadingAfter = false;
  let currentId = null;
  let restoring = true;
  let destroyed = false;
  const ctrl = new AbortController();
  const { signal } = ctrl;

  const inset = () => opts.topInset();
  const viewTop = () => window.scrollY + inset();
  const viewBottom = () => window.scrollY + window.innerHeight;

  function sectionBox(item) {
    const r = item.el.getBoundingClientRect();
    return { id: item.n.id, top: r.top + window.scrollY, height: r.height };
  }

  // ── Rendering ──

  function renderBody(n, bodyEl, frameReady) {
    if (n.body_html) {
      const iframe = document.createElement("iframe");
      iframe.className = "reader-frame";
      iframe.sandbox = "allow-same-origin";
      iframe.scrolling = "no";
      iframe.title = n.subject;
      bodyEl.appendChild(iframe);
      const resize = () => {
        const doc = iframe.contentDocument;
        if (doc?.documentElement) iframe.style.height = doc.documentElement.scrollHeight + "px";
      };
      // An iframe only has a document once it's attached, so fill it in after insertion
      frameReady.push(() => {
        const doc = iframe.contentDocument;
        const dark = document.body.classList.contains("dark");
        doc.open();
        doc.write(articleStyle(dark) + n.body_html);
        doc.close();
        doc.querySelectorAll("a[href]").forEach((a) => {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            if (a.href.startsWith("http")) opts.openLink(a.href);
          });
        });
        // Images inside the article load late and change its height
        doc.querySelectorAll("img").forEach((img) => {
          if (!img.complete) img.addEventListener("load", resize, { once: true });
        });
        iframe.addEventListener("load", resize);
        resize();
      });
    } else if (n.body_text) {
      const pre = document.createElement("pre");
      pre.className = "reader-text";
      pre.textContent = n.body_text;
      bodyEl.appendChild(pre);
    } else {
      bodyEl.innerHTML = `<p class="empty" style="padding:24px">Not downloaded. Sync while online to read this one.</p>`;
    }
  }

  function renderItem(n, frameReady) {
    const el = document.createElement("article");
    el.className = `feed-item${n.is_read ? " read" : ""}`;
    el.dataset.id = n.id;
    const from = senderName(n.sender);
    const byline = n.author && n.author !== from ? `${esc(n.author)} · ${esc(from)}` : esc(from);
    el.innerHTML = `
      <div class="reader-meta">
        <div class="reader-subject">${esc(n.subject)}</div>
        ${n.subtitle ? `<div class="reader-subtitle">${esc(n.subtitle)}</div>` : ""}
        <div class="reader-sender">${byline}</div>
        <div class="reader-date">${formatDate(n.received_at)}</div>
      </div>
      <div class="reader-frame-wrap"></div>`;
    renderBody(n, el.querySelector(".reader-frame-wrap"), frameReady);
    return el;
  }

  // Keep what's on screen still when content above it changes height
  // (newly prepended articles, or late-loading images in earlier articles).
  let heights = new WeakMap();
  const resizeObs = new ResizeObserver((entries) => {
    if (restoring) return;
    let delta = 0;
    const top = viewTop();
    for (const entry of entries) {
      const el = entry.target;
      const old = heights.get(el);
      const h = el.getBoundingClientRect().height;
      heights.set(el, h);
      if (old === undefined) continue;
      const elTop = el.getBoundingClientRect().top + window.scrollY;
      if (elTop + old <= top + 1) delta += h - old;
    }
    if (delta) window.scrollBy(0, delta);
  });

  function insert(newItems, where) {
    const frameReady = [];
    const els = newItems.map((n) => ({ n, el: renderItem(n, frameReady) }));
    if (where === "end") {
      els.forEach((it) => list.appendChild(it.el));
      items.push(...els);
      frameReady.forEach((f) => f());
    } else {
      const before = document.documentElement.scrollHeight;
      const frag = document.createDocumentFragment();
      els.forEach((it) => frag.appendChild(it.el));
      list.prepend(frag);
      items.unshift(...els);
      frameReady.forEach((f) => f());
      if (!restoring) window.scrollBy(0, document.documentElement.scrollHeight - before);
    }
    for (const it of els) {
      heights.set(it.el, it.el.getBoundingClientRect().height);
      resizeObs.observe(it.el);
    }
  }

  // ── Loading ──

  async function loadAfter() {
    if (loadingAfter || atEnd || destroyed) return;
    loadingAfter = true;
    try {
      const last = items[items.length - 1];
      const batch = await source.load(last ? last.n.id : null, "forward", BATCH);
      if (destroyed) return;
      if (batch.length < BATCH) atEnd = true;
      if (batch.length) insert(batch, "end");
      bottomSentinel.textContent = atEnd ? "You're all caught up." : "";
    } finally {
      loadingAfter = false;
    }
  }

  async function loadBefore() {
    if (loadingBefore || atStart || destroyed || !items.length) return;
    loadingBefore = true;
    try {
      const batch = await source.load(items[0].n.id, "backward", BATCH);
      if (destroyed) return;
      if (batch.length < BATCH) atStart = true;
      if (batch.length) insert(batch, "start");
      topSentinel.textContent = atStart ? "Start of your newsletters." : "";
    } finally {
      loadingBefore = false;
    }
  }

  function maybeLoadMore() {
    if (restoring) return;
    if (document.documentElement.scrollHeight - viewBottom() < LOAD_MARGIN) loadAfter();
    if (window.scrollY < LOAD_MARGIN) loadBefore();
  }

  // ── Position + read state ──

  const save = debounce((pos) => {
    source.savePosition(pos.newsletter_id, pos.offset);
  }, SAVE_DELAY);

  function update() {
    if (restoring || destroyed || !items.length) return;
    const pos = positionAt(items.map(sectionBox), viewTop());
    if (!pos) return;
    save(pos);
    if (pos.newsletter_id !== currentId) {
      currentId = pos.newsletter_id;
      opts.onCurrent(items.find((it) => it.n.id === currentId).n);
    }
    const bottom = viewBottom();
    for (const it of items) {
      if (it.n.is_read) continue;
      const box = sectionBox(it);
      if (box.top > bottom) break;
      if (hasReachedEnd(box, bottom)) {
        it.n.is_read = true;
        it.el.classList.add("read");
        source.markRead(it.n);
      }
    }
    maybeLoadMore();
  }

  // ── Paging ──

  function pageBy(dir) {
    const step = window.innerHeight - inset() - 48; // keep a couple of lines of overlap
    window.scrollTo({ top: window.scrollY + dir * step, behavior: "instant" });
    update();
  }

  function onKey(e) {
    if (e.target.closest?.("input, textarea, select, button")) return;
    if (opts.mode !== "pages") return;
    if (["ArrowRight", "PageDown", " "].includes(e.key) && !(e.key === " " && e.shiftKey)) {
      e.preventDefault(); pageBy(1);
    } else if (["ArrowLeft", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey)) {
      e.preventDefault(); pageBy(-1);
    }
  }

  let touchX = 0, touchY = 0;
  function onTouchStart(e) {
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }
  function onTouchEnd(e) {
    if (opts.mode !== "pages") return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) pageBy(dx < 0 ? 1 : -1);
  }

  function onPageZoneClick(e) {
    const zone = e.target.closest(".page-zone");
    if (zone) pageBy(zone.dataset.dir === "next" ? 1 : -1);
  }

  const zones = document.createElement("div");
  zones.className = "page-zones";
  zones.innerHTML = `<button class="page-zone" data-dir="prev" aria-label="Previous page"></button>
                     <button class="page-zone" data-dir="next" aria-label="Next page"></button>`;
  document.body.appendChild(zones);
  zones.addEventListener("click", onPageZoneClick, { signal });

  function setMode(mode) {
    opts.mode = mode;
    document.body.classList.toggle("feed-pages", mode === "pages");
  }
  setMode(opts.mode);

  window.addEventListener("scroll", update, { passive: true, signal });
  window.addEventListener("resize", update, { signal });
  document.addEventListener("keydown", onKey, { signal });
  document.addEventListener("touchstart", onTouchStart, { passive: true, signal });
  document.addEventListener("touchend", onTouchEnd, { passive: true, signal });
  // Save immediately when the app/tab is backgrounded
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && items.length) {
      const pos = positionAt(items.map(sectionBox), viewTop());
      if (pos) save.flush(pos);
    }
  }, { signal });

  // ── Start ──

  async function start() {
    const pos = await source.getPosition();
    let first = [];
    if (pos?.newsletter_id != null) {
      // Load the saved article plus a few after; earlier ones come in on scroll
      first = await source.load(pos.newsletter_id, "forward", BATCH, true);
    }
    if (!first.length) first = await source.load(null, "forward", BATCH);
    if (destroyed) return;
    if (!first.length) {
      list.innerHTML = `<p class="empty">No newsletters yet.</p>`;
      restoring = false;
      return;
    }
    if (first.length < BATCH) atEnd = true;
    insert(first, "end");
    // Fill a screen's worth before the anchor so scrolling up is immediate
    await loadBefore();

    const anchor = items.find((it) => it.n.id === first[0].id);
    const offset = pos && first[0].id === pos.newsletter_id ? pos.offset : 0;
    const go = () => window.scrollTo(0, scrollTargetFor(sectionBox(anchor), offset, inset()));
    go();
    // Late layout (fonts, iframe load) can move things; re-apply once settled
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    go();
    restoring = false;
    currentId = anchor.n.id;
    opts.onCurrent(anchor.n);
    update();
  }

  const ready = start();

  return {
    ready,
    setMode,
    /** Look for newsletters that arrived after the feed reached its end (e.g. after a sync). */
    async refresh() {
      await ready;
      if (!items.length) return this.jumpTo(null);
      atEnd = false;
      await loadAfter();
      update();
    },
    /** Jump to a specific newsletter (e.g. chosen from the index). */
    async jumpTo(id) {
      restoring = true;
      items.length = 0;
      atStart = atEnd = false;
      list.replaceChildren();
      heights = new WeakMap();
      if (id != null) await source.savePosition(id, 0);
      await start();
    },
    destroy() {
      destroyed = true;
      ctrl.abort();
      resizeObs.disconnect();
      zones.remove();
      document.body.classList.remove("feed-pages");
    },
  };
}
