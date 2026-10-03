-- Growth (src/lib/attribution.ts, src/lib/growth.ts): where signups come
-- from, the referral programme and the bonus screenshots it pays out.
--
-- Additive: until these tables exist the attribution cookie is still set but
-- nothing is saved, the referral section stays hidden, every quota check
-- counts the monthly allowance alone, and /app/growth asks for this migration.

-- One row per account created since this migration: the first touch its
-- browser carried, 'ios' for the app, or nothing for a direct visit. Every
-- value arrives sanitised and capped; referrer_host is a host name, never a
-- URL. ip_hash is a truncated SHA-256 of the signup address, kept only to
-- refuse referrals from the same person.
CREATE TABLE IF NOT EXISTS signup_sources (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 ref TEXT,
 source TEXT,
 medium TEXT,
 campaign TEXT,
 landing TEXT,
 referrer_host TEXT,
 touched_at TEXT,
 ip_hash TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_sources_created ON signup_sources(created_at);

-- Each account's referral code, made the first time it is asked for and never
-- changed: /join/<code>.
CREATE TABLE IF NOT EXISTS referral_codes (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 code TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL
);

-- One row per account created through a referral link: at most one for any
-- account, whoever referred it. 'pending' until the account is confirmed and
-- active, then 'rewarded', or 'rejected' with a reason. A deleted referred
-- account leaves its row with referred_id NULL, so the referrer's history and
-- cap stay as they were.
CREATE TABLE IF NOT EXISTS referrals (
 id TEXT PRIMARY KEY,
 referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 referred_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rewarded','rejected')),
 reason TEXT,
 created_at TEXT NOT NULL,
 rewarded_at TEXT
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_id, status);
CREATE INDEX IF NOT EXISTS referrals_created ON referrals(created_at);

-- Bonus screenshots: a balance that never expires, spent only once the month's
-- allowance is.
CREATE TABLE IF NOT EXISTS bonus_balances (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 screenshots INTEGER NOT NULL DEFAULT 0 CHECK(screenshots >= 0),
 updated_at TEXT NOT NULL
);

-- How many of a month's screenshots came out of the bonus, so a refund puts
-- them back where they came from. `token` marks the reservation that last
-- drew on it, for the statements in the same batch (see reserveQuota).
CREATE TABLE IF NOT EXISTS bonus_usage (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL,
 used INTEGER NOT NULL DEFAULT 0,
 token TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (user_id, period)
);
