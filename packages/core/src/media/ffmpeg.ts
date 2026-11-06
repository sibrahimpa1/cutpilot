import { spawn } from "node:child_process";
import { config } from "../config";

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

export type RunOptions = {
  cwd?: string;
  signal?: AbortSignal;
  /** Called with output seconds processed, parsed from `-progress pipe:1`. */
  onTime?: (seconds: number) => void;
  /** Return stdout as a Buffer (for raw frames). */
  binary?: boolean;
};

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let progressBuf = "";
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      if (opts.onTime) {
        progressBuf += d.toString();
        let i;
        while ((i = progressBuf.indexOf("\n")) >= 0) {
          const line = progressBuf.slice(0, i);
          progressBuf = progressBuf.slice(i + 1);
          const m = /^out_time_us=(\d+)/.exec(line);
          if (m) opts.onTime(Number(m[1]) / 1e6);
        }
      } else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`${cmd} failed to start: ${e.message}. Is it installed and on PATH?`));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new CancelledError());
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} exited with ${code}: ${err.split("\n").slice(-12).join("\n")}`));
    });
  });
}

export function ffmpeg(args: string[], opts?: RunOptions) {
  return run(config.ffmpeg, ["-hide_banner", "-y", "-loglevel", "error", ...args], opts);
}

export type Probe = {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number | null;
};

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run(config.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const j = JSON.parse(stdout.toString());
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
  let fps: number | null = null;
  if (v?.avg_frame_rate && v.avg_frame_rate.includes("/")) {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    fps = d ? n / d : null;
  }
  // Rotation metadata (phone footage) swaps width/height.
  const rot = Math.abs(Number(v?.side_data_list?.find((s: any) => s.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0),
    width: v ? (swap ? v.height : v.width) : null,
    height: v ? (swap ? v.width : v.height) : null,
    hasVideo: !!v,
    hasAudio: !!a,
    fps,
  };
}

/** 16 kHz mono WAV — what Whisper wants. */
export async function extractAudio(src: string, out: string, opts: { start?: number; duration?: number; signal?: AbortSignal } = {}) {
  const args: string[] = [];
  if (opts.start != null) args.push("-ss", String(opts.start));
  if (opts.duration != null) args.push("-t", String(opts.duration));
  args.push("-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out);
  await ffmpeg(args, { signal: opts.signal });
  return out;
}

export async function extractFrame(src: string, t: number, out: string, width = 480) {
  await ffmpeg(["-ss", String(Math.max(0, t)), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out]);
  return out;
}

/** Normalise any audio file to 48 kHz stereo WAV. */
export async function toWav(src: string, out: string, signal?: AbortSignal) {
  await ffmpeg(["-i", src, "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out], { signal });
  return out;
}

/** Path for use inside a filtergraph / concat list (quotes escaped). */
export function concatQuote(p: string) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}
