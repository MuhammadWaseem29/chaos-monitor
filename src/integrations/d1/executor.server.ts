// Runs the JSON queries produced by postgrest.ts against Cloudflare D1.
import { cfEnv, nowIso, track, uuid } from "./env.server";
import { fail, ok, type Filter, type PgResult, type Query, type RpcCall } from "./postgrest";
import {
  BOOL_COLS,
  HAS_UPDATED_AT,
  JSON_COLS,
  PUBLIC_TABLES,
  RELS,
  USER_TABLES,
  UUID_PK,
  virtualColumn,
} from "./schema.server";

export type Mode = { kind: "admin" } | { kind: "anon" } | { kind: "user"; userId: string };

const DOMAIN_COLS = [
  "id", "domain", "enabled", "last_scanned_at", "last_scan_status", "total_subdomains",
  "new_subdomains_last_scan", "created_at", "updated_at", "platform_id", "claimed_at",
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`invalid identifier: ${s}`);
  return `"${s}"`;
};

/* ------------------------------------------------------------------ select parsing */

type Node = { col?: string; rel?: string; inner?: boolean; children?: Node[]; star?: boolean };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(s: string): Node[] {
  return splitTop(s.replace(/\s+/g, " ")).map((tok) => {
    if (tok === "*") return { star: true } as Node;
    const m = /^([a-z_]+)(!inner)?(?:!\w+)?\s*\((.*)\)$/s.exec(tok);
    if (m) return { rel: m[1]!, inner: Boolean(m[2]), children: parseSelect(m[3]!) } as Node;
    const col = tok.includes(":") ? tok.split(":").pop()!.trim() : tok;
    return { col } as Node;
  });
}

/* ------------------------------------------------------------------ value conversion */

function toDb(table: string, col: string, v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (JSON_COLS[table]?.includes(col)) return v === null ? null : JSON.stringify(v);
  if (v !== null && typeof v === "object" && !(v instanceof ArrayBuffer)) return JSON.stringify(v);
  return v;
}

function fromDb(table: string, row: Record<string, unknown>) {
  for (const c of BOOL_COLS[table] ?? []) if (c in row && row[c] !== null) row[c] = Boolean(row[c]);
  for (const c of JSON_COLS[table] ?? []) {
    if (c in row && typeof row[c] === "string") {
      try {
        row[c] = JSON.parse(row[c] as string);
      } catch {
        /* leave as text */
      }
    }
  }
  return row;
}

const filterVal = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

/* ------------------------------------------------------------------ SQL builder */

type Ctx = {
  params: unknown[];
  joins: string[];
  aliases: Map<string, { alias: string; table: string }>; // path -> alias
  cols: string[];
  shape: Array<{ path: string; table: string }>;
  n: number;
};

function colExpr(ctx: Ctx, ref: string): string {
  const parts = ref.split(".");
  const col = parts.pop()!;
  const path = parts.join(".");
  const a = ctx.aliases.get(path);
  if (!a) throw new Error(`unknown relation in filter: ${ref}`);
  return virtualColumn(a.table, col, a.alias) ?? `${a.alias}.${q(col)}`;
}

function addSelect(ctx: Ctx, table: string, path: string, nodes: Node[]) {
  const { alias } = ctx.aliases.get(path)!;
  const prefix = path ? `${path.replace(/\./g, "__")}__` : "";
  for (const n of nodes) {
    if (n.star) {
      if (table === "domains") {
        for (const c of DOMAIN_COLS) ctx.cols.push(`${virtualColumn(table, c, alias) ?? `${alias}.${q(c)}`} AS "${prefix}${c}"`);
      } else if (!path) {
        ctx.cols.push(`${alias}.*`);
      } else {
        throw new Error("'*' is not supported inside embedded resources");
      }
    } else if (n.col) {
      ctx.cols.push(`${virtualColumn(table, n.col, alias) ?? `${alias}.${q(n.col)}`} AS "${prefix}${n.col}"`);
    } else if (n.rel) {
      const fk = RELS[table]?.[n.rel];
      if (!fk) throw new Error(`no relationship ${table} -> ${n.rel}`);
      const childAlias = `t${ctx.n++}`;
      const childPath = path ? `${path}.${n.rel}` : n.rel;
      ctx.aliases.set(childPath, { alias: childAlias, table: n.rel });
      ctx.joins.push(`${n.inner ? "JOIN" : "LEFT JOIN"} ${q(n.rel)} ${childAlias} ON ${childAlias}."id" = ${alias}.${q(fk)}`);
      ctx.shape.push({ path: childPath, table: n.rel });
      addSelect(ctx, n.rel, childPath, n.children ?? []);
    }
  }
}

