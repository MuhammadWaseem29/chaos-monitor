# Chaos Monitor (Cloudflare free plan)

A free, self-hosted feed of **newly discovered subdomains** across every public bug bounty program in
[ProjectDiscovery's Chaos dataset](https://chaos.projectdiscovery.io), with live-host probing and
subdomain-takeover checks. Everything (site, API, database, cron) runs on **Cloudflare Workers + D1 free tier**,
with no server and no card.

## How it works

```
cron (every minute) ── dispatcher ──┬─ /_internal/index     every 30 min: read Chaos index.json, find changed programs
                                    ├─ /_internal/task ×20   program: read zip directory via HTTP Range, diff CRCs per root
                                    │                        root: download one root's list (Range), diff against known hashes
                                    ├─ /_internal/probe ×6   DNS (DoH) + HTTP(S) probe of new hosts, takeover heuristics
                                    ├─ /_internal/snapshot   every 30 min: precomputed program/overview stats
                                    └─ /_internal/cleanup    daily: drop discoveries older than RETENTION_DAYS
```

* Each unit of work runs as its **own Worker invocation** (self service binding), so each one gets a fresh
  free-plan budget (10 ms CPU, 50 subrequests).
* Program archives are never downloaded whole. The Worker reads the zip's central directory from the end of the
  file and fetches only root domains whose CRC changed.
* Known hosts are stored as sorted 53-bit hashes (8 bytes/host) in D1, so "what's new?" is a binary search.
* Only **new** hosts are stored as rows, which keeps D1 under 100k writes/day. A write budget
  (`WRITE_BUDGET`) pauses scanning until midnight UTC if it's hit.
* Page views are served from the edge cache, so visitors don't use up D1 reads.

### Free-plan limits you should know

| Limit | Effect |
|---|---|
| 10 ms CPU per invocation | Root domains with more than `MAX_RAW_BYTES` of hosts (~15k hosts) are marked **too large** and skipped. Their full lists are still linked from the Chaos zips. |
| 100k D1 writes/day | First baseline takes a few days; after that only changed roots are touched. |
| Baseline | A root's hosts only count as "new" after its first (baseline) pass. |
| 50 subrequests | Probe batches are 8 hosts; no TLS/ASN details. |

## Deploy your own

```bash
npm install
npx wrangler login
npx wrangler d1 create chaos-monitor          # put the id into wrangler.jsonc
npx wrangler d1 migrations apply chaos-monitor --remote
npm run deploy

openssl rand -hex 32 | npx wrangler secret put INTERNAL_KEY   # required
openssl rand -hex 24 | tee .admin-token | npx wrangler secret put ADMIN_TOKEN
```

Optional secrets:

| Secret | What it enables |
|---|---|
| `CHAOS_API_KEY` | Add your own root domains (not in the public dataset) via `POST /api/admin/roots` |
| `DISCORD_WEBHOOK` | Alerts for new subdomains and takeover candidates |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Same alerts on Telegram |

Set `ALERT_PROGRAMS` in `wrangler.jsonc` (comma-separated program slugs) to only alert on programs you hunt.

### Add your own root domains

```bash
curl -X POST https://<your-worker>/api/admin/roots \
  -H "Authorization: Bearer $(cat .admin-token)" \
  -d '{"program":"my-targets","domains":["example.com"]}'
```

## API

See `/docs` on the deployed site. Highlights:

* `GET /raw/new.txt?hours=24` – new hosts, one per line
* `GET /raw/live.txt` · `GET /raw/takeovers.txt`
* `GET /api/subs?view=new|live|takeover&program=&q=&hours=&before=`

## Local development

```bash
npx wrangler dev            # API + cron on :8787
npm run dev:web             # UI on :5173, proxies /api to :8787
```

Takeover results are heuristics. Always verify by hand, and stay inside each program's scope.
