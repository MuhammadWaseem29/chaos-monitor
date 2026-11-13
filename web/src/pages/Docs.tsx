import { Card, PageHeader } from "@/components/ui";

const ENDPOINTS: Array<{ path: string; desc: string; params?: string }> = [
  { path: "GET /api/overview", desc: "Headline numbers, platforms, latest 15 discoveries." },
  { path: "GET /api/programs", desc: "All programs with host counts and new-subdomain counts (today / 7d / 30d)." },
  { path: "GET /api/programs/{slug}", desc: "One program: root domains, recent discoveries, per-day counts." },
  { path: "GET /api/roots/{domain}", desc: "One root domain and its recent discoveries." },
  {
    path: "GET /api/subs",
    desc: "Paginated discoveries, newest first. Pass `next` back as `before` for the next page.",
    params: "view=new|live|takeover|dead|pending · hours · program · root · q · code=200|4xx · limit≤500 · before",
  },
  { path: "GET /api/stats", desc: "Per-day totals (new, probed, live, takeovers)." },
  { path: "GET /api/health", desc: "Queue, free-plan usage and recent errors." },
  { path: "GET /raw/new.txt", desc: "Plain host list.", params: "hours (≤2160) · program" },
  { path: "GET /raw/live.txt", desc: "New hosts that answered HTTP(S).", params: "hours · program" },
  { path: "GET /raw/takeovers.txt", desc: "Takeover candidates.", params: "hours · program" },
];

export default function Docs() {
  const origin = location.origin;
  return (
    <>
      <PageHeader eyebrow="API" title="Public API">
        Read-only JSON and text endpoints with no key. Responses are cached at the edge for 30 seconds to a few minutes.
      </PageHeader>

      <Card title="Endpoints">
        <div className="divide-y divide-border">
          {ENDPOINTS.map((e) => (
            <div key={e.path} className="px-5 py-3">
              <code className="font-mono text-sm font-medium">{e.path}</code>
              <p className="mt-1 text-sm text-muted-foreground">{e.desc}</p>
              {e.params && <p className="mt-1 font-mono text-xs text-muted-foreground">{e.params}</p>}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Examples" className="mt-6">
        <pre className="overflow-x-auto bg-terminal p-5 font-mono text-[13px] leading-6 text-terminal-foreground">
{`# new hosts in the last hour, then probe them yourself
curl -s "${origin}/raw/new.txt?hours=1" | httpx -silent -title -sc

# takeover candidates for one program as JSON
curl -s "${origin}/api/subs?view=takeover&program=example&hours=720"

# add your own root domains (needs the CHAOS_API_KEY secret on the Worker)
curl -X POST "${origin}/api/admin/roots" \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -d '{"program":"my-targets","domains":["example.com","example.org"]}'`}
        </pre>
      </Card>
    </>
  );
}
