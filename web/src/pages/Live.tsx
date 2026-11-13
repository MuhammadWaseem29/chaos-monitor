import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { overviewQuery, type SubsFilter } from "@/lib/api";
import { SubsFeed } from "@/components/feed";
import { PageHeader, Seg } from "@/components/ui";

type View = NonNullable<SubsFilter["view"]>;

const CODES = [
  { value: "", label: "Any" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];

export default function Live() {
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View) ?? "live";
  const code = params.get("code") ?? "";
  const { data } = useQuery(overviewQuery);
  const set = (k: string, v: string) => {
    const next = Object.fromEntries(params);
    if (v) next[k] = v;
    else delete next[k];
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader eyebrow="Probing" title="Live hosts & takeovers">
        Every new subdomain gets a DNS lookup and an HTTP(S) request from Cloudflare's edge. Takeover candidates are
        CNAMEs that point at a third-party service showing its "unclaimed" page, or at a name that no longer resolves.
        Always verify by hand before reporting.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Seg<View>
          value={view}
          onChange={(v) => set("view", v)}
          options={[
            { value: "live", label: "Live" },
            { value: "takeover", label: `Takeover${data?.takeovers ? ` (${data.takeovers})` : ""}` },
            { value: "dead", label: "Dead / NX" },
            { value: "pending", label: `Queued${data?.probes_pending ? ` (${data.probes_pending})` : ""}` },
          ]}
        />
        {view === "live" && <Seg value={code} onChange={(v) => set("code", v)} options={CODES} />}
        <a href={`/raw/${view === "takeover" ? "takeovers" : "live"}.txt?hours=720`} className="text-sm text-muted-foreground hover:text-foreground sm:ml-auto">
          raw .txt ↗
        </a>
      </div>
      <SubsFeed
        title={view === "takeover" ? "Takeover candidates" : view === "pending" ? "Waiting for probe" : view === "dead" ? "Not responding" : "Responding hosts"}
        filename={`${view}-hosts.txt`}
        filter={{ view, hours: 24 * 60, code: view === "live" && code ? code : undefined }}
      />
    </>
  );
}