function filterSql(ctx: Ctx, table: string, f: Filter): string {
  if ("or" in f) {
    const parts = splitTop(f.or).map((p) => {
      const i1 = p.indexOf(".");
      const i2 = p.indexOf(".", i1 + 1);
      const col = p.slice(0, i1);
      let op = p.slice(i1 + 1, i2);
      let raw: unknown = p.slice(i2 + 1);
      let negate = false;
      if (op === "not") {
        const i3 = p.indexOf(".", i2 + 1);
        op = p.slice(i2 + 1, i3);
        raw = p.slice(i3 + 1);
        negate = true;
      }
      if (raw === "null") raw = null;
      else if (raw === "true") raw = true;
      else if (raw === "false") raw = false;
      else if (op === "in" && typeof raw === "string") raw = raw.replace(/^\(|\)$/g, "").split(",");
      return filterSql(ctx, table, { col, op: op as never, val: raw, negate });
    });
    return `(${parts.join(" OR ")})`;
  }
  const e = colExpr(ctx, f.col);
  let sql: string;
  const v = filterVal(f.val);
  switch (f.op) {
    case "eq":
      if (v === null) sql = `${e} IS NULL`;
      else {
        ctx.params.push(v);
        sql = `${e} = ?`;
      }
      break;
    case "neq":
      ctx.params.push(v);
      sql = `${e} != ?`;
      break;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
      ctx.params.push(v);
      sql = `${e} ${sym} ?`;
      break;
    }
    case "like":
    case "ilike":
      ctx.params.push(String(v).replace(/\*/g, "%"));
      sql = `${e} LIKE ?`;
      break;
    case "is":
      sql = v === null ? `${e} IS NULL` : `${e} = ${v ? 1 : 0}`;
      break;
    case "in":
      ctx.params.push(JSON.stringify((f.val as unknown[]).map(filterVal)));
      sql = `${e} IN (SELECT value FROM json_each(?))`;
      break;
    default:
      throw new Error(`unsupported filter operator: ${String(f.op)}`);
  }
  return f.negate ? `NOT (${sql})` : sql;
}

function shapeRow(table: string, raw: Record<string, unknown>, shape: Ctx["shape"]) {
  const row: Record<string, unknown> = {};
  const nested: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = k.lastIndexOf("__");
    if (idx < 0) row[k] = v;
    else (nested[k.slice(0, idx)] ??= {})[k.slice(idx + 2)] = v;
  }
  fromDb(table, row);
  // Deepest paths first so children attach before parents are null-checked.
  for (const s of [...shape].sort((a, b) => b.path.length - a.path.length)) {
    const key = s.path.replace(/\./g, "__");
    const obj = nested[key] ?? {};
    for (const [ck, cv] of Object.entries(nested)) {
      if (ck.startsWith(`${key}__`) && !ck.slice(key.length + 2).includes("__")) obj[ck.slice(key.length + 2)] = cv;
    }
    const allNull = Object.values(obj).every((v) => v === null);
    nested[key] = allNull ? (null as never) : fromDb(s.table, obj);
  }
  for (const s of shape) if (!s.path.includes(".")) row[s.path] = nested[s.path] ?? null;
  return row;
}

/* ------------------------------------------------------------------ execution */

async function all(sql: string, params: unknown[]) {
  const r = await cfEnv().DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
  track(r.meta);
  return r.results ?? [];
}

