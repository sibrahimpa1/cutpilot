import path from "node:path";
import { getAsset, listAssets, setTranscript, type Asset, type Project } from "../db";
import { generateMusicBed } from "../media/generate";
import { probe } from "../media/ffmpeg";
import { trackSubject } from "../media/tracking";
import type { Providers } from "../providers";
import { evenWordTimings } from "../providers/speech";
import { placeholderVisuals } from "../providers/visuals";
import {
  ASPECT_SIZE,
  Aspect,
  CaptionStyle,
  timelineDuration,
  type Clip,
  type GraphNode,
  type Mode,
  type MomentSelection,
  type NodeType,
  type Script,
  type Timeline,
  type Word,
} from "../types";

export type NodeCtx = {
  project: Project;
  mode: Mode;
  node: GraphNode;
  params: Record<string, any>;
  /** Outputs of every upstream node, keyed by node type. */
  inputs: Partial<Record<NodeType, any>>;
  dir: string;
  providers: Providers;
  signal: AbortSignal;
  progress: (p: number, message?: string) => void;
  log: (action: string, detail?: string, actor?: "ai" | "system" | "user") => void;
};

export type NodeResult = { output: any; provider?: string };
export type NodeExecutor = (ctx: NodeCtx) => Promise<NodeResult>;

const need = <T>(v: T | undefined | null, msg: string): T => {
  if (v == null) throw new Error(msg);
  return v;
};

function upstreamTimeline(ctx: NodeCtx): Timeline {
  const t =
    ctx.inputs.music?.timeline ?? ctx.inputs.reframe?.timeline ?? ctx.inputs.assemble_edit?.timeline ?? ctx.inputs.assemble_generated?.timeline;
  return structuredClone(need(t, "No timeline upstream. Run the assemble step first.")) as Timeline;
}

/* ------------------------------------------------------------------ */
/* Reframing (shared with revisions)                                   */
/* ------------------------------------------------------------------ */

export async function reframeTimeline(t: Timeline, mode: "track" | "center" | "off", signal?: AbortSignal, onClip?: (i: number, n: number) => void) {
  const { width: W, height: H } = ASPECT_SIZE[t.aspect];
  let tracked = 0;
  for (let i = 0; i < t.clips.length; i++) {
    const c = t.clips[i];
    onClip?.(i, t.clips.length);
    if (c.kind !== "video" || mode === "off") continue;
    const p = await probe(c.src);
    const wider = p.width && p.height ? p.width / p.height > (W / H) * 1.01 : false;
    if (!wider || mode === "center") {
      delete c.crop;
      continue;
    }
    c.crop = await trackSubject(c.src, c.in, c.out, { signal });
    tracked++;
  }
  return { timeline: t, tracked };
}

/* ------------------------------------------------------------------ */
/* Edit footage                                                        */
/* ------------------------------------------------------------------ */

export function snapToWords(words: Word[], start: number, end: number) {
  // A word belongs to the moment if it starts inside it; a word starting at the end boundary is the next sentence.
  const inside = words.filter((w) => w.start >= start - 0.15 && w.start < end - 0.02 && w.end <= end + 0.4);
  if (!inside.length) return { start, end };
  return { start: inside[0].start, end: inside[inside.length - 1].end };
}

