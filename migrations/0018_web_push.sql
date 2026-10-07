-- Web Push (src/lib/web-push.ts, src/lib/push.ts): monitor change alerts in
-- browsers and installed web apps, alongside the iOS app's APNs alerts.
--
-- Additive: until these tables exist, or until the VAPID secrets are set,
-- web push stays hidden, nothing is queued, and APNs and email alerts carry
-- on exactly as before.

-- One row per signed-in browser that turned alerts on. A browser keeps one
-- subscription per site, so a session has at most one; the endpoint is
-- unique, and subscribing it again from another session moves it there.
-- Signing out deletes the session, and the subscription with it. p256dh and
-- auth are the browser's public key and secret, base64url, used to encrypt
-- each alert; user_agent is trimmed and capped.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL UNIQUE,
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 user_agent TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 last_success_at TEXT
);
CREATE INDEX IF NOT EXISTS web_push_subscriptions_user ON web_push_subscriptions(user_id, created_at);
CREATE INDEX IF NOT EXISTS web_push_subscriptions_session ON web_push_subscriptions(session_id);

-- The delivery queue, column for column the same as push_deliveries, with
-- device_id naming a web_push_subscriptions row. A sibling table rather than
-- a nullable column on push_deliveries: there device_id is NOT NULL, part of
-- the primary key and a reference to push_devices, and SQLite can only loosen
-- that by rebuilding a live table the iOS app depends on. With the same
-- columns, one queue, claim, retry and expiry path in push.ts serves both.
CREATE TABLE IF NOT EXISTS web_push_deliveries (
 run_id TEXT NOT NULL REFERENCES watch_runs(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 reason TEXT,
 PRIMARY KEY(run_id, device_id)
);
CREATE INDEX IF NOT EXISTS web_push_deliveries_due ON web_push_deliveries(status, next_attempt_at);
