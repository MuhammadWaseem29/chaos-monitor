export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SELF: Fetcher;

  // vars
  MAX_RAW_BYTES?: string;        // largest root host list processed (uncompressed bytes)
  TASK_FANOUT?: string;          // root/program tasks started per minute
  PROBE_FANOUT?: string;         // probe workers started per minute
  WRITE_BUDGET?: string;         // stop scan tasks after this many D1 rows written today
  RETENTION_DAYS?: string;       // how long new-subdomain rows are kept
  ALERT_PROGRAMS?: string;       // optional comma list of program slugs to alert on

  // secrets
  INTERNAL_KEY: string;          // protects /_internal/* fan-out calls
  ADMIN_TOKEN?: string;          // protects /api/admin/*
  CHAOS_API_KEY?: string;        // optional: enables custom root domains via Chaos API
  DISCORD_WEBHOOK?: string;      // optional alerts
  TELEGRAM_BOT_TOKEN?: string;   // optional alerts
  TELEGRAM_CHAT_ID?: string;
}

export const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();
