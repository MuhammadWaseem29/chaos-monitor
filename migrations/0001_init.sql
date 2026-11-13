-- Chaos monitor on Cloudflare D1 (free plan friendly).
-- Writes are the scarce resource (100k rows/day), so indexes are kept minimal.

CREATE TABLE IF NOT EXISTS programs (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'other',
  program_url TEXT,
  zip_url TEXT,
  bounty INTEGER NOT NULL DEFAULT 0,
  host_count INTEGER NOT NULL DEFAULT 0,
  change INTEGER NOT NULL DEFAULT 0,
  is_new INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  checked_at TEXT,
  root_count INTEGER NOT NULL DEFAULT 0,
  zip_etag TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);

CREATE TABLE IF NOT EXISTS roots (
  domain TEXT PRIMARY KEY,
  program_slug TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'dataset',   -- dataset | api
  crc INTEGER,
  raw_size INTEGER NOT NULL DEFAULT 0,
  host_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | ok | too_large | error | removed
  error TEXT,
  baseline_at TEXT,
  checked_at TEXT,
  changed_at TEXT,
  last_new INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS roots_program ON roots(program_slug);
CREATE INDEX IF NOT EXISTS roots_status ON roots(status);

-- Known hosts per root, stored as a sorted Float64Array of 53-bit hashes.
CREATE TABLE IF NOT EXISTS root_hashes (
  domain TEXT PRIMARY KEY,
  hashes BLOB NOT NULL
);

-- Newly discovered hosts (+ probe results). Only "new" hosts live here.
CREATE TABLE IF NOT EXISTS subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL,
  program_slug TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  probe_state INTEGER NOT NULL DEFAULT 0,   -- 0 pending, 1 claimed, 2 done
  claimed_at INTEGER,
  probed_at TEXT,
  status_code INTEGER,
  title TEXT,
  webserver TEXT,
  cdn TEXT,
  ip TEXT,
  cname TEXT,
  final_url TEXT,
  tech TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  takeover INTEGER NOT NULL DEFAULT 0,
  takeover_service TEXT,
  takeover_evidence TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS subs_seen ON subs(first_seen_at);
CREATE INDEX IF NOT EXISTS subs_program ON subs(program_slug, id);
CREATE INDEX IF NOT EXISTS subs_root ON subs(root, id);
CREATE INDEX IF NOT EXISTS subs_probe ON subs(probe_state, id);
CREATE INDEX IF NOT EXISTS subs_live ON subs(live, id);
CREATE INDEX IF NOT EXISTS subs_takeover ON subs(takeover, id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- program | root | api_root
  key TEXT NOT NULL UNIQUE,
  prio INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(claimed_at, prio, id);

CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,
  new_subs INTEGER NOT NULL DEFAULT 0,
  probed INTEGER NOT NULL DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 0,
  takeovers INTEGER NOT NULL DEFAULT 0,
  roots_checked INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  invocations INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS program_daily (
  day TEXT NOT NULL,
  slug TEXT NOT NULL,
  new_subs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slug)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
