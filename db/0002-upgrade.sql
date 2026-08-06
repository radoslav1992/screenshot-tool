-- Screenify upgrade: email verification + retention bookkeeping.
--
-- Run this in the D1 console (Cloudflare dashboard → Storage & Databases → D1 →
-- screenify-data → Console) on a database that already has the 0001 schema.
--
-- If you are setting up a fresh database instead, run db/apply-manually.sql,
-- which already contains everything below.
--
-- Note: `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite. If it reports
-- "duplicate column name: email_verified_at" the column is already there —
-- skip that one statement and run the rest.

ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- Existing accounts are treated as verified, so enabling verification later
-- never locks out anyone who signed up before it existed.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);

CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_verification_and_retention.sql');
