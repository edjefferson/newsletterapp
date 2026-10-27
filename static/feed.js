/* ── Continuous feed view ──
 *
 * Shared by the web app (loaded as an ES module from /static/feed.js) and the
 * Capacitor app (imported and bundled by Vite). All data access goes through a
 * `source` object so each client can back it with the API or local SQLite:
 *
 *   source.getPosition()                 → { newsletter_id, offset, anchor? } | null
 *   source.savePosition(id, offset, anchor) → persist where the reader is (anchor: text snippet)
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
const PAGE_GAP_TOP = 12; // breathing room above the page (the header is hidden in pages mode)
const PAGE_GAP_BOTTOM = 8; // …and between the page and the footer

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
  // text-size-adjust: stop Chrome's text autosizing enlarging paragraphs on narrow screens
  return `<style>
    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
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

const ANCHOR_LEN = 60;

/**
 * Text nodes of `root` as one whitespace-collapsed string, with each character mapped
 * back to its node and offset. Text is what survives a change of font size or width.
 */
function flatText(root) {
  let text = "";
  const map = [];
  const visit = (node) => {
    if (node.nodeType === 3) {
      const s = node.nodeValue;
      for (let i = 0; i < s.length; i++) {
        const space = /\s/.test(s[i]);
        if (space && (text === "" || text.endsWith(" "))) continue;
        text += space ? " " : s[i];
        map.push([node, i]);
      }
    } else if (node.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT)$/i.test(node.tagName)) {
      node.childNodes.forEach(visit);
    }
  };
  visit(root);
  return { text, map };
}

/** The first ANCHOR_LEN chars of text at or below `y` (px in `root`'s document), or null. */
export function textAnchorAt(root, y) {
  const doc = root.ownerDocument || root;
  const { text, map } = flatText(root);
  const range = doc.createRange();
  // Binary search for the first character whose line ends below y (text runs top to bottom)
  let lo = 0, hi = map.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(map[mid][0], map[mid][1]);
    range.setEnd(map[mid][0], map[mid][1] + 1);
    const r = range.getBoundingClientRect();
    if (!r.height) { lo = mid + 1; continue; } // hidden text: treat as above
    if (r.bottom > y) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (found < 0) return null;
  const snippet = text.slice(found, found + ANCHOR_LEN).trim();
  return snippet.length >= 8 ? snippet : null;
}

/** Top (px in `root`'s document) of the first occurrence of `anchor`, or null if not found. */
export function textAnchorTop(root, anchor) {
  if (!anchor) return null;
  const doc = root.ownerDocument || root;
  const { text, map } = flatText(root);
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const range = doc.createRange();
  range.setStart(map[at][0], map[at][1]);
  range.setEnd(map[at][0], map[at][1] + 1);
  return range.getBoundingClientRect().top;
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

// ── Text settings ──

export const FONT_CHOICES = [["original", "Original"], ["sans", "Sans"], ["serif", "Serif"]];
const FONT_STACKS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", Charter, "Bitstream Charter", Georgia, "Noto Serif", "Droid Serif", serif',
};
const SIZE_MIN = 12;
const SIZE_MAX = 26;
const SIZE_DEFAULT = 17; // where the slider starts when moving off "original"

/** True on e-ink readers (Boox), where animation ghosts and flashes. */
export function isEInk(ua = typeof navigator !== "undefined" ? navigator.userAgent : "") {
  // Boox model names, which may be followed directly by a model number (e.g. "NoteAir3C")
  return /\b(Palma|BOOX|Onyx|Note ?Air|Note ?Max|Tab ?Ultra|Tab ?Mini|Nova ?Air|Max ?Lumi|Leaf\d|Poke\d)/i.test(ua);
}

/** Settings row toggling page-turn animation ("slide" | "instant"). */
export function createTurnControl(value, onChange) {
  const row = document.createElement("div");
  row.className = "settings-row";
  row.innerHTML = `
    <span class="settings-row-label">Page turn</span>
    <button class="theme-toggle-btn" type="button"></button>`;
  const btn = row.querySelector("button");
  let current = value;
  const label = () => { btn.textContent = current === "instant" ? "Instant" : "Slide"; };
  btn.addEventListener("click", () => {
    current = current === "instant" ? "slide" : "instant";
    label();
    onChange(current);
  });
  label();
  return row;
}

