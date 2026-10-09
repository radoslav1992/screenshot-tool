-- Monthly website care reports (src/lib/care-reports.ts): a branded summary
-- of a project's month for the agency's client, shared by link and, on the
-- plans that include it, emailed to the client on the 1st.
--
-- Additive: until these tables exist the care report panels are not rendered,
-- every care route answers 404 and the hourly cron sends nothing.
--
-- One row per project that has saved its settings. recipients is a JSON array
-- of up to five lower-cased client addresses the owner typed, used only to send
-- these reports. next_run_at is the next 1st of the month at 09:00 in the
-- project's timezone while enabled, and NULL while not.
CREATE TABLE IF NOT EXISTS care_report_settings (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 timezone TEXT NOT NULL DEFAULT 'UTC',
 recipients TEXT NOT NULL DEFAULT '[]',
 owner_copy INTEGER NOT NULL DEFAULT 1 CHECK(owner_copy IN (0,1)),
 next_run_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
-- The hourly sweep: enabled projects, oldest due first.
CREATE INDEX IF NOT EXISTS care_report_settings_due ON care_report_settings(enabled, next_run_at);
-- One frozen report per project, month and way it was made: the schedule makes
-- one a month and never replaces it; generating by hand again replaces the
-- manual one's snapshot. snapshot is the whole report as JSON, written at
-- generation, so retention and later edits never change what was sent.
-- token_hash is the SHA-256 of the owner's share link, NULL until one is made
-- and once revoked; the links emailed to clients are in care_report_deliveries.
CREATE TABLE IF NOT EXISTS care_reports (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL CHECK(length(period) = 7),
 kind TEXT NOT NULL CHECK(kind IN ('scheduled','manual')),
 generated_at TEXT NOT NULL,
 snapshot TEXT NOT NULL CHECK(length(snapshot) <= 262144),
 token_hash TEXT UNIQUE,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 access_count INTEGER NOT NULL DEFAULT 0,
 last_access_at TEXT,
 UNIQUE(project_id, period, kind)
);
-- Account deletion.
CREATE INDEX IF NOT EXISTS care_reports_user ON care_reports(user_id, generated_at);
-- One row per report and address, claimed before the email goes so it goes at
-- most once, then its outcome, as digest_deliveries does. A client's row
-- carries the hash of the link in their email; the owner's copy links to the
-- app instead and has none.
CREATE TABLE IF NOT EXISTS care_report_deliveries (
 report_id TEXT NOT NULL REFERENCES care_reports(id) ON DELETE CASCADE,
 email TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('client','owner')),
 token_hash TEXT UNIQUE,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL,
 opened_at TEXT,
 PRIMARY KEY(report_id, email)
);
-- A care report lists the project's review reports and their sign-offs; until
-- now reading them by project scanned every account's reports.
CREATE INDEX IF NOT EXISTS review_reports_project ON review_reports(project_id, created_at);
