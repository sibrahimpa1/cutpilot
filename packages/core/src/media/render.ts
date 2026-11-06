import { statSync } from "node:fs";
import path from "node:path";
import { ASPECT_SIZE, clipDuration, clipStarts, timelineDuration, transitionOverlap, type Clip, type CropKeyframe, type Timeline } from "../types";
import { extractFrame, ffmpeg, probe } from "./ffmpeg";
import { writeOverlayTrack } from "./overlays";

export type SourceInfo = { width: number; height: number; hasAudio: boolean };

const r3 = (n: number) => Number(n.toFixed(3));

/** Piecewise-linear centre-x expression for FFmpeg's crop filter (t = clip-local seconds). */
export function cropCenterExpr(kf: CropKeyframe[]): string {
  const k = kf.length ? kf : [{ t: 0, cx: 0.5 }];
  if (k.length === 1) return String(r3(k[0].cx));
  let expr = String(r3(k[k.length - 1].cx));
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    const lerp = `${r3(a.cx)}+${r3(b.cx - a.cx)}*(t-${r3(a.t)})/${r3(dt)}`;
    expr = `if(lt(t,${r3(b.t)}),${lerp},${expr})`;
  }
  return expr;
}

/** Video filter chain that turns one source clip into a W×H, 30 fps, yuv420p stream. */
export function clipVideoFilter(c: Clip, src: SourceInfo | null, W: number, H: number, fps: number): string {
  const D = r3(clipDuration(c));
  const tail = `setsar=1,format=yuv420p,fps=${fps},tpad=stop_mode=clone:stop_duration=1,trim=duration=${D},setpts=PTS-STARTPTS,settb=AVTB`;
  if (c.kind === "image") {
    if (c.kenBurns) {
      const F = Math.max(1, Math.round(clipDuration(c) * fps));
      const SW = Math.round(W * 1.5);
      const SH = Math.round(H * 1.5);
      return `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},zoompan=z='1+0.12*on/${F}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${F}:s=${W}x${H}:fps=${fps},${tail}`;
    }
    return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}`;
  }
  const sw = src?.width ?? W;
  const sh = src?.height ?? H;
  const srcAspect = sw / sh;
  const dstAspect = W / H;
  if (srcAspect > dstAspect * 1.01) {
    // Wider than the target (e.g. 16:9 → 9:16): crop width, following the subject.
    const cw = Math.min(sw, Math.round((sh * dstAspect) / 2) * 2);
    const cx = c.crop?.length ? cropCenterExpr(c.crop) : "0.5";
    return `crop=w=${cw}:h=${sh}:x='max(0,min(iw-ow,(${cx})*iw-ow/2))':y=0,scale=${W}:${H},${tail}`;
  }
  if (srcAspect < dstAspect / 1.3) {
    // Much taller than the target (vertical phone clip in a 16:9 edit): blurred fill behind the original.
    return `split=2[bgsrc][fgsrc];[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4[bg];[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}`;
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}`;
}

export type RenderPlan = { args: string[]; duration: number };

/**
 * Build the complete FFmpeg command for a timeline. Pure: no I/O, so the whole
 * filter graph is unit-tested without running FFmpeg.
 */
export function buildRenderPlan(
  t: Timeline,
  sources: Record<string, SourceInfo>,
  out: string,
  opts: { overlayList?: string | null; preset?: string } = {},
): RenderPlan {
  if (!t.clips.length) throw new Error("Timeline has no clips");
  const { width: W, height: H } = ASPECT_SIZE[t.aspect];
  const fps = t.fps ?? 30;
  const total = timelineDuration(t);
  const args: string[] = [];
  const filters: string[] = [];
  let input = 0;
  const pairs: string[] = [];

  t.clips.forEach((c, i) => {
    const D = r3(clipDuration(c));
    const src = sources[c.src] ?? null;
    // Video input
    const vIdx = input++;
    if (c.kind === "image") {
      if (c.kenBurns) args.push("-i", c.src);
      else args.push("-loop", "1", "-framerate", String(fps), "-t", String(D), "-i", c.src);
    } else if (c.loop) {
      args.push("-stream_loop", "-1", "-ss", String(r3(c.in)), "-t", String(D), "-i", c.src);
    } else {
      args.push("-ss", String(r3(c.in)), "-t", String(D), "-i", c.src);
    }
    filters.push(`[${vIdx}:v]${clipVideoFilter(c, src, W, H, fps).replace(/\[(bgsrc|fgsrc|bg|fg)\]/g, `[$1${i}]`)}[v${i}]`);

    // Audio for this clip: a voiceover (optionally over the clip's own sound), its own track, or silence.
    const norm = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
    const fit = `apad=whole_dur=${D},atrim=0:${D},asetpts=PTS-STARTPTS`;
    const ownAudio = c.kind === "video" && src?.hasAudio && !c.muted;
    if (c.audioSrc) {
      const aIdx = input++;
      args.push("-i", c.audioSrc);
      if (c.kind === "video" && src?.hasAudio && (c.ambience ?? 0) > 0) {
        filters.push(`[${vIdx}:a]${norm},volume=${c.ambience}[amb${i}]`);
        filters.push(`[${aIdx}:a]${norm}[vo${i}]`);
        filters.push(`[amb${i}][vo${i}]amix=inputs=2:duration=longest:normalize=0,${fit}[a${i}]`);
      } else {
        filters.push(`[${aIdx}:a]${norm},${fit}[a${i}]`);
      }
    } else if (ownAudio) {
      filters.push(`[${vIdx}:a]${norm},${c.ambience != null ? `volume=${c.ambience},` : ""}${fit}[a${i}]`);
    } else {
      const aIdx = input++;
      args.push("-f", "lavfi", "-t", String(D), "-i", "anullsrc=r=48000:cl=stereo");
      filters.push(`[${aIdx}:a]${norm},${fit}[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });

  const overlap = transitionOverlap(t);
  if (overlap > 0) {
    // Crossfades: chain xfade/acrossfade, each starting where the next clip begins.
    const starts = clipStarts(t);
    let pv = "v0";
    let pa = "a0";
    for (let i = 1; i < t.clips.length; i++) {
      const nv = i === t.clips.length - 1 ? "cv" : `xv${i}`;
      const na = i === t.clips.length - 1 ? "ca" : `xa${i}`;
      filters.push(`[${pv}][v${i}]xfade=transition=fade:duration=${r3(overlap)}:offset=${r3(starts[i])}[${nv}]`);
      filters.push(`[${pa}][a${i}]acrossfade=d=${r3(overlap)}:c1=tri:c2=tri[${na}]`);
      pv = nv;
      pa = na;
    }
  } else {
    filters.push(`${pairs.join("")}concat=n=${t.clips.length}:v=1:a=1[cv][ca]`);
  }

  let v = "cv";
  if (opts.overlayList) {
    const oIdx = input++;
    args.push("-f", "concat", "-safe", "0", "-i", opts.overlayList);
    filters.push(`[${oIdx}:v]format=rgba,fps=${fps},setpts=PTS-STARTPTS[ov]`);
    filters.push(`[cv][ov]overlay=0:0:eof_action=pass:format=auto[cvo]`);
    v = "cvo";
  }
  const T = r3(total);
  const fadeOut = Math.max(0, r3(total - 0.35));
  filters.push(`[${v}]fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[vout]`);

  let a = "ca";
  if (t.music) {
    const mIdx = input++;
    args.push("-stream_loop", "-1", "-i", t.music.src);
    const fo = Math.max(0, r3(total - 1.5));
    filters.push(
      `[${mIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${t.music.volume},atrim=0:${T},afade=t=in:d=1,afade=t=out:st=${fo}:d=1.5[mus]`,
    );
    if (t.music.duck !== false) {
      // Duck the music whenever someone speaks.
      filters.push(`[ca]asplit=2[ca1][ca2]`);
      filters.push(`[mus][ca2]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck]`);
      filters.push(`[ca1][duck]amix=inputs=2:duration=first:normalize=0[am]`);
    } else {
      // Music-led piece: score and natural sound sit side by side.
      filters.push(`[ca][mus]amix=inputs=2:duration=first:normalize=0[am]`);
    }
    a = "am";
  }
  filters.push(`[${a}]afade=t=in:d=0.15,afade=t=out:st=${fadeOut}:d=0.35,alimiter=limit=0.95[aout]`);

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    String(T),
    "-c:v",
    "libx264",
    "-preset",
    opts.preset ?? "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    out,
  );
  return { args, duration: total };
}

export type RenderResult = {
  path: string;
  thumb: string;
  duration: number;
  width: number;
  height: number;
  sizeBytes: number;
  renderMs: number;
  overlayFrames: number;
};

/** Render a timeline to an MP4 in `dir`. */
export async function renderTimeline(
  t: Timeline,
  dir: string,
  opts: { onProgress?: (p: number, msg: string) => void; signal?: AbortSignal; fileName?: string } = {},
): Promise<RenderResult> {
  const started = Date.now();
  const sources: Record<string, SourceInfo> = {};
  for (const c of t.clips) {
    if (c.kind === "video" && !sources[c.src]) {
      const p = await probe(c.src);
      sources[c.src] = { width: p.width ?? 1920, height: p.height ?? 1080, hasAudio: p.hasAudio };
    }
  }
  const total = timelineDuration(t);
  opts.onProgress?.(0.02, "Drawing captions and titles");
  const overlay = writeOverlayTrack(t, total, dir);
  const out = path.join(dir, opts.fileName ?? "video.mp4");
  const plan = buildRenderPlan(t, sources, out, { overlayList: overlay?.listPath ?? null });
  opts.onProgress?.(0.05, `Encoding ${total.toFixed(1)}s with FFmpeg`);
  await ffmpeg(plan.args, {
    cwd: dir,
    signal: opts.signal,
    onTime: (s) => opts.onProgress?.(0.05 + 0.9 * Math.min(1, s / total), `Encoding ${s.toFixed(1)}/${total.toFixed(1)}s`),
  });
  const p = await probe(out);
  const thumb = path.join(dir, path.basename(out, ".mp4") + ".jpg");
  await extractFrame(out, Math.min(p.duration * 0.3, 3), thumb, 640);
  return {
    path: out,
    thumb,
    duration: p.duration,
    width: p.width ?? 0,
    height: p.height ?? 0,
    sizeBytes: statSync(out).size,
    renderMs: Date.now() - started,
    overlayFrames: overlay?.count ?? 0,
  };
}
