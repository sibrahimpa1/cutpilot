import Link from "next/link";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <svg width={small ? 26 : 32} height={small ? 26 : 32} viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2dd4bf" />
            <stop offset="0.5" stopColor="#8b7bff" />
            <stop offset="1" stopColor="#e879f9" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg)" />
        <path d="M12 10.5v11l9-5.5z" fill="white" />
        <path d="M7 8l4 4M7 24l4-4" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      </svg>
      <span className={`${small ? "text-base" : "text-lg"} font-bold tracking-tight`}>
        Cut<span className="text-accent">Pilot</span>
      </span>
    </Link>
  );
}

export function ModeBadge({ mode }: { mode: "edit" | "generate" }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${mode === "edit" ? "bg-edit/15 text-edit" : "bg-gen/15 text-gen"}`}>
      {mode === "edit" ? "Edit" : "Generate"}
    </span>
  );
}
