import { requestCancel } from "@cutpilot/core";
import { handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    requestCancel((await params).id);
    return ok({ ok: true });
  });
}
