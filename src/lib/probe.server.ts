
// Cloudflare free plan: at most 50 outbound requests per invocation, so each
// probe run handles a handful of hosts and the cron fans out several runs a minute.
const HOSTS_PER_RUN = 6;
const CONCURRENCY = 5;
const SUBREQUEST_BUDGET = 44;
const TIMEOUT_MS = 5000;
const DNS_TIMEOUT_MS = 2500;
const MAX_REDIRECTS = 2;
const BODY_CAP = 32 * 1024;

let subrequests = 0;
class BudgetExceeded extends Error {}
/** fetch() that counts against the per-invocation subrequest budget. */
async function sfetch(input: string, init?: RequestInit): Promise<Response> {
  if (subrequests >= SUBREQUEST_BUDGET) throw new BudgetExceeded("subrequest budget exhausted");
  subrequests++;
  return fetch(input, init);
}

type ProbeRow = {
  domain_id: string | null;
  host: string;
  url: string;
  final_url: string | null;
  status_code: number | null;
  title: string | null;
  content_length: number | null;
  content_type: string | null;
  response_time_ms: number | null;
  webserver: string | null;
  technologies: string[];
  cdn: string | null;
  ip: string | null;
  asn: string | null;
  cname: string | null;
  redirect_chain: string[];
  tls_issuer: string | null;
  tls_expires_at: string | null;
  body_hash: string | null;
  failed: boolean;
  error: string | null;
  takeover_risk: boolean;
  takeover_service: string | null;
  takeover_evidence: string | null;
};

