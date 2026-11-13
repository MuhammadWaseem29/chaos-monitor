import { Db } from "./db";
import type { Env } from "./env";
import { today } from "./env";
import { addApiRoots, buildSnapshot, dispatch, refreshIndex } from "./engine";

const json = (data: unknown, status = 200, maxAge = 30) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });

const text = (body: string, maxAge = 120) =>
  new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });

const clampInt = (v: string | null, d: number, min: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};

const sinceHours = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const SUB_COLS =
  "id, host, root, program_slug, first_seen_at, probe_state, probed_at, status_code, title, webserver, cdn, ip, cname, final_url, tech, live, takeover, takeover_service, takeover_evidence, error";

async function metaJson<T>(db: Db, key: string, fallback: T): Promise<T> {
  const row = await db.first<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", key);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function overview(db: Db) {
  const snap = await metaJson<Record<string, unknown>>(db, "snapshot_overview", {});
  const days = await db.all<Record<string, number | string>>(
    "SELECT * FROM daily WHERE day >= ? ORDER BY day DESC",
    new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
  );
  const [takeovers, latest] = await Promise.all([
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT 1 FROM subs WHERE takeover = 1 LIMIT 1000)"),
    db.all(`SELECT ${SUB_COLS} FROM subs ORDER BY id DESC LIMIT 15`),
  ]);
  const t = today();
  const window = (n: number) => {
    const from = new Date(Date.now() - (n - 1) * 86400_000).toISOString().slice(0, 10);
    return days.filter((d) => String(d.day) >= from);
  };
  const sum = (k: string, n: number) => window(n).reduce((s, d) => s + Number(d[k] ?? 0), 0);
  return {
    ...snap,
    today: days.find((d) => d.day === t) ?? null,
    new_today: sum("new_subs", 1),
    new_7d: sum("new_subs", 7),
    new_30d: sum("new_subs", 30),
    live_7d: sum("live", 7),
    probed_7d: sum("probed", 7),
    takeovers: takeovers?.n ?? 0,
    latest,
  };
}

