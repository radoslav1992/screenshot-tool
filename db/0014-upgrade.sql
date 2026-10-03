ALTER TABLE watches ADD COLUMN baseline_pinned_at TEXT;
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_pinned_baseline.sql');
