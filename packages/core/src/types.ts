import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Timeline (Edit Decision List) — the single source of truth for a   */
/* video. Both modes produce one; revisions edit it; FFmpeg renders it */
/* ------------------------------------------------------------------ */

export const Aspect = z.enum(["16:9", "9:16", "1:1"]);
export type Aspect = z.infer<typeof Aspect>;

export const ASPECT_SIZE: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export const Word = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});
export type Word = z.infer<typeof Word>;

/** Horizontal subject position over time (clip-local seconds, cx normalised 0..1). */
export const CropKeyframe = z.object({ t: z.number(), cx: z.number().min(0).max(1) });
export type CropKeyframe = z.infer<typeof CropKeyframe>;

export const Clip = z.object({
  id: z.string(),
  kind: z.enum(["video", "image"]),
  /** Absolute path to the media file. */
  src: z.string(),
  assetId: z.string().optional(),
  /** Source in/out in seconds. For images `in` is 0 and `out` is the display duration. */
  in: z.number().min(0),
  out: z.number().positive(),
  /** Optional voice/audio file played under this clip (generate mode voiceover). */
  audioSrc: z.string().optional(),
  /** Mute the clip's own audio. */
  muted: z.boolean().optional(),
  /** Slow zoom on stills. */
  kenBurns: z.boolean().optional(),
  /** Loop a video source that is shorter than the clip (stock footage under a long voiceover). */
  loop: z.boolean().optional(),
  /** Subject-tracking crop path; omitted = centre crop. */
  crop: z.array(CropKeyframe).optional(),
  /** Words spoken in this clip, in *source* time (same clock as in/out). */
  words: z.array(Word).default([]),
  label: z.string().optional(),
  /** Why the AI chose this clip (shown in the editor and the production log). */
  reason: z.string().optional(),
});
export type Clip = z.infer<typeof Clip>;

export const Title = z.object({
  text: z.string(),
  start: z.number().min(0),
  end: z.number().positive(),
  position: z.enum(["top", "center"]).default("top"),
});
export type Title = z.infer<typeof Title>;

export const CaptionStyle = z.enum(["karaoke", "block", "off"]);
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const Timeline = z.object({
  version: z.literal(1).default(1),
  title: z.string().default("Untitled"),
  aspect: Aspect,
  fps: z.number().int().default(30),
  clips: z.array(Clip),
  titles: z.array(Title).default([]),
  captions: z
    .object({
      style: CaptionStyle.default("karaoke"),
      /** Case-insensitive whole-word replacements applied when captions are drawn. */
      replacements: z.array(z.object({ find: z.string(), replace: z.string() })).default([]),
    })
    .default({ style: "karaoke", replacements: [] }),
  music: z.object({ src: z.string(), volume: z.number().min(0).max(1) }).nullable().default(null),
});
export type Timeline = z.infer<typeof Timeline>;

export function clipDuration(c: Pick<Clip, "in" | "out">): number {
  return Math.max(0, c.out - c.in);
}

export function timelineDuration(t: Pick<Timeline, "clips">): number {
  return t.clips.reduce((s, c) => s + clipDuration(c), 0);
}

/* ------------------------------------------------------------------ */
/* Workflow graph                                                      */
/* ------------------------------------------------------------------ */

export const Mode = z.enum(["edit", "generate"]);
export type Mode = z.infer<typeof Mode>;

export const NodeType = z.enum([
  // edit footage
  "source",
  "transcribe",
  "select_moments",
  "assemble_edit",
  "reframe",
  // generate from idea
  "idea",
  "script",
  "voiceover",
  "visuals",
  "align_captions",
  "assemble_generated",
  // shared
  "music",
  "render",
]);
export type NodeType = z.infer<typeof NodeType>;

export const GraphNode = z.object({
  id: z.string(),
  type: NodeType,
  label: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({ source: z.string(), target: z.string() });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z.object({ nodes: z.array(GraphNode), edges: z.array(GraphEdge) });
export type Graph = z.infer<typeof Graph>;

/* ------------------------------------------------------------------ */
/* Revisions — what the AI (or the user) wants changed                */
/* ------------------------------------------------------------------ */

export const RevisionOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("remove_clip"), index: z.number().int().min(0) }),
  z.object({ op: z.literal("move_clip"), index: z.number().int().min(0), to: z.number().int().min(0) }),
  z.object({
    op: z.literal("trim_clip"),
    index: z.number().int().min(0),
    /** Seconds to cut from the head / tail of the clip. */
    head: z.number().min(0).default(0),
    tail: z.number().min(0).default(0),
  }),
  /** Remove the moment where this exact phrase is spoken (splits clips if needed). */
  z.object({ op: z.literal("remove_phrase"), text: z.string().min(1) }),
  z.object({ op: z.literal("set_aspect"), aspect: Aspect }),
  z.object({ op: z.literal("replace_caption_text"), find: z.string().min(1), replace: z.string() }),
  z.object({ op: z.literal("set_caption_style"), style: CaptionStyle }),
  z.object({ op: z.literal("set_title"), text: z.string() }),
  z.object({ op: z.literal("remove_titles") }),
  z.object({ op: z.literal("set_music_volume"), volume: z.number().min(0).max(1) }),
  z.object({ op: z.literal("remove_music") }),
  z.object({ op: z.literal("target_duration"), seconds: z.number().positive() }),
]);
export type RevisionOp = z.infer<typeof RevisionOp>;

export const RevisionPlan = z.object({
  ops: z.array(RevisionOp),
  explanation: z.string(),
});
export type RevisionPlan = z.infer<typeof RevisionPlan>;

/* ------------------------------------------------------------------ */
/* AI outputs                                                          */
/* ------------------------------------------------------------------ */

export const Moment = z.object({
  assetId: z.string(),
  start: z.number(),
  end: z.number(),
  reason: z.string(),
});
export type Moment = z.infer<typeof Moment>;

export const MomentSelection = z.object({
  title: z.string(),
  hook: z.string(),
  moments: z.array(Moment),
});
export type MomentSelection = z.infer<typeof MomentSelection>;

export const Scene = z.object({
  narration: z.string(),
  visual: z.string(),
  onScreen: z.string().default(""),
});
export type Scene = z.infer<typeof Scene>;

export const Script = z.object({
  title: z.string(),
  scenes: z.array(Scene).min(1),
});
export type Script = z.infer<typeof Script>;

/** A transcript for one asset. */
export type Transcript = { words: Word[]; provider: string; language?: string };
