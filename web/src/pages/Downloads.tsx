import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { fmt, programsQuery } from "@/lib/api";
import { Card, Input, PageHeader, PlatformBadge } from "@/components/ui";

const FEEDS = [
  { href: "/raw/new.txt?hours=24", label: "New subdomains · last 24 hours", note: "one host per line" },
  { href: "/raw/new.txt?hours=168", label: "New subdomains · last 7 days", note: "one host per line" },
  { href: "/raw/live.txt?hours=168", label: "Live new hosts · last 7 days", note: "responded to HTTP(S)" },
  { href: "/raw/takeovers.txt?hours=720", label: "Takeover candidates · last 30 days", note: "verify before reporting" },
  { href: "/raw/programs.json", label: "Program list with counts", note: "JSON" },
];

export default function Downloads() {
  const { data } = useQuery(programsQuery);
  const [q, setQ] = useState("");
  const list = useMemo(
    () =>
      (data ?? [])
        .filter((p) => p.zip_url && p.host_count > 0)
        .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => b.host_count - a.host_count),
    [data, q],
  );

  return (
    <>
      <PageHeader eyebrow="Downloads" title="Lists & exports">
        Plain-text feeds for your recon tools (no login, no token). Full host lists for each program come straight from
        ProjectDiscovery's public Chaos dataset.
      </PageHeader>

      <Card title="Feeds">
        <div className="divide-y divide-border">
          {FEEDS.map((f) => (
            <a key={f.href} href={f.href} className="row-sweep flex items-center justify-between gap-3 px-5 py-3 text-sm">
              <span>
                <span className="font-medium">{f.label}</span>
                <span className="ml-2 text-muted-foreground">{f.note}</span>
              </span>
              <code className="hidden font-mono text-xs text-muted-foreground sm:block">{f.href}</code>
            </a>
          ))}
        </div>
        <div className="border-t border-border bg-terminal px-5 py-4 font-mono text-[13px] text-terminal-foreground">
          <span className="text-terminal-muted">$</span> curl -s {location.origin}/raw/new.txt?hours=24 | httpx -silent
        </div>
      </Card>

      <Card
        title={`Full program lists · ${fmt(list.length)}`}
        className="mt-6"
        action={<Input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-44" />}
      >
        <div className="max-h-[560px] divide-y divide-border overflow-y-auto">
          {list.map((p) => (
            <a key={p.slug} href={p.zip_url!} className="row-sweep flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span className="flex min-w-0 items-center gap-3">
                <Download className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{p.name}</span>
                <PlatformBadge platform={p.platform} />
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmt(p.host_count)} hosts</span>
            </a>
          ))}
        </div>
      </Card>
    </>
  );
}
