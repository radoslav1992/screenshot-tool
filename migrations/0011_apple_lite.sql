ALTER TABLE users ADD COLUMN free_quota INTEGER NOT NULL DEFAULT 20;
UPDATE users SET free_quota = 200 WHERE plan = 'free';
ALTER TABLE users ADD COLUMN apple_expires_at TEXT;
CREATE TABLE apple_accounts (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 app_account_token TEXT NOT NULL UNIQUE
);
CREATE TABLE apple_subscriptions (
 original_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 environment TEXT NOT NULL CHECK(environment IN ('Production','Sandbox')),
 product_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 checked_at TEXT NOT NULL,
 next_check_at TEXT NOT NULL
);
CREATE INDEX apple_subscriptions_due ON apple_subscriptions(next_check_at);
