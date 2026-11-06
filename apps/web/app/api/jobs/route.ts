import { listJobs } from "@cutpilot/core";
import { handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() => ok(listJobs(undefined, 50)));
}
