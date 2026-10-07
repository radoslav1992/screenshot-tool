CREATE TABLE IF NOT EXISTS plan_trials (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL DEFAULT 'pro', started_at TEXT NOT NULL, ends_at TEXT NOT NULL, reminded_at TEXT, ended_at TEXT, ip_hash TEXT);
CREATE INDEX IF NOT EXISTS plan_trials_open ON plan_trials(ended_at, ends_at);
CREATE INDEX IF NOT EXISTS plan_trials_ip ON plan_trials(ip_hash, started_at);
CREATE INDEX IF NOT EXISTS plan_trials_started ON plan_trials(started_at);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0019_plan_trials.sql');
