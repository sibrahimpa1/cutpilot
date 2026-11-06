import { createHash } from "node:crypto";
import { addRender, getNodeRuns, getProject, listAssets, logEvent, nextRenderVersion, upsertNodeRun, type RenderRow } from "../db";
import { projectDir } from "../config";
import { renderTimeline } from "../media/render";
import type { Providers } from "../providers";
import type { Graph, GraphNode, Mode, Timeline } from "../types";
import { executorFor } from "./nodes";
import { CancelledError } from "../media/ffmpeg";

export function topoOrder(g: Graph): GraphNode[] {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0);
  const out: GraphNode[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const e of g.edges.filter((e) => e.source === n.id)) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(g.nodes.find((x) => x.id === e.target)!);
    }
  }
  if (out.length !== g.nodes.length) throw new Error("Workflow graph has a cycle");
  return out;
}

export function ancestors(g: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const e of g.edges) if (e.target === x && !out.has(e.source)) (out.add(e.source), visit(e.source));
  };
  visit(id);
  return out;
}

export function descendants(g: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const e of g.edges) if (e.source === x && !out.has(e.target)) (out.add(e.target), visit(e.target));
  };
  visit(id);
  return out;
}

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export type RunOptions = {
  /** Re-run this node and everything after it. */
  fromNodeId?: string;
  /** Re-run only this node (its upstream must already have outputs). */
  onlyNodeId?: string;
  /** Ignore the cache and run every node. */
  force?: boolean;
};

export type JobHooks = {
  signal: AbortSignal;
  progress: (p: number, message: string) => void;
};

/**
 * Run a project's workflow for one mode. Nodes are cached by a hash of their params, the
 * project brief, the uploaded assets and their upstream hashes, so "Run" only redoes what
 * changed, and any single step can be re-run on its own.
 */
