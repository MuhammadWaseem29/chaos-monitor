-- Lovable "Chaos." schema ported to Cloudflare D1 (SQLite).
-- uuid -> TEXT, timestamptz -> ISO-8601 TEXT, bool -> INTEGER 0/1, arrays/jsonb -> JSON TEXT.
-- The engine's hash store (root_hashes), task queue (tasks) and meta from 0001 are kept.

DROP TABLE IF EXISTS programs;
DROP TABLE IF EXISTS roots;
DROP TABLE IF EXISTS subs;
DROP TABLE IF EXISTS daily;
DROP TABLE IF EXISTS program_daily;
DELETE FROM tasks;
DELETE FROM meta WHERE key LIKE 'snapshot_%' OR key IN ('index_etag', 'index_checked_at', 'api_roots_at');

CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6ee7b7',
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT,
  last_scan_status TEXT,
  total_subdomains INTEGER NOT NULL DEFAULT 0,
  new_subdomains_last_scan INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  platform_id TEXT REFERENCES platforms(id) ON DELETE SET NULL,
  claimed_at TEXT
) WITHOUT ROWID;
-- idx_domains_platform / idx_domains_total are created in 0003 (after the first
-- day's import, to stay inside D1's free 100k rows-written/day).

-- Only hosts discovered after a root's baseline live here (full lists come live from Chaos).
CREATE TABLE IF NOT EXISTS subdomains (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (domain_id, host)
);
CREATE INDEX IF NOT EXISTS idx_subdomains_first_seen_desc ON subdomains(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_subdomains_domain_first_seen ON subdomains(domain_id, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  total_returned INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','fetching','processing','success','error')),
  hosts TEXT,
  total_hosts INTEGER NOT NULL DEFAULT 0,
  processed_hosts INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_one_active_per_domain ON scan_jobs(domain_id)
  WHERE status IN ('queued','fetching','processing');
CREATE INDEX IF NOT EXISTS scan_jobs_pending_idx ON scan_jobs(status, created_at);

-- One row per engine minute: which alphabetical slice of domains was rescanned and when.
-- Gives every domain an accurate "last scanned" time without a write per domain.
CREATE TABLE IF NOT EXISTS scan_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_domain TEXT NOT NULL,
  end_domain TEXT NOT NULL,
  domains_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_ranges_at ON scan_ranges(at DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  new_subdomains INTEGER NOT NULL DEFAULT 0,
  scans_run INTEGER NOT NULL DEFAULT 0,
  scan_errors INTEGER NOT NULL DEFAULT 0,
  total_subdomains INTEGER NOT NULL DEFAULT 0,
  probed INTEGER NOT NULL DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  invocations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Auth (replaces Supabase auth.users).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  user_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- One row per key per hour (Lovable stored one row per request; too many writes for D1 free).
CREATE TABLE IF NOT EXISTS api_request_logs (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'GET',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 200,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (key_id, hour)
);
CREATE INDEX IF NOT EXISTS api_request_logs_user ON api_request_logs(user_id, hour DESC);

CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily',
  scope TEXT NOT NULL DEFAULT 'all',
  platform_ids TEXT NOT NULL DEFAULT '[]',
  domain_ids TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  last_host_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_count INTEGER NOT NULL DEFAULT 0,
  notify_live INTEGER NOT NULL DEFAULT 0,
  last_live_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  live_status_codes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS alert_subscriptions_due ON alert_subscriptions(is_active, last_sent_at);
CREATE INDEX IF NOT EXISTS alert_subscriptions_user ON alert_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board TEXT NOT NULL DEFAULT 'other',
  host TEXT,
  scheme TEXT NOT NULL DEFAULT 'https',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS notes_user_board_idx ON notes(user_id, board, created_at DESC);

CREATE TABLE IF NOT EXISTS live_hosts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS probe_jobs (
  id TEXT PRIMARY KEY,
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  platform_slug TEXT,
  program TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  search TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  total_hosts INTEGER NOT NULL DEFAULT 0,
  probed_hosts INTEGER NOT NULL DEFAULT 0,
  live_hosts INTEGER NOT NULL DEFAULT 0,
  cursor_host TEXT NOT NULL DEFAULT '',
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  error_message TEXT,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS probe_jobs_status ON probe_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS probe_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES probe_jobs(id) ON DELETE CASCADE,
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  status_code INTEGER,
  title TEXT,
  content_length INTEGER,
  content_type TEXT,
  response_time_ms INTEGER,
  webserver TEXT,
  technologies TEXT NOT NULL DEFAULT '[]',
  cdn TEXT,
  ip TEXT,
  asn TEXT,
  cname TEXT,
  redirect_chain TEXT NOT NULL DEFAULT '[]',
  tls_issuer TEXT,
  tls_expires_at TEXT,
  body_hash TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  probed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  takeover_risk INTEGER NOT NULL DEFAULT 0,
  takeover_service TEXT,
  takeover_evidence TEXT,
  UNIQUE (host)
);
CREATE INDEX IF NOT EXISTS probe_results_domain ON probe_results(domain_id);
CREATE INDEX IF NOT EXISTS probe_results_live_idx ON probe_results(probed_at DESC) WHERE failed = 0;
CREATE INDEX IF NOT EXISTS probe_results_takeover_idx ON probe_results(probed_at DESC) WHERE takeover_risk = 1;

INSERT OR IGNORE INTO platforms (id, slug, name, color, website) VALUES
  ('8f1f6d3e-0d6a-4c39-9d6c-000000000001', 'hackerone', 'HackerOne', '#ff6a55', 'https://hackerone.com'),
  ('8f1f6d3e-0d6a-4c39-9d6c-000000000002', 'bugcrowd', 'Bugcrowd', '#f26122', 'https://bugcrowd.com'),
  ('8f1f6d3e-0d6a-4c39-9d6c-000000000003', 'intigriti', 'Intigriti', '#ff6d3c', 'https://intigriti.com'),
  ('8f1f6d3e-0d6a-4c39-9d6c-000000000004', 'yeswehack', 'YesWeHack', '#e34a4a', 'https://yeswehack.com'),
  ('8f1f6d3e-0d6a-4c39-9d6c-000000000005', 'self', 'Self-hosted', '#22d3ee', NULL);
