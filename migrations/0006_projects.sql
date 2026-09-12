-- Additive: existing capture and monitor endpoints do not depend on these tables.
CREATE TABLE projects (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX projects_owner ON projects(user_id, created_at);
CREATE TABLE project_captures (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
 review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','changes')),
 PRIMARY KEY(project_id,capture_id)
);
CREATE TABLE project_watches (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
 PRIMARY KEY(project_id,watch_id)
);
CREATE TABLE capture_presets (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE review_reports (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
-- Capture IDs intentionally remain as historical references after retention deletes a capture.
CREATE TABLE report_captures (
 report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
 capture_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 3),
 PRIMARY KEY(report_id,position)
);
CREATE TABLE report_links (
 report_id TEXT PRIMARY KEY REFERENCES review_reports(id) ON DELETE CASCADE,
 token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 access_count INTEGER NOT NULL DEFAULT 0, last_access_at TEXT
);
CREATE TABLE report_comments (
 id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
 body TEXT NOT NULL, created_at TEXT NOT NULL
);
