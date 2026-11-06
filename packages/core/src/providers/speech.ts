import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config";
import { extractAudio, ffmpeg, probe, run, toWav } from "../media/ffmpeg";
import type { Word } from "../types";

export function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

/* ------------------------------------------------------------------ */
/* Text to speech                                                      */
/* ------------------------------------------------------------------ */

export interface TTSProvider {
  id: string;
  /** Writes a 48 kHz stereo WAV and returns its duration. */
  synth(text: string, outWav: string, signal?: AbortSignal): Promise<{ path: string; duration: number }>;
}

async function finish(tmp: string, outWav: string, signal?: AbortSignal) {
  await toWav(tmp, outWav, signal);
  return { path: outWav, duration: (await probe(outWav)).duration };
}

export const macSay: TTSProvider = {
  id: "macOS say",
  async synth(text, outWav, signal) {
    const tmp = outWav.replace(/\.wav$/, ".aiff");
    await run("say", ["-v", config.sayVoice, "-r", "185", "-o", tmp, text], { signal });
    return finish(tmp, outWav, signal);
  },
};

export const espeak: TTSProvider = {
  id: "espeak-ng",
  async synth(text, outWav, signal) {
    const tmp = outWav.replace(/\.wav$/, ".raw.wav");
    await run("espeak-ng", ["-s", "165", "-w", tmp, text], { signal });
    return finish(tmp, outWav, signal);
  },
};

/** Last resort so the pipeline never blocks: silence sized to the text. */
export const silentTTS: TTSProvider = {
  id: "silent (no TTS available)",
  async synth(text, outWav, signal) {
    const seconds = Math.max(1.5, text.split(/\s+/).length / 2.6);
    await ffmpeg(["-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo", "-c:a", "pcm_s16le", outWav], { signal });
    return { path: outWav, duration: seconds };
  },
};

export function openaiTTS(apiKey: string): TTSProvider {
  return {
    id: "OpenAI gpt-4o-mini-tts",
    async synth(text, outWav, signal) {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE ?? "alloy", input: text, response_format: "wav" }),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const tmp = outWav.replace(/\.wav$/, ".openai.wav");
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      return finish(tmp, outWav, signal);
    },
  };
}

export function elevenlabsTTS(apiKey: string, voiceId: string): TTSProvider {
  return {
    id: "ElevenLabs",
    async synth(text, outWav, signal) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2" }),
        signal,
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const tmp = outWav.replace(/\.wav$/, ".mp3");
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      return finish(tmp, outWav, signal);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Speech to text (word timestamps)                                    */
/* ------------------------------------------------------------------ */

export interface STTProvider {
  id: string;
  transcribe(mediaPath: string, workDir: string, signal?: AbortSignal): Promise<Word[]>;
}

/** Parse whisper.cpp `-oj` output produced with `-ml 1 -sow` (one word per segment). */
export function parseWhisperCppJson(j: any): Word[] {
  const words: Word[] = [];
  for (const seg of j.transcription ?? []) {
    const text = String(seg.text ?? "").trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue; // [BLANK_AUDIO], (music)
    const start = (seg.offsets?.from ?? 0) / 1000;
    const end = (seg.offsets?.to ?? 0) / 1000;
    // whisper.cpp occasionally emits punctuation as its own token: glue it to the previous word.
    if (/^[.,!?;:%]+$/.test(text) && words.length) {
      words[words.length - 1].text += text;
      continue;
    }
    words.push({ text, start, end: Math.max(end, start + 0.05) });
  }
  return words;
}

export const whisperCpp: STTProvider = {
  id: "whisper.cpp (local)",
  async transcribe(mediaPath, workDir, signal) {
    const wav = path.join(workDir, `stt_${path.basename(mediaPath)}.16k.wav`);
    await extractAudio(mediaPath, wav, { signal });
    const outBase = wav.replace(/\.wav$/, "");
    await run(config.whisperBin, ["-m", config.whisperModel, "-f", wav, "-ml", "1", "-sow", "-oj", "-of", outBase, "-np", "-t", "4"], { signal });
    return parseWhisperCppJson(JSON.parse(readFileSync(`${outBase}.json`, "utf8")));
  },
};

export function openaiSTT(apiKey: string): STTProvider {
  return {
    id: "OpenAI whisper-1",
    async transcribe(mediaPath, workDir, signal) {
      const mp3 = path.join(workDir, `stt_${path.basename(mediaPath)}.mp3`);
      await ffmpeg(["-i", mediaPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { signal });
      const form = new FormData();
      form.append("file", new Blob([readFileSync(mp3)], { type: "audio/mpeg" }), "audio.mp3");
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j: any = await res.json();
      // Word tokens carry no punctuation; restore it from the full text so sentence splitting works.
      const words: Word[] = (j.words ?? []).map((w: any) => ({ text: String(w.word), start: w.start, end: w.end }));
      return restorePunctuation(words, String(j.text ?? ""));
    },
  };
}

export function restorePunctuation(words: Word[], text: string): Word[] {
  const toks = text.split(/\s+/).filter(Boolean);
  let k = 0;
  return words.map((w) => {
    const bare = w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    for (let j = k; j < Math.min(toks.length, k + 4); j++) {
      if (toks[j].toLowerCase().replace(/[^\p{L}\p{N}']/gu, "") === bare) {
        k = j + 1;
        return { ...w, text: toks[j] };
      }
    }
    return w;
  });
}

/** No STT available: captions and moment picking fall back to time-based behaviour. */
export const noSTT: STTProvider = {
  id: "none",
  async transcribe() {
    return [];
  },
};

/** Spread words evenly over a known duration (used when no STT can align a voiceover). */
export function evenWordTimings(text: string, duration: number): Word[] {
  const toks = text.split(/\s+/).filter(Boolean);
  const weights = toks.map((t) => Math.max(2, t.length) + (/[,.!?]$/.test(t) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0.05;
  const span = Math.max(0.1, duration - 0.15);
  return toks.map((text, i) => {
    const d = (weights[i] / total) * span;
    const w = { text, start: t, end: t + d * 0.92 };
    t += d;
    return w;
  });
}
