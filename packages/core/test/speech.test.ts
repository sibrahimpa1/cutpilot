import { describe, expect, it } from "vitest";
import { evenWordTimings, parseWhisperCppJson, restorePunctuation } from "../src/providers/speech";
import { alignScriptToSpeech } from "../src/workflow/nodes";

describe("whisper.cpp output", () => {
  it("parses word segments, glues punctuation and skips markers", () => {
    const w = parseWhisperCppJson({
      transcription: [
        { offsets: { from: 0, to: 300 }, text: " Hello" },
        { offsets: { from: 300, to: 320 }, text: "," },
        { offsets: { from: 320, to: 700 }, text: " world" },
        { offsets: { from: 700, to: 900 }, text: "[BLANK_AUDIO]" },
      ],
    });
    expect(w).toEqual([
      { text: "Hello,", start: 0, end: 0.3 },
      { text: "world", start: 0.32, end: 0.7 },
    ]);
  });
});

describe("caption timing", () => {
  it("restores punctuation from the full transcript", () => {
    const w = restorePunctuation([{ text: "hi", start: 0, end: 1 }, { text: "there", start: 1, end: 2 }], "Hi, there!");
    expect(w.map((x) => x.text)).toEqual(["Hi,", "there!"]);
  });

  it("spreads words evenly inside the duration", () => {
    const w = evenWordTimings("one two three", 3);
    expect(w).toHaveLength(3);
    expect(w[2].end).toBeLessThanOrEqual(3);
    expect(w[0].start).toBeLessThan(w[1].start);
  });

  it("keeps the script's spelling but takes timings from speech", () => {
    const heard = [
      { text: "Right", start: 0.1, end: 0.4 },
      { text: "every", start: 0.5, end: 0.8 },
      { text: "decision", start: 0.9, end: 1.4 },
      { text: "down", start: 1.5, end: 1.8 },
    ];
    const out = alignScriptToSpeech("Write every decision down.", heard, 2);
    expect(out.map((w) => w.text)).toEqual(["Write", "every", "decision", "down."]);
    expect(out[1].start).toBe(0.5);
    expect(out[0].start).toBeGreaterThanOrEqual(0); // "Write" was misheard: interpolated
    expect(out[0].end).toBeLessThanOrEqual(0.5);
  });
});

describe("snapping AI timestamps to words", () => {
  it("excludes the first word of the next sentence", async () => {
    const { snapToWords } = await import("../src/workflow/nodes");
    const ws = [
      { text: "build", start: 12.2, end: 12.6 },
      { text: "anything.", start: 12.6, end: 12.98 },
      { text: "The", start: 13.0, end: 13.2 },
    ];
    expect(snapToWords(ws, 12.2, 12.98)).toEqual({ start: 12.2, end: 12.98 });
  });
});
