// Full subdomain lists are not stored in D1 (free-plan limits). They are
// fetched live from ProjectDiscovery Chaos with CHAOS_API_KEY and kept in
// the edge cache for an hour, so repeated page views cost nothing.
import { secret } from "./env.server";

const CHAOS_BASE = "https://dns.projectdiscovery.io/dns";
const TTL_SECONDS = 3600;

export class ChaosError extends Error {}

/** Chaos API fetch, returning sorted full hostnames. */
export async function fetchChaosHosts(domain: string, timeoutMs = 20_000): Promise<{ hosts: string[]; bytes: number }> {
  const key = secret("CHAOS_API_KEY");
  if (!key) throw new ChaosError("CHAOS_API_KEY is not configured");
  const res = await fetch(`${CHAOS_BASE}/${encodeURIComponent(domain)}/subdomains`, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new ChaosError(`Chaos API failed [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const json = JSON.parse(text) as { subdomains?: string[] | null };
  const set = new Set<string>();
  for (const label of json.subdomains ?? []) {
    if (typeof label !== "string") continue;
    const l = label.trim().toLowerCase();
    set.add(l === "" || l === "*" ? domain : `${l}.${domain}`);
  }
  return { hosts: [...set].sort(), bytes: text.length };
}

const memo = new Map<string, { at: number; hosts: string[] }>();

/** Live host list for one root domain (edge-cached for an hour). */
export async function liveHosts(domain: string): Promise<string[]> {
  const d = domain.toLowerCase();
  const m = memo.get(d);
  if (m && Date.now() - m.at < 60_000) return m.hosts;

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
  const key = new Request(`https://chaos-live.cache/${encodeURIComponent(d)}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const text = await hit.text();
      const hosts = text ? text.split("\n") : [];
      remember(d, hosts);
      return hosts;
    }
  }
  const { hosts } = await fetchChaosHosts(d);
  if (cache) {
    await cache.put(
      key,
      new Response(hosts.join("\n"), { headers: { "cache-control": `public, max-age=${TTL_SECONDS}` } }),
    );
  }
  remember(d, hosts);
  return hosts;
}

function remember(d: string, hosts: string[]) {
  if (memo.size > 200) memo.clear();
  memo.set(d, { at: Date.now(), hosts });
}

export const labelOf = (host: string, domain: string) =>
  host === domain ? "" : host.slice(0, Math.max(0, host.length - domain.length - 1));
