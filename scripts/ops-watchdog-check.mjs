/**
 * Watching our own service: the hourly self-check (src/lib/ops-watchdog.ts)
 * and the owner emails it sends, the hourly sweep's heartbeat on /api/health,
 * and the two GitHub workflows — CI in front of every deploy, and the uptime
 * check from outside. Real SQLite (every migration), an in-memory KV, a mocked
 * mailer. No network calls.
 *
 *   node scripts/ops-watchdog-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'ops-watchdog-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__ops = { env: {}, mails: [], mailReady: true });

const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__ops.env;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts':
    'export const canSendEmail = () => globalThis.__ops.mailReady;' +
    'export const mailTransport = () => (globalThis.__ops.mailReady ? "cloudflare" : "none");' +
    'export const sender = () => ({ email: "noreply@easyscreencapture.test" });' +
    'export async function sendMail(mail) { if (!globalThis.__ops.mailReady) return false; globalThis.__ops.mails.push(mail); return true; }',
};

const plugin = {
  name: 'ops-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
  },
};

let bundles = 0;
/** A fresh copy of a module, with its own per-isolate probe caches, as a new isolate would have. */
async function load(entry) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [plugin],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

/** A database with every migration, or every one but those named. */
function database({ without = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (without.includes(file)) continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** D1 over node:sqlite. */
function d1(db) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((q) => ({ meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } })) };
}

const kv = new Map();
const RATE = {
  get: async (key, type) => {
    const value = kv.get(key) ?? null;
    return value !== null && type === 'json' ? JSON.parse(value) : value;
  },
  put: async (key, value) => void kv.set(key, value),
  delete: async (key) => void kv.delete(key),
};
const SHOTS = { head: async () => null };

const ORIGIN = 'https://easyscreencapture.test';
const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-10-07T12:00:00Z');
const at = (ms) => new Date(ms).toISOString();

function world(options = {}) {
  const db = database(options);
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, {
    DB: d1(db),
    RATE,
    SHOTS,
    BROWSER: {},
    PUBLIC_SITE_URL: ORIGIN,
    OWNER_EMAILS: ' Owner@Example.test, ops@example.test ,owner@example.test,',
  });
  kv.clear();
  fx.mails.length = 0;
  fx.mailReady = true;
  db.prepare(
    `INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at)
     VALUES ('u1', 'u1@example.test', 'u1@example.test', 'u1', 'pro', ?, ?, ?)`,
  ).run(at(T0), at(T0), at(T0));
  return db;
}

let watches = 0;
function addWatch(db, { next, last = null, error = null, status = 'active' } = {}) {
  const id = `w${++watches}`;
  db.prepare(
    `INSERT INTO watches (id, user_id, url, host, device, width, height, frequency, status, next_run_at, last_run_at, last_error, created_at, updated_at)
     VALUES (?, 'u1', 'https://shop.example.test/', 'shop.example.test', 'desktop', 1440, 900, 'hourly', ?, ?, ?, ?, ?, ?)`,
  ).run(id, status, at(next ?? T0 + HOUR), last === null ? null : at(last), error, at(T0 - 30 * 24 * HOUR), at(T0));
  return id;
}

let jobs = 0;
function addJob(db, { status = 'queued', runAfter = T0, updated = T0 } = {}) {
  const id = `j${++jobs}`;
  db.prepare(
    `INSERT INTO capture_jobs (id, user_id, capture_id, url, device, options, status, run_after, created_at, updated_at)
     VALUES (?, 'u1', ?, 'https://shop.example.test/', 'desktop', '{}', ?, ?, ?, ?)`,
  ).run(id, `c${id}`, status, at(runAfter), at(runAfter), at(updated));
  return id;
}

const TEMPORARY = 'Temporarily unavailable: browser sessions are in use';
const failingKeys = (result) => result.checks.filter((c) => !c.ok).map((c) => c.key).sort();
const state = () => JSON.parse(kv.get('ops:watchdog') ?? 'null');
const recipients = () => fx.mails.map((m) => m.to).sort();

