// Server-only Chaos scanning logic. Never imported from client code.
//
// Cloudflare free-plan version: every root domain's Chaos list is diffed
// against a compact hash set (root_hashes). Only *changes* are written to D1
// (new subdomains, a scans row, domain counters); an unchanged root costs no
// writes. The rolling sweep and manual scans both go through scanRoot().
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchChaosHosts } from "@/integrations/d1/chaos-live.server";
import { cfEnv, nowIso, track, uuid } from "@/integrations/d1/env.server";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { decodeHashes, encodeHashes, has, hostHash } from "@/lib/hashset.server";

/** Chaos responses above this size are too heavy for one free-plan invocation. */
export const MAX_ROOT_BYTES = 1_200_000;

export type ScanResult = {
  domain: string;
  status: "success" | "partial" | "error" | "too_large" | "unchanged" | "baseline";
  total: number;
  newCount: number;
  removedCount: number;
  bytes?: number;
  error?: string;
};

export type ScanJobProgress = {
  id: string;
  domainId: string;
  status: "queued" | "fetching" | "processing" | "success" | "error";
  total: number;
  processed: number;
  newCount: number;
  error?: string;
};

/** total/baselined come from the domains row (lets an unchanged root skip all writes). */
type DomainRef = { id: string; domain: string; total?: number; baselined?: boolean };

async function batch(stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 100) {
    const rs = await cfEnv().DB.batch(stmts.slice(i, i + 100));
    for (const r of rs) track(r.meta);
  }
}

/**
 * Scan one root domain: fetch its Chaos list, diff against the stored hash set,
 * and persist only what changed. `force` writes a scans row even when nothing changed
 * (manual scans, so the user sees a result).
 */
export async function scanRoot(d: DomainRef, trigger: "manual" | "cron", opts: { force?: boolean; maxBytes?: number } = {}): Promise<ScanResult> {
  const db = cfEnv().DB;
  const started = nowIso();
  try {
    const { hosts, bytes } = await fetchChaosHosts(d.domain);
    if (bytes > (opts.maxBytes ?? MAX_ROOT_BYTES)) {
      await batch([
        db.prepare("UPDATE domains SET last_scan_status = 'too_large', total_subdomains = ?, updated_at = ? WHERE id = ? AND (last_scan_status IS NOT 'too_large' OR total_subdomains != ?)")
          .bind(hosts.length, started, d.id, hosts.length),
      ]);
      return { domain: d.domain, status: "too_large", total: hosts.length, newCount: 0, removedCount: 0, bytes };
    }

    const suffix = `.${d.domain}`;
    const hashes = new Float64Array(hosts.length);
    const clean: string[] = [];
    for (const h of hosts) {
      if (h !== d.domain && !h.endsWith(suffix)) continue;
      hashes[clean.length] = hostHash(h);
      clean.push(h);
    }
    const mine = hashes.subarray(0, clean.length);

    const prevRow = await db.prepare("SELECT hashes FROM root_hashes WHERE domain = ?").bind(d.domain).first<{ hashes: string }>();
    const prev = prevRow?.hashes ? decodeHashes(prevRow.hashes) : null;
    const fresh: string[] = [];
    let kept = 0;
    if (prev) {
      for (let i = 0; i < clean.length; i++) {
        if (has(prev, mine[i]!)) kept++;
        else fresh.push(clean[i]!);
      }
    }
    const removed = prev ? Math.max(prev.length - kept, 0) : 0;
    const changed = !prev || fresh.length > 0 || removed > 0;
    const finished = nowIso();

    if (!changed && !opts.force) {
      // Hash set already known (e.g. carried over) but the domains row was never filled in.
      if (d.baselined === false || (d.total !== undefined && d.total !== clean.length)) {
        await batch([
          db.prepare(
            `UPDATE domains SET total_subdomains = ?, last_scanned_at = ?, last_scan_status = 'success',
               claimed_at = COALESCE(claimed_at, ?), updated_at = ? WHERE id = ?`,
          ).bind(clean.length, finished, finished, finished, d.id),
        ]);
      }
      return { domain: d.domain, status: "unchanged", total: clean.length, newCount: 0, removedCount: 0, bytes };
    }

    const stmts: D1PreparedStatement[] = [];
    if (changed) {
      stmts.push(
        db.prepare("INSERT INTO root_hashes (domain, hashes) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET hashes = excluded.hashes")
          .bind(d.domain, encodeHashes(Float64Array.from(mine).sort())),
      );
    }
    // claimed_at doubles as the "baseline taken" timestamp.
    stmts.push(
      db.prepare(
        `UPDATE domains SET total_subdomains = ?, new_subdomains_last_scan = ?, last_scanned_at = ?, last_scan_status = 'success',
           claimed_at = COALESCE(claimed_at, ?), updated_at = ? WHERE id = ?`,
      ).bind(clean.length, fresh.length, finished, finished, finished, d.id),
    );
    for (const h of fresh.slice(0, 5000)) {
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO subdomains (id, domain_id, label, host, first_seen_at, last_seen_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)")
          .bind(uuid(), d.id, h === d.domain ? "" : h.slice(0, -suffix.length), h, finished, finished),
      );
    }
    if (prev || opts.force) {
      stmts.push(
        db.prepare(
          `INSERT INTO scans (id, domain_id, trigger, status, started_at, finished_at, total_returned, new_count, removed_count)
           VALUES (?, ?, ?, 'success', ?, ?, ?, ?, ?)`,
        ).bind(uuid(), d.id, trigger, started, finished, clean.length, fresh.length, removed),
      );
    }
    if (fresh.length) {
      stmts.push(
        db.prepare(
          `INSERT INTO daily_stats (id, day, new_subdomains) VALUES (?, date('now'), ?)
           ON CONFLICT(day) DO UPDATE SET new_subdomains = new_subdomains + excluded.new_subdomains, updated_at = ?`,
        ).bind(uuid(), fresh.length, finished),
      );
    }
    await batch(stmts);
    return {
      domain: d.domain,
      status: prev ? "success" : "baseline",
      total: clean.length,
      newCount: fresh.length,
      removedCount: removed,
      bytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (trigger === "manual") {
      await batch([
        db.prepare(
          `INSERT INTO scans (id, domain_id, trigger, status, started_at, finished_at, error_message) VALUES (?, ?, 'manual', 'error', ?, ?, ?)`,
        ).bind(uuid(), d.id, started, nowIso(), message.slice(0, 500)),
      ]).catch(() => {});
    }
    return { domain: d.domain, status: "error", total: 0, newCount: 0, removedCount: 0, error: message };
  }
}

