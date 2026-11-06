import { describe, expect, it } from "vitest";
import { centroid, columnEnergy, simplify, smoothPath, TRACK_H, TRACK_W } from "../src/media/tracking";
import { cropCenterExpr } from "../src/media/render";

function frameWithBlock(x: number): Uint8Array {
  const f = new Uint8Array(TRACK_W * TRACK_H).fill(40);
  for (let y = 15; y < 45; y++) for (let i = x; i < x + 12; i++) f[y * TRACK_W + i] = 220;
  return f;
}

describe("subject tracking", () => {
  it("finds a moving subject", () => {
    const prev = frameWithBlock(60);
    const cur = frameWithBlock(64);
    const cx = centroid(columnEnergy(cur, prev))!;
    expect(cx).toBeGreaterThan(0.6);
    expect(cx).toBeLessThan(0.85);
    const left = centroid(columnEnergy(frameWithBlock(8), frameWithBlock(4)))!;
    expect(left).toBeLessThan(0.25);
  });

  it("returns null for a flat frame", () => {
    const flat = new Uint8Array(TRACK_W * TRACK_H).fill(90);
    expect(centroid(columnEnergy(flat, flat))).toBeNull();
  });

  it("smooths and limits pan speed", () => {
    const path = smoothPath([
      { t: 0, cx: 0.2 },
      { t: 0.25, cx: 0.9 },
      { t: 0.5, cx: 0.9 },
      { t: 0.75, cx: null },
    ]);
    expect(path[0].cx).toBe(0.2);
    expect(path[1].cx - path[0].cx).toBeLessThanOrEqual(0.35 * 0.25 + 1e-9);
    expect(path[3].cx).toBe(path[2].cx); // lost subject: hold position
  });

  it("drops redundant keyframes", () => {
    const kf = [0, 1, 2, 3, 4].map((t) => ({ t, cx: 0.1 * t }));
    expect(simplify(kf)).toEqual([kf[0], kf[4]]);
  });

  it("builds a piecewise-linear crop expression", () => {
    expect(cropCenterExpr([{ t: 0, cx: 0.5 }])).toBe("0.5");
    const e = cropCenterExpr([
      { t: 0, cx: 0.2 },
      { t: 2, cx: 0.6 },
    ]);
    expect(e).toBe("if(lt(t,2),0.2+0.4*(t-0)/2,0.6)");
  });
});
