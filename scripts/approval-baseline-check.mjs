/**
 * A client's approval updates the monitor baseline (lib/approval-baseline.ts).
 *
 * Approving a shared report pins the newest capture each of the owner's
 * monitors has in it; requesting changes and the owner's reset pin nothing;
 * someone else's capture or monitor is never touched; captures that cannot be
 * pinned are skipped with a reason, and the decision is recorded whatever
 * happens to the pins; a repeated approval changes nothing; the monitor page
 * names the approval only while its pin stands; without migration 0022 it
 * still pins, without 0014 it pins nothing; the owner's email lists both; the
 * shared page's line appears only when captures map to monitors; and account
 * deletion takes the new rows.
 *
 * Real SQLite with every migration (or every one but 0022, or 0014 and 0022),
 * an in-memory KV, mail captured, no renderer. The routes are the shipped
 * ones, and the three pages are rendered from their .astro sources through
 * Astro's container. No network calls.
 *
 *   node scripts/approval-baseline-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { transform } from '@astrojs/compiler-rs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'approval-baseline-check-'));
const passed = [];
const section = async (name, fn) => {
  // Each section starts with fresh throttles and mail allowances.
  kv.clear();
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Bundle                                                                      */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__approval = { env: {}, mails: [], fail: null });
const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__approval.env;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts':
    'export const canSendEmail = () => true; export async function sendMail(mail) { globalThis.__approval.mails.push(mail); return true; }',
  '/lib/renderer.ts': 'export async function render() { throw new Error("no rendering here"); }',
};
const RUNTIME = 'astro/runtime/compiler/index.js';
const plugin = {
  name: 'approval-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
    // Pages and components compiled as `astro build` compiles them; their styles and scripts are not needed here.
    b.onResolve({ filter: /\?astro&type=(style|script)/ }, () => ({ path: 'asset', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    // `?raw` imports are the file's text, as Vite serves them.
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: join(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
    b.onLoad({ filter: /\.astro$/ }, (args) => ({
      contents: transform(readFileSync(args.path, 'utf8'), {
        filename: args.path,
        internalURL: 'astro/compiler-runtime',
        resultScopedSlot: true,
      }).code,
      loader: 'ts',
      resolveDir: dirname(args.path),
    }));
    // The dev server's metadata helper is not part of the runtime; rendering needs none of it.
    b.onResolve({ filter: /^astro\/compiler-runtime$/ }, () => ({ path: 'runtime', namespace: 'astro-runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'astro-runtime' }, () => ({
      contents: `export * from ${JSON.stringify(RUNTIME)}; export const createMetadata = () => ({});`,
      resolveDir: root,
    }));
  },
};

/** Everything under test in one bundle, so routes, pages and libraries share one copy of each probe cache. */
const ENTRY = join(directory, 'entry.ts');
const src = (path) => JSON.stringify(join(root, path));
writeFileSync(
  ENTRY,
  [
    `export * as approval from ${src('src/lib/approval-baseline.ts')};`,
    `export * as signoff from ${src('src/lib/signoff.ts')};`,
    `export * as projects from ${src('src/lib/projects.ts')};`,
    `export * as watches from ${src('src/lib/watches.ts')};`,
    `export * as auth from ${src('src/lib/auth.ts')};`,
    `export * as dates from ${src('src/lib/dates.ts')};`,
    `export * as deletion from ${src('src/lib/account-deletion.ts')};`,
    `export * as watchRoute from ${src('src/pages/api/watches/[id].ts')};`,
    `export * as signoffRoute from ${src('src/pages/r/[token]/signoff.ts')};`,
    `export { default as SharedPage } from ${src('src/pages/r/[token]/index.astro')};`,
    `export { default as ReportPage } from ${src('src/pages/app/reports/[id].astro')};`,
    `export { default as MonitorPage } from ${src('src/pages/app/watches/[id].astro')};`,
  ].join('\n'),
);
let bundles = 0;
/** A fresh copy, with its own per-isolate caches, as a new isolate would have. */
async function load() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['astro', 'astro/*'],
    plugins: [plugin],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  // Written outside the project, so the one external is pointed at the installed runtime.
  writeFileSync(
    out,
    result.outputFiles[0].text.replaceAll(JSON.stringify(RUNTIME), JSON.stringify(pathToFileURL(join(root, 'node_modules/astro/dist/runtime/compiler/index.js')).href)),
  );
  return import(pathToFileURL(out).href);
}
const { experimental_AstroContainer } = await import(pathToFileURL(join(root, 'node_modules/astro/dist/container/index.js')).href);
const container = await experimental_AstroContainer.create();

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MIGRATIONS = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
const PINS = '0014_pinned_baseline.sql';
const APPROVALS = '0022_baseline_approvals.sql';
assert.ok(MIGRATIONS.includes(PINS) && MIGRATIONS.includes(APPROVALS));

/** D1 over node:sqlite: a batch is one transaction. `fx.fail` makes chosen statements throw. */
function d1(db) {
  const guard = (sql) => {
    if (fx.fail?.(sql)) throw new Error('D1_ERROR: injected failure');
  };
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
    first: async () => (guard(sql), db.prepare(sql).get(...args) ?? null),
    all: async () => (guard(sql), { results: db.prepare(sql).all(...args) }),
    run: async () => (guard(sql), { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((q) => (guard(q.sql), { meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } }));
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
const SHOTS = { list: async () => ({ objects: [], truncated: false }), delete: async () => {}, head: async () => null, get: async () => null };
const ORIGIN = 'https://easyscreencapture.test';

/** A new world: its own database, the same env object every bundle holds on to. */
function world({ without = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of MIGRATIONS) if (!without.includes(file)) db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, { DB: d1(db), RATE, SHOTS, PUBLIC_SITE_URL: ORIGIN });
  kv.clear();
  fx.mails.length = 0;
  fx.fail = null;
  const now = new Date().toISOString();
  for (const id of ['owner', 'other'])
    db.prepare(
      `INSERT INTO users (id,email,email_lower,name,plan,period_start,created_at,updated_at,email_verified_at) VALUES (?,?,?,?,'pro',?,?,?,?)`,
    ).run(id, `${id}@example.test`, `${id}@example.test`, id, now.slice(0, 10), now, now, now);
  return db;
}

/** Minutes after a fixed morning, so "newest" never depends on how fast the test runs. */
const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 9, 0) + minutes * 60_000).toISOString();
const FILES = (user, id, engine = 2) =>
  JSON.stringify([{ name: 'capture.png', key: `captures/${user}/${id}/capture.png`, width: 1440, height: 900, bytes: 10, ...(engine ? { engine } : {}) }]);

function capture(db, id, { user = 'owner', url = 'https://example.test/', device = 'desktop', source = 'watch', minute = 0, files, engine = 2 } = {}) {
  db.prepare(
    `INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,source,share_token,files,bytes,created_at,completed_at)
     VALUES (?,?,?,'example.test',?,1440,900,'fullpage','png','done',?,?,?,10,?,?)`,
  ).run(id, user, url, device, source, `tok-${id}`, files ?? FILES(user, id, engine), at(minute), at(minute));
}

/** A monitor whose checks took `shots` in order, each compared with the one before; its baseline follows the last. */
function monitor(db, id, { user = 'owner', label = '', url = 'https://example.test/', device = 'desktop', shots = [], baseline } = {}) {
  db.prepare(
    `INSERT INTO watches (id,user_id,label,url,host,device,width,height,scale,mode,format,frequency,threshold,notify_email,status,baseline_capture_id,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,'example.test',?,1440,900,1,'fullpage','png','daily',1,1,'active',?,?,?,?)`,
  ).run(id, user, label, url, device, baseline ?? shots.at(-1)?.[0] ?? null, at(10_000), at(-60), at(-60));
  shots.forEach(([captureId, minute], i) =>
    db.prepare(
      `INSERT INTO watch_runs (id,watch_id,user_id,capture_id,baseline_capture_id,status,changed,change_pct,detail,created_at)
       VALUES (?,?,?,?,?,'done',?,?,'',?)`,
    ).run(`run-${id}-${captureId}`, id, user, captureId, i ? shots[i - 1][0] : null, i ? 1 : 0, i ? 12 : null, at(minute)),
  );
}

function report(db, id, title, captureIds, { project = 'prj_1' } = {}) {
  db.prepare('INSERT INTO review_reports VALUES (?,?,?,?,?)').run(id, project, title, '', at(500));
  captureIds.forEach((captureId, position) => db.prepare('INSERT INTO report_captures VALUES (?,?,?)').run(id, captureId, position));
}

const watchRow = (db, id) => db.prepare('SELECT baseline_capture_id, baseline_pinned_at FROM watches WHERE id = ?').get(id);
const approvals = (db, where = '1') => db.prepare(`SELECT * FROM baseline_approvals WHERE ${where} ORDER BY rowid`).all();
const signoffs = (db, reportId) => db.prepare('SELECT * FROM report_signoffs WHERE report_id = ? ORDER BY rowid').all(reportId);
const NOTE = 'Approving makes these screenshots the reference that future checks compare against.';

let address = 0;
function harness(app, db) {
  const share = async (reportId, project = 'prj_1', user = 'owner') =>
    (await app.projects.projectAction(user, { action: 'share', project_id: project, report_id: reportId, days: '7' }, ORIGIN)).share_url.split('/').at(-1);
  /** The shipped route, exactly as the form posts to it. */
  const decide = async (token, body) => {
    const response = await app.signoffRoute.POST({
      params: { token },
      request: new Request(`${ORIGIN}/r/${token}/signoff`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'cf-connecting-ip': `192.0.2.${++address % 250}` },
        body: new URLSearchParams(body),
      }),
      locals: {},
    });
    assert.equal(response.status, 303, `a decision redirects back (${response.status})`);
    return response.headers.get('location');
  };
  const approve = (token, name = 'Jane Doe') => decide(token, { decision: 'approved', name, note: '' });
  const user = () => app.auth.loadSessionUser('owner');
  const api = async (id, body) => {
    const locals = { user: await user() };
    const response = body
      ? await app.watchRoute.POST({
          params: { id },
          locals,
          request: new Request(`${ORIGIN}/api/watches/${id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify(body),
          }),
        })
      : await app.watchRoute.GET({ params: { id }, locals, url: new URL(`${ORIGIN}/api/watches/${id}`) });
    return { status: response.status, json: await response.json() };
  };
  const render = async (Component, path, params, locals = {}) =>
    container.renderToString(Component, { params, request: new Request(ORIGIN + path), locals });
  const sharedPage = (token) => render(app.SharedPage, `/r/${token}`, { token });
  const reportPage = async (id) => render(app.ReportPage, `/app/reports/${id}`, { id }, { user: await user() });
  const monitorPage = async (id) => render(app.MonitorPage, `/app/watches/${id}`, { id }, { user: await user() });
  return { share, decide, approve, api, sharedPage, reportPage, monitorPage, db };
}

/** One project, two of the owner's monitors with a report over both, and someone else's monitor. */
function seed(db) {
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('prj_1', 'owner', 'Client Co', 'North Studio', at(0));
  // Homepage: three checks; the report shows the first two, the third came later.
  for (const [id, minute] of [['c1', 0], ['c2', 60], ['c3', 120]]) capture(db, id, { minute });
  monitor(db, 'wat_home', { label: 'Homepage', shots: [['c1', 0], ['c2', 60], ['c3', 120]] });
  // Pricing on a phone. The report shows its pair in the opposite order: the newer one first.
  for (const [id, minute] of [['p1', 10], ['p2', 70]]) capture(db, id, { minute, url: 'https://example.test/pricing', device: 'mobile' });
  monitor(db, 'wat_price', { label: 'Pricing\nPage', url: 'https://example.test/pricing', device: 'mobile', shots: [['p1', 10], ['p2', 70]] });
  report(db, 'rep_home', 'Homepage refresh', ['c1', 'c2', 'p2', 'p1']);
  // Someone else's monitor, whose runs (crafted) even name the owner's capture.
  capture(db, 'x1', { user: 'other', minute: 5 });
  monitor(db, 'wat_theirs', { user: 'other', label: 'Theirs', shots: [['x1', 5]] });
  db.prepare(
    `INSERT INTO watch_runs (id,watch_id,user_id,capture_id,baseline_capture_id,status,changed,created_at) VALUES ('run-x-c2','wat_theirs','other','c2','x1','done',1,?)`,
  ).run(at(61));
  // A report of plain captures, with nothing to do with monitors.
  capture(db, 'a1', { source: 'app', minute: 1 });
  capture(db, 'a2', { source: 'app', minute: 2 });
  report(db, 'rep_plain', 'Plain screenshots', ['a1', 'a2']);
}
const theirsUntouched = (db) =>
  assert.deepEqual({ ...watchRow(db, 'wat_theirs') }, { baseline_capture_id: 'x1', baseline_pinned_at: null }, "someone else's monitor is never pinned");

try {
  /* ------------------------------------------------------------------ all migrations */
  let db = world();
  seed(db);
  let app = await load();
  let h = harness(app, db);
  const token = await h.share('rep_home');
  const plain = await h.share('rep_plain');

  await section('the shared page says approving sets the reference only when its captures map to monitors', async () => {
    assert.equal(await app.approval.approvalPinsMonitors({ id: 'rep_home' }, { user_id: 'owner' }), true);
    assert.equal(await app.approval.approvalPinsMonitors({ id: 'rep_plain' }, { user_id: 'owner' }), false);
    const page = await h.sharedPage(token);
    assert.ok(page.includes('data-signoff-form'), 'the sign-off form is there');
    assert.ok(page.includes(NOTE), 'the line is beside Approve');
    assert.match(page, /value="approved"[^>]*aria-describedby="signoff-baseline-note"/, 'and describes the Approve choice');
    assert.ok(!/Homepage|Pricing|wat_/.test(page.split('id="signoff"')[1]), 'the sign-off section names no monitor');
    const other = await h.sharedPage(plain);
    assert.ok(other.includes('data-signoff-form') && !other.includes(NOTE), 'no line when nothing maps to a monitor');
    assert.ok(!other.includes('aria-describedby="signoff-baseline-note"'));
  });

  await section('requesting changes pins nothing', async () => {
    await h.decide(token, { decision: 'changes', name: 'Jane Doe', note: 'Move the logo' });
    assert.deepEqual({ ...watchRow(db, 'wat_home') }, { baseline_capture_id: 'c3', baseline_pinned_at: null });
    assert.deepEqual({ ...watchRow(db, 'wat_price') }, { baseline_capture_id: 'p2', baseline_pinned_at: null });
    assert.equal(approvals(db).length, 0);
    assert.doesNotMatch(fx.mails.at(-1).text, /baseline/i, 'and the email says nothing about baselines');
    const none = await app.approval.pinApprovedCaptures({ id: 'rep_home' }, { user_id: 'owner' }, signoffs(db, 'rep_home').at(-1));
    assert.deepEqual(none, { pinned: [], skipped: [] });
  });

  let firstApproval;
  await section('approval pins the newest capture of each monitor, and only the owner’s', async () => {
    const location = await h.approve(token);
    assert.match(location, /\?signoff=saved#signoff$/);
    firstApproval = signoffs(db, 'rep_home').at(-1);
    assert.equal(firstApproval.decision, 'approved');
    const home = watchRow(db, 'wat_home');
    assert.equal(home.baseline_capture_id, 'c2', 'the after, not the before, and not the later check the report does not show');
    assert.ok(home.baseline_pinned_at);
    const price = watchRow(db, 'wat_price');
    assert.equal(price.baseline_capture_id, 'p2', 'newest by when it was taken, even shown first');
    assert.ok(price.baseline_pinned_at);
    theirsUntouched(db);
    const rows = approvals(db);
    assert.deepEqual(
      rows.map((row) => [row.watch_id, row.capture_id, row.report_id, row.signoff_id]).sort(),
      [
        ['wat_home', 'c2', 'rep_home', firstApproval.id],
        ['wat_price', 'p2', 'rep_home', firstApproval.id],
      ],
    );
    assert.equal(rows.find((row) => row.watch_id === 'wat_home').pinned_at, home.baseline_pinned_at, 'the row carries the pin’s own time');
    const plan = await app.approval.approvalPlan({ id: 'rep_home' }, { user_id: 'owner' });
    assert.deepEqual(plan.pins.map((pin) => pin.watch.id).sort(), ['wat_home', 'wat_price'], 'someone else’s monitor is not in the plan');
  });

  await section('the owner is emailed which monitors were pinned and how to undo it', async () => {
    const mail = fx.mails.at(-1);
    assert.equal(mail.to, 'owner@example.test');
    assert.equal(mail.subject, 'Approved: “Homepage refresh”');
    assert.deepEqual(Object.keys(mail).sort(), ['subject', 'text', 'to'], 'plain text only');
    assert.match(mail.text, /now the pinned baseline of these 2 monitors, so future checks compare against them:/);
    assert.ok(mail.text.includes(`- Homepage: ${ORIGIN}/app/watches/wat_home\n`));
    assert.ok(mail.text.includes(`- Pricing Page: ${ORIGIN}/app/watches/wat_price\n`), 'a label stays on one line');
    assert.match(mail.text, /Unpin it on the monitor page/);
    assert.doesNotMatch(mail.text, /Not pinned/);
    assert.ok(mail.text.indexOf('pinned baseline') < mail.text.indexOf('/app/reports/rep_home'), 'before the link to the report');
  });

  await section('the monitor page, its API and the owner’s report page say what the approval did', async () => {
    const provenance = await app.approval.approvalProvenance(await app.watches.getWatch('wat_home'));
    assert.deepEqual(provenance, { name: 'Jane Doe', reportId: 'rep_home', reportTitle: 'Homepage refresh', approvedAt: firstApproval.created_at });
    const { status, json } = await h.api('wat_home');
    assert.equal(status, 200);
    assert.deepEqual(json.pinned_by_approval, {
      name: 'Jane Doe',
      report_id: 'rep_home',
      report_title: 'Homepage refresh',
      approved_at: firstApproval.created_at,
    });
    assert.equal(json.baseline_pinned, true);
    assert.equal(json.baseline_capture_id, 'c2');
    assert.ok(Array.isArray(json.runs) && typeof json.id === 'string', 'the rest of the monitor is as it was');
    const line = `Pinned by client approval: Jane Doe approved “Homepage refresh” on ${app.dates.formatDate(firstApproval.created_at)}`;
    const page = await h.monitorPage('wat_home');
    assert.ok(page.includes(line), 'the monitor page names the approval');
    assert.ok(page.includes('href="/app/reports/rep_home"'));
    const owner = await h.reportPage('rep_home');
    assert.ok(owner.includes('Pinned as the baseline on 2 monitors'));
    assert.ok(owner.includes('href="/app/watches/wat_home"') && owner.includes('href="/app/watches/wat_price"'), 'linking to each');
    assert.ok(!owner.includes(NOTE), 'the note has done its job once the pins are there');
    const before = await h.reportPage('rep_plain');
    assert.ok(!before.includes(NOTE) && !before.includes('Pinned as the baseline'), 'a report without monitor captures says neither');
  });

  await section('the same approval twice is harmless', async () => {
    const pinnedAt = watchRow(db, 'wat_home').baseline_pinned_at;
    await h.approve(token);
    assert.equal(watchRow(db, 'wat_home').baseline_pinned_at, pinnedAt, 'the pin, and the alerting that follows it, are not restarted');
    assert.equal(approvals(db).length, 2, 'no second provenance row');
    assert.equal((await app.approval.approvalProvenance(await app.watches.getWatch('wat_home'))).approvedAt, firstApproval.created_at, 'still the approval that pinned it');
    assert.match(fx.mails.at(-1).text, /- Homepage \(already its pinned baseline\):/);
    const again = await app.approval.pinApprovedCaptures({ id: 'rep_home' }, { user_id: 'owner' }, firstApproval);
    assert.deepEqual(again.pinned.map((pin) => [pin.watchId, pin.already]).sort(), [['wat_home', true], ['wat_price', true]]);
    assert.equal(approvals(db).length, 2);
    // A different report's approval cannot be replayed against this one.
    const crossed = await app.approval.pinApprovedCaptures({ id: 'rep_plain' }, { user_id: 'owner' }, firstApproval);
    assert.deepEqual(crossed, { pinned: [], skipped: [] });
  });

  await section('requesting changes and the owner’s reset leave an approval’s pin in place', async () => {
    const before = { home: { ...watchRow(db, 'wat_home') }, price: { ...watchRow(db, 'wat_price') } };
    await h.decide(token, { decision: 'changes', name: 'Jane Doe', note: 'One more thing' });
    await app.signoff.resetSignoff('owner', 'rep_home');
    assert.deepEqual({ home: { ...watchRow(db, 'wat_home') }, price: { ...watchRow(db, 'wat_price') } }, before);
    assert.equal(approvals(db).length, 2);
    assert.ok(await app.approval.approvalProvenance(await app.watches.getWatch('wat_home')), 'and the monitor still names it');
    const owner = await h.reportPage('rep_home');
    assert.ok(owner.includes('Pinned as the baseline on 2 monitors'), 'the owner still sees the pins it made');
  });

  await section('a later approval of another report pins again', async () => {
    capture(db, 'p3', { minute: 130, url: 'https://example.test/pricing', device: 'mobile' });
    db.prepare(
      `INSERT INTO watch_runs (id,watch_id,user_id,capture_id,baseline_capture_id,status,changed,created_at) VALUES ('run-p3','wat_price','owner','p3','p2','done',0,?)`,
    ).run(at(130));
    report(db, 'rep_price', 'Pricing update', ['p2', 'p3']);
    await h.approve(await h.share('rep_price'), 'Sam Lee');
    assert.equal(watchRow(db, 'wat_price').baseline_capture_id, 'p3');
    assert.equal(watchRow(db, 'wat_home').baseline_capture_id, 'c2', 'a monitor the report does not show is left alone');
    assert.equal((await app.approval.approvalProvenance(await app.watches.getWatch('wat_price'))).name, 'Sam Lee');
    const owner = await h.reportPage('rep_home');
    assert.match(owner, /Pinned as the baseline on 1 monitor\s*</, 'the first report now pins one');
    assert.ok(!owner.includes('href="/app/watches/wat_price"'));
    assert.match(fx.mails.at(-1).text, /now the pinned baseline of this monitor,/);
  });

  await section('a manual pin or unpin supersedes the approval’s line', async () => {
    let r = await h.api('wat_home', { action: 'pin', capture_id: 'c3' });
    assert.equal(r.status, 200);
    assert.equal(r.json.baseline_capture_id, 'c3');
    assert.equal(await app.approval.approvalProvenance(await app.watches.getWatch('wat_home')), null, 'another capture pinned by hand');
    assert.equal((await h.api('wat_home')).json.pinned_by_approval, undefined, 'the API field goes with it');
    assert.ok(!(await h.monitorPage('wat_home')).includes('Pinned by client approval'));
    // Approving again pins the approved capture again, and names the new approval.
    await h.approve(token, 'Jane Doe');
    assert.equal(watchRow(db, 'wat_home').baseline_capture_id, 'c2');
    assert.match(fx.mails.at(-1).text, /- Homepage: /);
    assert.doesNotMatch(fx.mails.at(-1).text, /- Homepage \(already/, 'pinned again, not already');
    const latest = signoffs(db, 'rep_home').at(-1);
    assert.equal((await h.api('wat_home')).json.pinned_by_approval?.approved_at, latest.created_at);
    // Unpinned, then the very same capture pinned again by hand: a new pin, not the approval's.
    r = await h.api('wat_home', { action: 'unpin' });
    assert.equal(r.json.baseline_pinned, false);
    assert.equal((await h.api('wat_home')).json.pinned_by_approval, undefined);
    r = await h.api('wat_home', { action: 'pin' });
    assert.deepEqual([r.json.baseline_capture_id, r.json.baseline_pinned], ['c2', true]);
    assert.equal(await app.approval.approvalProvenance(await app.watches.getWatch('wat_home')), null, 'same capture, but pinned by hand');
    const page = await h.monitorPage('wat_home');
    assert.ok(page.includes('[ BASELINE ]') && !page.includes('Pinned by client approval'), 'pinned, without the line');
    // The owner's page counts what is pinned to the approved capture, whoever pinned it.
    // The re-approval above pinned Pricing back to this report's capture too; the owner's page
    // counts what is pinned to the approved captures, whoever pinned them.
    assert.equal(watchRow(db, 'wat_price').baseline_capture_id, 'p2', 'the latest approval wins');
    assert.ok((await h.reportPage('rep_home')).includes('Pinned as the baseline on 2 monitors'));
  });

  await section('captures that cannot be pinned are skipped with a reason, and nothing else is pinned instead', async () => {
    // Files gone from the newest: the older one is not pinned in its place.
    capture(db, 'f1', { minute: 200, url: 'https://example.test/files' });
    capture(db, 'f2', { minute: 260, url: 'https://example.test/files', files: '[]' });
    monitor(db, 'wat_files', { label: 'Files', url: 'https://example.test/files', shots: [['f1', 200], ['f2', 260]] });
    // A phone capture from before the capture engine marked its files (engine 1).
    capture(db, 'e1', { minute: 210, device: 'mobile', url: 'https://example.test/engine', engine: 0 });
    capture(db, 'e2', { minute: 270, device: 'mobile', url: 'https://example.test/engine', engine: 0 });
    monitor(db, 'wat_engine', { label: 'Engine', device: 'mobile', url: 'https://example.test/engine', shots: [['e1', 210], ['e2', 270]] });
    report(db, 'rep_skips', 'Skips', ['f1', 'f2', 'e1', 'e2']);
    // A monitor deleted after its captures went into a report.
    capture(db, 'd1', { minute: 300, url: 'https://example.test/gone' });
    capture(db, 'd2', { minute: 360, url: 'https://example.test/gone' });
    monitor(db, 'wat_gone', { label: 'Gone', url: 'https://example.test/gone', shots: [['d1', 300], ['d2', 360]] });
    report(db, 'rep_gone', 'Gone', ['d1', 'd2']);
    await app.watches.deleteWatch('wat_gone');
    // Only the "before" is a monitor's, beside a newer screenshot taken by hand.
    capture(db, 'k1', { minute: 400, url: 'https://example.test/hand' });
    capture(db, 'k2', { minute: 460, url: 'https://example.test/hand', source: 'app' });
    monitor(db, 'wat_hand', { label: 'Hand', url: 'https://example.test/hand', shots: [['k1', 400]] });
    report(db, 'rep_hand', 'By hand', ['k1', 'k2']);
    const unchanged = ['wat_files', 'wat_engine', 'wat_hand'].map((id) => [id, { ...watchRow(db, id) }]);

    const skipsToken = await h.share('rep_skips');
    assert.ok(!(await h.sharedPage(skipsToken)).includes(NOTE), 'nothing to say when nothing would be pinned');
    await h.approve(skipsToken);
    let text = fx.mails.at(-1).text;
    assert.match(text, /No monitor baseline was pinned:\n- Files: its screenshot is no longer available\.\n- Engine: its screenshot was taken before a capture engine update/);
    await h.approve(await h.share('rep_gone'));
    text = fx.mails.at(-1).text;
    assert.match(text, /- example\.test\/gone: the monitor that took the screenshot has been deleted\.\n/);
    assert.equal(text.match(/example\.test\/gone:/g).length, 1, 'one line for the monitor, not one per capture');
    await h.approve(await h.share('rep_hand'));
    assert.match(fx.mails.at(-1).text, /- Hand: the report shows its screenshot as the “before” of a newer one/);
    for (const [id, row] of unchanged) assert.deepEqual({ ...watchRow(db, id) }, row, `${id} is unchanged`);
    for (const id of ['rep_skips', 'rep_gone', 'rep_hand']) assert.equal(signoffs(db, id).at(-1).decision, 'approved', 'every approval is recorded');
    assert.equal(approvals(db, "report_id IN ('rep_skips','rep_gone','rep_hand')").length, 0);

    const plan = await app.approval.approvalPlan({ id: 'rep_skips' }, { user_id: 'owner' });
    assert.deepEqual(plan.skipped.map((s) => [s.watchId, s.captureId, s.reason]).sort(), [
      ['wat_engine', 'e2', 'outdated'],
      ['wat_files', 'f2', 'files_gone'],
    ]);
    const owner = await h.reportPage('rep_skips');
    assert.match(owner, /Not pinned: Files, its screenshot is no longer available; Engine, its screenshot was taken before/);
  });

  await section('someone else’s capture is never pinned, even where a run names it', async () => {
    // The owner's report holds the other account's capture, and the owner's monitor's run (crafted) names it.
    monitor(db, 'wat_mixed', { label: 'Mixed', shots: [['c3', 120]] });
    db.prepare(
      `INSERT INTO watch_runs (id,watch_id,user_id,capture_id,baseline_capture_id,status,changed,created_at) VALUES ('run-mixed-x1','wat_mixed','owner','x1','c3','done',1,?)`,
    ).run(at(700));
    report(db, 'rep_mixed', 'Mixed', ['c3', 'x1']);
    await h.approve(await h.share('rep_mixed'));
    assert.deepEqual({ ...watchRow(db, 'wat_mixed') }, { baseline_capture_id: 'c3', baseline_pinned_at: null }, 'not pinned to their capture, nor to the older one');
    assert.match(fx.mails.at(-1).text, /- Mixed: its screenshot is no longer available\./);
    theirsUntouched(db);
    // The other account approves a report of its own that holds the owner's capture: their crafted run names it too.
    db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('prj_theirs', 'other', 'Theirs', '', at(0));
    report(db, 'rep_theirs', 'Theirs', ['x1', 'c2'], { project: 'prj_theirs' });
    const before = { ...watchRow(db, 'wat_home') };
    await h.approve(await h.share('rep_theirs', 'prj_theirs', 'other'), 'Somebody');
    theirsUntouched(db);
    assert.deepEqual({ ...watchRow(db, 'wat_home') }, before, 'the owner’s monitor is not theirs to pin');
    assert.ok(!(await h.sharedPage(await h.share('rep_theirs', 'prj_theirs', 'other'))).includes(NOTE));
  });

  await section('the decision is recorded whatever happens to pinning', async () => {
    // The failures below are logged, as they would be in production; collected here instead of printed.
    const logged = [];
    const error = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      await failures();
    } finally {
      console.error = error;
    }
    assert.ok(logged.some((line) => line.startsWith('[approval] could not read the report’s monitors')));
    assert.ok(logged.some((line) => line.startsWith('[approval] could not pin a baseline')));
  });
  async function failures() {
    report(db, 'rep_fail', 'Failing', ['c1', 'c2']);
    const failToken = await h.share('rep_fail');
    fx.fail = (sql) => sql.includes('UNION ALL');
    assert.match(await h.approve(failToken), /signoff=saved/);
    assert.equal(signoffs(db, 'rep_fail').at(-1).decision, 'approved');
    assert.match(fx.mails.at(-1).text, /could not be updated just now/);
    // A write that fails is one skipped monitor, and the rest carry on.
    fx.fail = (sql) => sql.startsWith('UPDATE watches SET baseline_capture_id');
    await h.approve(failToken);
    assert.match(fx.mails.at(-1).text, /- Homepage: it could not be pinned just now\./);
    fx.fail = null;
    assert.ok((await h.sharedPage(failToken)).includes('data-signoff-form'));
  }

  await section('account deletion removes the provenance rows, and only the account’s', async () => {
    // The other account's own approval pins its own monitor.
    report(db, 'rep_theirs2', 'Theirs again', ['x1'], { project: 'prj_theirs' });
    await h.approve(await h.share('rep_theirs2', 'prj_theirs', 'other'), 'Their client');
    assert.equal(watchRow(db, 'wat_theirs').baseline_capture_id, 'x1');
    assert.ok(watchRow(db, 'wat_theirs').baseline_pinned_at, 'their approval pins their monitor');
    const theirs = approvals(db, "watch_id = 'wat_theirs'").length;
    assert.equal(theirs, 1);
    // Deleting a report takes its rows with it.
    const rows = approvals(db, "report_id = 'rep_price'").length;
    assert.ok(rows > 0);
    await app.projects.projectAction('owner', { action: 'delete_report', project_id: 'prj_1', report_id: 'rep_price' }, ORIGIN);
    assert.equal(approvals(db, "report_id = 'rep_price'").length, 0);
    // deleteAccount names its tables rather than leaning on cascades, so check it with them off.
    db.exec('PRAGMA foreign_keys=OFF');
    await app.deletion.deleteAccount('owner');
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(approvals(db, "watch_id <> 'wat_theirs'").length, 0, 'every row of the account is gone');
    assert.equal(approvals(db, "watch_id = 'wat_theirs'").length, theirs, 'the other account keeps its own');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  /* ---------------------------------------------------------------- without 0022 */
  db = world({ without: [APPROVALS] });
  seed(db);
  app = await load();
  h = harness(app, db);
  await section('without migration 0022 an approval still pins, with no provenance', async () => {
    assert.equal(await app.approval.approvalsReady(), false);
    const shared = await h.share('rep_home');
    assert.ok((await h.sharedPage(shared)).includes(NOTE));
    await h.approve(shared);
    assert.equal(watchRow(db, 'wat_home').baseline_capture_id, 'c2');
    assert.ok(watchRow(db, 'wat_home').baseline_pinned_at);
    assert.equal(watchRow(db, 'wat_price').baseline_capture_id, 'p2');
    theirsUntouched(db);
    assert.equal(await app.approval.approvalProvenance(await app.watches.getWatch('wat_home')), null);
    const { json } = await h.api('wat_home');
    assert.equal(json.baseline_pinned, true);
    assert.ok(!('pinned_by_approval' in json));
    const page = await h.monitorPage('wat_home');
    assert.ok(page.includes('[ BASELINE ]') && !page.includes('Pinned by client approval'));
    assert.ok((await h.reportPage('rep_home')).includes('Pinned as the baseline on 2 monitors'));
    assert.match(fx.mails.at(-1).text, /pinned baseline of these 2 monitors/);
    await app.deletion.deleteAccount('owner');
  });

  /* ------------------------------------------------------ without 0014 and 0022 */
  db = world({ without: [PINS, APPROVALS] });
  seed(db);
  app = await load();
  h = harness(app, db);
  await section('without migration 0014 nothing is pinned, and the approval is still recorded', async () => {
    const shared = await h.share('rep_home');
    assert.ok(!(await h.sharedPage(shared)).includes(NOTE), 'no promise the deployment cannot keep');
    assert.match(await h.approve(shared), /signoff=saved/);
    assert.equal(signoffs(db, 'rep_home').at(-1).decision, 'approved');
    const baselines = db.prepare('SELECT id, baseline_capture_id FROM watches ORDER BY id').all().map((row) => [row.id, row.baseline_capture_id]);
    assert.deepEqual(baselines, [['wat_home', 'c3'], ['wat_price', 'p2'], ['wat_theirs', 'x1']], 'every baseline follows its checks as before');
    assert.match(fx.mails.at(-1).text, /- Homepage: pinning a baseline is still being set up\./);
    const { status, json } = await h.api('wat_home');
    assert.equal(status, 200);
    assert.equal(json.baseline_pinned, false);
  });

  console.log(`\nApproval baseline checks passed: ${passed.length} sections.`);
} finally {
  delete globalThis.__approval;
  rmSync(directory, { recursive: true, force: true });
}
