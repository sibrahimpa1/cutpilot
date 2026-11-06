import { writeFileSync } from "node:fs";
import { ffmpeg } from "./ffmpeg";
import { svgToPng } from "./overlays";

/* ------------------------------------------------------------------ */
/* Music bed: a soft four-chord pad synthesised by FFmpeg. Royalty     */
/* free by construction, so there are no licensing questions.          */
/* ------------------------------------------------------------------ */

const PROGRESSIONS: number[][][] = [
  // I – V – vi – IV in C, voiced low
  [[130.81, 164.81, 196.0], [98.0, 123.47, 146.83], [110.0, 130.81, 164.81], [87.31, 110.0, 130.81]],
  // i – VI – III – VII in A minor
  [[110.0, 130.81, 164.81], [87.31, 110.0, 130.81], [130.81, 164.81, 196.0], [98.0, 123.47, 146.83]],
];

export function musicExpression(seed = 0, chordSeconds = 4): string {
  const prog = PROGRESSIONS[Math.abs(seed) % PROGRESSIONS.length];
  const loop = chordSeconds * prog.length;
  const pick = (voice: number) => {
    let e = String(prog[prog.length - 1][voice]);
    for (let i = prog.length - 2; i >= 0; i--) e = `if(lt(mod(t,${loop}),${(i + 1) * chordSeconds}),${prog[i][voice]},${e})`;
    return e;
  };
  // Envelope reaches zero at every chord change, which hides the phase jump.
  const env = `(0.5-0.5*cos(2*PI*mod(t,${chordSeconds})/${chordSeconds}))`;
  const voices = [0, 1, 2].map((v) => `sin(2*PI*${pick(v)}*t)+0.35*sin(4*PI*${pick(v)}*t)`).join("+");
  const sub = `0.6*sin(PI*${pick(0)}*t)`;
  return `0.11*${env}*(${voices}+${sub})`;
}

export async function generateMusicBed(out: string, seconds = 32, seed = 0, signal?: AbortSignal) {
  const expr = musicExpression(seed);
  await ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${expr}':s=48000:d=${seconds}`,
      "-af",
      "lowpass=f=1800,aecho=0.8:0.7:120|240:0.35|0.2,volume=1.4,aformat=channel_layouts=stereo",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    { signal },
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Placeholder scene art (used when no image or stock provider key).  */
/* ------------------------------------------------------------------ */

const PALETTES = [
  ["#1E1B4B", "#7C3AED", "#F472B6"],
  ["#0F172A", "#0EA5E9", "#22D3EE"],
  ["#1C1917", "#EA580C", "#FACC15"],
  ["#052E16", "#16A34A", "#A3E635"],
  ["#172554", "#2563EB", "#F59E0B"],
  ["#3B0764", "#C026D3", "#38BDF8"],
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const STOP = new Set("a an the of and or to in on with for at by from into over under is are be this that your you their our its as".split(" "));

export function keyword(prompt: string): string {
  const words = prompt.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
  return (words.sort((a, b) => b.length - a.length)[0] ?? "scene").toUpperCase();
}

export function sceneCardSvg(prompt: string, index: number, width: number, height: number): string {
  const h = hash(prompt + index);
  const [bg, c1, c2] = PALETTES[h % PALETTES.length];
  const rnd = (k: number) => ((h >>> (k * 3)) % 1000) / 1000;
  const blobs = [0, 1, 2, 3]
    .map((k) => {
      const cx = (0.15 + 0.7 * rnd(k)) * width;
      const cy = (0.15 + 0.7 * rnd(k + 4)) * height;
      const r = (0.25 + 0.25 * rnd(k + 2)) * Math.min(width, height);
      return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${k % 2 ? c1 : c2}" fill-opacity="0.75"/>`;
    })
    .join("");
  const word = keyword(prompt);
  const fs = Math.min((width * 0.86) / Math.max(4, word.length * 0.8), height * 0.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${c1}" stop-opacity="0.55"/></linearGradient>
    <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(Math.min(width, height) * 0.09).toFixed(0)}"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="${bg}"/>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <g filter="url(#b)">${blobs}</g>
  <text x="50%" y="${(height * 0.5 + fs * 0.35).toFixed(0)}" text-anchor="middle" font-family="Arial" font-weight="900" font-size="${fs.toFixed(0)}" fill="#FFFFFF" fill-opacity="0.16" letter-spacing="${(fs * 0.04).toFixed(1)}">${word.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>
</svg>`;
}

export function writeSceneCard(out: string, prompt: string, index: number, width: number, height: number) {
  writeFileSync(out, svgToPng(sceneCardSvg(prompt, index, width, height)));
  return out;
}
