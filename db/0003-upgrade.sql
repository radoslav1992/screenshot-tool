ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN plan_period_end TEXT;
ALTER TABLE users ADD COLUMN plan_interval TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, user_id TEXT, received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_billing.sql');
