import { getProject, listEvents, listRenders } from "./db";

/**
 * Delivery notes: the tools used, what the AI executed, what was manual, and time spent.
 * Built from the event log, so it is always complete and never written by hand.
 */
export function productionReport(projectId: string): string {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found");
  const events = listEvents(projectId);
  const renders = listRenders(projectId);
  const fmt = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);
  const count = (actor: string) => events.filter((e) => e.actor === actor).length;
  const tools = [...new Set(events.map((e) => e.tool))];
  const span = events.length ? events[events.length - 1].ts - events[0].ts : 0;
  const machineMs = events.reduce((s, e) => s + (e.actor !== "user" && e.durationMs ? e.durationMs : 0), 0);
  const manual = events.filter((e) => e.actor === "user");

  const lines = [
    `# Production log: ${p.name}`,
    "",
    `- Mode: ${p.mode === "edit" ? "Edit supplied footage" : "Generate from an idea"}`,
    `- Brief: ${p.brief || "(none)"}`,
    `- Versions delivered: ${renders.length}${renders[0] ? ` (latest v${renders[0].version}: ${renders[0].width}×${renders[0].height}, ${renders[0].duration?.toFixed(1)}s)` : ""}`,
    `- Elapsed: ${(span / 60000).toFixed(1)} min wall clock, ${(machineMs / 1000).toFixed(0)} s of machine work`,
    `- Steps: ${count("ai")} AI decisions, ${count("system")} automated operations, ${count("user")} manual actions`,
    `- Tools: ${tools.join(", ")}`,
    "",
    "## Manual intervention",
    "",
    ...(manual.length ? manual.map((e) => `- ${fmt(e.ts)}: ${e.action}${e.detail ? `: ${e.detail}` : ""}`) : ["- None"]),
    "",
    "## Versions",
    "",
    ...renders
      .slice()
      .reverse()
      .map((r) => `- v${r.version} (${fmt(r.createdAt)}): ${r.label}; ${r.timeline.aspect}, ${r.duration?.toFixed(1)}s, ${r.timeline.clips.length} clips`),
    "",
    "## Full log",
    "",
    "| Time | Actor | Tool | Action | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...events.map((e) => `| ${fmt(e.ts)} | ${e.actor} | ${e.tool} | ${e.action} | ${(e.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
  ];
  return lines.join("\n");
}
