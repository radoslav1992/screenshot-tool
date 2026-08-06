-- Screenify: full schema for a fresh D1 database.
--
-- Use this when you cannot run `wrangler d1 migrations apply` — paste it into
-- the D1 console (Cloudflare dashboard → Storage & Databases → D1 → screenify →
-- Console) and run it as one statement batch.
--
-- It is 0001_init.sql plus the bookkeeping row wrangler keeps in `d1_migrations`,
-- so a later `npm run db:migrate` sees 0001 as already applied and moves on to
-- any newer migration instead of re-running this one.
--
-- Safe to re-run: every statement uses IF NOT EXISTS and the final INSERT is
-- OR IGNORE.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT,                                  -- NULL for OAuth-only accounts
  plan          TEXT NOT NULL DEFAULT 'free',          -- free | pro | business
  period_start  TEXT NOT NULL,                         -- ISO date the current quota window opened
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                          -- sha256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash         TEXT NOT NULL UNIQUE,                    -- sha256 of the full key
  prefix       TEXT NOT NULL,                           -- e.g. sk_live_9f3k
  last4        TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'Production',
  environment  TEXT NOT NULL DEFAULT 'live',            -- live | test
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  host         TEXT NOT NULL,
  device       TEXT NOT NULL,                           -- desktop | tablet | mobile | custom
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  scale        REAL NOT NULL DEFAULT 2,
  mode         TEXT NOT NULL,                           -- visible | fullpage | series
  format       TEXT NOT NULL,                           -- png | jpg | pdf
  status       TEXT NOT NULL,                           -- pending | done | error
  error        TEXT,
  source       TEXT NOT NULL DEFAULT 'app',             -- app | api
  share_token  TEXT NOT NULL,
  files        TEXT NOT NULL DEFAULT '[]',              -- JSON: [{ key, name, bytes, width, height }]
  bytes        INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_user_created ON captures(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_user_mode ON captures(user_id, mode);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period  TEXT NOT NULL,                                -- YYYY-MM of the billing window
  used    INTEGER NOT NULL DEFAULT 0,
  via_app INTEGER NOT NULL DEFAULT 0,
  via_api INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

-- Wrangler's migration ledger. Recording 0001 here keeps a future
-- `npm run db:migrate` from trying to apply it a second time.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql');
