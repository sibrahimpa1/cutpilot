import { createProject, importFile, makeDemoFootage } from "@cutpilot/core";
import { handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One click: generate the fictional demo interview and open an Edit project with it. */
export async function POST() {
  return handle(async () => {
    const file = await makeDemoFootage();
    const p = createProject({
      name: "Demo: remote team interview",
      mode: "edit",
      brief: "A punchy 30 second cut for LinkedIn about running a remote team without drowning in meetings. Open on the strongest hook, end on the call to action.",
    });
    await importFile(p.id, file);
    return ok({ id: p.id }, { status: 201 });
  });
}
