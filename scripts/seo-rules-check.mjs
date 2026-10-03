/**
 * SEO monitor rules end to end, and the two times a check records quietly
 * instead of comparing.
 *
 * Three parts. The comparison (seo-signals.ts) is string-in/value-out and is
 * checked directly: normalisation, the order a detail reads in, and the signal
 * list a rule keeps in `selector`. The extraction runs inside the captured
 * page, so it is driven in local Chromium against a page served with real
 * response headers. And the check flow (watches.ts) runs against SQLite with
 * captures, mail, push and webhooks stubbed, for a baseline taken before the
 * SEO rule and one taken by an older capture engine — neither may alert.
 *
 *   node scripts/seo-rules-check.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, transformSync } from 'esbuild';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const directory = mkdtempSync(join(tmpdir(), 'seo-check-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const fixture = (globalThis.__seoFixture = { env: {}, state: {} });
let bundles = 0;

/**
 * Bundles a module of src with the Worker's `env`, and any sibling module named
 * in `stubs` (by file name), replaced.
 */
async function load(entry, stubs = {}) {
  const plugin = {
    name: 'seo-check-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const env = globalThis.__seoFixture.env;' }));
      for (const [name, contents] of Object.entries(stubs)) {
        builder.onLoad({ filter: new RegExp(`/lib/${name}\\.ts$`) }, () => ({ contents, loader: 'js' }));
      }
    },
  };
  const outfile = join(directory, `bundle-${++bundles}.mjs`);
  await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [plugin],
  });
  return import(pathToFileURL(outfile).href);
}

const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

const seo = await load('lib/seo-signals.ts');
const rules = await load('lib/monitor-rules.ts');
const httpLib = await load('lib/http.ts');
const IDS = seo.SEO_SIGNALS.map((signal) => signal.id);

/* -------------------------------------------------------------------------- */
/* Normalising                                                                 */
/* -------------------------------------------------------------------------- */

await section('a canonical that differs only in form is the same URL', () => {
  for (const [a, b] of [
    ['https://example.com/pricing/', 'https://example.com/pricing'],
    ['https://Example.COM/pricing', 'https://example.com/pricing'],
    ['https://example.com:443/pricing#plans', 'https://example.com/pricing'],
    ['//example.com/pricing', 'https://example.com/pricing'],
    ['https://example.com/', 'https://example.com'],
    ['  https://example.com/a  ', 'https://example.com/a'],
  ]) {
    assert.equal(seo.canonicalKey(a), seo.canonicalKey(b), `${a} is ${b}`);
  }
  for (const [a, b] of [
    ['https://example.com/pricing', 'https://example.com/Pricing'],
    ['https://example.com/a?page=2', 'https://example.com/a'],
    ['http://example.com/a', 'https://example.com/a'],
    ['https://www.example.com/a', 'https://example.com/a'],
    ['', 'https://example.com/a'],
  ]) {
    assert.notEqual(seo.canonicalKey(a), seo.canonicalKey(b), `${a} is not ${b}`);
  }
});

await section('robots directives: none, crawler scopes and valued directives', () => {
  const state = seo.robotsState;
  assert.deepEqual(state('index, follow'), { noindex: false, nofollow: false });
  assert.deepEqual(state(' NOINDEX '), { noindex: true, nofollow: false });
  assert.deepEqual(state('none'), { noindex: true, nofollow: true }, 'none is both');
  assert.deepEqual(state('googlebot: noindex'), { noindex: true, nofollow: false });
  assert.deepEqual(state('otherbot: noindex, nofollow'), { noindex: false, nofollow: false }, 'another crawler’s directives do not count');
  assert.deepEqual(state('otherbot: noindex\nnofollow'), { noindex: false, nofollow: true }, 'each header line starts unscoped');
  assert.deepEqual(
    state('unavailable_after: 25 Jun 2030 15:00:00 PST, nofollow'),
    { noindex: false, nofollow: true },
    'a valued directive is not a crawler name',
  );
  assert.deepEqual(state('max-snippet: -1, noindex'), { noindex: true, nofollow: false });
  assert.deepEqual(state(''), { noindex: false, nofollow: false });
});

