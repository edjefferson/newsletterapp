import { describe, it, expect } from "vitest";
import { positionAt, scrollTargetFor, hasReachedEnd, senderName, jumpDate, chooseBreak, pageStarts } from "../static/feed.js";

const sections = [
  { id: 1, top: 0, height: 1000 },
  { id: 2, top: 1000, height: 500 },
  { id: 3, top: 1500, height: 2000 },
];

describe("positionAt", () => {
  it("returns null with no sections", () => {
    expect(positionAt([], 0)).toBeNull();
  });

  it("finds the article under the top of the viewport", () => {
    expect(positionAt(sections, 1250)).toEqual({ newsletter_id: 2, offset: 0.5 });
  });

  it("is at the very start of an article on its boundary", () => {
    expect(positionAt(sections, 1500)).toEqual({ newsletter_id: 3, offset: 0 });
  });

  it("clamps above the first article to the start", () => {
    expect(positionAt(sections, -200)).toEqual({ newsletter_id: 1, offset: 0 });
  });

  it("clamps past the last article to the end", () => {
    expect(positionAt(sections, 9999)).toEqual({ newsletter_id: 3, offset: 1 });
  });

  it("handles zero-height articles", () => {
    expect(positionAt([{ id: 7, top: 0, height: 0 }], 0)).toEqual({ newsletter_id: 7, offset: 0 });
  });
});

describe("scrollTargetFor", () => {
  it("round-trips with positionAt", () => {
    const inset = 52;
    const target = scrollTargetFor(sections[2], 0.25, inset);
    expect(positionAt(sections, target + inset)).toEqual({ newsletter_id: 3, offset: 0.25 });
  });

  it("never scrolls above the top of the page", () => {
    expect(scrollTargetFor(sections[0], 0, 52)).toBe(0);
  });
});

describe("hasReachedEnd", () => {
  it("is false while the article continues below the viewport", () => {
    expect(hasReachedEnd(sections[2], 2000)).toBe(false);
  });

  it("is true once the article's bottom is on screen", () => {
    expect(hasReachedEnd(sections[1], 1500)).toBe(true);
    expect(hasReachedEnd(sections[1], 1800)).toBe(true);
  });
});

describe("senderName", () => {
  it("drops the email address", () => {
    expect(senderName("Popbitch <popbitch@substack.com>")).toBe("Popbitch");
  });
  it("unquotes quoted names", () => {
    expect(senderName('"The Fence" <x@y.com>')).toBe("The Fence");
  });
  it("keeps bare names and bare addresses", () => {
    expect(senderName("LRB")).toBe("LRB");
    expect(senderName("<a@b.com>")).toBe("<a@b.com>");
  });
});

describe("jumpDate", () => {
  const now = new Date(2026, 9, 21, 17, 45); // 21 Oct 2026, 17:45 local
  it("goes back whole days to local midnight", () => {
    expect(jumpDate("7d", now)).toEqual(new Date(2026, 9, 14));
    expect(jumpDate("1d", now)).toEqual(new Date(2026, 9, 20));
  });
  it("crosses month boundaries", () => {
    expect(jumpDate("30d", now)).toEqual(new Date(2026, 8, 21));
  });
});

describe("chooseBreak", () => {
  const lines = (lh, from = 0) => (y) => {
    const top = from + Math.floor((y - from) / lh) * lh;
    return [{ top, bottom: top + lh }];
  };

  it("ends the article on its last page", () => {
    expect(chooseBreak(0, 800, 500, () => [])).toBe(500);
  });

  it("keeps a clean break where nothing is cut", () => {
    expect(chooseBreak(0, 800, 5000, lines(25))).toBe(800);
  });

  it("moves up to the top of a line it would cut", () => {
    expect(chooseBreak(0, 810, 5000, lines(25))).toBe(800);
  });

  it("moves above an image it would cut", () => {
    const img = () => [{ top: 600, bottom: 1000 }];
    expect(chooseBreak(0, 800, 5000, img)).toBe(600);
  });

  it("cuts an image taller than most of the page rather than leave it nearly empty", () => {
    const img = () => [{ top: 100, bottom: 3000 }];
    expect(chooseBreak(0, 800, 5000, img)).toBe(800);
  });
});

describe("pageStarts", () => {
  it("covers the article with line-aligned pages", () => {
    const lh = 30;
    const at = (y) => { const t = Math.floor(y / lh) * lh; return [{ top: t, bottom: t + lh }]; };
    const starts = pageStarts(500, 1600, at);
    expect(starts[0]).toBe(0);
    for (const s of starts) expect(s % lh).toBe(0);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeLessThanOrEqual(500);
    expect(1600 - starts[starts.length - 1]).toBeLessThanOrEqual(500);
  });

  it("is a single page for short articles", () => {
    expect(pageStarts(800, 300, () => [])).toEqual([0]);
  });
});
