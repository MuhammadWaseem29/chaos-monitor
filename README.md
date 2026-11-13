# Chaos — subdomain monitor on Cloudflare (free plan)

The original Lovable app (TanStack Start + Supabase) ported to run entirely on
**Cloudflare Workers + D1**, with the same pages, API and features:
programs, chaos updates, live/new/recent subdomains, live probing with takeover
checks, live map, stats, notes, email alerts, API keys and the v1 REST API.

## What changed vs. the Lovable version

| Area | Lovable | Here |
|---|---|---|
| Database | Supabase Postgres (~14M rows) | Cloudflare D1. Only *new* subdomains, probe results and app data are stored; full lists come live from Chaos with your API key (edge-cached 1h) |
| Change detection | every host re-saved each scan | per-root hash sets (`root_hashes`); only changes are written |
| Cron | pg_cron → `/api/public/hooks/scan` | Worker Cron Trigger every minute → `/api/internal/dispatch`, fanned out through a self service binding |
| Auth | Lovable/Supabase auth (Google + email) | email + password in D1 (`users`, `sessions`); the first account becomes admin |
| Email | Resend via the Lovable gateway | Resend API directly (`RESEND_API_KEY`) |
| Scan cycle | 2 hours | 4 hours (free-plan CPU/request limits; Chaos data refreshes ~daily) |

Free-plan guards: D1 writes are budgeted (`WRITE_BUDGET`), heavy domain-wide
counts come from a 30-minute snapshot, public reads are edge-cached, and
platform-wide full exports are paged (`X-Next-Cursor`, followed automatically
by the site's download buttons).

## Deploy

```bash
bun install
npx wrangler login
npx wrangler d1 create chaos-monitor         # put the id in wrangler.jsonc
npx wrangler d1 migrations apply chaos-monitor --remote
bun run deploy

openssl rand -hex 32 | npx wrangler secret put INTERNAL_KEY     # required
openssl rand -hex 24 | tee .admin-token | npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CHAOS_API_KEY        # ProjectDiscovery Cloud key
npx wrangler secret put SITE_URL             # e.g. https://your-worker.workers.dev
npx wrangler secret put RESEND_API_KEY       # optional: email alerts
npx wrangler secret put ALERT_FROM_EMAIL     # optional: verified sender in Resend
```

Root domains are added on the Monitor page (admin) or seeded with SQL
(`INSERT INTO domains (id, domain, platform_id) ...`).

Manual engine tick: `curl -X POST -H "Authorization: Bearer $(cat .admin-token)" https://<worker>/api/public/hooks/scan`