// Third-party hosting services whose dangling CNAMEs are classic subdomain
// takeover targets. `body` is the "unclaimed" fingerprint served by the vendor.
const TAKEOVER_SERVICES: Array<{
  service: string;
  cname: RegExp;
  body?: RegExp;
  nxdomain?: boolean;
}> = [
  { service: "AWS S3", cname: /s3[.-][\w-]*amazonaws\.com$|s3\.amazonaws\.com$/i, body: /NoSuchBucket|The specified bucket does not exist/i },
  { service: "GitHub Pages", cname: /github\.io$|githubusercontent\.com$/i, body: /There isn't a GitHub Pages site here|For root URLs \(like http:\/\/example\.com\/\) you must provide an index\.html/i },
  { service: "Heroku", cname: /herokuapp\.com$|herokudns\.com$/i, body: /No such app|herokucdn\.com\/error-pages\/no-such-app/i, nxdomain: true },
  { service: "Azure", cname: /\.azurewebsites\.net$|cloudapp\.azure\.com$|trafficmanager\.net$|blob\.core\.windows\.net$|azureedge\.net$/i, nxdomain: true },
  { service: "Shopify", cname: /myshopify\.com$/i, body: /Sorry, this shop is currently unavailable|Only one step left/i },
  { service: "Fastly", cname: /fastly\.net$/i, body: /Fastly error: unknown domain/i },
  { service: "Netlify", cname: /netlify\.(app|com)$/i, body: /Not Found - Request ID|no such site/i },
  { service: "Vercel", cname: /vercel(-dns)?\.(app|com)$/i, body: /The deployment could not be found|DEPLOYMENT_NOT_FOUND/i },
  { service: "Pantheon", cname: /pantheonsite\.io$/i, body: /The gods are wise|404 error unknown site/i },
  { service: "Zendesk", cname: /zendesk\.com$/i, body: /Help Center Closed|this help center no longer exists/i },
  { service: "Tumblr", cname: /domains\.tumblr\.com$|tumblr\.com$/i, body: /Whatever you were looking for doesn't currently exist at this address/i },
  { service: "Unbounce", cname: /unbouncepages\.com$/i, body: /The requested URL was not found on this server/i },
  { service: "Surge.sh", cname: /surge\.sh$/i, body: /project not found/i },
  { service: "Bitbucket", cname: /bitbucket\.io$/i, body: /Repository not found/i },
  { service: "Ghost", cname: /ghost\.io$/i, body: /The thing you were looking for is no longer here/i },
  { service: "Readthedocs", cname: /readthedocs\.io$/i, body: /unknown to Read the Docs/i },
  { service: "Wordpress.com", cname: /wordpress\.com$/i, body: /Do you want to register/i },
  { service: "Webflow", cname: /proxy(-ssl)?\.webflow\.com$|webflow\.io$/i, body: /The page you are looking for doesn't exist or has been moved/i },
  { service: "Cargo", cname: /cargocollective\.com$/i, body: /404 Not Found/i },
  { service: "Desk.com", cname: /desk\.com$/i, body: /Please try again or try Desk\.com/i },
  { service: "Help Scout", cname: /helpscoutdocs\.com$/i, body: /No settings were found for this company/i },
  { service: "Statuspage", cname: /statuspage\.io$/i, body: /You are being.*redirected|Better Uptime|status page not found/i },
  { service: "Agile CRM", cname: /agilecrm\.com$/i, body: /Sorry, this page is no longer available/i },
  { service: "Acquia", cname: /acquia-sites\.com$/i, body: /The site you are looking for could not be found/i },
];

// Suffixes we treat as public/shared infrastructure rather than "another owner".
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const twoLevelTld = /^(co|com|net|org|gov|edu|ac|or|ne)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoLevelTld ? -3 : -2).join(".");
}

const CDN_HINTS: Array<[RegExp, string]> = [
  [/cloudflare/i, "Cloudflare"],
  [/akamai|ghost/i, "Akamai"],
  [/fastly/i, "Fastly"],
  [/amazons3|aws|cloudfront/i, "AWS/CloudFront"],
  [/gws|google/i, "Google"],
  [/azure|microsoft/i, "Azure"],
  [/incapsula|imperva/i, "Imperva"],
  [/sucuri/i, "Sucuri"],
  [/vercel/i, "Vercel"],
  [/netlify/i, "Netlify"],
  [/bunny/i, "BunnyCDN"],
];

const TECH_HINTS: Array<[RegExp, string]> = [
  [/_next|__NEXT_DATA__|x-powered-by:\s*next/i, "Next.js"],
  [/wp-content|wp-includes|wordpress/i, "WordPress"],
  [/react/i, "React"],
  [/laravel/i, "Laravel"],
  [/django/i, "Django"],
  [/drupal/i, "Drupal"],
  [/shopify/i, "Shopify"],
  [/jquery/i, "jQuery"],
  [/bootstrap/i, "Bootstrap"],
  [/graphql/i, "GraphQL"],
  [/swagger|openapi/i, "Swagger/OpenAPI"],
  [/jenkins/i, "Jenkins"],
  [/grafana/i, "Grafana"],
  [/kibana/i, "Kibana"],
  [/phpmyadmin/i, "phpMyAdmin"],
];

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice(0, BODY_CAP));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function doh(name: string, type: string, timeoutMs = DNS_TIMEOUT_MS): Promise<Array<{ data: string; type?: number }>> {
  try {
    const res = await sfetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { Answer?: Array<{ data: string; type?: number }> };
    return json.Answer ?? [];
  } catch {
    return [];
  }
}

const asnCache = new Map<string, string | null>();

// DNS rcode for a name: 0 = ok, 3 = NXDOMAIN, null = lookup failed.
async function dohStatus(name: string, timeoutMs = DNS_TIMEOUT_MS): Promise<number | null> {
  try {
    const res = await sfetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { Status?: number };
    return typeof json.Status === "number" ? json.Status : null;
  } catch {
    return null;
  }
}

