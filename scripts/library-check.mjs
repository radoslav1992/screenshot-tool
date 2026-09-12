import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureListQuery } from '../src/lib/capture-list.ts';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE captures (id TEXT, user_id TEXT, url TEXT, mode TEXT, created_at TEXT)');
const insert = db.prepare('INSERT INTO captures VALUES (?, ?, ?, ?, ?)');
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
db.close();
console.log('Library checks passed: owner isolation, literal search, modes, pagination, and API cursor.');
