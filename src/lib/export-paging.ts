// Full subdomain exports come back in pages (X-Next-Cursor) on the Cloudflare
// free plan. This installs one browser-side shim so every existing "Copy all"
// fetch() and every export download link transparently follows the cursor and
// receives the complete list — no page code had to change.

const EXPORT_PATH = "/api/public/export";
let installed = false;

function isExport(url: string) {
  try {
    return new URL(url, window.location.origin).pathname === EXPORT_PATH;
  } catch {
    return false;
  }
}

async function fetchAllPages(origFetch: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  const first = await origFetch(url, init);
  if (!first.ok || !first.headers.get("x-next-cursor")) return first;

  const target = new URL(url, window.location.origin);
  const format = target.searchParams.get("format") ?? "txt";
  const parts: string[] = [];
  const jsonRows: unknown[] = [];
  let res: Response = first;
  for (let page = 0; page < 2000; page++) {
    const body = await res.text();
    if (format === "json") {
      try {
        jsonRows.push(...(JSON.parse(body) as unknown[]));
      } catch {
        /* ignore malformed page */
      }
    } else {
      let text = body.replace(/^# next: .*$\n?/m, "");
      if (format === "csv" && page > 0) text = text.replace(/^host,first_seen_at,last_seen_at,is_active\n/, "");
      parts.push(text);
    }
    const cursor = res.headers.get("x-next-cursor");
    if (!cursor) break;
    target.searchParams.set("cursor", cursor);
    res = await origFetch(target.toString(), init);
    if (!res.ok) break;
  }
  const merged = format === "json" ? JSON.stringify(jsonRows, null, 0) : parts.join("");
  return new Response(merged, { status: 200, headers: { "content-type": first.headers.get("content-type") ?? "text/plain" } });
}

export function installExportPaging() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const origFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (isExport(url) && (!init?.method || init.method === "GET")) return fetchAllPages(origFetch, url, init);
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;

  // Plain <a href="/api/public/export?..."> downloads: page through, then save one file.
  document.addEventListener(
    "click",
    async (ev) => {
      const a = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !isExport(a.href) || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey) return;
      ev.preventDefault();
      const label = a.textContent;
      a.setAttribute("aria-busy", "true");
      a.style.opacity = "0.6";
      try {
        const res = await fetchAllPages(origFetch, a.href);
        const blob = await res.blob();
        const u = new URL(a.href);
        const name = `${u.searchParams.get("domain") ?? u.searchParams.get("platform") ?? "all"}-${u.searchParams.get("scope") ?? "all"}-subdomains.${u.searchParams.get("format") ?? "txt"}`;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      } finally {
        a.removeAttribute("aria-busy");
        a.style.opacity = "";
        if (label !== null) a.textContent = label;
      }
    },
    true,
  );
}
