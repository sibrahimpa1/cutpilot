import { clipDuration, timelineDuration, type Clip, type RevisionOp, type Timeline } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const MIN_CLIP = 0.3;

export type ApplyResult = { timeline: Timeline; notes: string[]; needsReframe: boolean };

function cloneTimeline(t: Timeline): Timeline {
  return JSON.parse(JSON.stringify(t));
}

function wordsIn(c: Clip, start: number, end: number) {
  return (c.words ?? []).filter((w) => w.end > start && w.start < end);
}

/** Cut [a, b] (source time) out of a clip: returns 0, 1 or 2 clips. */
export function cutRange(c: Clip, a: number, b: number): Clip[] {
  const out: Clip[] = [];
  if (a - c.in >= MIN_CLIP) out.push({ ...c, id: `${c.id}a`, out: a, words: wordsIn(c, c.in, a), crop: c.crop });
  if (c.out - b >= MIN_CLIP) {
    // Shift crop keyframes so the second half keeps tracking from the right point.
    const shift = b - c.in;
    const crop = c.crop?.map((k) => ({ ...k, t: k.t - shift })).filter((k) => k.t >= -1);
    out.push({ ...c, id: `${c.id}b`, in: b, words: wordsIn(c, b, c.out), crop: crop?.length ? crop : c.crop });
  }
  return out;
}

/** Find every occurrence of a spoken phrase. Returns [clipIndex, start, end] in source time. */
export function findPhrase(t: Timeline, phrase: string): { clip: number; start: number; end: number }[] {
  const target = phrase.split(/\s+/).map(norm).filter(Boolean);
  const hits: { clip: number; start: number; end: number }[] = [];
  if (!target.length) return hits;
  t.clips.forEach((c, ci) => {
    const ws = wordsIn(c, c.in, c.out);
    for (let i = 0; i + target.length <= ws.length; i++) {
      if (target.every((tok, k) => norm(ws[i + k].text) === tok)) {
        hits.push({ clip: ci, start: ws[i].start, end: ws[i + target.length - 1].end });
      }
    }
  });
  return hits;
}

