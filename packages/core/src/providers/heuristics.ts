import {
  timelineDuration,
  type Aspect,
  type MomentSelection,
  type RevisionOp,
  type RevisionPlan,
  type Script,
  type Timeline,
  type Word,
} from "../types";

/* Offline fallbacks for every AI decision. They are deliberately simple and transparent;
   the same interfaces are served by Claude when ANTHROPIC_API_KEY is set. */

export type Sentence = { assetId: string; start: number; end: number; text: string; words: Word[] };

/** Split word streams into sentences on punctuation or pauses longer than 0.7 s. */
export function sentences(assetId: string, words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ assetId, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text.trim()).join(" "), words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.7) flush();
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text.trim()) || cur.length >= 45) flush();
  }
  flush();
  return out;
}

const STOP = new Set(
  "the a an and or but so to of in on at for with from by is are was were be been it this that these those i you we they he she my your our their me us them as if then than just very really".split(" "),
);
const HOOKS = ["secret", "mistake", "never", "always", "why", "how", "biggest", "best", "worst", "first", "truth", "nobody", "most", "changed", "learned", "problem", "realized", "actually", "surprising", "simple"];
const FILLERS = new Set(["um", "uh", "erm", "like", "you know", "sort of", "kind of"]);

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

export function scoreSentence(s: Sentence, brief: string): number {
  const toks = tokens(s.text);
  if (toks.length < 4) return -5;
  const dur = s.end - s.start;
  const briefToks = new Set(tokens(brief).filter((t) => !STOP.has(t) && t.length > 2));
  let score = 0;
  for (const t of toks) {
    if (briefToks.has(t)) score += 2;
    if (HOOKS.includes(t)) score += 1.5;
    if (FILLERS.has(t)) score -= 1;
    if (/^\d/.test(t)) score += 1;
  }
  if (/\?$/.test(s.text.trim())) score += 1.5;
  if (/\b(you|your)\b/i.test(s.text)) score += 0.8;
  // Prefer clean, quotable lengths (4–14 s).
  if (dur >= 4 && dur <= 14) score += 2;
  else if (dur > 20) score -= 2;
  return score + Math.min(toks.length, 30) / 15;
}

export function heuristicSelect(
  transcripts: { assetId: string; words: Word[]; duration: number }[],
  brief: string,
  targetSeconds: number,
  maxClips: number,
): MomentSelection {
  const all = transcripts.flatMap((t) => sentences(t.assetId, t.words));
  if (!all.length) {
    // No speech found: spread evenly across the footage.
    const moments = transcripts.flatMap((t) => {
      const n = Math.max(1, Math.min(maxClips, Math.round(targetSeconds / 6)));
      const len = Math.min(6, t.duration / n);
      return Array.from({ length: n }, (_, i) => {
        const start = (t.duration / n) * i;
        return { assetId: t.assetId, start, end: Math.min(t.duration, start + len), reason: "Evenly spaced (no speech detected)" };
      });
    });
    return { title: "Highlights", hook: "Highlights", moments: moments.slice(0, maxClips) };
  }
  const ranked = all.map((s, i) => ({ s, i, score: scoreSentence(s, brief) })).sort((a, b) => b.score - a.score);
  const chosen: typeof ranked = [];
  let total = 0;
  for (const r of ranked) {
    if (chosen.length >= maxClips) break;
    const d = r.s.end - r.s.start;
    if (total + d > targetSeconds * 1.15 && chosen.length) continue;
    chosen.push(r);
    total += d;
    if (total >= targetSeconds * 0.9) break;
  }
  const best = chosen[0].s;
  const order = (x: (typeof ranked)[number]) => transcripts.findIndex((t) => t.assetId === x.s.assetId) * 1e6 + x.s.start;
  chosen.sort((a, b) => order(a) - order(b));
  const hookWords = cleanHook(best.text);
  return {
    title: hookWords,
    hook: hookWords,
    moments: chosen.map((c) => ({
      assetId: c.s.assetId,
      start: c.s.start,
      end: c.s.end,
      reason: `Heuristic score ${c.score.toFixed(1)}: ${c.s.text.slice(0, 80)}`,
    })),
  };
}

