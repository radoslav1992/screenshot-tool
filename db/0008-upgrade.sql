CREATE TABLE IF NOT EXISTS watch_settings (
 watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
 hide TEXT NOT NULL DEFAULT '', ignore_regions TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0008_monitor_noise.sql');
