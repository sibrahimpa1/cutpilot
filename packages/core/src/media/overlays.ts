import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { ASPECT_SIZE, clipDuration, clipStarts, type CaptionStyle, type Timeline, type Title, type Word } from "../types";

/* ------------------------------------------------------------------ */
/* 1. Words on the output clock                                        */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Map every clip's source-time words onto the final timeline clock, then apply caption replacements. */
export function timelineWords(t: Timeline): Word[] {
  const out: Word[] = [];
  const starts = clipStarts(t);
  t.clips.forEach((c, ci) => {
    const offset = starts[ci];
    for (const w of c.words ?? []) {
      if (w.end <= c.in || w.start >= c.out) continue;
      const start = offset + Math.max(0, w.start - c.in);
      const end = offset + Math.min(clipDuration(c), w.end - c.in);
      if (end - start < 0.02) continue;
      out.push({ text: w.text.trim(), start, end });
    }
  });
  return applyReplacements(out.filter((w) => w.text), t.captions.replacements);
}

export function applyReplacements(words: Word[], reps: { find: string; replace: string }[]): Word[] {
  let tokens = words.slice();
  for (const r of reps) {
    const find = r.find.trim().split(/\s+/).map(norm).filter(Boolean);
    if (!find.length) continue;
    const next: Word[] = [];
    for (let i = 0; i < tokens.length; ) {
      const slice = tokens.slice(i, i + find.length);
      if (slice.length === find.length && slice.every((w, k) => norm(w.text) === find[k])) {
        const trailing = /[.,!?;:]+$/.exec(slice[slice.length - 1].text)?.[0] ?? "";
        const replacement = r.replace.trim();
        if (replacement) {
          next.push({ text: replacement + trailing, start: slice[0].start, end: slice[slice.length - 1].end });
        }
        i += find.length;
      } else {
        next.push(tokens[i]);
        i++;
      }
    }
    tokens = next;
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 2. Caption chunks ("pages" of 1–2 lines)                           */
/* ------------------------------------------------------------------ */

export type Chunk = { words: Word[]; start: number; end: number };

export function chunkWords(words: Word[], style: CaptionStyle): Chunk[] {
  if (style === "off" || !words.length) return [];
  const maxWords = style === "karaoke" ? 4 : 7;
  const chunks: Chunk[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) chunks.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || cur.length >= maxWords)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  // Hold each chunk until the next one starts when the gap is short, so captions don't flicker.
  for (let i = 0; i < chunks.length - 1; i++) {
    const gap = chunks[i + 1].start - chunks[i].end;
    if (gap > 0 && gap < 0.4) chunks[i].end = chunks[i + 1].start;
  }
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 3. Overlay segments: piecewise-constant states on the timeline     */
/* ------------------------------------------------------------------ */

export type OverlayState = { title: Title | null; chunk: Chunk | null; active: number };
export type OverlaySegment = { start: number; end: number; state: OverlayState; key: string };

export function overlaySegments(t: Timeline, total: number): OverlaySegment[] {
  const chunks = chunkWords(timelineWords(t), t.captions.style);
  const cuts = new Set<number>([0, total]);
  for (const ti of t.titles) [ti.start, ti.end].forEach((x) => cuts.add(x));
  for (const c of chunks) {
    cuts.add(c.start);
    cuts.add(c.end);
    if (t.captions.style === "karaoke") c.words.forEach((w) => (cuts.add(w.start), cuts.add(w.end)));
  }
  const times = [...cuts].filter((x) => x >= 0 && x <= total).sort((a, b) => a - b);
  const segs: OverlaySegment[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i];
    const b = times[i + 1];
    if (b - a < 1 / 60) continue;
    const mid = (a + b) / 2;
    const title = t.titles.find((x) => mid >= x.start && mid < x.end) ?? null;
    const chunk = chunks.find((c) => mid >= c.start && mid < c.end) ?? null;
    let active = -1;
    if (chunk && t.captions.style === "karaoke") {
      active = chunk.words.findIndex((w) => mid >= w.start && mid < w.end);
      if (active < 0) {
        // Between words: keep the last spoken word lit.
        for (let k = chunk.words.length - 1; k >= 0; k--) if (chunk.words[k].end <= mid) { active = k; break; }
      }
    }
    const key = JSON.stringify([title?.text ?? null, title?.position ?? null, chunk ? chunk.words.map((w) => w.text) : null, active]);
    const last = segs[segs.length - 1];
    if (last && last.key === key) last.end = b;
    else segs.push({ start: a, end: b, state: { title, chunk, active }, key });
  }
  return segs;
}

/* ------------------------------------------------------------------ */
/* 4. SVG                                                              */
/* ------------------------------------------------------------------ */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap using an average glyph width estimate (bold sans ≈ 0.58em). */
export function wrap(words: string[], fontSize: number, maxWidth: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let width = 0;
  const space = fontSize * 0.3;
  words.forEach((w, i) => {
    const ww = w.length * fontSize * 0.58;
    if (line.length && width + space + ww > maxWidth) {
      lines.push(line);
      line = [];
      width = 0;
    }
    width += (line.length ? space : 0) + ww;
    line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

export function overlaySvg(state: OverlayState, t: Pick<Timeline, "aspect" | "captions">): string {
  const { width: W, height: H } = ASPECT_SIZE[t.aspect];
  const font = config.captionFont;
  const portrait = H > W;
  const parts: string[] = [];

  if (state.title) {
    const fs = portrait ? 66 : 62;
    const words = state.title.text.split(/\s+/).filter(Boolean);
    const lines = wrap(words, fs, W * 0.8);
    const lh = fs * 1.2;
    const boxH = lines.length * lh + fs * 0.8;
    const boxW = Math.min(W * 0.88, Math.max(...lines.map((l) => l.map((i) => words[i]).join(" ").length)) * fs * 0.58 + fs * 1.4);
    const top = state.title.position === "center" ? (H - boxH) / 2 : portrait ? H * 0.12 : H * 0.08;
    parts.push(`<rect x="${(W - boxW) / 2}" y="${top}" width="${boxW}" height="${boxH}" rx="${fs * 0.45}" fill="#0B0F1A" fill-opacity="0.78"/>`);
    lines.forEach((l, li) => {
      const y = top + fs * 0.4 + lh * li + fs * 0.95;
      parts.push(
        `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${esc(font)}" font-weight="800" font-size="${fs}" fill="#FFFFFF">${esc(l.map((i) => words[i]).join(" "))}</text>`,
      );
    });
  }

  if (state.chunk && t.captions.style !== "off") {
    const karaoke = t.captions.style === "karaoke";
    const fs = portrait ? 78 : t.aspect === "1:1" ? 64 : 60;
    const words = state.chunk.words.map((w) => (karaoke ? w.text.toUpperCase() : w.text));
    const lines = wrap(words, fs, W * 0.84);
    const lh = fs * 1.22;
    const blockH = lines.length * lh;
    const bottom = portrait ? H * 0.8 : H * 0.9;
    const top = bottom - blockH;
    if (!karaoke) {
      const maxChars = Math.max(...lines.map((l) => l.map((i) => words[i]).join(" ").length));
      const boxW = Math.min(W * 0.92, maxChars * fs * 0.56 + fs * 1.2);
      parts.push(`<rect x="${(W - boxW) / 2}" y="${top - fs * 0.35}" width="${boxW}" height="${blockH + fs * 0.6}" rx="${fs * 0.3}" fill="#000000" fill-opacity="0.6"/>`);
    }
    lines.forEach((l, li) => {
      const y = top + lh * li + fs * 0.9;
      const spans = l
        .map((i) => {
          const on = karaoke && i === state.active;
          const fill = on ? "#FFD84D" : "#FFFFFF";
          const size = on ? fs * 1.1 : fs;
          return `<tspan fill="${fill}" font-size="${size.toFixed(1)}">${esc(words[i])}</tspan>`;
        })
        .join(" ");
      const stroke = karaoke ? `stroke="#000000" stroke-width="${(fs * 0.14).toFixed(1)}" stroke-linejoin="round" paint-order="stroke"` : "";
      parts.push(
        `<text x="${W / 2}" y="${y}" text-anchor="middle" xml:space="preserve" font-family="${esc(font)}" font-weight="900" font-size="${fs}" ${stroke}>${spans}</text>`,
      );
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

export function svgToPng(svg: string): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { loadSystemFonts: true, defaultFontFamily: config.captionFont },
    background: "rgba(0,0,0,0)",
  });
  return r.render().asPng();
}

/**
 * Render the overlay track as PNG stills plus an ffconcat list. FFmpeg plays the list
 * as one transparent video stream that is overlaid on the edit in a single pass.
 */
export function writeOverlayTrack(t: Timeline, total: number, dir: string): { listPath: string; count: number } | null {
  const segs = overlaySegments(t, total);
  if (!segs.some((s) => s.state.title || s.state.chunk)) return null;
  const cache = new Map<string, string>();
  const lines = ["ffconcat version 1.0"];
  let n = 0;
  for (const s of segs) {
    let file = cache.get(s.key);
    if (!file) {
      file = `ov_${String(n++).padStart(4, "0")}.png`;
      writeFileSync(path.join(dir, file), svgToPng(overlaySvg(s.state, t)));
      cache.set(s.key, file);
    }
    lines.push(`file '${file}'`, `duration ${(s.end - s.start).toFixed(4)}`);
  }
  // ffconcat ignores the last duration unless the final file is repeated.
  lines.push(`file '${cache.get(segs[segs.length - 1].key)}'`);
  const listPath = path.join(dir, "overlays.ffconcat");
  writeFileSync(listPath, lines.join("\n") + "\n");
  return { listPath, count: n };
}
