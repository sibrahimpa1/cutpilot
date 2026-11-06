import { enqueueJob, getProject, Mode } from "@cutpilot/core";
import { fail, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const p = getProject(id);
    if (!p) return fail("Project not found", 404);
    const body = await req.json().catch(() => ({}));
    const job = enqueueJob(id, "run_workflow", {
      mode: Mode.parse(body.mode ?? p.mode),
      fromNodeId: body.fromNodeId || undefined,
      onlyNodeId: body.onlyNodeId || undefined,
      force: !!body.force,
    });
    return ok(job, { status: 202 });
  });
}
