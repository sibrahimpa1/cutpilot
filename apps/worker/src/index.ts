import { loadEnv, resolveProviders, workerLoop } from "@cutpilot/core";

loadEnv();
const p = resolveProviders();
console.log("[worker] CutPilot worker started");
for (const s of p.status) console.log(`[worker]   ${s.kind.padEnd(7)} → ${s.active}`);
if (!p.ffmpeg) console.warn("[worker] ffmpeg/ffprobe not found on PATH: renders will fail. Install FFmpeg.");

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("[worker] stopping");
    process.exit(0);
  });
}

workerLoop({ onJob: (j) => console.log(`[worker] ${j.type} ${j.id} (project ${j.projectId})`) }).catch((e) => {
  console.error(e);
  process.exit(1);
});
