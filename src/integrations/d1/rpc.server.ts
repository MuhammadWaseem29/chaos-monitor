// SQLite/D1 ports of the Lovable Postgres RPCs (same names, args and result shapes).
import { cfEnv, nowIso, track, uuid } from "./env.server";
import { registerRpcs, setFastCount, type RpcImpl } from "./executor.server";
import { labelOf, liveHosts } from "./chaos-live.server";

/* ------------------------------------------------------------------ helpers */

export async function sql<T = Record<string, any>>(query: string, ...params: unknown[]): Promise<T[]> {
  const r = await cfEnv().DB.prepare(query).bind(...params).all<T>();
  track(r.meta);
  return r.results ?? [];
}
export async function sql1<T = Record<string, any>>(query: string, ...params: unknown[]): Promise<T | null> {
  return (await sql<T>(query, ...params))[0] ?? null;
}
export async function run(query: string, ...params: unknown[]) {
  const r = await cfEnv().DB.prepare(query).bind(...params).run();
  track(r.meta);
  return r.meta;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3600_000;
const clamp = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Math.floor(Number(v ?? d));
  return Math.min(Math.max(Number.isFinite(n) ? n : d, lo), hi);
};
const like = (s: unknown) => `%${String(s).replace(/[%_]/g, "")}%`;
const has = (s: unknown) => typeof s === "string" && s.trim() !== "";

function bucketExpr(bucket: string, col: string) {
  switch (bucket) {
    case "hour":
      return `strftime('%Y-%m-%dT%H:00:00.000Z', ${col})`;
    case "week":
      return `strftime('%Y-%m-%dT00:00:00.000Z', ${col}, '-6 days', 'weekday 1')`;
    case "month":
      return `strftime('%Y-%m-01T00:00:00.000Z', ${col})`;
    default:
      return `strftime('%Y-%m-%dT00:00:00.000Z', ${col})`;
  }
}

/* ------------------------------------------------------------------ snapshot of domain-wide aggregates */

export type Agg = {
  generated_at: string;
  total_domains: number;
  enabled_domains: number;
  baselined: number;
  sum_total: number;
  platforms: Record<string, { domain_count: number; subdomain_count: number }>;
};

let aggMemo: { at: number; agg: Agg } | null = null;

/** Domain-wide totals, rebuilt by the engine every 30 minutes (22k-row scans are too costly per request). */
export async function getAgg(): Promise<Agg> {
  if (aggMemo && Date.now() - aggMemo.at < 30_000) return aggMemo.agg;
  const row = await sql1<{ value: string }>("SELECT value FROM meta WHERE key = 'agg'");
  let agg: Agg | null = null;
  try {
    agg = row?.value ? (JSON.parse(row.value) as Agg) : null;
  } catch {
    agg = null;
  }
  if (!agg) agg = await rebuildAgg();
  aggMemo = { at: Date.now(), agg };
  return agg;
}

export async function rebuildAgg(): Promise<Agg> {
  const [tot, plats] = await Promise.all([
    sql1<{ n: number; e: number; b: number; s: number }>(
      `SELECT COUNT(*) AS n, SUM(enabled) AS e, SUM(claimed_at IS NOT NULL) AS b, COALESCE(SUM(total_subdomains), 0) AS s FROM domains`,
    ),
    sql<{ platform_id: string | null; n: number; s: number }>(
      `SELECT platform_id, COUNT(*) AS n, COALESCE(SUM(total_subdomains), 0) AS s FROM domains GROUP BY platform_id`,
    ),
  ]);
  const agg: Agg = {
    generated_at: nowIso(),
    total_domains: Number(tot?.n ?? 0),
    enabled_domains: Number(tot?.e ?? 0),
    baselined: Number(tot?.b ?? 0),
    sum_total: Number(tot?.s ?? 0),
    platforms: Object.fromEntries(
      plats.map((p) => [p.platform_id ?? "none", { domain_count: Number(p.n), subdomain_count: Number(p.s) }]),
    ),
  };
  await run(
    "INSERT INTO meta (key, value) VALUES ('agg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(agg),
  );
  aggMemo = { at: Date.now(), agg };
  return agg;
}

/** What the engine is doing this minute (written once per dispatcher tick). */
export type EngineTick = {
  at: string;
  scan_workers: number;
  probe_workers: number;
  domains: Array<{ id: string; domain: string; platform_slug: string | null; platform_name: string | null; platform_color: string | null }>;
  cycle_started_at?: string;
};

