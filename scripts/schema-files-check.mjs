/**
 * The hand-applied schema files agree with the migrations they stand in for.
 *
 * - db/apply-manually.sql builds exactly the schema (and d1_migrations ledger)
 *   that applying every migrations/*.sql in order does, and re-running it
 *   changes nothing.
 * - Every migration after 0001 has a db/NNNN-upgrade.sql that takes the schema
 *   from the one before it to the one after it, ledger row included.
 * - All of those files survive the D1 console, which flattens a paste onto one
 *   line: no `--` or `/*` comments, and each is run here flattened.
 *
 * New migrations are picked up from the directory, so adding 0013 without its
 * upgrade file or apply-manually.sql change fails here.
 *
 *   node scripts/schema-files-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const migrations = readdirSync(new URL('migrations/', root))
  .filter((file) => file.endsWith('.sql'))
  .sort();
for (const file of migrations) assert.match(file, /^\d{4}_[a-z0-9_]+\.sql$/, `migrations/${file} is named NNNN_name.sql`);
const numberOf = (file) => file.slice(0, 4);

/* ---------------------------------------------------------------- databases */

/** What `wrangler d1 migrations apply` does: its ledger table, then each file and its row. */
const WRANGLER_LEDGER = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
function migrated(count = migrations.length) {
  const db = new DatabaseSync(':memory:');
  db.exec(WRANGLER_LEDGER);
  for (const file of migrations.slice(0, count)) {
    db.exec(read(`migrations/${file}`));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
  }
  return db;
}

/** The D1 console runs a paste as one line. */
const flatten = (sql) => sql.replace(/\r?\n/g, ' ');

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const normalise = (sql) =>
  stripComments(sql)
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();

/** CHECK constraints are not visible through any pragma, so read them out of the stored SQL. */
function checksOf(sql) {
  const text = normalise(sql);
  const found = [];
  for (let at = text.indexOf('check('); at !== -1; at = text.indexOf('check(', at + 1)) {
    let depth = 0;
    let end = at + 5;
    do {
      if (text[end] === '(') depth++;
      if (text[end] === ')') depth--;
      end++;
    } while (depth > 0 && end < text.length);
    found.push(text.slice(at, end));
  }
  return found.sort();
}

/**
 * Everything about a schema that could make one database behave differently
 * from another — not the stored SQL text, which differs once ALTER TABLE has
 * appended to it.
 */
function describe(db) {
  const rows = (sql, ...args) => JSON.parse(JSON.stringify(db.prepare(sql).all(...args)));
  const schema = { tables: {}, other: {}, ledger: rows('SELECT name FROM d1_migrations ORDER BY name').map((r) => r.name) };
  for (const { name, sql } of rows("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
    schema.tables[name] = {
      columns: rows('SELECT * FROM pragma_table_xinfo(?)', name),
      foreignKeys: rows('SELECT * FROM pragma_foreign_key_list(?)', name),
      indexes: rows('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name', name).map((index) => ({
        ...index,
        columns: rows('SELECT * FROM pragma_index_xinfo(?)', index.name),
      })),
      checks: checksOf(sql ?? ''),
      autoincrement: /\bautoincrement\b/.test(normalise(sql ?? '')),
    };
  }
  for (const { type, name, sql } of rows("SELECT type, name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY name"))
    schema.other[`${type}:${name}`] = normalise(sql);
  return schema;
}

/** Names what differs, so a failure says where to look. */
function differences(actual, expected) {
  const out = [];
  for (const table of new Set([...Object.keys(actual.tables), ...Object.keys(expected.tables)])) {
    if (!actual.tables[table]) out.push(`table ${table} is missing`);
    else if (!expected.tables[table]) out.push(`table ${table} should not exist`);
    else
      for (const part of Object.keys(expected.tables[table]))
        if (JSON.stringify(actual.tables[table][part]) !== JSON.stringify(expected.tables[table][part]))
          out.push(`${table}: ${part} differ`);
  }
  if (JSON.stringify(actual.other) !== JSON.stringify(expected.other)) out.push('views or triggers differ');
  for (const name of expected.ledger) if (!actual.ledger.includes(name)) out.push(`d1_migrations has no row for ${name}`);
  for (const name of actual.ledger) if (!expected.ledger.includes(name)) out.push(`d1_migrations should not have a row for ${name}`);
  return out;
}

const assertSameSchema = (actual, expected, label) => {
  const found = differences(actual, expected);
  assert.deepEqual(found, [], `${label}:\n  ${found.join('\n  ')}`);
  assert.deepEqual(actual, expected, label);
};

const consoleSafe = (path) => {
  const text = read(path);
  assert.ok(!text.includes('--') && !text.includes('/*'), `${path} must be comment-free: the D1 console flattens it onto one line`);
  return text;
};

/* ----------------------------------------------------------- apply-manually */

const target = describe(migrated());
assert.deepEqual(target.ledger, [...migrations].sort(), 'the migrated ledger lists every migration');

const fresh = new DatabaseSync(':memory:');
const manual = consoleSafe('db/apply-manually.sql');
fresh.exec(flatten(manual));
assertSameSchema(describe(fresh), target, 'db/apply-manually.sql builds the schema the migrations do');
fresh.exec(flatten(manual));
assertSameSchema(describe(fresh), target, 'db/apply-manually.sql is safe to run twice');
assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, migrations.length);
// Data statements belong to upgrades. Re-run on a live database, 0011's UPDATE
// would hand every newer free account the grandfathered quota.
assert.doesNotMatch(manual, /^\s*(UPDATE|DELETE)\b/im, 'apply-manually.sql changes no rows');
fresh.close();

/* ------------------------------------------------------------ upgrade files */

const upgrades = readdirSync(new URL('db/', root)).filter((file) => /^\d{4}-upgrade\.sql$/.test(file));
assert.deepEqual(
  upgrades.sort(),
  migrations.filter((file) => numberOf(file) !== '0001').map((file) => `${numberOf(file)}-upgrade.sql`),
  'every migration after 0001 has a db/NNNN-upgrade.sql, and every upgrade file has a migration',
);

for (const [index, file] of migrations.entries()) {
  if (index === 0) continue;
  const path = `db/${numberOf(file)}-upgrade.sql`;
  assert.ok(existsSync(new URL(path, root)), `${path} exists for migrations/${file}`);
  const before = migrated(index);
  before.exec(flatten(consoleSafe(path)));
  assertSameSchema(describe(before), describe(migrated(index + 1)), `${path} is equivalent to migrations/${file}`);
  before.close();
}

console.log(
  `Schema file checks passed: apply-manually.sql matches ${migrations.length} migrations and re-runs cleanly, ` +
    `and ${upgrades.length} comment-free upgrade files each match their migration flattened onto one line.`,
);
