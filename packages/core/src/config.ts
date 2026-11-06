import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file so every process (web, worker, MCP) agrees on it. */
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function dataDir(): string {
  const dir = path.resolve(env("DATA_DIR") ?? path.join(REPO_ROOT, "data"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDir(projectId: string, ...sub: string[]): string {
  const dir = path.join(dataDir(), "projects", projectId, ...sub);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const config = {
  get anthropicKey() {
    return env("ANTHROPIC_API_KEY");
  },
  get anthropicModel() {
    return env("ANTHROPIC_MODEL") ?? "claude-opus-5-5";
  },
  get openaiKey() {
    return env("OPENAI_API_KEY");
  },
  get elevenlabsKey() {
    return env("ELEVENLABS_API_KEY");
  },
  get elevenlabsVoice() {
    return env("ELEVENLABS_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM";
  },
  get pexelsKey() {
    return env("PEXELS_API_KEY");
  },
  get ffmpeg() {
    return env("FFMPEG_PATH") ?? "ffmpeg";
  },
  get ffprobe() {
    return env("FFPROBE_PATH") ?? "ffprobe";
  },
  get whisperBin() {
    return env("WHISPER_CPP_BIN") ?? "whisper-cli";
  },
  get whisperModel() {
    return env("WHISPER_MODEL") ?? path.join(dataDir(), "models", "ggml-base.en.bin");
  },
  get sayVoice() {
    return env("SAY_VOICE") ?? "Samantha";
  },
  get captionFont() {
    return env("CAPTION_FONT") ?? "Arial";
  },
  /** Force a provider: e.g. TTS_PROVIDER=say, STT_PROVIDER=whisper-cpp, VISUALS_PROVIDER=placeholder, LLM_PROVIDER=heuristic */
  pick(kind: "LLM" | "TTS" | "STT" | "VISUALS"): string | undefined {
    return env(`${kind}_PROVIDER`);
  },
};
