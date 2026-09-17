CREATE TABLE IF NOT EXISTS monitor_rules (
 watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
 kind TEXT NOT NULL DEFAULT 'visual',
 phrase TEXT NOT NULL DEFAULT '',
 selector TEXT NOT NULL DEFAULT '',
 region TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS alert_retries (
 run_id TEXT PRIMARY KEY REFERENCES watch_runs(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_retries_due ON alert_retries(status,next_attempt_at);