function scope(mode: Mode, query: Query): Query {
  if (mode.kind === "admin") return query;
  const owner = USER_TABLES[query.table];
  if (mode.kind === "user" && owner) {
    const filters = [...query.filters, { col: owner, op: "eq" as const, val: mode.userId }];
    let values = query.values;
    if ((query.kind === "insert" || query.kind === "upsert") && values) {
      const force = (r: Record<string, unknown>) => ({ ...r, [owner]: mode.userId });
      values = Array.isArray(values) ? values.map(force) : force(values);
    }
    return { ...query, filters, values } as Query;
  }
  if (query.kind === "select" && PUBLIC_TABLES.has(query.table)) return query;
  throw new Error(`permission denied for table ${query.table}`);
}

function applySingle(rows: unknown[], single: Query["single"]): PgResult {
  if (!single) return ok(rows);
  if (rows.length === 1) return ok(rows[0]);
  if (rows.length === 0 && single === "maybe") return ok(null);
  return { ...fail("JSON object requested, multiple (or no) rows returned", "PGRST116", 406) };
}

async function runSelect(query: Query): Promise<PgResult> {
  const ctx: Ctx = { params: [], joins: [], aliases: new Map([["", { alias: "t0", table: query.table }]]), cols: [], shape: [], n: 1 };
  const nodes = parseSelect(query.columns || "*");
  addSelect(ctx, query.table, "", nodes);
  const from = `FROM ${q(query.table)} t0 ${ctx.joins.join(" ")}`;
  const where = query.filters.map((f) => filterSql(ctx, query.table, f));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const whereParams = [...ctx.params];

  let count: number | null = null;
  const fast = query.count && REG.fastCount ? await REG.fastCount(query.table, query.filters) : null;
  if (fast !== null && fast !== undefined) {
    count = fast;
  } else if (query.count) {
    if (query.table === "subdomains" && query.count !== "exact" && where.length === 0) {
      // "Subdomains stored": the full lists are not stored, so report what the scans returned.
      const r = await all("SELECT COALESCE(SUM(total_subdomains), 0) AS c FROM domains", []);
      count = Number(r[0]?.c ?? 0);
    } else {
      const r = await all(`SELECT COUNT(*) AS c ${from} ${whereSql}`, whereParams);
      count = Number(r[0]?.c ?? 0);
    }
  }
  if (query.head) return ok(null, count);

  const orderSql = query.order.length
    ? `ORDER BY ${query.order
        .map((o) => {
          const nullsFirst = o.nullsFirst ?? !o.asc;
          return `${colExpr(ctx, o.col)} ${o.asc ? "ASC" : "DESC"} NULLS ${nullsFirst ? "FIRST" : "LAST"}`;
        })
        .join(", ")}`
    : "";
  const limit = query.limit ?? 1000;
  const params = [...whereParams, limit, query.offset ?? 0];
  const rows = await all(`SELECT ${ctx.cols.join(", ")} ${from} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`, params);
  const shaped = rows.map((r) => shapeRow(query.table, r, ctx.shape));
  const res = applySingle(shaped, query.single);
  res.count = count;
  return res;
}

function prepareRow(table: string, row: Record<string, unknown>, isInsert: boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  if (isInsert && UUID_PK.has(table) && out.id == null) out.id = uuid();
  return out;
}

