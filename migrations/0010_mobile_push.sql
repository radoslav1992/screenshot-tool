CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  registered_at TEXT NOT NULL,
  UNIQUE(token, environment)
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(user_id);
CREATE TABLE IF NOT EXISTS push_deliveries (
  run_id TEXT NOT NULL REFERENCES watch_runs(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY(run_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_deliveries_due ON push_deliveries(status, next_attempt_at);