async function lookupAsn(ip: string): Promise<string | null> {
  if (subrequests > SUBREQUEST_BUDGET - 8) return null;
  const key = ip.split(".").slice(0, 3).join(".");
  if (asnCache.has(key)) return asnCache.get(key) ?? null;
  const rev = ip.split(".").reverse().join(".");
  const txt = await doh(`${rev}.origin.asn.cymru.com`, "TXT", 2000);
  const raw = txt[0]?.data?.replace(/"/g, "");
  let asn: string | null = null;
  if (raw) {
    const [num, , , , desc] = raw.split(" | ");
    asn = desc ? `AS${num} ${desc}` : `AS${num}`;
  }
  if (asnCache.size < 20000) asnCache.set(key, asn);
  return asn;
}

// A single A query already returns any CNAME records in the answer chain,
// so one round trip is enough to resolve both.
async function lookupDns(host: string): Promise<{ ip: string | null; cname: string | null }> {
  const answers = await doh(host, "A");
  const ip = answers.find((r) => /^\d+\.\d+\.\d+\.\d+$/.test(r.data))?.data ?? null;
  const cname =
    answers.find((r) => r.type === 5 || /^[a-z0-9.-]+\.$/i.test(r.data))?.data?.replace(/\.$/, "") ?? null;
  return { ip, cname };
}

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{0,300})<\/title>/i.exec(html);
  return m && m[1] ? m[1].trim().replace(/\s+/g, " ").slice(0, 200) : null;
}

function detectTech(headers: Headers, body: string): string[] {
  const hay = `${[...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${body.slice(0, 30000)}`;
  const found = new Set<string>();
  for (const [re, name] of TECH_HINTS) if (re.test(hay)) found.add(name);
  const powered = headers.get("x-powered-by");
  if (powered?.split("/")[0]) found.add(powered.split("/")[0]!.trim());
  return [...found].slice(0, 12);
}

function detectCdn(headers: Headers): string | null {
  const cf = headers.get("cf-ray");
  if (cf) return "Cloudflare";
  const hay = [headers.get("server"), headers.get("via"), headers.get("x-cdn"), headers.get("x-cache")]
    .filter(Boolean)
    .join(" ");
  for (const [re, name] of CDN_HINTS) if (re.test(hay)) return name;
  return null;
}

async function fetchChain(startUrl: string): Promise<{
  final: Response;
  finalUrl: string;
  chain: string[];
  bodyText: string;
  timeMs: number;
}> {
  let url = startUrl;
  const chain: string[] = [];
  const started = Date.now();
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await sfetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; chaos-monitor/1.0; live-host probe)",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.arrayBuffer().catch(() => undefined);
      if (!loc) return { final: res, finalUrl: url, chain, bodyText: "", timeMs: Date.now() - started };
      chain.push(`${res.status} ${url} -> ${new URL(loc, url).toString()}`);
      url = new URL(loc, url).toString();
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const capped = buf.slice(0, BODY_CAP);
    const bodyText = new TextDecoder().decode(capped);
    return { final: res, finalUrl: url, chain, bodyText, timeMs: Date.now() - started };
  }
  // Redirect loop
  const res = await sfetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { final: res, finalUrl: url, chain, bodyText: "", timeMs: Date.now() - started };
}