/** Text size in px from a stored setting ("original" or a number), or null for original. */
export function sizePx(size) {
  const n = Number(size);
  return Number.isFinite(n) && n > 0 ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n))) : null;
}
// Everything that carries body text in newsletter HTML (code/pre keep their own font)
// Tables are listed explicitly: articles render in quirks mode, where tables don't inherit font size
const TEXT_SELECTOR = "body, table, thead, tbody, tfoot, tr, td, th, center, p, li, ul, ol, blockquote, dd, dt, div, span, a, em, strong, b, i, u, font, section, article, figcaption, small";

/**
 * CSS overriding a newsletter's own typography with the reader's choices
 * ({font, size}, "original" = leave as is). Injected into each article iframe.
 */
export function textStyle({ font = "original", size = "original" } = {}) {
  let css = "";
  if (FONT_STACKS[font]) {
    css += `${TEXT_SELECTOR}, h1, h2, h3, h4, h5, h6 { font-family: ${FONT_STACKS[font]} !important; }\n`;
  }
  const px = sizePx(size);
  if (px) {
    css += `body { font-size: ${px}px !important; }
${TEXT_SELECTOR.replace("body, ", "")} { font-size: inherit !important; line-height: 1.6 !important; }
h1 { font-size: 1.6em !important; line-height: 1.25 !important; }
h2 { font-size: 1.35em !important; line-height: 1.25 !important; }
h3 { font-size: 1.15em !important; line-height: 1.3 !important; }
h4, h5, h6 { font-size: 1em !important; }\n`;
  }
  return css;
}