/* -------------------------------------------------------------------------- */
/* Which signals a rule watches                                                */
/* -------------------------------------------------------------------------- */

await section('a rule keeps its signals in `selector`, empty meaning all', async () => {
  assert.equal(seo.encodeSeoSignals(IDS), '', 'all of them is stored as empty, so later signals are included');
  assert.equal(seo.encodeSeoSignals(['status', 'title', 'bogus']), 'title,status', 'in the form’s order, unknown ids dropped');
  assert.deepEqual(seo.decodeSeoSignals(''), IDS);
  assert.deepEqual(seo.decodeSeoSignals('robots, TITLE,someday'), ['title', 'robots'], 'a later version’s id is skipped');
  assert.deepEqual(seo.decodeSeoSignals('someday'), IDS, 'nothing known reads as all');

  const parse = (body) => rules.parseMonitorRule({ rule_kind: 'seo', ...body });
  assert.deepEqual(parse({}), { kind: 'seo', phrase: '', selector: '', region: '' }, 'no list means every signal');
  assert.equal(parse({ rule_seo_signals: 'robots,title' }).selector, 'title,robots');
  assert.equal(parse({ rule_selector: '.price' }).selector, '', 'a CSS selector is never taken for the list');
  assert.throws(() => parse({ rule_seo_signals: 'title,keywords' }), (error) => error.status === 400 && /keywords/.test(error.message));
  assert.throws(() => parse({ rule_seo_signals: '' }), (error) => error.status === 400);
  // The form sends a checkbox per signal and a marker that the boxes were shown.
  assert.equal(parse({ rule_seo_form: '1', rule_seo_title: '1', rule_seo_status: 'on' }).selector, 'title,status');
  assert.equal(parse({ rule_seo_form: '1', ...Object.fromEntries(IDS.map((id) => [`rule_seo_${id}`, '1'])) }).selector, '');
  assert.throws(() => parse({ rule_seo_form: '1' }), (error) => error.status === 400, 'ticking none is not all');
  // Other kinds ignore the boxes, and the app's own create body is still a visual rule.
  assert.equal(rules.parseMonitorRule({ rule_kind: 'element', rule_selector: '.price', rule_seo_form: '1' }).selector, '.price');
  assert.deepEqual(rules.parseMonitorRule({ url: 'https://example.com', frequency: 'daily', device: 'mobile', threshold: '1' }), rules.defaultRule);

  // A JSON array arrives as the comma list.
  const body = await httpLib.readBody(
    new Request('https://app.test/api/watches/w/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule_kind: 'seo', rule_seo_signals: ['robots', 'status'] }),
    }),
  );
  assert.equal(rules.parseMonitorRule(body).selector, 'robots,status');
});

/* -------------------------------------------------------------------------- */
/* Comparing                                                                   */
/* -------------------------------------------------------------------------- */

const signals = (over = {}) => ({
  title: 'Running shoes',
  description: 'Shoes for running.',
  canonical: 'https://shop.test/shoes',
  robots: 'index, follow',
  robots_header: '',
  h1: 'Running shoes',
  h1_count: 1,
  hreflang: [
    { lang: 'en', href: 'https://shop.test/shoes' },
    { lang: 'de', href: 'https://shop.test/de/shoes' },
  ],
  og: { title: 'Running shoes', description: 'Shoes', image: 'https://cdn.shop.test/shoes.jpg' },
  status: 200,
  ...over,
});
const compare = (before, after, selector = '') => seo.compareSeo({ seo: signals(before) }, { seo: signals(after) }, selector);
const detail = (before, after, selector) => compare(before, after, selector).detail;

