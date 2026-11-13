// Column metadata the SQL translator needs (types SQLite cannot express).

export const BOOL_COLS: Record<string, string[]> = {
  domains: ["enabled"],
  subdomains: ["is_active"],
  api_keys: ["revoked"],
  alert_subscriptions: ["is_active", "notify_live"],
  probe_results: ["failed", "takeover_risk"],
};

export const JSON_COLS: Record<string, string[]> = {
  scan_jobs: ["hosts"],
  api_keys: ["scopes"],
  alert_subscriptions: ["platform_ids", "domain_ids", "keywords", "live_status_codes"],
  notes: ["tags"],
  probe_results: ["technologies", "redirect_chain"],
  users: ["user_metadata"],
};

/** child table -> parent table -> foreign key column (all embeds are many-to-one). */
export const RELS: Record<string, Record<string, string>> = {
  subdomains: { domains: "domain_id" },
  probe_results: { domains: "domain_id", probe_jobs: "job_id" },
  probe_jobs: { domains: "domain_id" },
  scan_jobs: { domains: "domain_id" },
  scans: { domains: "domain_id" },
  domains: { platforms: "platform_id" },
  api_request_logs: { api_keys: "key_id" },
  api_keys: { profiles: "user_id" },
};

export const UUID_PK = new Set([
  "platforms", "domains", "subdomains", "scans", "scan_jobs", "daily_stats", "users", "profiles",
  "user_roles", "api_keys", "api_request_logs", "alert_subscriptions", "notes", "live_hosts",
  "probe_jobs", "probe_results",
]);

export const HAS_UPDATED_AT = new Set([
  "domains", "scan_jobs", "daily_stats", "profiles", "api_keys", "alert_subscriptions", "notes",
  "live_hosts", "probe_jobs",
]);

/** Tables owned per user (emulates the old Supabase RLS policies). */
export const USER_TABLES: Record<string, string> = {
  notes: "user_id",
  alert_subscriptions: "user_id",
  api_keys: "user_id",
  api_request_logs: "user_id",
  live_hosts: "user_id",
  profiles: "id",
};

/** Readable by anyone (the old "anyone can read" RLS policies). */
export const PUBLIC_TABLES = new Set([
  "platforms", "domains", "subdomains", "scans", "probe_jobs", "probe_results", "daily_stats",
]);

/** domains.last_scanned_at is derived from scan_ranges so unchanged roots cost no writes. */
export const virtualColumn = (table: string, col: string, alias: string): string | null => {
  if (table === "domains" && col === "last_scanned_at") {
    return `NULLIF(max(COALESCE((SELECT r.at FROM scan_ranges r WHERE r.start_domain <= ${alias}.domain AND r.end_domain >= ${alias}.domain ORDER BY r.at DESC LIMIT 1), ''), COALESCE(${alias}.last_scanned_at, '')), '')`;
  }
  return null;
};
