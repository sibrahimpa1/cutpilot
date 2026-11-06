import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir, extractFrame } from "@cutpilot/core";
import { fail, insideData } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Cached frame grab: /api/thumb?path=<video>&t=<seconds> */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const file = insideData(url.searchParams.get("path"));
  const t = Number(url.searchParams.get("t") ?? 0);
  if (!file || !existsSync(file) || !Number.isFinite(t)) return fail("Not found", 404);
  const out = path.join(dataDir(), "thumbs", createHash("sha1").update(`${file}@${t.toFixed(2)}`).digest("hex") + ".jpg");
  try {
    if (!existsSync(out)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(path.dirname(out), { recursive: true });
      await extractFrame(file, t, out, 320);
    }
    return new Response(readFileSync(out), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return fail("Could not read frame", 500);
  }
}
