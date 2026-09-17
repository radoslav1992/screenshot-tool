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
for (const id of ['owner', 'other'])
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
  changedPct: 20,
};
const calls = [];
const bind = (sql, args = []) => ({
  bind: (...next) => bind(sql, next),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({meta:db.prepare(sql).run(...args)}),
});
const files = JSON.stringify([{ name: 'image.png', key: 'image.png', width: 1440, height: 900, bytes: 100 }]);
let n = 0;
const fixture = {
  env: {
    DB: { prepare: (sql) => bind(sql), batch: async (queries) => Promise.all(queries.map((query) => query.run())) },
  },
  state,
  captures: {
    getUsage: async () => ({ remaining: state.remaining }),
    createCaptureRow: async (_user, options) => {
      state.lastOptions = options;
      const id = `capture-${++n}`;
      db.prepare(
        `INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,share_token,files,created_at,duration_ms) VALUES (?,'owner','https://example.test','example.test','desktop',1440,900,'fullpage','png','done','fixture',?,?,1200)`,
      ).run(id, files, new Date().toISOString());
      return db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    },
    runCapture: async (row) => row,
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
      contents: `export function diffAvailable(){return globalThis.__monitorFixture.state.canCompare} export async function compareImages(){const s=globalThis.__monitorFixture.state;if(s.comparisonFails) throw Error('fixture');return {changedPct:s.changedPct,resized:false}}`,
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export function canSendEmail(){return globalThis.__monitorFixture.state.emailConfigured} export async function sendMail(){globalThis.__monitorFixture.state.emails++;return globalThis.__monitorFixture.state.emailAccepted}',
    }));
    b.onLoad({ filter: /\/lib\/summarise\.ts$/ }, () => ({
      contents: 'export async function summariseChange(){return {sentence:"Test change",detail:"",source:"plain"}}',
    }));
  },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return new Response('failure', { status: 500 });
};
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
  assert.equal(current.consecutive_errors, 1);
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
  db.prepare("UPDATE alert_retries SET next_attempt_at='2000-01-01'").run();
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
  outcome = await watches.runWatch(current, 'https://fixture.test');
  assert.equal(outcome.status, 'skipped');
  assert.equal((await watches.getWatch(watch.id)).baseline_capture_id, current.baseline_capture_id);
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
  console.log(
    'Monitor integration passed: baseline preservation, quota skips, webhook HTTP failure, alert persistence, schedule authorization, paused state, and account-scoped health metrics.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__monitorFixture;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
