import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { fmt, rootQuery, timeAgo } from "@/lib/api";
import { Card, ErrorBox, ExtLink, PageHeader, PlatformBadge, Skeleton, Stat, SubsTable } from "@/components/ui";

export default function DomainPage() {
  const { domain = "" } = useParams();
  const { data, isLoading, error } = useQuery(rootQuery(domain));
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const { root: r, recent } = data;

  return (
    <>
      <PageHeader eyebrow="Root domain" title={<span className="font-mono">{r.domain}</span>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <PlatformBadge platform={r.platform} />
          <Link to={`/program/${r.program_slug}`} className="hover:underline">
            {r.program_name ?? r.program_slug}
          </Link>
          {r.zip_url && <ExtLink href={r.zip_url}>Full program list (.zip)</ExtLink>}
          <a href={`/raw/new.txt?hours=2160&program=${r.program_slug}`} className="hover:underline">Program new hosts .txt</a>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Known hosts" value={r.host_count} />
        <Stat label="Status" value={<span className="text-xl">{r.status.replace("_", " ")}</span>} hint={r.error ?? (r.status === "too_large" ? "Over the free plan's per-run size limit" : `source: ${r.source}`)} />
        <Stat label="Baseline" value={<span className="text-xl">{timeAgo(r.baseline_at)}</span>} hint={`checked ${timeAgo(r.checked_at)}`} />
        <Stat label="Last change" value={<span className="text-xl">{r.changed_at ? `+${fmt(r.last_new)}` : "—"}</span>} hint={r.changed_at ? timeAgo(r.changed_at) : "no new hosts yet"} />
      </div>

      <Card title="New hosts under this domain" className="mt-6">
        <SubsTable rows={recent} showProgram={false} />
      </Card>
    </>
  );
}
