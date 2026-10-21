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
 *   source.findFrom(date)                → id of the first newsletter on/after `date`
 *                                          (or the newest one if there's nothing that recent)
 *
 * The feed only grows forwards: it opens with the previous article above the
 * current one for context, and older newsletters are reached via the index.
 *
 * Options:
 *   mode:       'scroll' | 'pages'
 *   topInset:   () => px hidden under the sticky header
 *   openLink:   (url) => void
 *   onCurrent:  (newsletter) => void   called when the article at the top changes
 */

const BATCH = 4;
const LOAD_MARGIN = 2500; // px from the bottom before fetching more
const SAVE_DELAY = 800;
const PAGE_GAP_TOP = 24; // breathing room above the page (the header is hidden in pages mode)
const PAGE_GAP_BOTTOM = 16; // …and between the page and the footer

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

const JUMP_CHOICES = [
  ["", "Choose…"],
  ["1d", "Yesterday"],
  ["7d", "1 week ago"],
  ["30d", "1 month ago"],
  ["date", "A date…"],
];

/** Start of the day `choice` refers to ("1d", "7d", "30d"), in local time. */
export function jumpDate(choice, now = new Date()) {
  const days = parseInt(choice, 10);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Settings-row control for jumping the feed to a point in time. Calls
 * `onJump(date)`; returns the row element to put in a settings panel.
 */
export function createJumpControl(onJump) {
  const row = document.createElement("div");
  row.className = "settings-row";
  row.innerHTML = `
    <span class="settings-row-label">Jump to</span>
    <select class="jump-select">${JUMP_CHOICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
    <input class="jump-date" type="date" hidden>`;
  const select = row.querySelector(".jump-select");
  const dateInput = row.querySelector(".jump-date");
  dateInput.max = new Date().toISOString().slice(0, 10);
  select.addEventListener("change", () => {
    if (select.value === "date") {
      dateInput.hidden = false;
      dateInput.showPicker?.();
      return;
    }
    dateInput.hidden = true;
    if (select.value) onJump(jumpDate(select.value));
    select.value = "";
  });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    const [y, m, d] = dateInput.value.split("-").map(Number);
    onJump(new Date(y, m - 1, d));
    dateInput.value = "";
    dateInput.hidden = true;
    select.value = "";
  });
  return row;
}

/**
 * Where to end a page that starts at `start` (px within an article of height
 * `total`), given at most `pageH` px of room. `straddlersAt(y)` returns the
 * boxes ({top, bottom}) of lines/images that a break at y would cut through;
 * the break moves up to the top of the highest one. If that would leave the
 * page less than `minFill` full it cuts anyway — except for images
 * ({kind: "image"}) that fit on a page, which always move to the next page.
 */
export function chooseBreak(start, pageH, total, straddlersAt, minFill = 0.4) {
  if (start + pageH >= total) return total;
  let brk = start + pageH;
  // A few passes: moving up to one line's top can land inside another (table columns)
  for (let pass = 0; pass < 4; pass++) {
    const cut = straddlersAt(brk).filter((s) => s.top < brk - 1 && s.bottom > brk + 1);
    if (!cut.length) break;
    // Round down so a fractional top doesn't leave a sliver of the line/image showing
    const top = Math.floor(Math.min(...cut.map((s) => s.top)));
    const wholeImage = cut.some((s) => s.kind === "image" && Math.floor(s.top) === top && s.bottom - s.top <= pageH);
    if (top <= start || (top <= start + pageH * minFill && !wholeImage)) break;
    brk = top;
  }
  return Math.floor(brk);
}

