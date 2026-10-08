/**
 * Monthly care reports: periods in the project's timezone across month edges
 * and DST, the snapshot from seeded monitors, runs, sign-offs and SEO
 * findings, the site-health section from a stubbed summary (and hidden when
 * it returns nothing), the next-steps rules, frozen snapshots, the schedule
 * (once on the 1st at 09:00 local, at-most-once deliveries), plan gating with
 * a Pro trial, recipients, throttles, links (expiry, revoke, the neutral 404,
 * the access count), ownership, white-label, the AI fallback, account
 * deletion, index-backed queries and the dormant state before migration 0021.
 * Real SQLite with every migration, an in-memory KV, a mocked mailer, Workers
 * AI and PDF printer. No network calls.
 *
 *   node scripts/care-report-check.mjs
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
const directory = mkdtempSync(join(tmpdir(), 'care-report-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__care = {
  env: {},
  mails: [],
  mailMode: 'ok',
  pdfs: [],
  healthReady: false,
  health: async () => [],
  healthCalls: [],
});

const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__care.env;',
  'astro:middleware': 'export const defineMiddleware = (fn) => fn;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts':
    'export const canSendEmail = () => globalThis.__care.mailMode !== "off";' +
    'export async function sendMail(mail) { const mode = globalThis.__care.mailMode; if (mode === "off") return false;' +
    ' globalThis.__care.mails.push(mail); if (mode === "throw") throw new Error("provider down"); return mode !== "fail"; }',
  '/lib/site-health-summary.ts':
    'export const siteHealthReady = async () => globalThis.__care.healthReady;' +
    'export async function siteHealthForWatches(...args) { globalThis.__care.healthCalls.push(args); return globalThis.__care.health(...args); }',
  '/lib/report-pdf.ts':
    'export const escapeHtml = (v) => v.replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" })[c]);' +
    'export async function printPdf(html) { globalThis.__care.pdfs.push(html); return new Uint8Array([37, 80, 68, 70]); }' +
    'export async function reportPdf() { throw new Error("not in this check"); }',
};

function plugin(real = []) {
  return {
    name: 'care-stubs',
    setup(b) {
      b.onResolve({ filter: /^(cloudflare:workers|astro:middleware|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
      for (const [suffix, contents] of Object.entries(STUBS)) {
        if (!suffix.startsWith('/') || real.includes(suffix)) continue;
        b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
      }
    },
  };
}

let bundles = 0;
/** A fresh copy of a module, with its own per-isolate probe caches, as a new isolate would have. */
async function load(entry, real = []) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [plugin(real)],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

const NEW = '0021_care_reports.sql';
/** A database with every migration, or every one but 0021. */
function database({ care = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!care && file === NEW) continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** Every statement the code ran, for the query-plan check at the end. */
const recorded = [];
/** D1 over node:sqlite: each statement atomic, a batch one transaction whose reads return rows, binds bounded as D1 bounds them. */
function d1(db) {
  const reads = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => {
      assert.ok(values.length <= 100, 'D1 takes at most 100 bound parameters');
      assert.ok(!values.some((v) => v === undefined), `undefined bound in ${sql.slice(0, 60)}`);
      return statement(sql, values);
    },
    first: async () => (recorded.push({ sql, args }), db.prepare(sql).get(...args) ?? null),
    all: async () => (recorded.push({ sql, args }), { results: db.prepare(sql).all(...args) }),
    run: async () => (recorded.push({ sql, args }), { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((q) => {
          recorded.push({ sql: q.sql, args: q.args });
          if (reads(q.sql)) return { results: db.prepare(q.sql).all(...q.args), meta: { changes: 0 } };
          return { results: [], meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } };
        });
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
  get: async (key) => (objects.has(key) ? { body: objects.get(key), size: 3, arrayBuffer: async () => objects.get(key).buffer } : null),
  head: async () => null,
  delete: async (keys) => {
    for (const key of [keys].flat()) objects.delete(key);
  },
  list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
};

const previousFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`unexpected fetch to ${input}`);
};

const ORIGIN = 'https://easyscreencapture.test';
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** Fixed for content: the Sofia September of 2026 runs 2026-08-31T21:00Z → 2026-09-30T21:00Z. */
const NOW = new Date('2026-10-08T10:00:00.000Z');
const PRJ = 'prj_care00001';
const OTHER_PRJ = 'prj_care00002';
const RUN_PREFIX = 'esc-run-v1:';
const detail = (message, extra = {}) =>
  RUN_PREFIX + JSON.stringify({ message, delivery: { email: 'not_needed', webhook: 'not_needed' }, ...extra });

/** A new world: its own database, the same env object every bundle holds on to. */
function world({ care = true, seed = true } = {}) {
  const db = database({ care });
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, { DB: d1(db), RATE, SHOTS, BROWSER: {}, PUBLIC_SITE_URL: ORIGIN });
  kv.clear();
  objects.clear();
  fx.mails.length = 0;
  fx.pdfs.length = 0;
  fx.mailMode = 'ok';
  fx.healthReady = false;
  fx.health = async () => [];
  fx.healthCalls.length = 0;
  if (seed) seedWorld(db);
  return db;
}

