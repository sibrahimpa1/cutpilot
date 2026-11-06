import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir } from "./config";
import type { Graph, Mode, Timeline, Transcript } from "./types";
import { templateFor } from "./workflow/templates";

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  const file = process.env.DB_PATH ?? path.join(dataDir(), "cutpilot.db");
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(d);
  _db = d;
  return d;
}

/** For tests: use a fresh database file. */
export function resetDbForTests(file: string) {
  _db?.close();
  _db = null;
  process.env.DB_PATH = file;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      graphs TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      duration REAL,
      width INTEGER,
      height INTEGER,
      has_audio INTEGER NOT NULL DEFAULT 0,
      transcript TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_runs (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_hash TEXT,
      output TEXT,
      error TEXT,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT,
      provider TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (project_id, mode, node_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      label TEXT NOT NULL,
      mode TEXT NOT NULL,
      timeline TEXT NOT NULL,
      path TEXT NOT NULL,
      thumb TEXT,
      duration REAL,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER,
      render_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      duration_ms INTEGER
    );
  `);
}

const now = () => Date.now();
const json = <T>(s: string | null | undefined): T | null => (s ? (JSON.parse(s) as T) : null);

/* ----------------------------- projects ----------------------------- */

export type Project = {
  id: string;
  name: string;
  mode: Mode;
  brief: string;
  graphs: Record<Mode, Graph>;
  createdAt: number;
  updatedAt: number;
};

function rowToProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    brief: r.brief,
    graphs: JSON.parse(r.graphs),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createProject(input: { name: string; mode: Mode; brief?: string }): Project {
  const id = randomUUID().slice(0, 8);
  const graphs = { edit: templateFor("edit"), generate: templateFor("generate") };
  if (input.brief) {
    // Seed the idea node with the brief so "generate" works straight away.
    const idea = graphs.generate.nodes.find((n) => n.type === "idea");
    if (idea) idea.params = { ...idea.params, prompt: input.brief };
  }
  db()
    .prepare(
      `INSERT INTO projects (id,name,mode,brief,graphs,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, input.name, input.mode, input.brief ?? "", JSON.stringify(graphs), now(), now());
  return getProject(id)!;
}

export function getProject(id: string): Project | null {
  const r = db().prepare(`SELECT * FROM projects WHERE id=?`).get(id);
  return r ? rowToProject(r) : null;
}

export function listProjects(): (Project & { latestRender: RenderRow | null })[] {
  const rows = db().prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all();
  return rows.map((r) => {
    const p = rowToProject(r);
    return { ...p, latestRender: listRenders(p.id)[0] ?? null };
  });
}

export function updateProject(id: string, patch: Partial<Pick<Project, "name" | "mode" | "brief" | "graphs">>) {
  const p = getProject(id);
  if (!p) throw new Error(`Project ${id} not found`);
  const next = { ...p, ...patch };
  db()
    .prepare(`UPDATE projects SET name=?, mode=?, brief=?, graphs=?, updated_at=? WHERE id=?`)
    .run(next.name, next.mode, next.brief, JSON.stringify(next.graphs), now(), id);
  return getProject(id)!;
}

export function touchProject(id: string) {
  db().prepare(`UPDATE projects SET updated_at=? WHERE id=?`).run(now(), id);
}

export function deleteProject(id: string) {
  db().prepare(`DELETE FROM projects WHERE id=?`).run(id);
}

/* ------------------------------ assets ------------------------------ */

export type Asset = {
  id: string;
  projectId: string;
  kind: "video" | "audio" | "image";
  name: string;
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  transcript: Transcript | null;
  createdAt: number;
};

function rowToAsset(r: any): Asset {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    name: r.name,
    path: r.path,
    duration: r.duration,
    width: r.width,
    height: r.height,
    hasAudio: !!r.has_audio,
    transcript: json<Transcript>(r.transcript),
    createdAt: r.created_at,
  };
}

