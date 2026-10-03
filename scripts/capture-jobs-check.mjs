/**
 * Background captures, run without a Cloudflare browser or a cron.
 *
 * What goes wrong in a queue is not the pixels: a job two ticks both took, a
 * lease that never lapses, a batch that spends more than it reserved, a
 * cancelled page still charged, a queued capture the iOS app shows as a
 * failure, a minute cron that swallowed the hourly sweep. Each is checked here
 * by running the shipped modules and routes — bundled with only the Worker
 * bindings and the browser stubbed — against a real SQLite database with every
 * migration applied, and against one without 0013, where nothing may change.
 *
 *   node scripts/capture-jobs-check.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const cc = (globalThis.__cc = { env: {}, calls: [] });
/** The bundles hold on to this one object, so it is refilled rather than replaced. */
const setEnv = (values) => {
  for (const key of Object.keys(cc.env)) delete cc.env[key];
  Object.assign(cc.env, values);
};
const directory = mkdtempSync(join(tmpdir(), 'capture-jobs-check-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
let bundles = 0;

const BASE_STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__cc.env;',
  '@cloudflare/puppeteer': 'export default {};',
  // The bundle's own HttpError goes to the stub, so a failure it throws is the kind runCapture recognises.
  './renderer': `import { HttpError } from './http';
                 export const render = (options, onFile) => globalThis.__cc.render(options, onFile, HttpError);`,
};

/**
 * Bundles one module (a path from the repository root) with the Worker-only
 * imports replaced, plus any import named in `stubs` by its exact specifier.
 * Each call is a fresh copy, with its own per-isolate caches.
 */
async function load(entry, stubs = {}) {
  const contents = { ...BASE_STUBS, ...stubs };
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const filter = new RegExp(`^(${Object.keys(contents).map(escape).join('|')})$`);
  const plugin = {
    name: 'capture-jobs-stubs',
    setup(builder) {
      builder.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: contents[args.path],
        loader: 'js',
        resolveDir: join(root, 'src/lib'),
      }));
    },
  };
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [plugin],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};
const rejects = async (promise, status, type) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.status, status, `${error.type}: ${error.message}`);
    if (type) assert.equal(error.type, type);
    return error;
  }
  assert.fail(`expected a ${status} rejection`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Databases and bindings                                                      */
/* -------------------------------------------------------------------------- */

/** A database with the migrations applied, all of them or all but `skip`. */
function database(skip = []) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (skip.includes(file)) continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** D1 over node:sqlite: each statement atomic, a batch one transaction, binds bounded as D1 bounds them. */
function d1(db) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => {
      assert.ok(values.length <= 100, 'D1 takes at most 100 bound parameters');
      return statement(sql, values);
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((q) => ({ meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const objects = new Map();
const kv = new Map();
const mails = [];
function bindings(db) {
  return {
    DB: d1(db),
    SHOTS: {
      put: async (key) => objects.set(key, true),
      delete: async (keys) => [].concat(keys).forEach((key) => objects.delete(key)),
      list: async () => ({ objects: [], truncated: false }),
    },
    RATE: { get: async (key) => kv.get(key) ?? null, put: async (key, value) => kv.set(key, value) },
    EMAIL: { send: async (message) => mails.push(message) },
    EMAIL_FROM: 'Easy Screen Capture <noreply@example.test>',
    PUBLIC_SITE_URL: 'https://app.test',
  };
}

const ORIGIN = 'https://app.test';
const now = new Date().toISOString();
const period = now.slice(0, 7);
function addUser(db, id, plan = 'free', freeQuota = 20) {
  db.prepare(
    `INSERT INTO users (id, email, email_lower, plan, period_start, created_at, updated_at, free_quota)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.test`, `${id}@example.test`, plan, now, now, now, freeQuota);
  return { id, email: `${id}@example.test`, name: '', plan, freeQuota, periodStart: now, createdAt: now };
}
const used = (db, user) =>
  db.prepare('SELECT used FROM usage_counters WHERE user_id = ? AND period = ?').get(user.id, period)?.used ?? 0;
const setUsed = (db, user, count) =>
  db.prepare('INSERT OR REPLACE INTO usage_counters (user_id, period, used) VALUES (?, ?, ?)').run(user.id, period, count);
const job = (db, id) => db.prepare('SELECT * FROM capture_jobs WHERE id = ?').get(id);
const jobFor = (db, captureId) => db.prepare('SELECT * FROM capture_jobs WHERE capture_id = ?').get(captureId);
const capture = (db, id) => db.prepare('SELECT * FROM captures WHERE id = ?').get(id);

/** A render that succeeds with one file per planned size, recording what it was asked for. */
const rendered = [];
let inFlight = 0;
let maxInFlight = 0;
const file = (name) => ({ data: new Uint8Array([1, 2, 3]), contentType: 'image/png', ext: 'png', index: 1, name, width: 1440, height: 900 });
function renderOk(delay = 0) {
  return async (options) => {
    rendered.push(options.url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delay) await sleep(delay);
      return { files: [file()], engine: 'binding', durationMs: 5 };
    } finally {
      inFlight--;
    }
  };
}
const resetRenders = () => {
  rendered.length = 0;
  inFlight = 0;
  maxInFlight = 0;
};

const FAST = { budgetMs: 2_000, pollMs: 2 };
const atMinute = (minute) => new Date(Date.UTC(2026, 9, 3, 14, minute));

/** An Astro route context the way the iOS app reaches it: no Origin header, JSON strings, its own cookie. */
function context(method, path, { user = null, body, headers = {}, params = {} } = {}) {
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const waited = [];
  return {
    request,
    url: new URL(request.url),
    params,
    locals: { user, cfContext: { waitUntil: (promise) => waited.push(promise) } },
    waited,
  };
}
async function call(route, method, path, options) {
  const ctx = context(method, path, options);
  const response = await route[method](ctx);
  await Promise.all(ctx.waited);
  return { status: response.status, headers: response.headers, json: await response.json() };
}

/* -------------------------------------------------------------------------- */
/* Without migration 0013                                                      */
/* -------------------------------------------------------------------------- */

{
  const db = database(['0013_capture_jobs.sql']);
  setEnv(bindings(db));
  const jobs = await load('src/lib/capture-jobs.ts');
  const captures = await load('src/pages/api/captures/index.ts');
  const batches = await load('src/pages/api/batches/index.ts');
  const user = addUser(db, 'legacy');

  await section('without 0013 the queue is dormant and touches nothing', async () => {
    assert.equal(await jobs.captureJobsReady(), false);
    resetRenders();
    cc.render = renderOk();
    const tick = await jobs.runCaptureJobs(ORIGIN, atMinute(30), FAST);
    assert.deepEqual(
      Object.values(tick).every((value) => value === 0),
      true,
      'a tick on a database without the tables does nothing at all',
    );
    assert.deepEqual(await jobs.pruneCaptureJobs(), { jobs: 0, batches: 0 });
    assert.equal(rendered.length, 0);
    await rejects(jobs.requireCaptureJobs(), 503, 'setup_required');
  });

  await section('without 0013 async captures run inline, and batches answer setup_required', async () => {
    cc.render = renderOk();
    const response = await call(captures, 'POST', '/api/captures', {
      user,
      body: { url: 'https://example.com', device: 'desktop', mode: 'visible', format: 'png', async: '1' },
    });
    assert.equal(response.status, 201, 'the preference is declined: the capture ran here');
    assert.equal(response.json.status, 'done');
    assert.equal(response.headers.get('preference-applied'), null);

    for (const method of ['GET', 'POST']) {
      const answer = await call(batches, method, '/api/batches', {
        user,
        ...(method === 'POST' ? { body: { urls: 'https://example.com' } } : {}),
      });
      assert.equal(answer.status, 503);
      assert.equal(answer.json.error.type, 'setup_required');
    }
  });
}

/* -------------------------------------------------------------------------- */
/* With migration 0013                                                         */
/* -------------------------------------------------------------------------- */

const db = database();
setEnv(bindings(db));
const jobs = await load('src/lib/capture-jobs.ts');
const batchLib = await load('src/lib/capture-batches.ts');
const captureList = await load('src/lib/captures.ts');
const plans = await load('src/lib/plans.ts');
const { parseCaptureOptions: parse } = await load('src/lib/capture-options.ts');
/** One async capture, as POST /api/captures queues it. */
const enqueue = (user, url, source = 'app') => jobs.enqueueCapture(user, parse({ url }), { url }, source);
const request = (body, user) => batchLib.readBatchRequest(body, user);
const urls = (count, host = 'example.com') => Array.from({ length: count }, (_, i) => `https://${host}/page-${i}`).join('\n');
const create = async (user, body, source = 'app') =>
  batchLib.createBatch(user, await request({ url_lines: '1', ...body }, user), source);
const run = (minute = 30, timing = FAST) => jobs.runCaptureJobs(ORIGIN, atMinute(minute), timing);
const drain = async (minute = 30) => {
  for (let i = 0; i < 20; i++) {
    const tick = await run(minute);
    if (!tick.due && !tick.recovered) return;
  }
};

await section('plan limits: a batch is never larger than the hourly capture limit, nor 500', () => {
  assert.deepEqual(
    plans.PLAN_ORDER.map((id) => plans.batchLimit(id)),
    [10, 30, 60, 120, 500],
  );
  for (const id of plans.PLAN_ORDER) assert.ok(plans.batchLimit(id) <= plans.APP_RATE_LIMIT[id]);
});

await section('a batch past the plan limit is refused before anything is spent', async () => {
  const user = addUser(db, 'limited', 'free', 100);
  await rejects(create(user, { urls: urls(11) }), 400, 'batch_too_large');
  // Each device is a capture: six pages on two devices is twelve.
  await rejects(create(user, { urls: urls(6), devices: 'desktop,mobile' }), 400, 'batch_too_large');
  assert.equal(used(db, user), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_jobs WHERE user_id = ?').get(user.id).n, 0);
  const batch = await create(user, { urls: urls(5), devices: 'desktop,mobile' });
  assert.equal(batch.total, 10, 'up to the limit is fine');
});

await section('the whole cost is reserved at once, counting sizes per file and a series per frame', async () => {
  const user = addUser(db, 'reserver', 'business');
  const sized = await create(user, { urls: urls(3), sizes: 'desktop,mobile' });
  assert.equal(sized.shots, 6);
  assert.equal(used(db, user), 6);
  const series = await create(user, { urls: urls(2, 'series.test'), mode: 'series', max_frames: '5' });
  assert.equal(series.shots, 10);
  assert.equal(used(db, user), 16);
  const rows = db.prepare('SELECT reserved FROM capture_jobs WHERE batch_id = ?').all(series.id);
  assert.deepEqual(rows.map((row) => row.reserved), [5, 5]);
  const queued = db.prepare(`SELECT status, COUNT(*) AS n FROM captures WHERE user_id = ? GROUP BY status`).all(user.id);
  assert.deepEqual(queued.map((row) => [row.status, row.n]), [['queued', 5]], 'every capture row exists from the start, queued');
});

await section('a batch the quota cannot cover is refused whole, and the hourly limit is charged in full', async () => {
  const user = addUser(db, 'tight', 'free', 20);
  setUsed(db, user, 15);
  const error = await rejects(create(user, { urls: urls(6) }), 402, 'quota_exceeded');
  assert.match(error.message, /needs 6 screenshots and you have 5 left/);
  assert.equal(used(db, user), 15, 'nothing reserved');

  const pro = addUser(db, 'bursty', 'pro');
  const first = await create(pro, { urls: urls(100) });
  assert.equal(first.total, 100);
  const refused = await rejects(create(pro, { urls: urls(30, 'other.test') }), 429, 'rate_limited');
  assert.match(refused.message, /needs 30 of the 120 captures an hour .* 20 are left/);
  assert.equal(used(db, pro), 100, 'a batch refused for the hour spends no quota');
});

await section('bad URLs are reported and the rest go ahead; credentials and html are refused', async () => {
  const user = addUser(db, 'mixed', 'business');
  const batch = await create(user, {
    urls: 'https://example.com/a\nhttp://127.0.0.1/admin\nexample.com/a\nhttps://example.com/b',
  });
  assert.equal(batch.total, 2, 'a private address is rejected; a duplicate spelled differently is one page');
  assert.deepEqual(batch.rejected.map((entry) => entry.url), ['http://127.0.0.1/admin']);
  await rejects(create(user, { urls: urls(2), headers: '{"authorization":"Bearer x"}' }), 400, 'invalid_request');
  await rejects(create(user, { urls: urls(2), cookies: '{"session":"1"}' }), 400, 'invalid_request');
  await rejects(create(user, { urls: urls(2), html: '<p>hi</p>' }), 400, 'invalid_request');
  await rejects(create(user, { urls: 'http://localhost/\nhttp://10.0.0.1/' }), 400, 'invalid_request');
  await rejects(create(user, { urls: urls(2), devices: 'desktop,__proto__' }), 400, 'invalid_request');
});

await section('jobs run to done, settle their quota and finish their batch with one email', async () => {
  const user = addUser(db, 'runner', 'business');
  mails.length = 0;
  resetRenders();
  cc.render = renderOk();
  const series = await create(user, { urls: urls(1, 'short.test'), mode: 'series', max_frames: '6' });
  const batch = await create(user, { urls: urls(3), notify: '1', label: 'Launch' });
  assert.equal(used(db, user), 9);
  await drain();
  const detail = await batchLib.batchDetail(user.id, batch.id, ORIGIN);
  assert.equal(detail.status, 'done');
  assert.deepEqual([detail.done, detail.failed, detail.queued, detail.running], [3, 0, 0, 0]);
  assert.equal(detail.captures.length, 3);
  for (const dto of detail.captures) {
    for (const key of ['id', 'status', 'url', 'display_url', 'device', 'mode', 'format', 'source', 'images', 'created_at']) {
      assert.ok(key in dto, `${key} is in the capture`);
    }
    assert.match(dto.images[0], /^https:\/\/app\.test\/f\/cap_[a-z0-9]+\/capture\.png\?t=/);
  }
  assert.ok(detail.completed_at);
  assert.equal(used(db, user), 4, 'the series kept one of its six frames; the pages one each');
  assert.equal(mails.length, 1, 'one email, sent once');
  assert.match(mails[0].subject, /^Launch: 3 of 3 captured$/);
  assert.match(mails[0].text, /Results: https:\/\/app\.test\/app\/batch\?batch=bat_/);
  await drain();
  assert.equal(mails.length, 1, 'a later tick does not send it again');
  assert.equal(db.prepare('SELECT completed_at FROM capture_batches WHERE id = ?').get(series.id).completed_at !== null, true);
});

await section('slots bound concurrency across overlapping ticks, one during the monitor sweep', async () => {
  const user = addUser(db, 'busy', 'business');
  await create(user, { urls: urls(10, 'slots.test') });
  resetRenders();
  cc.render = renderOk(15);
  await Promise.all([run(30), run(30), run(30)]);
  assert.equal(rendered.length, 10, 'every job ran once and only once');
  assert.equal(new Set(rendered).size, 10);
  assert.ok(maxInFlight <= jobs.JOB_SLOTS, `at most ${jobs.JOB_SLOTS} at once, saw ${maxInFlight}`);
  assert.equal(maxInFlight, 2, 'and the two slots are used');

  await create(user, { urls: urls(4, 'sweep.test') });
  resetRenders();
  await Promise.all([run(5), run(5)]);
  assert.equal(rendered.length, 4);
  assert.equal(maxInFlight, jobs.SWEEP_SLOTS, 'one at a time while the hourly sweep runs');
});

await section('a tick stops claiming when its budget is spent and reports the backlog', async () => {
  const user = addUser(db, 'backlog', 'business');
  await create(user, { urls: urls(8, 'budget.test') });
  resetRenders();
  cc.render = renderOk(30);
  const tick = await run(30, { budgetMs: 40, pollMs: 2 });
  assert.ok(tick.claimed >= 2 && tick.claimed < 8, `claimed ${tick.claimed}`);
  assert.equal(tick.backlog, 8 - tick.claimed);
  assert.ok(tick.maxLateMs >= 0);
  cc.render = renderOk();
  await drain();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM capture_jobs WHERE user_id = ? AND status = 'done'`).get(user.id).n, 8);
});

await section('the account with the fewest jobs running goes next', async () => {
  const big = addUser(db, 'big', 'business');
  const small = addUser(db, 'small', 'business');
  await create(big, { urls: urls(6, 'big.test') });
  await create(small, { urls: urls(2, 'small.test') });
  resetRenders();
  cc.render = renderOk(10);
  await drain();
  assert.deepEqual(
    rendered.slice(0, 2).map((url) => new URL(url).hostname).sort(),
    ['big.test', 'small.test'],
    'the second slot goes to the other account, not the big batch',
  );
});

await section('a lapsed lease is taken again; out of attempts it fails and is refunded', async () => {
  const user = addUser(db, 'crashy', 'business');
  cc.render = renderOk();

  // A tick died mid-render: its job is running under a lease that has lapsed.
  const first = await enqueue(user, 'https://lease.test/a');
  const lapsed = '2000-01-01T00:00:00.000Z';
  db.prepare(`UPDATE capture_jobs SET status = 'running', attempts = 1, lease_until = ? WHERE capture_id = ?`).run(lapsed, first.id);
  db.prepare(`UPDATE captures SET status = 'running' WHERE id = ?`).run(first.id);
  resetRenders();
  const tick = await run();
  assert.equal(tick.recovered, 1);
  assert.equal(jobFor(db, first.id).status, 'done');
  assert.equal(jobFor(db, first.id).attempts, 2);
  assert.equal(capture(db, first.id).status, 'done');
  assert.equal(used(db, user), 1);

  // The second time it dies there is nothing left to try.
  const second = await enqueue(user, 'https://lease.test/b');
  db.prepare(`UPDATE capture_jobs SET status = 'running', attempts = 2, lease_until = ? WHERE capture_id = ?`).run(lapsed, second.id);
  db.prepare(`UPDATE captures SET status = 'running' WHERE id = ?`).run(second.id);
  assert.equal(used(db, user), 2);
  resetRenders();
  const expired = await run();
  assert.equal(expired.expired, 1);
  assert.equal(rendered.length, 0);
  assert.equal(jobFor(db, second.id).status, 'error');
  assert.equal(capture(db, second.id).status, 'error');
  assert.equal(capture(db, second.id).error, 'The capture did not finish. Try again.');
  assert.equal(used(db, user), 1, 'its screenshot went back');

  // A tick that died after the capture settled: the capture's outcome stands, nothing renders twice.
  const third = await enqueue(user, 'https://lease.test/c');
  db.prepare(`UPDATE capture_jobs SET status = 'running', attempts = 1, lease_until = ? WHERE capture_id = ?`).run(lapsed, third.id);
  db.prepare(`UPDATE captures SET status = 'done' WHERE id = ?`).run(third.id);
  resetRenders();
  await run();
  assert.equal(rendered.length, 0);
  assert.equal(jobFor(db, third.id).status, 'done');
  assert.equal(used(db, user), 2, 'and its reservation is neither refunded nor charged again');
});

await section('a full browser pool is tried once more, a minute later, then fails and is refunded', async () => {
  const user = addUser(db, 'pooled', 'business');
  const row = await enqueue(user, 'https://pool.test/', 'api');
  cc.render = async (_options, _onFile, HttpError) => {
    throw new HttpError(503, 'browser_unavailable', 'All 2 browser sessions are in use (2 active).');
  };
  const tick = await run();
  assert.equal(tick.retried, 1);
  const waiting = jobFor(db, row.id);
  assert.equal(waiting.status, 'queued');
  assert.ok(Date.parse(waiting.run_after) > Date.now() + 30_000, 'not before a minute has passed');
  assert.equal(capture(db, row.id).status, 'queued');
  assert.equal(used(db, user), 1, 'the reservation was taken again');
  assert.equal((await run()).due, 0, 'not due yet');

  db.prepare(`UPDATE capture_jobs SET run_after = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', waiting.id);
  const again = await run();
  assert.equal(again.failed, 1);
  assert.equal(jobFor(db, row.id).status, 'error');
  assert.equal(capture(db, row.id).status, 'error');
  assert.equal(used(db, user), 0, 'refunded for good');
  assert.equal(db.prepare('SELECT via_api FROM usage_counters WHERE user_id = ?').get(user.id).via_api, 0);
});

await section('a queued capture deleted before it runs is cancelled and refunded', async () => {
  const user = addUser(db, 'deleter', 'business');
  const row = await enqueue(user, 'https://gone.test/');
  assert.equal(used(db, user), 1);
  await captureList.deleteCapture(await captureList.getCapture(row.id));
  resetRenders();
  cc.render = renderOk();
  const tick = await run();
  assert.equal(tick.cancelled, 1);
  assert.equal(rendered.length, 0);
  assert.equal(jobFor(db, row.id).status, 'cancelled');
  assert.equal(used(db, user), 0);
});

await section('cancel stops what has not started, refunds it and deletes its rows; running work finishes', async () => {
  const user = addUser(db, 'canceller', 'business');
  mails.length = 0;
  const batch = await create(user, { urls: urls(5, 'cancel.test'), notify: '1' });
  assert.equal(used(db, user), 5);
  // One is rendering right now.
  const busy = db.prepare(`SELECT * FROM capture_jobs WHERE batch_id = ? ORDER BY position LIMIT 1`).get(batch.id);
  db.prepare(`UPDATE capture_jobs SET status = 'running', attempts = 1, lease_until = ? WHERE id = ?`).run(
    new Date(Date.now() + 60_000).toISOString(),
    busy.id,
  );
  db.prepare(`UPDATE captures SET status = 'running' WHERE id = ?`).run(busy.capture_id);

  assert.equal(await jobs.cancelBatch(user.id, batch.id, ORIGIN), 4);
  assert.equal(await jobs.cancelBatch(user.id, batch.id, ORIGIN), 0, 'cancelling twice takes nothing twice');
  assert.equal(used(db, user), 1, 'four screenshots back');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM captures WHERE user_id = ?`).get(user.id).n,
    1,
    'the cancelled captures are gone; the running one stays',
  );
  let detail = await batchLib.batchDetail(user.id, batch.id, ORIGIN);
  assert.deepEqual([detail.status, detail.running, detail.cancelled, detail.queued], ['running', 1, 4, 0]);
  assert.equal(await jobs.cancelBatch('someone-else', batch.id, ORIGIN), 0, 'only the owner can cancel');

  // The running one finishes (its tick died, a later one takes it): the batch ends cancelled, with no email.
  db.prepare(`UPDATE capture_jobs SET lease_until = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', busy.id);
  cc.render = renderOk();
  await drain();
  detail = await batchLib.batchDetail(user.id, batch.id, ORIGIN);
  assert.deepEqual([detail.status, detail.done, detail.cancelled], ['cancelled', 1, 4]);
  assert.ok(detail.completed_at && detail.cancelled_at);
  assert.equal(mails.length, 0, 'someone who cancelled is not told it finished');
  assert.equal(used(db, user), 1);
});

await section('batch detail sends only what changed since the last answer', async () => {
  const user = addUser(db, 'poller', 'business');
  const batch = await create(user, { urls: urls(3, 'poll.test') });
  // Queued a while ago, so nothing about it is recent.
  db.prepare(`UPDATE capture_jobs SET updated_at = ? WHERE batch_id = ?`).run('2026-01-01T00:00:00.000Z', batch.id);
  const first = await batchLib.batchDetail(user.id, batch.id, ORIGIN);
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.items.map((item) => item.url), ['https://poll.test/page-0', 'https://poll.test/page-1', 'https://poll.test/page-2']);
  const quiet = await batchLib.batchDetail(user.id, batch.id, ORIGIN, first.as_of);
  assert.equal(quiet.items.length, 0, 'nothing moved');
  assert.equal(quiet.queued, 3, 'the counts are always whole');

  // A tick stamps a job a moment before its write lands. Stamped just before an
  // answer was read, it must still come back on the next poll.
  const asOf = Date.parse(quiet.as_of);
  assert.ok(Date.now() - asOf >= 10_000, 'as_of trails the read');
  const straggler = db.prepare(`SELECT id FROM capture_jobs WHERE batch_id = ? ORDER BY position LIMIT 1`).get(batch.id);
  db.prepare(`UPDATE capture_jobs SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 1_000).toISOString(), straggler.id);
  assert.deepEqual(
    (await batchLib.batchDetail(user.id, batch.id, ORIGIN, quiet.as_of)).items.map((item) => item.id),
    [straggler.id],
  );

  cc.render = renderOk();
  await drain();
  const moved = await batchLib.batchDetail(user.id, batch.id, ORIGIN, quiet.as_of);
  assert.equal(moved.items.length, 3);
  assert.equal(moved.captures.length, 3);
  await rejects(batchLib.batchDetail('someone-else', batch.id, ORIGIN), 404, 'not_found');
  const listed = await batchLib.listBatches(user.id);
  assert.equal(listed[0].id, batch.id);
  assert.deepEqual([listed[0].status, listed[0].done, listed[0].total], ['done', 3, 3]);
});

await section('a job is parsed again when it runs: a host denied since is refused and refunded', async () => {
  const user = addUser(db, 'denied', 'business');
  await create(user, { urls: 'https://soon-denied.test/' });
  assert.equal(used(db, user), 1);
  setEnv({ ...bindings(db), CAPTURE_HOST_DENYLIST: 'soon-denied.test' });
  resetRenders();
  await drain();
  setEnv(bindings(db));
  assert.equal(rendered.length, 0);
  const row = db.prepare(`SELECT * FROM captures WHERE user_id = ?`).get(user.id);
  assert.equal(row.status, 'error');
  assert.match(row.error, /not allowed/);
  assert.equal(used(db, user), 0);
});

await section('nothing a job stores carries credentials', () => {
  const stored = jobs.storedParams({
    url: 'https://example.com',
    headers: '{"authorization":"x"}',
    cookies: '{"s":"1"}',
    basic_auth: 'u:p',
    async: '1',
    device: 'mobile',
  });
  assert.deepEqual(stored, { url: 'https://example.com', device: 'mobile' });
  const options = db.prepare('SELECT options FROM capture_jobs').all().map((row) => row.options).join(' ');
  assert.doesNotMatch(options, /authorization|cookies|basic_auth/);
});

await section('finished jobs and batches are pruned after 30 days; waiting ones never', async () => {
  const user = addUser(db, 'pruned', 'business');
  const old = '2026-01-01T00:00:00.000Z';
  const finished = await create(user, { urls: urls(2, 'old.test') });
  db.prepare(`UPDATE capture_jobs SET status = 'done', updated_at = ? WHERE batch_id = ?`).run(old, finished.id);
  db.prepare(`UPDATE capture_batches SET completed_at = ? WHERE id = ?`).run(old, finished.id);
  const single = await enqueue(user, 'https://old.test/x');
  db.prepare(`UPDATE capture_jobs SET status = 'done', updated_at = ? WHERE capture_id = ?`).run(old, single.id);
  const waiting = await enqueue(user, 'https://old.test/y');
  db.prepare(`UPDATE capture_jobs SET updated_at = ? WHERE capture_id = ?`).run(old, waiting.id);

  const pruned = await jobs.pruneCaptureJobs(Date.parse('2026-10-03T00:00:00Z'));
  assert.deepEqual(pruned, { jobs: 3, batches: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_batches WHERE id = ?').get(finished.id).n, 0);
  assert.ok(jobFor(db, waiting.id), 'a waiting job is kept however old');
  assert.ok(capture(db, single.id), 'captures follow their own retention');
});

await section('deleting an account removes its jobs and batches too', async () => {
  const accounts = await load('src/lib/account-deletion.ts');
  const user = addUser(db, 'leaver', 'business');
  await create(user, { urls: urls(2, 'leaver.test') });
  await accounts.deleteAccount(user.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_jobs WHERE user_id = ?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_batches WHERE user_id = ?').get(user.id).n, 0);
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

const capturesRoute = await load('src/pages/api/captures/index.ts');
const captureRoute = await load('src/pages/api/captures/[id].ts');
const batchesRoute = await load('src/pages/api/batches/index.ts');
const batchRoute = await load('src/pages/api/batches/[id].ts');
const v1Capture = await load('src/pages/v1/capture.ts');
const v1Captures = await load('src/pages/v1/captures/index.ts');
const v1Batches = await load('src/pages/v1/batches/index.ts');

await section('POST /api/captures stays synchronous for the iOS app; async=1 answers 202 queued', async () => {
  const user = addUser(db, 'phone', 'free', 20);
  resetRenders();
  cc.render = renderOk();
  const sync = await call(capturesRoute, 'POST', '/api/captures', {
    user,
    body: { url: 'https://example.com', device: 'desktop', mode: 'visible', format: 'png' },
  });
  assert.equal(sync.status, 201);
  assert.equal(sync.json.status, 'done', 'a finished capture, as the app waits for');
  assert.equal(rendered.length, 1);

  const queued = await call(capturesRoute, 'POST', '/api/captures', {
    user,
    body: { url: 'https://example.com/later', async: '1' },
  });
  assert.equal(queued.status, 202);
  assert.equal(queued.json.status, 'queued');
  assert.equal(queued.headers.get('preference-applied'), 'respond-async');
  assert.equal(queued.headers.get('location'), `/api/captures/${queued.json.id}`);
  assert.deepEqual(queued.json.images, []);
  assert.equal(rendered.length, 1, 'nothing rendered yet');

  const preferred = await call(capturesRoute, 'POST', '/api/captures', {
    user,
    body: { url: 'https://example.com/prefer' },
    headers: { prefer: 'respond-async, wait=5' },
  });
  assert.equal(preferred.status, 202);

  const credentials = await call(capturesRoute, 'POST', '/api/captures', {
    user,
    body: { url: 'https://example.com', async: '1', basic_auth: 'u:p' },
  });
  assert.equal(credentials.status, 400);
  assert.equal(credentials.json.error.param, 'async');

  // The lists the app reads never show what is still waiting.
  for (const path of ['/api/captures?collection=regular&limit=30&offset=0', '/api/captures']) {
    const list = await call(capturesRoute, 'GET', path, { user });
    assert.equal(list.status, 200);
    assert.ok(list.json.data.every((row) => row.status !== 'queued' && row.status !== 'running'), path);
    assert.ok(!list.json.data.some((row) => row.id === queued.json.id), path);
  }
  const all = await call(capturesRoute, 'GET', '/api/captures?collection=regular&include_pending=1', { user });
  assert.ok(all.json.data.some((row) => row.id === queued.json.id), 'include_pending opts in');

  const polled = await call(captureRoute, 'GET', `/api/captures/${queued.json.id}`, { user, params: { id: queued.json.id } });
  assert.equal(polled.json.status, 'queued');
  await drain();
  const done = await call(captureRoute, 'GET', `/api/captures/${queued.json.id}`, { user, params: { id: queued.json.id } });
  assert.equal(done.json.status, 'done');
  assert.equal(done.json.images.length, 1);
  const after = await call(capturesRoute, 'GET', '/api/captures?collection=regular&limit=30&offset=0', { user });
  assert.ok(after.json.data.some((row) => row.id === queued.json.id), 'once done it is an ordinary capture');
});

await section('/api/batches creates, reads, lists and cancels', async () => {
  const user = addUser(db, 'webapp', 'business');
  const created = await call(batchesRoute, 'POST', '/api/batches', {
    user,
    body: { urls: urls(3, 'route.test'), url_lines: '1', device: 'mobile', mode: 'fullpage', label: 'Route' },
  });
  assert.equal(created.status, 202);
  for (const key of ['id', 'status', 'total', 'queued', 'running', 'done', 'failed', 'created_at']) {
    assert.ok(key in created.json, `${key} is in the batch`);
  }
  assert.deepEqual([created.json.status, created.json.total, created.json.queued], ['queued', 3, 3]);
  assert.equal(created.headers.get('location'), `/api/batches/${created.json.id}`);

  const id = created.json.id;
  const read = await call(batchRoute, 'GET', `/api/batches/${id}`, { user, params: { id } });
  assert.equal(read.status, 200);
  assert.equal(read.json.items.length, 3);
  assert.equal(read.json.items[0].device, 'mobile');
  const list = await call(batchesRoute, 'GET', '/api/batches', { user });
  assert.equal(list.json.data[0].id, id);

  const wrong = await call(batchRoute, 'POST', `/api/batches/${id}`, { user, params: { id }, body: { action: 'pause' } });
  assert.equal(wrong.status, 400);
  const cancelled = await call(batchRoute, 'POST', `/api/batches/${id}`, { user, params: { id }, body: { action: 'cancel' } });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.json.status, cancelled.json.cancelled], ['cancelled', 3]);
  const other = addUser(db, 'intruder', 'business');
  const hidden = await call(batchRoute, 'GET', `/api/batches/${id}`, { user: other, params: { id } });
  assert.equal(hidden.status, 404);
  const anonymous = await call(batchesRoute, 'GET', '/api/batches', {});
  assert.equal(anonymous.status, 401);
});

await section('/v1: async captures are queued, credentialed ones keep the old path, batches take a key', async () => {
  const user = addUser(db, 'keyholder', 'pro');
  const secret = 'sk_live_capturejobscheck';
  db.prepare(`INSERT INTO api_keys (id, user_id, hash, prefix, last4, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'key_check',
    user.id,
    createHash('sha256').update(secret).digest('hex'),
    'sk_live_capt',
    'heck',
    now,
  );
  const auth = { authorization: `Bearer ${secret}` };
  resetRenders();
  cc.render = renderOk();

  const queued = await call(v1Capture, 'POST', '/v1/capture', { headers: auth, body: { url: 'https://api.test/', async: '1' } });
  assert.equal(queued.status, 202);
  assert.equal(queued.json.status, 'queued');
  assert.equal(queued.json.source, 'api');
  assert.equal(rendered.length, 0);

  const legacy = await call(v1Capture, 'POST', '/v1/capture', {
    headers: auth,
    body: { url: 'https://api.test/private', async: '1', cookies: '{"session":"abc"}' },
  });
  assert.equal(legacy.status, 202);
  assert.equal(legacy.json.status, 'pending', 'credentials are never queued: rendered after the response, as before');
  assert.equal(rendered.length, 1);

  const listed = await call(v1Captures, 'GET', '/v1/captures', { headers: auth });
  assert.ok(!listed.json.data.some((row) => row.id === queued.json.id));
  const pending = await call(v1Captures, 'GET', '/v1/captures?include_pending=1', { headers: auth });
  assert.ok(pending.json.data.some((row) => row.id === queued.json.id));

  const batch = await call(v1Batches, 'POST', '/v1/batches', {
    headers: auth,
    body: { urls: ['https://api.test/a', 'https://api.test/b'], devices: 'desktop,mobile' },
  });
  assert.equal(batch.status, 202);
  assert.equal(batch.json.total, 4);
  assert.equal(db.prepare('SELECT source FROM capture_batches WHERE id = ?').get(batch.json.id).source, 'api');
  const noKey = await call(v1Batches, 'POST', '/v1/batches', { body: { urls: 'https://api.test/' } });
  assert.equal(noKey.status, 401);
});

/* -------------------------------------------------------------------------- */
/* The cron dispatch                                                           */
/* -------------------------------------------------------------------------- */

await section('the minute cron runs the queue only; the hourly cron runs the sweep exactly as before', async () => {
  const record = (name) => `export const ${name} = async (...args) => { globalThis.__cc.calls.push(${JSON.stringify(name)}); return globalThis.__cc.results?.[${JSON.stringify(name)}] ?? {}; };`;
  const worker = await load('src/worker.ts', {
    '@astrojs/cloudflare/entrypoints/server': 'export default { fetch: () => new Response("ok") };',
    './lib/apple-billing': record('refreshAppleSubscriptions'),
    './lib/push': record('drainPush'),
    './lib/retention': `${record('failStrandedCaptures')}\n${record('sweepExpiredCaptures')}`,
    './lib/watches': `${record('runDueWatches')}\n${record('retryAlerts')}`,
    './lib/digests': record('runProjectDigests'),
    './lib/capture-jobs': `${record('runCaptureJobs')}\n${record('pruneCaptureJobs')}`,
  });
  cc.results = {
    runCaptureJobs: { due: 0, recovered: 0, expired: 0 },
    failStrandedCaptures: 0,
    runDueWatches: { due: 0 },
    sweepExpiredCaptures: { scanned: 0, deleted: 0, filesDeleted: 0, bytesFreed: 0, tokensPurged: 0, failed: 0, truncated: false },
    pruneCaptureJobs: { jobs: 0, batches: 0 },
  };
  const fire = async (cron) => {
    cc.calls.length = 0;
    const waited = [];
    await worker.default.scheduled({ cron, scheduledTime: Date.parse('2026-10-03T14:00:00Z') }, cc.env, {
      waitUntil: (promise) => waited.push(promise),
    });
    await Promise.all(waited);
    return [...cc.calls].sort();
  };
  const hourly = [
    'drainPush',
    'failStrandedCaptures',
    'pruneCaptureJobs',
    'refreshAppleSubscriptions',
    'retryAlerts',
    'runDueWatches',
    'runProjectDigests',
    'sweepExpiredCaptures',
  ];
  assert.deepEqual(await fire('* * * * *'), ['runCaptureJobs']);
  assert.deepEqual(await fire('0 * * * *'), hourly, 'the monitor sweep and every hourly task, and not the queue');
  assert.deepEqual(await fire(undefined), hourly, 'a manual run with no cron is the hourly sweep');

  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  assert.match(config, /"crons":\s*\["0 \* \* \* \*", "\* \* \* \* \*"\]/, 'both triggers are configured');
  for (const binding of ['queues', 'durable_objects']) assert.ok(!config.includes(`"${binding}"`), `no ${binding} binding`);
});

await section('the console upgrade matches the migration and carries no comments', () => {
  const upgrade = readFileSync(join(root, 'db/0013-upgrade.sql'), 'utf8');
  assert.ok(!upgrade.includes('--'), 'the D1 console flattens SQL onto one line');
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(`CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)`);
  fresh.exec(upgrade.replace(/\n/g, ' '));
  fresh.exec(upgrade.replace(/\n/g, ' '));
  const schema = (database) =>
    database
      .prepare(`SELECT name, type FROM sqlite_master WHERE name LIKE '%capture_jobs%' OR name LIKE '%capture_batches%' ORDER BY name`)
      .all()
      .map((row) => `${row.type}:${row.name}`);
  assert.deepEqual(schema(fresh), schema(db));
  // Structure, not stored SQL text: columns with their types and defaults, keys and every index.
  const rows = (database, sql, ...args) => JSON.parse(JSON.stringify(database.prepare(sql).all(...args)));
  const shape = (database, table) => ({
    columns: rows(database, 'SELECT * FROM pragma_table_xinfo(?)', table),
    foreignKeys: rows(database, 'SELECT * FROM pragma_foreign_key_list(?)', table),
    indexes: rows(database, 'SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name', table).map(
      (index) => ({ ...index, columns: rows(database, 'SELECT * FROM pragma_index_xinfo(?)', index.name) }),
    ),
  });
  for (const table of ['capture_jobs', 'capture_batches']) assert.deepEqual(shape(fresh, table), shape(db, table), table);
  assert.equal(fresh.prepare(`SELECT name FROM d1_migrations`).get().name, '0013_capture_jobs.sql');
});

console.log(`\nall ${passed.length} checks passed`);
