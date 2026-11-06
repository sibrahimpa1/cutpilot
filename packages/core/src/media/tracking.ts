import { ffmpeg } from "./ffmpeg";
import type { CropKeyframe } from "../types";

/**
 * Subject tracking for reframing (e.g. 16:9 → 9:16) without a GPU or a model download.
 *
 * Frames are sampled at a low rate as tiny grayscale images. Each frame scores columns by
 * motion (difference to the previous frame) plus local contrast, which is where people,
 * faces and hands usually are. The weighted centroid of that energy is the subject
 * position. It is smoothed and speed-limited so the virtual camera pans like an operator
 * instead of jittering.
 */

export const TRACK_W = 96;
export const TRACK_H = 54;

export function columnEnergy(frame: Uint8Array, prev: Uint8Array | null, w = TRACK_W, h = TRACK_H): Float64Array {
  const col = new Float64Array(w);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const motion = prev ? Math.abs(frame[i] - prev[i]) : 0;
      const contrast = Math.abs(frame[i] - frame[i - 1]) + Math.abs(frame[i] - frame[i - w]);
      col[x] += motion * 3 + contrast * 0.5;
    }
  }
  return col;
}

/** Weighted centroid (0..1). Energy is squared so one strong subject beats diffuse texture. Null if the frame is flat. */
export function centroid(col: Float64Array): number | null {
  let sum = 0;
  let wsum = 0;
  let max = 0;
  for (let x = 0; x < col.length; x++) max = Math.max(max, col[x]);
  if (max < 1) return null;
  for (let x = 0; x < col.length; x++) {
    const e = (col[x] / max) ** 2;
    sum += e * (x + 0.5);
    wsum += e;
  }
  return wsum > 0 ? sum / wsum / col.length : null;
}

/** Exponential smoothing plus a max pan speed (fraction of frame width per second). */
export function smoothPath(points: { t: number; cx: number | null }[], opts = { alpha: 0.35, maxSpeed: 0.35 }): CropKeyframe[] {
  const out: CropKeyframe[] = [];
  let cur: number | null = null;
  let lastT = 0;
  for (const p of points) {
    const target: number = p.cx ?? cur ?? 0.5;
    if (cur == null) cur = target;
    else {
      const dt = Math.max(1e-3, p.t - lastT);
      let next: number = cur + opts.alpha * (target - cur);
      const maxStep = opts.maxSpeed * dt;
      next = Math.max(cur - maxStep, Math.min(cur + maxStep, next));
      cur = next;
    }
    lastT = p.t;
    out.push({ t: Number(p.t.toFixed(3)), cx: Number(Math.min(1, Math.max(0, cur as number)).toFixed(4)) });
  }
  return out;
}

/** Drop keyframes that a straight line between their neighbours already explains. */
export function simplify(kf: CropKeyframe[], tolerance = 0.01): CropKeyframe[] {
  if (kf.length <= 2) return kf;
  const out = [kf[0]];
  for (let i = 1; i < kf.length - 1; i++) {
    const a = out[out.length - 1];
    const b = kf[i + 1];
    const m = kf[i];
    const expected = a.cx + ((b.cx - a.cx) * (m.t - a.t)) / Math.max(1e-6, b.t - a.t);
    if (Math.abs(expected - m.cx) > tolerance) out.push(m);
  }
  out.push(kf[kf.length - 1]);
  return out;
}

/** Track the subject inside [start, end] of a video. Keyframe times are relative to `start`. */
export async function trackSubject(src: string, start: number, end: number, opts: { fps?: number; signal?: AbortSignal } = {}): Promise<CropKeyframe[]> {
  const fps = opts.fps ?? 4;
  const { stdout } = await ffmpeg(
    [
      "-ss",
      String(start),
      "-t",
      String(Math.max(0.1, end - start)),
      "-i",
      src,
      "-vf",
      `fps=${fps},scale=${TRACK_W}:${TRACK_H},format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { signal: opts.signal },
  );
  const size = TRACK_W * TRACK_H;
  const frames = Math.floor(stdout.length / size);
  const pts: { t: number; cx: number | null }[] = [];
  let prev: Uint8Array | null = null;
  for (let f = 0; f < frames; f++) {
    const frame = new Uint8Array(stdout.buffer, stdout.byteOffset + f * size, size);
    pts.push({ t: f / fps, cx: centroid(columnEnergy(frame, prev)) });
    prev = frame;
  }
  return simplify(smoothPath(pts)).slice(0, 60);
}
