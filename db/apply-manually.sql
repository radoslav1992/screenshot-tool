-- Easy Screen Capture: full schema for a fresh D1 database.
--
-- Use this when you cannot run `wrangler d1 migrations apply` — paste it into
-- the D1 console (Cloudflare dashboard → Storage & Databases → D1 → screenify-data
-- → Console) and run it as one statement batch.
--
-- It is the full migration history (0001 through 0003) plus the bookkeeping rows
-- wrangler keeps in `d1_migrations`, so a later `npm run db:migrate` sees them
-- as already applied and moves on to any newer migration.
--
-- For a database that already has an older schema, run the matching
-- db/000N-upgrade.sql files in order instead — this file creates tables but will
-- not add columns to existing ones.
--
-- Safe to re-run: every statement uses IF NOT EXISTS and the final INSERT is
-- OR IGNORE.

CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL,
  email_lower            TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL DEFAULT '',
  password_hash          TEXT,                         -- NULL for OAuth-only accounts
  plan                   TEXT NOT NULL DEFAULT 'free', -- free | plus | pro | business
  period_start           TEXT NOT NULL,                -- ISO date the current quota window opened
  email_verified_at      TEXT,                         -- NULL until the address is confirmed
  stripe_customer_id     TEXT,                         -- set on first checkout, reused after
  stripe_subscription_id TEXT,
  plan_status            TEXT NOT NULL DEFAULT '',     -- '' | active | trialing | past_due | canceled
  plan_period_end        TEXT,                         -- paid through, ISO
  plan_interval          TEXT NOT NULL DEFAULT '',     -- '' | monthly | yearly
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT PRIMARY KEY,                          -- sha256 of the emailed token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);

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
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period  TEXT NOT NULL,                                -- YYYY-MM of the billing window
  used    INTEGER NOT NULL DEFAULT 0,
  via_app INTEGER NOT NULL DEFAULT 0,
  via_api INTEGER NOT NULL DEFAULT 0,
  via_watch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

-- A saved capture that re-runs on a schedule and alerts when the page changes.
CREATE TABLE IF NOT EXISTS watches (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               TEXT NOT NULL DEFAULT '',
  url                 TEXT NOT NULL,
  host                TEXT NOT NULL,
  device              TEXT NOT NULL,                    -- desktop | tablet | mobile | custom
  width               INTEGER NOT NULL,
  height              INTEGER NOT NULL,
  scale               REAL NOT NULL DEFAULT 2,
  mode                TEXT NOT NULL DEFAULT 'fullpage', -- visible | fullpage
  format              TEXT NOT NULL DEFAULT 'png',
  frequency           TEXT NOT NULL,                    -- hourly | daily | weekly
  threshold           REAL NOT NULL DEFAULT 1.0,        -- % of pixels that must differ
  notify_email        INTEGER NOT NULL DEFAULT 1,
  webhook_url         TEXT,
  status              TEXT NOT NULL DEFAULT 'active',   -- active | paused
  baseline_capture_id TEXT,                             -- the previous run, to diff against
  last_run_at         TEXT,
  next_run_at         TEXT NOT NULL,
  last_changed_at     TEXT,
  last_change_pct     REAL,
  last_error          TEXT,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_watches_baseline ON watches(baseline_capture_id);

-- One row per run, so the history outlives the captures retention sweeps away.
CREATE TABLE IF NOT EXISTS watch_runs (
  id                  TEXT PRIMARY KEY,
  watch_id            TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  capture_id          TEXT,
  baseline_capture_id TEXT,
  status              TEXT NOT NULL,                    -- done | error | skipped
  changed             INTEGER NOT NULL DEFAULT 0,
  change_pct          REAL,
  detail              TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_runs_watch ON watch_runs(watch_id, created_at DESC);

-- Stripe retries webhooks, and a retry must not be replayed as a second
-- upgrade. Every handled event id is recorded here first.
CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,                         -- Stripe event id (evt_…)
  type        TEXT NOT NULL,
  user_id     TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);

-- Wrangler's migration ledger. Recording the migrations here keeps a future
-- `npm run db:migrate` from trying to apply them a second time.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_verification_and_retention.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_billing.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_watches.sql');
