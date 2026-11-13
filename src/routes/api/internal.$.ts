import { createFileRoute } from "@tanstack/react-router";

// Fan-out targets for the cron engine (called through the SELF service binding).
// Protected by INTERNAL_KEY; each call reports its D1 usage back to the dispatcher.
export const Route = createFileRoute("/api/internal/$")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { secret, withUsage } = await import("@/integrations/d1/env.server");
        const key = secret("INTERNAL_KEY");
        if (!key || request.headers.get("x-internal-key") !== key) return new Response("forbidden", { status: 403 });

        const action = (params as { _splat?: string })._splat ?? "";
        const body = (await request.json().catch(() => ({}))) as Record<string, any>;
        let result: unknown = null;
        let extra: Record<string, number> = {};
        const usage = { read: 0, written: 0 };
        try {
          const ran = await withUsage(async () => {
          (await import("@/integrations/d1/rpc.server")).ensureRpcs();
          switch (action) {
            case "dispatch": {
              const { dispatch } = await import("@/lib/engine.server");
              result = await dispatch();
              break;
            }
            case "scan": {
              const { scanGroup } = await import("@/lib/chaos.server");
              result = await scanGroup(body.domains ?? []);
              break;
            }
            case "manual": {
              const { runManualJob } = await import("@/lib/chaos.server");
              result = await runManualJob(String(body.id));
              break;
            }
            case "probe": {
              const { processProbeJobs } = await import("@/lib/probe.server");
              const r = await processProbeJobs(0);
              result = r;
              extra = { probed: r.probed };
              break;
            }
            case "alerts": {
              const { dispatchDueAlerts } = await import("@/lib/alerts.server");
              result = await dispatchDueAlerts(20_000);
              break;
            }
            case "agg": {
              const { rebuildAgg } = await import("@/integrations/d1/rpc.server");
              result = await rebuildAgg();
              break;
            }
            case "cleanup": {
              const { cleanup } = await import("@/lib/engine.server");
              result = await cleanup();
              break;
            }
            default:
              throw new Error(`unknown internal action: ${action}`);
          }
          });
          usage.read = ran.usage.read;
          usage.written = ran.usage.written;
        } catch (e) {
          console.error("internal", action, e);
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), usage: { ...usage } }, { status: 500 });
        }
        return Response.json({ ok: true, result, usage: { ...usage, ...extra } });
      },
    },
  },
});
