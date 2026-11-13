import { animate, motion } from "framer-motion";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isInteresting, PLATFORM_COLORS, platformLabel, timeAgo, type Sub } from "@/lib/api";

export const EASE = [0.22, 1, 0.36, 1] as const;

export function CountUp({ value }: { value: number }) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    // Background tabs throttle animation frames; show the final number right away there.
    if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setV(value);
      return;
    }
    const c = animate(from.current, value, {
      duration: 0.9,
      ease: EASE,
      onUpdate: setV,
      onComplete: () => (from.current = value),
    });
    return () => c.stop();
  }, [value]);
  return <span>{Math.round(v).toLocaleString()}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="mb-8"
    >
      {eyebrow && <p className="label-mono mb-2 text-muted-foreground">{eyebrow}</p>}
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
      {children && <div className="mt-3 max-w-2xl text-muted-foreground">{children}</div>}
    </motion.div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: number | ReactNode; hint?: ReactNode; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="label-mono text-muted-foreground">{label}</p>
      <p
        className={`mt-2 text-2xl font-bold tabular-nums sm:text-3xl ${
          tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : ""
        }`}
      >
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-card ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          {title && <h2 className="label-mono text-muted-foreground">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PlatformBadge({ platform }: { platform: string | null | undefined }) {
  const p = platform || "other";
  return (
    <span className="chip-mono whitespace-nowrap">
      <span className="size-1.5 rounded-full" style={{ background: PLATFORM_COLORS[p] ?? PLATFORM_COLORS.other }} />
      {platformLabel(p)}
    </span>
  );
}

export function StatusCode({ code }: { code: number | null }) {
  if (code == null) return <span className="text-muted-foreground">—</span>;
  const tone =
    code < 300
      ? "bg-success/15 text-success"
      : code < 400
        ? "bg-brand/15 text-brand"
        : code < 500
          ? "bg-warning/20 text-warning"
          : "bg-destructive/15 text-destructive";
  return <span className={`rounded px-1.5 py-0.5 font-mono text-xs font-medium ${tone}`}>{code}</span>;
}

export function ProbeCell({ s }: { s: Sub }) {
  if (s.takeover) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive" title={s.takeover_evidence ?? ""}>
        <AlertTriangle className="size-3" /> takeover?
      </span>
    );
  }
  if (s.probe_state !== 2) return <span className="label-mono text-muted-foreground">queued</span>;
  if (!s.live) return <span className="label-mono text-muted-foreground" title={s.error ?? ""}>{s.error === "nxdomain" ? "nxdomain" : "dead"}</span>;
  return <StatusCode code={s.status_code} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-12 text-center text-sm text-muted-foreground">{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {error instanceof Error ? error.message : "Something went wrong"}
    </div>
  );
}

export function SubsTable({ rows, showProgram = true, loading }: { rows: Sub[]; showProgram?: boolean; loading?: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2 p-5">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7" />
        ))}
      </div>
    );
  }
  if (!rows.length) return <Empty>No subdomains here yet. New ones appear as soon as a program changes.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono px-5 py-2.5 font-normal text-muted-foreground">Host</th>
            <th className="label-mono px-3 py-2.5 font-normal text-muted-foreground">Status</th>
            <th className="label-mono px-3 py-2.5 font-normal text-muted-foreground">Title / info</th>
            {showProgram && <th className="label-mono px-3 py-2.5 font-normal text-muted-foreground">Program</th>}
            <th className="label-mono px-5 py-2.5 text-right font-normal text-muted-foreground">Found</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="row-sweep border-b border-border/60 last:border-0">
              <td className="max-w-[340px] px-5 py-2 font-mono text-[13px]">
                <div className="flex items-center gap-2">
                  {isInteresting(s.host) && <span className="size-1.5 shrink-0 rounded-full bg-brand" title="interesting keyword" />}
                  <a
                    href={s.final_url ?? `https://${s.host}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate hover:underline"
                    title={s.host}
                  >
                    {s.host}
                  </a>
                </div>
              </td>
              <td className="px-3 py-2">
                <ProbeCell s={s} />
              </td>
              <td className="max-w-[280px] truncate px-3 py-2 text-muted-foreground" title={s.takeover_evidence ?? s.title ?? ""}>
                {s.takeover ? (
                  <span className="text-destructive">{s.takeover_service}: {s.takeover_evidence}</span>
                ) : (
                  [s.title, s.webserver, s.cdn, s.tech].filter(Boolean).join(" · ") || (s.cname ? `→ ${s.cname}` : s.ip ?? "")
                )}
              </td>
              {showProgram && (
                <td className="px-3 py-2">
                  <Link to={`/program/${s.program_slug}`} className="story-link whitespace-nowrap text-muted-foreground hover:text-foreground">
                    {s.program_slug}
                  </Link>
                </td>
              )}
              <td className="whitespace-nowrap px-5 py-2 text-right text-xs text-muted-foreground" title={s.first_seen_at}>
                {timeAgo(s.first_seen_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-full border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-9 rounded-full border border-input bg-background px-4 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/20 ${props.className ?? ""}`}
    />
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:underline">
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}
