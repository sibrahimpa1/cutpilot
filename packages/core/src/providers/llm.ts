import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { config } from "../config";
import { MomentSelection, RevisionPlan, Script, type Timeline, type Word } from "../types";
import { describeTimeline, heuristicRevision, heuristicScript, heuristicSelect, sentences } from "./heuristics";

export interface LLMProvider {
  id: string;
  selectMoments(input: {
    brief: string;
    targetSeconds: number;
    maxClips: number;
    transcripts: { assetId: string; name: string; words: Word[]; duration: number }[];
  }): Promise<MomentSelection>;
  writeScript(input: { prompt: string; seconds: number; style: string; aspect: string }): Promise<Script>;
  planRevision(input: { instruction: string; timeline: Timeline; brief: string }): Promise<RevisionPlan>;
}

export const heuristicLLM: LLMProvider = {
  id: "heuristic",
  async selectMoments(i) {
    return heuristicSelect(i.transcripts, i.brief, i.targetSeconds, i.maxClips);
  },
  async writeScript(i) {
    return heuristicScript(i.prompt, i.seconds);
  },
  async planRevision(i) {
    return heuristicRevision(i.instruction, i.timeline);
  },
};

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const MOMENTS_SCHEMA = obj({
  title: str,
  hook: str,
  moments: { type: "array", items: obj({ assetId: str, start: num, end: num, reason: str }) },
});

const SCRIPT_SCHEMA = obj({
  title: str,
  scenes: { type: "array", items: obj({ narration: str, visual: str, onScreen: str }) },
});

const op = (name: string, props: Record<string, unknown> = {}) => obj({ op: { type: "string", enum: [name] }, ...props });
const REVISION_SCHEMA = obj({
  explanation: str,
  ops: {
    type: "array",
    items: {
      anyOf: [
        op("remove_clip", { index: int }),
        op("move_clip", { index: int, to: int }),
        op("trim_clip", { index: int, head: num, tail: num }),
        op("remove_phrase", { text: str }),
        op("set_aspect", { aspect: { type: "string", enum: ["16:9", "9:16", "1:1"] } }),
        op("replace_caption_text", { find: str, replace: str }),
        op("set_caption_style", { style: { type: "string", enum: ["karaoke", "block", "off"] } }),
        op("set_title", { text: str }),
        op("remove_titles"),
        op("set_music_volume", { volume: num }),
        op("remove_music"),
        op("target_duration", { seconds: num }),
      ],
    },
  },
});

/** Sends one structured request and returns the model's JSON text. */
export type Transport = (req: { system: string; user: string; jsonSchema: object; effort: "low" | "medium" | "high" }) => Promise<string>;

/** Claude through the Anthropic API (structured outputs + server-side refusal fallbacks). */
export function anthropicTransport(apiKey: string, model = config.anthropicModel): Transport {
  const client = new Anthropic({ apiKey });
  return async ({ system, user, jsonSchema, effort }) => {
    const params = {
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema: jsonSchema } },
    };
    const res = (await client.beta.messages.create(params as any)) as any;
    if (res.stop_reason === "refusal") throw new Error(`Claude declined this request (${res.stop_details?.category ?? "policy"}).`);
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens).");
    return (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
  };
}

/** Claude through OpenRouter (one key for many models), with a strict JSON schema response format. */
export function openrouterTransport(apiKey: string, model = config.openrouterModel): Transport {
  return async ({ system, user, jsonSchema, effort }) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/sibrahimpa1/cutpilot",
        "X-Title": "CutPilot",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        reasoning: { effort },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema: jsonSchema } },
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(`OpenRouter ${res.status}: ${j.error?.message ?? res.statusText}`);
    const choice = j.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("The model's answer was cut off (max_tokens).");
    const text = String(choice?.message?.content ?? "").trim();
    // Some routes wrap JSON in a code fence; strip it.
    return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  };
}