await section('form-only differences are not changes', () => {
  assert.deepEqual(
    compare({}, {
      title: '  Running \n shoes ',
      canonical: 'https://SHOP.test/shoes/',
      hreflang: [
        { lang: 'DE', href: 'https://shop.test/de/shoes/' },
        { lang: 'en', href: 'https://shop.test/shoes' },
      ],
      robots: 'INDEX,FOLLOW',
    }),
    { changed: false, detail: 'No watched SEO signal changed.' },
  );
});

await section('each change is one line saying what it was and is', () => {
  assert.equal(detail({}, { title: 'Trail shoes' }), 'Title: "Running shoes" → "Trail shoes"');
  assert.equal(detail({}, { description: '' }), 'Meta description: "Shoes for running." → none');
  assert.equal(detail({}, { robots: 'index, nofollow' }), 'Robots: follow → nofollow', 'only the half that changed');
  assert.equal(detail({ robots: 'noindex' }, {}), 'Robots: noindex → index');
  assert.equal(detail({}, { robots: 'none' }), 'Robots: index, follow → noindex, nofollow');
  assert.equal(detail({}, { canonical: 'https://shop.test/sale' }), 'Canonical: https://shop.test/shoes → https://shop.test/sale');
  assert.equal(detail({}, { h1: 'Trail', h1_count: 2 }), 'H1: "Running shoes" → "Trail"; H1 count: 1 → 2');
  assert.equal(
    detail({}, { hreflang: [{ lang: 'en', href: 'https://shop.test/shoes' }, { lang: 'fr', href: 'https://shop.test/fr/shoes' }] }),
    'Hreflang: de removed, fr added',
  );
  assert.equal(
    detail({}, { hreflang: [{ lang: 'en', href: 'https://shop.test/shoes' }, { lang: 'de', href: 'https://shop.test/de/schuhe' }] }),
    'Hreflang: de https://shop.test/de/shoes → https://shop.test/de/schuhe',
  );
  assert.equal(
    detail({}, { og: { title: 'Running shoes', description: 'New', image: 'https://cdn.shop.test/new.jpg' } }),
    'OG description: "Shoes" → "New"; OG image: https://cdn.shop.test/shoes.jpg → https://cdn.shop.test/new.jpg',
  );
  assert.equal(detail({}, { status: 301 }), 'HTTP status: 200 → 301');
  const long = 'x'.repeat(200);
  assert.equal(detail({}, { title: long }), `Title: "Running shoes" → "${'x'.repeat(79)}…"`, 'long values are clipped');
  assert.ok(!detail({}, { title: 'A\nB', robots: 'noindex', status: 404 }).includes('\n'), 'one line, fit for an email subject');
});

await section('noindex appearing and an error status are called out first', () => {
  assert.equal(
    detail({}, { title: 'Gone', canonical: 'https://shop.test/', robots: 'noindex', status: 404 }),
    'HTTP status: 200 → 404; Robots: index → noindex; Canonical: https://shop.test/shoes → https://shop.test/; Title: "Running shoes" → "Gone"',
  );
  assert.equal(detail({}, { status: 301, robots: 'noindex' }), 'Robots: index → noindex; HTTP status: 200 → 301', 'a redirect is news, a noindex is worse');
  assert.equal(detail({}, { status: 503, robots: 'index, nofollow' }), 'HTTP status: 200 → 503; Robots: follow → nofollow');
  assert.equal(detail({ status: 404 }, { status: 500, title: 'Error' }), 'HTTP status: 404 → 500; Title: "Running shoes" → "Error"');
});

await section('X-Robots-Tag counts only when both captures saw the response', () => {
  assert.equal(detail({}, { robots_header: 'noindex' }), 'Robots: index → noindex (X-Robots-Tag header)');
  assert.equal(detail({}, { robots: 'noindex', robots_header: 'noindex' }), 'Robots: index → noindex', 'a meta tag says it already');
  assert.equal(compare({ robots_header: null }, { robots_header: 'noindex' }).changed, false, 'a baseline that could not see headers');
  assert.equal(detail({}, { robots_header: 'otherbot: noindex' }), 'No watched SEO signal changed.');
  assert.equal(detail({}, { robots: 'index, follow, noindex' }), 'Robots: index → noindex', 'googlebot’s meta tag is read with robots');
  assert.equal(compare({ status: null }, { status: 404 }).changed, false, 'no status to compare for inline HTML');
});