function addUser(db, id, { plan = 'pro', verified = true, name = id } = {}) {
  const at = iso(Date.now());
  const email = `${id}@agency.test`;
  db.prepare(
    `INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, email, name, plan, at, at, at, verified ? at : null);
  return id;
}
const addTrial = (db, id, { active = true } = {}) =>
  db
    .prepare('INSERT INTO plan_trials (user_id, plan, started_at, ends_at) VALUES (?, ?, ?, ?)')
    .run(id, 'pro', iso(Date.now() - 5 * DAY), iso(Date.now() + (active ? 9 : -1) * DAY));
const addProject = (db, id, user, name = 'Acme', brand = '') =>
  db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(id, user, name, brand, iso(Date.UTC(2026, 0, 1)));
let watchOrder = 0;
function addWatch(db, id, user, { label = '', url = 'https://acme.test/', project = PRJ, kind = null, selector = '' } = {}) {
  const at = iso(Date.UTC(2026, 0, 1) + ++watchOrder * 1000);
  db.prepare(
    `INSERT INTO watches (id, user_id, label, url, host, device, width, height, frequency, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, user, label, url, new URL(url).hostname, 'desktop', 1440, 900, 'daily', at, at, at);
  if (project) db.prepare('INSERT INTO project_watches VALUES(?,?)').run(project, id);
  if (kind) db.prepare('INSERT INTO monitor_rules(watch_id,kind,phrase,selector,region) VALUES(?,?,?,?,?)').run(id, kind, '', selector, '');
}
let runCount = 0;
function addRun(db, watch, at, { user = 'owner', status = 'done', changed = 0, pct = null, message = 'No significant change', extra = {}, capture = null } = {}) {
  const id = `wrn_${String(++runCount).padStart(6, '0')}`;
  db.prepare(
    `INSERT INTO watch_runs (id, watch_id, user_id, capture_id, baseline_capture_id, status, changed, change_pct, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, watch, user, capture, 'cap_base', status, changed, pct, status === 'error' ? message : detail(message, extra), at);
  return id;
}
function addReport(db, id, createdAt, project = PRJ, title = id) {
  db.prepare('INSERT INTO review_reports VALUES(?,?,?,?,?)').run(id, project, title, '', createdAt);
}
let signoffCount = 0;
function addSignoff(db, report, decision, at, name = 'Lee Client') {
  db.prepare('INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) VALUES(?,?,?,?,?,?)').run(
    `so_${++signoffCount}`,
    report,
    decision,
    decision === 'reset' ? '' : name,
    decision === 'changes' ? 'Move the button' : '',
    at,
  );
}

/** The project every content check reads: five monitors, a month of runs, six review reports. */
function seedWorld(db) {
  for (const [id, plan, verified] of [
    ['owner', 'pro', true],
    ['other', 'pro', true],
    ['plus', 'plus', true],
    ['free', 'free', true],
    ['lite', 'lite', true],
    ['trialist', 'free', true],
    ['unverified', 'pro', false],
  ])
    addUser(db, id, { plan, verified, name: id === 'owner' ? 'Dana Smith' : id });
  addTrial(db, 'trialist');
  addProject(db, PRJ, 'owner', 'Acme\nWebsite', 'North Studio');
  addProject(db, OTHER_PRJ, 'other', 'Other Co');
  for (const [id, user] of [
    ['prj_plus', 'plus'],
    ['prj_free', 'free'],
    ['prj_lite', 'lite'],
    ['prj_trial', 'trialist'],
    ['prj_unver', 'unverified'],
  ])
    addProject(db, id, user, `${user} project`);

  addWatch(db, 'w_home', 'owner', { label: 'Homepage', url: 'https://acme.test/' });
  addWatch(db, 'w_pricing', 'owner', { label: 'Pricing', url: 'https://acme.test/pricing' });
  addWatch(db, 'w_seo', 'owner', { label: 'Pricing SEO', url: 'https://acme.test/pricing', kind: 'seo' });
  addWatch(db, 'w_text', 'owner', { label: 'Free shipping banner', url: 'https://acme.test/shop', kind: 'disappeared' });
  addWatch(db, 'w_blog', 'owner', { label: 'Blog', url: 'https://acme.test/blog' });
  addWatch(db, 'w_loose', 'owner', { label: 'Not in the project', url: 'https://acme.test/loose', project: null });
  addWatch(db, 'w_other', 'other', { label: 'Other', url: 'https://other.test/', project: OTHER_PRJ });

  const sep = (day, hour = 12) => iso(Date.UTC(2026, 8, day, hour));
  // Pricing: twelve changes in September, the cap is ten.
  for (let day = 1; day <= 12; day++)
    addRun(db, 'w_pricing', sep(day), {
      changed: 1,
      pct: 10 + day,
      message: `${10 + day}% changed · Met the 1% threshold used for this check.`,
      extra: { regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], highlight: true },
      capture: `cap_p${day}`,
    });
  for (let day = 13; day <= 20; day++) addRun(db, 'w_pricing', sep(day));
  addRun(db, 'w_pricing', sep(21), { status: 'error', message: 'Navigation timed out' });
  addRun(db, 'w_pricing', sep(22), { status: 'skipped', message: 'Out of screenshots' });
  // Another account's row under this watch is never counted.
  addRun(db, 'w_pricing', sep(23), { user: 'other', changed: 1, pct: 99 });
  // Homepage: the edges of the Sofia month.
  addRun(db, 'w_home', '2026-08-31T20:59:00.000Z', { changed: 1, pct: 5 }); // 23:59 on 31 Aug in Sofia: August
  addRun(db, 'w_home', '2026-08-31T21:00:00.000Z', { changed: 1, pct: 6, message: '6% changed · Met the 1% threshold used for this check.' }); // 00:00 on 1 Sep: September
  addRun(db, 'w_home', '2026-09-30T20:59:00.000Z', { changed: 1, pct: 7, message: '7% changed · Met the 1% threshold used for this check.' }); // 23:59 on 30 Sep: September
  addRun(db, 'w_home', '2026-09-30T21:00:00.000Z', { changed: 1, pct: 8 }); // 00:00 on 1 Oct: October
  // SEO: a noindex and a 404 in the month.
  addRun(db, 'w_seo', sep(3), { changed: 1, message: 'HTTP status: 200 → 404' });
  addRun(db, 'w_seo', sep(12), { changed: 1, message: 'Robots: index → noindex; Title: "Pricing" → "Prices"' });
  addRun(db, 'w_seo', sep(13), { message: 'No watched SEO signal changed.' });
  addRun(db, 'w_text', sep(5), { changed: 1, message: '“Free shipping” is no longer on the page.' });
  // Blog: fine, then its last three checks failed.
  addRun(db, 'w_blog', sep(20));
  for (const day of [28, 29, 30]) addRun(db, 'w_blog', sep(day, 6), { status: 'error', message: 'DNS failure' });
  addRun(db, 'w_loose', sep(10), { changed: 1, pct: 50 });
  addRun(db, 'w_other', sep(10), { user: 'other', changed: 1, pct: 50 });

  addReport(db, 'rep_a', sep(1), PRJ, 'Launch review');
  addReport(db, 'rep_b', sep(2), PRJ, 'Checkout\nreview');
  addReport(db, 'rep_c', '2026-08-01T00:00:00.000Z', PRJ, 'August review');
  addReport(db, 'rep_d', sep(4), PRJ, 'Footer review');
  addReport(db, 'rep_e', sep(6), PRJ, 'Menu review');
  addReport(db, 'rep_f', '2026-10-02T00:00:00.000Z', PRJ, 'October review');
  addReport(db, 'rep_o', sep(6), OTHER_PRJ, 'Other review');
  addSignoff(db, 'rep_a', 'changes', sep(3), 'Lee Client');
  addSignoff(db, 'rep_a', 'approved', sep(9), 'Lee Client');
  addSignoff(db, 'rep_b', 'changes', sep(10), 'Sam Client');
  addSignoff(db, 'rep_c', 'approved', '2026-08-02T00:00:00.000Z');
  addSignoff(db, 'rep_e', 'approved', sep(7));
  addSignoff(db, 'rep_e', 'reset', sep(8));
  addSignoff(db, 'rep_d', 'approved', '2026-10-03T00:00:00.000Z'); // after the period: still awaiting in September
  db.prepare(
    `INSERT INTO project_branding(project_id,logo_key,logo_type,logo_width,logo_height,accent,footer,hide_attribution,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(PRJ, '', '', 0, 0, '#1f6feb', 'North Studio · hello@north.test', 1, iso(Date.now()));
}

const sampleHealth = () => [
  {
    origin: 'https://acme.test',
    uptime: {
      checks: 8640,
      down: 12,
      pct: 99.861,
      incidents: [
        { startedAt: '2026-09-14T03:00:00.000Z', endedAt: '2026-09-14T03:40:00.000Z', minutes: 40, detail: 'HTTP 503' },
        { startedAt: '2026-09-30T19:00:00.000Z', endedAt: null, minutes: 120, detail: 'Connection refused' },
      ],
    },
    ssl: { status: 'expiring', validTo: '2026-10-12T12:00:00.000Z', issuer: "Let's Encrypt", checkedAt: '2026-09-30T00:00:00.000Z', detail: 'Expires in 12 days' },
    domain: { status: 'ok', domain: 'acme.test', expiresAt: '2027-03-01T00:00:00.000Z', registrar: 'Example Registrar', checkedAt: '2026-09-30T00:00:00.000Z', detail: '' },
    links: {
      checkedAt: '2026-09-30T00:00:00.000Z',
      pages: 40,
      checked: 1200,
      broken: Array.from({ length: 23 }, (_, i) => ({
        page: i < 3 ? 'https://acme.test/pricing' : 'https://acme.test/blog/post',
        url: `https://acme.test/missing-${i}`,
        status: 404,
        reason: 'Not found',
      })),
      fixed: 5,
    },
  },
  {
    origin: 'https://shop.acme.test',
    uptime: { checks: 4320, down: 0, pct: 100, incidents: [] },
    ssl: { status: 'expired', validTo: '2026-09-20T00:00:00.000Z', issuer: 'Example CA', checkedAt: '2026-09-30T00:00:00.000Z', detail: '' },
    domain: { status: 'expiring', domain: 'acme-shop.test', expiresAt: '2026-10-20T00:00:00.000Z', registrar: null, checkedAt: '2026-09-30T00:00:00.000Z', detail: '' },
    links: null,
  },
];

/** The modules, loaded fresh for a world so their per-isolate caches start empty. */
async function modules() {
  const [care, rules, period, deletion, api, publicPdf, ownerPdf, highlight] = await Promise.all([
    load('src/lib/care-reports.ts'),
    load('src/lib/care-rules.ts'),
    load('src/lib/care-period.ts'),
    load('src/lib/account-deletion.ts'),
    load('src/pages/api/care/index.ts'),
    load('src/pages/care/[token]/pdf.ts'),
    load('src/pages/api/care/[id]/pdf.ts'),
    load('src/pages/api/care/[id]/highlight.ts'),
  ]);
  const auth = await load('src/lib/auth.ts');
  const pdf = await load('src/lib/care-pdf.ts');
  return { care, rules, period, deletion, api, publicPdf, ownerPdf, highlight, auth, pdf };
}

const rejects = async (promise, status, type) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.status, status, `${error.type}: ${error.message}`);
    if (type) assert.equal(error.type, type, error.message);
    return error;
  }
  assert.fail(`expected a ${status} rejection`);
};
const tokenOf = (url) => url.split('/').at(-1);
const settings = (m, user, body) => m.care.careAction(user, { action: 'settings', project_id: PRJ, timezone: 'Europe/Sofia', ...body }, ORIGIN, NOW);

