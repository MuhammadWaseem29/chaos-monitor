// Places the Worker entry (app + cron) next to nitro's Cloudflare output.
import { copyFileSync, existsSync, rmSync } from "node:fs";

if (!existsSync(".output/server/index.mjs")) {
  console.error("nitro output missing: run `vite build` first");
  process.exit(1);
}
copyFileSync("worker/entry.mjs", ".output/server/worker.mjs");
// nitro writes a redirect config that would make wrangler ignore wrangler.jsonc.
rmSync(".wrangler/deploy/config.json", { force: true });
console.log("worker entry -> .output/server/worker.mjs");
