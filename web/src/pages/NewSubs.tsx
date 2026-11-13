import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SubsFeed } from "@/components/feed";
import { Input, PageHeader, Seg } from "@/components/ui";

const WINDOWS = [
  { value: "1", label: "1h" },
  { value: "24", label: "24h" },
  { value: "168", label: "7d" },
  { value: "720", label: "30d" },
  { value: "1440", label: "60d" },
];

function useDebounced<T>(v: T, ms = 400) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function NewSubs() {
  const [params, setParams] = useSearchParams();
  const hours = params.get("hours") ?? "24";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [program, setProgram] = useState(params.get("program") ?? "");
  const dq = useDebounced(q);
  const dp = useDebounced(program);

  useEffect(() => {
    const next: Record<string, string> = { hours };
    if (dq) next.q = dq;
    if (dp) next.program = dp;
    setParams(next, { replace: true });
  }, [dq, dp, hours, setParams]);

  return (
    <>
      <PageHeader eyebrow="Feed" title="New subdomains">
        Hosts that appeared in a program's Chaos list since the last check. A blue dot means the name contains a
        keyword like <span className="font-mono">dev</span>, <span className="font-mono">admin</span> or{" "}
        <span className="font-mono">staging</span>.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Seg value={hours} onChange={(v) => setParams({ ...Object.fromEntries(params), hours: v })} options={WINDOWS} />
        <Input placeholder="Filter host (e.g. api, dev)…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-60" />
        <Input placeholder="Program slug…" value={program} onChange={(e) => setProgram(e.target.value)} className="w-full sm:w-44" />
        <a href={`/raw/new.txt?hours=${hours}${dp ? `&program=${dp}` : ""}`} className="text-sm text-muted-foreground hover:text-foreground sm:ml-auto">
          raw .txt ↗
        </a>
      </div>
      <SubsFeed
        title="Discovered"
        filename={`new-subdomains-${hours}h.txt`}
        filter={{ view: "new", hours: Number(hours), q: dq || undefined, program: dp.toLowerCase() || undefined }}
      />
    </>
  );
}
