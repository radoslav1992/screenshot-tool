-- A pinned baseline: when set, every check compares against baseline_capture_id
-- and none replaces it. NULL (every existing watch) keeps comparing each check
-- with the one before. The code probes for this column, so deploying before it
-- exists only hides pinning.
ALTER TABLE watches ADD COLUMN baseline_pinned_at TEXT;
