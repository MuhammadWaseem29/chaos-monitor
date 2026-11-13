import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { fmt, healthQuery, timeAgo } from "@/lib/api";
import { Card, ErrorBox, PageHeader, Skeleton, Stat } from "@/components/ui";

function Meter({ label, used, max, hint }: { label: string; used: number; max: number; hint?: string }) {
  const pct = Math.min(100, (used / max) * 100);
  const tone = pct > 90 ? "bg-destructive" : pct > 70 ? "bg-warning" : "bg-success";
  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {fmt(used)} / {fmt(max)} · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function Status() {
  const { data, isLoading, error } = useQuery(healthQuery);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const u = data.usage;
  const queued = data.queue.reduce((s, q) => s + q.n, 0);
  const roots = data.roots ?? {};

  return (
    <>
      <PageHeader eyebrow="Status" title="Engine status">
        Everything runs inside Cloudflare's free limits. When today's D1 write budget is used up, scanning pauses until
        midnight UTC and resumes on its own.
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tasks queued" value={queued} hint={data.queue.map((q) => `${q.kind}: ${fmt(q.n)}`).join(" · ") || "idle"} />
        <Stat label="Probes queued" value={data.probes_pending} />
        <Stat label="Roots baselined" value={roots.ok ?? 0} hint={`${fmt(roots.pending)} pending · ${fmt(roots.too_large)} too large`} />
        <Stat label="Errors today" value={u?.errors ?? 0} tone={u?.errors ? "danger" : undefined} />
      </div>

      <Card title="Free-plan budget (today, UTC)" className="mt-6">
        <div className="divide-y divide-border">
          <Meter label="D1 rows written" used={u?.rows_written ?? 0} max={data.limits.rows_written_per_day} hint={`Scanning pauses at ${fmt(data.limits.write_budget)}; probes continue a little longer.`} />
          <Meter label="D1 rows read" used={u?.rows_read ?? 0} max={data.limits.rows_read_per_day} hint="Counted by the engine only. Page views are cached at the edge." />
          <Meter label="Engine runs today (one per minute)" used={u?.invocations ?? 0} max={1440} hint="Each run starts up to 20 scan tasks and 6 probe batches as separate invocations (free limit: 100,000 requests/day)." />
        </div>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Schedule">
          <dl className="divide-y divide-border text-sm">
            {[
              ["Chaos index checked", data.meta.index_checked_at],
              ["Snapshot rebuilt", data.meta.snapshot_at],
              ["Custom roots queued", data.meta.api_roots_at],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-5 py-2.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{timeAgo(v)}</dd>
              </div>
            ))}
            <div className="flex justify-between px-5 py-2.5">
              <dt className="text-muted-foreground">Today</dt>
              <dd className="font-mono text-xs">
                {fmt(u?.roots_checked)} roots · {fmt(u?.new_subs)} new · {fmt(u?.probed)} probed
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Features">
          <ul className="divide-y divide-border text-sm">
            {[
              ["Custom root domains (Chaos API key)", data.features.chaos_api],
              ["Discord alerts", data.features.alerts_discord],
              ["Telegram alerts", data.features.alerts_telegram],
            ].map(([k, on]) => (
              <li key={String(k)} className="flex items-center justify-between px-5 py-2.5">
                <span>{k}</span>
                {on ? <Check className="size-4 text-success" /> : <X className="size-4 text-muted-foreground" />}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {data.errors.length > 0 && (
        <Card title="Root domains with errors" className="mt-6">
          <div className="divide-y divide-border text-sm">
            {data.errors.map((e) => (
              <div key={e.domain} className="px-5 py-2.5">
                <span className="font-mono">{e.domain}</span>
                <span className="ml-3 text-destructive">{e.error}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
