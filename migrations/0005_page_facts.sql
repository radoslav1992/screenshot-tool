-- What a capture found out about the page, as JSON, when `facts=1` asked for it.
-- Nullable and unindexed: it is a payload to hand back, never a filter.
ALTER TABLE captures ADD COLUMN facts TEXT;
