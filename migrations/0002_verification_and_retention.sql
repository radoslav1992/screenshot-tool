-- Email verification + retention bookkeeping.

-- NULL means unverified. Existing accounts are grandfathered as verified so an
-- upgrade never locks anyone out of a deployment that had no verification.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE email_verifications (
  id         TEXT PRIMARY KEY,                          -- sha256 of the emailed token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX idx_email_verifications_expires ON email_verifications(expires_at);

-- Lets the retention sweep find expired captures without scanning per user.
CREATE INDEX idx_captures_created ON captures(created_at);
