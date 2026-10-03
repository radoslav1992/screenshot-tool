CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL,
  email_lower            TEXT NOT NULL UNIQUE,
  name                   TEXT NOT NULL DEFAULT '',
  password_hash          TEXT,
  plan                   TEXT NOT NULL DEFAULT 'free',
  period_start           TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  email_verified_at      TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  plan_status            TEXT NOT NULL DEFAULT '',
  plan_period_end        TEXT,
  plan_interval          TEXT NOT NULL DEFAULT '',
  free_quota             INTEGER NOT NULL DEFAULT 20,
  apple_expires_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
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
  hash         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  last4        TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'Production',
  environment  TEXT NOT NULL DEFAULT 'live',
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
  device       TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  scale        REAL NOT NULL DEFAULT 2,
  mode         TEXT NOT NULL,
  format       TEXT NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  source       TEXT NOT NULL DEFAULT 'app',
  share_token  TEXT NOT NULL,
  files        TEXT NOT NULL DEFAULT '[]',
  bytes        INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  facts        TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_user_created ON captures(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_user_mode ON captures(user_id, mode);
CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period    TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  via_app   INTEGER NOT NULL DEFAULT 0,
  via_api   INTEGER NOT NULL DEFAULT 0,
  via_watch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);

CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  user_id     TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);

CREATE TABLE IF NOT EXISTS watches (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               TEXT NOT NULL DEFAULT '',
  url                 TEXT NOT NULL,
  host                TEXT NOT NULL,
  device              TEXT NOT NULL,
  width               INTEGER NOT NULL,
  height              INTEGER NOT NULL,
  scale               REAL NOT NULL DEFAULT 2,
  mode                TEXT NOT NULL DEFAULT 'fullpage',
  format              TEXT NOT NULL DEFAULT 'png',
  frequency           TEXT NOT NULL,
  threshold           REAL NOT NULL DEFAULT 1.0,
  notify_email        INTEGER NOT NULL DEFAULT 1,
  webhook_url         TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  baseline_capture_id TEXT,
  last_run_at         TEXT,
  next_run_at         TEXT NOT NULL,
  last_changed_at     TEXT,
  last_change_pct     REAL,
  last_error          TEXT,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  baseline_pinned_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_watches_baseline ON watches(baseline_capture_id);

CREATE TABLE IF NOT EXISTS watch_runs (
  id                  TEXT PRIMARY KEY,
  watch_id            TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  capture_id          TEXT,
  baseline_capture_id TEXT,
  status              TEXT NOT NULL,
  changed             INTEGER NOT NULL DEFAULT 0,
  change_pct          REAL,
  detail              TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_runs_watch ON watch_runs(watch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_runs_user ON watch_runs(user_id, watch_id, created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  brand      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(user_id, created_at);

CREATE TABLE IF NOT EXISTS project_captures (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capture_id    TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','changes')),
  PRIMARY KEY(project_id,capture_id)
);

CREATE TABLE IF NOT EXISTS project_watches (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id,watch_id)
);

CREATE TABLE IF NOT EXISTS capture_presets (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  settings   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_reports (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_captures (
  report_id  TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
  capture_id TEXT NOT NULL,
  position   INTEGER NOT NULL CHECK(position BETWEEN 0 AND 3),
  PRIMARY KEY(report_id,position)
);

CREATE TABLE IF NOT EXISTS report_links (
  report_id      TEXT PRIMARY KEY REFERENCES review_reports(id) ON DELETE CASCADE,
  token_hash     TEXT UNIQUE NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT
);

CREATE TABLE IF NOT EXISTS report_comments (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email_lower TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('viewer','editor')),
  token_hash  TEXT UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id,email_lower)
);
CREATE INDEX IF NOT EXISTS members_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS team_comments (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_digests (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  PRIMARY KEY(project_id,user_id)
);

CREATE TABLE IF NOT EXISTS digest_deliveries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,user_id,week)
);

CREATE TABLE IF NOT EXISTS watch_settings (
  watch_id       TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  hide           TEXT NOT NULL DEFAULT '',
  ignore_regions TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS monitor_rules (
  watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL DEFAULT 'visual',
  phrase   TEXT NOT NULL DEFAULT '',
  selector TEXT NOT NULL DEFAULT '',
  region   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS alert_retries (
  run_id          TEXT PRIMARY KEY REFERENCES watch_runs(id) ON DELETE CASCADE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_retries_due ON alert_retries(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS push_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  environment   TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  registered_at TEXT NOT NULL,
  UNIQUE(token, environment)
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(user_id);

CREATE TABLE IF NOT EXISTS push_deliveries (
  run_id          TEXT NOT NULL REFERENCES watch_runs(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  reason          TEXT,
  PRIMARY KEY(run_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_deliveries_due ON push_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS apple_accounts (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  app_account_token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS apple_subscriptions (
  original_id   TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment   TEXT NOT NULL CHECK(environment IN ('Production','Sandbox')),
  product_id    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  checked_at    TEXT NOT NULL,
  next_check_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS apple_subscriptions_due ON apple_subscriptions(next_check_at);

CREATE TABLE IF NOT EXISTS capture_batches (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'app',
  project_id   TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  shots        INTEGER NOT NULL DEFAULT 0,
  notify       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  cancelled_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_batches_user ON capture_batches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_batches_completed ON capture_batches(completed_at);
CREATE TABLE IF NOT EXISTS capture_jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id    TEXT REFERENCES capture_batches(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  capture_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  device      TEXT NOT NULL,
  options     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'app',
  reserved    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'queued',
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  run_after   TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_status ON capture_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_user ON capture_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_batch ON capture_jobs(batch_id, updated_at);

CREATE TABLE IF NOT EXISTS report_signoffs (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
  decision   TEXT NOT NULL CHECK(decision IN ('approved','changes','reset')),
  name       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_signoffs_report ON report_signoffs(report_id, created_at);
CREATE TABLE IF NOT EXISTS project_branding (
  project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  logo_key         TEXT NOT NULL DEFAULT '',
  logo_type        TEXT NOT NULL DEFAULT '',
  logo_width       INTEGER NOT NULL DEFAULT 0,
  logo_height      INTEGER NOT NULL DEFAULT 0,
  accent           TEXT NOT NULL DEFAULT '',
  footer           TEXT NOT NULL DEFAULT '',
  hide_attribution INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_fast_checks (
  watch_id     TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'learning' CHECK(mode IN ('learning','fast','browser')),
  forced       INTEGER NOT NULL DEFAULT 0,
  signature    TEXT,
  agreements   INTEGER NOT NULL DEFAULT 0,
  mismatches   INTEGER NOT NULL DEFAULT 0,
  noise        INTEGER NOT NULL DEFAULT 0,
  unavailable  INTEGER NOT NULL DEFAULT 0,
  last_full_at TEXT,
  reason       TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_verification_and_retention.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_billing.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_watches.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_page_facts.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_projects.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_collaboration.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0008_monitor_noise.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0009_monitor_workflows.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0010_mobile_push.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0011_apple_lite.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0012_watch_runs_user_index.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0013_capture_jobs.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_pinned_baseline.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0015_report_signoff_branding.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0016_watch_fast_checks.sql');
