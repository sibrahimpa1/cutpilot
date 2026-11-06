import { writeFileSync } from "node:fs";
import path from "node:path";
import { writeSceneCard } from "../media/generate";
import { probe } from "../media/ffmpeg";
import { awaitVideo, openrouterImage, submitVideo } from "./openrouter";
import { ASPECT_SIZE, type Aspect } from "../types";

export type Visual = { path: string; kind: "image" | "video"; credit?: string; duration?: number };

export type ShotRequest = { visual: string; seconds: number };
export type BatchOptions = {
  subject: string;
  look: string;
  resolution: string;
  audio: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, msg: string) => void;
  log?: (action: string, detail: string) => void;
  spend?: (usd: number, what: string) => void;
};

export interface VisualsProvider {
  id: string;
  get(prompt: string, index: number, aspect: Aspect, dir: string, signal?: AbortSignal): Promise<Visual>;
  /** Providers that need the whole shot list at once (for a consistent subject across shots). */
  getAll?(shots: ShotRequest[], aspect: Aspect, dir: string, opts: BatchOptions): Promise<Visual[]>;
}

export const placeholderVisuals: VisualsProvider = {
  id: "generated scene cards (offline)",
  async get(prompt, index, aspect, dir) {
    const { width, height } = ASPECT_SIZE[aspect];
    const out = path.join(dir, `scene_${index}.png`);
    writeSceneCard(out, prompt, index, width, height);
    return { path: out, kind: "image" };
  },
};

async function download(url: string, out: string, signal?: AbortSignal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}