const errors = [];
const originalError = console.error;
const originalLog = console.log;
console.error = (...args) => {
  const line = args.map(String).join(' ');
  if (!line.includes('ExperimentalWarning')) errors.push(line);
};
console.log = (...args) => (String(args[0]).startsWith('ok ') ? originalLog(...args) : undefined);

try {
  world();
  const ops = await load('src/lib/ops-watchdog.ts');

  await section('a healthy service: every check passes, nothing is mailed, the run is remembered', async () => {
    const db = world();
    addWatch(db, { next: T0 + HOUR, last: T0 - HOUR });
    addWatch(db, { next: T0 - 30 * 60_000 }); // due, not late
    addWatch(db, { next: T0 - 5 * HOUR, status: 'paused' }); // paused monitors are never late
    const result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(
      result.checks.map((c) => c.key).sort(),
      ['database', 'kv', 'monitors', 'queue', 'renderer', 'schema', 'storage'],
    );
    assert.deepEqual(result.failing, []);
    assert.equal(result.sent, null);
    assert.equal(fx.mails.length, 0);
    assert.deepEqual(state(), { checkedAt: at(T0), failing: [], since: null, notifiedAt: null });
    assert.deepEqual(errors, []);
  });

  await section('late monitors: one email per owner, then quiet, a daily reminder, an update when it changes, and the all clear', async () => {
    const db = world();
    const late = addWatch(db, { next: T0 - 3 * HOUR });
    addWatch(db, { next: T0 - HOUR }); // an hour late is a backlog, not an outage

    let result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, ['monitors']);
    assert.equal(result.sent, 'problem');
    assert.deepEqual(recipients(), ['ops@example.test', 'owner@example.test'], 'each owner once, whatever the case or spacing');
    const [mail] = fx.mails;
    assert.equal(mail.subject, 'Easy Screen Capture: 1 problem needs a look');
    assert.match(mail.text, /1 active monitor is more than two hours late \(the oldest was due 2026-10-07T09:00:00\.000Z\)/);
    assert.match(mail.text, /Live status: https:\/\/easyscreencapture\.test\/api\/health/);
    assert.match(mail.text, /Passing: .*Database/);
    assert.deepEqual(state(), { checkedAt: at(T0), failing: ['monitors'], since: at(T0), notifiedAt: at(T0) });

    fx.mails.length = 0;
    result = await ops.runWatchdog(ORIGIN, T0 + HOUR);
    assert.equal(result.sent, null, 'the same failure an hour later is not news');
    assert.equal(fx.mails.length, 0);
    result = await ops.runWatchdog(ORIGIN, T0 + 23 * HOUR);
    assert.equal(fx.mails.length, 0);

    result = await ops.runWatchdog(ORIGIN, T0 + 24 * HOUR);
    assert.equal(result.sent, 'reminder');
    assert.equal(fx.mails[0].subject, 'Easy Screen Capture: 1 problem still needs a look');
    assert.match(fx.mails[0].text, /Still failing since 2026-10-07T12:00:00\.000Z/);
    assert.equal(state().notifiedAt, at(T0 + 24 * HOUR));

    // A second problem on top: told at once, and still counted from when the trouble began.
    fx.mails.length = 0;
    for (let i = 0; i < 3; i++) addWatch(db, { next: T0 + 30 * HOUR, last: T0 + 24 * HOUR, error: TEMPORARY });
    result = await ops.runWatchdog(ORIGIN, T0 + 25 * HOUR);
    assert.deepEqual(result.failing, ['monitors', 'renderer']);
    assert.equal(result.sent, 'problem');
    assert.equal(fx.mails[0].subject, 'Easy Screen Capture: 2 problems need a look');
    assert.equal(state().since, at(T0));

    // Fixed: one all-clear, then nothing.
    fx.mails.length = 0;
    db.prepare(`UPDATE watches SET next_run_at = ?, last_error = NULL`).run(at(T0 + 27 * HOUR));
    result = await ops.runWatchdog(ORIGIN, T0 + 26 * HOUR);
    assert.equal(result.sent, 'recovered');
    assert.equal(fx.mails.length, 2);
    assert.equal(fx.mails[0].subject, 'Easy Screen Capture: all checks pass again');
    assert.match(fx.mails[0].text, /the trouble began 2026-10-07T12:00:00\.000Z/);
    assert.match(fx.mails[0].text, /✓ Monitors running on time/);
    assert.deepEqual(state(), { checkedAt: at(T0 + 26 * HOUR), failing: [], since: null, notifiedAt: null });
    fx.mails.length = 0;
    result = await ops.runWatchdog(ORIGIN, T0 + 27 * HOUR);
    assert.equal(result.sent, null);
    assert.equal(fx.mails.length, 0);
    assert.ok(late);
  });

  await section('the renderer: only failures on our side, only recent ones, and only when they are most of what ran', async () => {
    const recent = T0 - 30 * 60_000;
    const check = async (rows) => {
      const db = world();
      for (const row of rows) addWatch(db, { next: T0 + HOUR, ...row });
      return failingKeys(await ops.runWatchdog(ORIGIN, T0));
    };
    const ours = { last: recent, error: TEMPORARY };
    const fine = { last: recent };
    assert.deepEqual(await check([ours, ours, ours, fine]), ['renderer'], 'three of four could not be served');
    assert.deepEqual(await check([ours, ours, fine, fine]), [], 'two is not enough to call it');
    assert.deepEqual(await check([ours, ours, ours, fine, fine, fine, fine, fine]), [], 'three of eight is the pages, not us');
    assert.deepEqual(await check([ours, ours, ours, ours, fine, fine, fine, fine]), ['renderer'], 'half is');
    assert.deepEqual(
      await check([{ last: recent, error: 'net::ERR_NAME_NOT_RESOLVED' }, { last: recent, error: 'HTTP 500 from the page' }, { last: recent, error: 'Timeout' }]),
      [],
      'a broken page is its owner’s problem, not ours',
    );
    assert.deepEqual(await check([{ last: T0 - 3 * HOUR, error: TEMPORARY }, { last: T0 - 3 * HOUR, error: TEMPORARY }, { last: T0 - 3 * HOUR, error: TEMPORARY }]), [], 'failures from hours ago are over');
    assert.deepEqual(await check([{ ...ours, status: 'paused' }, { ...ours, status: 'paused' }, { ...ours, status: 'paused' }]), [], 'paused monitors are not running');
  });

  await section('the capture queue: stuck when work waits half an hour and nothing finishes, fine while it moves', async () => {
    const check = async (rows) => {
      const db = world();
      for (const row of rows) addJob(db, row);
      return ops.runWatchdog(ORIGIN, T0);
    };
    let result = await check([{ runAfter: T0 - 40 * 60_000 }, { status: 'done', updated: T0 - 20 * 60_000 }]);
    assert.deepEqual(result.failing, ['queue']);
    assert.match(fx.mails[0].text, /1 background capture has waited more than 30 minutes and none finished in the last 15 \(last one: 2026-10-07T11:40:00\.000Z\)/);
    result = await check([{ runAfter: T0 - 40 * 60_000 }]);
    assert.deepEqual(result.failing, ['queue'], 'nothing ever finished');
    assert.match(fx.mails[0].text, /\(last one: never\)/);
    result = await check([{ runAfter: T0 - 40 * 60_000 }, { status: 'error', updated: T0 - 5 * 60_000 }]);
    assert.deepEqual(result.failing, [], 'a long queue that is moving');
    result = await check([{ runAfter: T0 - 10 * 60_000 }, { status: 'done', updated: T0 - 3 * HOUR }]);
    assert.deepEqual(result.failing, [], 'a new job after a quiet afternoon');
    result = await check([{ status: 'running', runAfter: T0 - 3 * HOUR }, { status: 'cancelled', runAfter: T0 - 3 * HOUR }]);
    assert.deepEqual(result.failing, []);

    // Before migration 0013 there is no queue to watch.
    world({ without: ['0013_capture_jobs.sql'] });
    const fresh = await load('src/lib/ops-watchdog.ts');
    result = await fresh.runWatchdog(ORIGIN, T0);
    assert.ok(!result.checks.some((c) => c.key === 'queue'));
    assert.deepEqual(result.failing, []);
  });

  await section('the schema: a required migration missing is a problem, an optional one is not', async () => {
    let db = world();
    db.exec('PRAGMA foreign_keys=OFF; DROP TABLE watch_settings;');
    let result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, ['schema']);
    assert.match(fx.mails[0].text, /Required migrations are not applied: 0008_monitor_noise\.sql\. Paste db\/0008-upgrade\.sql into the D1 console\./);

    db = world();
    db.exec('PRAGMA foreign_keys=OFF; DROP TABLE web_push_deliveries; DROP TABLE web_push_subscriptions;');
    result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, [], 'optional migrations only switch features on');
  });

  await section('a broken binding is reported, and the checks that need the database wait for it', async () => {
    world();
    fx.env.DB = { prepare: () => { throw new Error('D1_ERROR: database unavailable'); } };
    fx.env.SHOTS = { head: async () => { throw new Error('R2 is down'); } };
    let result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, ['database', 'storage']);
    assert.deepEqual(result.checks.map((c) => c.key).sort(), ['database', 'kv', 'storage']);
    assert.equal(result.sent, 'problem');
    assert.match(fx.mails[0].text, /✗ Database\n  D1_ERROR: database unavailable/);
    assert.match(fx.mails[0].text, /✗ File storage \(R2\)\n  R2 is down/);

    // KV down: nothing to remember with, so it reports every hour rather than never.
    world();
    fx.env.RATE = { get: async () => { throw new Error('KV down'); }, put: async () => { throw new Error('KV down'); } };
    result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, ['kv']);
    assert.equal(result.sent, 'problem');
    fx.mails.length = 0;
    result = await ops.runWatchdog(ORIGIN, T0 + HOUR);
    assert.equal(result.sent, 'problem');
    assert.ok(errors.some((e) => e.startsWith('[watchdog] could not save its state')));
    errors.length = 0;

    // No binding at all.
    world();
    delete fx.env.SHOTS;
    result = await ops.runWatchdog(ORIGIN, T0);
    assert.deepEqual(result.failing, ['storage']);
    assert.match(fx.mails[0].text, /No SHOTS binding on this deployment\./);
  });

  await section('nobody to tell: logged, and tried again next hour until someone is told', async () => {
    const db = world();
    addWatch(db, { next: T0 - 3 * HOUR });
    delete fx.env.OWNER_EMAILS;
    errors.length = 0;
    let result = await ops.runWatchdog(ORIGIN, T0);
    assert.equal(result.sent, null);
    assert.equal(result.recipients, 0);
    assert.ok(errors.includes('[watchdog] Easy Screen Capture: 1 problem needs a look (not emailed: OWNER_EMAILS is not set)'), errors.join('\n'));
    assert.deepEqual(state(), { checkedAt: at(T0), failing: ['monitors'], since: at(T0), notifiedAt: null });

    // The mailer refuses.
    fx.env.OWNER_EMAILS = 'owner@example.test';
    fx.mailReady = false;
    errors.length = 0;
    result = await ops.runWatchdog(ORIGIN, T0 + HOUR);
    assert.equal(result.sent, null);
    assert.ok(errors.some((e) => e.includes('(not emailed: no mail could be sent)')));

    // Mail works again: the owner hears about it, from when it began.
    fx.mailReady = true;
    result = await ops.runWatchdog(ORIGIN, T0 + 2 * HOUR);
    assert.equal(result.sent, 'reminder');
    assert.deepEqual(recipients(), ['owner@example.test']);
    assert.match(fx.mails[0].text, /Still failing since 2026-10-07T12:00:00\.000Z/);
    assert.equal(state().notifiedAt, at(T0 + 2 * HOUR));
    errors.length = 0;
  });

  await section('/api/health: the hourly sweep’s heartbeat, reported on its own and kept out of the top-level ok', async () => {
    world();
    const { GET } = await load('src/pages/api/health.ts');
    const health = async () => {
      const response = await GET({});
      return { status: response.status, body: await response.json() };
    };
    let { status, body } = await health();
    assert.equal(status, 200);
    assert.deepEqual(body.checks.scheduler, { ok: true, lastRunAt: null, detail: 'No hourly sweep recorded yet.' });

    const recent = Date.now() - 50 * 60_000;
    await ops.runWatchdog(ORIGIN, recent);
    ({ status, body } = await health());
    assert.deepEqual(body.checks.scheduler, { ok: true, lastRunAt: at(recent) });

    const stale = Date.now() - 3 * HOUR;
    await ops.runWatchdog(ORIGIN, stale);
    ({ status, body } = await health());
    assert.equal(status, 200, 'pages still load: the site is up');
    assert.equal(body.ok, true);
    assert.equal(body.checks.scheduler.ok, false);
    assert.equal(body.checks.scheduler.lastRunAt, at(stale));
    assert.match(body.checks.scheduler.detail, /has not run for over two hours/);

    fx.env.RATE = { get: async () => { throw new Error('KV down'); } };
    ({ body } = await health());
    assert.equal(body.checks.scheduler.ok, true, 'an unreadable heartbeat is the KV check’s to report');
  });

  await section('the hourly cron runs the self-check, and the uptime workflow reads what it leaves', () => {
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    assert.match(worker, /import \{ runWatchdog \} from '\.\/lib\/ops-watchdog';/);
    const hourly = worker.slice(worker.indexOf('function hourly('));
    assert.match(hourly, /runWatchdog\(siteOrigin\(\), now\.getTime\(\)\)/, 'inside the hourly sweep, not the minute one');

    const uptime = readFileSync(join(root, '.github/workflows/uptime.yml'), 'utf8');
    assert.match(uptime, /cron: '7,37 \* \* \* \*'/);
    assert.match(uptime, /SITE: https:\/\/easyscreencapture\.com/);
    assert.match(uptime, /\$SITE\/api\/health/);
    assert.match(uptime, /jq -e '\.ok == true'/);
    assert.match(uptime, /jq -e '\.checks\.scheduler\.ok != false'/);
    assert.match(uptime, /permissions: \{\}/);
  });

  await section('CI runs what a contributor runs, on pull requests and on every push to main', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const trigger of ['pull_request:', 'push:\n    branches: [main]']) assert.ok(ci.includes(trigger), trigger);
    const steps = ['npm ci', 'npx playwright-core install --with-deps --no-shell chromium', 'npx astro check', 'npm test', 'npm run build'];
    let from = 0;
    for (const step of steps) {
      const index = ci.indexOf(step, from);
      assert.ok(index > from, `${step}, in order`);
      from = index;
    }
    assert.match(ci, /CHROME_PATH=/, 'the rendering checks get the installed Chromium');
    assert.match(ci, /node-version: 22/);
    assert.match(ci, /permissions:\n  contents: read/);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.test, /npm run -s ops:check/);
    for (const script of readdirSync(join(root, 'scripts')).filter((name) => /check\.mjs$/.test(name))) {
      const source = readFileSync(join(root, 'scripts', script), 'utf8');
      if (/^\s*import .* from 'playwright-core';|await import\('playwright-core'\)/m.test(source)) {
        assert.match(source, /process\.env\.CHROME_PATH/, `${script} takes CI's Chromium`);
      }
    }
  });

  assert.deepEqual(errors, [], 'nothing logged an unexpected error');
  console.log = originalLog;
  console.error = originalError;
  console.log(
    `\nSelf-monitoring checks passed (${passed.length}): late monitors, renderer failures on our side, a stuck capture ` +
      'queue, the schema and the bindings; one email per owner on a change, a daily reminder, the all clear, retries ' +
      'when nobody could be told; the sweep heartbeat on /api/health; the CI and uptime workflows.',
  );
} catch (error) {
  console.log = originalLog;
  console.error = originalError;
  if (errors.length) console.error(errors.join('\n'));
  throw error;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
