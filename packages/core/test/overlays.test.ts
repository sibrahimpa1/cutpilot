import { describe, expect, it } from "vitest";
import { applyReplacements, chunkWords, overlaySegments, overlaySvg, timelineWords, wrap } from "../src/media/overlays";
import { clip, timeline, words } from "./helpers";

describe("captions on the output clock", () => {
  it("maps source-time words of each clip onto the timeline", () => {
    const t = timeline([clip("a", 10, 12, words("one two three four", 10)), clip("b", 0, 1, words("five six", 0))]);
    const w = timelineWords(t);
    expect(w.map((x) => x.text)).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(w[0].start).toBeCloseTo(0);
    expect(w[4].start).toBeCloseTo(2); // second clip starts after 2 s of the first
  });

  it("drops words outside the clip range", () => {
    const t = timeline([clip("a", 1, 2, words("zero one two three", 0))]);
    expect(timelineWords(t).map((x) => x.text)).toEqual(["two", "three"]);
  });

  it("applies whole-word and multi-word caption replacements, keeping punctuation", () => {
    const w = words("we are gonna ship it, okay.");
    const out = applyReplacements(w, [
      { find: "gonna", replace: "going to" },
      { find: "it okay", replace: "it today" },
    ]);
    expect(out.map((x) => x.text).join(" ")).toBe("we are going to ship it today.");
  });

  it("can delete a word by replacing it with nothing", () => {
    expect(applyReplacements(words("so um yes"), [{ find: "um", replace: "" }]).map((w) => w.text)).toEqual(["so", "yes"]);
  });
});

describe("chunking and overlay segments", () => {
  it("breaks karaoke chunks at 4 words, sentence ends and pauses", () => {
    const w = [...words("a b c d e f.", 0, 0.3), ...words("g h", 5)];
    const chunks = chunkWords(w, "karaoke");
    expect(chunks.map((c) => c.words.map((x) => x.text).join(" "))).toEqual(["a b c d", "e f.", "g h"]);
    expect(chunkWords(w, "off")).toEqual([]);
  });

  it("highlights the active word in karaoke style", () => {
    const t = timeline([clip("a", 0, 2, words("hello big world", 0))]);
    const segs = overlaySegments(t, 2);
    const actives = segs.filter((s) => s.state.chunk).map((s) => s.state.active);
    expect(actives).toContain(0);
    expect(actives).toContain(2);
    const svg = overlaySvg(segs.find((s) => s.state.active === 1)!.state, t);
    expect(svg).toContain(">BIG</tspan>");
    expect(svg).toMatch(/fill="#FFD84D"[^>]*>BIG/);
  });

  it("includes titles and merges identical neighbouring states", () => {
    const t = timeline([clip("a", 0, 4)], { titles: [{ text: "Hook", start: 0, end: 2, position: "top" }] });
    const segs = overlaySegments(t, 4);
    expect(segs).toHaveLength(2);
    expect(segs[0].state.title?.text).toBe("Hook");
    expect(segs[1].state.title).toBeNull();
  });

  it("wraps long lines", () => {
    expect(wrap("one two three four five six seven".split(" "), 100, 600).length).toBeGreaterThan(1);
  });
});
