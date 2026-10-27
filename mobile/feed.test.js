// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { positionAt, scrollTargetFor, hasReachedEnd, senderName, jumpDate, chooseBreak, pageStarts, textStyle, sizePx, marginPx, readingDefaults, blackenText, isEInk, textAnchorAt, textAnchorTop } from "../static/feed.js";

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

  it("moves an image that fits on a page to the next page, even from near the top", () => {
    const img = () => [{ top: 100, bottom: 850, kind: "image" }];
    expect(chooseBreak(0, 800, 5000, img)).toBe(100);
  });

  it("cuts an image taller than a page (nothing else would help)", () => {
    const img = () => [{ top: 100, bottom: 1200, kind: "image" }];
    expect(chooseBreak(0, 800, 5000, img)).toBe(800);
  });

  it("doesn't move an image that already starts the page", () => {
    const img = () => [{ top: 0, bottom: 900, kind: "image" }];
    expect(chooseBreak(0, 800, 5000, img)).toBe(800);
  });

  it("cuts a tall block (not an image) rather than leave the page nearly empty", () => {
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

describe("textStyle", () => {
  it("leaves the newsletter alone by default", () => {
    expect(textStyle()).toBe("");
    expect(textStyle({ font: "original", size: "original" })).toBe("");
  });
  it("overrides the font family, including headings", () => {
    const css = textStyle({ font: "serif" });
    expect(css).toMatch(/h1, h2, h3, h4, h5, h6 \{ font-family: .*serif !important; \}/);
    expect(css).not.toMatch(/font-size/);
  });
  it("sets a base size and keeps headings proportionally larger", () => {
    const css = textStyle({ size: 19 });
    expect(css).toContain("body { font-size: 19px !important; }");
    expect(css).toContain("h1 { font-size: 1.6em !important;");
    expect(css).not.toMatch(/font-family/);
  });
});

describe("sizePx", () => {
  it("treats 'original' and junk as no override", () => {
    expect(sizePx("original")).toBeNull();
    expect(sizePx(undefined)).toBeNull();
    expect(sizePx("l")).toBeNull();
  });
  it("clamps to the slider range", () => {
    expect(sizePx(8)).toBe(12);
    expect(sizePx(40)).toBe(26);
    expect(sizePx("18")).toBe(18);
  });
});

describe("isEInk", () => {
  it("recognises Boox devices", () => {
    expect(isEInk("Mozilla/5.0 (Linux; Android 11; Palma Build/RKQ1.210614.002; wv) AppleWebKit/537.36")).toBe(true);
    expect(isEInk("Mozilla/5.0 (Linux; Android 12; NoteAir3C Build/SKQ1; wv)")).toBe(true);
  });
  it("leaves ordinary phones alone", () => {
    expect(isEInk("Mozilla/5.0 (Linux; Android 17; Pixel 8a Build/CP3A.261005.005; wv)")).toBe(false);
  });
});

describe("text anchors", () => {
  // happy-dom has no layout, so give each paragraph a fake rect by index
  function page(paragraphs, rectOf) {
    document.body.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join("");
    const ps = [...document.body.querySelectorAll("p")];
    document.createRange = () => {
      const range = { startContainer: null, setStart(n) { this.startContainer = n; }, setEnd() {},
        getBoundingClientRect() { return rectOf(ps.findIndex((p) => p.contains(this.startContainer))); } };
      return range;
    };
    return document.body;
  }
  const rect = (i) => ({ top: i * 100, bottom: i * 100 + 20, height: 20 });

  it("anchors on the first text below the given y", () => {
    const body = page(["First paragraph of text.", "Second paragraph is here, with more words in it.", "Third."], rect);
    expect(textAnchorAt(body, 50).startsWith("Second paragraph is here, with more words in it.")).toBe(true);
  });

  it("finds the anchor again wherever layout puts it", () => {
    const body = page(["First paragraph of text.", "Second paragraph is here, with more words in it."], (i) => rect(i * 3));
    expect(textAnchorTop(body, "Second paragraph is here")).toBe(300);
  });

  it("returns null when the text is gone or too short to trust", () => {
    const body = page(["Hello there, reader."], rect);
    expect(textAnchorTop(body, "not in the article")).toBeNull();
    expect(textAnchorAt(body, 5000)).toBeNull();
  });
});

describe("margins", () => {
  it("defaults when unset or invalid, and clamps", () => {
    expect(marginPx(undefined)).toBe(10);
    expect(marginPx("nope")).toBe(10);
    expect(marginPx(-5)).toBe(0);
    expect(marginPx(500)).toBe(40);
    expect(marginPx(4)).toBe(4);
  });

  it("only overrides the article's side padding when changed from the default", () => {
    expect(textStyle({ margin: 10 })).toBe("");
    const css = textStyle({ margin: 2 });
    expect(css).toContain("padding-left: 2px !important");
    expect(css).toContain("padding-right: 2px !important");
  });
});

describe("text weight", () => {
  it("adds nothing for the original weight and keeps headings bold otherwise", () => {
    expect(textStyle({ weight: "original" })).toBe("");
    expect(textStyle({ weight: 999 })).toBe("");
    const css = textStyle({ weight: 500 });
    expect(css).toContain("font-weight: 500 !important");
    expect(css).toMatch(/b, strong, h1.*font-weight: 700 !important/);
  });

  it("defaults to heavier black text on e-ink only", () => {
    expect(readingDefaults(true)).toEqual({ weight: 500, black: true });
    expect(readingDefaults(false)).toEqual({ weight: "original", black: false });
  });
});

describe("blackenText", () => {
  const html = `<p id="grey" style="color: rgb(90,90,90)">grey</p>
    <p id="light" style="color: rgb(240,240,240)">light on dark</p>
    <p id="blue" style="color: rgb(37,99,235)">link-ish</p>
    <div id="wrap"><span id="empty"></span></div>`;

  it("blackens dark text, leaves light and coloured text, and can undo", () => {
    document.body.innerHTML = html;
    blackenText(document, true);
    const color = (id) => document.getElementById(id).style.color;
    expect(["#000", "rgb(0, 0, 0)"]).toContain(color("grey"));
    expect(color("light")).toBe("rgb(240, 240, 240)");
    expect(color("blue")).toBe("rgb(37, 99, 235)");
    blackenText(document, false);
    expect(color("grey")).toBe("rgb(90, 90, 90)");
  });
});
