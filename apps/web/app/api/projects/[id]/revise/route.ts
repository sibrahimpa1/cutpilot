import { enqueueJob, getProject, listRenders } from "@cutpilot/core";
import { fail, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    if (!getProject(id)) return fail("Project not found", 404);
    if (!listRenders(id).length) return fail("Render the workflow once before revising.");
    const body = await req.json().catch(() => ({}));
    if (!body.instruction && !(Array.isArray(body.ops) && body.ops.length)) return fail("Send an instruction or ops");
    const job = enqueueJob(id, "revise", {
      instruction: body.instruction ? String(body.instruction).slice(0, 2000) : undefined,
      ops: body.ops,
      baseRenderId: body.baseRenderId || undefined,
    });
    return ok(job, { status: 202 });
  });
}
