import { deleteProject, getProject, Mode, updateProject } from "@cutpilot/core";
import { fail, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const p = getProject(id);
    if (!p) return fail("Project not found", 404);
    const body = await req.json().catch(() => ({}));
    const patch: Parameters<typeof updateProject>[1] = {};
    if (typeof body.name === "string") patch.name = body.name.slice(0, 120);
    if (typeof body.brief === "string") patch.brief = body.brief.slice(0, 4000);
    if (body.mode) patch.mode = Mode.parse(body.mode);
    if (body.node) {
      const mode = Mode.parse(body.node.mode ?? p.mode);
      const graphs = structuredClone(p.graphs);
      const node = graphs[mode].nodes.find((n) => n.id === body.node.id);
      if (!node) return fail("Unknown node");
      node.params = { ...node.params, ...(body.node.params ?? {}) };
      if (body.node.position) node.position = body.node.position;
      patch.graphs = graphs;
    }
    updateProject(id, patch);
    return ok({ ok: true });
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    deleteProject(id);
    return ok({ ok: true });
  });
}
