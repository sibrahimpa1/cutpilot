"use client";

import { Clapperboard, Film, KeyRound, Loader2, Play, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, ModeBadge } from "@/components/Logo";
import { ProvidersPanel, type ProviderInfo } from "@/components/Providers";
import { api, fmtDur, timeAgo } from "@/lib/client";

type ProjectCard = {
  id: string;
  name: string;
  mode: "edit" | "generate";
  brief: string;
  updatedAt: number;
  latest: { version: number; thumb: string | null; aspect: string; duration: number | null } | null;
};

export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [providers, setProviders] = useState<ProviderInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ProjectCard[]>("/api/projects").then(setProjects).catch((e) => setError(e.message));
    api<ProviderInfo>("/api/providers").then(setProviders).catch(() => {});
  }, []);

  async function create(mode: "edit" | "generate", name: string, brief: string) {
    setBusy(mode);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/projects", { method: "POST", json: { mode, name, brief } });
      router.push(`/projects/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  }

  async function demo() {
    setBusy("demo");
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/projects/demo", { method: "POST" });
      router.push(`/projects/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-20 sm:px-6">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <a className="text-sm text-ink-400 hover:text-ink-100" href="https://github.com/sibrahimpa1/cutpilot" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>

      <section className="pt-6 pb-10">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          From brief to finished video.
          <span className="block bg-gradient-to-r from-edit via-accent to-gen bg-clip-text text-transparent">AI does the edit. You direct.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-ink-300">
          Two workflows on one engine. Cut supplied footage into a captioned story, or turn an idea into a narrated video. Then revise it by
          asking: &ldquo;remove the second clip&rdquo;, &ldquo;make a vertical version&rdquo;, &ldquo;fix that caption&rdquo;. Every step is logged.
        </p>
      </section>

      {error && <div className="mb-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="grid gap-5 lg:grid-cols-2">
        <ModeCard
          mode="edit"
          icon={<Film className="h-5 w-5" />}
          title="Edit footage"
          steps={["Upload", "Transcribe", "Pick moments", "Assemble", "Reframe", "Music", "Render"]}
          blurb="Interviews, talking heads, event footage. Claude picks the strongest moments for your brief; captions, titles and a tracked 9:16 crop are automatic."
          placeholder="Brief: a 30 s LinkedIn cut about our remote-first culture. Open on the strongest line."
          busy={busy === "edit"}
          onCreate={(n, b) => create("edit", n, b)}
          extra={
            <button className="btn btn-ghost text-edit" disabled={!!busy} onClick={demo}>
              {busy === "demo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Try with demo footage
            </button>
          }
        />
        <ModeCard
          mode="generate"
          icon={<Sparkles className="h-5 w-5" />}
          title="Generate from idea"
          steps={["Idea", "Script", "Voiceover", "Visuals", "Captions", "Assemble", "Music", "Render"]}
          blurb="No footage needed. Claude writes the script, then voiceover, a visual per scene, word-timed captions and music are assembled into an MP4."
          placeholder="Idea: three habits that make remote teams faster, as a 30 s vertical explainer."
          busy={busy === "generate"}
          onCreate={(n, b) => create("generate", n, b)}
        />
      </section>

      <section className="mt-12 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <Clapperboard className="h-5 w-5 text-ink-400" /> Projects
          </h2>
          {!projects ? (
            <div className="panel h-40 shimmer" />
          ) : projects.length === 0 ? (
            <div className="panel px-6 py-10 text-center text-ink-400">No projects yet. Start one above, or try the demo footage.</div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => (
                <Link key={p.id} href={`/projects/${p.id}`} className="panel group overflow-hidden transition hover:border-ink-600">
                  <div className="relative aspect-video bg-ink-900">
                    {p.latest?.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.latest.thumb} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-ink-600">
                        {p.mode === "edit" ? <Film className="h-8 w-8" /> : <Wand2 className="h-8 w-8" />}
                      </div>
                    )}
                    {p.latest && (
                      <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px]">
                        v{p.latest.version} · {p.latest.aspect} · {fmtDur(p.latest.duration)}
                      </span>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <ModeBadge mode={p.mode} />
                      <span className="truncate font-medium">{p.name}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-ink-400">{p.brief || "No brief"}</div>
                    <div className="mt-2 text-[11px] text-ink-400">{timeAgo(p.updatedAt)}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
        <aside>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <KeyRound className="h-5 w-5 text-ink-400" /> Providers
          </h2>
          <ProvidersPanel info={providers} />
        </aside>
      </section>
    </main>
  );
}

function ModeCard(props: {
  mode: "edit" | "generate";
  icon: React.ReactNode;
  title: string;
  blurb: string;
  steps: string[];
  placeholder: string;
  busy: boolean;
  onCreate: (name: string, brief: string) => void;
  extra?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const color = props.mode === "edit" ? "text-edit" : "text-gen";
  return (
    <div className="panel relative overflow-hidden p-5">
      <div
        className={`pointer-events-none absolute -top-24 -right-24 h-56 w-56 rounded-full blur-3xl ${props.mode === "edit" ? "bg-edit/15" : "bg-gen/15"}`}
      />
      <div className={`flex items-center gap-2 font-semibold ${color}`}>
        {props.icon}
        <span className="text-ink-100">{props.title}</span>
      </div>
      <p className="mt-2 text-sm text-ink-300">{props.blurb}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {props.steps.map((s, i) => (
          <span key={s} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 text-[11px] text-ink-300">
            <span className={`mr-1 font-mono ${color}`}>{i + 1}</span>
            {s}
          </span>
        ))}
      </div>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          props.onCreate(name, brief);
        }}
      >
        <input className="field" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className="field min-h-20 resize-y" placeholder={props.placeholder} value={brief} onChange={(e) => setBrief(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={props.busy}>
            {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : props.icon}
            Create {props.mode === "edit" ? "edit" : "video"} project
          </button>
          {props.extra}
        </div>
      </form>
    </div>
  );
}