/** The Claude planner: same prompts and schemas whichever transport carries them. */
export class ClaudeLLM implements LLMProvider {
  constructor(
    public id: string,
    private send: Transport,
  ) {}

  private async structured<T>(schema: z.ZodType<T>, jsonSchema: object, system: string, user: string, effort: "low" | "medium" | "high" = "medium"): Promise<T> {
    const text = await this.send({ system, user, jsonSchema, effort });
    return schema.parse(JSON.parse(text));
  }

  async selectMoments(i: Parameters<LLMProvider["selectMoments"]>[0]) {
    const transcript = i.transcripts
      .map((t) => {
        const lines = sentences(t.assetId, t.words).map((s) => `[${s.start.toFixed(2)}–${s.end.toFixed(2)}] ${s.text}`);
        return `## Asset ${t.assetId} — "${t.name}" (${t.duration.toFixed(1)}s)\n${lines.join("\n") || "(no speech)"}`;
      })
      .join("\n\n");
    return this.structured(
      MomentSelection,
      MOMENTS_SCHEMA,
      `You are a senior video editor cutting supplied interview or talking-head footage into a finished edit.
Choose the strongest, self-contained moments that serve the brief and form a clear story: a hook first, then substance, then a natural ending.
Rules:
- Use only timestamps that appear in the transcript; start and end on sentence boundaries listed there.
- Never change the speaker's meaning: do not stitch half-sentences into claims the speaker did not make.
- Keep chronological order unless reordering clearly improves the story without changing meaning.
- Aim for the target length (within ±15%) and at most the given number of moments.
- "hook" is a short on-screen title (max 8 words) for the opening; "title" names the video.
- "reason" says in one sentence why each moment earns its place.`,
      `Brief: ${i.brief || "(none — make the most engaging cut)"}\nTarget length: ${i.targetSeconds}s\nMax moments: ${i.maxClips}\n\n${transcript}`,
      "high",
    );
  }

  async writeScript(i: Parameters<LLMProvider["writeScript"]>[0]) {
    const words = Math.round(i.seconds * 2.4);
    return this.structured(
      Script,
      SCRIPT_SCHEMA,
      `You write scripts for short narrated videos that are assembled automatically from a voiceover, one visual per scene and burned-in captions.
- Total narration about ${words} words (${i.seconds}s at a natural pace). 4–7 scenes.
- Scene 1 is a hook that earns the next 3 seconds. The last scene lands the point or a call to action.
- "visual": a concrete, literal description a stock-footage search or image model can render (subject, setting, light). No text in the image.
- "onScreen": at most 6 words, or empty.
- Plain spoken English; no stage directions inside narration.`,
      `Idea: ${i.prompt}\nStyle: ${i.style}\nFormat: ${i.aspect}`,
    );
  }

  async planRevision(i: Parameters<LLMProvider["planRevision"]>[0]) {
    return this.structured(
      RevisionPlan,
      REVISION_SCHEMA,
      `You revise a video edit by emitting operations on its edit decision list. Clip indexes are 0-based and refer to the CURRENT order; operations run in sequence, so account for earlier removals shifting later indexes.
To remove filler words ("um", "uh"), emit one remove_phrase per filler word that appears in the transcript.
Operations: remove_clip, move_clip, trim_clip (seconds off head/tail), remove_phrase (cut where an exact spoken phrase occurs), set_aspect, replace_caption_text (fix caption wording without touching audio), set_caption_style, set_title (opening on-screen title), remove_titles, set_music_volume (0–1), remove_music, target_duration (shorten by trimming the weakest clips).
Prefer the smallest set of operations that does exactly what was asked. If something can't be done with these operations, say so in "explanation" and leave it out.`,
      `Brief: ${i.brief || "(none)"}\n\nCurrent edit:\n${describeTimeline(i.timeline)}\n\nRequested change: ${i.instruction}`,
    );
  }
}
