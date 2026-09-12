/** Production project/report operations, with real SQLite and mocked browser/R2. No network calls. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).sort();
for (const f of migrations.filter((f) => f.endsWith('.sql')))
  db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const now = new Date().toISOString();
for (const id of ['owner', 'other', 'viewer'])
  db.prepare(
    `INSERT INTO users(id,email,email_lower,plan,period_start,created_at,updated_at) VALUES(?,?,?,'pro',?,?,?)`,
  ).run(id, id + '@example.test', id + '@example.test', now, now, now);
db.prepare('UPDATE users SET email_verified_at=?').run(now);
const files = JSON.stringify([
  { name: 'capture.png', key: 'test.png', contentType: 'image/png', bytes: 8, width: 1440, height: 900 },
]);
for (const [id, user, format, mode] of [
  ['before', 'owner', 'png', 'fullpage'],
  ['after', 'owner', 'png', 'fullpage'],
  ['mobile1', 'owner', 'png', 'visible'],
  ['mobile2', 'owner', 'png', 'visible'],
  ['foreign', 'other', 'png', 'visible'],
  ['series', 'owner', 'png', 'series'],
  ['pdf', 'owner', 'pdf', 'visible'],
])
  db.prepare(
    `INSERT INTO captures(id,user_id,url,host,device,width,height,mode,format,status,share_token,files,created_at) VALUES(?,?,'https://example.test/?a=<script>','example.test','desktop',1440,900,?,?,'done','DO_NOT_LEAK',?,?)`,
  ).run(id, user, mode, format, files, now);
const bind = (sql, args = []) => ({
  bind: (...a) => bind(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => {
    const r = db.prepare(sql).run(...args);
    return { meta: { changes: Number(r.changes) } };
  },
});
const mails = [];
let html = '',
  browserClosed = 0,
  jsEnabled = true,
  interception = false,
  sourceMissing = false;
globalThis.__projects = {
  mails,
  env: {
    DB: {
      prepare: (sql) => bind(sql),
      batch: async (statements) => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const q of statements) results.push(await q.run());
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    SHOTS: {
      get: async () =>
        sourceMissing
          ? null
          : {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array([1, 2]));
                  c.close();
                },
              }),
              size: 8,
              arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
            },
    },
  },
  browser: {
    newPage: async () => ({
      setJavaScriptEnabled: async (x) => {
        jsEnabled = x;
      },
      setRequestInterception: async (x) => {
        interception = x;
      },
      on: () => {},
      setContent: async (x) => {
        html = x;
      },
      pdf: async () => new TextEncoder().encode('%PDF-fixture'),
      close: async () => {},
    }),
    close: async () => {
      browserClosed++;
    },
  },
};
const directory = mkdtempSync(join(tmpdir(), 'projects-check-'));
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({ path: 'puppeteer', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
      contents:
        args.path === 'cf'
          ? 'export const env=globalThis.__projects.env;'
          : 'export default {sessions:async()=>[],launch:async()=>globalThis.__projects.browser};',
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export const canSendEmail=()=>true;export async function sendMail(mail){globalThis.__projects.mails.push(mail);return true;}',
    }));
    b.onLoad({ filter: /\/lib\/captures\.ts$/ }, () => ({ contents: 'export const safeParseFiles=JSON.parse;' }));
  },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw Error('Unexpected network request');
};
try {
  for (const name of [
    'projects',
    'report-files',
    'report-pdf',
    'collaboration',
    'digests',
    'digest-schedule',
    'ignore-regions',
    'watch-settings',
  ])
    await build({
      entryPoints: [new URL(`../src/lib/${name}.ts`, import.meta.url).pathname],
      outfile: join(directory, name + '.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [plugin],
    });
  const p = await import(pathToFileURL(join(directory, 'projects.mjs')));
  const f = await import(pathToFileURL(join(directory, 'report-files.mjs')));
  const pdf = await import(pathToFileURL(join(directory, 'report-pdf.mjs')));
  const origin = 'https://fixture.test';
  assert.equal(await p.projectsReady(), true);
  const created = await p.projectAction(
    'owner',
    { action: 'create', name: 'Client', brand: 'Agency <script>alert(1)</script>' },
    origin,
  );
  const id = created.redirect.split('/').at(-1);
  assert.equal((await p.listProjects('other')).length, 0);
  const action = (a, body = {}, user = 'owner') =>
    p.projectAction(user, { action: a, project_id: id, ...body }, origin);
  for (const a of ['rename', 'delete', 'attach', 'preset', 'report'])
    await assert.rejects(
      () => action(a, {}, 'other'),
      (e) => e.status === 404,
    );
  await assert.rejects(
    () => action('attach', { asset_id: 'foreign' }),
    (e) => e.status === 404,
  );
  for (const asset_id of ['before', 'after', 'mobile1', 'mobile2', 'series', 'pdf'])
    await action('attach', { asset_id });
  await action('preset', {
    name: 'Privacy',
    device: 'mobile',
    mode: 'visible',
    hide: '.ad',
    auth: 'secret',
    headers: 'secret',
    cookies: 'secret',
    actions: 'secret',
    url: 'https://secret.test',
    html: 'secret',
  });
  const saved = JSON.parse(db.prepare('SELECT settings FROM capture_presets').get().settings);
  assert.deepEqual(saved, { device: 'mobile', mode: 'visible', hide: '.ad' });
  await assert.rejects(
    () => action('review', { asset_id: 'before', review_status: 'injected' }),
    (e) => e.status === 400,
  );
  await action('review', { asset_id: 'before', review_status: 'approved' });
  assert.equal(
    db.prepare("SELECT review_status FROM project_captures WHERE capture_id='before'").get().review_status,
    'approved',
  );
  for (const after of ['foreign', 'series', 'pdf', 'before'])
    await assert.rejects(
      () => action('report', { title: 'Test', before: 'before', after }),
      (e) => e.status === 400,
    );
  await assert.rejects(
    () => action('report', { title: 'Test', before: 'before', after: 'after', mobile_before: 'mobile1' }),
    (e) => e.status === 400,
  );
  const reportId = (
    await action('report', {
      title: 'Launch <script>',
      before: 'before',
      after: 'after',
      mobile_before: 'mobile1',
      mobile_after: 'mobile2',
      notes: 'Notes <img src=x onerror=alert(1)>',
    })
  ).redirect
    .split('/')
    .at(-1);
  await assert.rejects(
    () => p.ownReport('other', reportId),
    (e) => e.status === 404,
  );
  await action('comment', { report_id: reportId, body: 'Private note' });
  await assert.rejects(
    () => action('comment', { report_id: reportId, body: 'Attack' }, 'other'),
    (e) => e.status === 404,
  );
  const { report, project } = await p.ownReport('owner', reportId);
  assert.equal((await p.reportCaptures(report, 'owner')).length, 4);
  assert.equal((await p.reportCaptures(report, 'other')).filter((c) => c.id).length, 0);
  let token = (await action('share', { report_id: reportId, days: '7' })).share_url.split('/').at(-1);
  const stored = db.prepare('SELECT * FROM report_links').get();
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.token_hash.length, 64);
  await p.sharedReport(token, true);
  assert.equal(db.prepare('SELECT access_count FROM report_links').get().access_count, 1);
  const image = await f.reportImage(report, 'owner', '0');
  assert.equal(image.status, 200);
  assert.match(image.headers.get('cache-control'), /no-store/);
  await assert.rejects(
    () => f.reportImage(report, 'other', '0'),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => f.reportImage(report, 'owner', '4'),
    (e) => e.status === 404,
  );
  const output = await pdf.reportPdf(project, report);
  assert.match(new TextDecoder().decode(output), /^%PDF/);
  assert.equal(jsEnabled, false);
  assert.equal(interception, true);
  assert.equal(browserClosed, 1);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('DO_NOT_LEAK'));
  assert.ok(!html.includes('Private note'));
  assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/data:image\/png;base64/g) || []).length, 4);
  const team = await import(pathToFileURL(join(directory, 'collaboration.mjs')));
  const digests = await import(pathToFileURL(join(directory, 'digests.mjs')));
  const schedule = await import(pathToFileURL(join(directory, 'digest-schedule.mjs')));
  const regions = await import(pathToFileURL(join(directory, 'ignore-regions.mjs')));
  const noise = await import(pathToFileURL(join(directory, 'watch-settings.mjs')));
  assert.equal(schedule.digestWeek('UTC', new Date('2026-09-14T08:00:00Z')), null);
  assert.equal(schedule.digestWeek('Asia/Kolkata', new Date('2026-09-14T04:00:00Z')), '2026-09-14');
  assert.equal(schedule.nextDigest('Europe/Sofia', new Date('2026-09-13T12:00:00Z')), '2026-09-14T06:00:00.000Z');
  assert.equal(schedule.nextDigest('America/New_York', new Date('2026-11-01T12:00:00Z')), '2026-11-02T14:00:00.000Z');
  assert.deepEqual(regions.parseIgnoreRegions('0,10,200,100;300,0,50,80'), [
    { x: 0, y: 10, width: 200, height: 100 },
    { x: 300, y: 0, width: 50, height: 80 },
  ]);
  for (const raw of ['0,0,0,10', '-1,0,10,10', '0,0,10', '0,0,20001,2', '0,0,10,10;'.repeat(11)])
    assert.throws(() => regions.parseIgnoreRegions(raw));
  const preview = noise.previewOptions({ url: 'https://example.test', hide: '.clock', ignore_regions: '0,0,10,10' });
  const fingerprint = await noise.previewFingerprint(preview);
  assert.notEqual(await noise.previewFingerprint({ ...preview, ignoreRegions: [] }), fingerprint);
  const owner = { id: 'owner', email: 'owner@example.test', plan: 'business' };
  const other = { id: 'other', email: 'other@example.test', plan: 'free' };
  const viewer = { id: 'viewer', email: 'viewer@example.test', plan: 'free' };
  const teamAction = (action, body = {}, user = owner) =>
    team.collaborationAction(user, { action, project_id: id, ...body }, origin);
  await assert.rejects(
    () => teamAction('invite', { email: other.email, role: 'editor' }),
    (e) => e.status === 403,
  );
  db.prepare("UPDATE users SET plan='business' WHERE id='owner'").run();
  const invite = (await teamAction('invite', { email: other.email, role: 'editor' })).share_url.split('token=')[1];
  await assert.rejects(
    () => teamAction('accept', { token: invite }, viewer),
    (e) => e.status === 400,
  );
  db.prepare("UPDATE users SET email_verified_at=NULL WHERE id='other'").run();
  await assert.rejects(
    () => teamAction('accept', { token: invite }, other),
    (e) => e.status === 403,
  );
  db.prepare("UPDATE users SET email_verified_at=? WHERE id='other'").run(now);
  await teamAction('accept', { token: invite }, other);
  await assert.rejects(
    () => teamAction('accept', { token: invite }, other),
    (e) => e.status === 400,
  );
  assert.equal((await team.reportAccess('other', reportId)).role, 'editor');
  await teamAction('comment', { report_id: reportId, body: 'Team-only comment' }, other);
  await assert.rejects(
    () => teamAction('invite', { email: 'third@example.test', role: 'viewer' }, other),
    (e) => e.status === 404,
  );
  const viewerInvite = (await teamAction('invite', { email: viewer.email, role: 'viewer' })).share_url.split(
    'token=',
  )[1];
  await teamAction('accept', { token: viewerInvite }, viewer);
  await assert.rejects(
    () => teamAction('comment', { report_id: reportId, body: 'Forbidden' }, viewer),
    (e) => e.status === 403,
  );
  await teamAction('invite', { email: 'pending@example.test', role: 'viewer' });
  await assert.rejects(
    () => teamAction('invite', { email: 'fourth@example.test', role: 'viewer' }),
    (e) => e.status === 400,
  );
  db.prepare("UPDATE users SET plan='pro' WHERE id='owner'").run();
  await assert.rejects(
    () => team.reportAccess('other', reportId),
    (e) => e.status === 404,
  );
  db.prepare("UPDATE users SET plan='business',email_verified_at=? WHERE id='owner'").run(now);
  await teamAction('digest', { enabled: '1', timezone: 'UTC' });
  db.prepare("UPDATE project_digests SET next_run_at='2026-09-14T09:00:00.000Z'").run();
  const monday = new Date('2026-09-14T09:00:00.000Z');
  assert.equal((await digests.runProjectDigests(origin, monday)).attempted, 1);
  assert.equal((await digests.runProjectDigests(origin, monday)).attempted, 0);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, owner.email);
  assert.ok(!mails[0].text.includes('Private note'));
  assert.ok(!mails[0].text.includes('DO_NOT_LEAK'));
  assert.equal(db.prepare('SELECT status FROM digest_deliveries').get().status, 'accepted');
  await teamAction('digest', { enabled: '0', timezone: 'UTC' });
  assert.equal(db.prepare('SELECT enabled FROM project_digests').get().enabled, 0);
  const member = db.prepare("SELECT id FROM project_members WHERE user_id='other'").get();
  await teamAction('revoke_member', { member_id: member.id });
  await assert.rejects(
    () => team.reportAccess('other', reportId),
    (e) => e.status === 404,
  );
  const old = token;
  token = (await action('share', { report_id: reportId, days: '1' })).share_url.split('/').at(-1);
  await assert.rejects(
    () => p.sharedReport(old),
    (e) => e.status === 404,
  );
  db.prepare("UPDATE report_links SET expires_at='2000-01-01T00:00:00Z'").run();
  await assert.rejects(
    () => p.sharedReport(token),
    (e) => e.status === 404,
  );
  token = (await action('share', { report_id: reportId })).share_url.split('/').at(-1);
  await action('revoke', { report_id: reportId });
  await assert.rejects(
    () => p.sharedReport(token),
    (e) => e.status === 404,
  );
  sourceMissing = true;
  await assert.rejects(
    () => f.reportImage(report, 'owner', '0'),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => pdf.reportPdf(project, report),
    (e) => e.status === 409,
  );
  sourceMissing = false;
  db.prepare("DELETE FROM captures WHERE id='before'").run();
  const retained = await p.reportCaptures(report, 'owner');
  assert.equal(retained[0].id, null);
  assert.equal(retained[1].id, 'after');
  await assert.rejects(
    () => pdf.reportPdf(project, report),
    (e) => e.status === 409,
  );
  await action('delete');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_reports').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_comments').get().n, 0);
  assert.ok(db.prepare("SELECT id FROM captures WHERE id='after'").get());
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  console.log(
    'Projects: ownership, preset privacy, launch reports, notes, PDF sanitization, token replacement/expiry/revocation, image privacy, retention cascades, team roles/invitations/seat limits/downgrades, digest deduplication/timezones, and noise validation passed.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__projects;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