/** Pexels stock: prefers a video clip, falls back to a photo. Free API key at pexels.com/api. */
export function pexelsVisuals(apiKey: string): VisualsProvider {
  const orientation = (a: Aspect) => (a === "9:16" ? "portrait" : a === "1:1" ? "square" : "landscape");
  return {
    id: "Pexels stock",
    async get(prompt, index, aspect, dir, signal) {
      const q = encodeURIComponent(prompt.split(/[,.]/)[0].slice(0, 80));
      const headers = { Authorization: apiKey };
      const vr = await fetch(`https://api.pexels.com/videos/search?query=${q}&orientation=${orientation(aspect)}&per_page=3&size=medium`, { headers, signal });
      if (vr.ok) {
        const vj: any = await vr.json();
        const video = vj.videos?.[0];
        const file = video?.video_files
          ?.filter((f: any) => f.file_type === "video/mp4" && f.width)
          .sort((a: any, b: any) => Math.abs(a.width - 1080) - Math.abs(b.width - 1080))[0];
        if (file) {
          const out = path.join(dir, `scene_${index}.mp4`);
          await download(file.link, out, signal);
          return { path: out, kind: "video", credit: `Video by ${video.user?.name ?? "Pexels"} on Pexels`, duration: video.duration };
        }
      }
      const pr = await fetch(`https://api.pexels.com/v1/search?query=${q}&orientation=${orientation(aspect)}&per_page=1`, { headers, signal });
      if (!pr.ok) throw new Error(`Pexels ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
      const pj: any = await pr.json();
      const photo = pj.photos?.[0];
      if (!photo) return placeholderVisuals.get(prompt, index, aspect, dir, signal);
      const out = path.join(dir, `scene_${index}.jpg`);
      await download(photo.src.large2x ?? photo.src.original, out, signal);
      return { path: out, kind: "image", credit: `Photo by ${photo.photographer} on Pexels` };
    },
  };
}

/** OpenAI image generation (gpt-image-1). */
export function openaiVisuals(apiKey: string): VisualsProvider {
  const size = (a: Aspect) => (a === "9:16" ? "1024x1536" : a === "1:1" ? "1024x1024" : "1536x1024");
  return {
    id: "OpenAI gpt-image-1",
    async get(prompt, index, aspect, dir, signal) {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1", prompt: `${prompt}. Photorealistic, cinematic light, no text.`, size: size(aspect), n: 1 }),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j: any = await res.json();
      const out = path.join(dir, `scene_${index}.png`);
      writeFileSync(out, Buffer.from(j.data[0].b64_json, "base64"));
      return { path: out, kind: "image", credit: "Generated with gpt-image-1" };
    },
  };
}

/**
 * Photoreal AI footage through OpenRouter.
 *  1. A "hero" frame of the subject is generated once.
 *  2. Each shot's first frame is generated with the hero frame as a reference, so the
 *     same car / person / place appears in every shot.
 *  3. Every first frame is animated by a video model (Veo by default, with native sound).
 * All video jobs run in parallel. In "image" mode it stops after step 2 (stills + Ken Burns).
 */
export function openrouterVisuals(key: string, mode: "video" | "image"): VisualsProvider {
  const still = async (prompt: string, index: number, aspect: Aspect, dir: string, signal?: AbortSignal) => {
    const out = path.join(dir, `frame_${index}.jpg`);
    await openrouterImage(key, prompt, aspect, out, { signal });
    return { path: out, kind: "image" as const };
  };
  return {
    id: mode === "video" ? "OpenRouter AI video" : "OpenRouter AI images",
    get: still,
    async getAll(shots, aspect, dir, o) {
      const total = shots.length * (mode === "video" ? 2 : 1) + 1;
      let done = 0;
      const tick = (msg: string) => o.onProgress?.(++done, total, msg);
      const look = o.look || "photorealistic, cinematic, natural light, shot on a cinema camera, shallow depth of field";
      const frameAspect: Aspect = aspect === "1:1" ? "16:9" : aspect;
      const subject = o.subject ? `${o.subject}. ` : "";

      const hero = path.join(dir, "hero.jpg");
      await openrouterImage(key, `${subject}${shots[0].visual}. ${look}. Photorealistic photograph, no text, no watermark.`, frameAspect, hero, {
        signal: o.signal,
        spend: o.spend,
      });
      tick("Hero frame");

      const frames: string[] = [];
      for (let i = 0; i < shots.length; i++) {
        if (i === 0) {
          frames.push(hero);
          continue;
        }
        const out = path.join(dir, `frame_${i}.jpg`);
        await openrouterImage(
          key,
          `${subject}Keep the exact same ${o.subject ? "subject" : "main subject"} as in the reference image (same model, colour and details). New shot: ${shots[i].visual}. ${look}. Photorealistic photograph, no text, no watermark.`,
          frameAspect,
          out,
          { references: [hero], signal: o.signal, spend: o.spend },
        );
        frames.push(out);
        tick(`First frame ${i + 1}/${shots.length}`);
      }
      if (mode === "image") return frames.map((p) => ({ path: p, kind: "image" as const, credit: "AI image via OpenRouter" }));

      const jobs = await Promise.all(
        shots.map((s, i) =>
          submitVideo(key, {
            prompt: `${s.visual}. ${look}. Realistic motion and physics, smooth camera movement, natural ambient sound. No text, no captions, no music.`,
            seconds: s.seconds,
            aspect: frameAspect,
            resolution: o.resolution,
            firstFrame: frames[i],
            audio: o.audio,
            signal: o.signal,
          }),
        ),
      );
      o.log?.("Submitted video jobs", jobs.map((j, i) => `shot ${i + 1}: ${j.seconds}s on ${j.model}`).join("; "));
      const results = await Promise.all(
        jobs.map(async (job, i) => {
          const out = path.join(dir, `shot_${i}.mp4`);
          try {
            await awaitVideo(key, job, out, o.signal, o.spend);
            tick(`Shot ${i + 1}/${shots.length} rendered`);
            return { path: out, kind: "video" as const, duration: (await probe(out)).duration, credit: `AI video (${job.model})` };
          } catch (e: any) {
            if (o.signal?.aborted) throw e;
            o.log?.("Video shot failed, using its still frame", `Shot ${i + 1}: ${e.message}`);
            tick(`Shot ${i + 1} fell back to a still`);
            return { path: frames[i], kind: "image" as const, credit: "AI image via OpenRouter" };
          }
        }),
      );
      return results;
    },
  };
}
