import type { Graph, GraphNode, Mode, NodeType } from "../types";

type Spec = { type: NodeType; label: string; params?: Record<string, unknown> };

function chain(specs: Spec[]): Graph {
  const nodes: GraphNode[] = specs.map((s, i) => ({
    id: s.type,
    type: s.type,
    label: s.label,
    params: s.params ?? {},
    // Two rows so the chain reads left→right on a normal screen.
    position: { x: (i % 4) * 280, y: Math.floor(i / 4) * 190 },
  }));
  const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id }));
  return { nodes, edges };
}

/** Default node chains. Ids equal the node type, which keeps the canvas and the MCP tools simple. */
export function templateFor(mode: Mode): Graph {
  if (mode === "edit") {
    return chain([
      { type: "source", label: "Footage", params: {} },
      { type: "transcribe", label: "Transcribe", params: {} },
      { type: "select_moments", label: "Pick moments", params: { targetSeconds: 40, maxClips: 6 } },
      { type: "assemble_edit", label: "Assemble edit", params: { aspect: "16:9", captionStyle: "karaoke", titleCard: true, padding: 0.15 } },
      { type: "reframe", label: "Reframe", params: { mode: "track" } },
      { type: "music", label: "Music", params: { source: "auto", volume: 0.1 } },
      { type: "render", label: "Render MP4", params: {} },
    ]);
  }
  return chain([
    { type: "idea", label: "Idea", params: { prompt: "", seconds: 30, style: "clear, upbeat explainer", aspect: "9:16", narration: "auto" } },
    { type: "script", label: "Script & scenes", params: {} },
    { type: "voiceover", label: "Voiceover", params: {} },
    { type: "visuals", label: "Visuals", params: { resolution: "720p", nativeAudio: true } },
    { type: "align_captions", label: "Captions", params: {} },
    { type: "assemble_generated", label: "Assemble", params: { captionStyle: "karaoke", kenBurns: true, transition: "crossfade" } },
    { type: "music", label: "Music", params: { source: "auto" } },
    { type: "render", label: "Render MP4", params: {} },
  ]);
}

export const NODE_DESCRIPTIONS: Record<NodeType, string> = {
  source: "Uploaded footage that goes into the edit.",
  transcribe: "Word-level transcript of every clip (local Whisper or OpenAI).",
  select_moments: "Claude reads the transcript and the brief, then picks the strongest moments and the hook.",
  assemble_edit: "Builds the edit decision list: clips, title card, captions.",
  reframe: "Crops to the target aspect, following the subject with motion saliency tracking.",
  idea: "What the video is about, how long, and the format.",
  script: "Claude writes the shot list: what each shot shows, camera, duration, optional narration and the music brief.",
  voiceover: "Text-to-speech for every scene.",
  visuals: "One shot per scene: AI video (same subject in every shot), AI images, stock footage, or offline art.",
  align_captions: "Word timings for captions, from transcribing the voiceover.",
  assemble_generated: "Builds the edit decision list from scenes, voice and visuals.",
  music: "Music: composed by AI (Lyria) or synthesised offline; ducked under speech.",
  render: "FFmpeg renders the timeline into an H.264 MP4.",
};
