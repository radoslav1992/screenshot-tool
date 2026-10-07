/**
 * Pro trials: who may start one, the plan an account acts on during and after
 * it, the quota, monitors, the API, checkout and Apple on the real plan, both
 * emails, paying during a trial, the iOS profile, retention, the growth
 * dashboard, account deletion — with migration 0019 and without it. Real
 * SQLite (every migration), an in-memory KV, a mocked mailer, a mocked Stripe
 * and a stubbed renderer. No network calls.
 *
 *   node scripts/trial-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'trial-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__trial = {
  env: {},
  mails: [],
  mailReady: true,
  render: async () => {
    throw new Error('no render set');
  },
});

const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__trial.env;',
  'astro:middleware': 'export const defineMiddleware = (fn) => fn;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts':
    'export const canSendEmail = () => globalThis.__trial.mailReady;' +
    'export async function sendMail(mail) { if (!globalThis.__trial.mailReady) return false; globalThis.__trial.mails.push(mail); return true; }',
  '/lib/renderer.ts': 'export const render = (...args) => globalThis.__trial.render(...args);',
  '/lib/visual-diff.ts':
    'export const diffAvailable = () => true;' +
    'export async function compareImages() { return { changedPct: 0, changedPixels: 0, sharedPct: 0, resized: false, width: 1440, height: 900, regions: [] }; }',
  '/lib/summarise.ts': 'export async function summariseChange() { return { sentence: "", detail: "", source: "plain" }; }',
};

const plugin = {
  name: 'trial-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|astro:middleware|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
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

/** A database with every migration, or every one but 0019. */
function database({ trials = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!trials && file === '0019_plan_trials.sql') continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** D1 over node:sqlite: each statement atomic, a batch one transaction that nothing interleaves with. */
function d1(db) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
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

const kv = new Map();
const RATE = {
  get: async (key) => kv.get(key) ?? null,
  put: async (key, value) => void kv.set(key, value),
  delete: async (key) => void kv.delete(key),
};
const objects = new Map();
const SHOTS = {
  put: async (key, data) => void objects.set(key, data),
  get: async () => null,
  head: async () => null,
  delete: async (keys) => {
    for (const key of [keys].flat()) objects.delete(key);
  },
  list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
};

/** Stripe over `fetch`: subscriptions by id, a customer, and a checkout that always opens. */
const stripe = { subscriptions: new Map(), calls: [] };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.stripe.com') throw new Error(`unexpected fetch to ${url}`);
  const method = init.method ?? 'GET';
  const path = url.pathname.replace(/^\/v1/, '');
  stripe.calls.push(`${method} ${path}`);
  const body = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && path === '/customers') return reply({ id: 'cus_trial' });
  if (method === 'GET' && path === '/checkout/sessions') return reply({ data: [] });
  if (method === 'POST' && path === '/checkout/sessions') {
    return reply({ id: 'cs_1', url: `https://checkout.stripe.test/${body.get('line_items[0][price]')}` });
  }
  const sub = /^\/subscriptions\/([^/]+)$/.exec(path)?.[1];
  if (sub && method === 'GET') return stripe.subscriptions.has(sub) ? reply(stripe.subscriptions.get(sub)) : reply({ error: { message: 'No such subscription' } }, 404);
  if (sub && method === 'POST') return reply({ id: sub });
  return reply({ error: { message: `unmocked ${method} ${path}` } }, 400);
};

/** A new world: its own database, the same env object every bundle holds on to. */
function world({ trials = true } = {}) {
  const db = database({ trials });
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, {
    DB: d1(db),
    RATE,
    SHOTS,
    BROWSER: {},
    PUBLIC_SITE_URL: 'https://easyscreencapture.test',
    // The capture gate is on: a trial waits for a confirmed email, as captures do.
    REQUIRE_EMAIL_VERIFICATION: '1',
    CAPTURE_HOST_DENYLIST: '',
    STRIPE_SECRET_KEY: 'sk_test_trial',
    STRIPE_PRICE_LITE_MONTHLY: 'price_lite_m',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
    STRIPE_PRICE_BUSINESS_MONTHLY: 'price_business_m',
  });
  kv.clear();
  objects.clear();
  stripe.subscriptions.clear();
  stripe.calls.length = 0;
  fx.mails.length = 0;
  fx.mailReady = true;
  fx.render = async () => ({ files: [png()], engine: 'binding', durationMs: 5 });
  return db;
}

const png = (index = 1) => ({ data: new Uint8Array([1, 2, 3]), contentType: 'image/png', ext: 'png', index, width: 1440, height: 900 });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ORIGIN = 'https://easyscreencapture.test';
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const period = () => new Date().toISOString().slice(0, 7);