export async function getTick(): Promise<EngineTick | null> {
  const row = await sql1<{ value: string }>("SELECT value FROM meta WHERE key = 'engine_tick'");
  try {
    const t = row?.value ? (JSON.parse(row.value) as EngineTick) : null;
    return t && Date.now() - Date.parse(t.at) < 120_000 ? t : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ discovery analytics */

const discovery_timeseries: RpcImpl = async ({ bucket, since }) =>
  sql(
    `SELECT ${bucketExpr(bucket, "first_seen_at")} AS ts, COUNT(*) AS new_subdomains
       FROM subdomains WHERE first_seen_at >= ? GROUP BY 1 ORDER BY 1`,
    since,
  );

const scan_timeseries: RpcImpl = async ({ bucket, since }) => {
  const [ranges, manual] = await Promise.all([
    sql<{ ts: string; scans: number; errors: number; new_found: number }>(
      `SELECT ${bucketExpr(bucket, "at")} AS ts, SUM(domains_count) AS scans, SUM(errors) AS errors, SUM(new_count) AS new_found
         FROM scan_ranges WHERE at >= ? GROUP BY 1`,
      since,
    ),
    sql<{ ts: string; scans: number; errors: number; new_found: number }>(
      `SELECT ${bucketExpr(bucket, "started_at")} AS ts, COUNT(*) AS scans, SUM(status = 'error') AS errors, COALESCE(SUM(new_count), 0) AS new_found
         FROM scans WHERE started_at >= ? AND trigger = 'manual' GROUP BY 1`,
      since,
    ),
  ]);
  const m = new Map<string, { ts: string; scans: number; errors: number; new_found: number }>();
  for (const r of [...ranges, ...manual]) {
    const x = m.get(r.ts) ?? { ts: r.ts, scans: 0, errors: 0, new_found: 0 };
    x.scans += Number(r.scans ?? 0);
    x.errors += Number(r.errors ?? 0);
    x.new_found += Number(r.new_found ?? 0);
    m.set(r.ts, x);
  }
  return [...m.values()].sort((a, b) => a.ts.localeCompare(b.ts));
};

const top_domains_by_new: RpcImpl = async ({ since, lim }) =>
  sql(
    `SELECT d.domain, COUNT(*) AS new_count FROM subdomains s JOIN domains d ON d.id = s.domain_id
      WHERE s.first_seen_at >= ? GROUP BY d.domain ORDER BY new_count DESC LIMIT ?`,
    since,
    clamp(lim, 10, 1, 50),
  );

const new_subdomain_counts: RpcImpl = async () =>
  sql(
    `SELECT SUM(first_seen_at > ?) AS last_hour, SUM(first_seen_at > ?) AS last_day, SUM(first_seen_at > ?) AS last_week,
            SUM(first_seen_at > ?) AS last_month, COUNT(*) AS last_half_year
       FROM subdomains WHERE first_seen_at > ?`,
    ago(H),
    ago(24 * H),
    ago(7 * 24 * H),
    ago(30 * 24 * H),
    ago(182 * 24 * H),
  ).then((r) => r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Number(v ?? 0)]))));

const count_new_subs: RpcImpl = async ({ since }) =>
  Number((await sql1<{ c: number }>("SELECT COUNT(*) AS c FROM subdomains WHERE first_seen_at >= ?", since))?.c ?? 0);

const new_subs_hour_heatmap: RpcImpl = async ({ since }) =>
  sql(
    `SELECT CAST(strftime('%w', first_seen_at) AS INTEGER) AS dow, CAST(strftime('%H', first_seen_at) AS INTEGER) AS hour, COUNT(*) AS c
       FROM subdomains WHERE first_seen_at >= ? GROUP BY 1, 2`,
    since,
  );

const new_subs_label_breakdown: RpcImpl = async ({ since, lim }) =>
  sql(
    `SELECT CASE WHEN instr(host, '.') > 0 THEN substr(host, 1, instr(host, '.') - 1) ELSE host END AS prefix, COUNT(*) AS c
       FROM subdomains WHERE first_seen_at >= ? GROUP BY 1 ORDER BY 2 DESC LIMIT ?`,
    since,
    clamp(lim, 15, 1, 60),
  );

const new_subs_page: RpcImpl = async ({ since, before_ts, before_id, lim }) =>
  sql(
    `SELECT s.id, s.host, d.domain, s.first_seen_at FROM subdomains s JOIN domains d ON d.id = s.domain_id
      WHERE s.first_seen_at >= ?
        AND (? IS NULL OR s.first_seen_at < ? OR (s.first_seen_at = ? AND ? IS NOT NULL AND s.id < ?))
      ORDER BY s.first_seen_at DESC, s.id DESC LIMIT ?`,
    since,
    before_ts ?? null,
    before_ts ?? null,
    before_ts ?? null,
    before_id ?? null,
    before_id ?? null,
    clamp(lim, 500, 1, 2000),
  );

const recent_subs_overview: RpcImpl = async ({ since }) => {
  const r = await sql1<Record<string, number | string | null>>(
    `SELECT COUNT(s.id) AS total_new, COUNT(DISTINCT d.platform_id) AS programs_active, COUNT(DISTINCT d.id) AS domains_active,
            MAX(s.first_seen_at) AS latest_at
       FROM subdomains s JOIN domains d ON d.id = s.domain_id WHERE s.first_seen_at >= ?`,
    since,
  );
  const hours = Math.max((Date.now() - Date.parse(since)) / H, 0.0166);
  const total = Number(r?.total_new ?? 0);
  return [{ ...r, total_new: total, per_hour: Math.round((total / hours) * 100) / 100 }];
};

const search_subdomains: RpcImpl = async ({ q, lim, off }) =>
  sql(
    `SELECT s.id, s.host, d.domain, s.first_seen_at, s.is_active = 1 AS is_active FROM subdomains s
       JOIN domains d ON d.id = s.domain_id WHERE s.host LIKE ? ORDER BY s.first_seen_at DESC LIMIT ? OFFSET ?`,
    like(q),
    clamp(lim, 100, 1, 1000),
    clamp(off, 0, 0, 1_000_000),
  ).then((rows) => rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) })));

