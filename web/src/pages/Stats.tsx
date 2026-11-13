import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, overviewQuery, programsQuery, statsQuery } from "@/lib/api";
import { Card, PageHeader, PlatformBadge, Skeleton, Stat } from "@/components/ui";

const tip = { background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 };

export default function Stats() {
  const stats = useQuery(statsQuery);
  const ov = useQuery(overviewQuery);
  const programs = useQuery(programsQuery);
  const days = stats.data?.days ?? [];
  const top = [...(programs.data ?? [])].sort((a, b) => b.new_7d - a.new_7d).filter((p) => p.new_7d > 0).slice(0, 15);
  const codes = (ov.data?.status_codes ?? []).map((c) => ({ code: String(c.status_code ?? "?"), n: c.n }));

  return (
    <>
      <PageHeader eyebrow="Stats" title="Discovery stats">
        Daily totals since this monitor started.
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New (30d)" value={ov.data?.new_30d ?? 0} />
        <Stat label="Probed (7d)" value={ov.data?.probed_7d ?? 0} />
        <Stat label="Hosts tracked" value={ov.data?.tracked_hosts ?? 0} hint="with a baseline" />
        <Stat label="Root domains" value={Object.values(ov.data?.roots ?? {}).reduce((a, b) => a + b, 0)} hint={`${fmt(ov.data?.roots?.too_large)} too large for free plan`} />
      </div>

      <Card title="New subdomains per day" className="mt-6">
        <div className="h-64 p-4">
          {stats.isLoading ? (
            <Skeleton className="h-full" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={days}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-chart-5)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-chart-5)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" width={44} />
                <Tooltip contentStyle={tip} />
                <Area type="monotone" dataKey="new_subs" name="new" stroke="var(--color-chart-5)" fill="url(#g)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Probed vs live per day">
          <div className="h-56 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" width={40} />
                <Tooltip contentStyle={tip} cursor={{ fill: "var(--color-accent)" }} />
                <Bar dataKey="probed" fill="var(--color-chart-2)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="live" fill="var(--color-success)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Status codes (recent live hosts)">
          <div className="h-56 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={codes} layout="vertical">
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="code" width={40} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" />
                <Tooltip contentStyle={tip} cursor={{ fill: "var(--color-accent)" }} />
                <Bar dataKey="n" name="hosts" fill="var(--color-chart-1)" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="Most active programs (7 days)" className="mt-6">
        {top.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No new subdomains yet. Check back after the first pass finishes.</p>
        ) : (
          <div className="divide-y divide-border">
            {top.map((p) => (
              <Link key={p.slug} to={`/program/${p.slug}`} className="row-sweep flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="flex items-center gap-3">
                  <span className="font-medium">{p.name}</span>
                  <PlatformBadge platform={p.platform} />
                </span>
                <span className="font-mono tabular-nums text-success">+{fmt(p.new_7d)}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