await section('only the chosen signals are compared', () => {
  const changes = { title: 'New', robots: 'noindex', status: 404 };
  assert.equal(detail({}, changes, 'title'), 'Title: "Running shoes" → "New"');
  assert.equal(detail({}, changes, 'robots,status'), 'HTTP status: 200 → 404; Robots: index → noindex');
  assert.equal(compare({}, { description: 'Other' }, 'title,robots').changed, false);
  assert.equal(compare({}, { og: { title: 'x', description: 'y', image: 'z' } }, 'og').changed, true);
});

await section('a baseline without signals records them instead of alerting', () => {
  const rule = { ...rules.defaultRule, kind: 'seo' };
  const after = { text: 'Shoes', seo: signals() };
  assert.equal(seo.SEO_RECORDED, 'SEO signals recorded; the next check compares them.');
  assert.deepEqual(rules.evaluateRule(rule, { text: 'Shoes' }, after), { changed: false, detail: seo.SEO_RECORDED });
  assert.deepEqual(rules.evaluateRule(rule, null, after), { changed: false, detail: seo.SEO_RECORDED }, 'nor when the baseline read no facts at all');
  assert.throws(() => rules.evaluateRule(rule, after, { text: 'Shoes' }), /SEO signals could not be read/);
  assert.throws(() => rules.evaluateRule(rule, after, null), /previous baseline has been kept/);
  assert.equal(rules.evaluateRule({ ...rule, selector: 'title' }, after, { seo: signals({ title: 'New' }) }).changed, true);
});

await section('the monitor page lists the watched signals as recorded', () => {
  assert.deepEqual(seo.describeSeo(signals({ robots_header: 'noindex' }), 'status,robots'), [
    { label: 'HTTP status', value: '200' },
    { label: 'Robots', value: 'noindex, follow · X-Robots-Tag: noindex' },
  ]);
  const all = seo.describeSeo(signals({ robots_header: null, status: null, description: '' }));
  assert.deepEqual(all.map((row) => row.label), [
    'HTTP status', 'Robots', 'Canonical', 'Title', 'Meta description', 'H1', 'Hreflang', 'OG title', 'OG description', 'OG image',
  ]);
  assert.equal(all.find((row) => row.label === 'HTTP status').value, 'not available');
  assert.equal(all.find((row) => row.label === 'Meta description').value, 'none');
  assert.equal(all.find((row) => row.label === 'H1').value, 'Running shoes · 1 on the page');
  assert.equal(all.find((row) => row.label === 'Hreflang').value, 'en, de');
});

/* -------------------------------------------------------------------------- */
/* Reading them in the page                                                    */
/* -------------------------------------------------------------------------- */

