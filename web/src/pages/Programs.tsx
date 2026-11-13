import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fmt, platformLabel, programsQuery, timeAgo, type Program } from "@/lib/api";
import { Card, Empty, ErrorBox, Input, PageHeader, PlatformBadge, Seg, Skeleton } from "@/components/ui";

type Sort = "new_7d" | "new_today" | "host_count" | "name";

export default function Programs() {
  const { data, isLoading, error } = useQuery(programsQuery);
  const [params, setParams] = useSearchParams();
  const platform = params.get("platform") ?? "all";
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("new_7d");
  const [bountyOnly, setBountyOnly] = useState(false);

  const platforms = useMemo(() => [...new Set((data ?? []).map((p) => p.platform))].sort(), [data]);
  const rows = useMemo(() => {
    let r = (data ?? []) as Program[];
    if (platform !== "all") r = r.filter((p) => p.platform === platform);
    if (bountyOnly) r = r.filter((p) => p.bounty);
    const s = q.trim().toLowerCase();
    if (s) r = r.filter((p) => p.name.toLowerCase().includes(s) || p.slug.includes(s));
    return [...r].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : (b[sort] as number) - (a[sort] as number) || b.host_count - a.host_count,
    );
  }, [data, platform, q, sort, bountyOnly]);

  return (
    <>
      <PageHeader eyebrow="Programs" title="Bug bounty programs">
        Every program in the public Chaos dataset. Sort by recent discoveries to see who is shipping new infrastructure.
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input placeholder="Search programs…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-64" />
        <select
          value={platform}
          onChange={(e) => {
            const v = e.target.value;
            setParams(v === "all" ? {} : { platform: v });
          }}
          className="h-9 rounded-full border border-input bg-background px-3 text-sm"
        >
          <option value="all">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {platformLabel(p)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={bountyOnly} onChange={(e) => setBountyOnly(e.target.checked)} /> Paid bounty only
        </label>
        <div className="sm:ml-auto">
          <Seg<Sort>
            value={sort}
            onChange={setSort}
            options={[
              { value: "new_7d", label: "New 7d" },
              { value: "new_today", label: "Today" },
              { value: "host_count", label: "Hosts" },
              { value: "name", label: "A–Z" },
            ]}
          />
        </div>
      </div>

      {error ? (
        <ErrorBox error={error} />
      ) : (
        <Card title={`${fmt(rows.length)} programs`}>
          {isLoading ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty>No programs match.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    {["Program", "Platform", "Hosts", "Today", "7 days", "30 days", "Checked"].map((h, i) => (
                      <th key={h} className={`label-mono py-2.5 font-normal text-muted-foreground ${i === 0 ? "px-5" : "px-3"} ${i >= 2 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 1000).map((p) => (
                    <tr key={p.slug} className="row-sweep border-b border-border/60 last:border-0">
                      <td className="px-5 py-2.5">
                        <Link to={`/program/${p.slug}`} className="font-medium hover:underline">
                          {p.name}
                        </Link>
                        {p.bounty ? <span className="label-mono ml-2 text-success">$</span> : null}
                        {p.is_new ? <span className="label-mono ml-2 text-brand">new</span> : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <PlatformBadge platform={p.platform} />
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmt(p.host_count)}</td>
                      <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${p.new_today ? "font-semibold text-success" : "text-muted-foreground"}`}>
                        {p.new_today ? `+${fmt(p.new_today)}` : "0"}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${p.new_7d ? "" : "text-muted-foreground"}`}>{fmt(p.new_7d)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(p.new_30d)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-muted-foreground">{timeAgo(p.checked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
