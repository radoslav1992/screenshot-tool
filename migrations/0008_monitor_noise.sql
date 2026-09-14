CREATE TABLE watch_settings (
 watch_id TEXT PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
 hide TEXT NOT NULL DEFAULT '', ignore_regions TEXT NOT NULL DEFAULT ''
);
