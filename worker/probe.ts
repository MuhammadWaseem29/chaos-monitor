// Live-host probe that fits the Workers free plan: every host costs a handful
// of subrequests (DNS + HTTP), and a single invocation stays under 50.

import type { Db } from "./db";
import { alertsEnabled, sendAlert, wantsProgram } from "./alerts";
import type { Env } from "./env";
import { nowIso } from "./env";

const TIMEOUT_MS = 5000;
const BODY_CAP = 32 * 1024;
const MAX_REDIRECTS = 2;
const SUBREQUEST_BUDGET = 46;

type Row = {
  id: number;
  host: string;
  program_slug: string;
  status_code: number | null;
  title: string | null;
  webserver: string | null;
  cdn: string | null;
  ip: string | null;
  cname: string | null;
  final_url: string | null;
  tech: string[];
  live: boolean;
  takeover: boolean;
  takeover_service: string | null;
  takeover_evidence: string | null;
  error: string | null;
};

const TAKEOVER: Array<{ service: string; cname: RegExp; body?: RegExp; nxdomain?: boolean }> = [
  { service: "AWS S3", cname: /s3[.-][\w-]*amazonaws\.com$|s3\.amazonaws\.com$/i, body: /NoSuchBucket|The specified bucket does not exist/i },
  { service: "GitHub Pages", cname: /github\.io$/i, body: /There isn't a GitHub Pages site here/i },
  { service: "Heroku", cname: /herokuapp\.com$|herokudns\.com$/i, body: /No such app|no-such-app/i, nxdomain: true },
  { service: "Azure", cname: /azurewebsites\.net$|cloudapp\.(azure\.com|net)$|trafficmanager\.net$|blob\.core\.windows\.net$|azureedge\.net$/i, nxdomain: true },
  { service: "Shopify", cname: /myshopify\.com$/i, body: /Sorry, this shop is currently unavailable/i },
  { service: "Fastly", cname: /fastly\.net$/i, body: /Fastly error: unknown domain/i },
  { service: "Netlify", cname: /netlify\.(app|com)$/i, body: /Not Found - Request ID/i },
  { service: "Vercel", cname: /vercel(-dns)?\.(app|com)$/i, body: /DEPLOYMENT_NOT_FOUND|The deployment could not be found/i },
  { service: "Pantheon", cname: /pantheonsite\.io$/i, body: /The gods are wise|404 error unknown site/i },
  { service: "Zendesk", cname: /zendesk\.com$/i, body: /Help Center Closed/i },
  { service: "Tumblr", cname: /tumblr\.com$/i, body: /Whatever you were looking for doesn't currently exist/i },
  { service: "Unbounce", cname: /unbouncepages\.com$/i, body: /The requested URL was not found on this server/i },
  { service: "Surge.sh", cname: /surge\.sh$/i, body: /project not found/i },
  { service: "Bitbucket", cname: /bitbucket\.io$/i, body: /Repository not found/i },
  { service: "Ghost", cname: /ghost\.io$/i, body: /The thing you were looking for is no longer here/i },
  { service: "Readthedocs", cname: /readthedocs\.io$/i, body: /unknown to Read the Docs/i },
  { service: "Webflow", cname: /webflow\.(com|io)$/i, body: /The page you are looking for doesn't exist or has been moved/i },
  { service: "Help Scout", cname: /helpscoutdocs\.com$/i, body: /No settings were found for this company/i },
  { service: "Agile CRM", cname: /agilecrm\.com$/i, body: /Sorry, this page is no longer available/i },
  { service: "Acquia", cname: /acquia-sites\.com$/i, body: /The site you are looking for could not be found/i },
];

const CDN: Array<[RegExp, string]> = [
  [/cloudflare/i, "Cloudflare"],
  [/akamai/i, "Akamai"],
  [/fastly/i, "Fastly"],
  [/cloudfront|amazons3|awselb/i, "AWS"],
  [/gws|google/i, "Google"],
  [/azure|microsoft/i, "Azure"],
  [/incapsula|imperva/i, "Imperva"],
  [/sucuri/i, "Sucuri"],
  [/vercel/i, "Vercel"],
  [/netlify/i, "Netlify"],
];

const TECH: Array<[RegExp, string]> = [
  [/__NEXT_DATA__|\/_next\//, "Next.js"],
  [/wp-content|wp-includes/i, "WordPress"],
  [/laravel_session|laravel/i, "Laravel"],
  [/csrfmiddlewaretoken|django/i, "Django"],
  [/drupal/i, "Drupal"],
  [/cdn\.shopify|shopify/i, "Shopify"],
  [/graphql/i, "GraphQL"],
  [/swagger-ui|openapi/i, "Swagger"],
  [/jenkins/i, "Jenkins"],
  [/grafana/i, "Grafana"],
  [/kibana/i, "Kibana"],
  [/phpmyadmin/i, "phpMyAdmin"],
  [/gitlab/i, "GitLab"],
];

function registrable(host: string) {
  const p = host.toLowerCase().replace(/\.$/, "").split(".");
  if (p.length <= 2) return p.join(".");
  const two = /^(co|com|net|org|gov|edu|ac|or|ne)\.[a-z]{2}$/.test(p.slice(-2).join("."));
  return p.slice(two ? -3 : -2).join(".");
}

class Budget {
  used = 0;
  take(n = 1) {
    if (this.used + n > SUBREQUEST_BUDGET) return false;
    this.used += n;
    return true;
  }
}

async function doh(name: string, budget: Budget) {
  if (!budget.take()) return null;
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  } catch {
    return null;
  }
}

async function readCapped(res: Response) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_CAP) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    /* partial body is fine */
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(size, BODY_CAP));
  let o = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, all.length - o);
    all.set(c.subarray(0, n), o);
    o += n;
    if (o >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

async function fetchChain(url: string, budget: Budget) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!budget.take()) throw new Error("budget");
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; chaos-monitor/1.0; +live-host probe)",
        accept: "text/html,*/*;q=0.8",
      },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && i < MAX_REDIRECTS) {
      res.body?.cancel().catch(() => {});
      current = new URL(loc, current).toString();
      continue;
    }
    const body = await readCapped(res);
    return { res, body, finalUrl: current };
  }
  throw new Error("redirect loop");
}

