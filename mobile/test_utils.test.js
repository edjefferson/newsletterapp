// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Copy functions under test from static/app.js ─────────────────────────────
// (Copied here so tests don't depend on a browser module bundler)

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((today - msgDay) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function sanitizeHtml(html) {
  const dark = document.body.classList.contains("dark");
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
  return style + html;
}

// ── escHtml ───────────────────────────────────────────────────────────────────

describe("escHtml", () => {
  it("escapes ampersand", () => {
    expect(escHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less than", () => {
    expect(escHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater than", () => {
    expect(escHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quote", () => {
    expect(escHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes all together", () => {
    const result = escHtml('<a href="x&y">link</a>');
    expect(result).toBe("&lt;a href=&quot;x&amp;y&quot;&gt;link&lt;/a&gt;");
  });

  it("passes through safe string", () => {
    expect(escHtml("hello world")).toBe("hello world");
  });

  it("converts number to string", () => {
    expect(escHtml(42)).toBe("42");
  });

  it("converts null to string", () => {
    expect(escHtml(null)).toBe("null");
  });

  it("handles multiple special chars", () => {
    const result = escHtml('a&b<c>d"e');
    expect(result).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns month and day for old date", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00"));
    const result = formatDate("2020-03-15T10:00:00");
    // Should contain "Mar" and "15"
    expect(result).toMatch(/Mar/i);
    expect(result).toMatch(/15/);
  });

  it("returns Yesterday for yesterday", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00"));
    expect(formatDate("2025-06-14T10:00:00")).toBe("Yesterday");
  });

  it("returns a weekday for 3 days ago", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00")); // Sunday
    const result = formatDate("2025-06-12T10:00:00"); // Thursday
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    expect(weekdays.some((d) => result.includes(d))).toBe(true);
  });

  it("returns time string for today", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00"));
    const result = formatDate("2025-06-15T09:30:00");
    expect(result).toMatch(/\d+:\d+/);
  });

  it("returns month/day format for exactly 7 days ago", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00"));
    const result = formatDate("2025-06-08T10:00:00");
    // 7 days ago — not weekday, not Yesterday, not time
    expect(result).not.toBe("Yesterday");
    expect(result).not.toMatch(/\d+:\d+/);
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    expect(weekdays.some((d) => result.includes(d))).toBe(false);
  });

  it("returns Yesterday for exactly 1 day ago", () => {
    vi.setSystemTime(new Date("2025-06-15T12:00:00"));
    expect(formatDate("2025-06-14T23:59:59")).toBe("Yesterday");
  });
});

// ── debounce ──────────────────────────────────────────────────────────────────

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not call fn immediately", () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 200);
    debouncedFn();
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn after delay", () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 200);
    debouncedFn();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on rapid calls", () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 200);
    debouncedFn();
    vi.advanceTimersByTime(100);
    debouncedFn();
    vi.advanceTimersByTime(100);
    debouncedFn();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes arguments through", () => {
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100);
    debouncedFn("hello", 42);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("hello", 42);
  });
});

// ── sanitizeHtml (needs happy-dom DOM) ───────────────────────────────────────

describe("sanitizeHtml", () => {
  beforeEach(() => {
    document.body.className = "";
  });

  it("injects a style tag at the start", () => {
    const result = sanitizeHtml("<p>hello</p>");
    expect(result.startsWith("<style>")).toBe(true);
  });

  it("does not include invert filter in light mode", () => {
    // body has no 'dark' class
    const result = sanitizeHtml("<p>light</p>");
    expect(result).not.toContain("invert(1)");
  });

  it("includes invert filter in dark mode", () => {
    document.body.classList.add("dark");
    const result = sanitizeHtml("<p>dark</p>");
    expect(result).toContain("invert(1)");
  });

  it("appends html after style tag", () => {
    const result = sanitizeHtml("<p>content</p>");
    expect(result).toContain("<p>content</p>");
    const styleEnd = result.indexOf("</style>");
    const contentStart = result.indexOf("<p>content</p>");
    expect(styleEnd).toBeLessThan(contentStart);
  });

  it("returns style even for empty html", () => {
    const result = sanitizeHtml("");
    expect(result).toContain("<style>");
    expect(result).toContain("</style>");
  });
});
