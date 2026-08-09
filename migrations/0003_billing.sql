-- Stripe billing: subscription state on the user, plus webhook idempotency.

-- Set once the account has a Stripe customer, and reused for every later
-- checkout so one person never accumulates duplicate customers.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;

-- Mirrors the Stripe subscription status: '' (never subscribed), active,
-- trialing, past_due, canceled, … The plan column stays the source of truth for
-- entitlements; this only explains why it is what it is.
ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT '';

-- End of the paid period, ISO. A cancelled subscription keeps its plan until
-- this passes, which is what the customer paid for.
ALTER TABLE users ADD COLUMN plan_period_end TEXT;
ALTER TABLE users ADD COLUMN plan_interval TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_users_stripe_customer ON users(stripe_customer_id);

-- Stripe retries webhooks, and a retry must not be replayed as a second
-- upgrade. Every handled event id is recorded here first.
CREATE TABLE billing_events (
  id          TEXT PRIMARY KEY,                         -- Stripe event id (evt_…)
  type        TEXT NOT NULL,
  user_id     TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_billing_events_received ON billing_events(received_at);
