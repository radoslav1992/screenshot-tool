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
 * - src/lib/schema-manifest.ts lists every migration and exactly what each one
 *   creates, and /api/health reports from it.
 *
 * New migrations are picked up from the directory, so adding 0013 without its
 * upgrade file, manifest entry or apply-manually.sql change fails here.
 *
 *   node scripts/schema-files-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/* ----------------------------------------------------------- the manifest */

const directory = mkdtempSync(join(tmpdir(), 'schema-files-check-'));
const fixture = { env: {} };
globalThis.__schemaFiles = fixture;
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const env=globalThis.__schemaFiles.env;', loader: 'js' }));
  },
};

/** Just enough of D1 for the probes. */
const d1 = (db) => {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return { prepare: (sql) => statement(sql) };
};

try {
  for (const [name, entry] of Object.entries({ manifest: 'src/lib/schema-manifest.ts', health: 'src/pages/api/health.ts' }))
    await build({
      entryPoints: [new URL(entry, root).pathname],
      outfile: join(directory, `${name}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [plugin],
      logLevel: 'silent',
    });
  const { MIGRATIONS, CORE_TABLES, migrationStatus, upgradeFileFor } = await import(pathToFileURL(join(directory, 'manifest.mjs')));
  const { GET } = await import(pathToFileURL(join(directory, 'health.mjs')));

  assert.deepEqual(
    MIGRATIONS.map((entry) => entry.name),
    migrations,
    'src/lib/schema-manifest.ts has one entry per migration, in order',
  );
  assert.deepEqual(
    CORE_TABLES,
    ['users', 'sessions', 'api_keys', 'captures', 'usage_counters', 'email_verifications', 'billing_events', 'watches', 'watch_runs'],
    'the core tables are the ones /api/health has always required',
  );

  // Each entry is exactly what its migration creates: applied one at a time,
  // the objects that appear are the ones listed, no more and no fewer.
  const objects = (db) => {
    const found = new Set();
    for (const { type, name } of db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'").all()) {
      found.add(`${type}:${name}`);
      if (type === 'table') for (const column of db.prepare('SELECT name FROM pragma_table_info(?)').all(name)) found.add(`column:${name}.${column.name}`);
    }
    return found;
  };
  for (const [index, entry] of MIGRATIONS.entries()) {
    const before = objects(migrated(index));
    const after = objects(migrated(index + 1));
    const tables = [...after].filter((o) => o.startsWith('table:') && !before.has(o)).map((o) => o.slice(6));
    const added = [...after].filter((o) => !before.has(o) && !(o.startsWith('column:') && tables.includes(o.slice(7).split('.')[0])));
    const listed = [
      ...(entry.tables ?? []).map((t) => `table:${t}`),
      ...(entry.columns ?? []).map((c) => `column:${c}`),
      ...(entry.indexes ?? []).map((i) => `index:${i}`),
    ];
    assert.deepEqual(listed.sort(), added.sort(), `the manifest entry for ${entry.name} lists exactly what it creates`);
  }

  assert.equal(upgradeFileFor('0001_init.sql'), 'db/apply-manually.sql');
  assert.equal(upgradeFileFor('0011_apple_lite.sql'), 'db/0011-upgrade.sql');
  for (const entry of MIGRATIONS.slice(1)) assert.ok(existsSync(new URL(upgradeFileFor(entry.name), root)), `${upgradeFileFor(entry.name)} exists`);

  /* ------------------------------------------------------- probes, health */

  const complete = migrated();
  assert.ok((await migrationStatus(d1(complete))).every((entry) => entry.applied), 'a migrated database has everything');

  const empty = new DatabaseSync(':memory:');
  const nothing = await migrationStatus(d1(empty));
  assert.ok(nothing.every((entry) => !entry.applied));
  assert.equal(nothing[0].upgrade, 'db/apply-manually.sql');

  // Deployed ahead of 0011 and later ones: each is named, with the files to paste.
  const behind = migrated(migrations.indexOf('0011_apple_lite.sql'));
  const status = await migrationStatus(d1(behind));
  assert.deepEqual(
    status.filter((entry) => !entry.applied).map((entry) => [entry.name, entry.upgrade]),
    // 0011 and everything after it, including migrations added later.
    migrations.slice(migrations.indexOf('0011_apple_lite.sql')).map((name) => [name, upgradeFileFor(name)]),
  );
  assert.ok(status.find((entry) => entry.name === '0011_apple_lite.sql').missing.includes('users.free_quota'));

  // A console paste that stopped after its first statement is not "applied".
  behind.exec('ALTER TABLE users ADD COLUMN free_quota INTEGER NOT NULL DEFAULT 20');
  const partial = (await migrationStatus(d1(behind))).find((entry) => entry.name === '0011_apple_lite.sql');
  assert.equal(partial.applied, false);
  assert.ok(!partial.missing.includes('users.free_quota') && partial.missing.includes('users.apple_expires_at'));

  // The bundle holds on to this object, so it is filled in rather than replaced.
  Object.assign(fixture.env, { SHOTS: { head: async () => null }, RATE: { get: async () => null }, BROWSER: {} });
  const health = async (db) => {
    fixture.env.DB = d1(db);
    const response = await GET({});
    return { status: response.status, body: await response.json() };
  };

  let r = await health(complete);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.checks.database.ok, true);
  assert.deepEqual(r.body.checks.database.tables, CORE_TABLES, 'the existing tables field is kept');
  assert.deepEqual(r.body.migrations.map((entry) => entry.name), migrations, 'every migration is reported');
  assert.ok(r.body.migrations.every((entry) => entry.applied === true));

  r = await health(behind);
  assert.equal(r.status, 503, 'code that needs a missing migration is not a healthy deployment');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.checks.database.missing, undefined, 'core tables are all there');
  assert.match(r.body.checks.database.detail, /0011_apple_lite\.sql \([^)]*users\.apple_expires_at/);
  assert.match(r.body.checks.database.detail, /paste db\/0011-upgrade\.sql, then db\/0012-upgrade\.sql/);

  // Only an optional migration missing: named, but not an outage.
  const optionalOnly = migrated();
  optionalOnly.exec('DROP INDEX idx_watch_runs_user');
  r = await health(optionalOnly);
  assert.equal(r.status, 200, 'a deployment ahead of an optional migration is still healthy');
  assert.equal(r.body.checks.database.ok, true);
  assert.match(r.body.checks.database.detail, /optional.*0012_watch_runs_user_index\.sql.*db\/0012-upgrade\.sql/);
  const pendingOptional = r.body.migrations.find((entry) => entry.name === '0012_watch_runs_user_index.sql');
  assert.equal(pendingOptional.applied, false);
  assert.equal(pendingOptional.optional, true);

  r = await health(empty);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body.checks.database.missing, CORE_TABLES, 'an empty database still names the core tables');
  assert.deepEqual(r.body.checks.database.tables, []);
  assert.match(r.body.checks.database.detail, /apply-manually\.sql/);

  console.log(
    `Schema file checks passed: apply-manually.sql matches ${migrations.length} migrations and re-runs cleanly, ` +
      `${upgrades.length} comment-free upgrade files each match their migration flattened onto one line, ` +
      'and the health manifest lists exactly what every migration creates.',
  );
} finally {
  delete globalThis.__schemaFiles;
  rmSync(directory, { recursive: true, force: true });
}
