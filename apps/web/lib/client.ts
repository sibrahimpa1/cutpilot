"use client";

export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const fmtDur = (s?: number | null) => {
  if (s == null || !Number.isFinite(s)) return "–";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m ? `${m}:${r.toFixed(0).padStart(2, "0")}` : `${r.toFixed(1)}s`;
};

export const timeAgo = (ts: number) => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};

export const fileUrl = (p?: string | null) => (p ? `/api/files?path=${encodeURIComponent(p)}` : "");
export const thumbUrl = (p: string, t: number) => `/api/thumb?path=${encodeURIComponent(p)}&t=${t.toFixed(2)}`;
