import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { fmt, programQuery, timeAgo } from "@/lib/api";
import { Card, ErrorBox, ExtLink, PageHeader, PlatformBadge, Skeleton, Stat, SubsTable } from "@/components/ui";

const STATUS_TONE: Record<string, string> = {
  ok: "text-success",
  too_large: "text-warning",
  error: "text-destructive",
  pending: "text-muted-foreground",
  removed: "text-muted-foreground line-through",
};

export default function ProgramPage() {
  const { slug = "" } = useParams();
  const { data, isLoading, error } = useQuery(programQuery(slug));

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const { program: p, roots, recent, days } = data;
  const live = recent.filter((r) => r.live).length;
  const risky = recent.filter((r) => r.takeover).length;

  return (
    <>
      <PageHeader eyebrow="Program" title={p.name}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <PlatformBadge platform={p.platform} />
          {p.bounty ? <span className="chip-mono text-success">paid bounty</span> : <span className="chip-mono">vdp</span>}
          {p.program_url && <ExtLink href={p.program_url}>Program page</ExtLink>}
          {p.zip_url && <ExtLink href={p.zip_url}>Full host list (.zip)</ExtLink>}
          <a href={`/raw/new.txt?program=${p.slug}&hours=720`} className="hover:underline">New hosts .txt</a>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Hosts in dataset" value={p.host_count} hint={`${fmt(p.root_count)} root domains`} />
        <Stat label="New (recent)" value={recent.length} hint={`checked ${timeAgo(p.checked_at)}`} />
        <Stat label="Live of recent" value={live} tone="success" />
        <Stat label="Takeover candidates" value={risky} tone={risky ? "danger" : undefined} />
      </div>

      {days.length > 0 && (
        <Card title="New subdomains per day" className="mt-6">
          <div className="h-44 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days}>
                <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" />
                <Tooltip cursor={{ fill: "var(--color-accent)" }} contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="new_subs" name="new" fill="var(--color-chart-5)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card title="Recently discovered" className="mt-6">
        <SubsTable rows={recent} showProgram={false} />
      </Card>

      <Card title={`Root domains · ${fmt(roots.length)}`} className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {["Domain", "Hosts", "Status", "Last change", "Checked"].map((h, i) => (
                  <th key={h} className={`label-mono py-2.5 font-normal text-muted-foreground ${i === 0 ? "px-5" : "px-3"} ${i === 1 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roots.map((r) => (
                <tr key={r.domain} className="row-sweep border-b border-border/60 last:border-0">
                  <td className="px-5 py-2 font-mono text-[13px]">
                    <Link to={`/domain/${r.domain}`} className="hover:underline">{r.domain}</Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(r.host_count)}</td>
                  <td className={`label-mono px-3 py-2 ${STATUS_TONE[r.status] ?? ""}`} title={r.error ?? (r.status === "too_large" ? "Too big for the free plan's per-run CPU limit" : "")}>
                    {r.status.replace("_", " ")}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.changed_at ? `+${r.last_new} · ${timeAgo(r.changed_at)}` : "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{timeAgo(r.checked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