/** Apply revision operations to a timeline. Pure: the same ops always give the same edit. */
export function applyOps(input: Timeline, ops: RevisionOp[]): ApplyResult {
  const t = cloneTimeline(input);
  const notes: string[] = [];
  let needsReframe = false;
  const valid = (i: number, what: string) => {
    if (i >= 0 && i < t.clips.length) return true;
    notes.push(`${what}: clip #${i} doesn't exist (the edit has ${t.clips.length} clips).`);
    return false;
  };

  for (const op of ops) {
    switch (op.op) {
      case "remove_clip":
        if (!valid(op.index, "remove_clip")) break;
        if (t.clips.length === 1) {
          notes.push("Kept the last remaining clip; an edit needs at least one.");
          break;
        }
        t.clips.splice(op.index, 1);
        break;
      case "move_clip": {
        if (!valid(op.index, "move_clip")) break;
        const [c] = t.clips.splice(op.index, 1);
        t.clips.splice(Math.min(Math.max(0, op.to), t.clips.length), 0, c);
        break;
      }
      case "trim_clip": {
        if (!valid(op.index, "trim_clip")) break;
        const c = t.clips[op.index];
        const nin = c.in + op.head;
        const nout = c.out - op.tail;
        if (nout - nin < MIN_CLIP) {
          notes.push(`trim_clip: trimming #${op.index} would leave less than ${MIN_CLIP}s; skipped.`);
          break;
        }
        if (c.crop) c.crop = c.crop.map((k) => ({ ...k, t: k.t - op.head })).filter((k, i, a) => k.t >= 0 || i === a.length - 1 || a[i + 1].t > 0);
        c.in = nin;
        c.out = nout;
        c.words = wordsIn(c, nin, nout);
        break;
      }
      case "remove_phrase": {
        const hits = findPhrase(t, op.text);
        if (!hits.length) {
          notes.push(`remove_phrase: "${op.text}" isn't spoken in the current edit.`);
          break;
        }
        // Work back to front so indexes stay valid.
        for (const h of hits.sort((a, b) => b.clip - a.clip || b.start - a.start)) {
          const c = t.clips[h.clip];
          const pieces = cutRange(c, Math.max(c.in, h.start - 0.04), Math.min(c.out, h.end + 0.06));
          t.clips.splice(h.clip, 1, ...pieces);
        }
        if (!t.clips.length) {
          notes.push("remove_phrase removed everything; restored the original edit.");
          return { timeline: cloneTimeline(input), notes, needsReframe: false };
        }
        break;
      }
      case "set_aspect":
        if (t.aspect !== op.aspect) {
          t.aspect = op.aspect;
          t.clips.forEach((c) => delete c.crop);
          needsReframe = true;
        }
        break;
      case "replace_caption_text":
        t.captions.replacements = [...t.captions.replacements.filter((r) => norm(r.find) !== norm(op.find)), { find: op.find, replace: op.replace }];
        break;
      case "set_caption_style":
        t.captions.style = op.style;
        break;
      case "set_title":
        if (t.titles.length) t.titles[0].text = op.text;
        else t.titles.push({ text: op.text, start: 0, end: Math.min(3, timelineDuration(t)), position: "top" });
        t.title = op.text;
        break;
      case "remove_titles":
        t.titles = [];
        break;
      case "set_music_volume":
        if (t.music) t.music.volume = op.volume;
        else notes.push("set_music_volume: this edit has no music.");
        break;
      case "remove_music":
        t.music = null;
        break;
      case "target_duration": {
        const target = op.seconds;
        // 1) Drop whole clips from the end while that still leaves at least ~90% of the target.
        while (t.clips.length > 1 && timelineDuration(t) - clipDuration(t.clips[t.clips.length - 1]) >= target * 0.9 && timelineDuration(t) > target * 1.05) {
          t.clips.pop();
        }
        // 2) Then shave tails proportionally, snapping to the end of a spoken word.
        let over = timelineDuration(t) - target;
        if (over > 0.2) {
          const total = timelineDuration(t);
          for (const c of t.clips) {
            const cut = (clipDuration(c) / total) * over;
            let nout = c.out - cut;
            const lastWord = [...(c.words ?? [])].reverse().find((w) => w.end <= nout && w.end > c.in);
            if (lastWord && nout - lastWord.end < 1.5) nout = lastWord.end + 0.1;
            if (nout - c.in >= MIN_CLIP) {
              c.out = Math.min(c.out, nout);
              c.words = wordsIn(c, c.in, c.out);
            }
          }
        }
        over = timelineDuration(t) - target;
        if (over > target * 0.1) notes.push(`target_duration: got to ${timelineDuration(t).toFixed(1)}s (asked for ${target}s).`);
        break;
      }
    }
  }
  // Keep titles inside the new running time.
  const total = timelineDuration(t);
  t.titles = t.titles.filter((x) => x.start < total).map((x) => ({ ...x, end: Math.min(x.end, total) }));
  return { timeline: t, notes, needsReframe };
}

export function describeOp(op: RevisionOp): string {
  switch (op.op) {
    case "remove_clip":
      return `Removed clip #${op.index + 1}`;
    case "move_clip":
      return `Moved clip #${op.index + 1} to position ${op.to + 1}`;
    case "trim_clip":
      return `Trimmed clip #${op.index + 1} (${op.head}s head, ${op.tail}s tail)`;
    case "remove_phrase":
      return `Cut the moment where "${op.text}" is said`;
    case "set_aspect":
      return `Reformatted to ${op.aspect}`;
    case "replace_caption_text":
      return `Caption fix: "${op.find}" → "${op.replace}"`;
    case "set_caption_style":
      return `Captions: ${op.style}`;
    case "set_title":
      return `Title: "${op.text}"`;
    case "remove_titles":
      return "Removed on-screen titles";
    case "set_music_volume":
      return `Music volume ${Math.round(op.volume * 100)}%`;
    case "remove_music":
      return "Removed music";
    case "target_duration":
      return `Shortened to ~${op.seconds}s`;
  }
}
