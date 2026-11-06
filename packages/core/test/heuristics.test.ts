import { describe, expect, it } from "vitest";
import { cleanHook, heuristicRevision, heuristicScript, heuristicSelect, sentences } from "../src/providers/heuristics";
import { RevisionPlan, Script } from "../src/types";
import { clip, timeline, words } from "./helpers";

const interview = [
  ...words("Um, thanks for having me.", 0, 0.4),
  ...words("The biggest mistake remote teams make is treating chat like a meeting room.", 3, 0.4),
  ...words("We tried a lot of tools.", 9, 0.4),
  ...words("Here is how you cut meetings in half: write every decision down first.", 12, 0.4),
];

describe("sentences", () => {
  it("splits on punctuation and long pauses", () => {
    const s = sentences("a", interview);
    expect(s).toHaveLength(4);
    expect(s[1].text).toMatch(/^The biggest mistake/);
  });
});

describe("heuristicSelect", () => {
  it("prefers on-brief, hook-like sentences and keeps chronological order", () => {
    const sel = heuristicSelect([{ assetId: "a", words: interview, duration: 20 }], "remote meetings", 10, 3);
    expect(sel.moments.length).toBeGreaterThan(0);
    const texts = sel.moments.map((m) => sentences("a", interview).find((s) => s.start === m.start)?.text);
    expect(texts.join(" ")).toMatch(/biggest mistake|cut meetings/);
    expect(sel.moments.map((m) => m.start)).toEqual([...sel.moments.map((m) => m.start)].sort((a, b) => a - b));
    expect(sel.hook).not.toMatch(/^um/i);
  });

  it("falls back to evenly spaced moments without speech", () => {
    const sel = heuristicSelect([{ assetId: "a", words: [], duration: 60 }], "", 18, 3);
    expect(sel.moments).toHaveLength(3);
  });
});

describe("cleanHook", () => {
  it("strips fillers and caps length", () => {
    expect(cleanHook("So, um, the question I get most is how we run a fully remote team")).toBe("The question I get most is how we");
  });
});

describe("heuristicScript", () => {
  it("turns the idea's sentences into scenes", () => {
    const s = Script.parse(heuristicScript("Three remote habits. Write it down. Two meetings a week. Demo on Fridays.", 30));
    expect(s.scenes.length).toBeGreaterThanOrEqual(5);
    expect(s.scenes[0].narration).toMatch(/^Three remote habits/);
    expect(s.scenes.map((x) => x.narration).join(" ")).toMatch(/Demo on Fridays/);
    expect(new Set(s.scenes.map((x) => x.visual)).size).toBe(s.scenes.length);
  });
});

describe("heuristicRevision", () => {
  const t = timeline([clip("a", 0, 3, words("um this is it")), clip("b", 5, 8), clip("c", 9, 12)], { music: { src: "/m.wav", volume: 0.2 } });

  it("parses several requests in one message", () => {
    const plan = RevisionPlan.parse(heuristicRevision('Remove the second clip and make it vertical; replace "it" with "IT"', t));
    expect(plan.ops).toEqual([
      { op: "remove_clip", index: 1 },
      { op: "set_aspect", aspect: "9:16" },
      { op: "replace_caption_text", find: "it", replace: "IT" },
    ]);
  });

  it("understands durations, captions, music and fillers", () => {
    expect(heuristicRevision("cut it down to 20 seconds", t).ops).toEqual([{ op: "target_duration", seconds: 20 }]);
    expect(heuristicRevision("turn off captions", t).ops).toEqual([{ op: "set_caption_style", style: "off" }]);
    expect(heuristicRevision("make the music quieter", t).ops).toEqual([{ op: "set_music_volume", volume: 0.1 }]);
    expect(heuristicRevision("remove the filler words", t).ops).toEqual([{ op: "remove_phrase", text: "um" }]);
    expect(heuristicRevision("delete the last clip", t).ops).toEqual([{ op: "remove_clip", index: 2 }]);
  });

  it("says what it could not understand", () => {
    const plan = heuristicRevision("make it feel more cinematic", t);
    expect(plan.ops).toEqual([]);
    expect(plan.explanation).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("mood pieces", () => {
  it("plans picture-and-music shots with no narration for cinematic requests", () => {
    const s = Script.parse(heuristicScript("Generate me a BMW driving through Croatia near the sea, make it look cinematic", 24));
    expect(s.scenes.every((x) => x.narration === "")).toBe(true);
    expect(s.subject).toMatch(/BMW/);
    expect(s.scenes.reduce((a, x) => a + x.duration, 0)).toBeGreaterThanOrEqual(18);
    expect(s.musicPrompt).toBeTruthy();
  });
  it("respects an explicit narration setting", () => {
    expect(heuristicScript("Three tips. One. Two.", 20, "off").scenes.every((x) => !x.narration)).toBe(true);
    expect(heuristicScript("Generate me a cinematic drone shot of Split", 20, "on").scenes.some((x) => x.narration)).toBe(true);
  });
});
