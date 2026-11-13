import { useInfiniteQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { fetchSubs, download, type SubsFilter } from "@/lib/api";
import { Card, ErrorBox, SubsTable } from "./ui";

/** Paginated subdomain list backed by /api/subs (keyset pagination on id). */
export function SubsFeed({ filter, title, showProgram = true, filename = "subdomains.txt" }: { filter: SubsFilter; title: string; showProgram?: boolean; filename?: string }) {
  const q = useInfiniteQuery({
    queryKey: ["subs", filter],
    queryFn: ({ pageParam }) => fetchSubs(filter, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    refetchInterval: 60_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <Card
      title={
        <span>
          {title} · <span className="text-foreground">{rows.length.toLocaleString()}{q.hasNextPage ? "+" : ""}</span>
        </span>
      }
      action={
        rows.length > 0 && (
          <button
            onClick={() => download(filename, rows.map((r) => r.host).join("\n") + "\n")}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            <Download className="size-3" /> Copy list (.txt)
          </button>
        )
      }
    >
      {q.error ? (
        <div className="p-5">
          <ErrorBox error={q.error} />
        </div>
      ) : (
        <SubsTable rows={rows} loading={q.isLoading} showProgram={showProgram} />
      )}
      {q.hasNextPage && (
        <div className="border-t border-border p-3 text-center">
          <button
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="rounded-full border border-border px-4 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {q.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </Card>
  );
}
