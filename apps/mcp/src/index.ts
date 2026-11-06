/**
 * CutPilot MCP server: lets Claude Desktop (or any MCP client) run the whole video workflow
 * through conversation: create a project, import footage, run steps, revise, read the log.
 *
 * Jobs go through the same SQLite queue as the web app. If no worker picks a job up within a
 * few seconds, this server runs it itself, so it also works on its own.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  claimJob,
  createProject,
  describeTimeline,
  enqueueJob,
  executeJob,
  getJob,
  getNodeRuns,
  getProject,
  importFile,
  listAssets,
  listProjects,
  listRenders,
  loadEnv,
  productionReport,
  resolveProviders,
  updateProject,
  type Job,
  type Mode,
} from "@cutpilot/core";

loadEnv();
const server = new McpServer({ name: "cutpilot", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

async function waitForJob(job: Job, timeoutMs = 30 * 60_000): Promise<Job> {
  const started = Date.now();
  let ranInline = false;
  for (;;) {
    const j = getJob(job.id)!;
    if (["done", "error", "cancelled"].includes(j.status)) return j;
    if (!ranInline && j.status === "queued" && Date.now() - started > 3000) {
      const claimed = claimJob(job.id);
      if (claimed) {
        ranInline = true;
        await executeJob(claimed, resolveProviders());
        continue;
      }
    }
    if (Date.now() - started > timeoutMs) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function projectSummary(id: string) {
  const p = getProject(id);
  if (!p) throw new Error(`Project ${id} not found`);
  const runs = getNodeRuns(id, p.mode);
  return {
    id: p.id,
    name: p.name,
    mode: p.mode,
    brief: p.brief,
    steps: p.graphs[p.mode].nodes.map((n) => ({
      id: n.id,
      label: n.label,
      params: n.params,
      status: runs[n.id]?.status ?? "idle",
      provider: runs[n.id]?.provider ?? null,
      error: runs[n.id]?.error ?? null,
    })),
    assets: listAssets(id).map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: a.duration, size: `${a.width}x${a.height}`, transcribed: !!a.transcript })),
    versions: listRenders(id).map((r) => ({ version: r.version, id: r.id, label: r.label, path: r.path, aspect: r.timeline.aspect, duration: r.duration })),
  };
}

function jobResult(j: Job, projectId: string) {
  const latest = listRenders(projectId)[0];
  return {
    job: { id: j.id, status: j.status, message: j.message, error: j.error },
    latestVersion: latest ? { version: latest.version, path: latest.path, label: latest.label, aspect: latest.timeline.aspect, duration: latest.duration } : null,
  };
}

server.registerTool(
  "list_projects",
  { title: "List projects", description: "List CutPilot video projects with their latest rendered version.", inputSchema: {} },
  async () => json(listProjects().map((p) => ({ id: p.id, name: p.name, mode: p.mode, latest: p.latestRender?.path ?? null }))),
);

server.registerTool(
  "providers",
  { title: "Provider status", description: "Show which AI/media providers are active (Claude or offline heuristics, TTS, transcription, visuals).", inputSchema: {} },
  async () => json(resolveProviders().status),
);

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description:
      "Create a video project. mode 'edit' cuts supplied footage from a brief; mode 'generate' makes a narrated video from an idea (the brief becomes the idea).",
    inputSchema: { name: z.string(), mode: z.enum(["edit", "generate"]), brief: z.string().optional() },
  },
  async ({ name, mode, brief }) => json(projectSummary(createProject({ name, mode, brief }).id)),
);

server.registerTool(
  "import_media",
  {
    title: "Import media",
    description: "Copy a local video, audio or image file into a project (absolute path on this machine).",
    inputSchema: { projectId: z.string(), path: z.string() },
  },
  async ({ projectId, path }) => {
    const a = await importFile(projectId, path);
    return json({ id: a.id, name: a.name, kind: a.kind, duration: a.duration, width: a.width, height: a.height });
  },
);

server.registerTool(
  "configure",
  {
    title: "Configure project",
    description:
      "Change the brief, switch mode, or set parameters of one workflow step. Edit steps: select_moments {targetSeconds,maxClips}, assemble_edit {aspect:'16:9'|'9:16'|'1:1', captionStyle:'karaoke'|'block'|'off', titleCard}, reframe {mode:'track'|'center'|'off'}, music {source:'generated'|'none', volume}. Generate steps: idea {prompt, seconds, style, aspect}, assemble_generated {captionStyle, kenBurns}.",
    inputSchema: {
      projectId: z.string(),
      brief: z.string().optional(),
      mode: z.enum(["edit", "generate"]).optional(),
      step: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async ({ projectId, brief, mode, step, params }) => {
    const p = getProject(projectId);
    if (!p) throw new Error("Project not found");
    const graphs = structuredClone(p.graphs);
    if (step && params) {
      const m = (mode ?? p.mode) as Mode;
      const node = graphs[m].nodes.find((n) => n.id === step);
      if (!node) throw new Error(`Unknown step "${step}". Steps: ${graphs[m].nodes.map((n) => n.id).join(", ")}`);
      node.params = { ...node.params, ...params };
    }
    updateProject(projectId, { brief: brief ?? p.brief, mode: mode ?? p.mode, graphs });
    return json(projectSummary(projectId));
  },
);

server.registerTool(
  "run_workflow",
  {
    title: "Run workflow",
    description:
      "Run the project's workflow and wait for the MP4. Unchanged steps are cached. fromStep re-runs that step and everything after it; onlyStep re-runs one step.",
    inputSchema: { projectId: z.string(), fromStep: z.string().optional(), onlyStep: z.string().optional(), force: z.boolean().optional() },
  },
  async ({ projectId, fromStep, onlyStep, force }) => {
    const job = enqueueJob(projectId, "run_workflow", { fromNodeId: fromStep, onlyNodeId: onlyStep, force });
    const done = await waitForJob(job);
    return json({ ...jobResult(done, projectId), steps: projectSummary(projectId).steps });
  },
);

server.registerTool(
  "get_project",
  { title: "Get project", description: "Steps, statuses, assets and rendered versions (with MP4 paths).", inputSchema: { projectId: z.string() } },
  async ({ projectId }) => json(projectSummary(projectId)),
);

server.registerTool(
  "get_edit",
  {
    title: "Get current edit",
    description: "The latest version's edit decision list: clips with their transcript, titles, captions, aspect. Use this before planning precise revisions.",
    inputSchema: { projectId: z.string(), version: z.number().int().optional() },
  },
  async ({ projectId, version }) => {
    const r = listRenders(projectId).find((x) => version == null || x.version === version);
    if (!r) throw new Error("No rendered version yet. Run the workflow first.");
    return text(`v${r.version} (${r.path})\n${describeTimeline(r.timeline)}`);
  },
);

server.registerTool(
  "revise",
  {
    title: "Revise video",
    description:
      "Describe a change in plain words (e.g. 'remove the second clip', 'make a vertical 9:16 version', 'replace \"gonna\" with \"going to\" in the captions', 'cut it to 30 seconds'). Claude plans the edit operations, then a new version is rendered.",
    inputSchema: { projectId: z.string(), instruction: z.string(), baseVersion: z.number().int().optional() },
  },
  async ({ projectId, instruction, baseVersion }) => {
    const base = baseVersion != null ? listRenders(projectId).find((r) => r.version === baseVersion) : undefined;
    const job = enqueueJob(projectId, "revise", { instruction, baseRenderId: base?.id });
    return json(jobResult(await waitForJob(job), projectId));
  },
);

server.registerTool(
  "apply_ops",
  {
    title: "Apply exact edit operations",
    description:
      "Apply explicit operations without AI planning. ops items: {op:'remove_clip',index} | {op:'move_clip',index,to} | {op:'trim_clip',index,head,tail} | {op:'remove_phrase',text} | {op:'set_aspect',aspect} | {op:'replace_caption_text',find,replace} | {op:'set_caption_style',style} | {op:'set_title',text} | {op:'remove_titles'} | {op:'set_music_volume',volume} | {op:'remove_music'} | {op:'target_duration',seconds}. Indexes are 0-based.",
    inputSchema: { projectId: z.string(), ops: z.array(z.record(z.string(), z.unknown())), baseVersion: z.number().int().optional() },
  },
  async ({ projectId, ops, baseVersion }) => {
    const base = baseVersion != null ? listRenders(projectId).find((r) => r.version === baseVersion) : undefined;
    const job = enqueueJob(projectId, "revise", { ops, baseRenderId: base?.id });
    return json(jobResult(await waitForJob(job), projectId));
  },
);

server.registerTool(
  "production_log",
  {
    title: "Production log",
    description: "Markdown delivery notes: tools used, AI decisions, manual interventions, versions and time spent.",
    inputSchema: { projectId: z.string() },
  },
  async ({ projectId }) => text(productionReport(projectId)),
);

await server.connect(new StdioServerTransport());
console.error("[cutpilot-mcp] ready on stdio");
