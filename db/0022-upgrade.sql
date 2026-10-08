CREATE TABLE IF NOT EXISTS baseline_approvals (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE, capture_id TEXT NOT NULL, report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE, signoff_id TEXT NOT NULL REFERENCES report_signoffs(id) ON DELETE CASCADE, pinned_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS baseline_approvals_watch ON baseline_approvals(watch_id, pinned_at);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0022_baseline_approvals.sql');
