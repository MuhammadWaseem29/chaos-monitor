import { createFileRoute } from "@tanstack/react-router";

// Manual trigger for one engine tick (the Worker cron runs it every minute).
// Requires: Authorization: Bearer <ADMIN_TOKEN>  (or x-cron-secret: <ADMIN_TOKEN>).
export const Route = createFileRoute("/api/public/hooks/scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { secret } = await import("@/integrations/d1/env.server");
        const token = secret("ADMIN_TOKEN");
        const supplied =
          request.headers.get("x-cron-secret") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!token || supplied !== token) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const { callInternal } = await import("@/lib/engine.server");
        const r = await callInternal("dispatch", {});
        return Response.json({ ok: r.ok, ...(r.result ?? {}) });
      },
    },
  },
});