/** Kept for API compatibility with the old code. */
export async function scanDomain(domainRow: DomainRef, trigger: "manual" | "cron"): Promise<ScanResult> {
  return scanRoot(domainRow, trigger, { force: trigger === "manual" });
}

/** Scans a slice of the rolling sweep inside one invocation. Stops early once enough data was processed. */
export async function scanGroup(domains: DomainRef[], byteBudget = 900_000) {
  const results: ScanResult[] = [];
  let bytes = 0;
  for (const d of domains) {
    if (bytes > byteBudget) break;
    const r = await scanRoot(d, "cron", { maxBytes: domains.length > 1 ? Math.min(MAX_ROOT_BYTES, byteBudget) : MAX_ROOT_BYTES });
    bytes += r.bytes ?? 0;
    results.push(r);
  }
  return {
    processed: results.length,
    newCount: results.reduce((s, r) => s + r.newCount, 0),
    errors: results.filter((r) => r.status === "error").length,
    baselines: results.filter((r) => r.status === "baseline").length,
    changed: results.filter((r) => r.status === "success").length,
    tooLarge: results.filter((r) => r.status === "too_large").map((r) => r.domain),
    bytes,
  };
}

export async function queueManualScan(domainId: string): Promise<ScanJobProgress> {
  const { data: active } = await supabaseAdmin
    .from("scan_jobs")
    .select("id, domain_id, status, total_hosts, processed_hosts, new_count, error_message")
    .eq("domain_id", domainId)
    .in("status", ["queued", "fetching", "processing"])
    .maybeSingle();

  let job = active;
  if (!job) {
    const { data, error } = await supabaseAdmin
      .from("scan_jobs")
      .insert({ domain_id: domainId, status: "queued" })
      .select("id, domain_id, status, total_hosts, processed_hosts, new_count, error_message")
      .single();
    if (error) {
      const { data: raced } = await supabaseAdmin
        .from("scan_jobs")
        .select("id, domain_id, status, total_hosts, processed_hosts, new_count, error_message")
        .eq("domain_id", domainId)
        .in("status", ["queued", "fetching", "processing"])
        .single();
      if (!raced) throw new Error(error.message);
      job = raced;
    } else {
      job = data;
    }
  }

  return {
    id: job.id,
    domainId: job.domain_id,
    status: job.status as ScanJobProgress["status"],
    total: job.total_hosts,
    processed: job.processed_hosts,
    newCount: job.new_count,
    ...(job.error_message ? { error: job.error_message } : {}),
  };
}

export async function getManualScanProgress(domainId: string): Promise<ScanJobProgress | null> {
  const { data, error } = await supabaseAdmin
    .from("scan_jobs")
    .select("id, domain_id, status, total_hosts, processed_hosts, new_count, error_message")
    .eq("domain_id", domainId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id,
    domainId: data.domain_id,
    status: data.status as ScanJobProgress["status"],
    total: data.total_hosts,
    processed: data.processed_hosts,
    newCount: data.new_count,
    ...(data.error_message ? { error: data.error_message } : {}),
  };
}

/** Runs one queued manual scan job (the engine fans these out, one per invocation). */
export async function runManualJob(jobId: string) {
  const { data: job } = await supabaseAdmin
    .from("scan_jobs")
    .select("id, domain_id, status, domains(domain)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;
  const domain = (job.domains as { domain?: string } | null)?.domain;
  if (!domain) return null;
  const now = nowIso();
  await supabaseAdmin.from("scan_jobs").update({ status: "fetching", claimed_at: now, started_at: now }).eq("id", jobId);
  const r = await scanRoot({ id: job.domain_id, domain }, "manual", { force: true });
  const finished = nowIso();
  await supabaseAdmin
    .from("scan_jobs")
    .update({
      status: r.status === "error" ? "error" : "success",
      total_hosts: r.total,
      processed_hosts: r.total,
      new_count: r.newCount,
      error_message: r.error ?? (r.status === "too_large" ? "Host list is too large for one free-plan run; it is still shown live." : null),
      finished_at: finished,
      claimed_at: finished,
      hosts: null,
    })
    .eq("id", jobId);
  return r;
}

/** Compatibility shim: claims queued manual jobs and runs them inline. */
export async function processPendingScanJobs(_budgetMs = 20_000) {
  const { data } = await supabaseAdmin.from("scan_jobs").select("id").eq("status", "queued").order("created_at", { ascending: true }).limit(3);
  const out = [];
  for (const j of data ?? []) out.push(await runManualJob(j.id));
  return out.length === 1 ? out[0] : out.length === 0 ? null : out;
}

/** Compatibility shim: the rolling sweep now runs from the Worker cron (src/worker/engine.ts). */
export async function scanAllEnabledDomains(_trigger: "manual" | "cron", _options: Record<string, unknown> = {}) {
  return [] as ScanResult[];
}
