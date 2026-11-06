import {
  claimNextJob,
  getJob,
  getProject,
  getRender,
  listRenders,
  logEvent,
  requeueStaleJobs,
  updateJob,
  type Job,
} from "./db";
import { CancelledError } from "./media/ffmpeg";
import { resolveProviders, type Providers } from "./providers";
import { applyOps, describeOp } from "./revise";
import { RevisionOp, type Mode } from "./types";
import { renderVersion, runWorkflow } from "./workflow/engine";
import { reframeTimeline } from "./workflow/nodes";

export type RevisePayload = { instruction?: string; ops?: RevisionOp[]; baseRenderId?: string };
export type RunPayload = { mode?: Mode; fromNodeId?: string; onlyNodeId?: string; force?: boolean };

export async function executeJob(job: Job, providers: Providers = resolveProviders()) {
  const ctrl = new AbortController();
  // Poll for cancel requests from the UI / MCP.
  const poll = setInterval(() => {
    if (getJob(job.id)?.cancelRequested) ctrl.abort();
  }, 700);
  let lastWrite = 0;
  const progress = (p: number, message: string) => {
    const t = Date.now();
    if (t - lastWrite < 250 && p < 1) return; // keep SQLite writes cheap
    lastWrite = t;
    updateJob(job.id, { progress: Math.min(0.999, p), message });
  };
  try {
    if (job.type === "run_workflow") {
      const p = job.payload as RunPayload;
      const project = getProject(job.projectId)!;
      const mode = p.mode ?? project.mode;
      const { render } = await runWorkflow(job.projectId, mode, p, providers, { signal: ctrl.signal, progress });
      updateJob(job.id, { status: "done", progress: 1, message: render ? `Rendered v${render.version}` : "Everything was up to date" });
    } else if (job.type === "revise") {
      const render = await revise(job.projectId, job.payload as RevisePayload, providers, ctrl.signal, progress);
      updateJob(job.id, { status: "done", progress: 1, message: `Rendered v${render.version}` });
    } else {
      throw new Error(`Unknown job type ${job.type}`);
    }
  } catch (e: any) {
    if (e instanceof CancelledError || ctrl.signal.aborted) updateJob(job.id, { status: "cancelled", message: "Cancelled" });
    else updateJob(job.id, { status: "error", error: String(e.message ?? e), message: "Failed" });
  } finally {
    clearInterval(poll);
  }
}

/** Apply a revision (AI-planned from an instruction, or explicit ops from the editor) and render a new version. */
export async function revise(projectId: string, payload: RevisePayload, providers: Providers, signal: AbortSignal, progress: (p: number, m: string) => void) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");
  const base = payload.baseRenderId ? getRender(payload.baseRenderId) : listRenders(projectId)[0];
  if (!base) throw new Error("Render the workflow once before revising.");
  const started = Date.now();
  let ops: RevisionOp[];
  let label: string;
  if (payload.ops?.length) {
    ops = payload.ops.map((o) => RevisionOp.parse(o));
    label = ops.map(describeOp).join(", ");
    logEvent({ projectId, actor: "user", tool: "Editor", action: "Manual edit", detail: label, durationMs: null });
  } else {
    const instruction = (payload.instruction ?? "").trim();
    if (!instruction) throw new Error("Describe the change you want.");
    progress(0.05, `Planning with ${providers.llm.id}`);
    logEvent({ projectId, actor: "user", tool: "Chat", action: "Revision request", detail: instruction, durationMs: null });
    const plan = await providers.llm.planRevision({ instruction, timeline: base.timeline, brief: project.brief });
    ops = plan.ops;
    label = instruction;
    logEvent({
      projectId,
      actor: "ai",
      tool: providers.llm.id,
      action: "Planned revision",
      detail: `${plan.explanation} Ops: ${ops.map(describeOp).join("; ") || "none"}`,
      durationMs: Date.now() - started,
    });
    if (!ops.length) throw new Error(plan.explanation || "Nothing to change.");
  }
  const result = applyOps(base.timeline, ops);
  for (const n of result.notes) logEvent({ projectId, actor: "system", tool: "Editor", action: "Note", detail: n, durationMs: null });
  let timeline = result.timeline;
  if (result.needsReframe) {
    progress(0.15, "Tracking subject for the new format");
    timeline = (await reframeTimeline(timeline, "track", signal)).timeline;
  }
  return renderVersion(projectId, base.mode, timeline, `Revision of v${base.version}: ${label}`.slice(0, 200), signal, (p, m) => progress(0.2 + 0.8 * p, m));
}

/** Long-running worker loop: one job at a time, crash-safe via SQLite. */
export async function workerLoop(opts: { idleMs?: number; once?: boolean; onJob?: (j: Job) => void } = {}) {
  const requeued = requeueStaleJobs();
  if (requeued) console.log(`[worker] requeued ${requeued} interrupted job(s)`);
  for (;;) {
    const job = claimNextJob();
    if (job) {
      opts.onJob?.(job);
      // Providers are resolved per job, so a freshly downloaded model or installed tool is picked up without a restart.
      await executeJob(job, resolveProviders());
      const done = getJob(job.id);
      console.log(`[worker] ${job.type} ${job.id} → ${done?.status}${done?.error ? `: ${done.error}` : ""}`);
      if (opts.once) return;
      continue;
    }
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, opts.idleMs ?? 600));
  }
}