async function probeHost(domainId: string | null, host: string): Promise<ProbeRow> {
  const base: ProbeRow = {
    domain_id: domainId,
    host,
    url: `https://${host}`,
    final_url: null,
    status_code: null,
    title: null,
    content_length: null,
    content_type: null,
    response_time_ms: null,
    webserver: null,
    technologies: [],
    cdn: null,
    ip: null,
    asn: null,
    cname: null,
    redirect_chain: [],
    tls_issuer: null,
    tls_expires_at: null,
    body_hash: null,
    failed: false,
    error: null,
    takeover_risk: false,
    takeover_service: null,
    takeover_evidence: null,
  };

  // DNS runs in parallel with the first request instead of blocking it.
  const dnsPromise = lookupDns(host);
  let lastBody = "";

  const attempt = async (scheme: "https" | "http", retry: boolean): Promise<boolean> => {
    for (let tries = 0; tries <= (retry ? 1 : 0); tries++) {
      const url = `${scheme}://${host}`;
      try {
        const { final, finalUrl, chain, bodyText, timeMs } = await fetchChain(url);
        base.url = url;
        base.final_url = finalUrl;
        base.status_code = final.status;
        base.response_time_ms = timeMs;
        base.redirect_chain = chain;
        base.webserver = final.headers.get("server");
        base.content_type = final.headers.get("content-type")?.split(";")[0] ?? null;
        base.cdn = detectCdn(final.headers);
        base.technologies = detectTech(final.headers, bodyText);
        const bodyBytes = new TextEncoder().encode(bodyText);
        base.content_length = bodyBytes.length;
        base.title = extractTitle(bodyText);
        base.body_hash = await sha256Hex(bodyBytes);
        lastBody = bodyText;
        base.failed = false;
        base.error = null;
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 200) : "request_failed";
        base.error = msg;
        // Only retry transient network/timeout errors, never hard DNS/TLS failures.
        if (!/timeout|timed out|reset|network|socket|EAI_AGAIN|fetch failed/i.test(msg)) break;
      }
    }
    return false;
  };

  let ok = await attempt("https", true);
  if (!ok) ok = await attempt("http", false);

  const dns = await dnsPromise;
  base.ip = dns.ip;
  base.cname = dns.cname;
  if (ok && dns.ip) base.asn = await lookupAsn(dns.ip);

  if (!ok) {
    base.failed = true;
    if (!dns.ip && !dns.cname) base.error = "no_dns";
  }

  await assessTakeover(base, lastBody);
  return base;
}

// Flags subdomains delegated to an outside owner where that delegation looks
// unclaimed — the classic subdomain-takeover setup.
async function assessTakeover(row: ProbeRow, body: string): Promise<void> {
  const cname = row.cname;
  if (!cname) return;
  const own = registrableDomain(row.host);
  const target = registrableDomain(cname);
  if (!target || target === own) return;

  const hay = `${body.slice(0, 20000)}\n${row.title ?? ""}`;
  const match = TAKEOVER_SERVICES.find((s) => s.cname.test(cname));

  if (match) {
    if (match.body && match.body.test(hay)) {
      row.takeover_risk = true;
      row.takeover_service = match.service;
      row.takeover_evidence = `CNAME -> ${cname} and the service returns its "unclaimed" page`;
      return;
    }
    // No answer at all from the vendor target: dangling delegation.
    if (!row.ip) {
      const status = await dohStatus(cname);
      if (status === 3 || (match.nxdomain && !row.status_code)) {
        row.takeover_risk = true;
        row.takeover_service = match.service;
        row.takeover_evidence = `CNAME -> ${cname} does not resolve (dangling delegation)`;
        return;
      }
    }
  }

  // Not a known vendor, but the delegation target itself is gone.
  if (!row.ip && row.failed) {
    const status = await dohStatus(cname);
    if (status === 3) {
      row.takeover_risk = true;
      row.takeover_service = target;
      row.takeover_evidence = `CNAME -> ${cname} (${target}) returns NXDOMAIN`;
      return;
    }
  }

  // Points elsewhere but still resolves: informational only.
  row.takeover_service = target;
  row.takeover_evidence = `Points to third-party domain ${target}`;
}


type ProbeJob = {
  id: string;
  domain_id: string | null;
  platform_slug: string | null;
  program: string | null;
  scope: string;
  search: string | null;
  cursor_host: string;
};

const SEP = "\u0001";

/**
 * Next hosts for a probe job. Full lists come live from Chaos (not stored in D1);
 * scope "new" uses the subdomains discovered in the last 24 hours.
 * Platform-wide jobs walk domains alphabetically with a "domain<SEP>host" cursor.
 */