/* ------------------------------------------------------------------ platforms */

const platform_stats: RpcImpl = async () => {
  const [agg, plats, fresh] = await Promise.all([
    getAgg(),
    sql<{ id: string; slug: string; name: string; color: string }>("SELECT id, slug, name, color FROM platforms ORDER BY name"),
    sql<{ platform_id: string | null; c: number }>(
      `SELECT d.platform_id, COUNT(*) AS c FROM subdomains s JOIN domains d ON d.id = s.domain_id
        WHERE s.first_seen_at > ? GROUP BY d.platform_id`,
      ago(24 * H),
    ),
  ]);
  const freshMap = new Map(fresh.map((f) => [f.platform_id, Number(f.c)]));
  return plats.map((p) => ({
    platform_id: p.id,
    slug: p.slug,
    name: p.name,
    color: p.color,
    domain_count: agg.platforms[p.id]?.domain_count ?? 0,
    subdomain_count: agg.platforms[p.id]?.subdomain_count ?? 0,
    new_24h: freshMap.get(p.id) ?? 0,
  }));
};

const platform_updates: RpcImpl = async ({ since }) =>
  sql(
    `SELECT p.id AS platform_id, p.slug, p.name, p.color, COUNT(s.id) AS new_count, COUNT(DISTINCT s.domain_id) AS domains_affected,
            MAX(s.first_seen_at) AS last_seen
       FROM subdomains s JOIN domains d ON d.id = s.domain_id JOIN platforms p ON p.id = d.platform_id
      WHERE s.first_seen_at >= ? GROUP BY p.id, p.slug, p.name, p.color ORDER BY 5 DESC`,
    since,
  );

const platform_recent_subdomains: RpcImpl = async ({ _platform_id, since, lim }) =>
  sql(
    `SELECT s.host, d.domain, s.first_seen_at FROM subdomains s JOIN domains d ON d.id = s.domain_id
      WHERE d.platform_id = ? AND s.first_seen_at >= ? ORDER BY s.first_seen_at DESC LIMIT ?`,
    _platform_id,
    since,
    clamp(lim, 100, 1, 1000),
  );

/* ------------------------------------------------------------------ per-domain (full lists come live from Chaos) */

async function domainRow(id: string) {
  return sql1<{ id: string; domain: string; claimed_at: string | null; created_at: string; total_subdomains: number }>(
    "SELECT id, domain, claimed_at, created_at, total_subdomains FROM domains WHERE id = ?",
    id,
  );
}

async function lastScanned(domain: string, fallback: string | null) {
  const r = await sql1<{ at: string }>(
    "SELECT at FROM scan_ranges WHERE start_domain <= ? AND end_domain >= ? ORDER BY at DESC LIMIT 1",
    domain,
    domain,
  );
  return r?.at ?? fallback;
}

type LiveSub = { id: string; host: string; label: string; first_seen_at: string | null; last_seen_at: string | null; is_active: boolean };

/** Full list for one domain: discovered rows (with real first_seen) + the rest of the live Chaos list. */
async function domainSubs(domainId: string): Promise<LiveSub[]> {
  const d = await domainRow(domainId);
  if (!d) return [];
  const [hosts, known, seen] = await Promise.all([
    liveHosts(d.domain).catch(() => [] as string[]),
    sql<{ id: string; host: string; label: string; first_seen_at: string; last_seen_at: string }>(
      "SELECT id, host, label, first_seen_at, last_seen_at FROM subdomains WHERE domain_id = ?",
      domainId,
    ),
    lastScanned(d.domain, d.claimed_at),
  ]);
  const baseline = d.claimed_at ?? d.created_at;
  const byHost = new Map(known.map((k) => [k.host, k]));
  const out: LiveSub[] = known
    .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at))
    .map((k) => ({ ...k, last_seen_at: seen ?? k.last_seen_at, is_active: true }));
  for (const h of hosts) {
    if (byHost.has(h)) continue;
    out.push({ id: h, host: h, label: labelOf(h, d.domain), first_seen_at: baseline, last_seen_at: seen, is_active: true });
  }
  return out;
}

function filterSubs(rows: LiveSub[], search?: string, filter?: string) {
  const s = has(search) ? String(search).toLowerCase() : "";
  const cutoff = ago(24 * H);
  return rows.filter(
    (r) =>
      (!s || r.host.includes(s)) &&
      (!filter || filter === "all" || (filter === "new" && (r.first_seen_at ?? "") > cutoff) || (filter === "inactive" && !r.is_active)),
  );
}

const domain_subdomains_page: RpcImpl = async ({ _domain_id, _search, _filter, _limit, _offset }) => {
  const rows = filterSubs(await domainSubs(_domain_id), _search, _filter);
  const off = clamp(_offset, 0, 0, 10_000_000);
  return rows.slice(off, off + clamp(_limit, 100, 1, 1000));
};

const domain_subdomains_count: RpcImpl = async ({ _domain_id, _search, _filter }) =>
  filterSubs(await domainSubs(_domain_id), _search, _filter).length;

