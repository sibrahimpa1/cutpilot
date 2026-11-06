"use client";

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  AudioLines,
  Captions,
  CheckCircle2,
  Clapperboard,
  Crop,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  Loader2,
  Mic,
  Music,
  Scissors,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRun } from "@cutpilot/core";
import { api } from "@/lib/client";
import type { Graph, Mode } from "@/lib/types";

export const NODE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  source: Film,
  transcribe: AudioLines,
  select_moments: Scissors,
  assemble_edit: Layers,
  reframe: Crop,
  idea: Lightbulb,
  script: FileText,
  voiceover: Mic,
  visuals: ImageIcon,
  align_captions: Captions,
  assemble_generated: Layers,
  music: Music,
  render: Clapperboard,
};

const AI_STEPS = new Set(["select_moments", "script"]);

type StepData = { label: string; type: string; run?: NodeRun; index: number; mode: Mode };

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const Icon = NODE_ICONS[data.type] ?? Film;
  const status = data.run?.status ?? "idle";
  const accent = data.mode === "edit" ? "text-edit" : "text-gen";
  const ring =
    status === "running"
      ? "border-accent shadow-[0_0_0_3px_rgba(139,123,255,0.25)]"
      : status === "error"
        ? "border-red-500/70"
        : status === "done"
          ? "border-emerald-500/40"
          : status === "queued"
            ? "border-amber-400/50 border-dashed"
            : "border-ink-600";
  return (
    <div className={`w-[220px] rounded-2xl border bg-ink-850 ${ring} ${selected ? "outline-2 outline-offset-2 outline-accent/70" : ""}`}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-0 !bg-ink-600" />
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-xl bg-ink-800 ${accent}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-ink-400 uppercase">
            Step {data.index + 1}
            {AI_STEPS.has(data.type) && <span className="rounded bg-accent/20 px-1 text-accent normal-case">AI</span>}
          </div>
          <div className="truncate text-sm font-semibold">{data.label}</div>
        </div>
        <div className="ml-auto">
          {status === "running" && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
          {status === "done" && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          {status === "error" && <TriangleAlert className="h-4 w-4 text-red-400" />}
        </div>
      </div>
      <div className="px-3 pt-2 pb-3">
        <div className="truncate text-[11px] text-ink-400">
          {status === "error"
            ? <span className="text-red-300">{data.run?.error}</span>
            : data.run?.message ?? (status === "queued" ? "Queued" : "Not run yet")}
        </div>
        {data.run?.provider && <div className="mt-0.5 truncate font-mono text-[10px] text-ink-400">{data.run.provider}</div>}
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${status === "error" ? "bg-red-500" : status === "done" ? "bg-emerald-500/70" : "bg-accent"}`}
            style={{ width: `${status === "done" ? 100 : Math.round((data.run?.progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-0 !bg-ink-600" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

export function WorkflowCanvas(props: {
  projectId: string;
  mode: Mode;
  graph: Graph;
  runs: Record<string, NodeRun>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const build = useCallback(
    (): Node<StepData>[] =>
      props.graph.nodes.map((n, i) => ({
        id: n.id,
        type: "step",
        position: n.position,
        selected: n.id === props.selected,
        data: { label: n.label, type: n.type, run: props.runs[n.id], index: i, mode: props.mode },
      })),
    [props.graph, props.runs, props.selected, props.mode],
  );
  const [nodes, setNodes] = useState<Node<StepData>[]>(build);

  useEffect(() => {
    // Refresh data (status/progress) but keep positions the user dragged to.
    setNodes((prev) => build().map((n) => ({ ...n, position: prev.find((p) => p.id === n.id)?.position ?? n.position })));
  }, [build]);

  const edges: Edge[] = useMemo(
    () =>
      props.graph.edges.map((e) => {
        const running = props.runs[e.target]?.status === "running";
        return { id: `${e.source}-${e.target}`, source: e.source, target: e.target, animated: running || props.runs[e.target]?.status === "queued", type: "smoothstep" };
      }),
    [props.graph, props.runs],
  );

  const onNodesChange = useCallback((changes: NodeChange<Node<StepData>>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => props.onSelect(n.id)}
      onNodeDragStop={(_, n) =>
        api(`/api/projects/${props.projectId}`, { method: "PATCH", json: { node: { mode: props.mode, id: n.id, position: n.position } } }).catch(() => {})
      }
      fitView
      fitViewOptions={{ padding: 0.25 }}
      minZoom={0.3}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#262b3a" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