function addUser(db, id, { plan = 'free', verified = true, freeQuota = 20, apple = null, subscription = null, status = '' } = {}) {
  const at = iso(Date.now());
  const email = `${id}@example.test`;
  db.prepare(
    `INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at, email_verified_at, free_quota,
                        apple_expires_at, stripe_subscription_id, plan_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, email, id, plan, at, at, at, verified ? at : null, freeQuota, apple, subscription, status);
  return id;
}
/** A trial row as the API would leave it, `daysIn` days after it started. */
const addTrial = (db, id, { daysIn = 5, ended = null, reminded = null, ip = null } = {}) =>
  db
    .prepare('INSERT INTO plan_trials (user_id, plan, started_at, ends_at, reminded_at, ended_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'pro', iso(Date.now() - daysIn * DAY), iso(Date.now() + (14 - daysIn) * DAY), reminded, ended, ip);
const trialOf = (db, id) => db.prepare('SELECT * FROM plan_trials WHERE user_id = ?').get(id);
const expire = (db, id) => db.prepare('UPDATE plan_trials SET ends_at = ? WHERE user_id = ?').run(iso(Date.now() - 60_000), id);
const setUsed = (db, userId, used) =>
  db.prepare('INSERT OR REPLACE INTO usage_counters (user_id, period, used) VALUES (?, ?, ?)').run(userId, period(), used);

const errors = [];
const originalError = console.error;
const originalLog = console.log;

try {
  /* ------------------------------------------------------------------------ */
  /* Bundles                                                                   */
  /* ------------------------------------------------------------------------ */

  world();
  const auth = await load('src/lib/auth.ts');
  const plan = await load('src/lib/trial-plan.ts');
  const trials = await load('src/lib/trials.ts');
  const captures = await load('src/lib/captures.ts');
  const options = await load('src/lib/capture-options.ts');
  const watches = await load('src/lib/watches.ts');
  const guard = await load('src/lib/api-guard.ts');
  const billing = await load('src/lib/billing.ts');
  const retention = await load('src/lib/retention.ts');
  const report = await load('src/lib/growth-report.ts');
  const deletion = await load('src/lib/account-deletion.ts');
  const route = (await load('src/pages/api/trial.ts')).POST;
  const profile = (await load('src/pages/api/mobile/profile.ts')).GET;
  const checkout = (await load('src/pages/api/billing/checkout.ts')).POST;
  const diagnose = (await load('src/pages/api/billing/diagnose.ts')).GET;
  const purchases = (await load('src/pages/api/mobile/purchases.ts')).GET;
  const parse = (input) => options.parseCaptureOptions(input);

  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => {
    if (String(args[0]).startsWith('ok ')) originalLog(...args);
  };

  /** POST /api/trial as the web app sends it: same origin, JSON, from an address. */
  const start = async (userId, { ip = '203.0.113.7', origin = ORIGIN, json = true } = {}) => {
    const headers = { origin, 'cf-connecting-ip': ip };
    if (json) headers.accept = 'application/json';
    if (!origin) delete headers.origin;
    if (!ip) delete headers['cf-connecting-ip'];
    const user = userId ? await auth.loadSessionUser(userId) : null;
    const response = await route({ request: new Request(`${ORIGIN}/api/trial`, { method: 'POST', headers }), locals: { user } });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const me = (id) => auth.loadSessionUser(id);

  /* ------------------------------------------------------------------------ */
  /* Starting a trial                                                          */
  /* ------------------------------------------------------------------------ */

  await section('POST /api/trial: 201 {plan, ends_at} 14 days out, once per account', async () => {
    const db = world();
    addUser(db, 'fresh');
    const before = Date.now();
    const r = await start('fresh');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), ['ends_at', 'plan']);
    assert.equal(r.json.plan, 'pro');
    const ends = Date.parse(r.json.ends_at);
    assert.ok(ends >= before + 14 * DAY && ends <= Date.now() + 14 * DAY, 'fourteen days from now');
    const row = trialOf(db, 'fresh');
    assert.equal(row.ends_at, r.json.ends_at);
    assert.equal(row.ip_hash, sha256('signup-ip:203.0.113.7').slice(0, 32), 'hashed like the signup address');
    assert.equal(row.reminded_at, null);
    assert.equal(row.ended_at, null);
    assert.equal(db.prepare('SELECT plan FROM users WHERE id = ?').get('fresh').plan, 'free', 'users.plan is never written');

    const again = await start('fresh');
    assert.deepEqual([again.status, again.json.error.type], [409, 'trial_used']);
    // Over, it is still used.
    expire(db, 'fresh');
    assert.deepEqual([(await start('fresh')).status, (await start('fresh')).json.error.type], [409, 'trial_used']);
  });

  await section('the email must be confirmed by the rule captures follow', async () => {
    const db = world();
    addUser(db, 'unconfirmed', { verified: false });
    const r = await start('unconfirmed');
    assert.deepEqual([r.status, r.json.error.type], [403, 'verification_required']);
    assert.equal(trialOf(db, 'unconfirmed'), undefined);
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(iso(Date.now()), 'unconfirmed');
    assert.equal((await start('unconfirmed')).status, 201);

    // Where the gate is off — no mailer, or not required — confirming is not asked for, as with captures.
    addUser(db, 'nomail', { verified: false });
    fx.mailReady = false;
    assert.equal((await start('nomail', { ip: '203.0.113.8' })).status, 201);
    fx.mailReady = true;
    fx.env.REQUIRE_EMAIL_VERIFICATION = '0';
    addUser(db, 'notrequired', { verified: false });
    assert.equal((await start('notrequired', { ip: '203.0.113.9' })).status, 201);
  });

  await section('only from Free or Lite, and never while Stripe bills the account (409 already_paid)', async () => {
    const db = world();
    const cases = [
      ['plus', { plan: 'plus', subscription: 'sub_plus', status: 'active' }, 409],
      ['pro', { plan: 'pro', subscription: 'sub_pro', status: 'active' }, 409],
      ['business', { plan: 'business', subscription: 'sub_biz', status: 'past_due' }, 409],
      ['stripelite', { plan: 'lite', subscription: 'sub_lite', status: 'active' }, 409],
      // A plan the webhook has not caught up with: the live subscription is what counts.
      ['lagging', { plan: 'free', subscription: 'sub_new', status: 'trialing' }, 409],
      ['applelite', { plan: 'free', apple: iso(Date.now() + 20 * DAY) }, 201],
      ['cancelled', { plan: 'free', subscription: 'sub_old', status: 'canceled' }, 201],
      ['complimentary', { plan: 'lite' }, 201],
    ];
    let ip = 10;
    for (const [id, setup, status] of cases) {
      addUser(db, id, setup);
      const r = await start(id, { ip: `198.51.100.${ip++}` });
      assert.equal(r.status, status, `${id}: ${JSON.stringify(r.json)}`);
      if (status === 409) assert.equal(r.json.error.type, 'already_paid', id);
    }
    // The offer the pages show follows the same rules.
    const ready = true;
    assert.equal(trials.trialOffered(await me('plus'), await billing.getBillingRow('plus'), ready), false);
    assert.equal(trials.trialOffered(await me('stripelite'), await billing.getBillingRow('stripelite'), ready), false);
    addUser(db, 'offered');
    addUser(db, 'appleoffered', { apple: iso(Date.now() + DAY) });
    assert.equal(trials.trialOffered(await me('offered'), await billing.getBillingRow('offered'), ready), true);
    assert.equal(await trials.trialOfferFor(await me('appleoffered')), true, 'Apple’s Lite may try Pro');
    assert.equal(await trials.trialOfferFor(await me('applelite')), false, 'not twice');
    assert.equal(trials.trialOffered(await me('offered'), null, false), false, 'never before the table exists');
    assert.equal(await trials.trialOfferFor(null), false);
  });

  await section('at most 3 trials per hashed address in 30 days, decided as the row is written', async () => {
    const db = world();
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) addUser(db, id);
    for (const id of ['n1', 'n2', 'n3']) assert.equal((await start(id, { ip: '192.0.2.50' })).status, 201, id);
    const fourth = await start('n4', { ip: '192.0.2.50' });
    assert.deepEqual([fourth.status, fourth.json.error.type], [429, 'trial_limit']);
    assert.equal(trialOf(db, 'n4'), undefined, 'nothing written');
    assert.equal((await start('n4', { ip: '192.0.2.51' })).status, 201, 'another address is another count');
    // Thirty days on, the address is free again.
    db.prepare("UPDATE plan_trials SET started_at = ? WHERE user_id = 'n1'").run(iso(Date.now() - 31 * DAY));
    assert.equal((await start('n5', { ip: '192.0.2.50' })).status, 201);
    assert.equal((await start('n6', { ip: '192.0.2.50' })).status, 429);
    // An unknown address (local runs) is no address at all: stored as nothing, never capped.
    for (const id of ['u1', 'u2', 'u3', 'u4']) {
      addUser(db, id);
      assert.equal((await start(id, { ip: null })).status, 201, id);
      assert.equal(trialOf(db, id).ip_hash, null);
    }
    // Racing requests from one address cannot pass the cap together.
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) addUser(db, id);
    const raced = await Promise.all(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => start(id, { ip: '192.0.2.77' })));
    assert.equal(raced.filter((r) => r.status === 201).length, 3);
    assert.equal(raced.filter((r) => r.status === 429).length, 2);
  });

  await section('the endpoint: KV throttle, same-origin, signed in, and form posts land on the account screen', async () => {
    const db = world();
    addUser(db, 'busy');
    assert.equal((await start('busy', { ip: '203.0.113.20' })).status, 201);
    for (let i = 0; i < 4; i++) assert.equal((await start('busy', { ip: '203.0.113.20' })).status, 409);
    const limited = await start('busy', { ip: '203.0.113.20' });
    assert.deepEqual([limited.status, limited.json.error.type], [429, 'rate_limited']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After says when');

    addUser(db, 'elsewhere');
    const cross = await start('elsewhere', { origin: 'https://evil.example' });
    assert.deepEqual([cross.status, cross.json.error.type], [403, 'forbidden']);
    assert.equal(trialOf(db, 'elsewhere'), undefined);
    assert.equal((await start(null)).status, 401);

    const form = await start('elsewhere', { json: false, ip: '203.0.113.21' });
    assert.deepEqual([form.status, form.headers.get('location')], [303, '/app/account?trial=started']);
    const refused = await start('elsewhere', { json: false, ip: '203.0.113.21' });
    assert.deepEqual([refused.status, refused.headers.get('location')], [303, '/app/account']);
    assert.match(refused.headers.get('set-cookie'), /^sf_flash=This%20account%20has%20already%20had%20its%20Pro%20trial\.; Path=\/app\/account; HttpOnly/);
  });

  /* ------------------------------------------------------------------------ */
  /* The plan an account acts on                                               */
  /* ------------------------------------------------------------------------ */

  await section('the effective plan: Pro while the trial runs over a lower plan, the own plan otherwise', async () => {
    const db = world();
    const running = (own, extra = {}) => {
      const id = `${own}-${Object.keys(extra).join('-') || 'plain'}`;
      addUser(db, id, { plan: own, ...extra });
      addTrial(db, id);
      return id;
    };
    for (const own of ['free', 'lite', 'plus']) {
      const user = await me(running(own));
      assert.deepEqual([user.plan, user.ownPlan, user.trial.active], ['pro', own, true], own);
    }
    for (const own of ['pro', 'business']) {
      const user = await me(running(own));
      assert.deepEqual([user.plan, user.ownPlan], [own, own], `${own} is not raised`);
    }
    const apple = await me(running('free', { apple: iso(Date.now() + DAY) }));
    assert.deepEqual([apple.plan, apple.ownPlan], ['pro', 'lite'], 'Apple’s Lite is the own plan');

    addUser(db, 'over');
    addTrial(db, 'over', { daysIn: 15 });
    let user = await me('over');
    assert.deepEqual([user.plan, user.ownPlan, user.trial.active], ['free', 'free', false], 'past ends_at, sweep or no sweep');
    assert.equal(plan.trialEnded(user), true);
    assert.equal(plan.trialJustEnded(user), true);
    db.prepare("UPDATE plan_trials SET started_at = ?, ends_at = ? WHERE user_id = 'over'").run(iso(Date.now() - 50 * DAY), iso(Date.now() - 36 * DAY));
    assert.equal(plan.trialJustEnded(await me('over')), false, 'a month on, nothing says so');

    addUser(db, 'closed');
    addTrial(db, 'closed', { ended: iso(Date.now()) });
    user = await me('closed');
    assert.deepEqual([user.plan, user.trial.active], ['free', false], 'closed before its end');

    addUser(db, 'never');
    user = await me('never');
    assert.deepEqual([user.plan, user.ownPlan, user.trial], ['free', 'free', undefined]);

    // The session and an API key read the same plan.
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256('tok'), 'free-plain', iso(Date.now()), '2999-01-01T00:00:00.000Z');
    const session = await auth.resolveSession('tok');
    assert.deepEqual([session.plan, session.ownPlan], ['pro', 'free']);
    const key = await auth.issueApiKey('free-plain', 'k', 'live');
    const viaKey = await auth.authenticateApiKey(new Request(`${ORIGIN}/v1/account`, { headers: { authorization: `Bearer ${key.secret}` } }));
    assert.deepEqual([viaKey.user.plan, viaKey.user.ownPlan], ['pro', 'free']);

    // planSql (retention, report branding) agrees with toSessionUser for every account here.
    const now = iso(Date.now());
    for (const row of db.prepare(`SELECT id, ${plan.planSql('u', '?1', true)} AS plan FROM users u`).all(now)) {
      assert.equal(row.plan, (await me(row.id)).plan, row.id);
    }
  });

  await section('quota: Pro’s for the month during the trial; the own plan’s for the rest of it after, usage kept', async () => {
    const db = world();
    addUser(db, 'q');
    addTrial(db, 'q');
    setUsed(db, 'q', 500);
    let usage = await captures.getUsage(await me('q'));
    assert.deepEqual([usage.used, usage.quota, usage.remaining], [500, 2000, 1500]);
    const pdf = parse({ url: 'https://example.com', format: 'pdf' });
    const row = await captures.createCaptureRow(await me('q'), pdf, 'app');
    assert.equal(pdf.watermark, false, 'no mark during the trial');
    assert.equal(row.reserved, 1);

    expire(db, 'q');
    usage = await captures.getUsage(await me('q'));
    assert.deepEqual([usage.used, usage.quota, usage.remaining], [501, 20, 0], 'what was used still counts');
    const after = await me('q');
    await assert.rejects(() => captures.createCaptureRow(after, parse({ url: 'https://example.com' }), 'app'), (error) => error.type === 'quota_exceeded' && /20 screenshots on the Free plan/.test(error.message));
    // A grandfathered free allowance is the one it goes back to.
    db.prepare("UPDATE users SET free_quota = 200 WHERE id = 'q'").run();
    usage = await captures.getUsage(await me('q'));
    assert.deepEqual([usage.quota, usage.remaining], [200, 0]);
    setUsed(db, 'q', 0);
    const clean = parse({ url: 'https://example.com' });
    await captures.createCaptureRow(await me('q'), clean, 'app');
    assert.equal(clean.watermark, true, 'the mark is back');
    assert.throws(() => captures.assertPlanAllows(after, parse({ url: 'https://example.com', format: 'pdf' })), /PDF export/);
  });

  await section('monitors: Pro’s limit and schedules during the trial; beyond Free’s pause at the next run, saying why', async () => {
    const db = world();
    addUser(db, 'mon');
    addTrial(db, 'mon');
    const make = async (label, frequency) =>
      watches.createWatch(await me('mon'), {
        options: parse({ url: `https://example.com/${label}`, device: 'desktop', mode: 'fullpage' }),
        label,
        frequency,
        threshold: 1,
        notifyEmail: false,
        webhookUrl: null,
      });
    const weekly = [];
    for (let i = 1; i <= 5; i++) {
      weekly.push(await make(`w${i}`, 'weekly'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const hourly = await make('hourly', 'hourly');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM watches WHERE user_id = 'mon'").get().n, 6, 'more than Free’s three, and hourly');
    let outcome = await watches.runWatch(await watches.getWatch(weekly[4].id), ORIGIN);
    assert.equal(outcome.status, 'done', `the fifth runs during the trial: ${JSON.stringify(outcome)}`);
    outcome = await watches.runWatch(await watches.getWatch(hourly.id), ORIGIN);
    assert.equal(outcome.status, 'done', 'hourly runs during the trial');

    expire(db, 'mon');
    await assert.rejects(() => make('late', 'weekly'), (error) => error.type === 'watch_limit', 'no new ones past Free’s limit');
    const results = [];
    for (const watch of [...weekly, hourly]) results.push(await watches.runWatch(await watches.getWatch(watch.id), ORIGIN));
    assert.deepEqual(results.map((r) => r.status), ['done', 'done', 'done', 'skipped', 'skipped', 'skipped']);
    const state = (id) => db.prepare('SELECT status, last_error FROM watches WHERE id = ?').get(id);
    for (const watch of weekly.slice(3)) {
      assert.deepEqual({ ...state(watch.id) }, { status: 'paused', last_error: 'Paused: your Pro trial ended; your plan includes 3 monitors.' });
    }
    assert.deepEqual({ ...state(hourly.id) }, {
      status: 'paused',
      last_error: 'Paused: your Pro trial ended; checks every hour are not included on your plan.',
    });
    for (const watch of weekly.slice(0, 3)) assert.equal(state(watch.id).status, 'active');
    // Resuming one more is refused, as after any downgrade.
    const resumer = await me('mon');
    await assert.rejects(() => watches.assertCanResume(weekly[3], resumer), (error) => error.type === 'watch_limit');

    // Without a trial — a paid plan given up — the wording is the plain one it always was.
    addUser(db, 'downgraded', { plan: 'plus' });
    const plain = [];
    for (let i = 0; i < 4; i++) {
      plain.push(
        await watches.createWatch(await me('downgraded'), {
          options: parse({ url: `https://example.com/d${i}`, device: 'desktop', mode: 'fullpage' }),
          label: `d${i}`,
          frequency: 'weekly',
          threshold: 1,
          notifyEmail: false,
          webhookUrl: null,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    db.prepare("UPDATE users SET plan = 'free' WHERE id = 'downgraded'").run();
    const last = await watches.runWatch(await watches.getWatch(plain[3].id), ORIGIN);
    assert.equal(last.status, 'skipped');
    assert.equal(state(plain[3].id).last_error, 'Paused: your plan includes 3 monitors.');
  });

  await section('API keys work during the trial and are refused after it, saying the trial ended', async () => {
    const db = world();
    addUser(db, 'dev');
    addTrial(db, 'dev');
    const key = await auth.issueApiKey('dev', 'trial key', 'live');
    const call = () => guard.guardApiRequest(new Request(`${ORIGIN}/v1/capture`, { method: 'POST', headers: { authorization: `Bearer ${key.secret}` } }));
    const ok = await call();
    assert.equal(ok.auth.user.plan, 'pro');
    assert.equal(ok.headers['x-ratelimit-limit'], '60', 'Pro’s rate');
    expire(db, 'dev');
    await assert.rejects(call, (error) => error.status === 403 && error.type === 'plan_required' && /Your Pro trial has ended/.test(error.message));
    assert.ok(db.prepare("SELECT revoked_at FROM api_keys WHERE user_id = 'dev'").get().revoked_at === null, 'the key is kept');

    addUser(db, 'plainfree');
    const other = await auth.issueApiKey('plainfree', 'k', 'live');
    await assert.rejects(
      () => guard.guardApiRequest(new Request(`${ORIGIN}/v1/capture`, { headers: { authorization: `Bearer ${other.secret}` } })),
      (error) => error.type === 'plan_required' && error.message === 'API access is available on the Pro and Business plans. Upgrade to start using keys.',
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Billing on the real plan                                                  */
  /* ------------------------------------------------------------------------ */

  await section('checkout, the plan-change diagnosis and Apple read the real plan: a trialing Free account can buy', async () => {
    const db = world();
    addUser(db, 'buyer');
    addTrial(db, 'buyer');
    const user = await me('buyer');
    assert.equal(user.plan, 'pro');
    for (const wanted of ['pro', 'lite']) {
      const request = new Request(`${ORIGIN}/api/billing/checkout`, {
        method: 'POST',
        headers: { origin: ORIGIN, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: wanted, interval: 'monthly' }),
      });
      const response = await checkout({ request, locals: { user } });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.url, `https://checkout.stripe.test/price_${wanted}_m`);
    }

    const diagnosis = await (await diagnose({ request: new Request(`${ORIGIN}/api/billing/diagnose`), locals: { user }, url: new URL(`${ORIGIN}/api/billing/diagnose`) })).json();
    assert.equal(diagnosis.plan, 'free', 'the plan being paid for');
    assert.equal(diagnosis.target, 'lite/yearly', 'the next plan up from it, not from Pro');

    fx.env.APPLE_IAP_KEY_ID = 'k';
    fx.env.APPLE_IAP_ISSUER_ID = 'i';
    fx.env.APPLE_IAP_PRIVATE_KEY = 'p';
    const apple = await (await purchases({ locals: { user } })).json();
    assert.equal(apple.canPurchase, true, 'the app may still sell Lite to a trialing Free account');

    // The pages that sell and change plans read ownPlan.
    const source = (path) => readFileSync(join(root, path), 'utf8');
    assert.match(source('src/pages/pricing.astro'), /user && user\.ownPlan === plan\.id \?/);
    assert.match(source('src/pages/app/upgrade.astro'), /const plan = getPlan\(user\.ownPlan\);/);
    assert.match(source('src/pages/app/account.astro'), /const plan = getPlan\(user\.ownPlan\);/);
    assert.match(source('src/pages/api/billing/diagnose.ts'), /getPlan\(user\.ownPlan\)/);
  });

  await section('subscribing to Pro or Business during the trial closes it without the ended email; Lite does not', async () => {
    const db = world();
    const subscription = (id, price, user) => ({
      id,
      status: 'active',
      customer: `cus_${user}`,
      metadata: { user_id: user },
      items: { data: [{ id: `si_${id}`, price: { id: price, recurring: { interval: 'month' } }, current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000) }] },
    });
    const event = (n, sub) => ({ id: `evt_${n}`, type: 'customer.subscription.updated', data: { object: { id: sub.id } } });

    addUser(db, 'goespro');
    addTrial(db, 'goespro');
    stripe.subscriptions.set('sub_p', subscription('sub_p', 'price_pro_m', 'goespro'));
    await billing.handleWebhookEvent(event(1, stripe.subscriptions.get('sub_p')));
    assert.equal(db.prepare("SELECT plan FROM users WHERE id = 'goespro'").get().plan, 'pro');
    assert.ok(trialOf(db, 'goespro').ended_at, 'closed');
    let user = await me('goespro');
    assert.deepEqual([user.plan, user.ownPlan, user.trial.active], ['pro', 'pro', false]);

    addUser(db, 'goeslite');
    addTrial(db, 'goeslite');
    stripe.subscriptions.set('sub_l', subscription('sub_l', 'price_lite_m', 'goeslite'));
    await billing.handleWebhookEvent(event(2, stripe.subscriptions.get('sub_l')));
    assert.equal(trialOf(db, 'goeslite').ended_at, null, 'Lite is below Pro: the trial goes on');
    user = await me('goeslite');
    assert.deepEqual([user.plan, user.ownPlan], ['pro', 'lite']);

    // Neither gets the ended email when the trials run out; Lite gets it, Pro is closed already.
    expire(db, 'goespro');
    expire(db, 'goeslite');
    const result = await trials.runTrialLifecycle(ORIGIN);
    assert.deepEqual(result, { reminded: 0, ended: 1, closed: 0 });
    assert.deepEqual(fx.mails.map((m) => m.to), ['goeslite@example.test']);
    assert.match(fx.mails[0].text, /back on Lite: 500 screenshots a month, 10 monitors checked daily or weekly and 30 days of capture history/);
    assert.doesNotMatch(fx.mails[0].text, /Captures older than/, 'Lite keeps as much history as Pro');

    // A payment the webhook never closed the trial for is closed quietly by the sweep.
    addUser(db, 'missed', { plan: 'business', subscription: 'sub_b', status: 'active' });
    addTrial(db, 'missed', { daysIn: 12 });
    fx.mails.length = 0;
    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN), { reminded: 0, ended: 0, closed: 1 });
    assert.equal(fx.mails.length, 0);
    assert.ok(trialOf(db, 'missed').ended_at);
  });

  /* ------------------------------------------------------------------------ */
  /* The hourly sweep                                                          */
  /* ------------------------------------------------------------------------ */

  await section('a reminder three days out and a note once it ended: each sent once, each with an upgrade link', async () => {
    const db = world();
    addUser(db, 'mailme');
    addTrial(db, 'mailme', { daysIn: 0 });
    const ends = Date.parse(trialOf(db, 'mailme').ends_at);

    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN, new Date(ends - 4 * DAY)), { reminded: 0, ended: 0, closed: 0 }, 'not yet');
    const at = new Date(ends - 3 * DAY + 3_600_000);
    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN, at), { reminded: 1, ended: 0, closed: 0 });
    assert.equal(fx.mails.length, 1);
    const [reminder] = fx.mails;
    assert.equal(reminder.to, 'mailme@example.test');
    assert.equal(reminder.subject, 'Your Pro trial ends in 3 days');
    assert.match(reminder.text, /back to Free: 20 screenshots a month, 3 monitors checked weekly and 7 days of capture history/);
    assert.match(reminder.text, /Nothing is charged for the trial, and we never asked for a card\./);
    assert.match(reminder.text, /API keys stop working/);
    assert.match(reminder.text, /Captures older than 7 days are deleted/);
    assert.match(reminder.text, /https:\/\/easyscreencapture\.test\/pricing#plan-pro$/);
    assert.ok(trialOf(db, 'mailme').reminded_at);
    await trials.runTrialLifecycle(ORIGIN, new Date(at.getTime() + 3_600_000));
    await Promise.all([trials.runTrialLifecycle(ORIGIN, at), trials.runTrialLifecycle(ORIGIN, at)]);
    assert.equal(fx.mails.length, 1, 'once');

    const after = new Date(ends + 3_600_000);
    const [one, two] = await Promise.all([trials.runTrialLifecycle(ORIGIN, after), trials.runTrialLifecycle(ORIGIN, after)]);
    assert.equal(one.ended + two.ended, 1, 'two sweeps overlapping send it once');
    assert.equal(fx.mails.length, 2);
    const ended = fx.mails[1];
    assert.equal(ended.subject, 'Your Pro trial has ended');
    assert.match(ended.text, /Your account is back on Free: 20 screenshots a month/);
    assert.match(ended.text, /Monitors beyond the 3 your plan includes, and schedules it does not include, are paused at their next check\./);
    assert.match(ended.text, /To keep Pro, choose it here:\nhttps:\/\/easyscreencapture\.test\/pricing#plan-pro$/);
    await trials.runTrialLifecycle(ORIGIN, new Date(ends + 2 * 3_600_000));
    assert.equal(fx.mails.length, 2, 'once');

    // A trial whose reminder window was missed gets only the ended note.
    addUser(db, 'late');
    addTrial(db, 'late', { daysIn: 15 });
    fx.mails.length = 0;
    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN), { reminded: 0, ended: 1, closed: 0 });
    assert.deepEqual(fx.mails.map((m) => m.subject), ['Your Pro trial has ended']);

    // Without a mailer the claims are still made, so nothing is sent later in a burst.
    addUser(db, 'quiet');
    addTrial(db, 'quiet', { daysIn: 15 });
    fx.mailReady = false;
    fx.mails.length = 0;
    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN), { reminded: 0, ended: 1, closed: 0 });
    fx.mailReady = true;
    assert.equal(fx.mails.length, 0);
    assert.deepEqual(await trials.runTrialLifecycle(ORIGIN), { reminded: 0, ended: 0, closed: 0 });

    // The worker runs it on the hourly trigger only.
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    const hourly = worker.slice(worker.indexOf('function hourly('));
    assert.ok(hourly.includes('runTrialLifecycle(siteOrigin(), now)'));
    assert.ok(!worker.slice(0, worker.indexOf('function hourly(')).includes('runTrialLifecycle('), 'not on the minute trigger');
  });

  /* ------------------------------------------------------------------------ */
  /* iOS, retention, dashboard, deletion                                       */
  /* ------------------------------------------------------------------------ */

  await section('the iOS profile keeps `plan` as the plan acted on and adds an optional trial {plan, ends_at}', async () => {
    const db = world();
    addUser(db, 'phone');
    const get = async () => (await profile({ locals: { user: { id: 'phone' } }, url: new URL(`${ORIGIN}/api/mobile/profile`) })).json();
    let body = await get();
    const before = Object.keys(body).sort();
    assert.equal(body.trial, undefined);
    assert.equal(body.plan, 'Free');

    addTrial(db, 'phone');
    body = await get();
    assert.deepEqual(Object.keys(body).sort(), [...before, 'trial'].sort(), 'one field added, nothing else changed');
    assert.deepEqual(body.trial, { plan: 'pro', ends_at: trialOf(db, 'phone').ends_at });
    assert.deepEqual([body.plan, body.retentionDays, body.usage.quota], ['Pro', 30, 2000]);
    assert.deepEqual(body.frequencies, ['hourly', 'daily', 'weekly'], 'visual schedules only, never the 15-minute one');

    expire(db, 'phone');
    body = await get();
    assert.deepEqual(Object.keys(body).sort(), before);
    assert.deepEqual([body.plan, body.usage.quota, body.frequencies], ['Free', 20, ['weekly']]);
    // The app is never offered a trial: the contract check asserts the field is optional and typed.
    assert.match(readFileSync(join(root, 'scripts/mobile-contract-check.mjs'), 'utf8'), /profile trial field is optional and typed/);
  });

  await section('retention follows the trial: Pro’s 30 days while it runs, the own plan’s once it ends', async () => {
    const db = world();
    addUser(db, 'keeper');
    addTrial(db, 'keeper');
    const row = await captures.createCaptureRow(await me('keeper'), parse({ url: 'https://example.com' }), 'app');
    await captures.runCapture(row, parse({ url: 'https://example.com' }));
    db.prepare('UPDATE captures SET created_at = ? WHERE id = ?').run(iso(Date.now() - 10 * DAY), row.id);
    await retention.sweepExpiredCaptures(Date.now());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures WHERE id = ?').get(row.id).n, 1, 'kept during the trial');
    expire(db, 'keeper');
    await retention.sweepExpiredCaptures(Date.now());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures WHERE id = ?').get(row.id).n, 0, 'Free’s 7 days once it ends');
  });

  await section('the growth dashboard counts trials started and those now on a Stripe plan', async () => {
    const db = world();
    for (const [id, own] of [['t1', 'free'], ['t2', 'pro'], ['t3', 'free']]) {
      addUser(db, id, { plan: own });
      addTrial(db, id);
    }
    db.prepare("UPDATE plan_trials SET started_at = ? WHERE user_id = 't3'").run(iso(Date.now() - 20 * DAY));
    const result = await report.growthReport();
    assert.deepEqual(result.trials, { started: [2, 3, 3], converted: [1, 1, 1] });
  });

  await section('deleting an account deletes its trial row', async () => {
    const db = world();
    addUser(db, 'leaver');
    addTrial(db, 'leaver');
    addUser(db, 'stayer');
    addTrial(db, 'stayer');
    await deletion.deleteAccount('leaver');
    assert.equal(trialOf(db, 'leaver'), undefined);
    assert.ok(trialOf(db, 'stayer'));
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Without migration 0019                                                    */
  /* ------------------------------------------------------------------------ */

  await section('without 0019 everything works as before: no trial, no offer, a 404, nothing swept', async () => {
    const db = world({ trials: false });
    // A new isolate: no probe cached from the migrated worlds above.
    const fresh = {
      auth: await load('src/lib/auth.ts'),
      plan: await load('src/lib/trial-plan.ts'),
      trials: await load('src/lib/trials.ts'),
      captures: await load('src/lib/captures.ts'),
      watches: await load('src/lib/watches.ts'),
      retention: await load('src/lib/retention.ts'),
      report: await load('src/lib/growth-report.ts'),
      deletion: await load('src/lib/account-deletion.ts'),
      billing: await load('src/lib/billing.ts'),
      route: (await load('src/pages/api/trial.ts')).POST,
      profile: (await load('src/pages/api/mobile/profile.ts')).GET,
    };
    assert.equal(await fresh.plan.trialsReady(), false);
    assert.deepEqual(await fresh.plan.trialColumns(), { select: '', join: '' });

    addUser(db, 'old');
    addUser(db, 'oldapple', { apple: iso(Date.now() + DAY) });
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256('old-tok'), 'old', iso(Date.now()), '2999-01-01T00:00:00.000Z');
    const user = await fresh.auth.resolveSession('old-tok');
    assert.deepEqual([user.plan, user.ownPlan, user.trial], ['free', 'free', undefined]);
    assert.equal((await fresh.auth.loadSessionUser('oldapple')).plan, 'lite', 'the Apple rule as before');
    assert.equal((await fresh.captures.getUsage(user)).quota, 20);

    const response = await fresh.route({
      request: new Request(`${ORIGIN}/api/trial`, { method: 'POST', headers: { origin: ORIGIN, accept: 'application/json' } }),
      locals: { user },
    });
    assert.deepEqual([response.status, (await response.json()).error.type], [404, 'not_found']);
    assert.equal(await fresh.trials.trialOfferFor(user), false);
    assert.deepEqual(await fresh.trials.runTrialLifecycle(ORIGIN), { reminded: 0, ended: 0, closed: 0 });
    assert.deepEqual(await fresh.trials.trialCleanup('old'), []);
    assert.equal(await fresh.plan.closeTrialForPayment('old', 'pro'), false);
    assert.equal(fresh.plan.planSql('u', '?1', false), "(CASE WHEN u.plan = 'free' AND u.apple_expires_at > ?1 THEN 'lite' ELSE u.plan END)");
    assert.equal((await fresh.report.growthReport()).trials, null);

    const body = await (await fresh.profile({ locals: { user: { id: 'old' } }, url: new URL(`${ORIGIN}/api/mobile/profile`) })).json();
    assert.equal(body.trial, undefined);
    assert.equal(body.plan, 'Free');

    // A monitor sweep, retention and a Stripe payment run as they always did.
    const watch = await fresh.watches.createWatch(user, {
      options: parse({ url: 'https://example.com/', device: 'desktop', mode: 'fullpage' }),
      label: 'Home',
      frequency: 'weekly',
      threshold: 1,
      notifyEmail: false,
      webhookUrl: null,
    });
    assert.equal((await fresh.watches.runWatch(await fresh.watches.getWatch(watch.id), ORIGIN)).status, 'done');
    await fresh.retention.sweepExpiredCaptures(Date.now());
    stripe.subscriptions.set('sub_old', {
      id: 'sub_old',
      status: 'active',
      customer: 'cus_old',
      metadata: { user_id: 'old' },
      items: { data: [{ id: 'si', price: { id: 'price_pro_m', recurring: { interval: 'month' } } }] },
    });
    await fresh.billing.handleWebhookEvent({ id: 'evt_old', type: 'customer.subscription.updated', data: { object: { id: 'sub_old' } } });
    assert.equal(db.prepare("SELECT plan FROM users WHERE id = 'old'").get().plan, 'pro');

    await fresh.deletion.deleteAccount('old');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id = 'old'").get().n, 0);
  });

  await section('the console upgrade carries no comments and records the migration; health lists it as optional', async () => {
    const upgrade = readFileSync(join(root, 'db/0019-upgrade.sql'), 'utf8');
    assert.ok(!upgrade.includes('--') && !upgrade.includes('/*'));
    assert.match(upgrade, /INSERT OR IGNORE INTO d1_migrations \(name\) VALUES \('0019_plan_trials\.sql'\);/);
    assert.match(readFileSync(join(root, 'db/apply-manually.sql'), 'utf8'), /VALUES \('0019_plan_trials\.sql'\)/);
    assert.match(readFileSync(join(root, 'src/lib/schema-manifest.ts'), 'utf8'), /name: '0019_plan_trials\.sql',\s*optional: true/);
  });

  assert.deepEqual(
    // The one expected: the diagnosis says why it could not build the plan-change link.
    errors.filter((e) => !/^\[billing\] no plan-change flow for lite\/yearly: the account has no subscription id recorded$/.test(e)),
    [],
    'nothing logged an unexpected error',
  );
  console.log = originalLog;
  console.error = originalError;
  console.log(
    `\nTrial checks passed (${passed.length}): starting a trial (once, 14 days, confirmed email, Free or Lite only, no ` +
      'Stripe subscription, 3 per hashed address in 30 days, KV throttle, same-origin, form redirects), the effective plan ' +
      'during and after, quota mid-month, monitor limits and pause reasons, API keys, checkout/diagnosis/Apple on the real ' +
      'plan, paying during a trial, both emails once each, the iOS profile, retention, the growth dashboard, account ' +
      'deletion and the no-migration fallback.',
  );
} catch (error) {
  console.log = originalLog;
  console.error = originalError;
  if (errors.length) console.error(errors.join('\n'));
  throw error;
} finally {
  globalThis.fetch = previousFetch;
  rmSync(directory, { recursive: true, force: true });
}