async function fetchHostBatch(job: ProbeJob, limit: number): Promise<{ hosts: Array<{ host: string; domainId: string | null }>; cursor: string; done: boolean }> {
  const { sql } = await import("@/integrations/d1/rpc.server");
  const { liveHosts } = await import("@/integrations/d1/chaos-live.server");
  const search = job.search?.toLowerCase() ?? "";

  let platformId: string | null = null;
  if (job.platform_slug) {
    const p = (await sql<{ id: string }>("SELECT id FROM platforms WHERE slug = ?", job.platform_slug))[0];
    if (!p) return { hosts: [], cursor: job.cursor_host, done: true };
    platformId = p.id;
  }

  if (job.scope === "new") {
    const rows = await sql<{ host: string; domain_id: string }>(
      `SELECT s.host, s.domain_id FROM subdomains s JOIN domains d ON d.id = s.domain_id
        WHERE s.first_seen_at >= ? AND s.host > ?
          AND (? IS NULL OR s.domain_id = ?) AND (? IS NULL OR d.platform_id = ?)
          AND (? IS NULL OR d.domain LIKE ?) AND (? = '' OR s.host LIKE ?)
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM probe_results pr WHERE pr.host = s.host))
        ORDER BY s.host LIMIT ?`,
      new Date(Date.now() - 24 * 3600_000).toISOString(),
      job.cursor_host,
      job.domain_id, job.domain_id,
      platformId, platformId,
      job.program ? 1 : null, `%${job.program ?? ""}%`,
      search, `%${search}%`,
      // The automatic job (no target) only probes hosts that were never probed.
      !job.domain_id && !job.platform_slug && !job.program && !job.search ? 1 : 0,
      limit,
    );
    return {
      hosts: rows.map((r) => ({ host: r.host, domainId: r.domain_id })),
      cursor: rows.at(-1)?.host ?? job.cursor_host,
      done: rows.length < limit,
    };
  }

  if (job.domain_id) {
    const d = (await sql<{ domain: string }>("SELECT domain FROM domains WHERE id = ?", job.domain_id))[0];
    if (!d) return { hosts: [], cursor: job.cursor_host, done: true };
    subrequests++;
    const all = (await liveHosts(d.domain)).filter((h) => h > job.cursor_host && (!search || h.includes(search)));
    const take = all.slice(0, limit);
    return {
      hosts: take.map((host) => ({ host, domainId: job.domain_id })),
      cursor: take.at(-1) ?? job.cursor_host,
      done: all.length <= limit,
    };
  }

  // Platform (or every platform): walk root domains in order.
  const [curDomain = "", curHost = ""] = job.cursor_host.split(SEP);
  const doms = await sql<{ id: string; domain: string }>(
    `SELECT id, domain FROM domains WHERE enabled = 1 AND domain >= ?
       AND (? IS NULL OR platform_id = ?) AND (? IS NULL OR domain LIKE ?)
     ORDER BY domain LIMIT 4`,
    curDomain,
    platformId, platformId,
    job.program ? 1 : null, `%${job.program ?? ""}%`,
  );
  const out: Array<{ host: string; domainId: string | null }> = [];
  let cursor = job.cursor_host;
  for (const d of doms) {
    if (subrequests > SUBREQUEST_BUDGET - 12) return { hosts: out, cursor, done: false };
    subrequests++;
    const list = await liveHosts(d.domain).catch(() => [] as string[]);
    const after = d.domain === curDomain ? curHost : "";
    for (const h of list) {
      if (after && h <= after) continue;
      if (search && !h.includes(search)) continue;
      out.push({ host: h, domainId: d.id });
      cursor = `${d.domain}${SEP}${h}`;
      if (out.length >= limit) return { hosts: out, cursor, done: false };
    }
    // Finished this domain: next run starts at the following one.
    cursor = `${d.domain}${SEP}￿`;
  }
  return { hosts: out, cursor, done: doms.length < 4 };
}

