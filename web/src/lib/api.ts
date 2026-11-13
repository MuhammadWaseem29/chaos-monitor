import { queryOptions } from "@tanstack/react-query";

export type Sub = {
  id: number;
  host: string;
  root: string;
  program_slug: string;
  first_seen_at: string;
  probe_state: number;
  probed_at: string | null;
  status_code: number | null;
  title: string | null;
  webserver: string | null;
  cdn: string | null;
  ip: string | null;
  cname: string | null;
  final_url: string | null;
  tech: string | null;
  live: number;
  takeover: number;
  takeover_service: string | null;
  takeover_evidence: string | null;
  error: string | null;
};

export type Program = {
  slug: string;
  name: string;
  platform: string;
  program_url: string | null;
  zip_url: string | null;
  bounty: number;
  host_count: number;
  change: number;
  is_new: number;
  source_updated_at: string | null;
  checked_at: string | null;
  root_count: number;
  status: string;
  new_today: number;
  new_7d: number;
  new_30d: number;
  roots: Record<string, number>;
};

export type Root = {
  domain: string;
  source: string;
  host_count: number;
  raw_size: number;
  status: string;
  error: string | null;
  checked_at: string | null;
  changed_at: string | null;
  last_new: number;
};

export type Day = {
  day: string;
  new_subs: number;
  probed: number;
  live: number;
  takeovers: number;
  roots_checked: number;
  errors: number;
  rows_written: number;
  rows_read: number;
  invocations: number;
};

export type Overview = {
  generated_at?: string;
  programs?: number;
  dataset_hosts?: number;
  tracked_hosts?: number;
  roots?: Record<string, number>;
  platforms?: Array<{ platform: string; programs: number; hosts: number; bounty: number; new_7d: number }>;
  queue?: Array<{ kind: string; n: number; running: number }>;
  probes_pending?: number;
  status_codes?: Array<{ status_code: number | null; n: number }>;
  today: Day | null;
  new_today: number;
  new_7d: number;
  new_30d: number;
  live_7d: number;
  probed_7d: number;
  takeovers: number;
  latest: Sub[];
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const overviewQuery = queryOptions({
  queryKey: ["overview"],
  queryFn: () => get<Overview>("/api/overview"),
  refetchInterval: 60_000,
});

export const programsQuery = queryOptions({
  queryKey: ["programs"],
  queryFn: () => get<Program[]>("/api/programs"),
  staleTime: 120_000,
});

export const programQuery = (slug: string) =>
  queryOptions({
    queryKey: ["program", slug],
    queryFn: () =>
      get<{ program: Program; roots: Root[]; recent: Sub[]; days: Array<{ day: string; new_subs: number }> }>(
        `/api/programs/${encodeURIComponent(slug)}`,
      ),
    refetchInterval: 120_000,
  });

export const rootQuery = (domain: string) =>
  queryOptions({
    queryKey: ["root", domain],
    queryFn: () =>
      get<{ root: Root & { program_slug: string; program_name: string | null; platform: string | null; zip_url: string | null; baseline_at: string | null }; recent: Sub[] }>(
        `/api/roots/${encodeURIComponent(domain)}`,
      ),
    refetchInterval: 120_000,
  });

export type SubsFilter = {
  view?: "new" | "live" | "takeover" | "pending" | "dead";
  hours?: number;
  program?: string;
  root?: string;
  q?: string;
  code?: string;
  limit?: number;
};

export const subsUrl = (f: SubsFilter, before?: number | null) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
  if (before) p.set("before", String(before));
  return `/api/subs?${p.toString()}`;
};

export const fetchSubs = (f: SubsFilter, before?: number | null) =>
  get<{ rows: Sub[]; next: number | null }>(subsUrl(f, before));

export const statsQuery = queryOptions({
  queryKey: ["stats"],
  queryFn: () => get<{ days: Day[] }>("/api/stats"),
  refetchInterval: 300_000,
});

export type Health = {
  meta: Record<string, string | null>;
  usage: Day | null;
  limits: { rows_written_per_day: number; rows_read_per_day: number; write_budget: number };
  queue: Array<{ kind: string; n: number; running: number }>;
  probes_pending: number;
  roots: Record<string, number>;
  snapshot_at: string | null;
  errors: Array<{ domain: string; program_slug: string; error: string; checked_at: string }>;
  features: { chaos_api: boolean; alerts_discord: boolean; alerts_telegram: boolean };
};

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: () => get<Health>("/api/health"),
  refetchInterval: 60_000,
});

/* ---------------------------------------------------------------- helpers */

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = /^\d+$/.test(iso) ? Number(iso) : new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

export const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString();

export const PLATFORM_COLORS: Record<string, string> = {
  hackerone: "#494649",
  bugcrowd: "#f26822",
  intigriti: "#5c6bf5",
  yeswehack: "#1a73e8",
  hackenproof: "#0fb07a",
  bugbountych: "#d81e34",
  custom: "#8b5cf6",
  other: "#8a8a8a",
};

export const platformLabel = (p: string | null | undefined) => {
  if (!p || p === "other") return "Self-hosted";
  const map: Record<string, string> = {
    hackerone: "HackerOne",
    bugcrowd: "Bugcrowd",
    intigriti: "Intigriti",
    yeswehack: "YesWeHack",
    hackenproof: "HackenProof",
    bugbountych: "BugBounty.ch",
    custom: "Custom",
  };
  return map[p] ?? p;
};

export const INTERESTING = [
  "admin", "internal", "intranet", "stage", "staging", "dev", "test", "uat", "qa", "vpn", "jenkins",
  "git", "gitlab", "jira", "grafana", "kibana", "api", "auth", "sso", "db", "backup", "legacy", "old", "beta", "preprod",
];

export const isInteresting = (host: string) =>
  host
    .toLowerCase()
    .split(/[.-]/)
    .some((part) => INTERESTING.some((w) => part === w || (w.length > 3 && part.startsWith(w))));

export function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
