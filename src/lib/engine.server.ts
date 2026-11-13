// Cron engine for the Cloudflare free plan. Replaces Lovable's pg_cron job that
// called /api/public/hooks/scan every minute. The Worker's scheduled handler
// calls dispatch() once a minute; dispatch() hands every unit of work to its own
// invocation via the SELF service binding (/api/internal/*), so each one gets a
// fresh free-plan budget (10 ms CPU, 50 subrequests).
import { cfEnv, nowIso, secret, usage, uuid } from "@/integrations/d1/env.server";
import { getAgg, rebuildAgg, run, sql, sql1, type EngineTick } from "@/integrations/d1/rpc.server";

const CYCLE_MINUTES = 240; // every root domain rescanned every 4 hours (Chaos data itself refreshes ~daily)
const GROUP_SIZE = 5; // small roots per scan invocation (keeps each run near the 10 ms CPU budget)
const BIG_ROOT = 15_000; // roots above this many hosts get an invocation of their own
const MAX_PER_MINUTE = 260;
const AGG_EVERY_MS = 30 * 60_000;
const PROBE_LANES = 3;
const PROBE_WALL_MS = 40_000;

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

type Usage = { read: number; written: number; probed?: number; live?: number; newCount?: number; errors?: number };

export async function callInternal(path: string, body: unknown): Promise<{ ok: boolean; result?: any; usage?: Usage }> {
  const env = cfEnv();
  const key = secret("INTERNAL_KEY") ?? "";
  try {
    const req = new Request(`https://internal.chaos/api/internal/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": key },
      body: JSON.stringify(body ?? {}),
    });
    const res = (env.SELF ? await env.SELF.fetch(req as never) : await fetch(req)) as unknown as Response;
    const json = (await res.json().catch(() => null)) as { ok: boolean; result?: unknown; usage?: Usage } | null;
    return json ?? { ok: false };
  } catch (e) {
    console.error("internal call failed", path, e);
    return { ok: false };
  }
}

async function meta(keys: string[]) {
  const rows = await sql<{ key: string; value: string | null }>(
    `SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(",")})`,
    ...keys,
  );
  const out: Record<string, string | null> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of rows) out[r.key] = r.value;
  return out;
}

const setMeta = (key: string, value: string) =>
  run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

export async function dispatch() {
  const started = Date.now();
  const totals = { read: 0, written: 0, probed: 0, live: 0, newCount: 0, errors: 0, scanned: 0 };
  const absorb = (u?: Usage) => {
    if (!u) return;
    totals.read += u.read ?? 0;
    totals.written += u.written ?? 0;
    totals.probed += u.probed ?? 0;
    totals.live += u.live ?? 0;
  };

  const budget = num(secret("WRITE_BUDGET"), 80_000);
  const day = await sql1<{ rows_written: number }>("SELECT rows_written FROM daily_stats WHERE day = date('now')");
  const writesToday = Number(day?.rows_written ?? 0);
  const m = await meta(["scan_cursor", "agg_at", "cleanup_day", "cycle_started_at", "scan_leftover"]);
  const jobs: Promise<unknown>[] = [];

  // Domain-wide aggregates (counts over ~22k rows) every 30 minutes.
  if (!m.agg_at || started - Number(m.agg_at) > AGG_EVERY_MS) {
    await setMeta("agg_at", String(started));
    jobs.push(callInternal("agg", {}).then((r) => absorb(r.usage)));
  }
  const today = new Date().toISOString().slice(0, 10);
  if (m.cleanup_day !== today) {
    await setMeta("cleanup_day", today);
    jobs.push(callInternal("cleanup", {}).then((r) => absorb(r.usage)));
  }

  // Manual "Scan now" jobs: one invocation each.
  const manual = await sql<{ id: string }>("SELECT id FROM scan_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 5");
  for (const j of manual) jobs.push(callInternal("manual", { id: j.id }).then((r) => absorb(r.usage)));

  // Rolling sweep over every enabled root domain, alphabetically, one slice per minute.
  let tick: EngineTick | null = null;
  if (writesToday < budget) {
    const agg = await getAgg();
    const perMinute = Math.min(Math.ceil(Math.max(agg.enabled_domains, 1) / CYCLE_MINUTES) + 2, MAX_PER_MINUTE);
    const cursor = m.scan_cursor ?? "";
    const doms = await sql<{ id: string; domain: string; total_subdomains: number; last_scan_status: string | null; claimed_at: string | null; slug: string | null; name: string | null; color: string | null }>(
      `SELECT d.id, d.domain, d.total_subdomains, d.last_scan_status, d.claimed_at, p.slug, p.name, p.color
         FROM domains d LEFT JOIN platforms p ON p.id = d.platform_id
        WHERE d.enabled = 1 AND d.domain > ? ORDER BY d.domain LIMIT ?`,
      cursor,
      perMinute,
    );
    if (doms.length) {
      type Ref = { id: string; domain: string; total: number; baselined: boolean };
      const groups: Ref[][] = [];
      // Domains a previous run had to stop before (data budget) are scanned first, alone.
      let leftover: Ref[] = [];
      try {
        leftover = m.scan_leftover ? (JSON.parse(m.scan_leftover) as Ref[]) : [];
      } catch {
        leftover = [];
      }
      for (const l of leftover.slice(0, 40)) groups.push([l]);
      let cur: Ref[] = [];
      for (const d of doms) {
        const big = d.total_subdomains > BIG_ROOT || d.last_scan_status === "too_large";
        const ref = { id: d.id, domain: d.domain, total: Number(d.total_subdomains), baselined: d.claimed_at != null };
        if (big) groups.push([ref]);
        else {
          cur.push(ref);
          if (cur.length >= GROUP_SIZE) {
            groups.push(cur);
            cur = [];
          }
        }
      }
      if (cur.length) groups.push(cur);

      tick = {
        at: nowIso(),
        scan_workers: groups.length,
        probe_workers: PROBE_LANES,
        domains: doms.slice(0, 60).map((d) => ({ id: d.id, domain: d.domain, platform_slug: d.slug, platform_name: d.name, platform_color: d.color })),
      };
      await setMeta("engine_tick", JSON.stringify(tick));

      const results = await Promise.all(groups.map((g) => callInternal("scan", { domains: g })));
      const nextLeftover: Ref[] = leftover.slice(40);
      results.forEach((r, i) => {
        const done = r.ok ? Number(r.result?.processed ?? 0) : 0;
        if (r.ok && done < groups[i]!.length) nextLeftover.push(...groups[i]!.slice(done));
      });
      if (nextLeftover.length || leftover.length) await setMeta("scan_leftover", JSON.stringify(nextLeftover.slice(0, 400)));
      let processed = 0;
      let fresh = 0;
      let errors = 0;
      for (const r of results) {
        absorb(r.usage);
        processed += r.result?.processed ?? 0;
        fresh += r.result?.newCount ?? 0;
        errors += r.ok ? r.result?.errors ?? 0 : 1;
      }
      totals.newCount += fresh;
      totals.errors += errors;
      totals.scanned += processed;
      const wrapped = doms.length < perMinute;
      await run(
        "INSERT INTO scan_ranges (start_domain, end_domain, domains_count, new_count, errors, at) VALUES (?, ?, ?, ?, ?, ?)",
        doms[0]!.domain,
        doms[doms.length - 1]!.domain,
        processed,
        fresh,
        errors,
        nowIso(),
      );
      await setMeta("scan_cursor", wrapped ? "" : doms[doms.length - 1]!.domain);
      if (wrapped || !cursor) await setMeta("cycle_started_at", nowIso());
    } else {
      await setMeta("scan_cursor", "");
    }
  }

  // One-time: indexes deferred from the first day's import (D1 free write limit).
  // Built on a fresh day so they fit inside the 100k rows-written allowance.
  const idx = await sql1<{ value: string }>("SELECT value FROM meta WHERE key = 'domain_indexes'");
  if (!idx && writesToday < 20_000) {
    await setMeta("domain_indexes", nowIso());
    await run("CREATE INDEX IF NOT EXISTS idx_domains_platform ON domains(platform_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_domains_total ON domains(total_subdomains DESC)");
  }

  // Live probing: a few lanes, each running short probe invocations back to back.
  // Paused near D1's hard daily write limit (100k) so the site keeps working.
  const probesAllowed = writesToday < budget + 7_000;
  const { ensureAutoProbeJob } = await import("@/lib/probe.server");
  if (probesAllowed) await ensureAutoProbeJob();
  const lane = async () => {
    if (!probesAllowed) return;
    while (Date.now() - started < PROBE_WALL_MS) {
      const r = await callInternal("probe", {});
      absorb(r.usage);
      if (!r.ok || !r.result?.jobId) return;
    }
  };
  jobs.push(...Array.from({ length: PROBE_LANES }, lane));

  // Email alerts.
  jobs.push(callInternal("alerts", {}).then((r) => absorb(r.usage)));

  await Promise.all(jobs);

  // One stats write per minute for everything this tick did.
  totals.read += usage.read;
  totals.written += usage.written + 1;
  await run(
    `INSERT INTO daily_stats (id, day, scans_run, scan_errors, probed, live, rows_written, rows_read, invocations)
     VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(day) DO UPDATE SET scans_run = scans_run + excluded.scans_run, scan_errors = scan_errors + excluded.scan_errors,
       probed = probed + excluded.probed, live = live + excluded.live, rows_written = rows_written + excluded.rows_written,
       rows_read = rows_read + excluded.rows_read, invocations = invocations + 1, updated_at = ?`,
    uuid(),
    totals.scanned,
    totals.errors,
    totals.probed,
    totals.live,
    totals.written,
    totals.read,
    nowIso(),
  );
  return { ms: Date.now() - started, ...totals, writesToday };
}

/** Daily housekeeping: old range rows, expired sessions, old API usage rows. */
export async function cleanup() {
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  await run("DELETE FROM scan_ranges WHERE at < ?", old);
  await run("DELETE FROM sessions WHERE expires_at < ?", nowIso());
  await run("DELETE FROM api_request_logs WHERE hour < ?", new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 13));
  return { ok: true };
}

export { rebuildAgg };