async function probeOne(item: { id: number; host: string; program_slug: string }, budget: Budget): Promise<Row> {
  const row: Row = {
    id: item.id,
    host: item.host,
    program_slug: item.program_slug,
    status_code: null,
    title: null,
    webserver: null,
    cdn: null,
    ip: null,
    cname: null,
    final_url: null,
    tech: [],
    live: false,
    takeover: false,
    takeover_service: null,
    takeover_evidence: null,
    error: null,
  };

  const dns = await doh(item.host, budget);
  const answers = dns?.Answer ?? [];
  row.ip = answers.find((a) => a.type === 1)?.data ?? null;
  row.cname = answers.find((a) => a.type === 5)?.data?.replace(/\.$/, "") ?? null;
  const nx = dns?.Status === 3;

  let body = "";
  if (!nx && (row.ip || row.cname || !dns)) {
    for (const scheme of ["https", "http"] as const) {
      try {
        const r = await fetchChain(`${scheme}://${item.host}`, budget);
        row.status_code = r.res.status;
        row.final_url = r.finalUrl;
        row.webserver = r.res.headers.get("server");
        const hay = [r.res.headers.get("server"), r.res.headers.get("via"), r.res.headers.get("x-cache")].join(" ");
        row.cdn = r.res.headers.get("cf-ray") ? "Cloudflare" : (CDN.find(([re]) => re.test(hay))?.[1] ?? null);
        const t = /<title[^>]*>([^<]{0,300})<\/title>/i.exec(r.body);
        row.title = t?.[1]?.trim().replace(/\s+/g, " ").slice(0, 200) ?? null;
        const techHay = `${r.res.headers.get("x-powered-by") ?? ""}\n${r.body}`;
        row.tech = TECH.filter(([re]) => re.test(techHay)).map(([, n]) => n);
        const powered = r.res.headers.get("x-powered-by")?.split("/")[0]?.trim();
        if (powered && !row.tech.includes(powered)) row.tech.push(powered);
        body = r.body;
        row.live = true;
        row.error = null;
        break;
      } catch (e) {
        row.error = e instanceof Error ? e.message.slice(0, 160) : "request failed";
        if (row.error === "budget") break;
      }
    }
  } else {
    row.error = nx ? "nxdomain" : "no_dns";
  }

  // Takeover heuristics: CNAME to a third party that looks unclaimed or dangling.
  if (row.cname && registrable(row.cname) !== registrable(row.host)) {
    const svc = TAKEOVER.find((s) => s.cname.test(row.cname!));
    const hay = `${body.slice(0, 20000)}\n${row.title ?? ""}`;
    if (svc?.body && svc.body.test(hay)) {
      row.takeover = true;
      row.takeover_service = svc.service;
      row.takeover_evidence = `CNAME → ${row.cname}; service shows its "unclaimed" page`;
    } else if (!row.ip) {
      const target = await doh(row.cname, budget);
      if (target?.Status === 3 || (svc?.nxdomain && !row.status_code && target && !target.Answer?.length)) {
        row.takeover = true;
        row.takeover_service = svc?.service ?? registrable(row.cname);
        row.takeover_evidence = `CNAME → ${row.cname} does not resolve (dangling)`;
      }
    }
    if (!row.takeover) {
      row.takeover_service = svc?.service ?? registrable(row.cname);
    }
  }
  return row;
}

