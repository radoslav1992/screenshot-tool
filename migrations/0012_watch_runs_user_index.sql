-- The monitor dashboard aggregates run history per account. Without this index
-- every load scanned all accounts' runs. Index only; no code depends on it.
CREATE INDEX IF NOT EXISTS idx_watch_runs_user ON watch_runs(user_id, watch_id, created_at DESC);
