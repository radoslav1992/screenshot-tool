CREATE TABLE IF NOT EXISTS capture_batches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'app', project_id TEXT, total INTEGER NOT NULL DEFAULT 0, shots INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT, completed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_capture_batches_user ON capture_batches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_batches_completed ON capture_batches(completed_at);
CREATE TABLE IF NOT EXISTS capture_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, batch_id TEXT REFERENCES capture_batches(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, capture_id TEXT NOT NULL, url TEXT NOT NULL, device TEXT NOT NULL, options TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'app', reserved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, run_after TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_status ON capture_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_user ON capture_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_batch ON capture_jobs(batch_id, updated_at);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0013_capture_jobs.sql');