try {
  /* ------------------------------------------------------------------------ */
  /* Before 0021                                                               */
  /* ------------------------------------------------------------------------ */

  await section('before 0021 everything is dormant: no sweep, 404 routes, nothing to delete', async () => {
    const db = world({ care: false });
    const m = await modules();
    assert.equal(await m.care.careReportsReady(), false);
    assert.deepEqual(await m.care.runCareReports(ORIGIN, NOW), { due: 0, generated: 0, attempted: 0, skipped: 0 });
    const owner = await m.auth.loadSessionUser('owner');
    await rejects(m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW), 404);
    await rejects(m.care.sharedCareReport('a'.repeat(64)), 404);
    // The API answers 404 before it even asks who is calling.
    let response = await m.api.POST({ request: new Request(`${ORIGIN}/api/care`, { method: 'POST', body: new URLSearchParams({ action: 'generate' }) }), locals: { user: null } });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.type, 'not_found');
    response = await m.publicPdf.GET({ params: { token: 'a'.repeat(64) }, request: new Request(`${ORIGIN}/care/x/pdf`) });
    assert.equal(response.status, 404);
    response = await m.ownerPdf.POST({ params: { id: 'care_x' }, locals: { user: owner }, request: new Request(`${ORIGIN}/api/care/care_x/pdf`, { method: 'POST' }) });
    assert.equal(response.status, 404);
    assert.equal(fx.mails.length, 0);
    assert.equal(kv.size, 0, 'nothing is throttled, or counted, for a feature that is not there');
    await m.deletion.deleteAccount('owner');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id='owner'").get().n, 0, 'account deletion works without the tables');
    // The pages probe the same table and hide every panel.
    for (const page of ['src/pages/app/projects/[id].astro', 'src/pages/app/projects/[id]/care.astro', 'src/pages/app/care/[id].astro']) {
      const source = readFileSync(join(root, page), 'utf8');
      assert.match(source, /careReports(Ready|Available)\(/, `${page} checks for the migration`);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* Periods                                                                   */
  /* ------------------------------------------------------------------------ */

  await section('periods: whole months in the project timezone, across month edges, DST and half-hour zones', async () => {
    world({ seed: false });
    const { period: p } = await modules();
    const hours = (x) => (Date.parse(x.to) - Date.parse(x.from)) / 3_600_000;
    let x = p.monthPeriod('Europe/Sofia', '2026-09');
    assert.deepEqual([x.from, x.to, x.label], ['2026-08-31T21:00:00.000Z', '2026-09-30T21:00:00.000Z', 'September 2026']);
    x = p.monthPeriod('Europe/Sofia', '2026-10');
    assert.deepEqual([x.from, x.to], ['2026-09-30T21:00:00.000Z', '2026-10-31T22:00:00.000Z']);
    assert.equal(hours(x), 31 * 24 + 1, 'October in Sofia has the hour DST gives back');
    assert.equal(hours(p.monthPeriod('Europe/Sofia', '2026-03')), 31 * 24 - 1, 'and March loses one');
    x = p.monthPeriod('America/New_York', '2026-11');
    assert.deepEqual([x.from, x.to], ['2026-11-01T04:00:00.000Z', '2026-12-01T05:00:00.000Z'], 'DST ends at 02:00 on 1 Nov; midnight is still EDT');
    x = p.monthPeriod('Asia/Kolkata', '2026-09');
    assert.deepEqual([x.from, x.to], ['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
    x = p.monthPeriod('Australia/Lord_Howe', '2026-10');
    assert.deepEqual([x.from, x.to], ['2026-09-30T13:30:00.000Z', '2026-10-31T13:00:00.000Z'], 'a half-hour DST change');
    assert.deepEqual(p.monthPeriod('UTC', '2026-12').to, '2027-01-01T00:00:00.000Z', 'the year rolls over');
    assert.equal(p.monthOf('Europe/Sofia', new Date('2026-09-30T20:59:59Z')), '2026-09');
    assert.equal(p.monthOf('Europe/Sofia', new Date('2026-09-30T21:00:00Z')), '2026-10');
    assert.equal(p.previousMonth('Europe/Sofia', new Date('2026-11-01T07:00:00Z')), '2026-10');
    assert.equal(p.previousMonth('UTC', new Date('2026-01-01T09:00:00Z')), '2025-12');
    // The schedule: the next 1st at 09:00 local, strictly after now.
    assert.equal(p.nextCareRun('Europe/Sofia', NOW), '2026-11-01T07:00:00.000Z', '09:00 EET, after DST ended');
    assert.equal(p.nextCareRun('America/New_York', NOW), '2026-11-01T14:00:00.000Z', '09:00 EST on the morning DST ends');
    assert.equal(p.nextCareRun('Asia/Kolkata', NOW), '2026-11-01T03:30:00.000Z');
    assert.equal(p.nextCareRun('Europe/Sofia', new Date('2026-11-01T06:59:00Z')), '2026-11-01T07:00:00.000Z');
    assert.equal(p.nextCareRun('Europe/Sofia', new Date('2026-11-01T07:00:00Z')), '2026-12-01T07:00:00.000Z', 'never the slot it is in');
    assert.equal(p.nextCareRun('Pacific/Kiritimati', new Date('2026-12-15T00:00:00Z')), '2026-12-31T19:00:00.000Z', 'UTC+14 starts January on 31 Dec');
    // What may be generated by hand: this month so far and the twelve before it.
    const months = p.manualPeriods('Europe/Sofia', NOW);
    assert.deepEqual([months.length, months[0], months[1], months.at(-1)], [13, '2026-10', '2026-09', '2025-10']);
    const soFar = p.manualPeriod('Europe/Sofia', '2026-10', NOW);
    assert.deepEqual([soFar.partial, soFar.from, soFar.to], [true, '2026-09-30T21:00:00.000Z', NOW.toISOString()]);
    assert.equal(p.manualPeriod('Europe/Sofia', '2026-09', NOW).partial, false);
    for (const bad of ['2026-11', '2025-09', '2026-13', 'September', '']) assert.equal(p.manualPeriod('Europe/Sofia', bad, NOW), null, bad);
    for (const zone of ['Europe/Sofia', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) assert.equal(p.validTimezone(zone), zone);
    for (const zone of ['', 'Mars/Base', '+02:00', 'Europe/Sofia; DROP', 'x'.repeat(65)]) assert.equal(p.validTimezone(zone), null, zone);
    assert.equal(p.formatDayTime('2026-09-30T21:30:00Z', 'Europe/Sofia'), '1 Oct 2026, 00:30');
    assert.equal(p.periodRange(p.monthPeriod('Europe/Sofia', '2026-09'), NOW.toISOString()), '1–30 Sep 2026');
    assert.equal(p.periodRange(soFar, NOW.toISOString()), '1–8 Oct 2026', 'the month so far ends today');
    assert.equal(p.periodRange(p.monthPeriod('Pacific/Kiritimati', '2026-12'), NOW.toISOString()), '1–31 Dec 2026');
    // Quiet monitor runs are pruned hourly; in every timezone, a 31-day month's first quiet check is still
    // there when its report is made on the 1st at 09:00, so "checks run" counts the whole month.
    const keep = Number(/const QUIET_RUN_DAYS = (\d+);/.exec(readFileSync(join(root, 'src/lib/retention.ts'), 'utf8'))[1]);
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      for (const month of ['2026-10', '2026-12', '2027-01']) {
        const whole = p.monthPeriod(zone, month);
        const reportAt = Date.parse(p.nextCareRun(zone, new Date(Date.parse(whole.to) - 1)));
        assert.ok(reportAt - Date.parse(whole.from) < keep * DAY, `${zone} ${month}: the report reads before the prune`);
      }
    }
  });

  /* ------------------------------------------------------------------------ */
  /* The snapshot                                                              */
  /* ------------------------------------------------------------------------ */

  let snapshotForLater;
  await section('the snapshot: monitors, changed checks (capped), failures, sign-offs and SEO findings for the month', async () => {
    world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    await settings(m, owner, { recipients: '' });
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW);
    assert.match(made.share_url, new RegExp(`^${ORIGIN}/care/[a-f0-9]{64}$`));
    assert.equal(made.redirect, `/app/care/${made.id}`);
    const { snapshot: s, report } = await m.care.ownCareReport('owner', made.id);
    snapshotForLater = s;
    assert.deepEqual([report.period, report.kind, report.user_id], ['2026-09', 'manual', 'owner']);
    assert.deepEqual(s.project, { name: 'Acme Website', brand: 'North Studio' }, 'owner text is one line');
    assert.deepEqual([s.period.key, s.period.timezone, s.period.partial], ['2026-09', 'Europe/Sofia', false]);
    // Totals: done and failed checks count, skipped ones and other accounts' rows do not; nor do monitors outside the project.
    assert.deepEqual(s.totals, { monitors: 5, checks: 31, changes: 17, failed: 4, skipped: 1, approved: 1, changesRequested: 1, awaiting: 2 });
    const by = Object.fromEntries(s.monitors.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(by).sort(), ['w_blog', 'w_home', 'w_pricing', 'w_seo', 'w_text']);
    assert.equal(s.monitors[0].id, 'w_pricing', 'the busiest monitor leads');
    const pricing = by.w_pricing;
    assert.deepEqual([pricing.checks, pricing.changes, pricing.failed, pricing.changed.length, pricing.more], [21, 12, 1, 10, 2]);
    assert.equal(pricing.changed[0].at, '2026-09-12T12:00:00.000Z', 'newest first');
    assert.deepEqual([pricing.changed[0].pct, pricing.changed[0].areas, pricing.changed[0].highlight], [22, 2, true]);
    assert.equal(pricing.changed[0].summary, '22% changed', 'our threshold verdict is left out');
    assert.deepEqual(by.w_home.changed.map((c) => c.pct), [7, 6], 'the first and last minute of the Sofia month, and nothing either side');
    assert.equal(by.w_blog.failing, true, 'its last three checks failed');
    assert.equal(by.w_pricing.failing, false);
    // Rule monitors: their findings are under SEO, not repeated as changes.
    assert.deepEqual([by.w_seo.changed.length, by.w_seo.more], [0, 0]);
    const seo = Object.fromEntries(s.seo.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(seo).sort(), ['w_seo', 'w_text']);
    assert.deepEqual(seo.w_seo.findings.map((f) => f.lines), [['Robots: index → noindex', 'Title: "Pricing" → "Prices"'], ['HTTP status: 200 → 404']]);
    assert.deepEqual([seo.w_seo.flagged, seo.w_seo.checks, seo.w_seo.kind], [2, 3, 'seo']);
    assert.deepEqual(seo.w_text.findings[0].lines, ['“Free shipping” is no longer on the page.']);
    // Sign-offs as they stood at the end of September.
    assert.deepEqual(
      s.signoffs.decided.map((d) => [d.title, d.state, d.name]),
      [
        ['Checkout review', 'changes', 'Sam Client'],
        ['Launch review', 'approved', 'Lee Client'],
      ],
      'the latest decision in the month, newest first; August’s approval is old news',
    );
    assert.deepEqual(s.signoffs.awaiting.map((a) => a.title).sort(), ['Footer review', 'Menu review'], 'reset after approval, and decided only in October');
    assert.ok(!JSON.stringify(s).includes('October review'), 'a report made after the period is not in it');
    assert.equal(s.health.length, 0);
    assert.deepEqual(s.nextSteps, [
      'Check /pricing on acme.test: it now asks search engines not to index it.',
      '1 monitor failed its last 3 checks.',
      'Make the changes requested on 1 review report.',
      '2 review reports are waiting for sign-off.',
    ]);
    // Never a capture URL or share token: the client's page is drawn from this.
    const json = JSON.stringify(s);
    for (const secret of ['/f/', '?t=', 'share_token', 'cap_p']) assert.ok(!json.includes(secret), secret);
    // The figures without site health: checks, changes, approvals and what waits.
    assert.deepEqual(
      m.rules.headlineFigures(s).map((f) => [f.label, f.value]),
      [
        ['CHECKS RUN', '31'],
        ['CHANGES FOUND', '17'],
        ['APPROVED BY CLIENT', '1'],
        ['AWAITING SIGN-OFF', '2'],
      ],
    );
    // The baseline-approval line waits for migration 0022's table, and reads it once it is there.
    assert.ok(!s.monitors.some((x) => 'baselineApprovedAt' in x));
    fx.env.DB.prepare('CREATE TABLE baseline_approvals (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, approved_at TEXT NOT NULL)').run();
    fx.env.DB.prepare("INSERT INTO baseline_approvals VALUES ('ba1','w_pricing','2026-09-15T10:00:00.000Z'),('ba2','w_home','2026-08-15T10:00:00.000Z')").run();
    const again = await m.care.buildSnapshot((await fx.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(PRJ).first()), m.period.monthPeriod('Europe/Sofia', '2026-09'), NOW);
    const approvals = Object.fromEntries(again.monitors.map((x) => [x.id, x.baselineApprovedAt]));
    assert.deepEqual([approvals.w_pricing, approvals.w_home], ['2026-09-15T10:00:00.000Z', undefined], 'only approvals inside the month');
    // A partial month says so.
    const soFar = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-10' }, ORIGIN, NOW);
    const partial = (await m.care.ownCareReport('owner', soFar.id)).snapshot;
    assert.deepEqual([partial.period.partial, partial.period.to, partial.totals.changes], [true, NOW.toISOString(), 1]);
    assert.match(partial.summary.text, /^So far in October 2026/);
  });

  await section('site health: from the stubbed summary, capped, in the figures and next steps; hidden when it returns []', async () => {
    world();
    const m = await modules();
    fx.healthReady = true;
    fx.health = async () => sampleHealth();
    const project = await fx.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(PRJ).first();
    const sep = m.period.monthPeriod('Europe/Sofia', '2026-09');
    const s = await m.care.buildSnapshot(project, sep, NOW);
    assert.deepEqual(fx.healthCalls[0], ['owner', ['w_home', 'w_pricing', 'w_seo', 'w_text', 'w_blog'], sep.from, sep.to], 'the owner, the project’s monitors and the period');
    assert.equal(s.health.length, 2);
    assert.deepEqual([s.health[0].links.broken.length, s.health[0].brokenMore], [20, 3], 'open broken links are capped, the rest counted');
    const figures = Object.fromEntries(m.rules.headlineFigures(s).map((f) => [f.label, f]));
    assert.deepEqual(Object.keys(figures), ['CHECKS RUN', 'CHANGES FOUND', 'APPROVED BY CLIENT', 'UPTIME', 'SSL & DOMAIN', 'BROKEN LINKS']);
    assert.equal(figures.UPTIME.value, '99.90%', 'checks that were up, over every site');
    assert.equal(figures.UPTIME.note, '2 incidents');
    assert.equal(figures['SSL & DOMAIN'].value, '1 needs attention');
    assert.deepEqual([figures['BROKEN LINKS'].value, figures['BROKEN LINKS'].note, figures['BROKEN LINKS'].attention], ['23 open', '5 fixed', true]);
    assert.deepEqual(s.nextSteps.slice(0, 5), [
      'Renew the SSL certificate for acme.test before 12 Oct.',
      'acme.test has been down since 30 Sep; restore it.',
      'Renew the SSL certificate for acme-shop.test: it expired on 20 Sep 2026.',
      'Renew the domain acme-shop.test before 20 Oct.',
      'Fix 23 broken links on acme.test, 17 of them on /blog/post.',
    ]);
    const html = m.pdf.careReportHtml(s, null, null);
    assert.match(html, /<h2>Site health<\/h2>/);
    assert.match(html, /99\.86%/);
    assert.match(html, /Expiring soon · valid to 12 Oct 2026 · Let&#39;s Encrypt/);
    assert.match(html, /and 3 more/);
    // Nothing to report: the section is not there at all.
    fx.health = async () => [];
    const quiet = await m.care.buildSnapshot(project, sep, NOW);
    assert.deepEqual(quiet.health, []);
    assert.ok(!m.pdf.careReportHtml(quiet, null, null).includes('Site health'));
    assert.ok(!m.rules.headlineFigures(quiet).some((f) => f.label === 'UPTIME'));
    // A module that throws, or is not ready, leaves the section out and the report intact.
    fx.health = async () => {
      throw new Error('site health broke');
    };
    const errors = [];
    const log = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      assert.deepEqual((await m.care.buildSnapshot(project, sep, NOW)).health, []);
    } finally {
      console.error = log;
    }
    assert.match(errors.join('\n'), /site health unavailable/);
    fx.healthReady = false;
    fx.health = async () => sampleHealth();
    assert.deepEqual((await m.care.buildSnapshot(project, sep, NOW)).health, [], 'not ready, not asked');
    // The page renders the section only when there is something in it.
    const component = readFileSync(join(root, 'src/components/CareReport.astro'), 'utf8');
    assert.match(component, /health\.length > 0 && \(\s*<section class="care-section" aria-labelledby="care-health">/);
    // The stub this branch ships, which 0020 replaces, has exactly that shape and reports nothing.
    const stub = await load('src/lib/site-health-summary.ts', ['/lib/site-health-summary.ts']);
    assert.deepEqual([await stub.siteHealthReady(), await stub.siteHealthForWatches('owner', ['w_home'], sep.from, sep.to)], [false, []]);
  });

  /* ------------------------------------------------------------------------ */
  /* Next steps                                                                */
  /* ------------------------------------------------------------------------ */

  await section('next steps: short and factual, most pressing first, capped; "Nothing needs attention" when none apply', async () => {
    const { rules: r } = await modules();
    const base = {
      v: 1,
      project: { name: 'A', brand: '' },
      period: { key: '2026-09', label: 'September 2026', timezone: 'UTC', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', partial: false },
      generatedAt: '2026-10-01T09:00:00.000Z',
      totals: { monitors: 1, checks: 30, changes: 0, failed: 0, skipped: 0, approved: 0, changesRequested: 0, awaiting: 0 },
      summary: { text: '', source: 'plain' },
      monitors: [{ id: 'w', label: 'Home', url: 'https://a.test/', kind: 'visual', checks: 30, changes: 0, failed: 0, failing: false, changed: [], more: 0 }],
      monitorsMore: 0,
      signoffs: { decided: [], awaiting: [], awaitingMore: 0 },
      seo: [],
      health: [],
      nextSteps: [],
    };
    assert.deepEqual(r.nextSteps(base), []);
    assert.equal(r.NOTHING_NEEDED, 'Nothing needs attention.');
    const site = (patch) => ({ origin: 'https://example.com', uptime: null, ssl: null, domain: null, links: null, ...patch });
    const ssl = (status, extra = {}) => ({ status, validTo: '2026-10-12T00:00:00.000Z', issuer: null, checkedAt: '', detail: '', ...extra });
    const steps = (patch) => r.nextSteps({ ...base, ...patch });
    assert.deepEqual(steps({ health: [site({ ssl: ssl('expiring') })] }), ['Renew the SSL certificate for example.com before 12 Oct.']);
    assert.deepEqual(steps({ health: [site({ ssl: ssl('expired') })] }), ['Renew the SSL certificate for example.com: it expired on 12 Oct 2026.']);
    assert.deepEqual(steps({ health: [site({ ssl: ssl('invalid', { detail: 'Hostname\nmismatch' }) })] }), ['Fix the SSL certificate for example.com: Hostname mismatch']);
    assert.deepEqual(steps({ health: [site({ ssl: ssl('no_https') })] }), ['Serve example.com over HTTPS.']);
    assert.deepEqual(steps({ health: [site({ ssl: ssl('ok'), domain: { status: 'ok', domain: 'example.com', expiresAt: null, registrar: null, checkedAt: '', detail: '' } })] }), []);
    assert.deepEqual(
      steps({ health: [site({ domain: { status: 'expiring', domain: 'example.com', expiresAt: '2026-11-03T00:00:00.000Z', registrar: null, checkedAt: '', detail: '' } })] }),
      ['Renew the domain example.com before 3 Nov.'],
    );
    const broken = (pages) => site({ links: { checkedAt: '', pages: 3, checked: 90, fixed: 2, broken: pages.map((page, i) => ({ page, url: `https://example.com/x${i}`, status: 404, reason: '' })) } });
    assert.deepEqual(steps({ health: [broken(['https://example.com/pricing', 'https://example.com/pricing', 'https://example.com/pricing'])] }), ['Fix 3 broken links on /pricing.']);
    assert.deepEqual(steps({ health: [broken(['https://example.com/a'])] }), ['Fix 1 broken link on /a.']);
    assert.deepEqual(steps({ health: [broken(['https://example.com/a', 'https://example.com/b', 'https://example.com/b'])] }), ['Fix 3 broken links on example.com, 2 of them on /b.']);
    assert.deepEqual(steps({ health: [site({ uptime: { checks: 10, down: 2, pct: 80, incidents: [{ startedAt: '2026-09-29T10:00:00.000Z', endedAt: null, minutes: 60, detail: '' }] } })] }), ['example.com has been down since 29 Sep; restore it.']);
    const seo = (lines) => [{ id: 's', label: 'SEO', url: 'https://example.com/pricing', kind: 'seo', checks: 4, flagged: 1, findings: [{ at: '', lines }], more: 0 }];
    assert.deepEqual(steps({ seo: seo(['HTTP status: 200 → 500']) }), ['Check /pricing on example.com: it now answers HTTP 500.']);
    assert.deepEqual(steps({ seo: seo(['Robots: noindex → index']) }), [], 'back in the index is good news');
    assert.deepEqual(steps({ seo: seo(['Title: "A" → "B"']) }), []);
    assert.deepEqual(steps({ monitors: [{ ...base.monitors[0], failing: true }, { ...base.monitors[0], id: 'v', failing: true }] }), ['2 monitors failed their last 3 checks.']);
    assert.deepEqual(steps({ totals: { ...base.totals, awaiting: 1 } }), ['1 review report is waiting for sign-off.']);
    assert.deepEqual(steps({ totals: { ...base.totals, awaiting: 2, changesRequested: 1 } }), ['Make the changes requested on 1 review report.', '2 review reports are waiting for sign-off.']);
    assert.deepEqual(steps({ signoffs: null, totals: { ...base.totals, awaiting: 2 } }), [], 'no sign-off without migration 0015');
    const many = Array.from({ length: 12 }, (_, i) => site({ origin: `https://s${i}.test`, ssl: ssl('no_https') }));
    assert.equal(steps({ health: many }).length, 8, 'at most eight');
    assert.match(r.plainSummary(base), /Nothing needs your attention\.$/);
  });

  /* ------------------------------------------------------------------------ */
  /* Frozen                                                                    */
  /* ------------------------------------------------------------------------ */

  await section('a report is frozen: later runs, retention, renames, removed monitors and resets change nothing in it', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    await settings(m, owner, {});
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW);
    const before = (await m.care.sharedCareReport(tokenOf(made.share_url), false, NOW)).snapshot;
    assert.deepEqual(before.totals, snapshotForLater.totals);
    db.exec(`DELETE FROM watch_runs; DELETE FROM project_watches WHERE watch_id='w_seo'; UPDATE projects SET name='Renamed', brand='' WHERE id='${PRJ}'; DELETE FROM report_signoffs;`);
    addRun(db, 'w_home', '2026-09-15T00:00:00.000Z', { changed: 1, pct: 40 });
    const after = (await m.care.sharedCareReport(tokenOf(made.share_url), false, NOW)).snapshot;
    assert.deepEqual(after, before, 'the stored snapshot is what was generated');
    assert.equal(after.project.name, 'Acme Website');
    // Generating the month again by hand replaces the manual snapshot, and keeps its link.
    const redo = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW);
    assert.equal(redo.id, made.id);
    assert.equal(redo.share_url, undefined, 'the live link stays; no new one');
    const fresh = (await m.care.sharedCareReport(tokenOf(made.share_url), false, NOW)).snapshot;
    assert.deepEqual([fresh.project.name, fresh.totals.changes, fresh.totals.monitors], ['Renamed', 1, 4]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM care_reports WHERE project_id=? AND period='2026-09'").get(PRJ).n, 1);
    // An oversized month is stored trimmed, never refused, and stays under the cap.
    const r = m.rules;
    const big = { ...fresh, monitors: Array.from({ length: 80 }, (_, i) => ({ ...fresh.monitors[0], id: `w${i}`, changes: 10, changed: Array.from({ length: 10 }, (_, k) => ({ runId: `r${i}_${k}`, at: NOW.toISOString(), pct: 5, summary: 'x'.repeat(300), areas: 1, highlight: false })), more: 0 })) };
    const fitted = r.fitSnapshot(big);
    assert.ok(JSON.stringify(big).length > r.CARE_SNAPSHOT_MAX);
    assert.ok(JSON.stringify(fitted).length <= r.CARE_SNAPSHOT_MAX);
    assert.equal(fitted.monitors.reduce((n, x) => n + x.changed.length + x.more, 0) + fitted.monitorsMore * 10, 800, 'counts stay whole');
    assert.throws(() => db.prepare("UPDATE care_reports SET snapshot=? WHERE id=?").run('x'.repeat(r.CARE_SNAPSHOT_MAX + 1), made.id), /CHECK/);
  });

  /* ------------------------------------------------------------------------ */
  /* The schedule                                                              */
  /* ------------------------------------------------------------------------ */

  await section('the schedule: once on the 1st at 09:00 local, last month, each address at most once', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    await settings(m, owner, { enabled: '1', recipients: 'Client@Acme.test, boss@acme.test', owner_copy: '1' });
    const row = db.prepare('SELECT * FROM care_report_settings WHERE project_id=?').get(PRJ);
    assert.deepEqual([row.enabled, row.timezone, row.next_run_at, JSON.parse(row.recipients)], [1, 'Europe/Sofia', '2026-11-01T07:00:00.000Z', ['client@acme.test', 'boss@acme.test']]);
    assert.deepEqual(await m.care.runCareReports(ORIGIN, new Date('2026-11-01T06:00:00Z')), { due: 0, generated: 0, attempted: 0, skipped: 0 }, '08:00 in Sofia: not yet');
    // Two sweeps at once: the slot is claimed by one write, so one report and one email per address.
    const [a, b] = await Promise.all([
      m.care.runCareReports(ORIGIN, new Date('2026-11-01T07:00:00Z')),
      m.care.runCareReports(ORIGIN, new Date('2026-11-01T07:00:00Z')),
    ]);
    assert.equal(a.generated + b.generated, 1);
    assert.equal(a.attempted + b.attempted, 2);
    const reports = db.prepare('SELECT * FROM care_reports WHERE project_id=?').all(PRJ);
    assert.deepEqual(reports.map((x) => [x.period, x.kind, x.token_hash]), [['2026-10', 'scheduled', null]], 'October, made by the schedule, with no owner link');
    assert.equal(db.prepare('SELECT next_run_at FROM care_report_settings').get().next_run_at, '2026-12-01T07:00:00.000Z');
    assert.deepEqual(fx.mails.map((x) => x.to), ['client@acme.test', 'boss@acme.test', 'owner@agency.test']);
    const [client, , copy] = fx.mails;
    assert.equal(client.subject, 'Acme Website · Website care report · October 2026');
    assert.equal(client.replyTo, 'owner@agency.test', 'replies go to the agency');
    const link = client.text.match(/https:\/\/easyscreencapture\.test\/care\/([a-f0-9]{64})/);
    assert.ok(link, 'the client’s own link');
    assert.notEqual(link[1], fx.mails[1].text.match(/\/care\/([a-f0-9]{64})/)[1], 'each recipient has their own');
    assert.match(client.text, /^North Studio — website care report for October 2026\n\nChecks run: \d+ \(5 monitored pages\)\nChanges found: 1\n/);
    assert.match(client.text, /Sent by Dana Smith \(owner@agency\.test\)\. Reply to this email to reach them\.$/, 'white-labelled: no product name');
    assert.ok(!client.text.includes('Easy Screen Capture'));
    assert.match(copy.subject, /^Your copy: Acme Website/);
    assert.match(copy.text, new RegExp(`${ORIGIN}/app/care/${reports[0].id}`), 'the owner’s copy points at the app, not a public link');
    assert.ok(!/\/care\/[a-f0-9]{64}/.test(copy.text));
    const delivered = db.prepare('SELECT email,role,status,token_hash IS NOT NULL AS live FROM care_report_deliveries ORDER BY email').all();
    assert.deepEqual(delivered.map((d) => [d.email, d.role, d.status, d.live]), [
      ['boss@acme.test', 'client', 'accepted', 1],
      ['client@acme.test', 'client', 'accepted', 1],
      ['owner@agency.test', 'owner', 'accepted', 0],
    ]);
    assert.equal(db.prepare('SELECT token_hash FROM care_report_deliveries WHERE email=?').get('client@acme.test').token_hash, sha256(link[1]));
    // The client's link opens the report, and records when it was first opened.
    const opened = await m.care.sharedCareReport(link[1], true, new Date('2026-11-02T00:00:00Z'));
    assert.equal(opened.report.id, reports[0].id);
    await m.care.sharedCareReport(link[1], true, new Date('2026-11-03T00:00:00Z'));
    assert.equal(db.prepare('SELECT opened_at FROM care_report_deliveries WHERE email=?').get('client@acme.test').opened_at, '2026-11-02T00:00:00.000Z');
    // Later in the hour, the next day, the next sweep: nothing more for October.
    fx.mails.length = 0;
    for (const at of ['2026-11-01T08:00:00Z', '2026-11-02T07:00:00Z', '2026-11-30T23:00:00Z']) await m.care.runCareReports(ORIGIN, new Date(at));
    assert.equal(fx.mails.length, 0);
    // Even a slot put back cannot make a second October report or a second email.
    db.prepare("UPDATE care_report_settings SET next_run_at='2026-11-01T07:00:00.000Z'").run();
    const again = await m.care.runCareReports(ORIGIN, new Date('2026-11-01T09:00:00Z'));
    assert.deepEqual([again.generated, again.skipped, fx.mails.length], [0, 1, 0]);
    // December's run makes November's report.
    const dec = await m.care.runCareReports(ORIGIN, new Date('2026-12-01T07:00:00Z'));
    assert.deepEqual([dec.generated, dec.attempted], [1, 2]);
    assert.deepEqual(db.prepare("SELECT period FROM care_reports WHERE kind='scheduled' ORDER BY period").all().map((x) => x.period), ['2026-10', '2026-11']);
    // Send now: only to addresses that have not had the report; each address once.
    const october = reports[0];
    await rejects(m.care.careAction(owner, { action: 'send', report_id: october.id }, ORIGIN, new Date('2026-11-05T00:00:00Z')), 409, 'already_sent');
    await settings(m, owner, { enabled: '1', recipients: 'client@acme.test\nboss@acme.test\nnew@acme.test', owner_copy: '0' });
    fx.mails.length = 0;
    const sent = await m.care.careAction(owner, { action: 'send', report_id: october.id }, ORIGIN, new Date('2026-11-05T00:00:00Z'));
    assert.deepEqual([sent.attempted, sent.already, fx.mails.map((x) => x.to)], [1, 2, ['new@acme.test']]);
    // A send whose outcome nobody saw is recorded as unknown and never sent again.
    await settings(m, owner, { enabled: '1', recipients: 'client@acme.test\nboss@acme.test\nnew@acme.test\nlate@acme.test', owner_copy: '0' });
    fx.mailMode = 'throw';
    await m.care.careAction(owner, { action: 'send', report_id: october.id }, ORIGIN, new Date('2026-11-05T00:00:00Z'));
    assert.equal(db.prepare('SELECT status FROM care_report_deliveries WHERE email=?').get('late@acme.test').status, 'unknown');
    fx.mailMode = 'ok';
    fx.mails.length = 0;
    await rejects(m.care.careAction(owner, { action: 'send', report_id: october.id }, ORIGIN, new Date('2026-11-05T00:00:00Z')), 409, 'already_sent');
    assert.equal(fx.mails.length, 0);
    // Turning the schedule off stops it; turning it on never mails on the spot.
    await settings(m, owner, { recipients: 'client@acme.test' });
    assert.equal(db.prepare('SELECT next_run_at FROM care_report_settings').get().next_run_at, null);
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2027-01-01T07:00:00Z'))).due, 0);
  });

  await section('the schedule across timezones and in bounded batches, oldest due first', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    // India is due at 03:30 UTC, so the 04:00 sweep sends it; New York, on the morning DST ends, at 14:00.
    await settings(m, owner, { enabled: '1', recipients: 'client@acme.test', timezone: 'Asia/Kolkata' });
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2026-11-01T03:00:00Z'))).generated, 0);
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2026-11-01T04:00:00Z'))).generated, 1);
    const india = db.prepare("SELECT snapshot FROM care_reports WHERE kind='scheduled'").get();
    assert.deepEqual(
      [JSON.parse(india.snapshot).period.from, JSON.parse(india.snapshot).period.to],
      ['2026-09-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z'],
      'the Indian October',
    );
    db.exec("DELETE FROM care_reports; DELETE FROM care_report_settings");
    await settings(m, owner, { enabled: '1', recipients: 'client@acme.test', timezone: 'America/New_York' });
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2026-11-01T13:00:00Z'))).generated, 0, '08:00 EST');
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2026-11-01T14:00:00Z'))).generated, 1, '09:00 EST');
    // A backlog: 25 projects due, 20 a sweep, the longest waiting first.
    db.exec('DELETE FROM care_reports; DELETE FROM care_report_settings');
    for (let i = 0; i < 25; i++) {
      addProject(db, `prj_b${String(i).padStart(2, '0')}`, 'owner', `Backlog ${i}`);
      db.prepare(
        `INSERT INTO care_report_settings(project_id,enabled,timezone,recipients,owner_copy,next_run_at,created_at,updated_at) VALUES(?,1,'UTC','["c@acme.test"]',0,?,?,?)`,
      ).run(`prj_b${String(i).padStart(2, '0')}`, iso(Date.UTC(2026, 10, 1, 9) - i * 60_000), NOW.toISOString(), NOW.toISOString());
    }
    const first = await m.care.runCareReports(ORIGIN, new Date('2026-11-01T10:00:00Z'));
    assert.deepEqual([first.due, first.generated], [20, 20]);
    const done = new Set(db.prepare('SELECT project_id FROM care_reports').all().map((x) => x.project_id));
    assert.ok(done.has('prj_b24') && !done.has('prj_b00'), 'oldest due first');
    assert.equal((await m.care.runCareReports(ORIGIN, new Date('2026-11-01T11:00:00Z'))).generated, 5, 'the next hour drains the rest');
  });

  /* ------------------------------------------------------------------------ */
  /* Gating                                                                    */
  /* ------------------------------------------------------------------------ */

  await section('gating: Plus generates and shares, Pro and Business email clients, a Pro trial counts, Free and Lite do neither', async () => {
    const db = world();
    const m = await modules();
    const { plans } = { plans: await load('src/lib/plans.ts') };
    assert.deepEqual(plans.PLAN_ORDER.map((id) => [id, plans.careReportsIncluded(id), plans.careEmailsIncluded(id)]), [
      ['free', false, false],
      ['lite', false, false],
      ['plus', true, false],
      ['pro', true, true],
      ['business', true, true],
    ]);
    assert.equal(m.care.CARE_REPORT_PLANS, 'Plus, Pro and Business');
    assert.equal(m.care.CARE_EMAIL_PLANS, 'Pro and Business');
    const user = (id) => m.auth.loadSessionUser(id);
    const generate = async (id, project) => m.care.careAction(await user(id), { action: 'generate', project_id: project, period: '2026-09' }, ORIGIN, NOW);
    for (const [id, project] of [['free', 'prj_free'], ['lite', 'prj_lite']]) {
      const error = await rejects(generate(id, project), 403, 'plan_required');
      assert.match(error.message, /Plus, Pro and Business/);
      await rejects(m.care.careAction(await user(id), { action: 'settings', project_id: project, timezone: 'UTC' }, ORIGIN, NOW), 403, 'plan_required');
    }
    // Plus: generate, share, PDF, the timezone; not the schedule, recipients or Send now.
    const plus = await user('plus');
    const made = await generate('plus', 'prj_plus');
    assert.ok(made.share_url);
    await m.care.careAction(plus, { action: 'settings', project_id: 'prj_plus', timezone: 'Europe/Paris' }, ORIGIN, NOW);
    assert.equal(db.prepare("SELECT timezone FROM care_report_settings WHERE project_id='prj_plus'").get().timezone, 'Europe/Paris');
    const emailError = await rejects(m.care.careAction(plus, { action: 'settings', project_id: 'prj_plus', timezone: 'UTC', enabled: '1', owner_copy: '1' }, ORIGIN, NOW), 403, 'plan_required');
    assert.match(emailError.message, /Pro and Business/);
    await rejects(m.care.careAction(plus, { action: 'settings', project_id: 'prj_plus', timezone: 'UTC', recipients: 'c@client.test' }, ORIGIN, NOW), 403, 'plan_required');
    await rejects(m.care.careAction(plus, { action: 'send', report_id: made.id }, ORIGIN, NOW), 403, 'plan_required');
    const pdf = await m.ownerPdf.POST({ params: { id: made.id }, locals: { user: plus }, request: new Request(`${ORIGIN}/api/care/${made.id}/pdf`, { method: 'POST' }) });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    // A Free account on a running Pro trial acts on Pro, schedule included.
    const trialist = await user('trialist');
    assert.deepEqual([trialist.plan, trialist.ownPlan], ['pro', 'free']);
    await m.care.careAction(trialist, { action: 'settings', project_id: 'prj_trial', timezone: 'UTC', enabled: '1', recipients: 'c@client.test' }, ORIGIN, NOW);
    db.prepare("UPDATE care_report_settings SET next_run_at='2026-11-01T09:00:00.000Z' WHERE project_id='prj_trial'").run();
    let run = await m.care.runCareReports(ORIGIN, new Date('2026-11-01T09:00:00Z'));
    assert.deepEqual([run.generated, run.attempted], [1, 1], 'the cron reads the plan with the trial');
    // Once the trial is over, the schedule sends nothing, and the slot still moves on.
    db.prepare("UPDATE plan_trials SET ends_at=? WHERE user_id='trialist'").run(iso(Date.now() - 60_000));
    db.prepare("UPDATE care_report_settings SET next_run_at='2026-12-01T09:00:00.000Z' WHERE project_id='prj_trial'").run();
    fx.mails.length = 0;
    run = await m.care.runCareReports(ORIGIN, new Date('2026-12-01T09:00:00Z'));
    assert.deepEqual([run.generated, run.skipped, fx.mails.length], [0, 1, 0]);
    assert.equal(db.prepare("SELECT next_run_at FROM care_report_settings WHERE project_id='prj_trial'").get().next_run_at, '2027-01-01T09:00:00.000Z');
    await rejects(m.care.careAction(await user('trialist'), { action: 'generate', project_id: 'prj_trial', period: '2026-09' }, ORIGIN, NOW), 403, 'plan_required');
    // Only confirmed owners email clients: refused when turned on, skipped by the cron.
    const unverified = await user('unverified');
    await rejects(m.care.careAction(unverified, { action: 'settings', project_id: 'prj_unver', timezone: 'UTC', enabled: '1', recipients: 'c@client.test' }, ORIGIN, NOW), 403, 'email_unverified');
    db.prepare(`INSERT INTO care_report_settings(project_id,enabled,timezone,recipients,owner_copy,next_run_at,created_at,updated_at) VALUES('prj_unver',1,'UTC','["c@client.test"]',1,'2026-11-01T09:00:00.000Z','x','x')`).run();
    fx.mails.length = 0;
    run = await m.care.runCareReports(ORIGIN, new Date('2026-11-01T09:00:00Z'));
    assert.deepEqual([run.generated, fx.mails.length], [0, 0]);
    const unverifiedReport = await m.care.careAction(unverified, { action: 'generate', project_id: 'prj_unver', period: '2026-09' }, ORIGIN, NOW);
    await rejects(m.care.careAction(unverified, { action: 'send', report_id: unverifiedReport.id }, ORIGIN, NOW), 403, 'email_unverified');
    // The project page offers the trial when it is on offer, Upgrade otherwise, and never as a second orange button.
    const page = readFileSync(join(root, 'src/pages/app/projects/[id].astro'), 'utf8');
    assert.match(page, /careTrial \? `Try Pro free for \$\{TRIAL_DAYS\} days` : 'Upgrade'/);
    assert.match(page, /trialOfferFor\(user\)/);
    const panel = page.slice(page.indexOf('id="care-heading"'), page.indexOf('<summary>Project settings</summary>'));
    assert.ok(!panel.includes('btn--lime'), 'the project page keeps "Capture pages" as its one orange action');
  });

  /* ------------------------------------------------------------------------ */
  /* Recipients                                                                */
  /* ------------------------------------------------------------------------ */

  await section('recipients: up to five client addresses, validated, lower-cased, never the owner’s own', async () => {
    const db = world();
    const m = await modules();
    const r = m.rules;
    assert.deepEqual(r.parseRecipients(' A@Client.test,b@client.test\n\nc@client.test; a@client.test ', 'owner@agency.test'), ['a@client.test', 'b@client.test', 'c@client.test']);
    assert.deepEqual(r.parseRecipients('', 'o@a.test'), []);
    for (const bad of ['not-an-email', 'a@b', 'a b@c.test', '<a@b.test>', 'a@b.test\r\nBcc: x@evil.test', `${'x'.repeat(250)}@b.test`])
      assert.throws(() => r.parseRecipients(bad, 'owner@agency.test'), (e) => e.status === 400 && e.param === 'recipients', bad);
    assert.throws(() => r.parseRecipients('1@c.test,2@c.test,3@c.test,4@c.test,5@c.test,6@c.test', 'o@a.test'), /up to 5 addresses/);
    assert.equal(r.parseRecipients('1@c.test,2@c.test,3@c.test,4@c.test,5@c.test', 'o@a.test').length, 5);
    assert.throws(() => r.parseRecipients('Owner@Agency.test', 'owner@agency.test'), /Email me a copy/);
    assert.deepEqual(r.storedRecipients('["a@b.test", 3, "nope", "c@d.test"]'), ['a@b.test', 'c@d.test']);
    assert.deepEqual(r.storedRecipients('{bad json'), []);
    const owner = await m.auth.loadSessionUser('owner');
    await rejects(settings(m, owner, { enabled: '1', recipients: '', owner_copy: '0' }), 400, 'invalid_request');
    await rejects(settings(m, owner, { timezone: 'Mars/Base' }), 400, 'invalid_request');
    await settings(m, owner, { recipients: 'X@Client.test' });
    assert.equal(db.prepare('SELECT recipients FROM care_report_settings').get().recipients, '["x@client.test"]');
  });

  /* ------------------------------------------------------------------------ */
  /* Throttles                                                                 */
  /* ------------------------------------------------------------------------ */

  await section('throttles: Send now 3 a day per project and 10 per account, generating 20 an hour, client PDFs per link and address', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    const now = new Date();
    assert.deepEqual(m.rules.CARE_LIMITS.sendProject, { limit: 3, windowSeconds: 86_400 });
    await settings(m, owner, { recipients: 'c0@client.test' });
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: m.period.monthOf('Europe/Sofia', now) }, ORIGIN, now);
    for (let i = 1; i <= 3; i++) {
      await settings(m, owner, { recipients: `c${i}@client.test` });
      assert.equal((await m.care.careAction(owner, { action: 'send', report_id: made.id }, ORIGIN, now)).attempted, 1);
    }
    await settings(m, owner, { recipients: 'c9@client.test' });
    const limited = await rejects(m.care.careAction(owner, { action: 'send', report_id: made.id }, ORIGIN, now), 429, 'rate_limited');
    assert.match(limited.message, /3 a day per project and 10 a day per account/);
    assert.ok(limited.retryAfter > 0);
    // Across projects, ten a day for the account.
    kv.clear();
    for (let i = 0; i < 11; i++) {
      const id = `prj_s${i}`;
      addProject(db, id, 'owner', `Send ${i}`);
      await m.care.careAction(owner, { action: 'settings', project_id: id, timezone: 'UTC', recipients: 'x@client.test' }, ORIGIN, now);
      const report = await m.care.careAction(owner, { action: 'generate', project_id: id, period: m.period.monthOf('UTC', now) }, ORIGIN, now);
      if (i < 10) await m.care.careAction(owner, { action: 'send', report_id: report.id }, ORIGIN, now);
      else await rejects(m.care.careAction(owner, { action: 'send', report_id: report.id }, ORIGIN, now), 429, 'rate_limited');
    }
    // Generating: twenty an hour.
    kv.clear();
    for (let i = 0; i < 20; i++) await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW);
    await rejects(m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW), 429, 'rate_limited');
    // The client's PDF: five an hour per link, ten per address.
    kv.clear();
    const link = await m.care.careAction(owner, { action: 'link', report_id: made.id }, ORIGIN, now);
    const token = tokenOf(link.share_url);
    const get = (ip) => m.publicPdf.GET({ params: { token }, request: new Request(`${ORIGIN}/care/${token}/pdf`, { headers: { 'cf-connecting-ip': ip } }) });
    for (let i = 0; i < 5; i++) assert.equal((await get(`192.0.2.${i}`)).status, 200);
    assert.equal((await get('192.0.2.9')).status, 429, 'per link');
    kv.clear();
    for (let i = 0; i < 10; i++) {
      if (i === 5) for (const key of [...kv.keys()].filter((k) => k.includes('care-pdf-link'))) kv.delete(key);
      assert.equal((await get('198.51.100.1')).status, 200);
    }
    for (const key of [...kv.keys()].filter((k) => k.includes('care-pdf-link'))) kv.delete(key);
    assert.equal((await get('198.51.100.1')).status, 429, 'per address');
    // The API's general limit: 120 updates an hour.
    kv.clear();
    const call = () =>
      m.api.POST({
        request: new Request(`${ORIGIN}/api/care`, { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams({ action: 'extend', report_id: made.id }) }),
        locals: { user: owner },
      });
    for (let i = 0; i < 120; i++) assert.equal((await call()).status, 200);
    const over = await call();
    assert.equal(over.status, 429);
    assert.deepEqual(Object.keys((await over.json()).error).sort(), ['message', 'type']);
  });

  /* ------------------------------------------------------------------------ */
  /* Links                                                                     */
  /* ------------------------------------------------------------------------ */

  await section('links: hashed, 90 days, extendable, revocable, a neutral 404 for every failure, and the access count', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    const now = new Date();
    await settings(m, owner, { recipients: 'client@acme.test' });
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: m.period.monthOf('Europe/Sofia', now) }, ORIGIN, now);
    const token = tokenOf(made.share_url);
    let row = db.prepare('SELECT * FROM care_reports WHERE id=?').get(made.id);
    assert.equal(row.token_hash, sha256(token), 'only the hash is stored');
    assert.ok(!JSON.stringify(row).includes(token));
    assert.equal(Date.parse(row.expires_at) - now.getTime(), 90 * DAY);
    // Every failure is the same 404.
    const message = (await rejects(m.care.sharedCareReport('f'.repeat(64)), 404)).message;
    for (const bad of ['', 'abc', token.toUpperCase(), token.slice(1), `${token}0`, '../'.repeat(22)])
      assert.equal((await rejects(m.care.sharedCareReport(bad), 404)).message, message, bad);
    const listed = await m.care.listCareReports(PRJ);
    assert.deepEqual(listed.map((x) => [x.id, x.kind, x.has_link, x.partial, x.sent]), [[made.id, 'manual', 1, 1, 0]]);
    // Views are counted on the report.
    await m.care.sharedCareReport(token, true);
    await m.care.sharedCareReport(token, true);
    await m.care.sharedCareReport(token, false);
    row = db.prepare('SELECT * FROM care_reports WHERE id=?').get(made.id);
    assert.equal(row.access_count, 2);
    assert.ok(row.last_access_at);
    // Expired, then extended.
    db.prepare('UPDATE care_reports SET expires_at=? WHERE id=?').run(iso(Date.now() - 1000), made.id);
    assert.equal((await rejects(m.care.sharedCareReport(token), 404)).message, message);
    await m.care.careAction(owner, { action: 'extend', report_id: made.id }, ORIGIN);
    assert.equal((await m.care.sharedCareReport(token)).report.id, made.id);
    // The client's emailed link is separate from the owner's: a new owner link leaves it working.
    const sent = await m.care.careAction(owner, { action: 'send', report_id: made.id }, ORIGIN);
    assert.equal(sent.attempted, 1);
    const clientToken = fx.mails[0].text.match(/\/care\/([a-f0-9]{64})/)[1];
    const fresh = tokenOf((await m.care.careAction(owner, { action: 'link', report_id: made.id }, ORIGIN)).share_url);
    await rejects(m.care.sharedCareReport(token), 404);
    assert.equal((await m.care.sharedCareReport(fresh)).report.id, made.id);
    assert.equal((await m.care.sharedCareReport(clientToken)).report.id, made.id, 'the client’s link survives a new owner link');
    // Revoking stops every link at once, the client's too, for good.
    await m.care.careAction(owner, { action: 'revoke', report_id: made.id }, ORIGIN);
    for (const t of [fresh, clientToken]) assert.equal((await rejects(m.care.sharedCareReport(t), 404)).message, message);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM care_report_deliveries WHERE token_hash IS NOT NULL').get().n, 0);
    await rejects(m.care.careAction(owner, { action: 'extend', report_id: made.id }, ORIGIN), 409, 'link_closed');
    await rejects(m.care.careAction(owner, { action: 'send', report_id: made.id }, ORIGIN), 409, 'link_closed');
    const revived = tokenOf((await m.care.careAction(owner, { action: 'link', report_id: made.id }, ORIGIN)).share_url);
    assert.equal((await m.care.sharedCareReport(revived)).report.id, made.id, 'a new link after revoking works');
    await rejects(m.care.sharedCareReport(clientToken), 404, 'not_found');
    // The client's PDF follows the same rules and the same 404.
    const pdf = (t) => m.publicPdf.GET({ params: { token: t }, request: new Request(`${ORIGIN}/care/${t}/pdf`) });
    assert.equal((await pdf(revived)).status, 200);
    assert.ok(!fx.pdfs.at(-1).includes(revived), 'the PDF does not carry the link');
    for (const t of [clientToken, 'nope', 'f'.repeat(64)]) {
      const response = await pdf(t);
      assert.deepEqual([response.status, await response.text()], [404, 'This report link is unavailable.']);
    }
    // Downgraded below Plus, the link still reads but the client's PDF is gone, as the owner's is.
    db.prepare("UPDATE users SET plan='free' WHERE id='owner'").run();
    assert.equal((await pdf(revived)).status, 404);
    assert.equal((await m.care.sharedCareReport(revived)).report.id, made.id);
    // Deleting the report ends it.
    db.prepare("UPDATE users SET plan='pro' WHERE id='owner'").run();
    const deleted = await m.care.careAction(owner, { action: 'delete', report_id: made.id }, ORIGIN);
    assert.equal(deleted.redirect, `/app/projects/${PRJ}/care`);
    await rejects(m.care.sharedCareReport(revived), 404);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM care_report_deliveries').get().n, 0, 'deliveries go with it');
  });

  /* ------------------------------------------------------------------------ */
  /* Ownership                                                                 */
  /* ------------------------------------------------------------------------ */

  await section('ownership: nobody reads, links, sends, exports or deletes another account’s report', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    const other = await m.auth.loadSessionUser('other');
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: '2026-09' }, ORIGIN, NOW);
    await rejects(m.care.ownCareReport('other', made.id), 404, 'not_found');
    for (const action of ['link', 'extend', 'revoke', 'send', 'delete'])
      await rejects(m.care.careAction(other, { action, report_id: made.id }, ORIGIN, NOW), 404, 'not_found');
    for (const action of ['generate', 'settings'])
      await rejects(m.care.careAction(other, { action, project_id: PRJ, period: '2026-09', timezone: 'UTC' }, ORIGIN, NOW), 404, 'not_found');
    const otherPdf = await m.ownerPdf.POST({ params: { id: made.id }, locals: { user: other }, request: new Request(`${ORIGIN}/api/care/${made.id}/pdf`, { method: 'POST' }) });
    assert.equal(otherPdf.status, 404);
    // Highlights: the owner's, for runs in the report, behind sign-in.
    const { snapshot } = await m.care.ownCareReport('owner', made.id);
    const runId = snapshot.monitors.find((x) => x.id === 'w_pricing').changed[0].runId;
    const capture = db.prepare('SELECT capture_id FROM watch_runs WHERE id=?').get(runId).capture_id;
    objects.set(`captures/owner/${capture}/changes.jpg`, new Uint8Array([255, 216, 255]));
    const highlight = (user, run) =>
      m.highlight.GET({ params: { id: made.id }, locals: { user }, url: new URL(`${ORIGIN}/api/care/${made.id}/highlight?run=${run}`) });
    let response = await highlight(owner, runId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await highlight(other, runId)).status, 404);
    assert.equal((await highlight(null, runId)).status, 401);
    assert.equal((await highlight(owner, 'wrn_999999')).status, 404, 'not a run in this report');
    objects.clear();
    assert.equal((await highlight(owner, runId)).status, 404, 'gone with the capture');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM care_reports').get().n, 1, 'nothing deleted');
    // The API: signed in, same origin, JSON errors.
    response = await m.api.POST({ request: new Request(`${ORIGIN}/api/care`, { method: 'POST', body: new URLSearchParams({ action: 'generate' }) }), locals: { user: null } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { type: 'unauthorized', message: 'Sign in first.' } });
    response = await m.api.POST({
      request: new Request(`${ORIGIN}/api/care`, { method: 'POST', headers: { origin: 'https://evil.test' }, body: new URLSearchParams({ action: 'revoke', report_id: made.id }) }),
      locals: { user: owner },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.type, 'forbidden');
    response = await m.api.POST({
      request: new Request(`${ORIGIN}/api/care`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'nonsense', report_id: made.id }) }),
      locals: { user: owner },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, 'invalid_request');
  });

  /* ------------------------------------------------------------------------ */
  /* White label                                                               */
  /* ------------------------------------------------------------------------ */

  await section('white-label: Pro and Business drop the product name from the email and the PDF; Plus keeps it', async () => {
    const db = world();
    const m = await modules();
    const branding = await load('src/lib/branding.ts');
    const project = (id) => fx.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first();
    const s = snapshotForLater;
    let b = await branding.projectBranding(await project(PRJ));
    assert.deepEqual([b.attribution, b.accent, b.footer], [false, '#1f6feb', 'North Studio · hello@north.test']);
    let html = m.pdf.careReportHtml(s, b, null);
    assert.ok(!html.includes('Easy Screen Capture'));
    assert.match(html, /border-bottom:3px solid #1f6feb/);
    assert.match(html, /North Studio · hello@north\.test/);
    // The same row on Plus: the attribution is back, as on review links.
    db.prepare(
      `INSERT INTO project_branding(project_id,logo_key,logo_type,logo_width,logo_height,accent,footer,hide_attribution,updated_at) VALUES('prj_plus','','',0,0,'','',1,'x')`,
    ).run();
    b = await branding.projectBranding(await project('prj_plus'));
    assert.equal(b.attribution, true);
    assert.match(m.pdf.careReportHtml(s, b, null), /Shared with Easy Screen Capture/);
    const email = (whiteLabel) =>
      m.rules.careEmail({ snapshot: s, link: `${ORIGIN}/care/${'a'.repeat(64)}`, expiresAt: '2027-01-06T10:00:00.000Z', sender: { name: 'Dana\nSmith', email: 'dana@agency.test' }, whiteLabel });
    assert.match(email(false).text, /Sent by Dana Smith \(dana@agency\.test\) using Easy Screen Capture\./);
    assert.ok(!email(true).text.includes('Easy Screen Capture'));
    assert.equal(email(true).subject, 'Acme Website · Website care report · September 2026');
    assert.match(email(true).text, /The link works until 6 Jan 2027\./);
    assert.ok(!/\n\s*\n\s*\n/.test(email(true).text), 'plain text, no runaway blank lines');
    // The component shows the attribution unless the project is white-labelled.
    const component = readFileSync(join(root, 'src/components/CareReport.astro'), 'utf8');
    assert.match(component, /branding\?\.attribution !== false && \(/);
  });

  /* ------------------------------------------------------------------------ */
  /* The summary                                                               */
  /* ------------------------------------------------------------------------ */

  await section('the summary: Workers AI from snapshot facts only, refused when it invents a number, plain otherwise', async () => {
    world();
    const m = await modules();
    const project = await fx.env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(PRJ).first();
    const sep = m.period.monthPeriod('Europe/Sofia', '2026-09');
    // No binding: the plain paragraph.
    let s = await m.care.buildSnapshot(project, sep, NOW);
    assert.equal(s.summary.source, 'plain');
    assert.equal(
      s.summary.text,
      'In September 2026 we ran 31 checks on 5 monitored pages and found 17 changes. Pricing changed most often, 12 times. You approved 1 review report and asked for changes on 1; 2 reports are waiting for your sign-off. There are 4 next steps below.',
    );
    const prompts = [];
    let reply = { response: 'This September we ran 31 checks on your 5 monitored pages and found 17 changes, most of them on Pricing. You approved 1 review report and 2 are waiting for your sign-off.' };
    fx.env.AI = {
      run: async (model, input) => {
        prompts.push({ model, input });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    s = await m.care.buildSnapshot(project, sep, NOW);
    assert.deepEqual([s.summary.source, s.summary.text], ['model', reply.response]);
    const prompt = JSON.stringify(prompts[0].input);
    for (const leak of ['https://', 'acme.test', 'noindex', 'Free shipping', 'Prices', 'Lee Client', 'Launch review'])
      assert.ok(!prompt.includes(leak), `the prompt carries no ${leak}`);
    assert.match(prompt, /Checks run: 31/);
    // A made-up figure, a link, markup, nothing at all, or a failure: the plain paragraph.
    for (const bad of [
      { response: 'This September we ran 33 checks on your pages and fixed 9 bugs for you, which is a great result overall.' },
      { response: 'We ran 31 checks this month. Read more at https://example.com about what we found for you here.' },
      { response: '**31 checks** were run this month on your website and nothing much happened at all, really.' },
      { response: '' },
      {},
      new Error('model unavailable'),
    ]) {
      reply = bad;
      const log = console.error;
      console.error = () => {};
      try {
        s = await m.care.buildSnapshot(project, sep, NOW);
      } finally {
        console.error = log;
      }
      assert.equal(s.summary.source, 'plain', JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(m.rules.acceptSummary('In September 2026 we ran 1,240 checks with 99.95% uptime and nothing else to report.', ['Checks run: 1240', 'Uptime: 99.95%', 'Period: September 2026']), 'In September 2026 we ran 1,240 checks with 99.95% uptime and nothing else to report.');
    delete fx.env.AI;
  });

  /* ------------------------------------------------------------------------ */
  /* Account deletion                                                          */
  /* ------------------------------------------------------------------------ */

  await section('account deletion removes the account’s reports, deliveries and settings, and nobody else’s', async () => {
    const db = world();
    const m = await modules();
    const owner = await m.auth.loadSessionUser('owner');
    const other = await m.auth.loadSessionUser('other');
    await settings(m, owner, { enabled: '1', recipients: 'client@acme.test' });
    const made = await m.care.careAction(owner, { action: 'generate', project_id: PRJ, period: m.period.monthOf('Europe/Sofia', new Date()) }, ORIGIN);
    await m.care.careAction(owner, { action: 'send', report_id: made.id }, ORIGIN);
    await m.care.careAction(other, { action: 'settings', project_id: OTHER_PRJ, timezone: 'UTC' }, ORIGIN, NOW);
    await m.care.careAction(other, { action: 'generate', project_id: OTHER_PRJ, period: '2026-09' }, ORIGIN, NOW);
    const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    assert.deepEqual(['care_reports', 'care_report_deliveries', 'care_report_settings'].map(count), [2, 1, 2]);
    // The explicit deletes run with foreign keys off too, so nothing relies on the cascade.
    db.exec('PRAGMA foreign_keys=OFF');
    await m.deletion.deleteAccount('owner');
    db.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(['care_reports', 'care_report_deliveries', 'care_report_settings'].map(count), [1, 0, 1]);
    assert.equal(db.prepare('SELECT user_id FROM care_reports').get().user_id, 'other');
    // Deleting a project takes its care rows by cascade.
    db.prepare('DELETE FROM projects WHERE id=?').run(OTHER_PRJ);
    assert.deepEqual(['care_reports', 'care_report_settings'].map(count), [0, 0]);
  });

  /* ------------------------------------------------------------------------ */
  /* The mailer                                                                */
  /* ------------------------------------------------------------------------ */

  await section('Reply-To: one plain address on both transports, anything else left out', async () => {
    world({ seed: false });
    const mailer = await load('src/lib/mailer.ts', ['/lib/mailer.ts']);
    assert.equal(mailer.replyAddress('dana@agency.test'), 'dana@agency.test');
    for (const bad of ['', 'Dana <dana@agency.test>', 'a@b.test\r\nBcc: x@evil.test', 'a@b.test, c@d.test', 'not an address', undefined])
      assert.equal(mailer.replyAddress(bad), null, String(bad));
    const sent = [];
    Object.assign(fx.env, { EMAIL_FROM: 'Easy Screen Capture <noreply@easyscreencapture.test>', EMAIL: { send: async (message) => void sent.push(message) } });
    await mailer.sendMail({ to: 'c@client.test', subject: 's', text: 't', replyTo: 'dana@agency.test' });
    await mailer.sendMail({ to: 'c@client.test', subject: 's', text: 't', replyTo: 'x@y.test\nBcc: z@evil.test' });
    await mailer.sendMail({ to: 'c@client.test', subject: 's', text: 't' });
    assert.deepEqual(sent.map((x) => x.replyTo), ['dana@agency.test', undefined, undefined]);
    assert.ok(!('replyTo' in sent[2]), 'mail without one is sent exactly as before');
    delete fx.env.EMAIL;
    fx.env.RESEND_API_KEY = 're_test';
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.resend.com/emails');
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    };
    await mailer.sendMail({ to: 'c@client.test', subject: 's', text: 't', replyTo: 'dana@agency.test' });
    await mailer.sendMail({ to: 'c@client.test', subject: 's', text: 't' });
    assert.deepEqual(bodies.map((x) => x.reply_to), ['dana@agency.test', undefined]);
    globalThis.fetch = async (input) => {
      throw new Error(`unexpected fetch to ${input}`);
    };
  });

  /* ------------------------------------------------------------------------ */
  /* Queries, files, wiring                                                    */
  /* ------------------------------------------------------------------------ */

  await section('every query the care code ran is index-backed', async () => {
    const db = database();
    const tables = /\b(care_reports|care_report_settings|care_report_deliveries|watch_runs|review_reports|report_signoffs|project_watches|watches|projects)\b/;
    const seen = new Set();
    const scans = [];
    for (const { sql, args } of recorded) {
      if (!tables.test(sql) || /sqlite_master|pragma_table_info|baseline_approvals/.test(sql) || seen.has(sql)) continue;
      // Only the care code's own statements: every one names a care table or the reads it added.
      if (!/care_|ROW_NUMBER|status!='skipped'|LEFT JOIN report_signoffs|JOIN watch_runs r|SELECT w\.id,w\.label/.test(sql)) continue;
      seen.add(sql);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail);
      for (const line of plan) if (/^SCAN /.test(line) && !/USING|^SCAN \(subquery|CONSTANT ROW/.test(line)) scans.push(`${line}  ←  ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      // A project's runs are read monitor by monitor, each a created_at range of one watch's index entries,
      // never every run the account has.
      if (/JOIN watch_runs r/.test(sql)) {
        assert.match(plan.find((line) => line.startsWith('SEARCH')), /^SEARCH pw USING COVERING INDEX sqlite_autoindex_project_watches_1 \(project_id=\?\)/, plan.join(' / '));
        assert.ok(plan.some((line) => /SEARCH r USING INDEX idx_watch_runs_(watch|user) \((user_id=\? AND )?watch_id=\? AND created_at>\? AND created_at<\?\)/.test(line)), plan.join(' / '));
      }
    }
    assert.ok(seen.size >= 20, `checked ${seen.size} statements`);
    assert.deepEqual(scans, [], 'no full table scans');
  });

  await section('the migration, console upgrade, manifest, cron wiring and design rules are in place', async () => {
    const upgrade = readFileSync(join(root, 'db/0021-upgrade.sql'), 'utf8');
    assert.ok(!upgrade.includes('--'));
    assert.match(upgrade, /INSERT OR IGNORE INTO d1_migrations \(name\) VALUES \('0021_care_reports\.sql'\);\n$/);
    const manifest = readFileSync(join(root, 'src/lib/schema-manifest.ts'), 'utf8');
    assert.match(manifest, /name: '0021_care_reports\.sql',\s*optional: true/);
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    const hourly = worker.slice(worker.indexOf('function hourly('));
    assert.match(hourly, /runCareReports\(siteOrigin\(\), now\)[\s\S]*?\.catch\(\(error\) => console\.error\('\[care\] sweep failed', error\)\)/, 'its own catch, in the hourly sweep');
    assert.ok(!worker.slice(0, worker.indexOf('function hourly(')).includes('runCareReports('), 'not on the minute trigger');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['care:check'], 'node scripts/care-report-check.mjs');
    assert.match(pkg.scripts.test, /npm run -s care:check/);
    // One orange action per view.
    const count = (file, pattern) => (readFileSync(join(root, file), 'utf8').match(pattern) ?? []).length;
    assert.equal(count('src/pages/care/[token]/index.astro', /class="rr-btn-classic"/g), 1, 'the client page');
    assert.equal(count('src/components/CareReport.astro', /btn--lime|rr-btn-classic/g), 0, 'the report adds none of its own');
    assert.equal(count('src/pages/app/care/[id].astro', /btn--lime/g), 1, 'the owner view');
    const sub = readFileSync(join(root, 'src/pages/app/projects/[id]/care.astro'), 'utf8');
    assert.equal(sub.match(/btn--lime/g).length, 3, 'one of three, by plan and trial');
    assert.match(sub, /reports \? \([\s\S]*btn btn--lime[\s\S]*\) : offerTrial \? \([\s\S]*btn btn--lime[\s\S]*\) : \([\s\S]*btn btn--lime/);
    // The client page is noindex and never cached.
    const page = readFileSync(join(root, 'src/pages/care/[token]/index.astro'), 'utf8');
    assert.match(page, /'x-robots-tag', 'noindex, nofollow, noarchive'/);
    assert.match(page, /'cache-control', 'private, no-store'/);
    assert.match(page, /name="robots" content="noindex/);
    assert.match(readFileSync(join(root, 'src/lib/attribution.ts'), 'utf8'), /\|care\|/, 'care links are never a landing');
    // Print rules exist for the client's copy.
    assert.match(readFileSync(join(root, 'src/styles/adon/ai-care.css'), 'utf8'), /@media print \{[\s\S]*\.care-actions/);
  });

  console.log(
    `\nCare report checks passed (${passed.length}): periods across month edges, DST and half-hour zones; the snapshot from monitors, ` +
      'runs, sign-offs and SEO findings; site health from a stub and hidden when empty; next steps; frozen snapshots; the schedule once ' +
      'on the 1st at 09:00 local with at-most-once deliveries; plan gating with a Pro trial; recipients; throttles; links, revocation, ' +
      'the neutral 404 and the access count; ownership; white-label; the AI fallback; account deletion; Reply-To; index-backed queries; ' +
      'and the dormant state before 0021.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__care;
  rmSync(directory, { recursive: true, force: true });
}
