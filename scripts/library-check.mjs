import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureListQuery, monitorFoldersQuery } from '../src/lib/capture-list.ts';
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE captures (id TEXT, user_id TEXT, url TEXT, mode TEXT, created_at TEXT, source TEXT NOT NULL DEFAULT 'app')");
const insert = db.prepare('INSERT INTO captures (id, user_id, url, mode, created_at) VALUES (?, ?, ?, ?, ?)');
for (const row of [
  ['a', 'owner', 'https://example.com/Prices', 'fullpage', '2026-09-12'],
  ['b', 'owner', 'https://example.com/offer_10%', 'visible', '2026-09-12'],
  ['c', 'other', 'https://example.com/Prices', 'fullpage', '2026-09-12'],
  ['d', 'owner', 'https://another.test/', 'fullpage', '2026-09-11'],
])
  insert.run(...row);
const list = (options) => {
  const { sql, binds } = captureListQuery('owner', options);
  return db
    .prepare(sql)
    .all(...binds)
    .map((row) => row.id);
};
assert.deepEqual(list({ search: 'PRICES' }), ['a'], 'search must be case insensitive and owner scoped');
assert.deepEqual(list({ search: '10%' }), ['b'], 'percent is literal, not a wildcard');
assert.deepEqual(list({ search: "' OR 1=1 --" }), [], 'search must remain a bound value');
assert.deepEqual(list({ mode: 'visible', search: 'example' }), ['b']);
assert.deepEqual(list({ limit: 1 }), ['b']);
assert.deepEqual(list({ limit: 1, offset: 1 }), ['a'], 'equal timestamps must paginate deterministically');
assert.deepEqual(list({ cursor: '2026-09-12' }), ['d'], 'existing API cursor must keep working');
assert.deepEqual(list({ limit: NaN, offset: -20 }), ['b', 'a', 'd']);
db.exec(`
  CREATE TABLE watches (id TEXT, user_id TEXT, baseline_capture_id TEXT, label TEXT, url TEXT, status TEXT, created_at TEXT);
  CREATE TABLE watch_runs (watch_id TEXT, user_id TEXT, capture_id TEXT, baseline_capture_id TEXT);
  INSERT INTO watches VALUES ('job1', 'owner', 'a', 'Desktop', 'https://example.com/Prices', 'active', '2026-09-12'),
    ('job2', 'owner', 'e', 'Mobile', 'https://example.com/Prices', 'paused', '2026-09-12'),
    ('foreign', 'other', 'c', 'Private', 'https://example.com/Prices', 'active', '2026-09-12');
  INSERT INTO captures VALUES ('e', 'owner', 'https://example.com/Prices', 'visible', '2026-09-13', 'watch'),
    ('f', 'owner', 'https://example.com/Prices', 'fullpage', '2026-09-14', 'watch'),
    ('g', 'owner', 'https://example.com/Prices', 'fullpage', '2026-09-15', 'watch'),
    ('h', 'owner', 'https://example.com/Prices', 'fullpage', '2026-09-16', 'api');
  INSERT INTO watch_runs VALUES ('job1', 'owner', 'f', 'a'), ('job1', 'owner', 'f', 'a');
`);
assert.deepEqual(list({ collection: 'regular' }), ['h', 'b', 'd'], 'exclude linked legacy app baselines but retain unrelated same-URL captures');
assert.deepEqual(list({ collection: 'monitors', watchId: 'job1' }), ['f', 'a'], 'one copy per capture, including legacy baseline');
assert.deepEqual(list({ collection: 'monitors', watchId: 'job2' }), ['e'], 'same URL jobs stay separate');
assert.deepEqual(list({ collection: 'monitors', watchId: 'foreign' }), [], 'foreign jobs cannot expose captures');
assert.deepEqual(list({ collection: 'monitors', watchId: 'missing' }), []);
assert.deepEqual(list({ collection: 'monitors', unassigned: true }), ['g']);
assert.deepEqual(list({ collection: 'monitors', watchId: 'job1', limit: 1, offset: 1, search: 'PRICES', mode: 'fullpage' }), ['a']);
assert.deepEqual(list({}), ['h', 'g', 'f', 'e', 'b', 'a', 'd'], 'API default remains compatible');
db.exec("ALTER TABLE captures ADD COLUMN status TEXT DEFAULT 'done'");
db.exec("ALTER TABLE watch_runs ADD COLUMN changed INTEGER DEFAULT 1");
assert.deepEqual(list({collection:'monitors',watchId:'job1',changedOnly:true}),['f']);
const folders = (search = '') => {
  const { sql, binds } = monitorFoldersQuery('owner', search);
  return db.prepare(sql).all(...binds).map(({ id, capture_count }) => [id, capture_count]);
};
assert.deepEqual(folders(), [['job2', 1], ['job1', 2]], 'folder counts exclude duplicates and foreign jobs');
assert.deepEqual(folders('DESKTOP'), [['job1', 2]]);
assert.deepEqual(folders("' OR 1=1 --"), []);
db.exec("DELETE FROM watches WHERE id = 'job2'");
assert.deepEqual(list({ collection: 'monitors', unassigned: true }), ['g', 'e'], 'deleted job captures remain accessible');
db.close();
console.log('Library checks passed: owner isolation, literal search, modes, pagination, API compatibility, monitor folders, baselines, and unassigned captures.');
