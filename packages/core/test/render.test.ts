import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpeg, probe } from "../src/media/ffmpeg";
import { generateMusicBed, sceneCardSvg } from "../src/media/generate";
import { svgToPng } from "../src/media/overlays";
import { buildRenderPlan, renderTimeline } from "../src/media/render";
import { commandExists } from "../src/providers/speech";
import { clip, timeline, words } from "./helpers";

const hasFfmpeg = commandExists("ffmpeg") && commandExists("ffprobe");

describe("buildRenderPlan", () => {
  const t = timeline(
    [
      clip("a", 2, 4, [], { src: "/v/a.mp4" }),
      { id: "img", kind: "image", src: "/i/x.png", in: 0, out: 3, kenBurns: true, audioSrc: "/a/voice.wav", words: [] },
    ],
    { aspect: "9:16", music: { src: "/m/bed.wav", volume: 0.2 } },
  );
  const plan = buildRenderPlan(t, { "/v/a.mp4": { width: 1920, height: 1080, hasAudio: true } }, "/out.mp4", { overlayList: "overlays.ffconcat" });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];

  it("seeks video inputs and loops stills", () => {
    expect(plan.args.join(" ")).toContain("-ss 2 -t 2 -i /v/a.mp4");
    expect(plan.duration).toBe(5);
  });

  it("crops 16:9 footage to 9:16 and zooms stills", () => {
    expect(graph).toContain("crop=w=608:h=1080");
    expect(graph).toContain("zoompan=");
  });

  it("concats, overlays captions, ducks music and fades", () => {
    expect(graph).toContain("concat=n=2:v=1:a=1[cv][ca]");
    expect(graph).toContain("overlay=0:0");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toMatch(/fade=t=out:st=4\.65/);
  });

  it("refuses an empty timeline", () => {
    expect(() => buildRenderPlan(timeline([]), {}, "/x.mp4")).toThrow(/no clips/);
  });
});

describe.skipIf(!hasFfmpeg)("renderTimeline (FFmpeg integration)", () => {
  let dir: string;
  let video: string;
  let card: string;
  let bed: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cutpilot-render-"));
    video = path.join(dir, "src.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6",
      "-f", "lavfi", "-i", "sine=f=440:d=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video,
    ]);
    card = path.join(dir, "card.png");
    writeFileSync(card, svgToPng(sceneCardSvg("a calm lake at sunrise", 0, 1080, 1920)));
    bed = await generateMusicBed(path.join(dir, "bed.wav"), 8);
  });

  it("renders a real MP4 with the expected size and length", async () => {
    const t = timeline(
      [
        clip("a", 1, 3, words("hello there from the test", 1, 0.35), { src: video }),
        { id: "s", kind: "image", src: card, in: 0, out: 1.5, kenBurns: true, words: [] },
      ],
      { aspect: "9:16", titles: [{ text: "Integration test", start: 0, end: 1, position: "top" }], music: { src: bed, volume: 0.2 } },
    );
    const progress: number[] = [];
    const r = await renderTimeline(t, dir, { onProgress: (p) => progress.push(p) });
    const p = await probe(r.path);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.duration).toBeGreaterThan(3.3);
    expect(p.duration).toBeLessThan(3.8);
    expect(p.hasAudio).toBe(true);
    expect(r.overlayFrames).toBeGreaterThan(2);
    expect(progress.at(-1)!).toBeGreaterThan(0.5);
  });
});
