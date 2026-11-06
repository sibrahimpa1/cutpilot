import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createProject,
  enqueueJob,
  getJob,
  getNodeRuns,
  listEvents,
  listRenders,
  resetDbForTests,
  updateProject,
} from "../src/db";
import { productionReport } from "../src/report";
import { resolveProviders } from "../src/providers";
import { executeJob } from "../src/runner";
import { commandExists } from "../src/providers/speech";
import { ancestors, descendants, topoOrder } from "../src/workflow/engine";
import { templateFor } from "../src/workflow/templates";

describe("graph helpers", () => {
  const g = templateFor("generate");
  it("orders the template and walks it", () => {
    expect(topoOrder(g).map((n) => n.id)[0]).toBe("idea");
    expect(topoOrder(g).at(-1)!.id).toBe("render");
    expect([...ancestors(g, "voiceover")].sort()).toEqual(["idea", "script"]);
    expect(descendants(g, "music")).toEqual(new Set(["render"]));
  });
  it("rejects cycles", () => {
    expect(() => topoOrder({ nodes: g.nodes.slice(0, 2), edges: [{ source: "idea", target: "script" }, { source: "script", target: "idea" }] })).toThrow(/cycle/);
  });
});

const hasFfmpeg = commandExists("ffmpeg") && commandExists("ffprobe");

describe.skipIf(!hasFfmpeg)("generate workflow end to end (offline providers)", () => {
  let projectId: string;
  beforeAll(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutpilot-e2e-"));
    process.env.DATA_DIR = dir;
    process.env.LLM_PROVIDER = "heuristic";
    process.env.TTS_PROVIDER = "silent";
    process.env.STT_PROVIDER = "none";
    process.env.VISUALS_PROVIDER = "placeholder";
    resetDbForTests(path.join(dir, "test.db"));
    const p = createProject({ name: "e2e", mode: "generate", brief: "Two tips for better sleep. Keep a fixed wake time. Avoid screens late." });
    const graphs = structuredClone(p.graphs);
    graphs.generate.nodes.find((n) => n.id === "idea")!.params.seconds = 12;
    graphs.generate.nodes.find((n) => n.id === "idea")!.params.aspect = "1:1";
    updateProject(p.id, { graphs });
    projectId = p.id;
  });

  async function runJob(type: "run_workflow" | "revise", payload: object) {
    enqueueJob(projectId, type, payload);
    const job = claimNextJob()!;
    await executeJob(job, resolveProviders());
    return getJob(job.id)!;
  }

  it("runs every step and renders v1", async () => {
    const j = await runJob("run_workflow", {});
    expect(j.error).toBeNull();
    expect(j.status).toBe("done");
    const runs = getNodeRuns(projectId, "generate");
    expect(Object.values(runs).every((r) => r.status === "done")).toBe(true);
    const [r] = listRenders(projectId);
    expect(r.version).toBe(1);
    expect(existsSync(r.path)).toBe(true);
    expect([r.width, r.height]).toEqual([1080, 1080]);
  });

  it("caches unchanged steps", async () => {
    const before = getNodeRuns(projectId, "generate").script.finishedAt;
    const j = await runJob("run_workflow", {});
    expect(j.message).toBe("Everything was up to date");
    expect(getNodeRuns(projectId, "generate").script.finishedAt).toBe(before);
  });

  it("re-runs a single step on request", async () => {
    const before = getNodeRuns(projectId, "generate");
    await runJob("run_workflow", { onlyNodeId: "music" });
    const after = getNodeRuns(projectId, "generate");
    expect(after.music.finishedAt).not.toBe(before.music.finishedAt);
    expect(after.script.finishedAt).toBe(before.script.finishedAt);
  });

  it("revises the latest version into a new one", async () => {
    const j = await runJob("revise", { instruction: "remove the first clip and turn off captions" });
    expect(j.status).toBe("done");
    const [v2, v1] = listRenders(projectId);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.timeline.clips.length).toBe(v1.timeline.clips.length - 1);
    expect(v2.timeline.captions.style).toBe("off");
  });

  it("logs a production report", () => {
    const md = productionReport(projectId);
    expect(md).toMatch(/# Production log: e2e/);
    expect(md).toMatch(/Revision request/);
    expect(listEvents(projectId).some((e) => e.actor === "ai")).toBe(true);
  });
});