const domain_subdomain_stats: RpcImpl = async ({ _domain_id }) => {
  const rows = await domainSubs(_domain_id);
  const d24 = ago(24 * H);
  const d7 = ago(7 * 24 * H);
  const fresh = await sql1<{ a: number; b: number }>(
    "SELECT SUM(first_seen_at > ?) AS a, SUM(first_seen_at > ?) AS b FROM subdomains WHERE domain_id = ?",
    d24,
    d7,
    _domain_id,
  );
  return [
    {
      total: rows.length,
      new_24h: Number(fresh?.a ?? 0),
      new_7d: Number(fresh?.b ?? 0),
      active: rows.length,
      inactive: 0,
      latest_seen: rows.reduce<string | null>((m, r) => (r.last_seen_at && (!m || r.last_seen_at > m) ? r.last_seen_at : m), null),
    },
  ];
};

const domain_new_subs: RpcImpl = async ({ _domain_id, since, lim }) =>
  sql(
    "SELECT id, host, first_seen_at FROM subdomains WHERE domain_id = ? AND first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT ?",
    _domain_id,
    since,
    clamp(lim, 500, 1, 2000),
  );

/** Live full lists for every domain of a platform, keyset-paged by (domain_id, host). */
export const PLATFORM_PAGE_FETCH_BUDGET = 30;
const platform_subdomains_page: RpcImpl = async ({ _platform_id, _after_domain, _after_host, _lim, _domain_filter }) => {
  const lim = clamp(_lim, 1000, 1, 10000);
  const doms = await sql<{ id: string; domain: string; claimed_at: string | null; created_at: string }>(
    `SELECT id, domain, claimed_at, created_at FROM domains
      WHERE platform_id = ? AND (? IS NULL OR id >= ?) AND (? IS NULL OR domain LIKE ?)
      ORDER BY id LIMIT ?`,
    _platform_id,
    _after_domain ?? null,
    _after_domain ?? null,
    has(_domain_filter) ? 1 : null,
    like(_domain_filter ?? ""),
    PLATFORM_PAGE_FETCH_BUDGET,
  );
  const out: Array<Record<string, unknown>> = [];
  let fetched = 0;
  for (const d of doms) {
    if (fetched >= PLATFORM_PAGE_FETCH_BUDGET) break;
    fetched++;
    const hosts = await liveHosts(d.domain).catch(() => [] as string[]);
    const after = d.id === _after_domain ? String(_after_host ?? "") : "";
    for (const h of hosts) {
      if (after && h <= after) continue;
      out.push({ domain_id: d.id, domain: d.domain, host: h, is_active: true, first_seen_at: d.claimed_at ?? d.created_at, last_seen_at: d.claimed_at });
      if (out.length >= lim) return out;
    }
  }
  // Partial page because of the per-request fetch budget: tag the last row so callers keep paging.
  if (out.length && doms.length >= PLATFORM_PAGE_FETCH_BUDGET) (out[out.length - 1] as Record<string, unknown>).__more = true;
  return out;
};

/* ------------------------------------------------------------------ chaos_updates table */

type UpdArgs = { _since?: string; _search?: string; _platform_id?: string; _keyword?: string; _only_new?: boolean };

async function newCounts(a: UpdArgs) {
  return sql<{ domain_id: string; c: number; last_seen: string }>(
    `SELECT domain_id, COUNT(*) AS c, MAX(first_seen_at) AS last_seen FROM subdomains
      WHERE first_seen_at >= ? AND (? IS NULL OR host LIKE ?) GROUP BY domain_id`,
    a._since ?? ago(24 * H),
    has(a._keyword) ? 1 : null,
    like(a._keyword ?? ""),
  );
}

const domainFilterSql = `(? IS NULL OR d.platform_id = ?) AND (? IS NULL OR d.domain LIKE ?)`;
const domainFilterArgs = (a: UpdArgs) => [
  a._platform_id ?? null,
  a._platform_id ?? null,
  has(a._search) ? 1 : null,
  like(a._search ?? ""),
];

const UPD_COLS = `d.id, d.domain, d.total_subdomains, d.last_scanned_at, d.platform_id, p.slug AS platform_slug, p.name AS platform_name, p.color AS platform_color`;

