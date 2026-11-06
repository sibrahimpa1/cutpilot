import { existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config";

/** Load the repo's .env (if present) without overriding variables that are already set. */
export function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(REPO_ROOT, f);
    if (existsSync(p)) {
      try {
        (process as any).loadEnvFile?.(p);
      } catch {
        /* malformed lines are ignored */
      }
    }
  }
}
