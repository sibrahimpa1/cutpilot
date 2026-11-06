import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./config";
import { ffmpeg } from "./media/ffmpeg";
import { svgToPng } from "./media/overlays";
import { commandExists, espeak, macSay, silentTTS } from "./providers/speech";

/*
 * A ~60 s fictional "founder interview" for trying Edit mode without your own footage:
 * a 1920×1080 talking-head style shot whose subject drifts across the frame (so 9:16
 * reframing has something to track) and a spoken answer with filler words and soundbites.
 */

const ANSWER = `So, um, the question I get most is how we run a fully remote team without drowning in meetings.
Honestly, the first year we got it completely wrong. We had a meeting for everything, and nobody had time to actually build anything.
The biggest mistake was treating chat like a meeting room. Every message felt urgent, so everyone answered everything, all day.
Here's what changed it for us. We write things down first. Every decision starts as a one page doc, and people comment when they have focus time, not when a notification fires.
We kept exactly two meetings a week. A Monday plan, and a Friday demo where you show real work, not slides.
And, you know, I think the surprising part was trust. When you can read how a decision was made, you stop needing to be in the room.
Our output went up, and people actually take their evenings back.
If you lead a remote team, try this for one month. Cut one recurring meeting, and replace it with a written update. You'll see the difference in a week.`;

const W = 1920;
const H = 1080;

function backgroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="g" cx="0.5" cy="0.35" r="0.9"><stop offset="0" stop-color="#3a3f58"/><stop offset="1" stop-color="#14161f"/></radialGradient>
    <filter id="b"><feGaussianBlur stdDeviation="40"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <g filter="url(#b)" opacity="0.55">
    <rect x="120" y="180" width="360" height="520" rx="30" fill="#5b4b3a"/>
    <rect x="1460" y="140" width="300" height="640" rx="30" fill="#2f4a46"/>
    <circle cx="1560" cy="300" r="120" fill="#e0b46c" opacity="0.6"/>
  </g>
  <rect x="0" y="880" width="${W}" height="200" fill="#0e1016" opacity="0.6"/>
</svg>`;
}

function personSvg() {
  // A stylised presenter: head, shoulders, shirt collar, with crisp edges for the tracker to find.
  const w = 520;
  const h = 860;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs>
  <path d="M30 ${h} C30 600 110 520 260 520 C410 520 490 600 490 ${h} Z" fill="url(#s)"/>
  <path d="M200 525 L260 610 L320 525 Z" fill="#f1f5f9"/>
  <rect x="222" y="430" width="76" height="110" rx="30" fill="#e8b68f"/>
  <ellipse cx="260" cy="320" rx="135" ry="160" fill="#f2c39e"/>
  <path d="M116 336 C92 70 428 70 404 336 C398 250 344 214 300 240 C252 206 168 224 116 336 Z" fill="#2b1d16"/>
  <circle cx="212" cy="330" r="13" fill="#2b1d16"/><circle cx="308" cy="330" r="13" fill="#2b1d16"/>
  <path d="M215 405 Q260 430 305 405" stroke="#8a4b3a" stroke-width="10" fill="none" stroke-linecap="round"/>
</svg>`;
}

/** Generate (or reuse) the demo interview. Returns the MP4 path. */
export async function makeDemoFootage(outDir = path.join(dataDir(), "demo")): Promise<string> {
  const out = path.resolve(outDir);
  const file = path.join(out, "founder-interview.mp4");
  if (existsSync(file)) return file;
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "bg.png"), svgToPng(backgroundSvg()));
  writeFileSync(path.join(out, "person.png"), svgToPng(personSvg()));

  const tts = process.platform === "darwin" ? macSay : commandExists("espeak-ng") ? espeak : silentTTS;
  const voice = path.join(out, "answer.wav");
  const { duration } = await tts.synth(ANSWER.replace(/\n/g, " "), voice);

  // Subject drifts left↔right (period ~38 s) and bobs gently, like a presenter who moves around.
  await ffmpeg(
    [
      "-loop", "1", "-framerate", "30", "-i", path.join(out, "bg.png"),
      "-loop", "1", "-framerate", "30", "-i", path.join(out, "person.png"),
      "-i", voice,
      "-filter_complex",
      `[0:v]format=yuv420p[bg];[1:v]format=rgba[p];[bg][p]overlay=x='700+560*sin(2*PI*t/38)':y='${H - 860}+10*sin(2*PI*t/2.7)':shortest=0,` +
        `noise=alls=6:allf=t,format=yuv420p[v]`,
      "-map", "[v]", "-map", "2:a",
      "-t", String(duration + 0.5),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-shortest",
      file,
    ],
  );
  return file;
}

