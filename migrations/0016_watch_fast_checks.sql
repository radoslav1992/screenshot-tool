-- Smart checks (src/lib/fast-checks.ts): how each rule-based monitor checks
-- its page. One row per monitor that has been checked since this table
-- existed; visual monitors never get one.
--
-- mode: 'learning' reads the HTML and renders on every check, comparing the
-- two; 'fast' renders only when the HTML read changed; 'browser' renders on
-- every check, as before, with `reason` saying why in plain words. `forced` is
-- the owner's "Always use a full browser". The counters belong to the mode:
-- agreements, mismatches and noise while learning, unavailable reads in a row
-- once fast. `signature` is the hash the last HTML read gave, taken with the
-- last full check; `last_full_at` is when that check ran.
--
-- Additive: without this table every monitor renders on every check exactly
-- as before, and the 15-minute schedule is not offered.
CREATE TABLE IF NOT EXISTS watch_fast_checks (
 watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
 mode TEXT NOT NULL DEFAULT 'learning' CHECK(mode IN ('learning','fast','browser')),
 forced INTEGER NOT NULL DEFAULT 0,
 signature TEXT,
 agreements INTEGER NOT NULL DEFAULT 0,
 mismatches INTEGER NOT NULL DEFAULT 0,
 noise INTEGER NOT NULL DEFAULT 0,
 unavailable INTEGER NOT NULL DEFAULT 0,
 last_full_at TEXT,
 reason TEXT,
 updated_at TEXT NOT NULL
);
