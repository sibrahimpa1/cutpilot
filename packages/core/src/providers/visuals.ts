import { writeFileSync } from "node:fs";
import path from "node:path";
import { writeSceneCard } from "../media/generate";
import { ASPECT_SIZE, type Aspect } from "../types";

export type Visual = { path: string; kind: "image" | "video"; credit?: string; duration?: number };

export interface VisualsProvider {
  id: string;
  get(prompt: string, index: number, aspect: Aspect, dir: string, signal?: AbortSignal): Promise<Visual>;
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
