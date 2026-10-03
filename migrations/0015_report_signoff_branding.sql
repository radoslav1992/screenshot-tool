-- Additive: report pages, share links and the PDF probe for these tables and
-- render exactly as before until they exist.
--
-- One row per client decision on a shared report. The latest row is the
-- current state; an owner's reset is a 'reset' row, so the history keeps it.
CREATE TABLE IF NOT EXISTS report_signoffs (
 id TEXT PRIMARY KEY,
 report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
 decision TEXT NOT NULL CHECK(decision IN ('approved','changes','reset')),
 name TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_signoffs_report ON report_signoffs(report_id, created_at);
-- Per-project report branding. The logo itself lives in R2 at logo_key
-- (brand/<project_id>/<random>.<ext>); the dimensions are read from its header.
CREATE TABLE IF NOT EXISTS project_branding (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 logo_key TEXT NOT NULL DEFAULT '',
 logo_type TEXT NOT NULL DEFAULT '',
 logo_width INTEGER NOT NULL DEFAULT 0,
 logo_height INTEGER NOT NULL DEFAULT 0,
 accent TEXT NOT NULL DEFAULT '',
 footer TEXT NOT NULL DEFAULT '',
 hide_attribution INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
