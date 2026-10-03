CREATE TABLE IF NOT EXISTS signup_sources (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, ref TEXT, source TEXT, medium TEXT, campaign TEXT, landing TEXT, referrer_host TEXT, touched_at TEXT, ip_hash TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS signup_sources_created ON signup_sources(created_at);
CREATE TABLE IF NOT EXISTS referral_codes (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, referred_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rewarded','rejected')), reason TEXT, created_at TEXT NOT NULL, rewarded_at TEXT);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_id, status);
CREATE INDEX IF NOT EXISTS referrals_created ON referrals(created_at);
CREATE TABLE IF NOT EXISTS bonus_balances (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, screenshots INTEGER NOT NULL DEFAULT 0 CHECK(screenshots >= 0), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bonus_usage (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, period TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, period));
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0017_growth.sql');