/** Probes one small batch of the oldest open job (one batch per invocation on the free plan). */
export async function processProbeJobs(_budgetMs: number): Promise<{ jobId: string | null; probed: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  subrequests = 0;

  const { data: job } = await supabaseAdmin.rpc("claim_probe_job");
  const j = (Array.isArray(job) ? job[0] : job) as ProbeJob | null;
  if (!j || !j.id) return { jobId: null, probed: 0 };

  const batch = await fetchHostBatch(j, HOSTS_PER_RUN);
  if (batch.hosts.length === 0) {
    await supabaseAdmin.rpc("record_probe_batch", { _job_id: j.id, _results: [], _cursor_host: batch.cursor, _done: batch.done });
    return { jobId: j.id, probed: 0 };
  }

  const rows: ProbeRow[] = [];
  let index = 0;
  let stoppedEarly = false;
  let lastHost = j.cursor_host;
  const worker = async () => {
    for (;;) {
      if (subrequests > SUBREQUEST_BUDGET - 6) {
        stoppedEarly = true;
        return;
      }
      const i = index++;
      if (i >= batch.hosts.length) return;
      const h = batch.hosts[i]!;
      rows.push(await probeHost(h.domainId, h.host));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.hosts.length) }, worker));

  // Only advance the cursor past hosts that were actually probed.
  const probedHosts = new Set(rows.map((r) => r.host));
  for (const h of batch.hosts) {
    if (!probedHosts.has(h.host)) break;
    lastHost = j.domain_id || j.scope === "new" ? h.host : `${(batch.cursor.split(SEP)[0] ?? "")}`;
  }
  const allDone = !stoppedEarly && rows.length === batch.hosts.length;
  const cursor = allDone ? batch.cursor : j.domain_id || j.scope === "new" ? lastHost : j.cursor_host;
  const { error } = await supabaseAdmin.rpc("record_probe_batch", {
    _job_id: j.id,
    _results: rows,
    _cursor_host: cursor,
    _done: allDone && batch.done,
  });
  if (error) console.error("record_probe_batch failed:", error.message);
  return { jobId: j.id, probed: rows.length };
}

export async function probeJobTargets(job: { domain_id: string | null; platform_slug: string | null; program: string | null; scope: string; search: string | null }) {
  const { sql, getAgg } = await import("@/integrations/d1/rpc.server");
  if (job.scope === "new") {
    const r = await sql<{ c: number }>("SELECT COUNT(*) AS c FROM subdomains WHERE first_seen_at >= ?", new Date(Date.now() - 24 * 3600_000).toISOString());
    return Number(r[0]?.c ?? 0);
  }
  if (job.domain_id) {
    const d = (await sql<{ total_subdomains: number }>("SELECT total_subdomains FROM domains WHERE id = ?", job.domain_id))[0];
    return Number(d?.total_subdomains ?? 0);
  }
  const agg = await getAgg();
  if (job.platform_slug) {
    const p = (await sql<{ id: string }>("SELECT id FROM platforms WHERE slug = ?", job.platform_slug))[0];
    return p ? agg.platforms[p.id]?.subdomain_count ?? 0 : 0;
  }
  return agg.sum_total;
}


/**
 * Keeps a rolling "new subdomains -> is it live?" job in flight so freshly
 * discovered hosts land in the live list without anyone pressing a button.
 */
export async function ensureAutoProbeJob(): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: open } = await supabaseAdmin
    .from("probe_jobs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(1);
  if (open && open.length) return null;

  const { data: recent } = await supabaseAdmin
    .from("probe_jobs")
    .select("id")
    .is("domain_id", null)
    .is("platform_slug", null)
    .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .limit(1);
  if (recent && recent.length) return null;

  const { data, error } = await supabaseAdmin
    .from("probe_jobs")
    .insert({ scope: "new", status: "queued" })
    .select("id")
    .single();
  if (error) {
    console.error("ensureAutoProbeJob failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}
