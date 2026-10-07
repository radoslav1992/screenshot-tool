-- Pro trials (src/lib/trial-plan.ts, src/lib/trials.ts): 14 days of Pro, once
-- per account, with no card.
--
-- One row per account that ever started one, kept while the account exists so
-- a second trial can be refused. users.plan is never written by a trial: the
-- account acts on Pro while ends_at is ahead and ended_at is empty, and on its
-- own plan again as soon as it is not. reminded_at and ended_at mark the two
-- emails as sent; ended_at is also set, with no email, when the account starts
-- paying for Pro or Business during the trial. ip_hash is the truncated
-- SHA-256 of the address the trial was started from, hashed like the signup
-- address (lib/growth.ts), used only to cap trials from one place.
--
-- Additive: until this table exists nobody is offered a trial, POST /api/trial
-- answers 404, and every plan is exactly what it was.
CREATE TABLE IF NOT EXISTS plan_trials (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 plan TEXT NOT NULL DEFAULT 'pro',
 started_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 reminded_at TEXT,
 ended_at TEXT,
 ip_hash TEXT
);
-- The hourly sweep: trials still open, by when they end.
CREATE INDEX IF NOT EXISTS plan_trials_open ON plan_trials(ended_at, ends_at);
-- The cap on trials started from one address in 30 days.
CREATE INDEX IF NOT EXISTS plan_trials_ip ON plan_trials(ip_hash, started_at);
-- The owner's growth dashboard, which reads the last 90 days.
CREATE INDEX IF NOT EXISTS plan_trials_started ON plan_trials(started_at);
