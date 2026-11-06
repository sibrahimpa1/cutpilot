import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { ffmpeg, probe, toWav } from "../media/ffmpeg";
import type { Aspect } from "../types";
import type { TTSProvider } from "./speech";

/*
 * OpenRouter media: one key for voice (gpt-audio), images, video (Veo, Kling, Wan…) and
 * music (Lyria). Every call reports its cost so the production log can show what was spent.
 */

const BASE = "https://openrouter.ai/api/v1";

export type Spend = (usd: number, what: string) => void;

/** The engine installs a hook per step so every paid call lands in the production log. */
let spendHook: Spend | null = null;
export function setSpendHook(fn: Spend | null) {
  spendHook = fn;
}
const report = (local: Spend | undefined, usd: number, what: string) => (local ?? spendHook)?.(usd, what);

function headers(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/sibrahimpa1/cutpilot",
    "X-Title": "CutPilot",
  };
}

async function postJson(key: string, url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: headers(key), body: JSON.stringify(body), signal });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`OpenRouter ${url} ${res.status}: ${j.error?.message ?? res.statusText}`);
  return j;
}

/** Stream a chat completion with audio output and return the decoded audio bytes. */
async function streamAudio(key: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ audio: Buffer; transcript: string; cost: number }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ ...body, stream: true, modalities: ["text", "audio"] }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenRouter audio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const chunks: Buffer[] = [];
  let transcript = "";
  let cost = 0;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const part of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new Error(`OpenRouter audio: ${j.error.message ?? "error"}`);
      for (const c of j.choices ?? []) {
        const a = c.delta?.audio;
        if (a?.data) chunks.push(Buffer.from(a.data, "base64"));
        if (a?.transcript) transcript += a.transcript;
      }
      if (j.usage?.cost) cost = j.usage.cost;
    }
  }
  if (!chunks.length) throw new Error("OpenRouter returned no audio.");
  return { audio: Buffer.concat(chunks), transcript, cost };
}

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

