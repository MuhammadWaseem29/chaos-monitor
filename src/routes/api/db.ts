import { createFileRoute } from "@tanstack/react-router";

// Browser data endpoint: runs the query objects built by the client shim
// (src/integrations/supabase/client.ts) with anon or per-user permissions.
// Public reads are cached at the edge so polling pages stay within D1's free reads.

const FAST_RPCS = new Set(["scan_activity_summary", "running_scans_detail", "scan_cycle_health"]);

function decode(q: string) {
  const b64 = q.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(b64 + "===".slice((b64.length + 3) % 4)))));
}

async function run(request: Request, query: unknown) {
  const { execute } = await import("@/integrations/d1/executor.server");
  (await import("@/integrations/d1/rpc.server")).ensureRpcs();
  const { bearer, userFromToken } = await import("@/integrations/d1/auth.server");
  const user = await userFromToken(bearer(request));
  const mode = user ? ({ kind: "user", userId: user.id } as const) : ({ kind: "anon" } as const);
  return { result: await execute(mode, query as never), user };
}

export const Route = createFileRoute("/api/db")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        let query: { kind?: string; fn?: string; table?: string };
        try {
          query = decode(url.searchParams.get("q") ?? "");
        } catch {
          return Response.json({ data: null, error: { message: "bad query" }, count: null }, { status: 400 });
        }
        if (query.kind !== "select" && query.kind !== "rpc") {
          return Response.json({ data: null, error: { message: "use POST for writes" }, count: null }, { status: 405 });
        }

        const authed = Boolean(request.headers.get("authorization"));
        const cache = (caches as unknown as { default: Cache }).default;
        const key = new Request(url.toString());
        if (!authed) {
          const hit = await cache.match(key);
          if (hit) return hit;
        }
        const { result, user } = await run(request, query);
        const ttl = query.kind === "rpc" && FAST_RPCS.has(query.fn ?? "") ? 5 : 15;
        const res = Response.json(result, {
          status: result.error ? 400 : 200,
          headers: { "cache-control": user ? "private, no-store" : `public, max-age=${ttl}` },
        });
        if (!user && !result.error) {
          const ctx = (globalThis as { __ctx__?: { waitUntil(p: Promise<unknown>): void } }).__ctx__;
          const p = cache.put(key, res.clone());
          if (ctx) ctx.waitUntil(p);
          else await p;
        }
        return res;
      },
      POST: async ({ request }) => {
        const query = await request.json().catch(() => null);
        if (!query) return Response.json({ data: null, error: { message: "bad query" }, count: null }, { status: 400 });
        const { result, user } = await run(request, query);
        if (!user && (query as { kind?: string }).kind !== "select" && (query as { kind?: string }).kind !== "rpc") {
          return Response.json({ data: null, error: { message: "Unauthorized" }, count: null }, { status: 401 });
        }
        return Response.json(result, { status: result.error ? 400 : 200, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
