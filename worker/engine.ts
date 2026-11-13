// Scan engine. A once-a-minute cron (the dispatcher) claims small units of work
// and hands each to its own Worker invocation via a self service binding, so
// every unit gets a fresh free-plan budget (10 ms CPU, 50 subrequests).

import { Db } from "./db";
import { alertsEnabled, newHostsMessage, sendAlert, wantsProgram } from "./alerts";
import type { Env } from "./env";
import { nowIso, num, today } from "./env";
import { decodeHashes, encodeHashes, has, hostHash } from "./hashset";
import { runProbe } from "./probe";
import { readCentralDirectory, readEntry, type ZipEntry } from "./zip";

const INDEX_URL = "https://chaos-data.projectdiscovery.io/index.json";
const CHAOS_API = "https://dns.projectdiscovery.io/dns";
const INDEX_EVERY_MS = 30 * 60_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const API_ROOTS_EVERY_MS = 6 * 3600_000;
const STALE_CLAIM_MS = 5 * 60_000;
const MAX_NEW_PER_ROOT = 3000;
const INLINE_ROOTS = 8;
const INLINE_BYTES = 64 * 1024;
const PROBE_BATCH = 8;

type IndexItem = {
  name: string;
  program_url: string;
  URL: string;
  count: number;
  change: number;
  is_new: boolean;
  platform: string;
  bounty: boolean;
  last_updated: string;
};

type ProgramPayload = { slug: string; zip: string };
type RootPayload = { slug: string; zip: string; domain: string; entry: ZipEntry; etag: string | null };
type ApiRootPayload = { slug: string; domain: string };

const slugOf = (zipUrl: string) => (zipUrl.split("/").pop() ?? "").replace(/\.zip$/i, "").toLowerCase();

function enqueueStmt(db: Db, kind: string, key: string, prio: number, payload: unknown) {
  return db.stmt(
    `INSERT INTO tasks (kind, key, prio, payload, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, prio = excluded.prio`,
    kind,
    key,
    prio,
    JSON.stringify(payload),
    Date.now(),
  );
}

/* ------------------------------------------------------------------ dispatcher */

