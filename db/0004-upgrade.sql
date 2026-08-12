CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, host TEXT NOT NULL, device TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, scale REAL NOT NULL DEFAULT 2, mode TEXT NOT NULL DEFAULT 'fullpage', format TEXT NOT NULL DEFAULT 'png', frequency TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 1.0, notify_email INTEGER NOT NULL DEFAULT 1, webhook_url TEXT, status TEXT NOT NULL DEFAULT 'active', baseline_capture_id TEXT, last_run_at TEXT, next_run_at TEXT NOT NULL, last_changed_at TEXT, last_change_pct REAL, last_error TEXT, consecutive_errors INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_watches_baseline ON watches(baseline_capture_id);
CREATE TABLE IF NOT EXISTS watch_runs (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE, user_id TEXT NOT NULL, capture_id TEXT, baseline_capture_id TEXT, status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, change_pct REAL, detail TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_watch_runs_watch ON watch_runs(watch_id, created_at DESC);
ALTER TABLE usage_counters ADD COLUMN via_watch INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_watches.sql');