/** A short on-screen hook from a sentence: no fillers, at most 8 words. */
export function cleanHook(text: string): string {
  const words = text
    .replace(/\b(um+|uh+|erm|you know|i mean|honestly|so|well|like),?\s*/gi, "")
    .replace(/^[\s,]+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const s = words.join(" ").replace(/[,.;:]+$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const FILLER_WORDS = ["um", "uh", "umm", "uhh", "erm", "er", "ah", "hmm"];

export function heuristicScript(prompt: string, seconds: number): Script {
  const clean = prompt.trim() || "How to make a great short video";
  const parts = clean.split(/(?<=[.!?])\s+|\n+|;\s*/).map((s) => s.trim().replace(/[.!?]+$/, "")).filter((s) => s.length > 3);
  // The first sentence is the topic; any further sentences are the points to make.
  const topic = parts[0] ?? clean;
  const points = parts.slice(1);
  const nScenes = Math.max(3, Math.min(7, Math.max(points.length + 2, Math.round(seconds / 6))));
  const short = (s: string, n = 5) => s.split(/\s+/).slice(0, n).join(" ");
  const scenes: Script["scenes"] = [{ narration: `${topic}. Here's how.`, visual: topic, onScreen: short(topic, 6) }];
  const generic = [
    `Start with the one thing that matters most.`,
    `Keep it simple. Small steps, done every day, beat big plans.`,
    `Avoid the common mistake: trying to do everything at once.`,
    `Measure what works, and drop what doesn't.`,
    `Share what you learn. Teaching it makes it stick.`,
  ];
  for (let i = 0; scenes.length < nScenes - 1; i++) {
    const point = points[i];
    const narration = point ? `${points.length > 1 ? `${["One", "Two", "Three", "Four", "Five", "Six"][i] ?? "Next"}: ` : ""}${point}.` : generic[i % generic.length];
    scenes.push({ narration, visual: point ?? narration, onScreen: point ? short(point) : "" });
  }
  scenes.push({ narration: `Try it this week, and follow for more.`, visual: `${topic}, success, celebration`, onScreen: "Try it this week" });
  return { title: short(topic, 8), scenes };
}

/* ----------------------------- revisions ---------------------------- */

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, last: -1 };

function clipIndex(word: string, count: number): number | null {
  const w = word.toLowerCase();
  if (w in ORDINALS) return ORDINALS[w] === -1 ? count - 1 : ORDINALS[w] - 1;
  const n = parseInt(w.replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n - 1 : null;
}

/** Rule-based parser for common revision requests. Handles several requests joined by "and" / ";". */
export function heuristicRevision(instruction: string, t: Timeline): RevisionPlan {
  const ops: RevisionOp[] = [];
  const notes: string[] = [];
  const parts = instruction.split(/;|\n|\band then\b|(?<=[.!])\s+|,?\s+and\s+(?=(?:make|remove|delete|cut|drop|replace|change|turn|set|add|use|move|trim|shorten|mute|no)\b)/i);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    let m: RegExpMatchArray | null;
    const aspect: Aspect | null = /\b(9[:x/]16|vertical|portrait|reels?|tiktok|shorts)\b/i.test(p)
      ? "9:16"
      : /\b(1[:x/]1|square)\b/i.test(p)
        ? "1:1"
        : /\b(16[:x/]9|horizontal|landscape|youtube)\b/i.test(p)
          ? "16:9"
          : null;
    if ((m = p.match(/(?:replace|change|fix)\s+["“']([^"”']+)["”']\s+(?:with|to|into)\s+["“']([^"”']*)["”']/i))) {
      ops.push({ op: "replace_caption_text", find: m[1], replace: m[2] });
    } else if ((m = p.match(/(?:remove|delete|cut|drop)\s+(?:the\s+)?(?:part|bit|section|moment|line)?\s*(?:where|when)?\s*(?:he|she|they|i|we|it)?\s*(?:says?|said|mentions?)\s+["“']([^"”']+)["”']/i))) {
      ops.push({ op: "remove_phrase", text: m[1] });
    } else if (/\b(filler|fillers|ums?|uhs?|ums and uhs)\b/i.test(p) && /\b(remove|delete|cut|drop|clean|no)\b/i.test(p)) {
      const spoken = new Set(t.clips.flatMap((c) => (c.words ?? []).map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ""))));
      const found = FILLER_WORDS.filter((f) => spoken.has(f));
      for (const f of found) ops.push({ op: "remove_phrase", text: f });
      if (!found.length) notes.push("No filler words found in the edit.");
    } else if ((m = p.match(/(?:remove|delete|cut|drop)\s+(?:the\s+)?(\w+)\s+(?:clip|section|part|scene|segment)/i)) || (m = p.match(/(?:remove|delete|cut|drop)\s+(?:clip|section|part|scene|segment)\s+#?(\d+)/i))) {
      const idx = clipIndex(m[1], t.clips.length);
      if (idx != null && idx >= 0 && idx < t.clips.length) ops.push({ op: "remove_clip", index: idx });
      else notes.push(`Couldn't find clip "${m[1]}".`);
    } else if ((m = p.match(/move\s+(?:the\s+)?(\w+)\s+(?:clip|section|scene)\s+to\s+(?:the\s+)?(?:position\s+)?(\w+)/i))) {
      const a = clipIndex(m[1], t.clips.length);
      const b = /start|beginning|front|first/i.test(m[2]) ? 0 : /end|last/i.test(m[2]) ? t.clips.length - 1 : clipIndex(m[2], t.clips.length);
      if (a != null && b != null) ops.push({ op: "move_clip", index: a, to: b });
    } else if ((m = p.match(/(?:shorter|shorten|cut (?:it )?down|trim (?:it )?(?:down)?|under|max(?:imum)?|make it)\D{0,20}(\d+)\s*(?:s\b|sec|seconds)/i))) {
      ops.push({ op: "target_duration", seconds: Number(m[1]) });
    } else if (/\b(no|remove|turn off|disable|hide)\b.*\bcaptions?\b|\bcaptions? off\b/i.test(p)) {
      ops.push({ op: "set_caption_style", style: "off" });
    } else if (/\bkaraoke|word[- ]by[- ]word|animated captions?|highlight/i.test(p)) {
      ops.push({ op: "set_caption_style", style: "karaoke" });
    } else if (/\b(simple|plain|block|subtitle)\b.*\bcaptions?\b/i.test(p)) {
      ops.push({ op: "set_caption_style", style: "block" });
    } else if ((m = p.match(/title\s+(?:to|as|:)?\s*["“']([^"”']+)["”']/i))) {
      ops.push({ op: "set_title", text: m[1] });
    } else if (/\b(no|remove|without)\b.*\btitles?\b/i.test(p)) {
      ops.push({ op: "remove_titles" });
    } else if (/\b(no|remove|without|mute)\b.*\bmusic\b/i.test(p)) {
      ops.push({ op: "remove_music" });
    } else if (/\bmusic\b/i.test(p) && /\b(quieter|lower|softer|down)\b/i.test(p)) {
      ops.push({ op: "set_music_volume", volume: Math.max(0.02, (t.music?.volume ?? 0.1) * 0.5) });
    } else if (/\bmusic\b/i.test(p) && /\b(louder|higher|up)\b/i.test(p)) {
      ops.push({ op: "set_music_volume", volume: Math.min(0.6, (t.music?.volume ?? 0.1) * 1.8) });
    } else if (aspect) {
      ops.push({ op: "set_aspect", aspect });
    } else {
      notes.push(`Not understood without an AI key: "${p}".`);
    }
  }
  const explanation =
    (ops.length ? `Planned ${ops.length} change(s) with the offline rule parser.` : "No changes planned.") +
    (notes.length ? ` ${notes.join(" ")} Add ANTHROPIC_API_KEY for free-form revisions.` : "");
  return { ops, explanation };
}

export function describeTimeline(t: Timeline): string {
  let offset = 0;
  const lines = t.clips.map((c, i) => {
    const d = c.out - c.in;
    const text = (c.words ?? [])
      .filter((w) => w.end > c.in && w.start < c.out)
      .map((w) => w.text.trim())
      .join(" ");
    const line = `#${i} [${offset.toFixed(1)}–${(offset + d).toFixed(1)}s, ${d.toFixed(1)}s, ${c.kind}${c.label ? `, "${c.label}"` : ""}] ${text || "(no speech)"}`;
    offset += d;
    return line;
  });
  return [
    `Title: ${t.title}`,
    `Aspect: ${t.aspect}; captions: ${t.captions.style}; music: ${t.music ? `on (volume ${t.music.volume})` : "off"}; duration ${timelineDuration(t).toFixed(1)}s`,
    `On-screen titles: ${t.titles.map((x) => `"${x.text}" ${x.start.toFixed(1)}–${x.end.toFixed(1)}s`).join("; ") || "none"}`,
    `Caption replacements: ${t.captions.replacements.map((r) => `"${r.find}"→"${r.replace}"`).join(", ") || "none"}`,
    "Clips:",
    ...lines,
  ].join("\n");
}