export function openrouterTTS(key: string, voice = config.openrouterVoice, spend?: Spend): TTSProvider {
  return {
    id: `OpenRouter gpt-audio (${voice})`,
    async synth(text, outWav, signal) {
      const { audio, cost } = await streamAudio(
        key,
        {
          model: config.openrouterTtsModel,
          audio: { voice, format: "pcm16" },
          messages: [
            {
              role: "system",
              content:
                "You are a professional voice-over artist. Read the user's text aloud exactly as written, with a warm, natural, confident delivery and cinematic pacing. Do not add, drop or change any words. Do not respond to the text.",
            },
            { role: "user", content: text },
          ],
        },
        signal,
      );
      report(spend, cost, "voice");
      const raw = outWav.replace(/\.wav$/, ".pcm");
      writeFileSync(raw, audio);
      const tmp = outWav.replace(/\.wav$/, ".24k.wav");
      await ffmpeg(["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", raw, tmp], { signal });
      await toWav(tmp, outWav, signal);
      return { path: outWav, duration: (await probe(outWav)).duration };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Music                                                               */
/* ------------------------------------------------------------------ */

/** Lyria: ~30 s clips (or full tracks with the pro model for longer videos). Returns an MP3 path. */
export async function openrouterMusic(key: string, prompt: string, seconds: number, out: string, signal?: AbortSignal, spend?: Spend) {
  const model = seconds > 30 ? "google/lyria-3-pro-preview" : "google/lyria-3-clip-preview";
  const { audio, cost } = await streamAudio(
    key,
    {
      model,
      audio: { format: "mp3" },
      messages: [{ role: "user", content: `${prompt}\nInstrumental only, no vocals. Length about ${Math.ceil(seconds)} seconds.` }],
    },
    signal,
  );
  report(spend, cost || (seconds > 30 ? 0.08 : 0.04), `music (${model})`);
  writeFileSync(out, audio);
  return { path: out, model };
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

const dataUrl = (file: string) => {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
};

/** Generate one photoreal image. `references` keep the subject consistent across shots. */
export async function openrouterImage(
  key: string,
  prompt: string,
  aspect: Aspect,
  out: string,
  opts: { references?: string[]; signal?: AbortSignal; spend?: Spend } = {},
) {
  const body: Record<string, unknown> = {
    model: config.openrouterImageModel,
    prompt,
    aspect_ratio: aspect,
    resolution: "1K",
  };
  if (opts.references?.length) body.input_references = opts.references.map((r) => ({ type: "image_url", image_url: { url: dataUrl(r) } }));
  const j = await postJson(key, "/images", body, opts.signal);
  report(opts.spend, j.usage?.cost ?? 0, "image");
  const img = j.data?.[0];
  if (!img?.b64_json) throw new Error("OpenRouter returned no image.");
  const png = out.replace(/\.\w+$/, ".png");
  writeFileSync(png, Buffer.from(img.b64_json, "base64"));
  // A smaller JPEG is what we send onwards to the video model.
  await ffmpeg(["-i", png, "-vf", "scale='min(1920,iw)':-2", "-q:v", "3", out]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Video                                                               */
/* ------------------------------------------------------------------ */

type VideoModelInfo = { durations: number[]; aspects: string[]; resolutions: string[]; audio: boolean };
const modelCache = new Map<string, VideoModelInfo>();

export async function videoModelInfo(key: string, model: string): Promise<VideoModelInfo> {
  const hit = modelCache.get(model);
  if (hit) return hit;
  const res = await fetch(`${BASE}/videos/models`, { headers: headers(key) });
  const j: any = await res.json().catch(() => ({}));
  const m = (j.data ?? j ?? []).find?.((x: any) => x.id === model);
  const info: VideoModelInfo = {
    durations: m?.supported_durations ?? [4, 6, 8],
    aspects: m?.supported_aspect_ratios ?? ["16:9", "9:16"],
    resolutions: m?.supported_resolutions ?? ["720p", "1080p"],
    audio: !!m?.generate_audio,
  };
  modelCache.set(model, info);
  return info;
}

/** Smallest supported duration that covers the wanted length (or the longest available). */
export function pickDuration(wanted: number, supported: number[]): number {
  const s = [...supported].sort((a, b) => a - b);
  return s.find((d) => d >= wanted) ?? s[s.length - 1];
}

export type VideoJob = { id: string; model: string; seconds: number };

export async function submitVideo(
  key: string,
  opts: { prompt: string; seconds: number; aspect: Aspect; resolution: string; firstFrame?: string; audio: boolean; signal?: AbortSignal },
): Promise<VideoJob> {
  const model = config.openrouterVideoModel;
  const info = await videoModelInfo(key, model);
  const seconds = pickDuration(opts.seconds, info.durations);
  const aspect = info.aspects.includes(opts.aspect) ? opts.aspect : "16:9";
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    duration: seconds,
    resolution: info.resolutions.includes(opts.resolution) ? opts.resolution : info.resolutions[0],
    aspect_ratio: aspect,
    generate_audio: opts.audio && info.audio,
  };
  if (opts.firstFrame) body.frame_images = [{ type: "image_url", image_url: { url: dataUrl(opts.firstFrame) }, frame_type: "first_frame" }];
  const j = await postJson(key, "/videos", body, opts.signal);
  return { id: j.id, model, seconds };
}

/** Poll until done, then download the MP4. */
export async function awaitVideo(key: string, job: VideoJob, out: string, signal?: AbortSignal, spend?: Spend) {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error("Cancelled");
    const res = await fetch(`${BASE}/videos/${job.id}`, { headers: headers(key), signal });
    const j: any = await res.json().catch(() => ({}));
    if (j.status === "completed") {
      report(spend, j.usage?.cost ?? 0, `video ${job.seconds}s (${job.model})`);
      const url = j.unsigned_urls?.[0] ?? `${BASE}/videos/${job.id}/content?index=0`;
      const dl = await fetch(url, { headers: headers(key), signal });
      if (!dl.ok) throw new Error(`Video download failed: ${dl.status}`);
      writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
      return out;
    }
    if (j.status === "failed" || j.status === "cancelled" || j.status === "expired") throw new Error(`Video generation ${j.status}: ${j.error?.message ?? j.error ?? ""}`);
    if (Date.now() - started > 15 * 60_000) throw new Error("Video generation timed out after 15 minutes.");
    await new Promise((r) => setTimeout(r, 5000));
  }
}