async function runWrite(query: Query): Promise<PgResult> {
  const db = cfEnv().DB;
  const t = query.table;
  const returning = query.returning !== undefined;

  if (query.kind === "insert" || query.kind === "upsert") {
    const rows = (Array.isArray(query.values) ? query.values : [query.values ?? {}]).map((r) =>
      prepareRow(t, r as Record<string, unknown>, true),
    );
    if (!rows.length) return ok(returning ? [] : null);
    const conflict = (query.onConflict ?? "id").split(",").map((s) => s.trim());
    const stmts = rows.map((r) => {
      const keys = Object.keys(r);
      let sql = `INSERT INTO ${q(t)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
      if (query.kind === "upsert") {
        const upd = keys.filter((k) => !conflict.includes(k) && k !== "id");
        if (HAS_UPDATED_AT.has(t) && !keys.includes("updated_at")) upd.push("updated_at");
        sql +=
          query.ignoreDuplicates || upd.length === 0
            ? ` ON CONFLICT (${conflict.map(q).join(", ")}) DO NOTHING`
            : ` ON CONFLICT (${conflict.map(q).join(", ")}) DO UPDATE SET ${upd
                .map((k) => (k === "updated_at" && !keys.includes(k) ? `"updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')` : `${q(k)} = excluded.${q(k)}`))
                .join(", ")}`;
      }
      if (returning) sql += " RETURNING *";
      return db.prepare(sql).bind(...keys.map((k) => toDb(t, k, r[k])));
    });
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < stmts.length; i += 100) {
      const rs = await db.batch<Record<string, unknown>>(stmts.slice(i, i + 100));
      for (const r of rs as Array<{ meta: any; results?: Record<string, unknown>[] }>) {
        track(r.meta);
        out.push(...(r.results ?? []));
      }
    }
    if (!returning) return ok(null);
    return applySingle(out.map((r) => pick(t, r, query.returning!)), query.single);
  }

  const ctx: Ctx = { params: [], joins: [], aliases: new Map([["", { alias: "t0", table: t }]]), cols: [], shape: [], n: 1 };
  if (query.kind === "update") {
    const vals = prepareRow(t, (query.values ?? {}) as Record<string, unknown>, false);
    const keys = Object.keys(vals);
    if (HAS_UPDATED_AT.has(t) && !keys.includes("updated_at")) {
      keys.push("updated_at");
      vals.updated_at = nowIso();
    }
    if (!keys.length) return ok(null);
    const setParams = keys.map((k) => toDb(t, k, vals[k]));
    const where = query.filters.map((f) => filterSql(ctx, t, f));
    const sql = `UPDATE ${q(t)} AS t0 SET ${keys.map((k) => `${q(k)} = ?`).join(", ")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}${returning ? " RETURNING *" : ""}`;
    const rows = await all(sql, [...setParams, ...ctx.params]);
    if (!returning) return ok(null);
    return applySingle(rows.map((r) => pick(t, r, query.returning!)), query.single);
  }

  // delete
  const where = query.filters.map((f) => filterSql(ctx, t, f));
  if (!where.length) throw new Error("refusing DELETE without filters");
  const rows = await all(`DELETE FROM ${q(t)} AS t0 WHERE ${where.join(" AND ")}${returning ? " RETURNING *" : ""}`, ctx.params);
  if (!returning) return ok(null);
  return applySingle(rows.map((r) => pick(t, r, query.returning!)), query.single);
}

function pick(table: string, row: Record<string, unknown>, cols: string) {
  fromDb(table, row);
  if (!cols || cols.trim() === "*") return row;
  const out: Record<string, unknown> = {};
  for (const c of splitTop(cols)) if (c in row) out[c] = row[c];
  return out;
}

export type RpcImpl = (args: Record<string, any>, mode: Mode) => Promise<unknown>;

// Shared through globalThis: the bundler may duplicate this module into several
// chunks, and every copy must see the same RPC registry.
type FastCount = (table: string, filters: Filter[]) => Promise<number | null>;
type Registry = { impls: Record<string, RpcImpl>; public: Set<string>; fastCount: FastCount | null };
const REG: Registry = ((globalThis as { __d1Registry?: Registry }).__d1Registry ??= {
  impls: {},
  public: new Set<string>(),
  fastCount: null,
});

/** Optional shortcut for counts that would scan a whole large table (set by rpc.server). */
export function setFastCount(fn: FastCount | null) {
  REG.fastCount = fn;
}

export function registerRpcs(impls: Record<string, RpcImpl>, publicNames: string[]) {
  Object.assign(REG.impls, impls);
  for (const n of publicNames) REG.public.add(n);
}

export async function execute(mode: Mode, call: Query | RpcCall): Promise<PgResult> {
  try {
    if (call.kind === "rpc") {
      const impl = REG.impls[call.fn];
      if (!impl) return fail(`function ${call.fn} does not exist`, "PGRST202", 404);
      if (mode.kind !== "admin" && !REG.public.has(call.fn)) return fail(`permission denied for function ${call.fn}`, "42501", 403);
      return ok(await impl(call.args ?? {}, mode));
    }
    const query = scope(mode, call);
    return query.kind === "select" ? await runSelect(query) : await runWrite(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[d1]", call.kind === "rpc" ? call.fn : `${call.kind} ${call.table}`, message);
    return fail(message);
  }
}
