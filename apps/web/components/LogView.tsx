"use client";

import { Bot, Cog, Download, User } from "lucide-react";
import type { ProjectState } from "@/lib/types";

export function LogView({ state }: { state: ProjectState }) {
  const ev = state.events;
  const by = (a: string) => ev.filter((e) => e.actor === a).length;
  const machine = ev.reduce((s, e) => s + (e.actor !== "user" && e.durationMs ? e.durationMs : 0), 0);
  const span = ev.length ? ev[ev.length - 1].ts - ev[0].ts : 0;
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">Production log</h2>
          <p className="text-sm text-ink-400">Every tool, AI decision and manual step, recorded automatically. Hand it in with the delivery.</p>
        </div>
        <a className="btn btn-primary ml-auto" href={`/api/projects/${state.project.id}/log`}>
          <Download className="h-4 w-4" /> Download notes (.md)
        </a>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Stat label="AI decisions" value={by("ai")} />
        <Stat label="Automated steps" value={by("system")} />
        <Stat label="Manual actions" value={by("user")} />
        <Stat label="Machine time" value={`${(machine / 1000).toFixed(0)} s`} sub={`${(span / 60000).toFixed(1)} min elapsed`} />
      </div>
      <div className="panel overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-ink-800 text-xs text-ink-400">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Tool</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {ev
              .slice()
              .reverse()
              .map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-400">{new Date(e.ts).toLocaleTimeString()}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-xs">
                      {e.actor === "ai" ? <Bot className="h-3.5 w-3.5 text-accent" /> : e.actor === "user" ? <User className="h-3.5 w-3.5 text-edit" /> : <Cog className="h-3.5 w-3.5 text-ink-400" />}
                      {e.actor}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{e.tool}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{e.action}</td>
                  <td className="px-3 py-2 text-xs text-ink-300">{e.detail}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="panel p-3">
      <div className="label !mb-0.5">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-ink-400">{sub}</div>}
    </div>
  );
}