export async function runProbe(
  db: Db,
  env: Env,
  items: Array<{ id: number; host: string; program_slug: string }>,
) {
  const budget = new Budget();
  const done: Row[] = [];
  const queue = [...items];
  const worker = async () => {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      if (budget.used > SUBREQUEST_BUDGET - 3) {
        queue.unshift(it);
        return;
      }
      done.push(await probeOne(it, budget));
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));

  const stamp = nowIso();
  const stmts = done.map((r) =>
    db.stmt(
      `UPDATE subs SET probe_state = 2, claimed_at = NULL, probed_at = ?, status_code = ?, title = ?, webserver = ?,
         cdn = ?, ip = ?, cname = ?, final_url = ?, tech = ?, live = ?, takeover = ?, takeover_service = ?,
         takeover_evidence = ?, error = ? WHERE id = ?`,
      stamp,
      r.status_code,
      r.title,
      r.webserver,
      r.cdn,
      r.ip,
      r.cname,
      r.final_url,
      r.tech.join(",") || null,
      r.live ? 1 : 0,
      r.takeover ? 1 : 0,
      r.takeover_service,
      r.takeover_evidence,
      r.error,
      r.id,
    ),
  );
  // Hosts we ran out of budget for go back to the queue.
  for (const left of queue) {
    stmts.push(db.stmt("UPDATE subs SET probe_state = 0, claimed_at = NULL WHERE id = ?", left.id));
  }
  await db.batch(stmts);

  db.counters.probed += done.length;
  db.counters.live += done.filter((r) => r.live).length;
  const risky = done.filter((r) => r.takeover);
  db.counters.takeovers += risky.length;

  if (risky.length && alertsEnabled(env)) {
    const lines = risky
      .filter((r) => wantsProgram(env, r.program_slug))
      .map((r) => `${r.host} → ${r.takeover_service} (${r.takeover_evidence})`);
    if (lines.length) await sendAlert(env, `⚠️ Possible subdomain takeover\n${lines.join("\n")}`);
  }
  return { probed: done.length, live: done.filter((r) => r.live).length, takeovers: risky.length, requeued: queue.length };
}