const domain_updates_page: RpcImpl = async (args) => {
  const a = args as UpdArgs & { _sort?: string; _dir?: string; _limit?: number; _offset?: number };
  const limit = clamp(a._limit, 50, 1, 1000);
  const offset = clamp(a._offset, 0, 0, 10_000_000);
  const counts = await newCounts(a);
  const cmap = new Map(counts.map((c) => [c.domain_id, c]));
  const ids = counts.map((c) => c.domain_id);

  // Domains that have new finds in the window (small set), filtered like the main query.
  const withNew = ids.length
    ? await sql<Record<string, any>>(
        `SELECT ${UPD_COLS} FROM domains d LEFT JOIN platforms p ON p.id = d.platform_id
          WHERE d.id IN (SELECT value FROM json_each(?)) AND ${domainFilterSql}`,
        JSON.stringify(ids),
        ...domainFilterArgs(a),
      )
    : [];
  const decorate = (r: Record<string, any>): Record<string, any> => ({
    ...r,
    new_count: cmap.get(r.id)?.c ?? 0,
    last_seen: cmap.get(r.id)?.last_seen ?? null,
  });
  const sort = a._sort ?? "new";
  const asc = a._dir === "asc";
  const cmp = (x: Record<string, any>, y: Record<string, any>) => {
    let v = 0;
    if (sort === "new") v = x.new_count - y.new_count;
    else if (sort === "total") v = x.total_subdomains - y.total_subdomains;
    else v = String(x.domain).localeCompare(String(y.domain));
    if (v !== 0) return asc ? v : -v;
    return y.total_subdomains - x.total_subdomains || String(x.domain).localeCompare(String(y.domain));
  };
  const seg1 = withNew.map(decorate).sort(cmp);

  if (a._only_new) return seg1.slice(offset, offset + limit);

  if (sort === "new" && !asc) {
    // New finds first, then everything else by size (index scan, stops at LIMIT).
    const page = seg1.slice(offset, offset + limit);
    if (page.length === limit) return page;
    const rest = await sql<Record<string, any>>(
      `SELECT ${UPD_COLS} FROM domains d LEFT JOIN platforms p ON p.id = d.platform_id
        WHERE ${domainFilterSql} AND d.id NOT IN (SELECT value FROM json_each(?))
        ORDER BY d.total_subdomains DESC, d.domain ASC LIMIT ? OFFSET ?`,
      ...domainFilterArgs(a),
      JSON.stringify(seg1.map((r) => r.id)),
      limit - page.length,
      Math.max(0, offset - seg1.length),
    );
    return [...page, ...rest.map(decorate)];
  }

  // Other sorts: order in SQL, then attach the new counts.
  const orderBy =
    sort === "domain" ? `d.domain ${asc ? "ASC" : "DESC"}` : sort === "total" ? `d.total_subdomains ${asc ? "ASC" : "DESC"}, d.domain ASC` : `d.total_subdomains DESC, d.domain ASC`;
  if (sort === "new" && asc) {
    // Zero-new rows first (by size), then rows with new finds ascending.
    const zeroTotal = Number(
      (
        await sql1<{ c: number }>(
          `SELECT COUNT(*) AS c FROM domains d WHERE ${domainFilterSql} AND d.id NOT IN (SELECT value FROM json_each(?))`,
          ...domainFilterArgs(a),
          JSON.stringify(seg1.map((r) => r.id)),
        )
      )?.c ?? 0,
    );
    const zero = offset < zeroTotal
      ? await sql<Record<string, any>>(
          `SELECT ${UPD_COLS} FROM domains d LEFT JOIN platforms p ON p.id = d.platform_id
            WHERE ${domainFilterSql} AND d.id NOT IN (SELECT value FROM json_each(?))
            ORDER BY d.total_subdomains DESC, d.domain ASC LIMIT ? OFFSET ?`,
          ...domainFilterArgs(a),
          JSON.stringify(seg1.map((r) => r.id)),
          limit,
          offset,
        )
      : [];
    const out = zero.map(decorate);
    if (out.length < limit) out.push(...seg1.slice(Math.max(0, offset - zeroTotal), Math.max(0, offset - zeroTotal) + limit - out.length));
    return out;
  }
  const rows = await sql<Record<string, any>>(
    `SELECT ${UPD_COLS} FROM domains d LEFT JOIN platforms p ON p.id = d.platform_id WHERE ${domainFilterSql}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...domainFilterArgs(a),
    limit,
    offset,
  );
  return rows.map(decorate);
};

async function filteredDomainTotals(a: UpdArgs) {
  if (!a._platform_id && !has(a._search)) {
    const agg = await getAgg();
    return { n: agg.total_domains, s: agg.sum_total };
  }
  if (a._platform_id && !has(a._search)) {
    const agg = await getAgg();
    const p = agg.platforms[a._platform_id];
    return { n: p?.domain_count ?? 0, s: p?.subdomain_count ?? 0 };
  }
  const r = await sql1<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.total_subdomains), 0) AS s FROM domains d WHERE ${domainFilterSql}`,
    ...domainFilterArgs(a),
  );
  return { n: Number(r?.n ?? 0), s: Number(r?.s ?? 0) };
}