async function fanout(env: Env, db: Db, path: string, body: unknown) {
  try {
    const res = await env.SELF.fetch(
      new Request(`https://internal${path}`, {
        method: "POST",
        headers: { "x-internal-key": env.INTERNAL_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const out = (await res.json().catch(() => null)) as { usage?: Parameters<Db["absorb"]>[0] } | null;
    db.absorb(out?.usage);
    return res.ok;
  } catch {
    return false;
  }
}

export async function dispatch(env: Env) {
  const db = new Db(env.DB);
  const now = Date.now();
  const usage = await db.usageToday();
  const budget = num(env.WRITE_BUDGET, 80_000);

  await db.batch([
    db.stmt("UPDATE tasks SET claimed_at = NULL WHERE claimed_at IS NOT NULL AND claimed_at < ?", now - STALE_CLAIM_MS),
    db.stmt("UPDATE subs SET probe_state = 0, claimed_at = NULL WHERE probe_state = 1 AND claimed_at < ?", now - STALE_CLAIM_MS),
  ]);

  const m = await db.meta(["index_checked_at", "snapshot_at", "api_roots_at", "cleanup_day"]);
  const jobs: Promise<boolean>[] = [];
  const due = (k: string, every: number) => !m[k] || now - Number(m[k]) > every;
  const marks: D1PreparedStatement[] = [];

  if (due("index_checked_at", INDEX_EVERY_MS)) {
    marks.push(db.setMetaStmt("index_checked_at", String(now)));
    jobs.push(fanout(env, db, "/_internal/index", {}));
  }
  if (due("snapshot_at", SNAPSHOT_EVERY_MS)) {
    marks.push(db.setMetaStmt("snapshot_at", String(now)));
    jobs.push(fanout(env, db, "/_internal/snapshot", {}));
  }
  if (env.CHAOS_API_KEY && due("api_roots_at", API_ROOTS_EVERY_MS)) {
    marks.push(db.setMetaStmt("api_roots_at", String(now)));
    jobs.push(fanout(env, db, "/_internal/api-roots", {}));
  }
  if (m.cleanup_day !== today()) {
    marks.push(db.setMetaStmt("cleanup_day", today()));
    jobs.push(fanout(env, db, "/_internal/cleanup", {}));
  }
  if (marks.length) await db.batch(marks);

  // Scan tasks: only while today's write budget allows.
  if (usage.rows_written < budget) {
    const tasks = await db.all<{ id: number; kind: string; payload: string; attempts: number }>(
      `UPDATE tasks SET claimed_at = ?, attempts = attempts + 1
       WHERE id IN (SELECT id FROM tasks WHERE claimed_at IS NULL ORDER BY prio, id LIMIT ?)
       RETURNING id, kind, payload, attempts`,
      now,
      num(env.TASK_FANOUT, 20),
    );
    for (const t of tasks) jobs.push(fanout(env, db, "/_internal/task", t));
  }

  // Probes keep running a little past the scan budget so new hosts still get checked.
  if (usage.rows_written < budget + 15_000) {
    const fan = num(env.PROBE_FANOUT, 6);
    const items = await db.all<{ id: number; host: string; program_slug: string }>(
      `UPDATE subs SET probe_state = 1, claimed_at = ?
       WHERE id IN (SELECT id FROM subs WHERE probe_state = 0 ORDER BY id DESC LIMIT ?)
       RETURNING id, host, program_slug`,
      now,
      fan * PROBE_BATCH,
    );
    for (let i = 0; i < items.length; i += PROBE_BATCH) {
      jobs.push(fanout(env, db, "/_internal/probe", { items: items.slice(i, i + PROBE_BATCH) }));
    }
  }

  const results = await Promise.all(jobs);
  await db.flush();
  return { started: jobs.length, ok: results.filter(Boolean).length };
}

/* ------------------------------------------------------------------ index */

export async function refreshIndex(env: Env, db: Db = new Db(env.DB)) {
  const m = await db.meta(["index_etag"]);
  const res = await fetch(INDEX_URL, { headers: m.index_etag ? { "If-None-Match": m.index_etag } : {} });
  if (res.status === 304) {
    return { changed: 0, notModified: true };
  }
  if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
  const list = (await res.json()) as IndexItem[];

  const existing = await db.all<{ slug: string; source_updated_at: string | null }>(
    "SELECT slug, source_updated_at FROM programs",
  );
  const seen = new Map(existing.map((r) => [r.slug, r.source_updated_at]));
  const stmts: D1PreparedStatement[] = [];
  let changed = 0;
  for (const it of list) {
    const slug = slugOf(it.URL);
    if (!slug || seen.get(slug) === it.last_updated) continue;
    changed++;
    stmts.push(
      db.stmt(
        `INSERT INTO programs (slug, name, platform, program_url, zip_url, bounty, host_count, change, is_new, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, platform = excluded.platform,
           program_url = excluded.program_url, zip_url = excluded.zip_url, bounty = excluded.bounty,
           host_count = excluded.host_count, change = excluded.change, is_new = excluded.is_new,
           source_updated_at = excluded.source_updated_at`,
        slug,
        it.name,
        it.platform || "other",
        it.program_url || null,
        it.URL,
        it.bounty ? 1 : 0,
        it.count ?? 0,
        it.change ?? 0,
        it.is_new ? 1 : 0,
        it.last_updated,
      ),
    );
    if ((it.count ?? 0) > 0) {
      stmts.push(enqueueStmt(db, "program", `program:${slug}`, 0, { slug, zip: it.URL } satisfies ProgramPayload));
    }
  }
  const etag = res.headers.get("etag");
  if (etag) stmts.push(db.setMetaStmt("index_etag", etag));
  await db.batch(stmts);
  return { changed, programs: list.length };
}

/* ------------------------------------------------------------------ host lists */

async function processHostList(
  db: Db,
  env: Env,
  p: { slug: string; domain: string; hosts: string[]; crc: number | null; rawSize: number; source: string },
) {
  const suffix = `.${p.domain}`;
  const hashes = new Float64Array(p.hosts.length);
  const clean: string[] = [];
  for (const raw of p.hosts) {
    const h = raw.trim().toLowerCase();
    if (!h || (h !== p.domain && !h.endsWith(suffix))) continue;
    hashes[clean.length] = hostHash(h);
    clean.push(h);
  }
  const mine = hashes.subarray(0, clean.length);

  const prevRow = await db.first<{ hashes: string | null }>(
    "SELECT hashes FROM root_hashes WHERE domain = ?",
    p.domain,
  );
  const fresh: string[] = [];
  if (prevRow?.hashes) {
    const prev = decodeHashes(prevRow.hashes);
    for (let i = 0; i < clean.length; i++) if (!has(prev, mine[i]!)) fresh.push(clean[i]!);
  }
  const sorted = Float64Array.from(mine).sort();

  const stamp = nowIso();
  const take = fresh.slice(0, MAX_NEW_PER_ROOT);
  const stmts: D1PreparedStatement[] = [
    db.stmt(
      "INSERT INTO root_hashes (domain, hashes) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET hashes = excluded.hashes",
      p.domain,
      encodeHashes(sorted),
    ),
    db.stmt(
      `INSERT INTO roots (domain, program_slug, source, crc, raw_size, host_count, status, error, baseline_at, checked_at, changed_at, last_new)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET program_slug = excluded.program_slug, crc = excluded.crc,
         raw_size = excluded.raw_size, host_count = excluded.host_count, status = 'ok', error = NULL,
         baseline_at = COALESCE(roots.baseline_at, excluded.baseline_at), checked_at = excluded.checked_at,
         changed_at = CASE WHEN excluded.last_new > 0 THEN excluded.checked_at ELSE roots.changed_at END,
         last_new = excluded.last_new`,
      p.domain,
      p.slug,
      p.source,
      p.crc,
      p.rawSize,
      clean.length,
      stamp,
      stamp,
      take.length ? stamp : null,
      take.length,
    ),
  ];
  for (let i = 0; i < take.length; i += 25) {
    const chunk = take.slice(i, i + 25);
    stmts.push(
      db.stmt(
        `INSERT OR IGNORE INTO subs (host, root, program_slug, first_seen_at) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(",")}`,
        ...chunk.flatMap((h) => [h, p.domain, p.slug, stamp]),
      ),
    );
  }
  if (take.length) {
    stmts.push(
      db.stmt(
        `INSERT INTO program_daily (day, slug, new_subs) VALUES (?, ?, ?)
         ON CONFLICT(day, slug) DO UPDATE SET new_subs = new_subs + excluded.new_subs`,
        today(),
        p.slug,
        take.length,
      ),
    );
  }
  await db.batch(stmts);
  db.counters.roots_checked++;
  db.counters.new_subs += take.length;

  if (take.length && alertsEnabled(env) && wantsProgram(env, p.slug)) {
    await sendAlert(env, newHostsMessage(p.slug, p.domain, take));
  }
  return { hosts: clean.length, fresh: take.length, baseline: !prevRow?.hashes };
}

/* ------------------------------------------------------------------ tasks */

async function programTask(db: Db, env: Env, p: ProgramPayload) {
  const maxRaw = num(env.MAX_RAW_BYTES, 512 * 1024);
  const cd = await readCentralDirectory(p.zip);
  const prog = await db.first<{ zip_etag: string | null }>("SELECT zip_etag FROM programs WHERE slug = ?", p.slug);
  if (cd.etag && prog?.zip_etag === cd.etag) {
    await db.run("UPDATE programs SET checked_at = ?, status = 'ok', error = NULL WHERE slug = ?", nowIso(), p.slug);
    return { unchanged: true };
  }

  const known = new Map(
    (
      await db.all<{ domain: string; crc: number | null; status: string }>(
        "SELECT domain, crc, status FROM roots WHERE program_slug = ?",
        p.slug,
      )
    ).map((r) => [r.domain, r]),
  );

  const stmts: D1PreparedStatement[] = [];
  const inline: ZipEntry[] = [];
  let inlineBytes = 0;
  let roots = 0;
  let queued = 0;
  for (const e of cd.entries) {
    if (!e.name.endsWith(".txt")) continue;
    const domain = e.name.slice(0, -4).toLowerCase().split("/").pop()!;
    roots++;
    const r = known.get(domain);
    known.delete(domain);
    if (r && r.crc === e.crc && (r.status === "ok" || r.status === "too_large")) continue;
    if (e.usize > maxRaw) {
      stmts.push(
        db.stmt(
          `INSERT INTO roots (domain, program_slug, crc, raw_size, host_count, status, checked_at)
           VALUES (?, ?, ?, ?, ?, 'too_large', ?)
           ON CONFLICT(domain) DO UPDATE SET program_slug = excluded.program_slug, crc = excluded.crc,
             raw_size = excluded.raw_size, host_count = excluded.host_count, status = 'too_large', checked_at = excluded.checked_at`,
          domain,
          p.slug,
          e.crc,
          e.usize,
          Math.round(e.usize / 26),
          nowIso(),
        ),
      );
      continue;
    }
    if (inline.length < INLINE_ROOTS && inlineBytes + e.usize <= INLINE_BYTES) {
      inline.push(e);
      inlineBytes += e.usize;
    } else {
      queued++;
      stmts.push(
        enqueueStmt(db, "root", `root:${domain}`, 1, {
          slug: p.slug,
          zip: p.zip,
          domain,
          entry: e,
          etag: cd.etag,
        } satisfies RootPayload),
      );
    }
  }
  for (const [domain, r] of known) {
    if (r.status !== "removed") stmts.push(db.stmt("UPDATE roots SET status = 'removed' WHERE domain = ?", domain));
  }
  stmts.push(
    db.stmt(
      "UPDATE programs SET zip_etag = ?, root_count = ?, checked_at = ?, status = 'ok', error = NULL WHERE slug = ?",
      queued > 0 ? null : cd.etag,
      roots,
      nowIso(),
      p.slug,
    ),
  );
  await db.batch(stmts);

  // Small roots are handled right here instead of costing a queued task each.
  let fresh = 0;
  for (const e of inline) {
    const domain = e.name.slice(0, -4).toLowerCase().split("/").pop()!;
    try {
      const { text } = await readEntry(p.zip, e);
      const r = await processHostList(db, env, {
        slug: p.slug,
        domain,
        hosts: text.split("\n"),
        crc: e.crc,
        rawSize: e.usize,
        source: "dataset",
      });
      fresh += r.fresh;
    } catch (err) {
      db.counters.errors++;
      await db.batch([
        enqueueStmt(db, "root", `root:${domain}`, 1, { slug: p.slug, zip: p.zip, domain, entry: e, etag: cd.etag }),
      ]);
      console.error("inline root failed", domain, err);
    }
  }
  return { roots, inline: inline.length, queued, fresh };
}

async function rootTask(db: Db, env: Env, p: RootPayload) {
  const { text, etag } = await readEntry(p.zip, p.entry);
  if (p.etag && etag && etag !== p.etag) {
    // Archive was rebuilt since the directory was read: re-read it.
    await db.batch([enqueueStmt(db, "program", `program:${p.slug}`, 0, { slug: p.slug, zip: p.zip })]);
    return { stale: true };
  }
  return processHostList(db, env, {
    slug: p.slug,
    domain: p.domain,
    hosts: text.split("\n"),
    crc: p.entry.crc,
    rawSize: p.entry.usize,
    source: "dataset",
  });
}

async function apiRootTask(db: Db, env: Env, p: ApiRootPayload) {
  if (!env.CHAOS_API_KEY) throw new Error("CHAOS_API_KEY is not set");
  const maxRaw = num(env.MAX_RAW_BYTES, 512 * 1024);
  const res = await fetch(`${CHAOS_API}/${encodeURIComponent(p.domain)}/subdomains`, {
    headers: { Authorization: env.CHAOS_API_KEY },
  });
  if (!res.ok) throw new Error(`Chaos API HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxRaw) {
    res.body?.cancel().catch(() => {});
    await db.run(
      "UPDATE roots SET status = 'too_large', raw_size = ?, checked_at = ? WHERE domain = ?",
      len,
      nowIso(),
      p.domain,
    );
    return { tooLarge: true };
  }
  const json = (await res.json()) as { subdomains?: string[] | null };
  const labels = Array.isArray(json.subdomains) ? json.subdomains : [];
  return processHostList(db, env, {
    slug: p.slug,
    domain: p.domain,
    hosts: labels.map((l) => (l ? `${l}.${p.domain}` : p.domain)),
    crc: null,
    rawSize: len,
    source: "api",
  });
}

export async function runTask(env: Env, t: { id: number; kind: string; payload: string; attempts: number }, db: Db = new Db(env.DB)) {
  try {
    const payload = JSON.parse(t.payload);
    let result: unknown;
    if (t.kind === "program") result = await programTask(db, env, payload);
    else if (t.kind === "root") result = await rootTask(db, env, payload);
    else if (t.kind === "api_root") result = await apiRootTask(db, env, payload);
    else throw new Error(`unknown task kind ${t.kind}`);
    await db.run("DELETE FROM tasks WHERE id = ?", t.id);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.counters.errors++;
    const payload = JSON.parse(t.payload) as { slug?: string; domain?: string };
    const stmts: D1PreparedStatement[] = [];
    if (t.attempts >= 3) {
      stmts.push(db.stmt("DELETE FROM tasks WHERE id = ?", t.id));
      if (payload.domain) {
        stmts.push(db.stmt("UPDATE roots SET status = 'error', error = ?, checked_at = ? WHERE domain = ?", message.slice(0, 300), nowIso(), payload.domain));
      } else if (payload.slug) {
        stmts.push(db.stmt("UPDATE programs SET status = 'error', error = ?, checked_at = ? WHERE slug = ?", message.slice(0, 300), nowIso(), payload.slug));
      }
    } else {
      stmts.push(db.stmt("UPDATE tasks SET claimed_at = NULL WHERE id = ?", t.id));
    }
    await db.batch(stmts);
    return { ok: false, error: message };
  }
}

export async function probeTask(env: Env, items: Array<{ id: number; host: string; program_slug: string }>, db: Db = new Db(env.DB)) {
  const r = await runProbe(db, env, items);
  return r;
}

/* ------------------------------------------------------------------ custom roots (Chaos API) */

export async function enqueueApiRoots(env: Env, db: Db = new Db(env.DB)) {
  const rows = await db.all<{ domain: string; program_slug: string }>(
    "SELECT domain, program_slug FROM roots WHERE source = 'api' AND status != 'removed'",
  );
  await db.batch(
    rows.map((r) =>
      enqueueStmt(db, "api_root", `api:${r.domain}`, 2, { slug: r.program_slug, domain: r.domain } satisfies ApiRootPayload),
    ),
  );
  return { queued: rows.length };
}

export async function addApiRoots(env: Env, domains: string[], program: string, db: Db = new Db(env.DB)) {
  const slug = program.trim().toLowerCase() || "custom";
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
  const stmts: D1PreparedStatement[] = [
    db.stmt(
      `INSERT INTO programs (slug, name, platform, status) VALUES (?, ?, 'custom', 'ok')
       ON CONFLICT(slug) DO NOTHING`,
      slug,
      program.trim() || "Custom",
    ),
  ];
  for (const d of clean) {
    stmts.push(
      db.stmt(
        `INSERT INTO roots (domain, program_slug, source, status) VALUES (?, ?, 'api', 'pending')
         ON CONFLICT(domain) DO UPDATE SET source = 'api', program_slug = excluded.program_slug,
           status = CASE WHEN roots.status = 'removed' THEN 'pending' ELSE roots.status END`,
        d,
        slug,
      ),
    );
    stmts.push(enqueueStmt(db, "api_root", `api:${d}`, 2, { slug, domain: d } satisfies ApiRootPayload));
  }
  await db.batch(stmts);
  return { added: clean.length, program: slug };
}

/* ------------------------------------------------------------------ snapshot + cleanup */

export async function buildSnapshot(env: Env, db: Db = new Db(env.DB)) {
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const t = today();

  const [programs, perDay, rootStats] = await Promise.all([
    db.all<{ slug: string; platform: string; host_count: number; bounty: number; [k: string]: unknown }>(
      `SELECT slug, name, platform, program_url, zip_url, bounty, host_count, change, is_new,
              source_updated_at, checked_at, root_count, status FROM programs`,
    ),
    db.all<{ day: string; slug: string; new_subs: number }>(
      "SELECT day, slug, new_subs FROM program_daily WHERE day >= ?",
      since30,
    ),
    db.all<{ program_slug: string; status: string; n: number; hosts: number }>(
      "SELECT program_slug, status, COUNT(*) AS n, SUM(host_count) AS hosts FROM roots GROUP BY program_slug, status",
    ),
  ]);

  const agg = new Map<string, { today: number; d7: number; d30: number }>();
  for (const r of perDay) {
    const a = agg.get(r.slug) ?? { today: 0, d7: 0, d30: 0 };
    a.d30 += r.new_subs;
    if (r.day >= since7) a.d7 += r.new_subs;
    if (r.day === t) a.today += r.new_subs;
    agg.set(r.slug, a);
  }
  const roots = new Map<string, Record<string, number>>();
  const totals: Record<string, number> = {};
  let tracked = 0;
  for (const r of rootStats) {
    const m = roots.get(r.program_slug) ?? {};
    m[r.status] = (m[r.status] ?? 0) + r.n;
    roots.set(r.program_slug, m);
    totals[r.status] = (totals[r.status] ?? 0) + r.n;
    if (r.status === "ok") tracked += r.hosts ?? 0;
  }

  const list = programs.map((p) => {
    const a = agg.get(p.slug as string) ?? { today: 0, d7: 0, d30: 0 };
    const rs = roots.get(p.slug as string) ?? {};
    return { ...p, new_today: a.today, new_7d: a.d7, new_30d: a.d30, roots: rs };
  });

  const platforms = new Map<string, { platform: string; programs: number; hosts: number; bounty: number; new_7d: number }>();
  for (const p of list) {
    const key = (p.platform as string) || "other";
    const x = platforms.get(key) ?? { platform: key, programs: 0, hosts: 0, bounty: 0, new_7d: 0 };
    x.programs++;
    x.hosts += Number(p.host_count ?? 0);
    x.bounty += p.bounty ? 1 : 0;
    x.new_7d += p.new_7d;
    platforms.set(key, x);
  }

  const [queue, pending, codes] = await Promise.all([
    db.all<{ kind: string; n: number; running: number }>(
      "SELECT kind, COUNT(*) AS n, SUM(claimed_at IS NOT NULL) AS running FROM tasks GROUP BY kind",
    ),
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM subs WHERE probe_state = 0"),
    db.all<{ status_code: number | null; n: number }>(
      `SELECT status_code, COUNT(*) AS n FROM (SELECT status_code FROM subs WHERE live = 1 ORDER BY id DESC LIMIT 20000)
       GROUP BY status_code ORDER BY n DESC LIMIT 20`,
    ),
  ]);

  const overview = {
    generated_at: nowIso(),
    queue,
    probes_pending: pending?.n ?? 0,
    status_codes: codes,
    programs: list.length,
    dataset_hosts: list.reduce((s, p) => s + Number(p.host_count ?? 0), 0),
    tracked_hosts: tracked,
    roots: totals,
    platforms: [...platforms.values()].sort((a, b) => b.hosts - a.hosts),
  };

  await db.batch([
    db.setMetaStmt("snapshot_programs", JSON.stringify(list)),
    db.setMetaStmt("snapshot_overview", JSON.stringify(overview)),
  ]);
  return { programs: list.length };
}

export async function cleanup(env: Env, db: Db = new Db(env.DB)) {
  const days = num(env.RETENTION_DAYS, 60);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  await db.run(
    "DELETE FROM subs WHERE id IN (SELECT id FROM subs WHERE first_seen_at < ? ORDER BY id LIMIT 5000)",
    cutoff,
  );
  await db.run("DELETE FROM program_daily WHERE day < ?", cutoff.slice(0, 10));
  return { cutoff };
}
