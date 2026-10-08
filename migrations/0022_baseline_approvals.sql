-- Which client approval pinned which monitor baseline (src/lib/approval-baseline.ts).
--
-- When a client approves a shared review report, each capture in it that one
-- of the owner's monitors took becomes that monitor's pinned baseline, and one
-- row here records it. pinned_at is exactly the watches.baseline_pinned_at the
-- approval wrote, so the monitor page names the approval only while that pin
-- stands: pinning again writes a new time and unpinning clears it, and either
-- way the row stops matching. The client's name and the date come from the
-- sign-off row. capture_id has no reference, like report_captures: retention
-- may delete a capture, and a row that no longer matches is never shown.
--
-- Additive: until this table exists an approval still pins (that needs only
-- 0014), and the monitor page just does not say which approval did it.
CREATE TABLE IF NOT EXISTS baseline_approvals (
 id TEXT PRIMARY KEY,
 watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
 capture_id TEXT NOT NULL,
 report_id TEXT NOT NULL REFERENCES review_reports(id) ON DELETE CASCADE,
 signoff_id TEXT NOT NULL REFERENCES report_signoffs(id) ON DELETE CASCADE,
 pinned_at TEXT NOT NULL
);
-- The monitor page and GET /api/watches/:id: the row for a monitor's current pin.
CREATE INDEX IF NOT EXISTS baseline_approvals_watch ON baseline_approvals(watch_id, pinned_at);
