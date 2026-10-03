-- Background captures. A job is a capture that waits its turn: its captures row
-- and its quota are taken when it is asked for, and the minute cron renders it
-- later, a few at a time. A batch groups the jobs one request queued.
--
-- Optional at runtime: until this is applied the app keeps the synchronous
-- batch form, `async` captures run inline, and /api/batches answers 503
-- setup_required.

CREATE TABLE IF NOT EXISTS capture_batches (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'app',              -- app | api
  project_id   TEXT,                                     -- finished captures are added to this project
  total        INTEGER NOT NULL DEFAULT 0,               -- captures queued
  shots        INTEGER NOT NULL DEFAULT 0,               -- screenshots reserved from the quota
  notify       INTEGER NOT NULL DEFAULT 0,               -- 1: email the owner when it finishes
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  cancelled_at TEXT,
  completed_at TEXT                                      -- set once, when nothing is left to run
);
CREATE INDEX IF NOT EXISTS idx_capture_batches_user ON capture_batches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_batches_completed ON capture_batches(completed_at);

CREATE TABLE IF NOT EXISTS capture_jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id    TEXT REFERENCES capture_batches(id) ON DELETE CASCADE, -- NULL for a single async capture
  position    INTEGER NOT NULL DEFAULT 0,                -- order within the batch, as it was asked for
  capture_id  TEXT NOT NULL,                             -- the captures row this job fills in
  url         TEXT NOT NULL,
  device      TEXT NOT NULL,
  options     TEXT NOT NULL,                             -- JSON capture parameters; never credentials
  source      TEXT NOT NULL DEFAULT 'app',               -- app | api: the usage counter it was charged to
  reserved    INTEGER NOT NULL DEFAULT 0,                -- screenshots reserved, settled when it runs
  status      TEXT NOT NULL DEFAULT 'queued',            -- queued | running | done | error | cancelled
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,                                      -- a running job whose lease lapsed is taken again
  run_after   TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_status ON capture_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_user ON capture_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_capture_jobs_batch ON capture_jobs(batch_id, updated_at);