const executors: Record<NodeType, NodeExecutor> = {
  async source(ctx) {
    const wanted: string[] | undefined = Array.isArray(ctx.params.assetIds) && ctx.params.assetIds.length ? ctx.params.assetIds : undefined;
    const assets = listAssets(ctx.project.id).filter((a) => a.kind === "video" && (!wanted || wanted.includes(a.id)));
    if (!assets.length) throw new Error("Upload at least one video to the Footage step first.");
    ctx.log("Loaded footage", assets.map((a) => `${a.name} (${a.duration?.toFixed(1)}s, ${a.width}×${a.height})`).join("; "));
    return {
      output: { assets: assets.map(({ transcript, ...a }) => a) },
    };
  },

  async transcribe(ctx) {
    const assets: Omit<Asset, "transcript">[] = need(ctx.inputs.source?.assets, "Run Footage first.");
    const stt = ctx.providers.stt;
    const out: { assetId: string; provider: string; words: Word[] }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = getAsset(assets[i].id)!;
      ctx.progress(i / assets.length, `Transcribing ${a.name}`);
      let t = a.transcript;
      if (!t || t.provider !== stt.id || ctx.params.force) {
        const words = await stt.transcribe(a.path, ctx.dir, ctx.signal);
        t = { words, provider: stt.id };
        setTranscript(a.id, t);
      }
      out.push({ assetId: a.id, provider: t.provider, words: t.words });
    }
    const n = out.reduce((s, x) => s + x.words.length, 0);
    ctx.log("Transcribed footage", `${n} words across ${out.length} file(s)`);
    if (!n) ctx.log("No speech found", "Moments will be picked evenly; captions will be empty. Configure whisper.cpp or OPENAI_API_KEY.", "system");
    return { output: { transcripts: out }, provider: stt.id };
  },

  async select_moments(ctx) {
    const assets: Omit<Asset, "transcript">[] = need(ctx.inputs.source?.assets, "Run Footage first.");
    const transcripts: { assetId: string; words: Word[] }[] = need(ctx.inputs.transcribe?.transcripts, "Run Transcribe first.");
    const brief = String(ctx.params.brief ?? ctx.project.brief ?? "");
    const input = transcripts.map((t) => {
      const a = assets.find((x) => x.id === t.assetId)!;
      return { assetId: t.assetId, name: a.name, words: t.words, duration: a.duration ?? 0 };
    });
    ctx.progress(0.1, `Asking ${ctx.providers.llm.id} to pick moments`);
    const sel: MomentSelection = await ctx.providers.llm.selectMoments({
      brief,
      targetSeconds: Number(ctx.params.targetSeconds ?? 40),
      maxClips: Number(ctx.params.maxClips ?? 6),
      transcripts: input,
    });
    // Never trust timestamps blindly: clamp to the media and snap to real word boundaries.
    const moments = sel.moments
      .map((m) => {
        const t = input.find((x) => x.assetId === m.assetId);
        if (!t) return null;
        const s = snapToWords(t.words, Math.max(0, m.start), Math.min(t.duration, m.end));
        return s.end - s.start >= 0.5 ? { ...m, ...s } : null;
      })
      .filter(Boolean) as MomentSelection["moments"];
    if (!moments.length) throw new Error("No usable moments were selected.");
    ctx.log(
      "Selected moments",
      `Hook: "${sel.hook}". ` + moments.map((m, i) => `#${i + 1} ${m.start.toFixed(1)}–${m.end.toFixed(1)}s: ${m.reason}`).join(" | "),
      "ai",
    );
    return { output: { ...sel, moments }, provider: ctx.providers.llm.id };
  },

  async assemble_edit(ctx) {
    const assets: Omit<Asset, "transcript">[] = need(ctx.inputs.source?.assets, "Run Footage first.");
    const sel: MomentSelection = need(ctx.inputs.select_moments, "Run Pick moments first.");
    const transcripts: { assetId: string; words: Word[] }[] = ctx.inputs.transcribe?.transcripts ?? [];
    const aspect = Aspect.parse(ctx.params.aspect ?? "16:9");
    const pad = Number(ctx.params.padding ?? 0.15);
    const clips: Clip[] = sel.moments.map((m, i) => {
      const a = assets.find((x) => x.id === m.assetId)!;
      const words = transcripts.find((t) => t.assetId === m.assetId)?.words ?? [];
      // Pad for breathing room, but never into a neighbouring word (no stray syllables at cuts).
      const prevEnd = Math.max(0, ...words.filter((w) => w.end <= m.start + 0.01).map((w) => w.end));
      const nextStart = Math.min(a.duration ?? Infinity, ...words.filter((w) => w.start >= m.end - 0.01).map((w) => w.start));
      const cin = Math.max(0, prevEnd, m.start - pad);
      const cout = Math.min(a.duration ?? m.end + pad, nextStart, m.end + pad);
      const mid = (w: Word) => (w.start + w.end) / 2;
      return {
        id: `c${i + 1}`,
        kind: "video",
        src: a.path,
        assetId: a.id,
        in: cin,
        out: cout,
        words: words.filter((w) => mid(w) >= cin && mid(w) <= cout),
        label: `Clip ${i + 1}`,
        reason: m.reason,
      };
    });
    const timeline: Timeline = {
      version: 1,
      title: sel.title,
      aspect,
      fps: 30,
      clips,
      titles: ctx.params.titleCard === false ? [] : [{ text: sel.hook, start: 0, end: Math.min(3.2, clips[0].out - clips[0].in), position: "top" }],
      captions: { style: CaptionStyle.parse(ctx.params.captionStyle ?? "karaoke"), replacements: [] },
      music: null,
    };
    ctx.log("Assembled edit", `${clips.length} clips, ${timelineDuration(timeline).toFixed(1)}s, ${aspect}, captions ${timeline.captions.style}`);
    return { output: { timeline } };
  },

  async reframe(ctx) {
    const t = upstreamTimeline(ctx);
    const mode = (ctx.params.mode ?? "track") as "track" | "center" | "off";
    const { timeline, tracked } = await reframeTimeline(t, mode, ctx.signal, (i, n) => ctx.progress(i / n, `Tracking subject in clip ${i + 1}/${n}`));
    ctx.log("Reframed", tracked ? `Subject tracking on ${tracked} clip(s) for ${t.aspect}` : `No crop tracking needed for ${t.aspect}`);
    return { output: { timeline }, provider: tracked ? "motion-saliency tracker" : undefined };
  },

  /* ---------------------------------------------------------------- */
  /* Generate from idea                                                */
  /* ---------------------------------------------------------------- */

  async idea(ctx) {
    const prompt = String(ctx.params.prompt || ctx.project.brief || "").trim();
    if (!prompt) throw new Error("Write the idea in the Idea step first.");
    const out = {
      prompt,
      seconds: Number(ctx.params.seconds ?? 30),
      style: String(ctx.params.style ?? "clear, upbeat explainer"),
      aspect: Aspect.parse(ctx.params.aspect ?? "9:16"),
    };
    return { output: out };
  },

  async script(ctx) {
    const idea = need(ctx.inputs.idea, "Run Idea first.");
    ctx.progress(0.1, `Writing script with ${ctx.providers.llm.id}`);
    const script: Script = await ctx.providers.llm.writeScript(idea);
    ctx.log("Wrote script", `"${script.title}": ${script.scenes.length} scenes, ${script.scenes.map((s) => s.narration).join(" ").split(/\s+/).length} words`, "ai");
    return { output: script, provider: ctx.providers.llm.id };
  },

  async voiceover(ctx) {
    const script: Script = need(ctx.inputs.script, "Run Script first.");
    const scenes: { audio: string; duration: number }[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      ctx.progress(i / script.scenes.length, `Voicing scene ${i + 1}/${script.scenes.length}`);
      const r = await ctx.providers.tts.synth(script.scenes[i].narration, path.join(ctx.dir, `voice_${i}.wav`), ctx.signal);
      scenes.push({ audio: r.path, duration: r.duration });
    }
    ctx.log("Recorded voiceover", `${scenes.length} takes, ${scenes.reduce((s, x) => s + x.duration, 0).toFixed(1)}s total`);
    return { output: { scenes }, provider: ctx.providers.tts.id };
  },

  async visuals(ctx) {
    const script: Script = need(ctx.inputs.script, "Run Script first.");
    const aspect = need(ctx.inputs.idea, "Run Idea first.").aspect as Aspect;
    const out: { path: string; kind: "image" | "video"; credit?: string; duration?: number; provider: string }[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      ctx.progress(i / script.scenes.length, `Visual for scene ${i + 1}/${script.scenes.length}`);
      try {
        const v = await ctx.providers.visuals.get(script.scenes[i].visual, i, aspect, ctx.dir, ctx.signal);
        out.push({ ...v, provider: ctx.providers.visuals.id });
      } catch (e: any) {
        if (ctx.signal.aborted) throw e;
        ctx.log("Visual provider failed, used a scene card", `Scene ${i + 1}: ${e.message}`, "system");
        const v = await placeholderVisuals.get(script.scenes[i].visual, i, aspect, ctx.dir);
        out.push({ ...v, provider: placeholderVisuals.id });
      }
    }
    const credits = out.map((v) => v.credit).filter(Boolean);
    ctx.log("Created visuals", `${out.length} visuals` + (credits.length ? `. Credits: ${credits.join("; ")}` : ""));
    return { output: { scenes: out }, provider: ctx.providers.visuals.id };
  },

  async align_captions(ctx) {
    const script: Script = need(ctx.inputs.script, "Run Script first.");
    const voice: { audio: string; duration: number }[] = need(ctx.inputs.voiceover?.scenes, "Run Voiceover first.");
    const stt = ctx.providers.stt;
    const scenes: { words: Word[]; method: string }[] = [];
    for (let i = 0; i < voice.length; i++) {
      ctx.progress(i / voice.length, `Aligning captions ${i + 1}/${voice.length}`);
      const text = script.scenes[i].narration;
      let method = "even spacing";
      let words = evenWordTimings(text, voice[i].duration);
      if (stt.id !== "none" && !ctx.providers.tts.id.startsWith("silent")) {
        const heard = await stt.transcribe(voice[i].audio, ctx.dir, ctx.signal);
        if (heard.length) {
          words = alignScriptToSpeech(text, heard, voice[i].duration);
          method = `aligned to ${stt.id}`;
        }
      }
      scenes.push({ words, method });
    }
    ctx.log("Aligned captions", `Caption text comes from the script (exact spelling); timings ${scenes[0]?.method ?? "n/a"}`);
    return { output: { scenes }, provider: stt.id };
  },

  async assemble_generated(ctx) {
    const idea = need(ctx.inputs.idea, "Run Idea first.");
    const script: Script = need(ctx.inputs.script, "Run Script first.");
    const voice: { audio: string; duration: number }[] = need(ctx.inputs.voiceover?.scenes, "Run Voiceover first.");
    const visuals: { path: string; kind: "image" | "video"; duration?: number }[] = need(ctx.inputs.visuals?.scenes, "Run Visuals first.");
    const caps: { words: Word[] }[] = ctx.inputs.align_captions?.scenes ?? [];
    const gap = 0.35;
    const clips: Clip[] = [];
    const titles: Timeline["titles"] = [];
    let offset = 0;
    script.scenes.forEach((s, i) => {
      const d = voice[i].duration + gap;
      const v = visuals[i];
      const isVideo = v.kind === "video";
      clips.push({
        id: `s${i + 1}`,
        kind: v.kind,
        src: v.path,
        in: 0,
        out: d,
        audioSrc: voice[i].audio,
        muted: true,
        loop: isVideo && (v.duration ?? 0) < d,
        kenBurns: !isVideo && ctx.params.kenBurns !== false,
        words: caps[i]?.words ?? evenWordTimings(s.narration, voice[i].duration),
        label: `Scene ${i + 1}`,
        reason: s.visual,
      });
      if (s.onScreen) titles.push({ text: s.onScreen, start: offset, end: offset + Math.min(d, 2.8), position: "top" });
      offset += d;
    });
    const timeline: Timeline = {
      version: 1,
      title: script.title,
      aspect: idea.aspect,
      fps: 30,
      clips,
      titles,
      captions: { style: CaptionStyle.parse(ctx.params.captionStyle ?? "karaoke"), replacements: [] },
      music: null,
    };
    ctx.log("Assembled video", `${clips.length} scenes, ${timelineDuration(timeline).toFixed(1)}s, ${idea.aspect}`);
    return { output: { timeline } };
  },

  /* ---------------------------------------------------------------- */
  /* Shared                                                            */
  /* ---------------------------------------------------------------- */

  async music(ctx) {
    const t = upstreamTimeline(ctx);
    const source = String(ctx.params.source ?? "generated");
    const volume = Math.min(1, Math.max(0, Number(ctx.params.volume ?? 0.1)));
    if (source === "none") {
      t.music = null;
      return { output: { timeline: t } };
    }
    let src: string;
    if (source === "generated") {
      ctx.progress(0.2, "Synthesising music bed");
      const seed = [...ctx.project.id].reduce((s, ch) => s + ch.charCodeAt(0), 0);
      src = await generateMusicBed(path.join(ctx.dir, "music.wav"), 32, seed, ctx.signal);
    } else {
      const a = need(getAsset(source), `Music asset ${source} not found.`);
      src = a.path;
    }
    t.music = { src, volume };
    ctx.log("Added music", `${source === "generated" ? "Generated ambient bed" : "Uploaded track"} at ${Math.round(volume * 100)}%, ducked under speech`);
    return { output: { timeline: t }, provider: source === "generated" ? "FFmpeg synth" : "uploaded" };
  },

  async render() {
    // Implemented in the engine (it needs to create a version record).
    throw new Error("render is handled by the engine");
  },
};

