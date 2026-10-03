/**
 * Client sign-off on shared reports: token validation and expiry, per-address
 * and per-link rate limits, length limits, supersede and reset, the per-report
 * cap, notification email escaping, the page's fixed status messages and the
 * no-migration fallback. Real SQLite; KV and mail are mocked. No network calls.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEW = '0015_report_signoff_branding.sql';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const apply = (f) => db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
for (const f of readdirSync(new URL('../migrations/', import.meta.url))
  .filter((f) => f.endsWith('.sql') && f !== NEW)
  .sort())
  apply(f);
const now = new Date().toISOString();
for (const id of ['owner', 'other'])
  db.prepare(
    `INSERT INTO users(id,email,email_lower,plan,period_start,created_at,updated_at,email_verified_at) VALUES(?,?,?,'free',?,?,?,?)`,
  ).run(id, `${id}@example.test`, `${id}@example.test`, now, now, now, now);
const PROJECT = 'prj_signoff0001';
db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(PROJECT, 'owner', 'Client\nCo', 'North Studio', now);
for (const id of ['rep_1', 'rep_2'])
  db.prepare('INSERT INTO review_reports VALUES(?,?,?,?,?)').run(id, PROJECT, 'Launch\r\nreview', '', now);

const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});
const rate = new Map();
const mails = [];
globalThis.__signoff = {
  mails,
  env: {
    DB: { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((q) => q.run())) },
    SHOTS: { list: async () => ({ objects: [], truncated: false }), delete: async () => {} },
    RATE: {
      get: async (key) => rate.get(key) ?? null,
      put: async (key, value) => {
        rate.set(key, value);
      },
    },
  },
};
const directory = mkdtempSync(join(tmpdir(), 'signoff-check-'));
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const env=globalThis.__signoff.env;' }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export const canSendEmail=()=>true;export async function sendMail(mail){globalThis.__signoff.mails.push(mail);return true;}',
    }));
  },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw Error('Unexpected network request');
};
try {
  for (const name of ['signoff', 'projects'])
    await build({
      entryPoints: [new URL(`../src/lib/${name}.ts`, import.meta.url).pathname],
      outfile: join(directory, name + '.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [plugin],
      logLevel: 'error',
    });
  // A query string gives a fresh module, and so a fresh per-isolate schema cache.
  const load = (name, fresh = '') => import(pathToFileURL(join(directory, name + '.mjs')).href + fresh);
  const origin = 'https://fixture.test';
  const p = await load('projects');
  const share = async (report = 'rep_1') =>
    (await p.projectAction('owner', { action: 'share', project_id: PROJECT, report_id: report, days: '7' }, origin)).share_url
      .split('/')
      .at(-1);
  let token = await share();
  let address = 0;
  const ip = () => `192.0.2.${++address}`;
  const approve = (name = 'Dana Smith', at = ip(), t = token) => s.submitSignoff(t, { decision: 'approved', name, note: '' }, at);
  const fails = (body, type, at = ip(), t = token) =>
    assert.rejects(
      () => s.submitSignoff(t, body, at),
      (e) => e.type === type,
      `${JSON.stringify(body).slice(0, 60)} should fail with ${type}`,
    );

  /* ---- No migration: the share link works as before and sign-off is absent. ---- */
  let s = await load('signoff');
  assert.equal(await s.signoffsReady(), false);
  await assert.rejects(() => approve(), (e) => e.status === 404);
  await assert.rejects(() => s.resetSignoff('owner', 'rep_1'), (e) => e.status === 503);
  assert.equal(rate.size, 0, 'nothing is throttled, or counted, for a feature that is not there');
  assert.equal((await p.sharedReport(token)).report.id, 'rep_1', 'the share link still opens');

  apply(NEW);
  s = await load('signoff', '?migrated');
  assert.equal(await s.signoffsReady(), true);

  /* ---- Token validation, exactly as the share page: format, hash, expiry, revocation. ---- */
  for (const bad of ['', 'abc', token.toUpperCase(), token.slice(1), `${token}0`, '../'.repeat(22)])
    await fails({ decision: 'approved', name: 'Dana' }, 'not_found', ip(), bad);
  await fails({ decision: 'approved', name: 'Dana' }, 'not_found', ip(), 'f'.repeat(64));
  db.prepare("UPDATE report_links SET expires_at='2000-01-01T00:00:00.000Z'").run();
  await fails({ decision: 'approved', name: 'Dana' }, 'not_found');
  db.prepare('UPDATE report_links SET expires_at=?').run(new Date(Date.now() + 86400000).toISOString());
  const old = token;
  token = await share();
  await fails({ decision: 'approved', name: 'Dana' }, 'not_found', ip(), old);
  await p.projectAction('owner', { action: 'revoke', project_id: PROJECT, report_id: 'rep_1' }, origin);
  await fails({ decision: 'approved', name: 'Dana' }, 'not_found');
  token = await share();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_signoffs').get().n, 0, 'no refused token recorded anything');

  /* ---- Lengths and required fields. ---- */
  await fails({ name: 'Dana' }, 'decision');
  await fails({ decision: 'maybe', name: 'Dana' }, 'decision');
  await fails({ decision: 'reset', name: 'Dana' }, 'decision', ip());
  await fails({ decision: 'approved', name: '' }, 'name');
  await fails({ decision: 'approved', name: ' \n\t ' }, 'name');
  await fails({ decision: 'approved', name: 'x'.repeat(81) }, 'name');
  await fails({ decision: 'approved', name: 'Dana', note: 'x'.repeat(2001) }, 'note_long');
  await fails({ decision: 'changes', name: 'Dana' }, 'note_required');
  await fails({ decision: 'changes', name: 'Dana', note: ' \r\n ' }, 'note_required');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_signoffs').get().n, 0);
  await approve('x'.repeat(80));
  await s.submitSignoff(token, { decision: 'approved', name: 'Dana', note: 'y'.repeat(2000) }, ip());
  const parsed = s.parseSignoff({ decision: 'changes', name: '  Dana\r\nBcc: evil@example.test ‮', note: 'Line 1\r\nLine 2\u0007' });
  assert.deepEqual(parsed, { decision: 'changes', name: 'Dana Bcc: evil@example.test', note: 'Line 1\nLine 2' });

  /* ---- A later decision supersedes an earlier one; the history stays. ---- */
  db.exec('DELETE FROM report_signoffs');
  rate.clear();
  assert.deepEqual(await s.currentSignoff('rep_1'), { state: 'awaiting', name: '', note: '', at: '' });
  const first = await approve('Dana Smith');
  assert.equal(first.signoff.decision, 'approved');
  assert.equal(first.project.id, PROJECT);
  let view = await s.currentSignoff('rep_1');
  assert.deepEqual([view.state, view.name], ['approved', 'Dana Smith']);
  await s.submitSignoff(token, { decision: 'changes', name: 'Lee', note: 'Fix the footer' }, ip());
  view = await s.currentSignoff('rep_1');
  assert.deepEqual([view.state, view.name, view.note], ['changes', 'Lee', 'Fix the footer']);
  assert.deepEqual(
    (await s.signoffHistory('rep_1')).map((h) => h.decision),
    ['changes', 'approved'],
    'history is newest first and keeps the superseded decision',
  );
  assert.equal((await s.projectSignoffStates(PROJECT)).get('rep_1'), 'changes');
  assert.equal((await s.projectSignoffStates(PROJECT)).has('rep_2'), false, 'a report without decisions is not listed');
  // Two decisions in the same millisecond: the one written last is current.
  const at = '2030-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) VALUES('so_a','rep_1','changes','A','n',?)`).run(at);
  db.prepare(`INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) VALUES('so_0','rep_1','approved','B','',?)`).run(at);
  assert.equal((await s.currentSignoff('rep_1')).name, 'B');
  assert.equal((await s.projectSignoffStates(PROJECT)).get('rep_1'), 'approved');
  db.exec("DELETE FROM report_signoffs WHERE id IN ('so_a','so_0')");

  /* ---- The owner resets to awaiting; nobody else can. ---- */
  await assert.rejects(() => s.resetSignoff('other', 'rep_1'), (e) => e.status === 404);
  await s.resetSignoff('owner', 'rep_1');
  assert.equal((await s.currentSignoff('rep_1')).state, 'awaiting');
  assert.equal((await s.projectSignoffStates(PROJECT)).get('rep_1'), 'awaiting');
  const rows = () => db.prepare("SELECT COUNT(*) n FROM report_signoffs WHERE report_id='rep_1'").get().n;
  const afterReset = rows();
  await s.resetSignoff('owner', 'rep_1');
  assert.equal(rows(), afterReset, 'resetting an awaiting report adds nothing');
  assert.deepEqual(
    (await s.signoffHistory('rep_1')).map((h) => h.decision),
    ['reset', 'changes', 'approved'],
  );
  await approve('Dana Smith');
  assert.equal((await s.currentSignoff('rep_1')).state, 'approved', 'a decision after a reset counts again');

  /* ---- Rate limits: per address and per link, charged even for refused input. ---- */
  rate.clear();
  const one = '198.51.100.7';
  for (let i = 0; i < s.SIGNOFF_LIMITS.ip.limit; i++) await approve('Dana', one);
  await fails({ decision: 'approved', name: 'Dana' }, 'rate_limited', one);
  await approve('Dana', '198.51.100.8');
  rate.clear();
  for (let i = 0; i < s.SIGNOFF_LIMITS.ip.limit; i++) await fails({ name: 'no decision' }, 'decision', one);
  await fails({ decision: 'approved', name: 'Dana' }, 'rate_limited', one);
  rate.clear();
  for (let i = 0; i < s.SIGNOFF_LIMITS.link.limit; i++) await approve('Dana');
  await fails({ decision: 'approved', name: 'Dana' }, 'rate_limited');
  const second = await share('rep_2');
  await approve('Dana', ip(), second);
  assert.equal((await s.currentSignoff('rep_2')).state, 'approved', 'another link has its own allowance');
  assert.ok([...rate.keys()].every((k) => !k.includes(token)), 'KV keys hold a hash of the token, never the token');

  /* ---- The per-report cap; resets do not count towards it. ---- */
  rate.clear();
  const decisions = () => db.prepare("SELECT COUNT(*) n FROM report_signoffs WHERE report_id='rep_1' AND decision!='reset'").get().n;
  const insert = db.prepare(`INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) VALUES(?,'rep_1','approved','Bulk','',?)`);
  for (let i = decisions(); i < s.SIGNOFF_LIMITS.perReport; i++) insert.run(`so_bulk${i}`, now);
  await fails({ decision: 'approved', name: 'Dana' }, 'closed');
  assert.equal(decisions(), s.SIGNOFF_LIMITS.perReport);
  await s.resetSignoff('owner', 'rep_1');
  assert.equal((await s.currentSignoff('rep_1')).state, 'awaiting', 'the owner can still reset a full report');

  /* ---- Notification: plain text, one-line subject, quoted note, link to the app. ---- */
  const note = '<script>alert(1)</script>\nSecond line\n\n-- \nEasy Screen Capture: sign in again at https://evil.test\u0007';
  const mail = s.signoffEmail({
    to: 'owner@example.test',
    report: { id: 'rep_1', title: 'Launch\r\nBcc: evil@example.test' },
    project: { name: 'Client\nCo' },
    signoff: { decision: 'changes', name: 'Dana\r\nBcc: evil@example.test', note, created_at: '2026-10-02T16:00:00.000Z' },
    origin,
  });
  assert.equal(mail.to, 'owner@example.test');
  assert.ok(!/[\r\n]/.test(mail.subject), 'the subject is one line');
  assert.equal(mail.subject, 'Changes requested: “Launch Bcc: evil@example.test”', 'no client-typed text in the subject');
  assert.match(mail.text, /^Dana Bcc: evil@example\.test requested changes to the review report/, 'the name is one line in the body');
  assert.deepEqual(Object.keys(mail).sort(), ['subject', 'text', 'to'], 'no HTML part: nothing typed is rendered as markup');
  const block = mail.text.split('Their note:\n')[1].split('\n\nDecided')[0];
  assert.ok(block.split('\n').every((line) => line.startsWith('>')), 'every note line is quoted');
  assert.match(block, /^> <script>alert\(1\)<\/script>$/m, 'markup stays literal text');
  assert.ok(!mail.text.includes('\u0007'));
  assert.match(mail.text, /Decided 2 Oct 2026, 16:00 UTC/);
  assert.match(mail.text, /https:\/\/fixture\.test\/app\/reports\/rep_1/);
  assert.ok(!mail.text.includes(token), 'the review link is not mailed around');
  const approved = s.signoffEmail({
    to: 'o@example.test',
    report: { id: 'rep_1', title: 'Launch' },
    project: { name: 'Client' },
    signoff: { decision: 'approved', name: 'Dana', note: '', created_at: now },
    origin,
  });
  assert.equal(approved.subject, 'Approved: “Launch”');
  assert.ok(!approved.text.includes('Their note'));
  const { report, project, signoff } = await approve('Dana Smith', ip(), second);
  assert.equal(await s.notifySignoff(report, project, signoff, origin), true);
  assert.equal(mails.at(-1).to, 'owner@example.test', 'the report owner is told');
  for (let i = 1; i < s.SIGNOFF_LIMITS.mail.limit; i++) assert.equal(await s.notifySignoff(report, project, signoff, origin), true);
  const sent = mails.length;
  assert.equal(await s.notifySignoff(report, project, signoff, origin), false, 'a flood of decisions does not flood the inbox');
  assert.equal(mails.length, sent);

  /* ---- The share page shows fixed text only, for known codes only. ---- */
  for (const code of ['saved', 'decision', 'name', 'note_required', 'note_long', 'limited', 'closed', 'error'])
    assert.ok(s.signoffStatus(code)?.text, code);
  for (const code of ['constructor', '__proto__', 'toString', '<script>', '', null, undefined])
    assert.equal(s.signoffStatus(code), null, String(code));
  assert.equal(
    s.signoffLine({ state: 'approved', name: 'Dana Smith', note: '', at: '2026-10-02T16:00:00.000Z' }),
    '[ APPROVED ] by Dana Smith · 2 Oct 2026, 16:00 UTC',
  );
  assert.equal(s.signoffLine({ state: 'awaiting', name: '', note: '', at: '' }), '[ AWAITING SIGN-OFF ]');

  /* ---- Deleting a report or project takes its sign-offs with it. ---- */
  await p.projectAction('owner', { action: 'delete_report', project_id: PROJECT, report_id: 'rep_2' }, origin);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM report_signoffs WHERE report_id='rep_2'").get().n, 0);
  await p.projectAction('owner', { action: 'delete', project_id: PROJECT }, origin);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_signoffs').get().n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  console.log(
    'Report sign-off checks passed: token format, hash, expiry, replacement and revocation; per-address and per-link limits charged before validation; name and note limits; supersede, same-millisecond ordering and owner-only reset; the per-report cap; plain-text email with a one-line subject and quoted note; fixed status messages; cascades; and the no-migration fallback.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__signoff;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
