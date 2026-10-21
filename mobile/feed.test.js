import { describe, it, expect } from "vitest";
import { positionAt, scrollTargetFor, hasReachedEnd, senderName, jumpDate } from "../static/feed.js";

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
