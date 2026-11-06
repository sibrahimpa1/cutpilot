"use client";

import { Download, FastForward, Loader2, RotateCw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GraphNode, NodeRun } from "@cutpilot/core";
import { api, fmtDur, thumbUrl } from "@/lib/client";
import type { Mode, ProjectState } from "@/lib/types";
import { NODE_ICONS } from "./WorkflowCanvas";

type Spec = {
  key: string;
  label: string;
  type: "number" | "select" | "text" | "textarea" | "checkbox" | "range";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
};

const opt = (...xs: string[]) => xs.map((x) => ({ value: x, label: x }));

const SPECS: Record<string, Spec[]> = {
  transcribe: [{ key: "force", label: "Re-transcribe even if cached", type: "checkbox" }],
  select_moments: [
    { key: "targetSeconds", label: "Target length (seconds)", type: "number", min: 5, max: 600 },
    { key: "maxClips", label: "Max clips", type: "number", min: 1, max: 30 },
  ],
  assemble_edit: [
    { key: "aspect", label: "Format", type: "select", options: [{ value: "16:9", label: "16:9 landscape" }, { value: "9:16", label: "9:16 vertical" }, { value: "1:1", label: "1:1 square" }] },
    { key: "captionStyle", label: "Captions", type: "select", options: [{ value: "karaoke", label: "Animated word highlight" }, { value: "block", label: "Subtitle block" }, { value: "off", label: "Off" }] },
    { key: "titleCard", label: "Show the hook as an opening title", type: "checkbox" },
    { key: "padding", label: "Breathing room around each clip (s)", type: "number", min: 0, max: 1, step: 0.05 },
  ],
  reframe: [
    {
      key: "mode",
      label: "Reframing",
      type: "select",
      options: [{ value: "track", label: "Follow the subject" }, { value: "center", label: "Centre crop" }, { value: "off", label: "Off" }],
      hint: "Used when the output format is narrower than the footage (e.g. 16:9 → 9:16).",
    },
  ],
  idea: [
    { key: "prompt", label: "Idea", type: "textarea" },
    { key: "seconds", label: "Length (seconds)", type: "number", min: 8, max: 180 },
    { key: "style", label: "Tone & style", type: "text" },
    { key: "aspect", label: "Format", type: "select", options: [{ value: "9:16", label: "9:16 vertical" }, { value: "16:9", label: "16:9 landscape" }, { value: "1:1", label: "1:1 square" }] },
  ],
  assemble_generated: [
    { key: "captionStyle", label: "Captions", type: "select", options: [{ value: "karaoke", label: "Animated word highlight" }, { value: "block", label: "Subtitle block" }, { value: "off", label: "Off" }] },
    { key: "kenBurns", label: "Slow zoom on stills", type: "checkbox" },
  ],
  music: [
    { key: "source", label: "Music", type: "select", options: opt("generated", "none") },
    { key: "volume", label: "Volume", type: "range", min: 0, max: 0.5, step: 0.01 },
  ],
};

