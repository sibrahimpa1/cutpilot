import { getProject, importStream } from "@cutpilot/core";
import { fail, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 600;
type Ctx = { params: Promise<{ id: string }> };

/** Raw-body upload (streamed to disk): POST /api/projects/:id/assets?name=clip.mp4 */
export async function POST(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    if (!getProject(id)) return fail("Project not found", 404);
    const name = new URL(req.url).searchParams.get("name");
    if (!name || !req.body) return fail("Send the file as the request body with ?name=");
    const asset = await importStream(id, name, req.body);
    return ok(asset, { status: 201 });
  });
}
