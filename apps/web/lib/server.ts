import path from "node:path";
import { dataDir, loadEnv } from "@cutpilot/core";

loadEnv();

export const ok = (data: unknown, init?: ResponseInit) => Response.json(data, init);
export const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** Resolve a file path and refuse anything outside the data directory. */
export function insideData(p: string | null): string | null {
  if (!p) return null;
  const root = path.resolve(dataDir());
  const abs = path.resolve(p);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

/** URL the browser can load a data file from. */
export const fileUrl = (p: string | null | undefined) => (p ? `/api/files?path=${encodeURIComponent(p)}` : null);

export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e: any) {
    console.error(e);
    return fail(String(e?.message ?? e), 500);
  }
}
