import type { Clip, Timeline, Word } from "../src/types";

export const words = (text: string, start = 0, step = 0.5): Word[] =>
  text.split(/\s+/).map((t, i) => ({ text: t, start: start + i * step, end: start + i * step + step * 0.9 }));

export function clip(id: string, inn: number, out: number, ws: Word[] = [], extra: Partial<Clip> = {}): Clip {
  return { id, kind: "video", src: `/media/${id}.mp4`, in: inn, out, words: ws, ...extra };
}

export function timeline(clips: Clip[], extra: Partial<Timeline> = {}): Timeline {
  return {
    version: 1,
    title: "Test",
    aspect: "16:9",
    fps: 30,
    clips,
    titles: [],
    captions: { style: "karaoke", replacements: [] },
    music: null,
    ...extra,
  };
}
