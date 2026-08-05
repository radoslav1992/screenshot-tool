-- Screenify initial schema (Cloudflare D1 / SQLite)

CREATE TABLE users (
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

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                          -- sha256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE api_keys (
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
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE captures (
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
CREATE INDEX idx_captures_user_created ON captures(user_id, created_at DESC);
CREATE INDEX idx_captures_user_mode ON captures(user_id, mode);

CREATE TABLE usage_counters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period  TEXT NOT NULL,                                -- YYYY-MM of the billing window
  used    INTEGER NOT NULL DEFAULT 0,
  via_app INTEGER NOT NULL DEFAULT 0,
  via_api INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