async function newSummary(a: UpdArgs) {
  const counts = await newCounts(a);
  if (!counts.length) return { companies: 0, hosts: 0, total: 0 };
  const r = await sql1<{ n: number; s: number; ids: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(d.total_subdomains), 0) AS s, json_group_array(d.id) AS ids FROM domains d
      WHERE d.id IN (SELECT value FROM json_each(?)) AND ${domainFilterSql}`,
    JSON.stringify(counts.map((c) => c.domain_id)),
    ...domainFilterArgs(a),
  );
  const ids = new Set(JSON.parse(r?.ids ?? "[]") as string[]);
  return {
    companies: Number(r?.n ?? 0),
    hosts: counts.filter((c) => ids.has(c.domain_id)).reduce((s, c) => s + Number(c.c), 0),
    total: Number(r?.s ?? 0),
  };
}

const domain_updates_count: RpcImpl = async (a) => {
  if (a._only_new) return (await newSummary(a)).companies;
  return (await filteredDomainTotals(a)).n;
};

const domain_updates_summary: RpcImpl = async (a) => {
  const [n, all] = await Promise.all([newSummary(a), a._only_new ? null : filteredDomainTotals(a)]);
  return [
    {
      companies: a._only_new ? n.companies : all!.n,
      companies_with_new: n.companies,
      new_hosts: n.hosts,
      total_subdomains: a._only_new ? n.total : all!.s,
    },
  ];
};

/* ------------------------------------------------------------------ scan health / activity */

const domain_cycle_counts: RpcImpl = async ({ cycle_minutes }) => {
  const agg = await getAgg();
  const cyc = clamp(cycle_minutes, 120, 1, 10_000);
  const r = await sql1<{ n: number }>("SELECT COALESCE(SUM(domains_count), 0) AS n FROM scan_ranges WHERE at > ?", ago(cyc * 60_000));
  const scanned = Math.min(Number(r?.n ?? 0), agg.enabled_domains);
  return [{ total_domains: agg.enabled_domains, due_domains: Math.max(agg.enabled_domains - scanned, 0) }];
};

const scan_cycle_health: RpcImpl = async () => {
  const [agg, r, fresh, running, tick] = await Promise.all([
    getAgg(),
    sql1<{ s30: number; e1: number; newest: string | null; oldest: string | null }>(
      `SELECT SUM(CASE WHEN at > ? THEN domains_count ELSE 0 END) AS s30, SUM(CASE WHEN at > ? THEN errors ELSE 0 END) AS e1,
              MAX(at) AS newest, MIN(at) AS oldest FROM scan_ranges WHERE at > ?`,
      ago(30 * 60_000),
      ago(H),
      ago(4 * H),
    ),
    sql1<{ c: number }>("SELECT COUNT(*) AS c FROM subdomains WHERE first_seen_at > ?", ago(30 * 60_000)),
    sql1<{ c: number }>("SELECT COUNT(*) AS c FROM scans WHERE status = 'running'"),
    getTick(),
  ]);
  return [
    {
      total_domains: agg.enabled_domains,
      scanned_30m: Math.min(Number(r?.s30 ?? 0), agg.enabled_domains),
      never_scanned: Math.max(agg.enabled_domains - agg.baselined, 0),
      oldest_scan: r?.oldest ?? null,
      newest_scan: r?.newest ?? null,
      running_scans: Number(running?.c ?? 0) + (tick?.domains.length ?? 0),
      errors_1h: Number(r?.e1 ?? 0),
      new_subs_30m: Number(fresh?.c ?? 0),
    },
  ];
};

const running_scans_detail: RpcImpl = async ({ lim }) => {
  const max = clamp(lim, 50, 1, 200);
  const [manual, tick] = await Promise.all([
    sql(
      `SELECT s.id AS scan_id, d.domain, p.name AS platform_name, p.slug AS platform_slug, p.color AS platform_color, s.trigger, s.started_at
         FROM scans s JOIN domains d ON d.id = s.domain_id LEFT JOIN platforms p ON p.id = d.platform_id
        WHERE s.status = 'running' ORDER BY s.started_at ASC LIMIT ?`,
      max,
    ),
    getTick(),
  ]);
  const auto = (tick?.domains ?? []).map((d) => ({
    scan_id: `tick-${d.id}`,
    domain: d.domain,
    platform_name: d.platform_name,
    platform_slug: d.platform_slug,
    platform_color: d.platform_color,
    trigger: "cron",
    started_at: tick!.at,
  }));
  return [...manual, ...auto].slice(0, max).map((r: any) => ({
    ...r,
    elapsed_seconds: Math.max(0, (Date.now() - Date.parse(r.started_at)) / 1000),
  }));
};

const scan_activity_summary: RpcImpl = async () => {
  const [r, s, running, tick] = await Promise.all([
    sql1<{ c5: number }>("SELECT COALESCE(SUM(domains_count), 0) AS c5 FROM scan_ranges WHERE at > ?", ago(5 * 60_000)),
    sql1<{ n5: number; n60: number }>(
      "SELECT SUM(first_seen_at > ?) AS n5, COUNT(*) AS n60 FROM subdomains WHERE first_seen_at > ?",
      ago(5 * 60_000),
      ago(H),
    ),
    sql1<{ c: number }>("SELECT COUNT(*) AS c FROM scans WHERE status = 'running'"),
    getTick(),
  ]);
  return [
    {
      running: Number(running?.c ?? 0) + (tick?.domains.length ?? 0),
      claimed_5m: Number(r?.c5 ?? 0),
      finished_5m: Number(r?.c5 ?? 0),
      new_subs_5m: Number(s?.n5 ?? 0),
      new_subs_1h: Number(s?.n60 ?? 0),
    },
  ];
};

const mark_all_domains_due: RpcImpl = async () => {
  // Restart the rolling sweep from the first domain.
  await run(
    "INSERT INTO meta (key, value) VALUES ('scan_cursor', '') ON CONFLICT(key) DO UPDATE SET value = ''",
  );
  return (await getAgg()).enabled_domains;
};

const reconcile_scan_counts: RpcImpl = async () => 0;

const bump_daily_stats: RpcImpl = async ({ _new, _errors }) => {
  await run(
    `INSERT INTO daily_stats (id, day, new_subdomains, scans_run, scan_errors) VALUES (?, date('now'), ?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET new_subdomains = new_subdomains + excluded.new_subdomains,
       scans_run = scans_run + 1, scan_errors = scan_errors + excluded.scan_errors, updated_at = ?`,
    uuid(),
    Math.max(Number(_new ?? 0), 0),
    Math.max(Number(_errors ?? 0), 0),
    nowIso(),
  );
  return null;
};

/* ------------------------------------------------------------------ live probing */

const LIVE_JOIN = `FROM probe_results l JOIN domains d ON d.id = l.domain_id LEFT JOIN platforms p ON p.id = d.platform_id`;

const platform_live_stats: RpcImpl = async () =>
  sql(
    `SELECT d.platform_id, SUM(l.failed = 0) AS live_hosts, SUM(l.takeover_risk = 1 AND l.failed = 0) AS takeover_count
       FROM probe_results l JOIN domains d ON d.id = l.domain_id GROUP BY d.platform_id`,
  );

const live_program_stats: RpcImpl = async ({ _limit, _platform_slug }) =>
  sql(
    `SELECT d.domain, p.name AS platform_name, p.slug AS platform_slug, p.color AS platform_color,
            SUM(l.failed = 0) AS live_hosts, SUM(l.takeover_risk = 1) AS takeover_count,
            SUM(l.failed = 0 AND l.status_code BETWEEN 200 AND 299) AS ok_count,
            SUM(l.failed = 0 AND l.status_code IN (401, 403)) AS auth_count, MAX(l.probed_at) AS last_probed_at
       ${LIVE_JOIN} WHERE (? IS NULL OR p.slug = ?)
      GROUP BY d.domain, p.name, p.slug, p.color HAVING SUM(l.failed = 0) > 0 ORDER BY live_hosts DESC LIMIT ?`,
    _platform_slug ?? null,
    _platform_slug ?? null,
    clamp(_limit, 40, 1, 1000),
  );

const live_status_stats: RpcImpl = async ({ _platform_slug }) =>
  sql(
    `SELECT l.status_code, COUNT(*) AS c ${LIVE_JOIN}
      WHERE l.failed = 0 AND l.status_code IS NOT NULL AND (? IS NULL OR p.slug = ?)
      GROUP BY l.status_code ORDER BY c DESC`,
    _platform_slug ?? null,
    _platform_slug ?? null,
  );

const live_ip_points: RpcImpl = async ({ _limit, _platform_slug }) =>
  sql(
    `SELECT l.ip, COUNT(*) AS hosts, SUM(l.takeover_risk = 1) AS takeover_count, MIN(l.host) AS sample_host,
            MIN(d.domain) AS sample_domain, MIN(p.name) AS platform_name, MIN(p.color) AS platform_color
       ${LIVE_JOIN} WHERE l.failed = 0 AND l.ip IS NOT NULL AND l.ip <> '' AND (? IS NULL OR p.slug = ?)
      GROUP BY l.ip ORDER BY hosts DESC LIMIT ?`,
    _platform_slug ?? null,
    _platform_slug ?? null,
    clamp(_limit, 300, 1, 2000),
  );

const claim_probe_job: RpcImpl = async () => {
  const now = nowIso();
  const rows = await sql(
    `UPDATE probe_jobs SET status = 'running', claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = (SELECT id FROM probe_jobs
                   WHERE status = 'queued' OR (status = 'running' AND (claimed_at IS NULL OR claimed_at < ?) AND finished_at IS NULL)
                   ORDER BY created_at ASC LIMIT 1)
      RETURNING *`,
    now,
    now,
    now,
    ago(2 * 60_000),
  );
  return rows[0] ?? null;
};

const PROBE_COLS = [
  "domain_id", "host", "url", "final_url", "status_code", "title", "content_length", "content_type",
  "response_time_ms", "webserver", "technologies", "cdn", "ip", "asn", "cname", "redirect_chain",
  "tls_issuer", "tls_expires_at", "body_hash", "failed", "error", "takeover_risk", "takeover_service",
  "takeover_evidence",
];

const record_probe_batch: RpcImpl = async ({ _job_id, _results, _cursor_host, _done }) => {
  const rows = (Array.isArray(_results) ? _results : []) as Array<Record<string, any>>;
  const db = cfEnv().DB;
  const now = nowIso();
  const stmts = rows.map((r) => {
    const vals = PROBE_COLS.map((c) => {
      const v = r[c];
      if (c === "technologies" || c === "redirect_chain") return JSON.stringify(Array.isArray(v) ? v : []);
      if (typeof v === "boolean") return v ? 1 : 0;
      return v ?? null;
    });
    return db
      .prepare(
        `INSERT INTO probe_results (id, job_id, ${PROBE_COLS.join(", ")}, probed_at)
         VALUES (?, ?, ${PROBE_COLS.map(() => "?").join(", ")}, ?)
         ON CONFLICT (host) DO UPDATE SET job_id = excluded.job_id, ${PROBE_COLS.filter((c) => c !== "host")
           .map((c) => `${c} = excluded.${c}`)
           .join(", ")}, probed_at = excluded.probed_at`,
      )
      .bind(uuid(), _job_id, ...vals, now);
  });
  const live = rows.filter((r) => !r.failed).length;
  stmts.push(
    db
      .prepare(
        `UPDATE probe_jobs SET probed_hosts = probed_hosts + ?, live_hosts = live_hosts + ?, cursor_host = COALESCE(?, cursor_host),
           claimed_at = NULL, status = CASE WHEN ? THEN 'finished' ELSE 'running' END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`,
      )
      .bind(rows.length, live, _cursor_host ?? null, _done ? 1 : 0, _done ? 1 : 0, now, now, _job_id),
  );
  for (let i = 0; i < stmts.length; i += 100) {
    const rs = await db.batch(stmts.slice(i, i + 100));
    for (const r of rs) track(r.meta);
  }
  return null;
};

/* ------------------------------------------------------------------ API usage */

const api_usage_summary: RpcImpl = async ({ _user_id }) => {
  const rows = await sql<{ key_id: string; hour: string; requests: number; errors: number }>(
    "SELECT key_id, hour, requests, errors FROM api_request_logs WHERE user_id = ? AND hour >= ?",
    _user_id,
    ago(7 * 24 * H).slice(0, 13),
  );
  const h1 = new Date(Date.now() - H).toISOString().slice(0, 13);
  const h24 = ago(24 * H).slice(0, 13);
  const by = new Map<string, { key_id: string; requests_1h: number; requests_24h: number; requests_7d: number; last_request_at: string | null; e24: number }>();
  for (const r of rows) {
    const x = by.get(r.key_id) ?? { key_id: r.key_id, requests_1h: 0, requests_24h: 0, requests_7d: 0, last_request_at: null, e24: 0 };
    x.requests_7d += r.requests;
    if (r.hour >= h24) {
      x.requests_24h += r.requests;
      x.e24 += r.errors;
    }
    if (r.hour >= h1) x.requests_1h += r.requests;
    const at = `${r.hour}:00:00.000Z`;
    if (!x.last_request_at || at > x.last_request_at) x.last_request_at = at;
    by.set(r.key_id, x);
  }
  return [...by.values()].map(({ e24, ...x }) => ({
    ...x,
    error_rate_24h: x.requests_24h ? Math.round((1000 * e24) / x.requests_24h) / 10 : 0,
  }));
};

const api_rate_check: RpcImpl = async () => [{ used: 0, allowed: true, reset_at: new Date(Date.now() + 60_000).toISOString() }];

/* ------------------------------------------------------------------ registry */

export const PUBLIC_RPCS = [
  "discovery_timeseries", "scan_timeseries", "top_domains_by_new", "new_subdomain_counts", "count_new_subs",
  "new_subs_hour_heatmap", "new_subs_label_breakdown", "new_subs_page", "recent_subs_overview",
  "search_subdomains", "platform_stats", "platform_updates", "platform_recent_subdomains",
  "domain_subdomains_page", "domain_subdomains_count", "domain_subdomain_stats", "domain_new_subs",
  "domain_updates_page", "domain_updates_count", "domain_updates_summary", "domain_cycle_counts",
  "scan_cycle_health", "running_scans_detail", "scan_activity_summary", "platform_live_stats",
  "live_program_stats", "live_status_stats", "live_ip_points",
];

/** Registers every RPC with the executor. Explicit call: package.json has sideEffects:false. */
let registered = false;
export function ensureRpcs() {
  if (registered) return;
  registered = true;
  setFastCount(async (table, filters) => {
    if (table !== "domains") return null;
    const plain = filters.filter((f): f is Extract<typeof f, { col: string }> => "col" in f);
    if (plain.length !== filters.length) return null;
    const agg = await getAgg();
    if (plain.length === 0) return agg.total_domains;
    if (plain.length === 1) {
      const f = plain[0]!;
      if (f.col === "platform_id" && f.op === "eq" && !f.negate) return agg.platforms[String(f.val)]?.domain_count ?? 0;
      if (f.col === "last_scanned_at" && f.op === "is" && f.val === null && f.negate) return agg.baselined;
      if (f.col === "enabled" && f.op === "eq" && f.val === true) return agg.enabled_domains;
    }
    return null;
  });

  registerRpcs(
    {
      discovery_timeseries, scan_timeseries, top_domains_by_new, new_subdomain_counts, count_new_subs,
      new_subs_hour_heatmap, new_subs_label_breakdown, new_subs_page, recent_subs_overview, search_subdomains,
      platform_stats, platform_updates, platform_recent_subdomains, platform_subdomains_page,
      domain_subdomains_page, domain_subdomains_count, domain_subdomain_stats, domain_new_subs,
      domain_updates_page, domain_updates_count, domain_updates_summary, domain_cycle_counts,
      scan_cycle_health, running_scans_detail, scan_activity_summary, mark_all_domains_due,
      reconcile_scan_counts, bump_daily_stats, platform_live_stats, live_program_stats, live_status_stats,
      live_ip_points, claim_probe_job, record_probe_batch, api_usage_summary, api_rate_check,
    },
    PUBLIC_RPCS,
  );
}
