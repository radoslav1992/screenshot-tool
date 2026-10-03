/**
 * Report branding: logo validation by magic bytes, size and dimension limits,
 * accent validation and contrast, plan gating, R2 storage and serving, the PDF,
 * account deletion and the no-migration fallback. Real SQLite and real images;
 * R2, KV and the browser are mocked. No network calls.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NEW = '0016_report_signoff_branding.sql';
const migrations = readdirSync(new URL('../migrations/', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort();
assert.ok(migrations.includes(NEW), 'migration 0016 exists');
const upgrade = readFileSync(new URL('../db/0016-upgrade.sql', import.meta.url), 'utf8');
assert.ok(!upgrade.includes('--'), 'the console upgrade must be comment-free: the D1 console flattens it onto one line');
assert.match(upgrade, new RegExp(`INSERT OR IGNORE INTO d1_migrations \\(name\\) VALUES \\('${NEW}'\\);`));

// The console upgrade and the migration must build the same tables.
const schemaOf = (sql) => {
  const scratch = new DatabaseSync(':memory:');
  scratch.exec('CREATE TABLE review_reports(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY);');
  scratch.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
  scratch.exec(sql);
  const rows = scratch
    .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('report_signoffs','project_branding','report_signoffs_report') ORDER BY name")
    .all()
    .map((r) => [r.name, r.sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')]);
  scratch.close();
  return rows;
};
const fromMigration = readFileSync(new URL(`../migrations/${NEW}`, import.meta.url), 'utf8');
assert.deepEqual(schemaOf(upgrade), schemaOf(fromMigration), 'db/0016-upgrade.sql matches the migration');
assert.equal(schemaOf(upgrade + upgrade).length, 3, 'the console upgrade can be pasted twice');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const apply = (f) => db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
for (const f of migrations.filter((f) => f !== NEW)) apply(f);
const now = new Date().toISOString();
for (const [id, plan] of [
  ['owner', 'plus'],
  ['editor', 'free'],
])
  db.prepare(
    `INSERT INTO users(id,email,email_lower,plan,period_start,created_at,updated_at,email_verified_at) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(id, `${id}@example.test`, `${id}@example.test`, plan, now, now, now, now);
const PROJECT = 'prj_branding001';
db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?)`).run(PROJECT, 'owner', 'Client', 'North Studio', now);
db.prepare(`INSERT INTO review_reports VALUES(?,?,?,?,?)`).run('rep_1', PROJECT, 'Launch', 'Notes', now);

const png = await sharp({ create: { width: 300, height: 100, channels: 4, background: '#1f6feb' } }).png().toBuffer();
const solid = () => sharp({ create: { width: 300, height: 100, channels: 3, background: '#ffffff' } });
const jpeg = await solid().jpeg().toBuffer();
const progressive = await solid().jpeg({ progressive: true }).toBuffer();
const webpLossy = await solid().webp().toBuffer();
const webpLossless = await solid().webp({ lossless: true }).toBuffer();
const webpAlpha = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
  .webp()
  .toBuffer();
const files = JSON.stringify([{ name: 'capture.png', key: 'captures/owner/c1/capture.png', contentType: 'image/png' }]);
for (const [id, position] of [
  ['c1', 0],
  ['c2', 1],
]) {
  db.prepare(
    `INSERT INTO captures(id,user_id,url,host,device,width,height,mode,format,status,share_token,files,created_at) VALUES(?,?,'https://example.test/','example.test','desktop',1440,900,'fullpage','png','done','t',?,?)`,
  ).run(id, 'owner', files, now);
  db.prepare('INSERT INTO report_captures VALUES(?,?,?)').run('rep_1', id, position);
}

const stmt = (sql, args = []) => ({
  sql,
  args,
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});
let failNextBatch = false;
const objects = new Map();
const r2 = [];
let html = '';
globalThis.__branding = {
  env: {
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (list) => {
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error('D1_ERROR: simulated outage');
        }
        db.exec('BEGIN');
        try {
          const out = list.map((q) =>
            /^\s*SELECT/i.test(q.sql)
              ? { results: db.prepare(q.sql).all(...q.args) }
              : { results: [], meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } },
          );
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    SHOTS: {
      put: async (key, value, options) => {
        r2.push(['put', key]);
        objects.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType });
      },
      get: async (key) => {
        r2.push(['get', key]);
        const o = objects.get(key);
        return o
          ? { size: o.bytes.length, body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.slice().buffer }
          : null;
      },
      delete: async (keys) => {
        r2.push(['delete', keys]);
        for (const k of [].concat(keys)) objects.delete(k);
      },
      list: async ({ prefix }) => {
        r2.push(['list', prefix]);
        return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
      },
    },
  },
  browser: {
    newPage: async () => ({
      setJavaScriptEnabled: async () => {},
      setRequestInterception: async () => {},
      on: () => {},
      setContent: async (x) => {
        html = x;
      },
      pdf: async () => new TextEncoder().encode('%PDF-fixture'),
      close: async () => {},
    }),
    close: async () => {},
  },
};
objects.set('captures/owner/c1/capture.png', { bytes: new Uint8Array(png), type: 'image/png' });

const directory = mkdtempSync(join(tmpdir(), 'branding-check-'));
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({ path: 'puppeteer', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
      contents:
        args.path === 'cf'
          ? 'export const env=globalThis.__branding.env;'
          : 'export default {sessions:async()=>[],launch:async()=>globalThis.__branding.browser};',
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents: 'export const canSendEmail=()=>false;export async function sendMail(){return false;}',
    }));
  },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw Error('Unexpected network request');
};
try {
  for (const name of ['branding-rules', 'branding', 'report-pdf', 'account-deletion'])
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
  const rules = await load('branding-rules');
  const project = { id: PROJECT, user_id: 'owner', name: 'Client', brand: 'North Studio', created_at: now };
  const report = { id: 'rep_1', project_id: PROJECT, title: 'Launch', notes: 'Notes', created_at: now };
  const form = (fields, file) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ action: 'save', project_id: PROJECT, ...fields })) f.append(k, v);
    if (file) f.append('logo', file);
    return f;
  };
  const file = (bytes, type, name = 'logo') => new File([bytes], name, { type });

  /* ---- No migration: everything reads as absent and nothing breaks. ---- */
  {
    const b = await load('branding');
    const pdf = await load('report-pdf');
    assert.equal(await b.brandingReady(), false);
    assert.equal(await b.projectBranding(project), null, 'reports render unbranded without the table');
    assert.equal(await b.brandingRow(PROJECT), null);
    await assert.rejects(
      () => b.brandingAction({ project, role: 'owner' }, form({ accent: '#1f6feb' })),
      (e) => e.status === 503 && e.type === 'setup_required',
    );
    assert.equal((await b.logoResponse(PROJECT, 'a'.repeat(32) + '.png')).status, 404);
    const before = r2.length;
    await b.deleteProjectLogos(PROJECT);
    assert.deepEqual(await b.accountBrandingCleanup('owner'), []);
    assert.equal(r2.length, before, 'no R2 calls for branding before the migration');
    await pdf.reportPdf(project, report);
    assert.match(html, /border-bottom:3px solid #b5d652/, 'the PDF keeps its original look');
    assert.ok(!html.includes('class="logo"') && !html.includes('<footer>') && !html.includes('Sign-off'));
  }

  apply(NEW);

  /* ---- Logo validation: the bytes decide, never the declared type. ---- */
  const sizes = [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
    [progressive, 'image/jpeg'],
    [webpLossy, 'image/webp'],
    [webpLossless, 'image/webp'],
    [webpAlpha, 'image/webp'],
  ];
  for (const [bytes, type] of sizes) {
    const info = rules.sniffLogo(new Uint8Array(bytes));
    assert.deepEqual([info?.type, info?.width, info?.height], [type, 300, 100], `${type} is identified and sized`);
    assert.equal(rules.checkLogo(new Uint8Array(bytes), type).type, type);
  }
  const text = (s) => new TextEncoder().encode(s);
  const rejected = (bytes, declared, status = 400) =>
    assert.throws(
      () => rules.checkLogo(bytes, declared),
      (e) => e.status === status && e.param === 'logo',
      `${declared || 'untyped'} upload must be refused`,
    );
  const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  rejected(svg, 'image/svg+xml');
  rejected(svg, 'image/png');
  rejected(text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
  rejected(text('<!doctype html><script>alert(1)</script>'), 'image/png');
  rejected(text('GIF89a\x01\x00\x01\x00'), 'image/gif');
  rejected(new Uint8Array(png).slice(0, 12), 'image/png');
  rejected(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'image/jpeg');
  rejected(text('RIFF\x00\x00\x00\x00WEBPVP8 '), 'image/webp');
  // A real PNG announced as something else is a spoof, whichever way round.
  rejected(new Uint8Array(png), 'image/svg+xml');
  rejected(new Uint8Array(png), 'image/jpeg');
  rejected(new Uint8Array(png), 'text/html');
  assert.equal(rules.checkLogo(new Uint8Array(png), 'image/png; charset=binary').type, 'image/png');
  assert.equal(rules.checkLogo(new Uint8Array(png), 'application/octet-stream').type, 'image/png');
  assert.equal(rules.checkLogo(new Uint8Array(png), '').type, 'image/png');
  const atLimit = new Uint8Array(rules.LOGO_MAX_BYTES);
  atLimit.set(png);
  assert.equal(rules.checkLogo(atLimit, 'image/png').type, 'image/png', 'exactly 512 KB is accepted');
  const overLimit = new Uint8Array(rules.LOGO_MAX_BYTES + 1);
  overLimit.set(png);
  rejected(overLimit, 'image/png', 413);
  rejected(new Uint8Array(0), 'image/png');
  const huge = new Uint8Array(png);
  new DataView(huge.buffer).setUint32(16, 5000);
  rejected(huge, 'image/png');
  const empty = new Uint8Array(png);
  new DataView(empty.buffer).setUint32(20, 0);
  rejected(empty, 'image/png');

  /* ---- Accent: #rrggbb only, and black or white text by contrast. ---- */
  assert.equal(rules.parseAccent('#1F6FEB'), '#1f6feb');
  assert.equal(rules.parseAccent('  '), '');
  for (const bad of ['red', '#fff', '#12345g', '#1234567', '1f6feb', 'url(x)', '#1f6feb;color:red', 'javascript:'])
    assert.throws(() => rules.parseAccent(bad), (e) => e.status === 400 && e.param === 'accent', bad);
  assert.equal(rules.accentInk('#ffffff'), rules.BLACK);
  assert.equal(rules.accentInk('#000000'), rules.WHITE);
  assert.equal(rules.accentInk('#fb7515'), rules.BLACK, 'black on the default orange');
  assert.equal(rules.accentInk('#ffff00'), rules.BLACK);
  assert.equal(rules.accentInk('#1f6feb'), rules.WHITE);
  assert.equal(rules.accentInk('#7c3aed'), rules.WHITE);
  for (let r = 0; r < 256; r += 17)
    for (let g = 0; g < 256; g += 17)
      for (let b = 0; b < 256; b += 17) {
        const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        const ink = rules.accentInk(hex);
        const other = ink === rules.BLACK ? rules.WHITE : rules.BLACK;
        assert.ok(rules.contrastRatio(hex, ink) >= rules.contrastRatio(hex, other), `${hex}: the better of the two`);
        assert.ok(rules.contrastRatio(hex, ink) >= 4.5, `${hex}: at least 4.5:1`);
      }
  assert.equal(rules.accentStyle({ accent: '', accentInk: rules.BLACK }), '', 'no custom properties by default');
  assert.equal(rules.accentStyle({ accent: '#1f6feb', accentInk: '#ffffff' }), '--report-accent:#1f6feb;--report-accent-ink:#ffffff');

  /* ---- Footer: one line, 200 characters. ---- */
  assert.equal(rules.parseFooter(' Made by\nNorth ‮Studio\u0007 '), 'Made by North Studio');
  assert.equal(rules.parseFooter('x'.repeat(200)).length, 200);
  assert.throws(() => rules.parseFooter('x'.repeat(201)), (e) => e.status === 400 && e.param === 'footer');

  /* ---- Plan gating: hiding the attribution is for the top plans. ---- */
  for (const plan of ['free', 'lite', 'plus', 'unknown', null]) assert.equal(rules.canHideAttribution(plan), false, String(plan));
  for (const plan of ['pro', 'business']) assert.equal(rules.canHideAttribution(plan), true, plan);
  assert.equal(rules.whiteLabelPlans(), 'Pro and Business');
  const row = { logo_key: '', logo_type: '', logo_width: 0, logo_height: 0, accent: '', footer: '', hide_attribution: 1 };
  assert.equal(rules.resolveBranding(row, 'plus').attribution, true, 'a downgrade brings the attribution back');
  assert.equal(rules.resolveBranding(row, 'pro').attribution, false);
  assert.equal(rules.resolveBranding(null, 'business').attribution, true);
  assert.equal(rules.resolveBranding({ ...row, accent: 'red;x' }, 'pro').accent, '', 'a bad stored accent is ignored');
  assert.equal(rules.resolveBranding({ ...row, logo_key: '../secret.png' }, 'pro').logoUrl, null, 'only brand/ keys become URLs');

  /* ---- Storage and serving, with the migration applied. ---- */
  const b = await load('branding', '?migrated');
  const owner = { project, role: 'owner' };
  assert.equal(await b.brandingReady(), true);
  const puts = () => r2.filter(([op]) => op === 'put').length;
  let count = puts();
  await assert.rejects(() => b.brandingAction({ project, role: 'viewer' }, form({}, file(png, 'image/png'))), (e) => e.status === 403);
  await assert.rejects(() => b.brandingAction(owner, form({ accent: 'blue' })), (e) => e.param === 'accent');
  await assert.rejects(() => b.brandingAction(owner, form({ footer: 'x'.repeat(201) })), (e) => e.param === 'footer');
  await assert.rejects(() => b.brandingAction(owner, form({}, file(svg, 'image/png'))), (e) => e.param === 'logo');
  await assert.rejects(() => b.brandingAction(owner, form({}, file(overLimit, 'image/png'))), (e) => e.status === 413);
  await assert.rejects(() => b.brandingAction(owner, form({ action: 'publish' })), (e) => e.status === 400);
  assert.equal(puts(), count, 'nothing is stored for a refused upload');
  assert.equal(await b.brandingRow(PROJECT), null);

  await b.brandingAction(owner, form({ accent: '#1F6FEB', footer: 'Made by <b>North</b>\nStudio' }, file(png, 'image/png', 'logo.svg')));
  let saved = await b.brandingRow(PROJECT);
  assert.match(saved.logo_key, new RegExp(`^brand/${PROJECT}/[a-f0-9]{32}\\.png$`), 'random, versioned key under brand/');
  assert.deepEqual(
    [saved.logo_type, saved.logo_width, saved.logo_height, saved.accent, saved.footer, saved.hide_attribution],
    ['image/png', 300, 100, '#1f6feb', 'Made by <b>North</b> Studio', 0],
  );
  assert.equal(objects.get(saved.logo_key).type, 'image/png');
  const firstKey = saved.logo_key;
  const fileName = (key) => key.split('/').at(-1);
  const served = await b.logoResponse(PROJECT, fileName(firstKey));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('cache-control'), /public, max-age=31536000, immutable/);
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array(png));
  for (const [p, f] of [
    [PROJECT, '../../captures/owner/c1/capture.png'],
    ['../captures', fileName(firstKey)],
    [PROJECT, fileName(firstKey).toUpperCase()],
    [PROJECT, fileName(firstKey).replace('.png', '.svg')],
    ['prj_other', fileName(firstKey)],
  ])
    assert.equal((await b.logoResponse(p, f)).status, 404, `${p}/${f}`);

  let branded = await b.projectBranding(project);
  assert.deepEqual(
    [branded.logoUrl, branded.logoWidth, branded.accent, branded.accentInk, branded.attribution],
    [`/${firstKey}`, 300, '#1f6feb', '#ffffff', true],
  );

  // Plus cannot hide the attribution; Pro can; a downgrade shows it again.
  await assert.rejects(
    () => b.brandingAction(owner, form({ accent: '#1f6feb', hide_attribution: '1' })),
    (e) => e.status === 403 && e.type === 'plan_required' && /Pro and Business/.test(e.message),
  );
  assert.equal((await b.brandingRow(PROJECT)).hide_attribution, 0);
  db.prepare("UPDATE users SET plan='pro' WHERE id='owner'").run();
  await b.brandingAction({ project, role: 'editor' }, form({ accent: '#ffff00', hide_attribution: '1' }));
  saved = await b.brandingRow(PROJECT);
  assert.equal(saved.logo_key, firstKey, 'a save without a file keeps the logo');
  assert.equal(saved.hide_attribution, 1);
  branded = await b.projectBranding(project);
  assert.deepEqual([branded.attribution, branded.accentInk], [false, '#000000']);
  db.prepare("UPDATE users SET plan='plus' WHERE id='owner'").run();
  assert.equal((await b.projectBranding(project)).attribution, true);

  // Replacing deletes what it replaced, and the old URL stops resolving.
  await b.brandingAction(owner, form({ accent: '#1f6feb' }, file(webpAlpha, 'image/webp')));
  saved = await b.brandingRow(PROJECT);
  assert.match(saved.logo_key, /\.webp$/);
  assert.notEqual(saved.logo_key, firstKey);
  assert.ok(!objects.has(firstKey), 'the replaced object is deleted');
  assert.equal((await b.logoResponse(PROJECT, fileName(firstKey))).status, 404);
  assert.equal((await b.logoResponse(PROJECT, fileName(saved.logo_key))).headers.get('content-type'), 'image/webp');

  // A failed write leaves no object behind and the old logo in place.
  const current = saved.logo_key;
  failNextBatch = true;
  await assert.rejects(() => b.brandingAction(owner, form({}, file(jpeg, 'image/jpeg'))));
  assert.deepEqual(
    [...objects.keys()].filter((k) => k.startsWith('brand/')),
    [current],
    'the new object is removed when the row cannot be written',
  );
  assert.equal((await b.brandingRow(PROJECT)).logo_key, current);

  // Removal clears the row and deletes the object.
  await b.brandingAction(owner, form({ action: 'remove_logo' }));
  saved = await b.brandingRow(PROJECT);
  assert.deepEqual([saved.logo_key, saved.logo_type, saved.accent], ['', '', '#1f6feb']);
  assert.ok(!objects.has(current));
  assert.equal((await b.logoResponse(PROJECT, fileName(current))).status, 404);
  assert.equal((await b.projectBranding(project)).logoUrl, null);

  // Project deletion removes every logo object under the project, orphans included.
  objects.set(`brand/${PROJECT}/${'0'.repeat(32)}.png`, { bytes: new Uint8Array(png), type: 'image/png' });
  await b.deleteProjectLogos(PROJECT);
  assert.equal([...objects.keys()].filter((k) => k.startsWith(`brand/${PROJECT}/`)).length, 0);
  assert.equal(await b.deleteProjectLogos('../captures'), undefined);
  assert.ok(objects.has('captures/owner/c1/capture.png'), 'a crafted id cannot reach other prefixes');

  /* ---- The PDF carries the logo, accent, footer and sign-off, escaped. ---- */
  await b.brandingAction(owner, form({ accent: '#1f6feb', footer: 'Footer <script>alert(1)</script>' }, file(png, 'image/png')));
  db.prepare(`INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) VALUES('so_1','rep_1','approved','<b>Dana</b>','Ship it <img src=x>',?)`).run(
    '2026-10-02T16:00:00.000Z',
  );
  const pdf = await load('report-pdf', '?migrated');
  await pdf.reportPdf(project, report);
  assert.match(html, /<img class="logo" src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="">/);
  assert.match(html, /border-bottom:3px solid #1f6feb/);
  assert.match(html, /<footer>Footer &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/footer>/);
  assert.match(html, /\[ APPROVED \] by &lt;b&gt;Dana&lt;\/b&gt; · 2 Oct 2026, 16:00 UTC/);
  assert.match(html, /Ship it &lt;img src=x&gt;/);
  assert.ok(!/<script>|<b>Dana|<img src=x>/.test(html), 'nothing typed by a client or owner becomes markup');
  assert.ok(!html.includes('Easy Screen Capture'), 'PDF exports carry no attribution');

  /* ---- Account deletion takes the logos and rows with it. ---- */
  const logoKey = (await b.brandingRow(PROJECT)).logo_key;
  assert.ok(objects.has(logoKey));
  const accounts = await load('account-deletion', '?migrated');
  await accounts.deleteAccount('owner');
  assert.ok(!objects.has(logoKey), 'the logo object is deleted with the account');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_branding').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_signoffs').get().n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  console.log(
    'Report branding checks passed: magic-byte logo validation (PNG, JPEG, WebP; SVG, HTML and spoofed types refused), size and dimension limits, accent validation and contrast, footer limits, plan gating and downgrades, versioned R2 keys and serving headers, replacement and removal cleanup, the PDF, account deletion and the no-migration fallback.',
  );
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__branding;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