export function executorFor(type: NodeType): NodeExecutor {
  return executors[type];
}

/* ------------------------------------------------------------------ */
/* Caption alignment                                                   */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Keep the script's exact words (correct spelling, no ASR errors) but take timings from
 * what the speech recogniser heard. Greedy match within a small window; unmatched words
 * are interpolated between their matched neighbours.
 */
export function alignScriptToSpeech(script: string, heard: Word[], duration: number): Word[] {
  const toks = script.split(/\s+/).filter(Boolean);
  const times: ({ start: number; end: number } | null)[] = toks.map(() => null);
  let j = 0;
  for (let i = 0; i < toks.length; i++) {
    const n = norm(toks[i]);
    for (let k = j; k < Math.min(heard.length, j + 4); k++) {
      if (norm(heard[k].text) === n) {
        times[i] = { start: heard[k].start, end: heard[k].end };
        j = k + 1;
        break;
      }
    }
  }
  // Interpolate gaps.
  const out: Word[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (times[i]) {
      out.push({ text: toks[i], ...times[i]! });
      continue;
    }
    let a = i - 1;
    while (a >= 0 && !times[a]) a--;
    let b = i + 1;
    while (b < toks.length && !times[b]) b++;
    const t0 = a >= 0 ? times[a]!.end : 0.05;
    const t1 = b < toks.length ? times[b]!.start : Math.max(t0 + 0.2, duration - 0.1);
    const slots = b - a - 1;
    const pos = i - a - 1;
    const step = (t1 - t0) / slots;
    out.push({ text: toks[i], start: t0 + step * pos, end: t0 + step * (pos + 0.9) });
  }
  return out;
}
