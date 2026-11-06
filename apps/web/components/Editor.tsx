"use client";

import { Bot, ChevronLeft, ChevronRight, Download, Loader2, Play, Send, Type, User, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RevisionOp } from "@cutpilot/core";
import { api, fmtDur, thumbUrl } from "@/lib/client";
import type { ProjectState, RenderView } from "@/lib/types";

const SUGGESTIONS = [
  "Make a vertical 9:16 version",
  "Remove the second clip",
  "Cut it down to 20 seconds",
  "Remove the filler words",
  'Replace "meetings" with "meetings 📅" in the captions',
  "Simple subtitle captions and lower the music",
];

export function Editor({ state, busy, onChanged, onRunWorkflow }: { state: ProjectState; busy: boolean; onChanged: () => void; onRunWorkflow: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(state.renders[0]?.id ?? null);
  const latestId = state.renders[0]?.id;
  const prevLatest = useRef(latestId);
  useEffect(() => {
    if (latestId !== prevLatest.current) {
      setSelectedId(latestId ?? null);
      prevLatest.current = latestId;
    }
  }, [latestId]);

  const render = state.renders.find((r) => r.id === selectedId) ?? state.renders[0];
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function ops(o: RevisionOp[]) {
    setError(null);
    try {
      await api(`/api/projects/${state.project.id}/revise`, { method: "POST", json: { ops: o, baseRenderId: render?.id } });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (!render) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <Wand2 className="h-10 w-10 text-ink-600" />
        <div>
          <div className="font-semibold">No video yet</div>
          <div className="text-sm text-ink-400">Run the workflow once; then revise it here by asking for changes.</div>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={onRunWorkflow}>
          <Play className="h-4 w-4" /> Run workflow
        </button>
      </div>
    );
  }

  const t = render.timeline;
  const portrait = t.aspect === "9:16";
  const starts: number[] = [];
  t.clips.reduce((acc, c) => (starts.push(acc), acc + (c.out - c.in)), 0);

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_380px]">
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="panel flex items-center justify-center bg-black/40 p-3">
          <video
            ref={video}
            key={render.id}
            controls
            src={render.url}
            poster={render.thumbUrl}
            className={`rounded-lg bg-black ${portrait ? "h-[58vh]" : "max-h-[58vh] w-full"}`}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {state.renders
              .slice()
              .reverse()
              .map((r) => (
                <button
                  key={r.id}
                  title={r.label}
                  onClick={() => setSelectedId(r.id)}
                  className={`rounded-lg border px-2 py-1 font-mono text-xs ${r.id === render.id ? "border-accent bg-accent/15 text-accent" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
                >
                  v{r.version} <span className="opacity-70">{r.timeline.aspect}</span>
                </button>
              ))}
          </div>
          <a className="btn ml-auto" href={`${render.url}&download=1`}>
            <Download className="h-4 w-4" /> MP4 · {fmtDur(render.duration)} · {render.width}×{render.height} · {((render.sizeBytes ?? 0) / 1e6).toFixed(1)} MB
          </a>
        </div>
        <p className="mt-2 text-xs text-ink-400">
          v{render.version}: {render.label}
        </p>

        <QuickControls render={render} busy={busy} onOps={ops} />
        {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}

        <h4 className="label mt-6">Timeline · {t.clips.length} clips</h4>
        <div className="flex gap-1.5 overflow-x-auto pb-2">
          {t.clips.map((c, i) => (
            <div
              key={c.id}
              className="group relative shrink-0 cursor-pointer overflow-hidden rounded-xl border border-ink-700 bg-ink-900 hover:border-ink-400"
              style={{ width: Math.max(110, Math.min(260, (c.out - c.in) * 18)) }}
              onClick={() => {
                if (video.current) {
                  video.current.currentTime = starts[i] + 0.05;
                  video.current.play();
                }
              }}
              title={c.reason}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={c.kind === "video" ? thumbUrl(c.src, c.in + 0.2) : `/api/files?path=${encodeURIComponent(c.src)}`}
                alt=""
                className="h-16 w-full bg-black object-cover"
              />
              <div className="p-1.5">
                <div className="font-mono text-[10px] text-ink-400">
                  #{i + 1} · {fmtDur(c.out - c.in)}
                  {c.crop?.length ? " · tracked" : ""}
                </div>
                <div className="line-clamp-2 text-[11px] text-ink-300">{(c.words ?? []).map((w) => w.text).join(" ") || c.label}</div>
              </div>
              <div className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
                <IconBtn title="Move left" disabled={busy || i === 0} onClick={() => ops([{ op: "move_clip", index: i, to: i - 1 }])}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn title="Move right" disabled={busy || i === t.clips.length - 1} onClick={() => ops([{ op: "move_clip", index: i, to: i + 1 }])}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn title="Remove clip" disabled={busy || t.clips.length === 1} onClick={() => ops([{ op: "remove_clip", index: i }])}>
                  <X className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
        <CaptionFix busy={busy} onOps={ops} replacements={t.captions.replacements} />
      </div>
      <Chat state={state} render={render} busy={busy} onChanged={onChanged} />
    </div>
  );
}

function IconBtn(p: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={p.title}
      disabled={p.disabled}
      onClick={(e) => {
        e.stopPropagation();
        p.onClick();
      }}
      className="rounded-md bg-black/75 p-1 text-white hover:bg-accent disabled:opacity-30"
    >
      {p.children}
    </button>
  );
}

function QuickControls({ render, busy, onOps }: { render: RenderView; busy: boolean; onOps: (o: RevisionOp[]) => void }) {
  const t = render.timeline;
  const [title, setTitle] = useState(t.titles[0]?.text ?? "");
  useEffect(() => setTitle(t.titles[0]?.text ?? ""), [render.id, t.titles]);
  return (
    <div className="panel mt-4 grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <div>
        <div className="label">Format</div>
        <div className="flex gap-1">
          {(["16:9", "9:16", "1:1"] as const).map((a) => (
            <button key={a} disabled={busy || t.aspect === a} onClick={() => onOps([{ op: "set_aspect", aspect: a }])} className={`btn px-2.5 py-1.5 text-xs ${t.aspect === a ? "!border-accent !text-accent" : ""}`}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="label">Captions</div>
        <select className="field" disabled={busy} value={t.captions.style} onChange={(e) => onOps([{ op: "set_caption_style", style: e.target.value as any }])}>
          <option value="karaoke">Animated highlight</option>
          <option value="block">Subtitle block</option>
          <option value="off">Off</option>
        </select>
      </div>
      <div>
        <div className="label">Music {t.music ? `${Math.round(t.music.volume * 100)}%` : "off"}</div>
        <div className="flex gap-1">
          <button className="btn px-2.5 py-1.5 text-xs" disabled={busy || !t.music} onClick={() => onOps([{ op: "set_music_volume", volume: Math.max(0.02, (t.music?.volume ?? 0.1) * 0.6) }])}>
            Quieter
          </button>
          <button className="btn px-2.5 py-1.5 text-xs" disabled={busy || !t.music} onClick={() => onOps([{ op: "set_music_volume", volume: Math.min(0.6, (t.music?.volume ?? 0.1) * 1.5) }])}>
            Louder
          </button>
          <button className="btn px-2.5 py-1.5 text-xs" disabled={busy || !t.music} onClick={() => onOps([{ op: "remove_music" }])}>
            Off
          </button>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onOps([{ op: "set_title", text: title.trim() }]);
          else onOps([{ op: "remove_titles" }]);
        }}
      >
        <div className="label">Opening title</div>
        <div className="flex gap-1">
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="No title" />
          <button className="btn px-2.5" disabled={busy} title="Apply">
            <Type className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}

function CaptionFix({ busy, onOps, replacements }: { busy: boolean; onOps: (o: RevisionOp[]) => void; replacements: { find: string; replace: string }[] }) {
  const [find, setFind] = useState("");
  const [rep, setRep] = useState("");
  return (
    <div className="panel mt-4 p-4">
      <div className="label">Fix a caption (audio stays untouched)</div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (find.trim()) {
            onOps([{ op: "replace_caption_text", find: find.trim(), replace: rep }]);
            setFind("");
            setRep("");
          }
        }}
      >
        <input className="field" placeholder="Wrong word(s), as heard" value={find} onChange={(e) => setFind(e.target.value)} />
        <input className="field" placeholder="Correct text" value={rep} onChange={(e) => setRep(e.target.value)} />
        <button className="btn shrink-0" disabled={busy || !find.trim()}>
          Apply
        </button>
      </form>
      {replacements.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {replacements.map((r) => (
            <span key={r.find} className="rounded-md bg-ink-800 px-2 py-0.5 text-ink-300">
              “{r.find}” → “{r.replace}”
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Chat({ state, render, busy, onChanged }: { state: ProjectState; render: RenderView; busy: boolean; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useMemo(
    () =>
      state.events.filter(
        (e) =>
          (e.tool === "Chat" && e.action === "Revision request") ||
          e.action === "Planned revision" ||
          (e.tool === "Editor" && (e.action === "Note" || e.action === "Manual edit")) ||
          e.action.startsWith("Rendered v"),
      ),
    [state.events],
  );
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);
  const job = state.jobs.find((j) => j.type === "revise" && (j.status === "running" || j.status === "queued"));
  const failed = state.jobs.find((j) => j.type === "revise" && j.status === "error" && Date.now() - (j.finishedAt ?? 0) < 60_000);

  async function send(instruction: string) {
    if (!instruction.trim()) return;
    setError(null);
    try {
      await api(`/api/projects/${state.project.id}/revise`, { method: "POST", json: { instruction, baseRenderId: render.id } });
      setText("");
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-ink-700 bg-ink-900/60">
      <div className="border-b border-ink-700 p-4">
        <div className="font-semibold">Ask for changes</div>
        <div className="text-xs text-ink-400">Revises v{render.version} and renders a new version. Your words are planned into edit operations.</div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && <div className="text-sm text-ink-400">No revisions yet. Try one of the suggestions below.</div>}
        {messages.map((m) => {
          const user = m.actor === "user";
          const rendered = m.action.startsWith("Rendered v");
          return (
            <div key={m.id} className={`flex gap-2 ${user ? "flex-row-reverse" : ""}`}>
              <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${user ? "bg-accent/25 text-accent" : rendered ? "bg-emerald-500/20 text-emerald-300" : "bg-ink-700 text-ink-300"}`}>
                {user ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
              </div>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${user ? "bg-accent/15" : "bg-ink-800"}`}>
                {!user && <div className="mb-0.5 font-mono text-[10px] text-ink-400">{rendered ? "FFmpeg" : m.tool}</div>}
                {rendered ? (
                  <span>
                    <b>{m.action}</b>. <span className="text-ink-300">{m.detail}</span>
                  </span>
                ) : (
                  m.detail
                )}
              </div>
            </div>
          );
        })}
        {job && (
          <div className="flex items-center gap-2 text-sm text-ink-300">
            <Loader2 className="h-4 w-4 animate-spin" /> {job.message ?? "Queued"} {job.progress > 0 && `(${Math.round(job.progress * 100)}%)`}
          </div>
        )}
        {failed && !job && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{failed.error}</div>}
      </div>
      <div className="space-y-2 border-t border-ink-700 p-3">
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} disabled={busy} onClick={() => send(s)} className="rounded-full border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 hover:border-accent hover:text-ink-100 disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>
        {error && <div className="text-xs text-red-300">{error}</div>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <textarea
            className="field min-h-11 resize-none"
            rows={2}
            placeholder={"e.g. Drop the part where she says 'you know' and make it square"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <button className="btn btn-primary self-end" disabled={busy || !text.trim()} aria-label="Send">
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