/** All page start offsets for an article: [0, b1, b2, …]. */
export function pageStarts(pageH, total, straddlersAt) {
  const starts = [0];
  let start = 0;
  while (true) {
    const brk = chooseBreak(start, pageH, total, straddlersAt);
    if (brk >= total || brk <= start) break;
    starts.push(brk);
    start = brk;
  }
  return starts;
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
  root.classList.add("feed-root");

  const items = []; // { n, el } in chronological order
  let atEnd = false;
  let loadingAfter = false;
  let currentId = null;
  let restoring = true;
  let destroyed = false;
  const ctrl = new AbortController();
  const { signal } = ctrl;

  const inset = () => opts.topInset();
  // In pages mode the feed is a fixed frame and nothing scrolls; its top is the reading point
  const viewTop = () => (page ? root.getBoundingClientRect().top + window.scrollY : window.scrollY + inset());
  const viewBottom = () =>
    page ? viewTop() + page.visible : window.scrollY + window.innerHeight;

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
        attachPageInput(doc);
        fitImages(doc);
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
    if (page) showPage();
    else if (delta) window.scrollBy(0, delta);
  });

  function insert(newItems, where) {
    const frameReady = [];
    const els = newItems.map((n) => ({ n, el: renderItem(n, frameReady) }));
    if (where === "end") {
      els.forEach((it) => list.appendChild(it.el));
      items.push(...els);
      frameReady.forEach((f) => f());
    } else {
      // Only used while restoring, before the reader is positioned
      const frag = document.createDocumentFragment();
      els.forEach((it) => frag.appendChild(it.el));
      list.prepend(frag);
      items.unshift(...els);
      frameReady.forEach((f) => f());
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

  async function loadPrevious() {
    const batch = await source.load(items[0].n.id, "backward", 1);
    if (destroyed) return;
    if (batch.length) insert(batch, "start");
    else topSentinel.textContent = "Start of your newsletters.";
  }

  function maybeLoadMore() {
    if (restoring) return;
    if (page) {
      if (items.indexOf(page.item) >= items.length - 2) loadAfter();
    } else if (document.documentElement.scrollHeight - viewBottom() < LOAD_MARGIN) loadAfter();
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

  // ── Pages mode ──
  //
  // The feed becomes a fixed frame between the top of the screen and the
  // footer; turning a page moves the content inside it, so the document never
  // scrolls. Breaks don't cut through lines or images, each article starts on
  // a new page, images are scaled to fit a page, and the header is hidden
  // until the reader taps the page.

  let page = null; // { item, index, starts, visible } while in pages mode
  const pageCache = new WeakMap(); // item el → { key, starts }

  const footer = document.createElement("div");
  footer.className = "page-footer";
  footer.innerHTML = `<span class="page-footer-title"></span><span class="page-footer-count"></span>`;
  // Measures env(safe-area-inset-top), which CSS custom properties can't expose to JS
  const safeProbe = document.createElement("div");
  safeProbe.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
  document.body.append(footer, safeProbe);

  const frameTop = () => safeProbe.offsetHeight + PAGE_GAP_TOP;
  const pageHeight = () =>
    window.innerHeight - frameTop() - PAGE_GAP_BOTTOM - footer.getBoundingClientRect().height;

  // Scale images down to fit on one page so they never need splitting
  let fitHeight = 0;
  function fitImages(doc) {
    let style = doc.getElementById("page-fit");
    if (!style) {
      style = doc.createElement("style");
      style.id = "page-fit";
      doc.head?.appendChild(style);
    }
    style.textContent = opts.mode === "pages" && fitHeight
      ? `img, video, svg { max-height: ${fitHeight}px !important; object-fit: contain; }`
      : "";
  }
  function refitImages() {
    const h = opts.mode === "pages" ? Math.floor(pageHeight() - 32) : 0;
    if (h === fitHeight) return;
    fitHeight = h;
    for (const it of items) {
      const doc = it.el.querySelector("iframe")?.contentDocument;
      if (doc?.head) fitImages(doc);
    }
  }

  // Boxes (in article coordinates) of lines/images that a break at `y` would cut
  function straddlersAt(item, y) {
    const sec = item.el.getBoundingClientRect();
    const boxes = [];
    const add = (r, offset, kind = "text") => boxes.push({ top: r.top + offset, bottom: r.bottom + offset, kind });

    const meta = item.el.querySelector(".reader-meta");
    if (meta) add(meta.getBoundingClientRect(), -sec.top);

    const iframe = item.el.querySelector("iframe");
    const doc = iframe?.contentDocument;
    if (doc?.body) {
      const off = iframe.getBoundingClientRect().top - sec.top;
      const yi = y - off;
      const w = doc.documentElement.clientWidth;
      if (yi > 0 && yi < iframe.offsetHeight) {
        for (const fx of [0.08, 0.25, 0.5, 0.75, 0.92]) {
          const x = w * fx;
          const el = doc.elementFromPoint(x, yi);
          if (el && /^(IMG|VIDEO|SVG|PICTURE|CANVAS|IFRAME|svg)$/.test(el.tagName)) {
            add(el.getBoundingClientRect(), off, "image");
            continue;
          }
          let node = null, offset = 0;
          if (doc.caretRangeFromPoint) {
            const r = doc.caretRangeFromPoint(x, yi);
            if (r) { node = r.startContainer; offset = r.startOffset; }
          } else if (doc.caretPositionFromPoint) {
            const p = doc.caretPositionFromPoint(x, yi);
            if (p) { node = p.offsetNode; offset = p.offset; }
          }
          if (node?.nodeType === Node.TEXT_NODE && node.length) {
            const r = doc.createRange();
            const i = Math.min(offset, node.length - 1);
            r.setStart(node, i);
            r.setEnd(node, i + 1);
            const rect = r.getBoundingClientRect();
            if (rect.height) add(rect, off);
          }
        }
      }
    }

    const pre = item.el.querySelector(".reader-text");
    if (pre) {
      const r = pre.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(pre).lineHeight) || 24;
      const padTop = parseFloat(getComputedStyle(pre).paddingTop) || 0;
      const top = r.top - sec.top + padTop;
      if (y > top && y < r.bottom - sec.top) {
        const line = top + Math.floor((y - top) / lh) * lh;
        boxes.push({ top: line, bottom: line + lh, kind: "text" });
      }
    }
    return boxes;
  }

  function pagesFor(item) {
    const total = item.el.getBoundingClientRect().height;
    const h = pageHeight();
    const key = `${Math.round(total)}:${Math.round(h)}`;
    const cached = pageCache.get(item.el);
    if (cached?.key === key) return cached.starts;
    const starts = pageStarts(h, total, (y) => straddlersAt(item, y));
    pageCache.set(item.el, { key, starts });
    return starts;
  }

  // Draw the current page: shift the feed so the page's start is at the top of
  // the frame, and size the frame to end exactly at the page break
  function showPage() {
    if (!page) return;
    page.starts = pagesFor(page.item);
    page.index = Math.min(page.index, page.starts.length - 1);
    const height = page.item.el.getBoundingClientRect().height;
    const start = page.starts[page.index];
    const end = page.starts[page.index + 1] ?? height;
    const itemOffset = page.item.el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    page.visible = end - start;
    root.style.top = `${frameTop()}px`;
    root.style.height = `${page.visible}px`;
    list.style.transform = `translateY(${-(itemOffset + start)}px)`;
    footer.querySelector(".page-footer-title").textContent = senderName(page.item.n.sender);
    footer.querySelector(".page-footer-count").textContent =
      page.starts.length > 1 ? `${page.index + 1} / ${page.starts.length}` : "";
    update();
  }

  // Open the page of `item` that contains `offsetPx` (px into the article)
  function openPageAt(item, offsetPx) {
    const starts = pagesFor(item);
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1] <= offsetPx + 2) index++;
    page = { item, index, starts, visible: 0 };
    showPage();
  }

  // Where the reader is in scroll mode, as an article and a px offset into it
  function scrollReadingPoint() {
    const top = window.scrollY + inset();
    const item = items.find((it) => { const b = sectionBox(it); return b.top + b.height > top; }) || items[items.length - 1];
    return { item, offset: Math.max(0, top - sectionBox(item).top) };
  }

  function setChrome(visible) {
    document.body.classList.toggle("chrome-visible", visible);
  }

  let turning = false;
  async function turn(dir) {
    if (!page || turning) return;
    setChrome(false);
    const i = items.indexOf(page.item);
    let target;
    if (dir > 0) {
      if (page.index + 1 < page.starts.length) target = { item: page.item, index: page.index + 1 };
      else {
        if (i === items.length - 1) await loadAfter();
        if (items[i + 1]) target = { item: items[i + 1], index: 0 };
      }
    } else if (page.index > 0) {
      target = { item: page.item, index: page.index - 1 };
    } else if (items[i - 1]) {
      target = { item: items[i - 1], index: pagesFor(items[i - 1]).length - 1 };
    }
    turning = true;
    const shift = 28 * (dir > 0 ? 1 : -1);
    const fade = (from, to) => root.animate(
      [{ transform: `translateX(${from}px)`, opacity: from ? 0 : 1 }, { transform: `translateX(${to}px)`, opacity: to ? 0 : 1 }],
      { duration: 110, easing: "ease-out" }
    ).finished;
    try {
      if (!target) {
        // Nothing further: a small nudge so the tap doesn't feel ignored
        await root.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-shift / 3}px)` }, { transform: "translateX(0)" }], { duration: 160 }).finished;
        return;
      }
      await fade(0, -shift);
      page = { ...target, starts: pagesFor(target.item), visible: 0 };
      showPage();
      await fade(shift, 0);
    } finally {
      turning = false;
    }
  }

  function onKey(e) {
    if (opts.mode !== "pages" || e.target.closest?.("input, textarea, select, button")) return;
    if (["ArrowRight", "ArrowDown", "PageDown"].includes(e.key) || (e.key === " " && !e.shiftKey)) {
      e.preventDefault(); turn(1);
    } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey)) {
      e.preventDefault(); turn(-1);
    } else if (e.key === "Escape") {
      setChrome(!document.body.classList.contains("chrome-visible"));
    }
  }

  let touchX = 0, touchY = 0;
  function onTouchStart(e) {
    touchX = e.touches[0].screenX; touchY = e.touches[0].screenY;
  }
  function onTouchEnd(e) {
    if (opts.mode !== "pages") return;
    const dx = e.changedTouches[0].screenX - touchX;
    const dy = e.changedTouches[0].screenY - touchY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 40) return;
    // Swipe left or up = next page
    if (Math.abs(dx) >= Math.abs(dy)) turn(dx < 0 ? 1 : -1);
    else turn(dy < 0 ? 1 : -1);
  }

  let wheelAcc = 0, wheelAt = 0;
  function onWheel(e) {
    if (opts.mode !== "pages") return;
    const now = Date.now();
    if (now - wheelAt > 250) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 60) { turn(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; wheelAt = now + 400; }
  }

  // Tapping the page (not a link or control) shows/hides the header
  function onTap(e) {
    if (opts.mode !== "pages") return;
    if (e.target.closest?.("a, button, input, select, textarea, label, header, .settings-panel")) return;
    setChrome(!document.body.classList.contains("chrome-visible"));
  }

  // Article bodies are iframes, whose events don't reach this document
  function attachPageInput(target) {
    target.addEventListener("keydown", onKey, { signal });
    target.addEventListener("touchstart", onTouchStart, { passive: true, signal });
    target.addEventListener("touchend", onTouchEnd, { passive: true, signal });
    target.addEventListener("wheel", onWheel, { passive: true, signal });
    target.addEventListener("click", onTap, { signal });
  }

  const zones = document.createElement("div");
  zones.className = "page-zones";
  zones.innerHTML = `<button class="page-zone" data-dir="prev" aria-label="Previous page"></button>
                     <button class="page-zone" data-dir="next" aria-label="Next page"></button>`;
  document.body.appendChild(zones);
  zones.addEventListener("click", (e) => {
    const zone = e.target.closest(".page-zone");
    if (zone) turn(zone.dataset.dir === "next" ? 1 : -1);
  }, { signal });

  function setMode(mode) {
    const wasPages = !!page;
    const pages = mode === "pages";
    // Remember the reading point in the layout we're leaving
    const at = restoring || !items.length ? null
      : wasPages ? { item: page.item, offset: page.starts[page.index] }
      : scrollReadingPoint();
    opts.mode = mode;
    document.documentElement.classList.toggle("feed-pages", pages);
    document.body.classList.toggle("feed-pages", pages);
    setChrome(false);
    refitImages();
    if (pages) {
      if (at) openPageAt(at.item, at.offset);
    } else {
      page = null;
      root.style.top = root.style.height = "";
      list.style.transform = "";
      if (at) window.scrollTo(0, sectionBox(at.item).top + at.offset - inset());
      update();
    }
  }

  setMode(opts.mode);
  attachPageInput(document);
  window.addEventListener("resize", () => {
    if (!page) return;
    refitImages();
    pageCache.delete(page.item.el);
    showPage();
  }, { signal });

  window.addEventListener("scroll", update, { passive: true, signal });
  window.addEventListener("resize", update, { signal });
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
    // One article of context above; nothing further back
    await loadPrevious();

    const anchor = items.find((it) => it.n.id === first[0].id);
    const offset = pos && first[0].id === pos.newsletter_id ? pos.offset : 0;
    // Late layout (fonts, iframe load) can move things; wait for it to settle
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    restoring = false;
    currentId = anchor.n.id;
    opts.onCurrent(anchor.n);
    if (opts.mode === "pages") {
      refitImages();
      openPageAt(anchor, offset * sectionBox(anchor).height);
    } else {
      window.scrollTo(0, scrollTargetFor(sectionBox(anchor), offset, inset()));
      update();
    }
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
    /** Jump to the first newsletter on/after `date`. */
    async jumpToDate(date) {
      const id = await source.findFrom(date);
      if (id != null) await this.jumpTo(id);
    },
    /** Jump to a specific newsletter (e.g. chosen from the index). */
    async jumpTo(id) {
      restoring = true;
      items.length = 0;
      atEnd = false;
      list.replaceChildren();
      topSentinel.textContent = "";
      heights = new WeakMap();
      page = null;
      if (id != null) await source.savePosition(id, 0);
      await start();
    },
    destroy() {
      destroyed = true;
      ctrl.abort();
      resizeObs.disconnect();
      zones.remove();
      footer.remove();
      safeProbe.remove();
      document.documentElement.classList.remove("feed-pages");
      document.body.classList.remove("feed-pages", "chrome-visible");
    },
  };
}
