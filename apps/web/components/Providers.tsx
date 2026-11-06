import { CheckCircle2, Circle, TriangleAlert } from "lucide-react";

export type ProviderInfo = {
  ffmpeg: boolean;
  status: { kind: string; active: string; options: { id: string; available: boolean; needs?: string }[] }[];
};

const KIND_LABEL: Record<string, string> = { LLM: "Planning (LLM)", TTS: "Voiceover", STT: "Transcription", VISUALS: "Visuals" };

export function ProvidersPanel({ info, compact = false }: { info: ProviderInfo | null; compact?: boolean }) {
  if (!info) return <div className="panel h-48 shimmer" />;
  return (
    <div className="panel divide-y divide-ink-700">
      {!info.ffmpeg && (
        <div className="flex gap-2 p-3 text-sm text-amber-200">
          <TriangleAlert className="h-4 w-4 shrink-0" /> FFmpeg isn&apos;t on PATH. Install it to render.
        </div>
      )}
      {info.status.map((s) => (
        <div key={s.kind} className="p-3">
          <div className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">{KIND_LABEL[s.kind] ?? s.kind}</div>
          <div className="mt-0.5 text-sm font-medium">{s.active}</div>
          {!compact && (
            <ul className="mt-2 space-y-1">
              {s.options.map((o) => (
                <li key={o.id} className="flex items-center gap-1.5 text-xs text-ink-400">
                  {o.available ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Circle className="h-3.5 w-3.5" />}
                  <span className={o.available ? "text-ink-300" : ""}>{o.id}</span>
                  {!o.available && o.needs && <span className="ml-auto font-mono text-[10px] text-ink-400">{o.needs}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!compact && <div className="p-3 text-xs text-ink-400">Add keys to <code className="font-mono text-ink-300">.env</code> and restart the worker. Everything runs offline without them.</div>}
    </div>
  );
}
