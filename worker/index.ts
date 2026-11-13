import { handleApi } from "./api";
import { Db } from "./db";
import type { Env } from "./env";
import { buildSnapshot, cleanup, dispatch, enqueueApiRoots, probeTask, refreshIndex, runTask } from "./engine";

// Child invocations started by the dispatcher. They report their D1 usage back
// in the response instead of writing it, so stats cost one write per minute.
async function internal(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.INTERNAL_KEY || req.headers.get("x-internal-key") !== env.INTERNAL_KEY) {
    return new Response("forbidden", { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = new Db(env.DB);
  let result: unknown;
  try {
    switch (path) {
      case "/_internal/index":
        result = await refreshIndex(env, db);
        break;
      case "/_internal/snapshot":
        result = await buildSnapshot(env, db);
        break;
      case "/_internal/api-roots":
        result = await enqueueApiRoots(env, db);
        break;
      case "/_internal/cleanup":
        result = await cleanup(env, db);
        break;
      case "/_internal/task":
        result = await runTask(env, body as { id: number; kind: string; payload: string; attempts: number }, db);
        break;
      case "/_internal/probe":
        result = await probeTask(env, (body.items ?? []) as Array<{ id: number; host: string; program_slug: string }>, db);
        break;
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    console.error(path, err);
    db.counters.errors++;
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), usage: db.usage() }, { status: 500 });
  }
  return Response.json({ ok: true, result, usage: db.usage() });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_internal/")) return internal(req, env, url.pathname);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/raw/")) return handleApi(req, env, ctx);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      dispatch(env).then(
        (r) => console.log("dispatch", JSON.stringify(r)),
        (e) => console.error("dispatch failed", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
