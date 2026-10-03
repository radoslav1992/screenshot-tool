CREATE INDEX IF NOT EXISTS idx_watch_runs_user ON watch_runs(user_id, watch_id, created_at DESC);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0012_watch_runs_user_index.sql');