const transform = (name) =>
  transformSync(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code;
// Both import types only, which esbuild erases, so each stands alone.
writeFileSync(join(directory, 'page-facts.mjs'), transform('page-facts'));
writeFileSync(join(directory, 'redact-fn.mjs'), transform('redact-fn'));
const { buildFacts } = await import(pathToFileURL(join(directory, 'page-facts.mjs')).href);
const { PII_PATTERNS } = await import(pathToFileURL(join(directory, 'redact-fn.mjs')).href);
const readerScript = transformSync(readFileSync(new URL('../src/lib/page-facts-fn.ts', import.meta.url), 'utf8'), { loader: 'ts' })
  .code.replace(/^export\s+/gm, '');

const PAGE = `<!doctype html><html lang="en"><head>
  <title>  Orders   for ada@example.com </title>
  <meta name="description" content="Call +359 88 123 4567">
  <meta property="og:title" content="OG title"><meta property="og:description" content="OG description">
  <meta property="og:image" content="https://cdn.example.test/og.png">
  <meta name="robots" content="index, follow"><meta name="GoogleBot" content="noindex">
  <link rel="canonical" href="/pricing/">
  <link rel="alternate" hreflang="de" href="/de/pricing">
  <link rel="alternate" hreflang="EN" href="https://example.test/en/pricing">
  <link rel="alternate" hreflang="x-default" href="//cdn.example.test/pricing">
  <link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head><body>
  <h1 class="secret">Hidden heading</h1><h1>  Visible
  heading for ada@example.com </h1><h1>Second</h1><p>Body text</p>
</body></html>`;

const server = http
  .createServer((request, response) => {
    if (request.url === '/gone') {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Not found</title><h1>Not found</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noarchive' });
    response.end(PAGE);
  })
  .listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  /** Loads a path and reads it as the renderer does, with the response's own status and headers. */
  const read = async (path, request) => {
    const response = await page.goto(`${origin}${path}`);
    await page.addScriptTag({ content: readerScript });
    // The `hide` option is applied the same way before facts are read.
    await page.evaluate(() => document.querySelectorAll('.secret').forEach((node) => node.style.setProperty('display', 'none', 'important')));
    const raw = await page.evaluate((asked) => readFactsInPage(asked), request);
    return buildFacts({ raw, finalUrl: page.url(), status: response.status(), redirects: [], headers: response.headers() });
  };

  await section('the page’s SEO signals are read as a crawler resolves them', async () => {
    const facts = await read('/pricing/', { seo: true });
    assert.deepEqual(facts.seo, {
      title: 'Orders for ada@example.com',
      description: 'Call +359 88 123 4567',
      canonical: `${origin}/pricing/`,
      robots: 'index, follow, noindex',
      robots_header: 'noarchive',
      h1: 'Visible heading for ada@example.com',
      h1_count: 2,
      hreflang: [
        { lang: 'de', href: `${origin}/de/pricing` },
        { lang: 'en', href: 'https://example.test/en/pricing' },
        { lang: 'x-default', href: 'http://cdn.example.test/pricing' },
      ],
      og: { title: 'OG title', description: 'OG description', image: 'https://cdn.example.test/og.png' },
      status: 200,
    });
    assert.equal(seo.robotsState(facts.seo.robots).noindex, true, 'googlebot’s noindex is seen');
    assert.equal(seo.robotsState(facts.seo.robots_header).noindex, false);
  });

  await section('captures without an SEO rule read exactly what they did', async () => {
    const facts = await read('/pricing/');
    assert.equal(facts.seo, undefined);
    assert.equal('seo' in (await page.evaluate(() => readFactsInPage({ phrases: ['Body'] }))), false);
  });

  await section('redaction covers the SEO signals it covers elsewhere', async () => {
    const facts = await read('/pricing/', { seo: true, redact: PII_PATTERNS.map(({ source, flags }) => ({ source, flags })) });
    assert.doesNotMatch(facts.seo.title, /@/);
    assert.doesNotMatch(facts.seo.h1, /@/);
    assert.doesNotMatch(facts.seo.description, /123 4567/);
    assert.equal(facts.seo.h1.startsWith('Visible heading for '), true, 'only the address is covered');
  });

  await section('two real reads compare into an alert, the 404 first', async () => {
    const before = await read('/pricing/', { seo: true });
    const after = await read('/gone', { seo: true });
    assert.equal(after.seo.status, 404);
    assert.equal(after.seo.robots_header, '', 'a response without the header');
    const result = seo.compareSeo(before, after, 'status,title,canonical');
    assert.equal(result.changed, true);
    assert.equal(
      result.detail,
      `HTTP status: 200 → 404; Canonical: ${origin}/pricing/ → none; Title: "Orders for ada@example.com" → "Not found"`,
    );
  });
} finally {
  await browser.close();
  server.close();
}

/* -------------------------------------------------------------------------- */
/* The check flow                                                              */
/* -------------------------------------------------------------------------- */

const db = new DatabaseSync(':memory:');
// Every migration but 0016: these are the comparisons a full check makes, so
// each check here renders, as it does before smart checks exist. Reading the
// page first, and when that leaves the browser to decide, is fast-checks-check's.
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort().filter((name) => name.endsWith('.sql'))) {
  if (file === '0016_watch_fast_checks.sql') continue;
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO users (id,email,email_lower,name,plan,period_start,created_at,updated_at) VALUES ('owner','owner@example.test','owner@example.test','Owner','pro',?,?,?)`,
).run(now, now, now);

const statement = (sql, args = []) => ({
  sql,
  args,
  bind: (...values) => statement(sql, values),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: db.prepare(sql).run(...args) }),
});
fixture.env.DB = {
  prepare: (sql) => statement(sql),
  batch: async (statements) => {
    db.exec('BEGIN');
    try {
      const results = statements.map((query) => ({ meta: db.prepare(query.sql).run(...query.args) }));
      db.exec('COMMIT');
      return results;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
};
const state = Object.assign(fixture.state, {
  device: 'desktop',
  engine: undefined,
  facts: null,
  changedPct: 0,
  changedPixels: 0,
  lastOptions: null,
  emails: [],
  webhooks: [],
  pushes: [],
});
let captureCount = 0;
/** A stored capture as runCapture leaves it; `engine` undefined is one from before the marker. */
const storeCapture = (over = {}) => {
  // Spread rather than defaults: `engine: undefined` has to mean unmarked, not "as before".
  const { device, engine, facts } = { device: state.device, engine: state.engine, facts: state.facts, ...over };
  const id = `cap-${++captureCount}`;
  const files = JSON.stringify([{ key: `k/${id}`, name: 'capture.png', bytes: 1, width: 390, height: 844, ...(engine ? { engine } : {}) }]);
  db.prepare(
    `INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,share_token,files,created_at,facts)
     VALUES (?,'owner','https://shop.test/','shop.test',?,390,844,'fullpage','png','done','t',?,?,?)`,
  ).run(id, device, files, new Date().toISOString(), facts ? JSON.stringify(facts) : null);
  return db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
};
fixture.captures = {
  getUsage: async () => ({ remaining: 1000 }),
  createCaptureRow: async (_user, options) => {
    state.lastOptions = options;
    return storeCapture();
  },
  runCapture: async (row) => row,
  fileUrl: (row) => `https://fixture.test/${row.id}.png`,
  safeParseFiles: JSON.parse,
};
const watches = await load('lib/watches.ts', {
  captures: 'export const {getUsage,createCaptureRow,runCapture,fileUrl,safeParseFiles} = globalThis.__seoFixture.captures;',
  'visual-diff':
    'export const diffAvailable = () => true; export async function compareImages(){const s=globalThis.__seoFixture.state;return {changedPct:s.changedPct,changedPixels:s.changedPixels,sharedPct:s.changedPct,resized:false}}',
  mailer: 'export const canSendEmail = () => true; export async function sendMail(mail){globalThis.__seoFixture.state.emails.push(mail);return true}',
  summarise: 'export async function summariseChange(){return {sentence:"",detail:"",source:"plain"}}',
  push: 'export async function pushQueueStatement(runId){globalThis.__seoFixture.state.pushes.push(runId);return null} export async function drainPush(){}',
});
const engineModule = await load('lib/capture-engine.ts');
const { decodeRunDetail } = await load('lib/monitor-health.ts');

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  state.webhooks.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(null, { status: 204 });
};
const user = { id: 'owner', plan: 'pro' };
const options = (device) => ({
  url: 'https://shop.test/',
  host: 'shop.test',
  device,
  width: 390,
  height: 844,
  scale: 3,
  mode: 'fullpage',
  format: 'png',
  hide: [],
  ignoreRegions: [],
});
const create = (device, rule) =>
  watches.createWatch(user, {
    options: options(device),
    rule,
    label: 'Shop',
    frequency: 'daily',
    threshold: 1,
    notifyEmail: true,
    webhookUrl: 'https://hooks.example.test/seo',
  });
