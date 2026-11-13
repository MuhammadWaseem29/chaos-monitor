import { createFileRoute } from "@tanstack/react-router";

// Manual trigger for a few probe batches (the Worker cron already runs probes every minute).
// Requires: Authorization: Bearer <ADMIN_TOKEN>  (or x-cron-secret: <ADMIN_TOKEN>).
export const Route = createFileRoute("/api/public/hooks/probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { secret } = await import("@/integrations/d1/env.server");
        const token = secret("ADMIN_TOKEN");
        const supplied =
          request.headers.get("x-cron-secret") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!token || supplied !== token) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const url = new URL(request.url);
        const workers = Math.min(Math.max(Number(url.searchParams.get("workers") ?? 3) || 3, 1), 6);
        const { callInternal } = await import("@/lib/engine.server");
        const { ensureAutoProbeJob } = await import("@/lib/probe.server");
        await ensureAutoProbeJob();
        const runs = await Promise.all(Array.from({ length: workers }, () => callInternal("probe", {})));
        const probed = runs.reduce((s, r) => s + (r.result?.probed ?? 0), 0);
        return Response.json({ ok: true, workers, probed, jobs: runs.map((r) => r.result?.jobId ?? null) });
      },
    },
  },
});
