"use client";

import { CheckCircle2, CircleDashed, Loader2, Square, TriangleAlert } from "lucide-react";
import type { Job } from "@cutpilot/core";
import { timeAgo } from "@/lib/client";

const LABEL: Record<string, string> = { run_workflow: "Workflow run", revise: "Revision" };

export function JobsPanel({ jobs }: { jobs: Job[] }) {
  return (
    <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-ink-700 bg-ink-900/40 p-3 2xl:block">
      <h4 className="label">Job queue</h4>
      {jobs.length === 0 && <div className="text-xs text-ink-400">No jobs yet.</div>}
      <ul className="space-y-2">
        {jobs.map((j) => (
          <li key={j.id} className="rounded-xl border border-ink-700 bg-ink-850 p-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              {j.status === "running" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              ) : j.status === "done" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : j.status === "error" ? (
                <TriangleAlert className="h-3.5 w-3.5 text-red-400" />
              ) : j.status === "cancelled" ? (
                <Square className="h-3.5 w-3.5 text-ink-400" />
              ) : (
                <CircleDashed className="h-3.5 w-3.5 text-amber-300" />
              )}
              <span className="font-medium">{LABEL[j.type] ?? j.type}</span>
              <span className="ml-auto text-ink-400">{timeAgo(j.createdAt)}</span>
            </div>
            {j.type === "revise" && j.payload?.instruction && <div className="mt-1 line-clamp-2 text-ink-300">“{j.payload.instruction}”</div>}
            <div className={`mt-1 line-clamp-2 ${j.status === "error" ? "text-red-300" : "text-ink-400"}`}>{j.error ?? j.message ?? j.status}</div>
            {j.status === "running" && (
              <div className="mt-1.5 h-1 rounded bg-ink-700">
                <div className="h-full rounded bg-accent transition-all" style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
