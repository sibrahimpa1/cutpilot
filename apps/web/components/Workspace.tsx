"use client";

import { Film, GitBranch, Loader2, Play, RotateCcw, ScrollText, Sparkles, Square, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "./Editor";
import { Inspector } from "./Inspector";
import { JobsPanel } from "./JobsPanel";
import { Logo } from "./Logo";
import { LogView } from "./LogView";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { api } from "@/lib/client";
import type { Mode, ProjectState } from "@/lib/types";

type Tab = "workflow" | "editor" | "log";

export function Workspace({ id }: { id: string }) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("workflow");
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastRenderCount = useRef<number | null>(null);

  // Deep links: /projects/:id?tab=editor&node=select_moments
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t === "workflow" || t === "editor" || t === "log") setTab(t);
    if (q.get("node")) setSelected(q.get("node"));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<ProjectState>(`/api/projects/${id}/state`);
      setState(s);
      setError(null);
      // A new version just landed: jump to the editor to watch it.
      if (lastRenderCount.current != null && s.renders.length > lastRenderCount.current) {
        setTab("editor");
        setToast(`v${s.renders[0].version} rendered`);
        setTimeout(() => setToast(null), 3500);
      }
      lastRenderCount.current = s.renders.length;
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  const active = state?.jobs.some((j) => j.status === "queued" || j.status === "running") ?? false;

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, active ? 900 : 3000);
    return () => clearInterval(t);
  }, [refresh, active]);

  const mode: Mode = state?.project.mode ?? "edit";
  const graph = state?.project.graphs[mode];
  const runs = state?.runs[mode] ?? {};

  useEffect(() => {
    if (graph && (!selected || !graph.nodes.some((n) => n.id === selected))) setSelected(graph.nodes[0].id);
  }, [graph, selected]);

  async function setMode(m: Mode) {
    if (!state || m === mode) return;
    setState({ ...state, project: { ...state.project, mode: m } });
    await api(`/api/projects/${id}`, { method: "PATCH", json: { mode: m } });
    setTab("workflow");
    refresh();
  }

  async function run(opts: { fromNodeId?: string; onlyNodeId?: string; force?: boolean } = {}) {
    try {
      await api(`/api/projects/${id}/run`, { method: "POST", json: { mode, ...opts } });
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function cancel() {
    const j = state?.jobs.find((x) => x.status === "running" || x.status === "queued");
    if (j) await api(`/api/jobs/${j.id}/cancel`, { method: "POST" });
    refresh();
  }

  const runningJob = state?.jobs.find((j) => j.status === "running");
  const selectedNode = useMemo(() => graph?.nodes.find((n) => n.id === selected) ?? null, [graph, selected]);

  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-400">
        {error ? <span className="text-red-300">{error}</span> : <Loader2 className="h-6 w-6 animate-spin" />}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900/80 px-4 py-2.5 backdrop-blur">
        <Logo small />
        <span className="text-ink-600">/</span>
        <ProjectName id={id} name={state.project.name} onSaved={refresh} />

        <div className="ml-2 flex rounded-xl border border-ink-700 bg-ink-850 p-1" role="tablist" aria-label="Workflow mode">
          <ModeButton active={mode === "edit"} onClick={() => setMode("edit")} color="edit" icon={<Film className="h-4 w-4" />} label="Edit footage" />
          <ModeButton active={mode === "generate"} onClick={() => setMode("generate")} color="gen" icon={<Sparkles className="h-4 w-4" />} label="Generate from idea" />
        </div>

        <nav className="ml-auto flex items-center gap-1">
          <TabButton active={tab === "workflow"} onClick={() => setTab("workflow")} icon={<GitBranch className="h-4 w-4" />} label="Workflow" />
          <TabButton
            active={tab === "editor"}
            onClick={() => setTab("editor")}
            icon={<Wand2 className="h-4 w-4" />}
            label="Editor"
            badge={state.renders.length ? `v${state.renders[0].version}` : undefined}
          />
          <TabButton active={tab === "log"} onClick={() => setTab("log")} icon={<ScrollText className="h-4 w-4" />} label="Log" />
        </nav>

        {active ? (
          <button className="btn" onClick={cancel}>
            <Square className="h-4 w-4" /> Stop
          </button>
        ) : (
          <div className="flex gap-1">
            <button className="btn btn-primary" onClick={() => run()}>
              <Play className="h-4 w-4" /> Run workflow
            </button>
            <button className="btn" title="Re-run every step, ignoring the cache" onClick={() => run({ force: true })}>
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>
        )}
      </header>

      {runningJob && (
        <div className="relative h-1 bg-ink-800">
          <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-edit via-accent to-gen transition-all duration-500" style={{ width: `${Math.max(3, runningJob.progress * 100)}%` }} />
        </div>
      )}
      {error && <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">{error}</div>}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {tab === "workflow" && graph && (
            <div className="flex h-full">
              <div className="relative min-w-0 flex-1">
                <WorkflowCanvas
                  key={mode}
                  projectId={id}
                  mode={mode}
                  graph={graph}
                  runs={runs}
                  selected={selected}
                  onSelect={setSelected}
                />
                <div className="pointer-events-none absolute top-3 left-3 max-w-md rounded-xl border border-ink-700 bg-ink-900/85 px-3 py-2 text-xs text-ink-300 backdrop-blur">
                  {mode === "edit" ? (
                    <>
                      <b className="text-edit">Edit footage</b>: upload in <i>Footage</i>, write the brief in <i>Pick moments</i>, then Run. Click a step to tune it or re-run it alone.
                    </>
                  ) : (
                    <>
                      <b className="text-gen">Generate from idea</b>: describe it in <i>Idea</i>, then Run. Every step can be previewed and re-run.
                    </>
                  )}
                </div>
              </div>
              <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-900/60">
                {selectedNode && (
                  <Inspector
                    key={`${mode}-${selectedNode.id}`}
                    state={state}
                    mode={mode}
                    node={selectedNode}
                    run={runs[selectedNode.id]}
                    busy={active}
                    onRun={run}
                    onChanged={refresh}
                  />
                )}
              </aside>
            </div>
          )}
          {tab === "editor" && <Editor state={state} busy={active} onChanged={refresh} onRunWorkflow={() => { setTab("workflow"); run(); }} />}
          {tab === "log" && <LogView state={state} />}
        </main>
        <JobsPanel jobs={state.jobs} />
      </div>

      {toast && (
        <div className="fixed right-6 bottom-6 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-4 py-2.5 text-sm text-emerald-100 shadow-xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

function ModeButton(p: { active: boolean; onClick: () => void; color: "edit" | "gen"; icon: React.ReactNode; label: string }) {
  const on = p.color === "edit" ? "bg-edit/15 text-edit" : "bg-gen/15 text-gen";
  return (
    <button role="tab" aria-selected={p.active} onClick={p.onClick} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${p.active ? on : "text-ink-400 hover:text-ink-100"}`}>
      {p.icon}
      {p.label}
    </button>
  );
}

function TabButton(p: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: string }) {
  return (
    <button onClick={p.onClick} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${p.active ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-100"}`}>
      {p.icon}
      {p.label}
      {p.badge && <span className="rounded bg-accent/20 px-1 font-mono text-[10px] text-accent">{p.badge}</span>}
    </button>
  );
}

function ProjectName({ id, name, onSaved }: { id: string; name: string; onSaved: () => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <input
      aria-label="Project name"
      className="w-56 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold hover:border-ink-700 focus:border-accent focus:outline-none"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={async () => {
        if (v.trim() && v !== name) {
          await api(`/api/projects/${id}`, { method: "PATCH", json: { name: v.trim() } });
          onSaved();
        }
      }}
    />
  );
}
