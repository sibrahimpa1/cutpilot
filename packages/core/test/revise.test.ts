import { describe, expect, it } from "vitest";
import { applyOps, cutRange, findPhrase } from "../src/revise";
import { timelineDuration } from "../src/types";
import { clip, timeline, words } from "./helpers";

const base = () =>
  timeline(
    [
      clip("a", 0, 4, words("this is the first clip of the edit", 0)),
      clip("b", 10, 14, words("um so the second clip is weaker", 10)),
      clip("c", 20, 23, words("and the final call to action", 20)),
    ],
    { titles: [{ text: "Hook", start: 0, end: 3, position: "top" }], music: { src: "/m.wav", volume: 0.1 } },
  );

describe("applyOps", () => {
  it("removes and moves clips", () => {
    const r = applyOps(base(), [{ op: "remove_clip", index: 1 }, { op: "move_clip", index: 1, to: 0 }]);
    expect(r.timeline.clips.map((c) => c.id)).toEqual(["c", "a"]);
    expect(r.notes).toEqual([]);
  });

  it("does not mutate the input", () => {
    const t = base();
    applyOps(t, [{ op: "remove_clip", index: 0 }]);
    expect(t.clips).toHaveLength(3);
  });

  it("reports out-of-range indexes instead of failing", () => {
    const r = applyOps(base(), [{ op: "remove_clip", index: 9 }]);
    expect(r.timeline.clips).toHaveLength(3);
    expect(r.notes[0]).toMatch(/doesn't exist/);
  });

  it("trims a clip and its words", () => {
    const r = applyOps(base(), [{ op: "trim_clip", index: 0, head: 1, tail: 1 }]);
    const c = r.timeline.clips[0];
    expect([c.in, c.out]).toEqual([1, 3]);
    expect(c.words.every((w) => w.end > 1 && w.start < 3)).toBe(true);
  });

  it("removes a spoken phrase by splitting the clip", () => {
    const r = applyOps(base(), [{ op: "remove_phrase", text: "um so" }]);
    const ids = r.timeline.clips.map((c) => c.id);
    expect(ids).toContain("bb");
    const b = r.timeline.clips.find((c) => c.id === "bb")!;
    expect(b.in).toBeGreaterThan(10.9);
    expect(b.words[0].text).toBe("the");
  });

  it("finds phrases case- and punctuation-insensitively", () => {
    expect(findPhrase(base(), "The Final, call")).toHaveLength(1);
  });

  it("cutRange keeps both sides and drops slivers", () => {
    const c = clip("x", 0, 10, words("a b c d e f g h", 0, 1));
    expect(cutRange(c, 4, 6).map((p) => [p.in, p.out])).toEqual([
      [0, 4],
      [6, 10],
    ]);
    expect(cutRange(c, 0.1, 10)).toHaveLength(0);
  });

  it("flags a reframe when the aspect changes and clears old crops", () => {
    const t = base();
    t.clips[0].crop = [{ t: 0, cx: 0.3 }];
    const r = applyOps(t, [{ op: "set_aspect", aspect: "9:16" }]);
    expect(r.needsReframe).toBe(true);
    expect(r.timeline.clips[0].crop).toBeUndefined();
    expect(applyOps(base(), [{ op: "set_aspect", aspect: "16:9" }]).needsReframe).toBe(false);
  });

  it("edits captions, titles and music", () => {
    const r = applyOps(base(), [
      { op: "replace_caption_text", find: "um", replace: "" },
      { op: "set_caption_style", style: "block" },
      { op: "set_title", text: "New hook" },
      { op: "set_music_volume", volume: 0.3 },
    ]);
    expect(r.timeline.captions).toEqual({ style: "block", replacements: [{ find: "um", replace: "" }] });
    expect(r.timeline.titles[0].text).toBe("New hook");
    expect(r.timeline.music?.volume).toBe(0.3);
    expect(applyOps(base(), [{ op: "remove_music" }, { op: "remove_titles" }]).timeline).toMatchObject({ music: null, titles: [] });
  });

  it("shortens to a target duration", () => {
    const r = applyOps(base(), [{ op: "target_duration", seconds: 7 }]);
    const d = timelineDuration(r.timeline);
    expect(d).toBeLessThanOrEqual(7.8);
    expect(d).toBeGreaterThan(5);
  });

  it("keeps titles inside the new running time", () => {
    const r = applyOps(base(), [{ op: "trim_clip", index: 0, head: 0, tail: 3.5 }, { op: "remove_clip", index: 1 }, { op: "remove_clip", index: 1 }]);
    expect(r.timeline.titles[0].end).toBeLessThanOrEqual(timelineDuration(r.timeline));
  });
});
