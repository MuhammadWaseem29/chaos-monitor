import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { fmt, overviewQuery, platformLabel, PLATFORM_COLORS, timeAgo } from "@/lib/api";
import { Card, EASE, Skeleton, Stat, SubsTable } from "@/components/ui";

export default function Home() {
  const { data, isLoading } = useQuery(overviewQuery);
  const roots = data?.roots ?? {};
  const totalRoots = Object.values(roots).reduce((a, b) => a + b, 0);
  const pending = (roots.pending ?? 0) + (data?.queue?.reduce((s, q) => s + q.n, 0) ?? 0);

  return (
    <div className="space-y-12">
      <section className="relative -mx-4 -mt-10 overflow-hidden border-b border-border px-4 pb-14 pt-16 sm:-mx-5 sm:px-5">
        <div className="hero-grid pointer-events-none absolute -inset-24 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_70%)]" />
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="relative mx-auto max-w-3xl text-center"
        >
          <span className="chip-mono">
            <span className="live-dot" /> live · checked every 30 minutes
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-6xl">New subdomains, as they appear.</h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
            Tracks every public bug bounty program in the Chaos dataset, flags hosts that weren't there before, then checks
            whether they're live and whether they look like a subdomain takeover.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/new" className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Latest subdomains <ArrowRight className="size-4" />
            </Link>
            <Link to="/live?view=takeover" className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-accent">
              Takeover candidates
            </Link>
          </div>
        </motion.div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <Stat label="New today" value={data?.new_today ?? 0} hint={`${fmt(data?.new_7d)} in 7 days`} />
            <Stat label="Live (7d)" value={data?.live_7d ?? 0} hint={`${fmt(data?.probed_7d)} probed`} tone="success" />
            <Stat label="Takeover candidates" value={data?.takeovers ?? 0} hint="dangling CNAMEs / unclaimed pages" tone={data?.takeovers ? "danger" : undefined} />
            <Stat label="Programs" value={data?.programs ?? 0} hint={`${fmt(data?.dataset_hosts)} hosts in dataset`} />
          </>
        )}
      </section>

      {totalRoots > 0 && (roots.ok ?? 0) < totalRoots * 0.98 && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          First pass in progress: {fmt(roots.ok)} of {fmt(totalRoots)} root domains have a baseline. {fmt(pending)} still queued.
          Hosts only count as "new" once their root domain has a baseline.
        </div>
      )}

      <Card
        title="Just discovered"
        action={
          <Link to="/new" className="story-link text-sm text-muted-foreground hover:text-foreground">
            View all
          </Link>
        }
      >
        <SubsTable rows={data?.latest ?? []} loading={isLoading} />
      </Card>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Platforms">
          <div className="divide-y divide-border">
            {(data?.platforms ?? []).map((p) => {
              const max = Math.max(...(data?.platforms ?? []).map((x) => x.hosts), 1);
              return (
                <Link key={p.platform} to={`/programs?platform=${p.platform}`} className="row-sweep block px-5 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{platformLabel(p.platform)}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {fmt(p.programs)} programs · {fmt(p.hosts)} hosts · +{fmt(p.new_7d)} 7d
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full" style={{ width: `${(p.hosts / max) * 100}%`, background: PLATFORM_COLORS[p.platform] ?? PLATFORM_COLORS.other }} />
                  </div>
                </Link>
              );
            })}
            {!data?.platforms?.length && <p className="px-5 py-8 text-center text-sm text-muted-foreground">Waiting for the first snapshot…</p>}
          </div>
        </Card>
        <Card title="How it works">
          <ol className="space-y-3 p-5 text-sm text-muted-foreground">
            <li><span className="font-mono text-foreground">01</span> Every 30 min the Chaos index is checked for programs that changed.</li>
            <li><span className="font-mono text-foreground">02</span> Only changed root domains are downloaded (byte ranges, not whole zips) and compared with what was seen before.</li>
            <li><span className="font-mono text-foreground">03</span> New hosts get a DNS + HTTP probe: status, title, CDN, tech, CNAME.</li>
            <li><span className="font-mono text-foreground">04</span> CNAMEs pointing at unclaimed or dead third-party services are flagged as takeover candidates.</li>
          </ol>
          <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">Snapshot {timeAgo(data?.generated_at)}</p>
        </Card>
      </section>
    </div>
  );
}
