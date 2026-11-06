import type { Graph, Job, LogEvent, Mode, NodeRun, Project, RenderRow, Timeline } from "@cutpilot/core";

export type AssetView = {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  path: string;
  url: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  transcript: { provider: string; words: number; text: string } | null;
};

export type RenderView = RenderRow & { url: string; thumbUrl: string };

export type ProjectState = {
  project: Project;
  descriptions: Record<string, string>;
  assets: AssetView[];
  runs: Record<Mode, Record<string, NodeRun>>;
  jobs: Job[];
  renders: RenderView[];
  events: LogEvent[];
};

export type { Graph, Mode, Timeline };
