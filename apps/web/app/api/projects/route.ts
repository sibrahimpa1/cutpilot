import { createProject, listProjects, Mode } from "@cutpilot/core";
import { fail, fileUrl, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() =>
    ok(
      listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        mode: p.mode,
        brief: p.brief,
        updatedAt: p.updatedAt,
        latest: p.latestRender
          ? {
              version: p.latestRender.version,
              thumb: fileUrl(p.latestRender.thumb),
              aspect: p.latestRender.timeline.aspect,
              duration: p.latestRender.duration,
            }
          : null,
      })),
    ),
  );
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await req.json().catch(() => ({}));
    const mode = Mode.safeParse(body.mode);
    if (!mode.success) return fail("mode must be 'edit' or 'generate'");
    const name = String(body.name ?? "").trim() || (mode.data === "edit" ? "Untitled edit" : "Untitled video");
    const p = createProject({ name, mode: mode.data, brief: String(body.brief ?? "") });
    return ok({ id: p.id }, { status: 201 });
  });
}
