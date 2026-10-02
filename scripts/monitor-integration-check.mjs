/** Runs the production monitoring flow against SQLite and mocked external services. No network calls. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeRunDetail } from '../src/lib/monitor-health.ts';
const db = new DatabaseSync(':memory:');
for (const file of [
  '0001_init.sql',
  '0002_verification_and_retention.sql',
  '0003_billing.sql',
  '0004_watches.sql',
  '0005_page_facts.sql',
  '0008_monitor_noise.sql',
  '0009_monitor_workflows.sql',
]) {
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
const timestamp = new Date().toISOString();
for (const id of ['owner', 'other', 'small'])
  db.prepare(
    `INSERT INTO users (id,email,email_lower,name,plan,period_start,created_at,updated_at) VALUES (?,?,?,'Pilot','pro',?,?,?)`,
  ).run(id, `${id}@example.test`, `${id}@example.test`, timestamp, timestamp, timestamp);
const state = {
  lastOptions: null,
  remaining: 2000,
  comparisonFails: false,
  canCompare: true,
  emailConfigured: true,
  emailAccepted: true,
  emails: 0,
  lastMail: null,
  changedPct: 20,
  changedPixels: 1,
  resized: false,
  sharedPct: 0,
  captureError: null,
  quotaRace: false,
  facts: null,
  crash: false,
  failBatchOn: null,
  delayMs: 0,
  inflight: 0,
  maxInflight: 0,
};
const calls = [];
const bind = (sql, args = []) => ({
  sql,
  args,
  bind: (...next) => bind(sql, next),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({meta:db.prepare(sql).run(...args)}),
});
// A D1 batch is one transaction: all of it lands, or none of it does.
const batch = async (queries) => {
  db.exec('BEGIN');
  try {
    const results = queries.map((query) => {
      if (state.failBatchOn && query.sql.includes(state.failBatchOn)) throw new Error('fixture batch failure');
      return { meta: db.prepare(query.sql).run(...query.args) };
    });
    db.exec('COMMIT');
    return results;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
const files = JSON.stringify([{ name: 'image.png', key: 'image.png', width: 1440, height: 900, bytes: 100 }]);
let n = 0;
const fixture = {
  env: {
    DB: { prepare: (sql) => bind(sql), batch },
  },
  state,
  captures: {
    getUsage: async () => ({ remaining: state.remaining }),
    createCaptureRow: async (_user, options) => {
      // Another capture took the last of the quota between the check and the render.
      if (state.quotaRace) throw Object.assign(new Error('You have used all 2000 screenshots.'), { type: 'quota_exceeded' });
      state.lastOptions = options;
      const id = `capture-${++n}`;
      db.prepare(
        `INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,share_token,files,created_at,duration_ms,facts) VALUES (?,'owner','https://example.test','example.test','desktop',1440,900,'fullpage','png','done','fixture',?,?,1200,?)`,
      ).run(id, files, new Date().toISOString(), state.facts ? JSON.stringify(state.facts) : null);
      return db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    },
    runCapture: async (row) => {
      state.inflight++;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      state.inflight--;
      return state.captureError ? { ...row, status: 'error', error: state.captureError } : row;
    },
    fileUrl: (row) => `https://fixture.test/${row.id}.png`,
    safeParseFiles: JSON.parse,
  },
};
globalThis.__monitorFixture = fixture;
const directory = mkdtempSync(join(tmpdir(), 'monitor-check-'));
const plugin = {
  name: 'external-services',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: 'export const env = globalThis.__monitorFixture.env;',
    }));
    b.onLoad({ filter: /\/lib\/captures\.ts$/ }, () => ({
      contents:
        'export const {getUsage,createCaptureRow,runCapture,fileUrl,safeParseFiles} = globalThis.__monitorFixture.captures;',
    }));
    b.onLoad({ filter: /\/lib\/visual-diff\.ts$/ }, () => ({
      contents: `export function diffAvailable(){return globalThis.__monitorFixture.state.canCompare} export async function compareImages(){const s=globalThis.__monitorFixture.state;if(s.comparisonFails) throw Error('fixture');return {changedPct:s.changedPct,changedPixels:s.changedPixels,sharedPct:s.sharedPct,resized:s.resized}}`,
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export function canSendEmail(){return globalThis.__monitorFixture.state.emailConfigured} export async function sendMail(mail){const s=globalThis.__monitorFixture.state;s.emails++;s.lastMail=mail;return s.emailAccepted}',
    }));
    // Throws synchronously when asked, standing in for an isolate lost between the commit and the send.
    b.onLoad({ filter: /\/lib\/summarise\.ts$/ }, () => ({
      contents: 'export function summariseChange(){if(globalThis.__monitorFixture.state.crash) throw Error("isolate lost");return Promise.resolve({sentence:"Test change",detail:"",source:"plain"})}',
    }));
  },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return new Response('failure', { status: 500 });
};
const HOUR = 3_600_000;
const tickOf = (iso) => Math.floor(Date.parse(iso) / HOUR) * HOUR;
try {
  const output = join(directory, 'watches.mjs');
  await build({
    entryPoints: [new URL('../src/lib/watches.ts', import.meta.url).pathname],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [plugin],
  });
  const watches = await import(pathToFileURL(output));
  const user = { id: 'owner', plan: 'pro' };
  const options = {
    url: 'https://example.test',
    host: 'example.test',
    device: 'desktop',
    width: 1440,
    height: 900,
    scale: 1,
    mode: 'fullpage',
    format: 'png',
    hide: ['.live-clock'],
    ignoreRegions: [{ x: 0, y: 0, width: 100, height: 50 }],
  };
  const watch = await watches.createWatch(user, {
    options,
    label: 'Fixture',
    frequency: 'daily',
    threshold: 1,
    notifyEmail: true,
    webhookUrl: 'https://hooks.example.test/fixture',
  });
  let outcome = await watches.runWatch(watch, 'https://fixture.test');
  assert.equal(outcome.status, 'done');
  assert.deepEqual(state.lastOptions.hide, ['.live-clock']);
  assert.deepEqual(state.lastOptions.ignoreRegions, [{ x: 0, y: 0, width: 100, height: 50 }]);
  let current = await watches.getWatch(watch.id);
  const baseline = current.baseline_capture_id;
  state.comparisonFails = true;
  outcome = await watches.runWatch(current, 'https://fixture.test');
  assert.equal(outcome.status, 'error');
  current = await watches.getWatch(watch.id);
  assert.equal(current.baseline_capture_id, baseline, 'comparison failure must retain last good baseline');
  assert.equal(current.consecutive_errors, 0, 'a failing comparison browser does not count toward the auto-pause');
  assert.match(current.last_error, /^Temporarily unavailable: /);
  state.comparisonFails = false;
  outcome = await watches.runWatch(current, 'https://fixture.test');
  assert.equal(outcome.changed, true);
  current = await watches.getWatch(watch.id);
  assert.notEqual(current.baseline_capture_id, baseline);
  const changed = db
    .prepare('SELECT detail FROM watch_runs WHERE watch_id = ? AND changed = 1 ORDER BY created_at DESC LIMIT 1')
    .get(watch.id);
  assert.deepEqual(
    decodeRunDetail(changed.detail).delivery,
    { email: 'accepted', webhook: 'failed' },
    'non-2xx webhook is a failed alert',
  );
  const pendingJob = db.prepare("SELECT * FROM alert_retries WHERE status='pending' LIMIT 1").get();
  assert.ok(pendingJob, 'explicit webhook failure queues a durable retry');
  assert.equal(pendingJob.attempts, 1, 'the first delivery counts as an attempt');
  assert.equal(Date.parse(pendingJob.next_attempt_at) % HOUR, 0, 'retries are due on the hour the sweep runs');
  db.prepare("UPDATE alert_retries SET next_attempt_at='2000-01-01' WHERE status='pending'").run();
  const callsBeforeRetry = calls.length;
  const emailsBeforeRetry = state.emails;
  await watches.retryAlerts('https://fixture.test');
  assert.equal(calls.length,callsBeforeRetry+1,'failed webhook retried');
  assert.equal(state.emails,emailsBeforeRetry,'accepted email is never resent with webhook retry');
  assert.equal(db.prepare('SELECT attempts FROM alert_retries WHERE run_id=?').get(pendingJob.run_id).attempts,2);
  db.prepare("UPDATE alert_retries SET next_attempt_at='2000-01-01' WHERE status='pending'").run();
  await watches.retryAlerts('https://fixture.test');
  assert.equal(db.prepare('SELECT status FROM alert_retries WHERE run_id=?').get(pendingJob.run_id).status,'done','retry budget is bounded');

  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
  state.remaining = 0;
  const beforeQuota = state.emails;
  outcome = await watches.runWatch(current, 'https://fixture.test');
  assert.equal(outcome.status, 'skipped');
  assert.equal((await watches.getWatch(watch.id)).baseline_capture_id, current.baseline_capture_id);
  assert.equal(state.emails, beforeQuota + 1, 'the first quota skip of the month tells the owner');
  assert.match(state.lastMail.subject, /allowance used up/);
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(state.emails, beforeQuota + 1, 'later quota skips do not repeat the notice');
  await watches.setWatchFrequency(current, user, 'weekly');
  assert.equal((await watches.getWatch(watch.id)).frequency, 'weekly');
  await assert.rejects(() => watches.setWatchFrequency(current, { id: 'other', plan: 'pro' }, 'daily'));
  await assert.rejects(() => watches.setWatchFrequency(current, { id: 'owner', plan: 'plus' }, 'hourly'));
  await watches.setWatchStatus(watch.id, 'paused');
  await watches.setWatchFrequency(await watches.getWatch(watch.id), user, 'daily');
  assert.equal((await watches.getWatch(watch.id)).status, 'paused', 'schedule changes must not resume a paused watch');
  const dashOutput = join(directory, 'dashboard.mjs');
  await build({
    entryPoints: [new URL('../src/lib/monitor-dashboard.ts', import.meta.url).pathname],
    outfile: dashOutput,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [plugin],
  });
  const { monitorDashboard } = await import(pathToFileURL(dashOutput));
  const dashboard = await monitorDashboard('owner');
  assert.equal(dashboard.stats.succeeded, 3);
  assert.equal(dashboard.stats.average_ms, 1200);
  assert.ok(dashboard.successes.has(watch.id));
  assert.equal(
    dashboard.alerts.get(watch.id).delivery.webhook,
    'failed',
    'last alert remains visible after skipped checks',
  );
  const other = await monitorDashboard('other');
  assert.equal(other.stats.total, 0);
  assert.equal(other.latest.size, 0);
  assert.equal(other.alerts.size, 0);

  // Sensitivity edits preserve state and affect only future comparisons.
  current = await watches.getWatch(watch.id);
  const beforeEdit = { baseline: current.baseline_capture_id, next: current.next_run_at, status: current.status };
  await watches.setWatchThreshold(current, user, '0.1');
  current = await watches.getWatch(watch.id);
  assert.equal(current.threshold, 0.1);
  assert.deepEqual({ baseline: current.baseline_capture_id, next: current.next_run_at, status: current.status }, beforeEdit);
  for (const invalid of ['', ' ', 'NaN', 'Infinity', '-1', '0.09', '100.01', 'oops']) {
    await assert.rejects(() => watches.setWatchThreshold(current, user, invalid));
  }
  await assert.rejects(() => watches.setWatchThreshold(current, { id: 'other', plan: 'pro' }, '5'));
  assert.equal((await watches.getWatch(watch.id)).threshold, 0.1);
  await watches.setWatchThreshold(current, user, '100');
  assert.equal((await watches.getWatch(watch.id)).threshold, 100);
  await watches.setWatchThreshold(current, user, '0.1');
  await watches.setWatchStatus(watch.id, 'active');
  state.remaining = 2000;
  state.changedPct = 0.09;
  current = await watches.getWatch(watch.id);
  const emailCount = state.emails;
  outcome = await watches.runWatch(current, 'https://fixture.test');
  assert.equal(outcome.changed, false, 'below threshold must not alert');
  assert.equal(state.emails, emailCount);
  assert.match(outcome.detail, /Below the 0.1% threshold/);
  state.changedPct = 0.1;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, true, 'exactly at threshold must alert');
  assert.equal(state.emails, emailCount + 1);
  assert.match(outcome.detail, /Met the 0.1% threshold/);
  await watches.setWatchThreshold(await watches.getWatch(watch.id), user, '5');
  const recorded = await watches.listRuns(watch.id);
  assert.ok(recorded.some(run => run.detail?.includes('Met the 0.1% threshold')), 'history retains the threshold used at the time');
  state.changedPct = 5.01;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, true, 'above threshold must alert');

  // Exercise the same endpoint used by web FormData and native JSON clients.
  const routeOutput = join(directory, 'watch-route.mjs');
  await build({ entryPoints: [new URL('../src/pages/api/watches/[id].ts', import.meta.url).pathname],
    outfile: routeOutput, bundle: true, platform: 'node', format: 'esm', plugins: [plugin] });
  const route = await import(pathToFileURL(routeOutput));
  const post = (id, caller, body) =>
    route.POST({
      request: new Request('https://fixture.test/api/watches/' + id, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      params: { id },
      locals: { user: caller },
    });
  const update = async (caller, threshold, origin = 'https://fixture.test', form = false) => {
    const data = new FormData(); data.set('action', 'threshold'); data.set('threshold', threshold);
    const request = new Request('https://fixture.test/api/watches/' + watch.id, {
      method: 'POST', headers: form ? { origin } : { origin, 'content-type': 'application/json' },
      body: form ? data : JSON.stringify({ action: 'threshold', threshold }),
    });
    return route.POST({ request, params: { id: watch.id }, locals: { user: caller } });
  };
  assert.equal((await update(null, '1')).status, 401);
  assert.equal((await update({ id: 'other', plan: 'pro' }, '1')).status, 404);
  assert.equal((await update(user, '1', 'https://untrusted.test')).status, 403);
  assert.equal((await update(user, '0.01')).status, 400);
  let response = await update(user, '0.1');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).threshold, 0.1);
  response = await update(user, '2.5', 'https://fixture.test', true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).threshold, 2.5);

  response = await update(user, '0');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).threshold, 0);
  state.changedPct = 0;
  state.changedPixels = 0;
  const beforeAny = state.emails;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, false, 'identical images never alert with zero threshold');
  assert.equal(state.emails, beforeAny);
  state.changedPixels = 1;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, true, 'one detected pixel alerts even if percentage rounds to zero');
  assert.match(outcome.detail, /<0.01% changed/);
  assert.equal(state.emails, beforeAny + 1);
  state.changedPct = 0.05;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, true, 'the observed 0.05% change alerts');
  await update(user, '0.1');
  state.changedPct = 0;
  outcome = await watches.runWatch(await watches.getWatch(watch.id), 'https://fixture.test');
  assert.equal(outcome.changed, false, 'normal percentage thresholds retain their existing behavior');

  // Schedules land on the hour, so the hh:00 sweep that selects next_run_at <= hh:00 picks them up.
  assert.equal(watches.nextRunAt('hourly', new Date('2026-10-02T10:00:37.123Z')), '2026-10-02T11:00:00.000Z');
  assert.equal(watches.nextRunAt('daily', new Date('2026-10-02T10:03:00Z')), '2026-10-03T10:00:00.000Z', 'daily is due at the same tick tomorrow, not an hour later');
  assert.equal(watches.nextRunAt('weekly', new Date('2026-10-02T23:59:59Z')), '2026-10-09T23:00:00.000Z');
  current = await watches.getWatch(watch.id);
  assert.equal(Date.parse(current.next_run_at), tickOf(current.last_run_at) + 24 * HOUR, 'a finished check schedules the next one on the hour');

  // The sweep claims each due watch once, a few at a time, and skips paused ones.
  db.prepare("UPDATE watches SET next_run_at='2099-01-01T00:00:00.000Z'").run();
  const tick = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const plain = { ...options, hide: [], ignoreRegions: [] };
  const swept = [];
  for (let i = 0; i < 6; i++) {
    swept.push(await watches.createWatch(user, {
      options: { ...plain, url: `https://example.test/${i}` },
      label: `Swept ${i}`, frequency: 'daily', threshold: 1, notifyEmail: true, webhookUrl: null,
    }));
  }
  const due = (rows, at) => rows.forEach((row) => db.prepare('UPDATE watches SET next_run_at=? WHERE id=?').run(at, row.id));
  due(swept, new Date(tick.getTime() - HOUR).toISOString());
  due([swept[0]], tick.toISOString());
  await watches.setWatchStatus(swept[5].id, 'paused');
  due([swept[5]], new Date(tick.getTime() - HOUR).toISOString());
  state.delayMs = 5;
  const capturesBefore = n;
  let sweep = await watches.runDueWatches('https://fixture.test', tick);
  assert.equal(sweep.ran, 5, 'every active due watch runs, including one due exactly at the tick');
  assert.equal(n - capturesBefore, 5, 'the paused watch does not run');
  assert.ok(state.maxInflight > 1 && state.maxInflight <= 3, `runs overlap but stay bounded (saw ${state.maxInflight})`);
  assert.equal(sweep.backlog, 0);
  assert.ok(sweep.maxLateMs >= HOUR, 'lateness is measured from the time each watch was due');
  for (const row of swept.slice(0, 5)) {
    const fresh = await watches.getWatch(row.id);
    assert.equal(Date.parse(fresh.next_run_at), tickOf(fresh.last_run_at) + 24 * HOUR);
  }
  assert.equal((await watches.getWatch(swept[5].id)).last_run_at, null);
  // Two overlapping sweeps of the same tick still run each watch once.
  due(swept.slice(0, 5), new Date(tick.getTime() - HOUR).toISOString());
  const capturesBeforeOverlap = n;
  const [first, second] = await Promise.all([
    watches.runDueWatches('https://fixture.test', tick),
    watches.runDueWatches('https://fixture.test', tick),
  ]);
  assert.equal(first.ran + second.ran, 5, 'claims stop an overlapping sweep repeating a watch');
  assert.equal(n - capturesBeforeOverlap, 5);
  state.delayMs = 0;

  // "Check now" is claimed too: a double click runs once, and a held watch is refused.
  const busy = swept[0];
  const clicks = await Promise.allSettled([
    watches.runWatchNow(await watches.getWatch(busy.id), 'https://fixture.test'),
    watches.runWatchNow(await watches.getWatch(busy.id), 'https://fixture.test'),
  ]);
  assert.equal(clicks.filter((click) => click.status === 'fulfilled').length, 1);
  assert.equal(clicks.find((click) => click.status === 'rejected').reason.type, 'check_in_progress');
  const heldAt = new Date();
  db.prepare('UPDATE watches SET updated_at=?, next_run_at=? WHERE id=?')
    .run(heldAt.toISOString(), new Date(heldAt.getTime() + 20 * 60_000).toISOString(), busy.id);
  response = await post(busy.id, user, { action: 'run' });
  assert.equal(response.status, 409, 'a watch held by the sweep cannot be checked again at the same time');
  assert.equal((await response.json()).error.type, 'check_in_progress');
  await watches.setWatchFrequency(await watches.getWatch(busy.id), user, 'daily');

  // A failure never writes back the status the run started with.
  const stale = await watches.getWatch(busy.id);
  await watches.setWatchStatus(busy.id, 'paused');
  db.prepare('UPDATE watches SET consecutive_errors=4 WHERE id=?').run(busy.id);
  state.captureError = 'The page could not be loaded (net::ERR_CONNECTION_REFUSED).';
  const mailsBefore = state.emails;
  outcome = await watches.runWatch(stale, 'https://fixture.test');
  assert.equal(outcome.status, 'error');
  let row = await watches.getWatch(busy.id);
  assert.equal(row.status, 'paused', 'a pause made during the check survives its failure');
  assert.equal(row.consecutive_errors, 5);
  assert.equal(state.emails, mailsBefore, 'no auto-pause notice for a watch its owner paused');
  await watches.setWatchStatus(busy.id, 'active');
  db.prepare('UPDATE watches SET consecutive_errors=4 WHERE id=?').run(busy.id);
  outcome = await watches.runWatch(await watches.getWatch(busy.id), 'https://fixture.test');
  row = await watches.getWatch(busy.id);
  assert.equal(row.status, 'paused', 'the fifth failure in a row pauses the watch');
  assert.equal(state.emails, mailsBefore + 1, 'the owner is told once, when it pauses');
  assert.match(state.lastMail.subject, /^Monitor paused: /);
  outcome = await watches.runWatch(row, 'https://fixture.test');
  assert.equal(state.emails, mailsBefore + 1, 'a later failure of the paused watch sends nothing');

  // Failures of the service back off and never count toward the auto-pause.
  await watches.setWatchStatus(busy.id, 'active');
  state.captureError = 'All 2 browser sessions are in use (2 active). Retry shortly, or raise the concurrency limit on your Cloudflare account.';
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    outcome = await watches.runWatch(await watches.getWatch(busy.id), 'https://fixture.test');
    row = await watches.getWatch(busy.id);
    gaps.push((Date.parse(row.next_run_at) - tickOf(row.last_run_at)) / HOUR);
  }
  assert.deepEqual(gaps, [1, 2, 4, 8, 16, 24], 'backoff doubles from the next hour up to the watch schedule');
  assert.equal(row.status, 'active');
  assert.equal(row.consecutive_errors, 0);
  assert.match(row.last_error, /^Temporarily unavailable: All 2 browser sessions/);
  state.captureError = null;
  state.quotaRace = true;
  outcome = await watches.runWatch(await watches.getWatch(busy.id), 'https://fixture.test');
  assert.equal(outcome.detail, 'monthly quota used up', 'a quota race is a skip, not a failure');
  assert.equal((await watches.getWatch(busy.id)).consecutive_errors, 0);
  state.quotaRace = false;
  state.canCompare = false;
  const capturesBeforeNoBrowser = n;
  outcome = await watches.runWatch(await watches.getWatch(busy.id), 'https://fixture.test');
  assert.equal(outcome.status, 'error');
  assert.equal(n, capturesBeforeNoBrowser, 'no screenshot is spent when nothing can compare it');
  assert.equal((await watches.getWatch(busy.id)).consecutive_errors, 0);
  state.canCompare = true;

  // A quota skip retries within a day, not a week later.
  const weekly = swept[3];
  await watches.setWatchFrequency(await watches.getWatch(weekly.id), user, 'weekly');
  state.remaining = 0;
  const mailsBeforeWeekly = state.emails;
  outcome = await watches.runWatch(await watches.getWatch(weekly.id), 'https://fixture.test');
  row = await watches.getWatch(weekly.id);
  const wait = (Date.parse(row.next_run_at) - tickOf(row.last_run_at)) / HOUR;
  assert.ok(wait >= 1 && wait <= 24, `a skipped weekly watch tries again within a day (waits ${wait}h)`);
  assert.equal(state.emails, mailsBeforeWeekly, 'one quota notice per account per month');
  state.remaining = 2000;

  // The run, the moved baseline and the queued alert commit together or not at all.
  const batched = swept[1];
  const baselineBefore = (await watches.getWatch(batched.id)).baseline_capture_id;
  const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM watch_runs WHERE watch_id=?').get(batched.id).n;
  state.changedPct = 20;
  state.changedPixels = 1;
  state.failBatchOn = 'INSERT INTO alert_retries';
  await assert.rejects(async () => watches.runWatch(await watches.getWatch(batched.id), 'https://fixture.test'));
  assert.equal((await watches.getWatch(batched.id)).baseline_capture_id, baselineBefore, 'a failed commit leaves the baseline where it was');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watch_runs WHERE watch_id=?').get(batched.id).n, runsBefore);
  state.failBatchOn = null;
  // Lost after the commit and before the send: the alert is still queued, and goes out next hour.
  state.crash = true;
  const mailsBeforeCrash = state.emails;
  await assert.rejects(async () => watches.runWatch(await watches.getWatch(batched.id), 'https://fixture.test'));
  state.crash = false;
  const queued = db.prepare(
    'SELECT r.id, r.changed, a.status, a.attempts FROM watch_runs r JOIN alert_retries a ON a.run_id = r.id WHERE r.watch_id = ? ORDER BY r.created_at DESC LIMIT 1',
  ).get(batched.id);
  assert.equal(queued.changed, 1);
  assert.deepEqual([queued.status, queued.attempts], ['pending', 0], 'an alert lost before sending stays queued');
  assert.notEqual((await watches.getWatch(batched.id)).baseline_capture_id, baselineBefore);
  assert.equal(state.emails, mailsBeforeCrash);
  db.prepare("UPDATE alert_retries SET next_attempt_at='2000-01-01' WHERE run_id=?").run(queued.id);
  await watches.retryAlerts('https://fixture.test');
  assert.equal(state.emails, mailsBeforeCrash + 1, 'the retry sweep delivers it');
  assert.equal(decodeRunDetail(db.prepare('SELECT detail FROM watch_runs WHERE id=?').get(queued.id).detail).delivery.email, 'accepted');

  // A resize is weighed by the threshold, except under "Any detected change".
  const tall = swept[2];
  await watches.setWatchThreshold(await watches.getWatch(tall.id), user, '5');
  Object.assign(state, { resized: true, changedPct: 2, sharedPct: 0, changedPixels: 10 });
  outcome = await watches.runWatch(await watches.getWatch(tall.id), 'https://fixture.test');
  assert.equal(outcome.changed, false, 'a page that grew by 2% is below a 5% threshold');
  assert.match(outcome.detail, /Page dimensions changed .*Below the 5% threshold/);
  await watches.setWatchThreshold(await watches.getWatch(tall.id), user, '0');
  Object.assign(state, { changedPct: 0, changedPixels: 0 });
  outcome = await watches.runWatch(await watches.getWatch(tall.id), 'https://fixture.test');
  assert.equal(outcome.changed, true, 'with Any detected change a resize still alerts');
  Object.assign(state, { resized: false, changedPct: 20, changedPixels: 1 });

  // Rule alerts lead with what the rule found, in email and in the webhook payload.
  const stock = await watches.createWatch(user, {
    options: { ...plain, url: 'https://example.test/stock' },
    rule: { kind: 'appeared', phrase: 'In stock', selector: '', region: '' },
    label: 'Stock', frequency: 'daily', threshold: 1, notifyEmail: true, webhookUrl: 'https://hooks.example.test/rule',
  });
  state.facts = { text: 'Sold out', text_length: 8, text_hash: 'aa' };
  await watches.runWatch(stock, 'https://fixture.test');
  state.facts = { text: 'In stock now', text_length: 12, text_hash: 'bb' };
  outcome = await watches.runWatch(await watches.getWatch(stock.id), 'https://fixture.test');
  assert.equal(outcome.detail, '“In stock” appeared on the page.');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).rule, { kind: 'appeared', detail: '“In stock” appeared on the page.' });
  assert.match(state.lastMail.subject, /^Stock: “In stock” appeared/);
  assert.doesNotMatch(state.lastMail.text, /of the picture changed/);
  state.facts = null;

  // A downgrade keeps the oldest watches up to the plan running and pauses the rest.
  const small = { id: 'small', plan: 'pro' };
  const fleet = [];
  for (let i = 0; i < 6; i++) {
    const created = await watches.createWatch(small, {
      options: { ...plain, url: `https://example.test/small/${i}` },
      label: `Small ${i}`, frequency: 'daily', threshold: 1, notifyEmail: false, webhookUrl: null,
    });
    db.prepare('UPDATE watches SET created_at=? WHERE id=?').run(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), created.id);
    fleet.push(created.id);
  }
  db.prepare("UPDATE users SET plan='plus' WHERE id='small'").run();
  outcome = await watches.runWatch(await watches.getWatch(fleet[5]), 'https://fixture.test');
  assert.equal(outcome.status, 'skipped');
  row = await watches.getWatch(fleet[5]);
  assert.equal(row.status, 'paused', 'the newest watch beyond the plan pauses');
  assert.equal(row.last_error, 'Paused: your plan includes 5 monitors.');
  outcome = await watches.runWatch(await watches.getWatch(fleet[0]), 'https://fixture.test');
  assert.equal(outcome.status, 'done', 'the oldest keep running');
  response = await post(fleet[5], { id: 'small', plan: 'plus' }, { action: 'resume' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.type, 'watch_limit', 'resuming past the plan is refused with the type the app expects');

  // Alert channels can be edited, with the same URL checks as creation.
  const alerts = (body) => post(watch.id, user, { action: 'alerts', ...body });
  assert.equal((await alerts({ webhook_url: 'http://hooks.example.test/x' })).status, 400);
  assert.equal((await alerts({ webhook_url: 'https://127.0.0.1/x' })).status, 400, 'private addresses are refused');
  assert.equal((await post(watch.id, { id: 'other', plan: 'pro' }, { action: 'alerts', webhook_url: '' })).status, 404);
  response = await alerts({ webhook_url: 'https://hooks.slack.com/services/T/B/x', notify_email: '0' });
  assert.equal(response.status, 200);
  let dto = await response.json();
  assert.deepEqual([dto.webhook_url, dto.notify_email], ['https://hooks.slack.com/services/T/B/x', false]);
  dto = await (await alerts({ webhook_url: '' })).json();
  assert.deepEqual([dto.webhook_url, dto.notify_email], [null, false], 'fields left out stay as they were');
  dto = await (await alerts({ notify_email: '1' })).json();
  assert.equal(dto.notify_email, true);

  console.log(
    'Monitor integration passed: baseline preservation, quota skips and notices, webhook HTTP failure, alert persistence, schedule authorization, paused state, account-scoped health metrics, threshold boundaries, historical sensitivity, web/native threshold updates, hour-aligned schedules, claimed and bounded sweeps, Check now conflicts, stale status, auto-pause notices, service-failure backoff, quota races, atomic run commits, crash-safe alerts, resize thresholds, rule alert headlines, plan downgrades and alert channel edits.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__monitorFixture;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
