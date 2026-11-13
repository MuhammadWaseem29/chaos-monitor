// Cloudflare Worker entry: the nitro-built TanStack Start app plus the cron.
// Copied next to the nitro output at build time (scripts/postbuild.mjs).
import app from "./index.mjs";

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  // Every minute: one engine tick (rolling Chaos sweep, manual scans, probes, alerts).
  scheduled(_event, env, ctx) {
    const req = new Request("https://internal.chaos/api/internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": env.INTERNAL_KEY ?? "" },
      body: "{}",
    });
    ctx.waitUntil(
      app
        .fetch(req, env, ctx)
        .then(async (res) => console.log("dispatch", res.status, (await res.text()).slice(0, 400)))
        .catch((e) => console.error("dispatch failed", e)),
    );
  },
};
