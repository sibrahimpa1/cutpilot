import { resolveProviders } from "@cutpilot/core";
import { handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() => {
    const p = resolveProviders();
    return ok({ status: p.status, ffmpeg: p.ffmpeg });
  });
}
