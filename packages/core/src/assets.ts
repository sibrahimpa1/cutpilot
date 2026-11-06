import { copyFileSync, createWriteStream, renameSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { projectDir } from "./config";
import { addAsset, logEvent, type Asset } from "./db";
import { probe } from "./media/ffmpeg";

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const IMAGE = /\.(png|jpe?g|webp)$/i;

export function safeName(name: string) {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return base || "upload";
}

async function register(projectId: string, file: string, name: string): Promise<Asset> {
  const kind = VIDEO.test(name) ? "video" : AUDIO.test(name) ? "audio" : IMAGE.test(name) ? "image" : null;
  if (!kind) throw new Error(`Unsupported file type: ${name}`);
  const p = await probe(file);
  if (kind === "video" && !p.hasVideo) throw new Error(`${name} has no video stream`);
  const a = addAsset({
    projectId,
    kind,
    name,
    path: file,
    duration: p.duration || null,
    width: p.width,
    height: p.height,
    hasAudio: p.hasAudio,
  });
  logEvent({
    projectId,
    actor: "user",
    tool: "Upload",
    action: `Added ${kind}`,
    detail: `${name} (${(statSync(file).size / 1e6).toFixed(1)} MB${p.duration ? `, ${p.duration.toFixed(1)}s` : ""}${p.width ? `, ${p.width}×${p.height}` : ""})`,
    durationMs: null,
  });
  return a;
}

/** Stream an upload straight to disk (no buffering of large videos in memory). */
export async function importStream(projectId: string, name: string, body: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Promise<Asset> {
  const clean = safeName(name);
  const dir = projectDir(projectId, "assets");
  const tmp = path.join(dir, `.${randomUUID()}.part`);
  const dest = path.join(dir, `${Date.now().toString(36)}_${clean}`);
  const src = "getReader" in (body as any) ? Readable.fromWeb(body as any) : (body as NodeJS.ReadableStream);
  await pipeline(src, createWriteStream(tmp));
  renameSync(tmp, dest);
  return register(projectId, dest, clean);
}

export async function importFile(projectId: string, srcPath: string): Promise<Asset> {
  const clean = safeName(srcPath);
  const dest = path.join(projectDir(projectId, "assets"), `${Date.now().toString(36)}_${clean}`);
  copyFileSync(srcPath, dest);
  return register(projectId, dest, clean);
}
