import { getNodeRuns, getProject, listAssets, listEvents, listJobs, listRenders, NODE_DESCRIPTIONS } from "@cutpilot/core";
import { fail, fileUrl, handle, ok } from "@/lib/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Everything the project page needs, in one poll. */
export async function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const project = getProject(id);
    if (!project) return fail("Project not found", 404);
    const withUrls = (o: any): any => {
      // Add browser URLs next to any absolute file path in node outputs.
      if (Array.isArray(o)) return o.map(withUrls);
      if (o && typeof o === "object") {
        const r: any = {};
        for (const [k, v] of Object.entries(o)) {
          r[k] = withUrls(v);
          if (typeof v === "string" && v.startsWith("/") && /\.(mp4|wav|png|jpe?g|mp3|mov)$/i.test(v)) r[`${k}Url`] = fileUrl(v);
        }
        return r;
      }
      return o;
    };
    return ok({
      project,
      descriptions: NODE_DESCRIPTIONS,
      assets: listAssets(id).map((a) => ({
        ...a,
        url: fileUrl(a.path),
        transcript: a.transcript ? { provider: a.transcript.provider, words: a.transcript.words.length, text: a.transcript.words.map((w) => w.text).join(" ") } : null,
      })),
      runs: { edit: withUrls(getNodeRuns(id, "edit")), generate: withUrls(getNodeRuns(id, "generate")) },
      jobs: listJobs(id, 20),
      renders: listRenders(id).map((r) => ({ ...r, url: fileUrl(r.path), thumbUrl: fileUrl(r.thumb) })),
      events: listEvents(id).slice(-300),
    });
  });
}