export function Inspector(props: {
  state: ProjectState;
  mode: Mode;
  node: GraphNode;
  run?: NodeRun;
  busy: boolean;
  onRun: (o: { fromNodeId?: string; onlyNodeId?: string }) => void;
  onChanged: () => void;
}) {
  const { node, run, state } = props;
  const Icon = NODE_ICONS[node.type];
  const [values, setValues] = useState<Record<string, any>>(node.params);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectId = state.project.id;

  function set(key: string, v: any) {
    const next = { ...values, [key]: v };
    setValues(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api(`/api/projects/${projectId}`, { method: "PATCH", json: { node: { mode: props.mode, id: node.id, params: { [key]: v } } } }).then(props.onChanged);
    }, 400);
  }

  let specs = SPECS[node.type] ?? [];
  if (node.type === "music") {
    const audio = state.assets.filter((a) => a.kind === "audio");
    specs = specs.map((s) => (s.key === "source" ? { ...s, options: [...opt("generated", "none"), ...audio.map((a) => ({ value: a.id, label: `Upload: ${a.name}` }))] } : s));
  }

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-ink-800 ${props.mode === "edit" ? "text-edit" : "text-gen"}`}>{Icon && <Icon className="h-5 w-5" />}</div>
        <div className="min-w-0">
          <h3 className="font-semibold">{node.label}</h3>
          <p className="text-xs text-ink-400">{state.descriptions[node.type]}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={props.busy} onClick={() => props.onRun({ fromNodeId: node.id })} title="Run this step and everything after it">
          <FastForward className="h-4 w-4" /> Run from here
        </button>
        <button className="btn" disabled={props.busy} onClick={() => props.onRun({ onlyNodeId: node.id })} title="Re-run only this step">
          <RotateCw className="h-4 w-4" /> This step only
        </button>
      </div>

      {run?.status === "error" && <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{run.error}</div>}
      {run?.status === "running" && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> {run.message} ({Math.round(run.progress * 100)}%)
        </div>
      )}

      {node.type === "source" && <SourcePanel {...props} />}
      {node.type === "select_moments" && <BriefField projectId={projectId} brief={state.project.brief} onSaved={props.onChanged} />}

      {specs.length > 0 && (
        <section className="space-y-3">
          <h4 className="label">Settings</h4>
          {specs.map((s) => (
            <Field key={s.key} spec={s} value={values[s.key]} onChange={(v) => set(s.key, v)} />
          ))}
        </section>
      )}

      <section>
        <h4 className="label">Output {run?.finishedAt && run.status === "done" && <span className="normal-case text-ink-400">· {run.message}</span>}</h4>
        {run?.output ? <Output type={node.type} output={run.output} state={state} /> : <div className="text-sm text-ink-400">Run the workflow to see this step&apos;s output.</div>}
      </section>
    </div>
  );
}

function Field({ spec, value, onChange }: { spec: Spec; value: any; onChange: (v: any) => void }) {
  if (spec.type === "checkbox")
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[#8b7bff]" checked={value !== false && value != null ? !!value : false} onChange={(e) => onChange(e.target.checked)} />
        {spec.label}
      </label>
    );
  return (
    <div>
      <label className="label">{spec.label}</label>
      {spec.type === "select" ? (
        <select className="field" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {spec.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : spec.type === "textarea" ? (
        <textarea className="field min-h-28" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : spec.type === "range" ? (
        <div className="flex items-center gap-3">
          <input type="range" className="flex-1 accent-[#8b7bff]" min={spec.min} max={spec.max} step={spec.step} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />
          <span className="w-10 text-right font-mono text-xs">{Math.round((value ?? 0) * 100)}%</span>
        </div>
      ) : (
        <input
          className="field"
          type={spec.type === "number" ? "number" : "text"}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value ?? ""}
          onChange={(e) => onChange(spec.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )}
      {spec.hint && <p className="mt-1 text-xs text-ink-400">{spec.hint}</p>}
    </div>
  );
}

function BriefField({ projectId, brief, onSaved }: { projectId: string; brief: string; onSaved: () => void }) {
  const [v, setV] = useState(brief);
  useEffect(() => setV(brief), [brief]);
  return (
    <div>
      <label className="label">Brief</label>
      <textarea
        className="field min-h-28"
        placeholder="Who is it for, how long, what story should it tell, what must stay in."
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={async () => {
          if (v !== brief) {
            await api(`/api/projects/${projectId}`, { method: "PATCH", json: { brief: v } });
            onSaved();
          }
        }}
      />
      <p className="mt-1 text-xs text-ink-400">Claude reads this with the transcript to choose the moments.</p>
    </div>
  );
}

function SourcePanel({ state, onChanged }: { state: ProjectState; onChanged: () => void }) {
  const [uploads, setUploads] = useState<{ name: string; pct: number; error?: string }[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function upload(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setUploads((u) => [...u, { name: f.name, pct: 0 }]);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/projects/${state.project.id}/assets?name=${encodeURIComponent(f.name)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct: e.loaded / e.total } : x)));
      xhr.onload = () => {
        if (xhr.status >= 300) {
          let msg = xhr.statusText;
          try {
            msg = JSON.parse(xhr.responseText).error;
          } catch {}
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, error: msg } : x)));
        } else {
          setUploads((u) => u.filter((x) => x.name !== f.name));
          onChanged();
        }
      };
      xhr.send(f);
    }
  }

  const videos = state.assets.filter((a) => a.kind !== "image");
  return (
    <section className="space-y-3">
      <h4 className="label">Footage</h4>
      <div
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm transition ${drag ? "border-accent bg-accent/10" : "border-ink-600 hover:border-ink-400"}`}
      >
        <Upload className="h-5 w-5 text-ink-400" />
        <span>Drop video or music files, or click to browse</span>
        <span className="text-xs text-ink-400">MP4, MOV, MKV, WebM · MP3, WAV for music</span>
        <input ref={input} type="file" multiple accept="video/*,audio/*" className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      {uploads.map((u) => (
        <div key={u.name} className="text-xs">
          <div className="flex justify-between">
            <span className="truncate">{u.name}</span>
            <span className={u.error ? "text-red-300" : "text-ink-400"}>{u.error ?? `${Math.round(u.pct * 100)}%`}</span>
          </div>
          <div className="mt-1 h-1 rounded bg-ink-800">
            <div className="h-full rounded bg-accent" style={{ width: `${u.pct * 100}%` }} />
          </div>
        </div>
      ))}
      <ul className="space-y-2">
        {videos.map((a) => (
          <li key={a.id} className="flex gap-3 rounded-xl border border-ink-700 bg-ink-900 p-2">
            {a.kind === "video" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl(a.path, Math.min(2, (a.duration ?? 0) / 3))} alt="" className="h-14 w-24 rounded-lg bg-black object-contain" />
            ) : (
              <div className="flex h-14 w-24 items-center justify-center rounded-lg bg-ink-800 text-xs text-ink-400">audio</div>
            )}
            <div className="min-w-0 text-xs">
              <div className="truncate text-sm font-medium">{a.name}</div>
              <div className="text-ink-400">
                {fmtDur(a.duration)}
                {a.width ? ` · ${a.width}×${a.height}` : ""}
                {a.hasAudio ? " · audio" : " · no audio"}
              </div>
              <div className="text-ink-400">{a.transcript ? `${a.transcript.words} words transcribed` : "Not transcribed yet"}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimelineSummary({ t }: { t: any }) {
  if (!t) return null;
  const total = t.clips.reduce((s: number, c: any) => s + (c.out - c.in), 0);
  return (
    <div className="space-y-2 text-xs">
      <div className="text-ink-300">
        {t.clips.length} clips · {fmtDur(total)} · {t.aspect} · captions {t.captions?.style} {t.music ? `· music ${Math.round(t.music.volume * 100)}%` : ""}
      </div>
      <ol className="space-y-1.5">
        {t.clips.map((c: any, i: number) => (
          <li key={c.id} className="flex gap-2 rounded-lg border border-ink-700 bg-ink-900 p-1.5">
            {c.kind === "video" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl(c.src, c.in + 0.2)} alt="" className="h-10 w-16 shrink-0 rounded bg-black object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/files?path=${encodeURIComponent(c.src)}`} alt="" className="h-10 w-16 shrink-0 rounded bg-black object-cover" />
            )}
            <div className="min-w-0">
              <div className="font-mono text-[10px] text-ink-400">
                #{i + 1} · {fmtDur(c.out - c.in)} {c.crop?.length ? `· tracked (${c.crop.length} keyframes)` : ""}
              </div>
              <div className="line-clamp-2 text-ink-300">{(c.words ?? []).map((w: any) => w.text).join(" ") || c.reason}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Output({ type, output, state }: { type: string; output: any; state: ProjectState }) {
  switch (type) {
    case "source":
      return <div className="text-sm text-ink-300">{output.assets.length} video file(s) in the edit.</div>;
    case "idea":
      return (
        <div className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-xs text-ink-300">
          <p className="text-sm text-ink-100">{output.prompt}</p>
          <p className="mt-2 font-mono text-[10px] text-ink-400">
            {output.seconds}s · {output.aspect} · {output.style}
          </p>
        </div>
      );
    case "transcribe":
      return (
        <div className="space-y-3">
          {output.transcripts.map((t: any) => (
            <div key={t.assetId} className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-xs">
              <div className="mb-1 font-mono text-[10px] text-ink-400">
                {state.assets.find((a) => a.id === t.assetId)?.name} · {t.words.length} words · {t.provider}
              </div>
              <p className="max-h-56 overflow-y-auto leading-relaxed text-ink-300">{t.words.map((w: any) => w.text).join(" ") || "(no speech found)"}</p>
            </div>
          ))}
        </div>
      );
    case "select_moments":
      return (
        <div className="space-y-2 text-xs">
          <div className="rounded-xl border border-accent/30 bg-accent/10 p-3">
            <div className="label !mb-1">Hook</div>
            <div className="text-sm font-semibold">{output.hook}</div>
          </div>
          {output.moments.map((m: any, i: number) => {
            const a = state.assets.find((x) => x.id === m.assetId);
            return (
              <div key={i} className="flex gap-2 rounded-xl border border-ink-700 bg-ink-900 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {a && <img src={thumbUrl(a.path, m.start + 0.3)} alt="" className="h-12 w-20 shrink-0 rounded bg-black object-cover" />}
                <div>
                  <div className="font-mono text-[10px] text-ink-400">
                    #{i + 1} · {m.start.toFixed(1)}–{m.end.toFixed(1)}s
                  </div>
                  <div className="text-ink-300">{m.reason}</div>
                </div>
              </div>
            );
          })}
        </div>
      );
    case "script":
      return (
        <div className="space-y-2 text-xs">
          <div className="text-sm font-semibold">{output.title}</div>
          {output.scenes.map((s: any, i: number) => (
            <div key={i} className="rounded-xl border border-ink-700 bg-ink-900 p-2.5">
              <div className="font-mono text-[10px] text-ink-400">Scene {i + 1}{s.onScreen ? ` · “${s.onScreen}”` : ""}</div>
              <p className="mt-1 text-ink-100">{s.narration}</p>
              <p className="mt-1 text-ink-400 italic">Visual: {s.visual}</p>
            </div>
          ))}
        </div>
      );
    case "voiceover":
      return (
        <div className="space-y-2">
          {output.scenes.map((s: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-14 font-mono text-ink-400">S{i + 1} {fmtDur(s.duration)}</span>
              <audio controls src={s.audioUrl} className="h-8 flex-1" />
            </div>
          ))}
        </div>
      );
    case "visuals":
      return (
        <div className="grid grid-cols-3 gap-2">
          {output.scenes.map((s: any, i: number) =>
            s.kind === "video" ? (
              <video key={i} src={s.pathUrl} muted loop autoPlay playsInline className="aspect-[9/16] w-full rounded-lg bg-black object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={s.pathUrl} alt={`Scene ${i + 1}`} className="aspect-[9/16] w-full rounded-lg bg-black object-cover" />
            ),
          )}
        </div>
      );
    case "align_captions":
      return (
        <div className="space-y-2 text-xs">
          {output.scenes.map((s: any, i: number) => (
            <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-2">
              <div className="font-mono text-[10px] text-ink-400">Scene {i + 1} · {s.method}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.words.map((w: any, k: number) => (
                  <span key={k} className="rounded bg-ink-800 px-1" title={`${w.start.toFixed(2)}–${w.end.toFixed(2)}s`}>
                    {w.text}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case "music":
      return (
        <div className="space-y-3">
          {output.timeline.music ? <audio controls src={output.timeline.music.srcUrl} className="h-8 w-full" /> : <div className="text-sm text-ink-400">No music.</div>}
          <TimelineSummary t={output.timeline} />
        </div>
      );
    case "render":
      return (
        <div className="space-y-2">
          <video controls src={output.pathUrl} poster={output.thumbUrl} className="max-h-96 w-full rounded-xl bg-black" />
          <a className="btn w-full justify-center" href={`${output.pathUrl}&download=1`}>
            <Download className="h-4 w-4" /> Download v{output.version} ({fmtDur(output.duration)})
          </a>
        </div>
      );
    default:
      return output.timeline ? <TimelineSummary t={output.timeline} /> : <pre className="overflow-x-auto text-xs">{JSON.stringify(output, null, 2)}</pre>;
  }
}