export function addAsset(a: Omit<Asset, "id" | "createdAt" | "transcript">): Asset {
  const id = randomUUID().slice(0, 8);
  db()
    .prepare(
      `INSERT INTO assets (id,project_id,kind,name,path,duration,width,height,has_audio,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, a.projectId, a.kind, a.name, a.path, a.duration, a.width, a.height, a.hasAudio ? 1 : 0, now());
  touchProject(a.projectId);
  return getAsset(id)!;
}

export function getAsset(id: string): Asset | null {
  const r = db().prepare(`SELECT * FROM assets WHERE id=?`).get(id);
  return r ? rowToAsset(r) : null;
}

export function listAssets(projectId: string): Asset[] {
  return db()
    .prepare(`SELECT * FROM assets WHERE project_id=? ORDER BY created_at`)
    .all(projectId)
    .map(rowToAsset);
}

export function setTranscript(assetId: string, t: Transcript) {
  db().prepare(`UPDATE assets SET transcript=? WHERE id=?`).run(JSON.stringify(t), assetId);
}

export function deleteAsset(id: string) {
  db().prepare(`DELETE FROM assets WHERE id=?`).run(id);
}

/* ----------------------------- node runs ---------------------------- */

export type NodeRunStatus = "idle" | "queued" | "running" | "done" | "error" | "skipped";

export type NodeRun = {
  nodeId: string;
  status: NodeRunStatus;
  inputHash: string | null;
  output: any;
  error: string | null;
  progress: number;
  message: string | null;
  provider: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export function getNodeRuns(projectId: string, mode: Mode): Record<string, NodeRun> {
  const rows = db().prepare(`SELECT * FROM node_runs WHERE project_id=? AND mode=?`).all(projectId, mode) as any[];
  const out: Record<string, NodeRun> = {};
  for (const r of rows) {
    out[r.node_id] = {
      nodeId: r.node_id,
      status: r.status,
      inputHash: r.input_hash,
      output: json(r.output),
      error: r.error,
      progress: r.progress,
      message: r.message,
      provider: r.provider,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }
  return out;
}

export function upsertNodeRun(projectId: string, mode: Mode, nodeId: string, patch: Partial<NodeRun>) {
  const existing: NodeRun | undefined = getNodeRuns(projectId, mode)[nodeId];
  const blank: NodeRun = {
    nodeId,
    status: "idle",
    inputHash: null,
    output: null,
    error: null,
    progress: 0,
    message: null,
    provider: null,
    startedAt: null,
    finishedAt: null,
  };
  const n: NodeRun = { ...blank, ...(existing ?? {}), ...patch };
  db()
    .prepare(
      `INSERT INTO node_runs (project_id,mode,node_id,status,input_hash,output,error,progress,message,provider,started_at,finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id,mode,node_id) DO UPDATE SET status=excluded.status,input_hash=excluded.input_hash,output=excluded.output,
       error=excluded.error,progress=excluded.progress,message=excluded.message,provider=excluded.provider,started_at=excluded.started_at,finished_at=excluded.finished_at`,
    )
    .run(
      projectId,
      mode,
      nodeId,
      n.status,
      n.inputHash,
      n.output == null ? null : JSON.stringify(n.output),
      n.error,
      n.progress,
      n.message,
      n.provider,
      n.startedAt,
      n.finishedAt,
    );
}

/* ------------------------------- jobs ------------------------------- */

export type JobType = "run_workflow" | "revise";
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export type Job = {
  id: string;
  projectId: string;
  type: JobType;
  payload: any;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

function rowToJob(r: any): Job {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    status: r.status,
    progress: r.progress,
    message: r.message,
    error: r.error,
    cancelRequested: !!r.cancel_requested,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function enqueueJob(projectId: string, type: JobType, payload: unknown): Job {
  const id = randomUUID().slice(0, 8);
  db()
    .prepare(`INSERT INTO jobs (id,project_id,type,payload,status,created_at) VALUES (?,?,?,?, 'queued', ?)`)
    .run(id, projectId, type, JSON.stringify(payload ?? {}), now());
  touchProject(projectId);
  return getJob(id)!;
}

/** Atomically claim the oldest queued job. Safe with several worker processes. */
export function claimNextJob(): Job | null {
  const r = db()
    .prepare(
      `UPDATE jobs SET status='running', started_at=? WHERE id = (
         SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1
       ) AND status='queued' RETURNING *`,
    )
    .get(now());
  return r ? rowToJob(r) : null;
}

/** Claim one specific queued job (used by the MCP server when no worker picks it up). */
export function claimJob(id: string): Job | null {
  const r = db().prepare(`UPDATE jobs SET status='running', started_at=? WHERE id=? AND status='queued' RETURNING *`).get(now(), id);
  return r ? rowToJob(r) : null;
}

export function getJob(id: string): Job | null {
  const r = db().prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  return r ? rowToJob(r) : null;
}

export function listJobs(projectId?: string, limit = 50): Job[] {
  const rows = projectId
    ? db().prepare(`SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).all(projectId, limit)
    : db().prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows.map(rowToJob);
}