export async function runWorkflow(projectId: string, mode: Mode, opts: RunOptions, providers: Providers, hooks: JobHooks): Promise<{ render: RenderRow | null }> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const graph = project.graphs[mode];
  const order = topoOrder(graph);
  const runs = getNodeRuns(projectId, mode);
  const assetsKey = listAssets(projectId).map((a) => [a.id, a.duration]);

  // Hash every node from its inputs.
  const hashes: Record<string, string> = {};
  for (const n of order) {
    const ups = graph.edges.filter((e) => e.target === n.id).map((e) => hashes[e.source]);
    const salt = n.type === "source" || n.type === "transcribe" ? assetsKey : null;
    const brief = ["select_moments", "idea"].includes(n.type) ? project.brief : null;
    const prov =
      n.type === "transcribe" || n.type === "align_captions"
        ? providers.stt.id
        : n.type === "select_moments" || n.type === "script"
          ? providers.llm.id
          : n.type === "voiceover"
            ? providers.tts.id
            : n.type === "visuals"
              ? providers.visuals.id
              : null;
    hashes[n.id] = hash([n.type, n.params, ups, salt, brief, prov]);
  }

  let toRun: Set<string>;
  if (opts.onlyNodeId) {
    for (const a of ancestors(graph, opts.onlyNodeId)) {
      if (runs[a]?.status !== "done") throw new Error(`Run "${graph.nodes.find((n) => n.id === a)?.label}" first.`);
    }
    toRun = new Set([opts.onlyNodeId]);
  } else {
    const forced = opts.fromNodeId ? new Set([opts.fromNodeId, ...descendants(graph, opts.fromNodeId)]) : new Set<string>();
    toRun = new Set(
      order
        .filter((n) => opts.force || forced.has(n.id) || runs[n.id]?.status !== "done" || runs[n.id]?.inputHash !== hashes[n.id])
        .map((n) => n.id),
    );
    // Anything downstream of a node that will run must run too.
    for (const id of [...toRun]) for (const d of descendants(graph, id)) toRun.add(d);
  }

  for (const n of order) if (toRun.has(n.id)) upsertNodeRun(projectId, mode, n.id, { status: "queued", progress: 0, message: null, error: null });

  const outputs: Record<string, any> = {};
  for (const n of order) if (runs[n.id]?.output) outputs[n.id] = runs[n.id].output;

  const steps = order.filter((n) => toRun.has(n.id));
  let render: RenderRow | null = null;

  for (let si = 0; si < steps.length; si++) {
    const node = steps[si];
    if (hooks.signal.aborted) throw new CancelledError();
    const started = Date.now();
    upsertNodeRun(projectId, mode, node.id, { status: "running", progress: 0, startedAt: started, finishedAt: null, error: null, message: "Starting" });
    const progress = (p: number, message?: string) => {
      upsertNodeRun(projectId, mode, node.id, { progress: Math.min(1, Math.max(0, p)), message: message ?? null });
      hooks.progress((si + Math.min(1, p)) / steps.length, `${node.label}: ${message ?? ""}`.trim());
    };
    progress(0, "Starting");
    const inputs: Record<string, any> = {};
    for (const a of ancestors(graph, node.id)) {
      const an = graph.nodes.find((x) => x.id === a)!;
      inputs[an.type] = outputs[a];
    }
    const dir = projectDir(projectId, "nodes", mode, node.id);
    const log = (action: string, detail?: string, actor: "ai" | "system" | "user" = "system") =>
      logEvent({ projectId, actor, tool: `${node.label}`, action, detail: detail ?? null, durationMs: Date.now() - started });

    try {
      let output: any;
      let provider: string | undefined;
      if (node.type === "render") {
        const timeline: Timeline = inputs.music?.timeline ?? inputs.reframe?.timeline ?? inputs.assemble_edit?.timeline ?? inputs.assemble_generated?.timeline;
        if (!timeline) throw new Error("Nothing to render yet.");
        render = await renderVersion(projectId, mode, timeline, `${mode === "edit" ? "Edit" : "Generated"} from workflow`, hooks.signal, (p, m) => progress(p, m));
        output = { renderId: render.id, version: render.version, path: render.path, thumb: render.thumb, duration: render.duration };
        provider = "FFmpeg";
      } else {
        const r = await executorFor(node.type)({
          project,
          mode,
          node,
          params: node.params,
          inputs,
          dir,
          providers,
          signal: hooks.signal,
          progress,
          log,
        });
        output = r.output;
        provider = r.provider;
      }
      outputs[node.id] = output;
      upsertNodeRun(projectId, mode, node.id, {
        status: "done",
        output,
        provider: provider ?? null,
        inputHash: hashes[node.id],
        progress: 1,
        message: `Done in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        finishedAt: Date.now(),
      });
    } catch (e: any) {
      const cancelled = e instanceof CancelledError || hooks.signal.aborted;
      upsertNodeRun(projectId, mode, node.id, {
        status: cancelled ? "idle" : "error",
        error: cancelled ? null : String(e.message ?? e),
        message: cancelled ? "Cancelled" : "Failed",
        finishedAt: Date.now(),
      });
      for (const rest of steps.slice(si + 1)) upsertNodeRun(projectId, mode, rest.id, { status: "idle", message: null });
      if (!cancelled) logEvent({ projectId, actor: "system", tool: node.label, action: "Step failed", detail: String(e.message ?? e), durationMs: Date.now() - started });
      throw e;
    }
  }
  return { render };
}

/** Render a timeline into a new numbered version. Used by the workflow and by revisions. */
export async function renderVersion(
  projectId: string,
  mode: Mode,
  timeline: Timeline,
  label: string,
  signal: AbortSignal,
  onProgress: (p: number, msg: string) => void,
): Promise<RenderRow> {
  const version = nextRenderVersion(projectId);
  const dir = projectDir(projectId, "renders", `v${version}`);
  const r = await renderTimeline(timeline, dir, { signal, onProgress, fileName: `v${version}_${timeline.aspect.replace(":", "x")}.mp4` });
  const row = addRender({
    id: `${projectId}-v${version}`,
    projectId,
    version,
    label,
    mode,
    timeline,
    path: r.path,
    thumb: r.thumb,
    duration: r.duration,
    width: r.width,
    height: r.height,
    sizeBytes: r.sizeBytes,
    renderMs: r.renderMs,
  });
  logEvent({
    projectId,
    actor: "system",
    tool: "FFmpeg",
    action: `Rendered v${version}`,
    detail: `${r.width}×${r.height}, ${r.duration.toFixed(1)}s, ${(r.sizeBytes / 1e6).toFixed(1)} MB, ${r.overlayFrames} caption/title frames, ${(r.renderMs / 1000).toFixed(1)}s render`,
    durationMs: r.renderMs,
  });
  return row;
}