const check = async (id) => watches.runWatch(await watches.getWatch(id), 'https://fixture.test');
const lastRun = (id) => {
  const run = db.prepare('SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
  return { ...run, ...decodeRunDetail(run.detail) };
};
const quiet = () => ({ emails: state.emails.length, webhooks: state.webhooks.length, pushes: state.pushes.length });

try {
  await section('an SEO monitor records first, then alerts on what changed', async () => {
    Object.assign(state, { device: 'desktop', engine: engineModule.CAPTURE_ENGINE, facts: { text: 'Shoes' } });
    const watch = await create('desktop', { kind: 'seo', phrase: '', selector: 'title,robots,status', region: '' });
    await check(watch.id);
    assert.equal(state.lastOptions.monitorSeo, true, 'the capture is asked for SEO signals');
    assert.equal(state.lastOptions.monitorSelector, undefined, 'the signal list is not a CSS selector');
    assert.equal(state.lastOptions.monitorPhrases, undefined);

    // The baseline predates the rule: no signals to compare, so this check records them.
    state.facts = { text: 'Shoes', seo: signals() };
    const before = quiet();
    let outcome = await check(watch.id);
    assert.deepEqual([outcome.status, outcome.changed, outcome.detail], ['done', false, seo.SEO_RECORDED]);
    assert.deepEqual(quiet(), before, 'no email, webhook or push');
    let run = lastRun(watch.id);
    assert.deepEqual([run.changed, run.detail, run.delivery.email], [0, seo.SEO_RECORDED, 'not_needed']);

    // Unwatched signals may change freely.
    state.facts = { text: 'Shoes', seo: signals({ description: 'Different', h1: 'Other' }) };
    outcome = await check(watch.id);
    assert.deepEqual([outcome.changed, outcome.detail], [false, 'No watched SEO signal changed.']);

    state.facts = { text: 'Shoes', seo: signals({ description: 'Different', h1: 'Other', title: 'Sale', robots: 'noindex' }) };
    outcome = await check(watch.id);
    assert.equal(outcome.changed, true);
    assert.equal(outcome.detail, 'Robots: index → noindex; Title: "Running shoes" → "Sale"');
    assert.equal(state.emails.at(-1).subject, 'Shop: Robots: index → noindex; Title: "Running shoes" → "Sale"');
    const hook = state.webhooks.at(-1);
    assert.deepEqual(hook.body.rule, { kind: 'seo', detail: outcome.detail }, 'the webhook names the rule and what it found');
    assert.equal(hook.body.event, 'watch.changed', 'the payload is otherwise as it was');
    assert.equal(state.pushes.length, before.pushes + 1, 'an alert is pushed as any other');
    run = lastRun(watch.id);
    assert.equal(run.changed, 1);
    assert.equal((await watches.getWatch(watch.id)).baseline_capture_id, run.capture_id);
  });

  await section('a baseline from an older capture engine is refreshed without an alert', async () => {
    const watch = await create('mobile');
    // Taken before the engine marker existed, with the HeadlessChrome identity.
    const old = storeCapture({ device: 'mobile', engine: undefined, facts: { text: 'Shoes' } });
    db.prepare('UPDATE watches SET baseline_capture_id = ? WHERE id = ?').run(old.id, watch.id);
    Object.assign(state, { device: 'mobile', engine: engineModule.CAPTURE_ENGINE, changedPct: 60, changedPixels: 9000 });
    const before = quiet();
    let outcome = await check(watch.id);
    assert.deepEqual([outcome.status, outcome.changed, outcome.detail], ['done', false, 'Baseline refreshed after a capture engine update']);
    assert.equal(state.lastOptions.monitorSeo, false, 'a visual monitor asks for no SEO signals');
    assert.deepEqual(quiet(), before, 'no email, webhook or push');
    let run = lastRun(watch.id);
    assert.equal(run.changed, 0);
    assert.equal(run.baseline_capture_id, null, 'nothing was compared');
    assert.equal(run.change_pct, null);
    assert.equal(run.delivery.email, 'not_needed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_retries WHERE run_id = ?').get(run.id).n, 0);
    const refreshed = await watches.getWatch(watch.id);
    assert.equal(refreshed.baseline_capture_id, run.capture_id, 'the new capture is the baseline');
    assert.equal(refreshed.last_error, null);
    assert.equal(refreshed.consecutive_errors, 0);

    // Once: the next check compares, and a real change alerts.
    outcome = await check(watch.id);
    assert.equal(outcome.changed, true);
    assert.equal(state.emails.length, before.emails + 1);
    run = lastRun(watch.id);
    assert.equal(run.baseline_capture_id, refreshed.baseline_capture_id);
  });

  await section('an engine change refreshes only the baselines it reaches', async () => {
    // Engine 2 changed the handheld identities; a desktop baseline from engine 1 still compares.
    const desktop = await create('desktop');
    const old = storeCapture({ device: 'desktop', engine: undefined });
    db.prepare('UPDATE watches SET baseline_capture_id = ? WHERE id = ?').run(old.id, desktop.id);
    Object.assign(state, { device: 'desktop', changedPct: 60, changedPixels: 9000 });
    const outcome = await check(desktop.id);
    assert.equal(outcome.changed, true, 'a desktop page that changed still alerts');
    assert.equal(lastRun(desktop.id).baseline_capture_id, old.id);

    const { shouldRefreshBaseline, ENGINE_CHANGES, CAPTURE_ENGINE } = engineModule;
    const file = (engine) => JSON.stringify([{ key: 'k', name: 'capture.png', ...(engine ? { engine } : {}) }]);
    assert.equal(shouldRefreshBaseline({ files: file(), device: 'tablet' }), true);
    assert.equal(shouldRefreshBaseline({ files: file(), device: 'mobile' }), true);
    assert.equal(shouldRefreshBaseline({ files: file(), device: 'desktop' }), false);
    assert.equal(shouldRefreshBaseline({ files: file(CAPTURE_ENGINE), device: 'mobile' }), false);
    assert.equal(shouldRefreshBaseline({ files: 'not json', device: 'mobile' }), true, 'an unreadable manifest counts as unmarked');
    // A later change only has to say what it reaches.
    ENGINE_CHANGES.push({ version: CAPTURE_ENGINE + 1, what: 'fixture', reaches: () => true });
    try {
      assert.equal(shouldRefreshBaseline({ files: file(CAPTURE_ENGINE), device: 'desktop' }), true);
      assert.equal(shouldRefreshBaseline({ files: file(CAPTURE_ENGINE + 1), device: 'desktop' }), false);
    } finally {
      ENGINE_CHANGES.pop();
    }
  });

  await section('an SEO monitor on an old mobile baseline refreshes before it compares', async () => {
    const watch = await create('mobile', { kind: 'seo', phrase: '', selector: '', region: '' });
    const old = storeCapture({ device: 'mobile', engine: undefined, facts: { text: 'Shoes', seo: signals() } });
    db.prepare('UPDATE watches SET baseline_capture_id = ? WHERE id = ?').run(old.id, watch.id);
    Object.assign(state, { device: 'mobile', engine: engineModule.CAPTURE_ENGINE, facts: { text: 'Shoes', seo: signals({ title: 'Mobile title' }) } });
    const before = quiet();
    assert.equal((await check(watch.id)).detail, 'Baseline refreshed after a capture engine update', 'the engine, not the page, changed the title');
    assert.deepEqual(quiet(), before);
    assert.equal((await check(watch.id)).detail, 'No watched SEO signal changed.');
  });
} finally {
  globalThis.fetch = realFetch;
  db.close();
}

console.log(`\nall ${passed.length} checks passed`);
