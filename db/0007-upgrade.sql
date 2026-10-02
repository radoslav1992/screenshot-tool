CREATE TABLE IF NOT EXISTS project_members (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 email_lower TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('viewer','editor')), token_hash TEXT UNIQUE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,email_lower)
);
CREATE INDEX IF NOT EXISTS members_user ON project_members(user_id);
CREATE TABLE IF NOT EXISTS team_comments (
 id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_digests (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, next_run_at TEXT NOT NULL,
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS digest_deliveries (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,user_id,week)
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_collaboration.sql');
