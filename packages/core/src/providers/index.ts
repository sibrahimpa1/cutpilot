import { existsSync } from "node:fs";
import { config } from "../config";
import { anthropicTransport, ClaudeLLM, heuristicLLM, openrouterTransport, type LLMProvider } from "./llm";
import { commandExists, elevenlabsTTS, espeak, macSay, noSTT, openaiSTT, openaiTTS, silentTTS, whisperCpp, type STTProvider, type TTSProvider } from "./speech";
import { openaiVisuals, pexelsVisuals, placeholderVisuals, type VisualsProvider } from "./visuals";

export type ProviderStatus = {
  kind: "LLM" | "TTS" | "STT" | "VISUALS";
  active: string;
  options: { id: string; available: boolean; needs?: string }[];
};

type Candidate<T> = { id: string; available: () => boolean; make: () => T; needs?: string };

function choose<T extends { id: string }>(kind: ProviderStatus["kind"], cands: Candidate<T>[]): { provider: T; status: ProviderStatus } {
  const forced = config.pick(kind)?.toLowerCase();
  const pick =
    (forced && cands.find((c) => c.id.toLowerCase().startsWith(forced) && c.available())) || cands.find((c) => c.available()) || cands[cands.length - 1];
  const provider = pick.make();
  return {
    provider,
    status: {
      kind,
      active: provider.id,
      options: cands.map((c) => ({ id: c.id, available: c.available(), needs: c.needs })),
    },
  };
}

export function resolveProviders() {
  const llm = choose<LLMProvider>("LLM", [
    {
      id: "claude",
      available: () => !!config.anthropicKey,
      make: () => new ClaudeLLM(`claude (${config.anthropicModel})`, anthropicTransport(config.anthropicKey!)),
      needs: "ANTHROPIC_API_KEY",
    },
    {
      id: "openrouter",
      available: () => !!config.openrouterKey,
      make: () => new ClaudeLLM(`OpenRouter (${config.openrouterModel})`, openrouterTransport(config.openrouterKey!)),
      needs: "OPENROUTER_API_KEY",
    },
    { id: "heuristic", available: () => true, make: () => heuristicLLM },
  ]);
  const tts = choose<TTSProvider>("TTS", [
    { id: "elevenlabs", available: () => !!config.elevenlabsKey, make: () => elevenlabsTTS(config.elevenlabsKey!, config.elevenlabsVoice), needs: "ELEVENLABS_API_KEY" },
    { id: "openai", available: () => !!config.openaiKey, make: () => openaiTTS(config.openaiKey!), needs: "OPENAI_API_KEY" },
    { id: "say", available: () => process.platform === "darwin" && commandExists("say"), make: () => macSay, needs: "macOS" },
    { id: "espeak-ng", available: () => commandExists("espeak-ng"), make: () => espeak, needs: "espeak-ng installed" },
    { id: "silent", available: () => true, make: () => silentTTS },
  ]);
  const stt = choose<STTProvider>("STT", [
    {
      id: "whisper-cpp",
      available: () => commandExists(config.whisperBin) && existsSync(config.whisperModel),
      make: () => whisperCpp,
      needs: "whisper-cli + model (pnpm models:whisper)",
    },
    { id: "openai", available: () => !!config.openaiKey, make: () => openaiSTT(config.openaiKey!), needs: "OPENAI_API_KEY" },
    { id: "none", available: () => true, make: () => noSTT },
  ]);
  const visuals = choose<VisualsProvider>("VISUALS", [
    { id: "pexels", available: () => !!config.pexelsKey, make: () => pexelsVisuals(config.pexelsKey!), needs: "PEXELS_API_KEY (free)" },
    { id: "openai", available: () => !!config.openaiKey, make: () => openaiVisuals(config.openaiKey!), needs: "OPENAI_API_KEY" },
    { id: "placeholder", available: () => true, make: () => placeholderVisuals },
  ]);
  return {
    llm: llm.provider,
    tts: tts.provider,
    stt: stt.provider,
    visuals: visuals.provider,
    status: [llm.status, tts.status, stt.status, visuals.status],
    ffmpeg: commandExists(config.ffmpeg) && commandExists(config.ffprobe),
  };
}

export type Providers = ReturnType<typeof resolveProviders>;