/** Settings rows for font (select) and text size (slider). Calls `onChange({font, size})`. */
export function createTextControls(prefs, onChange) {
  const current = { font: "original", size: "original", ...prefs };
  const frag = document.createDocumentFragment();

  const fontRow = document.createElement("div");
  fontRow.className = "settings-row";
  fontRow.innerHTML = `
    <span class="settings-row-label">Font</span>
    <select class="jump-select" data-key="font">${FONT_CHOICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`;
  const fontSelect = fontRow.querySelector("select");
  fontSelect.value = current.font;
  fontSelect.addEventListener("change", () => {
    current.font = fontSelect.value;
    onChange({ ...current });
  });

  const sizeRow = document.createElement("div");
  sizeRow.className = "settings-row size-row";
  sizeRow.innerHTML = `
    <span class="settings-row-label">Text size</span>
    <span class="size-stepper">
      <button class="theme-toggle-btn size-step" type="button" data-step="-1" aria-label="Smaller text">−</button>
      <button class="theme-toggle-btn size-value" type="button"></button>
      <button class="theme-toggle-btn size-step" type="button" data-step="1" aria-label="Larger text">+</button>
    </span>`;
  const valueBtn = sizeRow.querySelector(".size-value");
  const [minusBtn, plusBtn] = sizeRow.querySelectorAll(".size-step");
  const show = () => {
    const px = sizePx(current.size);
    valueBtn.textContent = px ? `${px}px` : "Original";
    valueBtn.title = px ? "Back to each newsletter's own size" : "";
    minusBtn.disabled = px === SIZE_MIN;
    plusBtn.disabled = px === SIZE_MAX;
  };
  // Re-laying out the feed is costly, so a quick run of taps applies once
  const commit = debounce(() => onChange({ ...current }), 250);
  for (const btn of [minusBtn, plusBtn]) {
    btn.addEventListener("click", () => {
      const px = sizePx(current.size);
      current.size = sizePx((px ?? SIZE_DEFAULT) + Number(btn.dataset.step));
      show();
      commit();
    });
  }
  valueBtn.addEventListener("click", () => {
    if (current.size === "original") return;
    current.size = "original";
    show();
    commit.flush();
  });
  show();

  frag.append(fontRow, sizeRow);
  return frag;
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
  let t = null;
  let last = [];
  const d = (...args) => {
    last = args;
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...last); }, ms);
  };
  d.flush = () => { if (t !== null) { clearTimeout(t); t = null; fn(...last); } };
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
    text: { font: "original", size: "original" },
    turn: isEInk() ? "instant" : "slide",
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
        // Text can reflow without an image loading (fonts arriving, text settings)
        const RO = iframe.contentWindow?.ResizeObserver;
        if (RO) new RO(resize).observe(doc.documentElement);
        doc.fonts?.addEventListener?.("loadingdone", () => { resize(); pageCache.delete(iframe.closest(".feed-item")); });
        attachPageInput(doc);
        fitImages(doc);
        applyText(doc);
        resize();
      });
    } else if (n.body_text) {
      const pre = document.createElement("pre");
      pre.className = "reader-text";
      pre.textContent = n.body_text;
      styleTextBody(pre);
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

  // The text at the top of the view, for opening at the same spot on a device with a
  // different font size or width. Looked up at save time, not on every scroll.
  function anchorFor(id) {
    const item = items.find((it) => it.n.id === id);
    const iframe = item?.el.querySelector("iframe");
    const doc = iframe?.contentDocument;
    if (!doc?.body) return null;
    const y = viewTop() - (iframe.getBoundingClientRect().top + window.scrollY);
    return y < 0 || y >= iframe.offsetHeight ? null : textAnchorAt(doc.body, y);
  }

  const save = debounce((pos) => {
    source.savePosition(pos.newsletter_id, pos.offset, anchorFor(pos.newsletter_id));
  }, SAVE_DELAY);

  // Only save when the reader has actually moved. Re-saving the position we just
  // opened at (or one that merely drifted as images/fonts loaded) would stamp it as
  // newest and overwrite progress made on another device.
  let lastPos = null; // null until the feed has been positioned after (re)opening
  let lastInputAt = 0;
  const noteInput = () => { lastInputAt = Date.now(); };
  const INPUT_WINDOW = 5000; // covers momentum scrolling after the finger lifts
  const moved = (pos) =>
    pos.newsletter_id !== lastPos.newsletter_id || Math.abs(pos.offset - lastPos.offset) > 0.001;

  function update() {
    if (restoring || destroyed || !items.length) return;
    const pos = positionAt(items.map(sectionBox), viewTop());
    if (!pos) return;
    if (!lastPos) lastPos = pos;
    else if (moved(pos)) {
      lastPos = pos;
      if (Date.now() - lastInputAt < INPUT_WINDOW) save(pos);
    }
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
  // Reader's font/size choices, applied inside each article iframe and to plain-text bodies
  function applyText(doc) {
    let style = doc.getElementById("reading-prefs");
    if (!style) {
      style = doc.createElement("style");
      style.id = "reading-prefs";
      doc.head?.appendChild(style);
    }
    style.textContent = textStyle(opts.text);
  }
  function styleTextBody(pre) {
    const { font, size } = opts.text;
    pre.style.fontFamily = FONT_STACKS[font] || "";
    pre.style.fontSize = sizePx(size) ? `${sizePx(size)}px` : "";
  }

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
    const h = opts.mode === "pages" ? Math.floor(pageHeight() - 16) : 0;
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

  // The leaf element at the top of the view inside `item`'s iframe, and how far through it
  // the view starts. null if the view top isn't over the article body.
  function contentAnchor(item) {
    const iframe = item.el.querySelector("iframe");
    const doc = iframe?.contentDocument;
    if (!doc?.body) return null;
    const y = viewTop() - (iframe.getBoundingClientRect().top + window.scrollY);
    if (y < 0 || y >= iframe.offsetHeight) return null;
    for (const el of doc.body.querySelectorAll("*")) {
      if (el.children.length && el.tagName !== "A") continue;
      const r = el.getBoundingClientRect();
      if (r.height && r.bottom > y) return { el, frac: Math.min(1, Math.max(0, (y - r.top) / r.height)) };
    }
    return null;
  }

  // px into `item` where saved anchor text starts, or null if it can't be found
  function anchorTextOffset(item, text) {
    const iframe = item.el.querySelector("iframe");
    const doc = iframe?.contentDocument;
    if (!doc?.body) return null;
    const top = textAnchorTop(doc.body, text);
    if (top == null) return null;
    return iframe.getBoundingClientRect().top + window.scrollY + top - sectionBox(item).top;
  }

  // px into `item` of a contentAnchor() element, after layout has changed
  function anchorOffset(item, { el, frac }) {
    const iframe = item.el.querySelector("iframe");
    const r = el.getBoundingClientRect();
    const iframeTop = iframe.getBoundingClientRect().top + window.scrollY;
    return iframeTop + r.top + r.height * frac - sectionBox(item).top;
  }

  // Where the reader is in scroll mode, as an article and a px offset into it
  function scrollReadingPoint() {
    const top = window.scrollY + inset();
    const item = items.find((it) => { const b = sectionBox(it); return b.top + b.height > top; }) || items[items.length - 1];
    return { item, offset: Math.max(0, top - sectionBox(item).top) };
  }

  // The settings menu lives in the header, so it closes whenever the header hides
  const openMenu = () => document.querySelector(".settings-panel.open");
  function setChrome(visible) {
    document.body.classList.toggle("chrome-visible", visible);
    if (!visible) openMenu()?.classList.remove("open");
  }

  let turning = false;
  async function turn(dir) {
    if (!page || turning) return;
    noteInput();
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
        if (opts.turn !== "instant") {
          await root.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-shift / 3}px)` }, { transform: "translateX(0)" }], { duration: 160 }).finished;
        }
        return;
      }
      const animate = opts.turn !== "instant";
      if (animate) await fade(0, -shift);
      page = { ...target, starts: pagesFor(target.item), visible: 0 };
      showPage();
      if (animate) await fade(shift, 0);
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

  // Tapping the page (not a link or control) shows/hides the header. With the
  // settings menu open, a tap elsewhere just closes the menu.
  function onTap(e) {
    if (e.target.closest?.("header, .settings-panel")) return;
    const menu = openMenu();
    if (menu) {
      menu.classList.remove("open");
      // Swallow the tap: don't also follow a link or turn the page
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (opts.mode !== "pages") return;
    if (e.target.closest?.("a, button, input, select, textarea, label")) return;
    setChrome(!document.body.classList.contains("chrome-visible"));
  }

  // Article bodies are iframes, whose events don't reach this document
  function attachPageInput(target) {
    for (const type of ["pointerdown", "touchstart", "touchmove", "wheel", "keydown"]) {
      target.addEventListener(type, noteInput, { passive: true, capture: true, signal });
    }
    target.addEventListener("keydown", onKey, { signal });
    target.addEventListener("touchstart", onTouchStart, { passive: true, signal });
    target.addEventListener("touchend", onTouchEnd, { passive: true, signal });
    target.addEventListener("wheel", onWheel, { passive: true, signal });
    target.addEventListener("click", onTap, { capture: true, signal });
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
  // Send any pending save straight away when the app/tab is backgrounded
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) save.flush();
  }, { signal });

  // ── Start ──

  async function start() {
    lastPos = null;
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
    const saved = pos && first[0].id === pos.newsletter_id ? pos : null;
    const offset = saved ? saved.offset : 0;
    // Late layout (fonts, iframe load) can move things; wait for it to settle
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    restoring = false;
    currentId = anchor.n.id;
    opts.onCurrent(anchor.n);
    // Prefer the saved text over the fraction: it lands in the right place even when this
    // device's font size or width differs from the one that saved it
    const textPx = saved?.anchor ? anchorTextOffset(anchor, saved.anchor) : null;
    if (opts.mode === "pages") {
      refitImages();
      openPageAt(anchor, textPx ?? offset * sectionBox(anchor).height);
    } else if (textPx != null) {
      window.scrollTo(0, Math.max(0, Math.round(sectionBox(anchor).top + textPx - inset())));
      update();
    } else {
      window.scrollTo(0, scrollTargetFor(sectionBox(anchor), offset, inset()));
      update();
    }
  }

  const ready = start();

  return {
    ready,
    setMode,
    /** Turn a page (1 = next, -1 = previous) when in pages mode. */
    turnPage(dir) { return turn(dir); },
    /** "slide" | "instant" page turns. */
    setTurn(turn) { opts.turn = turn; },
    /** Change font/size ({font, size}), keeping the reader's place. */
    async setText(text) {
      opts.text = { ...opts.text, ...text };
      for (const it of items) pageCache.delete(it.el);
      // Remember where we are as a fraction through the article, since its height will change
      const pos = items.length ? positionAt(items.map(sectionBox), viewTop()) : null;
      // A fraction of the article drifts when only some of it scales (images, margins),
      // so also pin the element at the top of the view and follow it through the change
      const anchor = pos ? contentAnchor(items.find((it) => it.n.id === pos.newsletter_id)) : null;
      for (const it of items) {
        const doc = it.el.querySelector("iframe")?.contentDocument;
        if (doc?.head) applyText(doc);
        const pre = it.el.querySelector(".reader-text");
        if (pre) styleTextBody(pre);
      }
      if (!pos) return;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const it of items) {
        const iframe = it.el.querySelector("iframe");
        const doc = iframe?.contentDocument;
        if (doc?.documentElement) iframe.style.height = doc.documentElement.scrollHeight + "px";
      }
      const item = items.find((it) => it.n.id === pos.newsletter_id);
      if (!item) return;
      const offsetPx = anchor ? anchorOffset(item, anchor) : pos.offset * sectionBox(item).height;
      if (page) openPageAt(item, offsetPx);
      else window.scrollTo(0, sectionBox(item).top + offsetPx - inset());
    },
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