async function listSubs(db: Db, url: URL) {
  const view = url.searchParams.get("view") ?? "new";
  const hours = clampInt(url.searchParams.get("hours"), 24 * 7, 1, 24 * 365);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 500);
  const before = clampInt(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
  const program = url.searchParams.get("program")?.trim().toLowerCase();
  const root = url.searchParams.get("root")?.trim().toLowerCase();
  const q = url.searchParams.get("q")?.trim().toLowerCase();
  const code = url.searchParams.get("code");

  const where: string[] = ["first_seen_at >= ?"];
  const args: unknown[] = [sinceHours(hours)];
  if (view === "live") where.push("live = 1");
  if (view === "takeover") where.push("takeover = 1");
  if (view === "pending") where.push("probe_state = 0");
  if (view === "dead") where.push("probe_state = 2 AND live = 0");
  if (program) {
    where.push("program_slug = ?");
    args.push(program);
  }
  if (root) {
    where.push("root = ?");
    args.push(root);
  }
  if (q && q.length >= 2) {
    where.push("host LIKE ?");
    args.push(`%${q.replace(/[%_]/g, "")}%`);
  }
  if (code) {
    const c = Number(code);
    if (code.endsWith("xx")) {
      where.push("status_code BETWEEN ? AND ?");
      args.push(Number(code[0]) * 100, Number(code[0]) * 100 + 99);
    } else if (Number.isFinite(c)) {
      where.push("status_code = ?");
      args.push(c);
    }
  }
  if (before) {
    where.push("id < ?");
    args.push(before);
  }
  const rows = await db.all<{ id: number }>(
    `SELECT ${SUB_COLS} FROM subs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    ...args,
    limit,
  );
  return { rows, next: rows.length === limit ? rows[rows.length - 1]!.id : null };
}

async function rawList(db: Db, url: URL, kind: string) {
  const hours = clampInt(url.searchParams.get("hours"), 24, 1, 24 * 90);
  const program = url.searchParams.get("program")?.trim().toLowerCase();
  const where = ["first_seen_at >= ?"];
  const args: unknown[] = [sinceHours(hours)];
  if (kind === "live") where.push("live = 1");
  if (kind === "takeovers") where.push("takeover = 1");
  if (program) {
    where.push("program_slug = ?");
    args.push(program);
  }
  const rows = await db.all<{ host: string; final_url: string | null }>(
    `SELECT host, final_url FROM subs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 50000`,
    ...args,
  );
  return rows.map((r) => r.host).join("\n") + (rows.length ? "\n" : "");
}

function authorized(req: Request, env: Env) {
  const h = req.headers.get("authorization") ?? "";
  return Boolean(env.ADMIN_TOKEN) && h === `Bearer ${env.ADMIN_TOKEN}`;
}

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  }

  // Admin endpoints (never cached).
  if (path.startsWith("/api/admin/")) {
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    if (req.method !== "POST") return json({ error: "use POST" }, 405);
    const body = (await req.json().catch(() => ({}))) as { domains?: string[]; program?: string; what?: string };
    const adb = new Db(env.DB);
    let out: unknown;
    if (path === "/api/admin/roots") {
      if (!env.CHAOS_API_KEY) return json({ error: "set the CHAOS_API_KEY secret first" }, 400);
      out = await addApiRoots(env, body.domains ?? [], body.program ?? "custom", adb);
    } else if (path === "/api/admin/run") {
      if (body.what === "index") out = await refreshIndex(env, adb);
      else if (body.what === "snapshot") out = await buildSnapshot(env, adb);
      else return json(await dispatch(env), 200, 0); // dispatch flushes its own usage
    } else {
      return json({ error: "not found" }, 404);
    }
    await adb.flush();
    return json(out, 200, 0);
  }

  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  // Edge cache in front of D1 so page views do not eat the daily read budget.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const db = new Db(env.DB);
  let res: Response;
  const seg = path.split("/").filter(Boolean);

  try {
    if (path === "/api/overview") {
      res = json(await overview(db), 200, 30);
    } else if (path === "/api/programs") {
      res = json(await metaJson(db, "snapshot_programs", []), 200, 120);
    } else if (seg[0] === "api" && seg[1] === "programs" && seg[2]) {
      const slug = decodeURIComponent(seg[2]).toLowerCase();
      const program = await db.first("SELECT * FROM programs WHERE slug = ?", slug);
      if (!program) {
        res = json({ error: "program not found" }, 404);
      } else {
        const [roots, recent, days] = await Promise.all([
          db.all(
            "SELECT domain, source, host_count, raw_size, status, error, checked_at, changed_at, last_new FROM roots WHERE program_slug = ? ORDER BY host_count DESC LIMIT 2000",
            slug,
          ),
          db.all(`SELECT ${SUB_COLS} FROM subs WHERE program_slug = ? ORDER BY id DESC LIMIT 200`, slug),
          db.all("SELECT day, new_subs FROM program_daily WHERE slug = ? AND day >= ? ORDER BY day", slug,
            new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)),
        ]);
        res = json({ program, roots, recent, days }, 200, 60);
      }
    } else if (seg[0] === "api" && seg[1] === "roots" && seg[2]) {
      const domain = decodeURIComponent(seg[2]).toLowerCase();
      const root = await db.first(
        "SELECT r.*, p.name AS program_name, p.platform, p.zip_url FROM roots r LEFT JOIN programs p ON p.slug = r.program_slug WHERE r.domain = ?",
        domain,
      );
      if (!root) {
        res = json({ error: "root domain not found" }, 404);
      } else {
        const recent = await db.all(`SELECT ${SUB_COLS} FROM subs WHERE root = ? ORDER BY id DESC LIMIT 300`, domain);
        res = json({ root, recent }, 200, 60);
      }
    } else if (path === "/api/subs") {
      res = json(await listSubs(db, url), 200, 30);
    } else if (path === "/api/stats") {
      const days = await db.all(
        "SELECT * FROM daily WHERE day >= ? ORDER BY day",
        new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10),
      );
      res = json({ days }, 200, 300);
    } else if (path === "/api/health") {
      const m = await db.meta(["index_checked_at", "snapshot_at", "api_roots_at", "cleanup_day", "last_dispatch"]);
      const [usage, errors, snap] = await Promise.all([
        db.first("SELECT * FROM daily WHERE day = ?", today()),
        db.all("SELECT domain, program_slug, error, checked_at FROM roots WHERE status = 'error' LIMIT 50"),
        metaJson<{ queue?: unknown; probes_pending?: number; generated_at?: string; roots?: unknown }>(db, "snapshot_overview", {}),
      ]);
      res = json(
        {
          meta: m,
          usage,
          limits: { rows_written_per_day: 100_000, rows_read_per_day: 5_000_000, write_budget: Number(env.WRITE_BUDGET ?? 80_000) },
          queue: snap.queue ?? [],
          probes_pending: snap.probes_pending ?? 0,
          roots: snap.roots ?? {},
          snapshot_at: snap.generated_at ?? null,
          errors,
          features: {
            chaos_api: Boolean(env.CHAOS_API_KEY),
            alerts_discord: Boolean(env.DISCORD_WEBHOOK),
            alerts_telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          },
        },
        200,
        60,
      );
    } else if (path === "/raw/new.txt") {
      res = text(await rawList(db, url, "new"));
    } else if (path === "/raw/live.txt") {
      res = text(await rawList(db, url, "live"));
    } else if (path === "/raw/takeovers.txt") {
      res = text(await rawList(db, url, "takeovers"));
    } else if (path === "/raw/programs.json") {
      res = json(await metaJson(db, "snapshot_programs", []), 200, 300);
    } else {
      res = json({ error: "not found" }, 404);
    }
  } catch (err) {
    console.error("api error", path, err);
    return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  }

  if (res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