export function updateJob(id: string, patch: Partial<Pick<Job, "status" | "progress" | "message" | "error">>) {
  const j = getJob(id);
  if (!j) return;
  const n = { ...j, ...patch };
  const finished = ["done", "error", "cancelled"].includes(n.status) ? now() : null;
  db()
    .prepare(`UPDATE jobs SET status=?, progress=?, message=?, error=?, finished_at=COALESCE(?, finished_at) WHERE id=?`)
    .run(n.status, n.progress, n.message, n.error, finished, id);
}

export function requestCancel(id: string) {
  db().prepare(`UPDATE jobs SET cancel_requested=1 WHERE id=?`).run(id);
  db().prepare(`UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'`).run(now(), id);
}

/** Jobs left "running" by a crashed worker go back to the queue. */
export function requeueStaleJobs() {
  return db().prepare(`UPDATE jobs SET status='queued', started_at=NULL WHERE status='running'`).run().changes as number;
}

/* ------------------------------ renders ----------------------------- */

export type RenderRow = {
  id: string;
  projectId: string;
  version: number;
  label: string;
  mode: Mode;
  timeline: Timeline;
  path: string;
  thumb: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  renderMs: number | null;
  createdAt: number;
};

function rowToRender(r: any): RenderRow {
  return {
    id: r.id,
    projectId: r.project_id,
    version: r.version,
    label: r.label,
    mode: r.mode,
    timeline: JSON.parse(r.timeline),
    path: r.path,
    thumb: r.thumb,
    duration: r.duration,
    width: r.width,
    height: r.height,
    sizeBytes: r.size_bytes,
    renderMs: r.render_ms,
    createdAt: r.created_at,
  };
}

export function nextRenderVersion(projectId: string): number {
  const r = db().prepare(`SELECT MAX(version) v FROM renders WHERE project_id=?`).get(projectId) as { v: number | null };
  return (r.v ?? 0) + 1;
}

export function addRender(r: Omit<RenderRow, "createdAt">): RenderRow {
  db()
    .prepare(
      `INSERT INTO renders (id,project_id,version,label,mode,timeline,path,thumb,duration,width,height,size_bytes,render_ms,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      r.id,
      r.projectId,
      r.version,
      r.label,
      r.mode,
      JSON.stringify(r.timeline),
      r.path,
      r.thumb,
      r.duration,
      r.width,
      r.height,
      r.sizeBytes,
      r.renderMs,
      now(),
    );
  touchProject(r.projectId);
  return getRender(r.id)!;
}

export function getRender(id: string): RenderRow | null {
  const r = db().prepare(`SELECT * FROM renders WHERE id=?`).get(id);
  return r ? rowToRender(r) : null;
}

export function listRenders(projectId: string): RenderRow[] {
  return db()
    .prepare(`SELECT * FROM renders WHERE project_id=? ORDER BY version DESC`)
    .all(projectId)
    .map(rowToRender);
}

/* ------------------------------ events ------------------------------ */

export type EventActor = "ai" | "user" | "system";
export type LogEvent = {
  id: number;
  projectId: string;
  ts: number;
  actor: EventActor;
  tool: string;
  action: string;
  detail: string | null;
  durationMs: number | null;
};

export function logEvent(e: Omit<LogEvent, "id" | "ts"> & { ts?: number }) {
  db()
    .prepare(`INSERT INTO events (project_id,ts,actor,tool,action,detail,duration_ms) VALUES (?,?,?,?,?,?,?)`)
    .run(e.projectId, e.ts ?? now(), e.actor, e.tool, e.action, e.detail, e.durationMs);
}

export function listEvents(projectId: string): LogEvent[] {
  return (db().prepare(`SELECT * FROM events WHERE project_id=? ORDER BY id`).all(projectId) as any[]).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    ts: r.ts,
    actor: r.actor,
    tool: r.tool,
    action: r.action,
    detail: r.detail,
    durationMs: r.duration_ms,
  }));
}
