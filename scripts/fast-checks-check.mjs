/**
 * Smart checks: rule-based monitors that read their page before rendering it.
 *
 * The HTML reader (src/lib/fast-extract.ts) runs in workerd, through
 * Miniflare, against the real HTMLRewriter. Its selector subset, its undecoded
 * text chunks and its lack of a tree are exactly what decide whether a fast
 * check reads the right thing, and a stand-in parser written here would only
 * repeat the reader's own assumptions back to it. Everything else runs in
 * Node: the safe fetch against a stubbed fetch, the learning rules as pure
 * functions, and the check flow against SQLite — with migration 0016 and
 * without it — where the reader's calls go to the same workerd. The browser,
 * the quota and mail are stubbed. No network calls, no real alerts.
 *
 *   node scripts/fast-checks-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// Installed with wrangler, which runs this same workerd for `astro dev`.
import { Miniflare } from 'miniflare';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'fast-checks-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};
const ORIGIN = 'https://app.example.test';

/* -------------------------------------------------------------------------- */
/* The reader, in workerd                                                      */
/* -------------------------------------------------------------------------- */

const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))[1];
const readerModule = await build({
  entryPoints: [join(root, 'src/lib/fast-extract.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'fast-extract',
        compatibilityDate,
        manifest: {
          mainModule: 'index.mjs',
          modules: {
            'fast-extract.mjs': { type: 'esm', contents: readerModule.outputFiles[0].text },
            'index.mjs': {
              type: 'esm',
              contents: `import { extractFast } from './fast-extract.mjs';
                export default { async fetch(request) {
                  const { rule, page, hide } = await request.json();
                  return Response.json(await extractFast(rule, page, { hide }));
                } };`,
            },
          },
        },
      },
    },
  ],
});

/** extractFast in workerd. Headers travel as a plain object, which the reader takes as readily as Headers. */
async function inWorkerd(rule, page, hide = []) {
  const headers = page.headers instanceof Headers ? Object.fromEntries(page.headers) : page.headers;
  const response = await mf.dispatchFetch('http://reader/', {
    method: 'POST',
    body: JSON.stringify({ rule: { phrase: '', selector: '', region: '', ...rule }, page: { ...page, headers }, hide }),
  });
  return response.json();
}
const HTML = { 'content-type': 'text/html; charset=utf-8' };
const read = (rule, html, page = {}) =>
  inWorkerd(rule, { html, status: 200, headers: HTML, url: 'https://shop.example.test/item', truncated: false, ...page }, page.hide);

/* -------------------------------------------------------------------------- */
/* Bundles, databases and bindings                                             */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__fc = {
  env: {},
  state: null,
  extract: (rule, page, hide) => inWorkerd(rule, page, hide),
});

/** The lib stubs every bundle shares; `captures` is left real when it is the module under test. */
const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__fc.env;',
  '/lib/captures.ts': `const s = () => globalThis.__fc.state;
    export const getUsage = async () => ({ used: s().spent, viaApp: 0, viaApi: 0, viaWatch: s().spent, quota: 2000,
      remaining: Math.max(0, s().remaining), period: '2026-10', daysLeft: 20, renewsOn: '2026-11-01' });
    export async function createCaptureRow(user, options) {
      if (s().remaining <= 0) throw Object.assign(new Error('You have used all your screenshots.'), { type: 'quota_exceeded', status: 402 });
      s().remaining--; s().spent++;
      const id = 'cap_' + (++s().captures);
      const site = s().sites.get(options.url);
      s().renders.push({ url: options.url, options });
      s().db.prepare("INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,source,share_token,files,created_at,duration_ms,facts) VALUES (?,?,?,'example.test',?,1440,900,'fullpage','png','done','watch',?,?,?,900,?)")
        .run(id, user.id, options.url, options.device, 'tok-' + id, JSON.stringify([{ name: 'capture.png', key: 'captures/' + user.id + '/' + id + '/capture.png', width: 1440, height: 900, bytes: 10, engine: 2 }]),
          new Date().toISOString(), site?.facts ? JSON.stringify(site.facts) : null);
      return s().db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    }
    export async function runCapture(row) {
      s().rendering++; s().maxRendering = Math.max(s().maxRendering, s().rendering);
      await new Promise((resolve) => setTimeout(resolve, s().renderMs));
      s().rendering--;
      return row;
    }
    export const fileUrl = (row, file, origin) => origin + '/f/' + row.id + '/' + file.name + '?t=' + row.share_token;
    export const safeParseFiles = (raw) => { try { const f = JSON.parse(raw); return Array.isArray(f) ? f : []; } catch { return []; } };`,
  '/lib/visual-diff.ts': `export function diffAvailable() { return true; }
    export async function compareImages() { const s = globalThis.__fc.state; s.compares++;
      return { changedPct: s.changedPct, changedPixels: s.changedPct ? 1 : 0, sharedPct: s.changedPct, resized: false, width: 1440, height: 900, regions: [] }; }`,
  '/lib/mailer.ts': 'export function canSendEmail(){return true} export async function sendMail(mail){globalThis.__fc.state.mails.push(mail);return true}',
  '/lib/summarise.ts': 'export async function summariseChange(){return {sentence:"",detail:"",source:"plain"}}',
  '/lib/renderer.ts': 'export async function render(){throw new Error("no renderer in tests")}',
  '/lib/apple-billing.ts': 'export async function refreshAppleUser(){} export async function refreshAppleSubscriptions(){}',
};

/**
 * The reader inside these bundles is the real module with extractFast handed
 * to workerd: same source, same exports, the parsing done by HTMLRewriter.
 */
const readerSource = readFileSync(join(root, 'src/lib/fast-extract.ts'), 'utf8');
assert.ok(readerSource.includes('export async function extractFast('), 'the reader still exports extractFast');
const proxiedReader =
  readerSource.replace('export async function extractFast(', 'async function extractHere(') +
  '\nexport const extractFast = (rule: MonitorRule, page: RawPage, options: ExtractOptions = {}) =>' +
  ' (globalThis as any).__fc.extract(rule, page, options.hide ?? []) as Promise<FastRead>;\n';

const plugin = {
  name: 'fast-checks-stubs',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUBS['cloudflare:workers'], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
    b.onLoad({ filter: /\/lib\/fast-extract\.ts$/ }, () => ({ contents: proxiedReader, loader: 'ts', resolveDir: join(root, 'src/lib') }));
  },
};

let bundles = 0;
/** A fresh copy of a module, with its own per-isolate probe caches, as a new isolate would have. */
async function load(entry, extraPlugins = []) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [...extraPlugins, plugin],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

function database({ fast = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!fast && file === '0016_watch_fast_checks.sql') continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  const now = new Date().toISOString();
  for (const [id, plan] of [['owner', 'pro'], ['plus', 'plus'], ['free', 'free']]) {
    db.prepare(`INSERT INTO users (id,email,email_lower,name,plan,period_start,created_at,updated_at) VALUES (?,?,?,'Pilot',?,?,?,?)`)
      .run(id, `${id}@example.test`, `${id}@example.test`, plan, now, now, now);
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

/** A fresh world: database, bindings, the sites the stubbed fetch serves and what the stubbed browser sees. */
function world({ fast = true } = {}) {
  const db = database({ fast });
  fx.state = {
    db,
    sites: new Map(),
    fetches: [],
    fetchMs: 0,
    fetching: 0,
    maxFetching: 0,
    renders: [],
    renderMs: 0,
    rendering: 0,
    maxRendering: 0,
    captures: 0,
    compares: 0,
    changedPct: 0,
    remaining: 1000,
    spent: 0,
    mails: [],
  };
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, {
    DB: d1(db),
    BROWSER: {},
    SHOTS: { put: async () => undefined, delete: async () => undefined, head: async () => null },
    RATE: { get: async () => null, put: async () => undefined },
    CAPTURE_HOST_DENYLIST: '',
    REQUIRE_EMAIL_VERIFICATION: '0',
  });
  return fx.state;
}

/** What one URL serves to a plain request, and what the browser makes of it. */
function site(url, { html = '<p>Hello</p>', status = 200, headers = HTML, facts }) {
  fx.state.sites.set(url, { html, status, headers, facts });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const s = fx.state;
  s.fetches.push({ url, init });
  const page = s.sites.get(url);
  if (typeof page?.respond === 'function') return page.respond(init);
  if (!page) throw new TypeError('fetch failed');
  s.fetching++;
  s.maxFetching = Math.max(s.maxFetching, s.fetching);
  try {
    if (s.fetchMs) await new Promise((resolve) => setTimeout(resolve, s.fetchMs));
    return new Response(page.html, { status: page.status, headers: page.headers });
  } finally {
    s.fetching--;
  }
};

/** Browser facts for a phrase rule: the visible text, and the answer the page itself gave for the phrase. */
const phraseFacts = (text, phrase, found) => ({ text, text_length: text.length, text_hash: `h:${text}`, phrases: { [phrase]: found } });

try {
  /* ------------------------------------------------------------------------ */
  /* Reading HTML                                                              */
  /* ------------------------------------------------------------------------ */

  await section('phrases are read from the visible text, never from scripts, styles, templates or noscript', async () => {
    let r = await read(
      { kind: 'appeared', phrase: 'Back in stock' },
      `<p>Sold out</p><script>const label = "Back in stock";</script><style>.x::after{content:"Back in stock"}</style>
       <template><p>Back in stock</p></template><noscript>Back in stock</noscript><!-- Back in stock --><title>Back in stock</title>`,
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.values.found, false);
    r = await read({ kind: 'appeared', phrase: 'back  IN stock' }, '<p>Back <b>in</b>\n stock</p>');
    assert.equal(r.values.found, true, 'case and whitespace do not matter; inline tags join words as on screen');
    r = await read({ kind: 'disappeared', phrase: 'Tom & Jerry show' }, '<p>Tom &amp; Jerry&nbsp;show</p>');
    assert.equal(r.values.found, true, 'entities are decoded');
    r = await read({ kind: 'appeared', phrase: '<b>' }, '<p>&amp;lt;b&gt;</p>');
    assert.equal(r.values.found, false, 'decoded once, as a browser does: &amp;lt; is "&lt;" on screen');
    r = await read({ kind: 'appeared', phrase: 'freeshipping' }, '<ul><li>Free</li><li>shipping</li></ul>');
    assert.equal(r.values.found, false, 'block elements break words apart');
    r = await read({ kind: 'appeared', phrase: 'Cookie' }, '<div class="banner">Cookie notice</div><p>Body</p>', { hide: ['.banner'] });
    assert.equal(r.values.found, false, "the monitor's hidden elements are left out, as the browser removes them");
    r = await read({ kind: 'appeared', phrase: 'Body' }, '<p class="banner">Cookie notice<p>Body</p></body>', { hide: ['.banner'] });
    assert.equal(r.values.found, true, 'hiding an element whose end tag is implied never swallows the rest of the page');
    r = await read({ kind: 'appeared', phrase: 'x' }, '<p>x</p>', { hide: ['.a + .b'] });
    assert.deepEqual([r.ok, r.code], [false, 'hide_unsupported']);

    const a = await read({ kind: 'text' }, '<p>Price  list</p><script>window.nonce = 1</script>');
    const b = await read({ kind: 'text' }, '<p>Price list</p>\n<script>window.nonce = 2</script>');
    const c = await read({ kind: 'text' }, '<p>Price lists</p>');
    assert.equal(a.signature, b.signature, 'whitespace and script contents do not move a text signature');
    assert.notEqual(a.signature, c.signature, 'the text does');
    assert.match(a.signature, /^[0-9a-f]{64}$/);
    const x = await read({ kind: 'appeared', phrase: 'one' }, '<p>none here</p>'.replace('one', 'xyz'));
    const y = await read({ kind: 'appeared', phrase: 'two' }, '<p>none here</p>'.replace('one', 'xyz'));
    assert.deepEqual([x.values, y.values], [{ found: false }, { found: false }]);
    assert.notEqual(x.signature, y.signature, "the rule is part of the signature: another phrase's reading never matches");
  });

  await section('selectors: what HTMLRewriter supports is read, what it does not, or cannot find, is unavailable', async () => {
    let r = await read(
      { kind: 'price', selector: '.price' },
      '<template><span class="price">€ 1</span></template><span class="price">€ 19,99 <s>€ 25</s></span><span class="price">€ 5</span>',
    );
    assert.equal(r.values.numbers, '19,99|25', 'the first match outside templates, numbers as price rules compare them');
    r = await read({ kind: 'element', selector: '#stock' }, '<div id="stock"> In  stock: <b>4</b> &amp; more</div>');
    assert.equal(r.values.text, 'In stock: 4 & more');
    r = await read({ kind: 'element', selector: 'ul > li:nth-child(2)' }, '<ul><li>a</li><li>b</li></ul>');
    assert.equal(r.values.text, 'b', 'child combinators and :nth-child are supported');
    r = await read({ kind: 'element', selector: 'input[name=q]' }, '<input name="q" value="x"><p>after</p>');
    assert.deepEqual([r.ok, r.values.text], [true, ''], 'a void element is found, with no text');
    for (const selector of ['li + li', 'li ~ li', 'a:has(img)', 'p::first-line', 'a:hover']) {
      r = await read({ kind: 'element', selector }, '<ul><li>a</li><li>b</li></ul>');
      assert.deepEqual([r.ok, r.code], [false, 'selector_unsupported'], selector);
      assert.ok(r.reason.includes(selector));
    }
    r = await read({ kind: 'price', selector: '.price' }, '<div id="app"></div><script src="/app.js"></script>');
    assert.deepEqual([r.ok, r.code], [false, 'selector_missing'], 'a selector missing from the HTML is never a change');
    r = await read({ kind: 'element', selector: '#a' }, '<p id="a">x</p><p>and then the cut', { truncated: true });
    assert.equal(r.values.text, 'x', 'an element closed before the byte cap still reads');
    r = await read({ kind: 'text' }, '<p>x</p>', { truncated: true });
    assert.deepEqual([r.ok, r.code], [false, 'too_large'], 'a text rule cannot read a page cut short');
  });

  await section('SEO: every signal seo-signals compares, from the raw HTML, the status and the headers', async () => {
    const page = `<!doctype html><html lang="en"><head>
      <title>  Spring   sale &amp; more </title>
      <base href="https://shop.example.test/en/">
      <meta name="description" content="Save &quot;big&quot;"><meta name="description" content="second">
      <link rel="Canonical" href="sale/">
      <meta name="robots" content="index, follow"><meta name="GOOGLEBOT" content="noindex">
      <link rel="alternate" hreflang="DE" href="/de/sale"><link rel="alternate stylesheet" href="/x.css">
      <link rel="alternate" hreflang="fr" href="//shop.example.test/fr/sale/">
      <meta property="og:title" content="OG sale"><meta property="og:description" content="OG desc">
      <meta property="og:image" content="/img/sale.png"><meta property="og:title" content="second">
      </head><body><svg><title>Logo</title></svg><template><h1>Draft</h1><meta name="robots" content="nofollow"></template>
      <h1>Spring <em>sale</em></h1><h1>Again</h1></body></html>`;
    const headers = { ...HTML, 'x-robots-tag': 'googlebot: nofollow' };
    const r = await read({ kind: 'seo', selector: '' }, page, { headers });
    assert.deepEqual(r.values, {
      title: 'Spring sale & more',
      description: 'Save "big"',
      canonical: 'https://shop.example.test/en/sale',
      robots: 'noindex,nofollow',
      h1: 'Spring sale',
      h1_count: 2,
      hreflang: ['de https://shop.example.test/de/sale', 'fr https://shop.example.test/fr/sale'],
      og_title: 'OG sale',
      og_description: 'OG desc',
      og_image: '/img/sale.png',
      status: 200,
    });
    assert.deepEqual(r.html, { canonical: 'https://shop.example.test/en/sale/', noindex: true }, 'what the HTML itself says, for the notes');

    const swapped = page.replace('hreflang="DE" href="/de/sale"', 'hreflang="xx" href="/xx"').replace('hreflang="fr"', 'hreflang="de"').replace('hreflang="xx" href="/xx"', 'hreflang="fr" href="/fr/sale"');
    const again = await read({ kind: 'seo', selector: '' }, swapped.replace('//shop.example.test/fr/sale/', '/de/sale'), { headers });
    assert.deepEqual(again.values.hreflang, r.values.hreflang, 'alternates are a set');
    assert.equal(again.signature, r.signature, 'so their order never moves the signature');

    const titleOnly = await read({ kind: 'seo', selector: 'title' }, page, { headers });
    const otherDescription = await read({ kind: 'seo', selector: 'title' }, page.replace('Save &quot;big&quot;', 'Other'), { headers });
    assert.deepEqual(titleOnly.values, { title: 'Spring sale & more' }, 'only the watched signals are read');
    assert.equal(titleOnly.signature, otherDescription.signature, 'and only they move the signature');

    let s = await read({ kind: 'seo', selector: 'status,title' }, '<title>Gone</title>', { status: 404 });
    assert.deepEqual(s.values, { title: 'Gone', status: 404 }, 'a 404 is news to a rule watching the status');
    s = await read({ kind: 'seo', selector: 'status' }, '<title>Down</title>', { status: 500 });
    assert.deepEqual([s.ok, s.values?.status], [true, 500], 'so is a 500');
    s = await read({ kind: 'seo', selector: 'title' }, '<title>Down</title>', { status: 500 });
    assert.deepEqual([s.ok, s.code], [false, 'server_error'], 'for any other rule a server error is unavailable');
    s = await read({ kind: 'text' }, '<p>Not found</p>', { status: 404 });
    assert.equal(s.ok, true, 'a 404 page is read like any other: the browser sees it too');
  });

  await section('bot checks and responses about the request, not the page, are unavailable', async () => {
    const cloudflare =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-body"></div>' +
      '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script></body></html>';
    const cases = [
      [{ kind: 'text' }, cloudflare, { status: 403 }, 'challenge'],
      [{ kind: 'text' }, cloudflare, { status: 503 }, 'challenge'],
      [{ kind: 'seo', selector: 'status' }, cloudflare, { status: 503 }, 'challenge'],
      [{ kind: 'text' }, '<p>fine</p>', { headers: { ...HTML, 'cf-mitigated': 'challenge' } }, 'challenge'],
      [{ kind: 'text' }, '<script src="https://ct.captcha-delivery.com/c.js"></script>', { status: 403 }, 'challenge'],
      [{ kind: 'text' }, '<div id="px-captcha"></div>', { status: 403 }, 'challenge'],
      [{ kind: 'text' }, '<iframe src="/_Incapsula_Resource?SWJIYLWA=1"></iframe>', { status: 403 }, 'challenge'],
      [{ kind: 'text' }, '<h1>Access Denied</h1><p>Reference #18.1 https://errors.edgesuite.net/18.1</p>', { status: 403 }, 'challenge'],
      [{ kind: 'text' }, '<p>Too many</p>', { status: 429, headers: { ...HTML, 'x-amzn-waf-action': 'captcha' } }, 'challenge'],
      [{ kind: 'text' }, '<h1>Forbidden</h1>', { status: 403 }, 'refused'],
      [{ kind: 'seo', selector: 'status' }, '<h1>Forbidden</h1>', { status: 403 }, 'refused'],
      [{ kind: 'text' }, '<h1>Slow down</h1>', { status: 429 }, 'refused'],
      [{ kind: 'text' }, '<h1>Sign in</h1>', { status: 401 }, 'refused'],
      [{ kind: 'text' }, '{"ok":true}', { headers: { 'content-type': 'application/json' } }, 'not_html'],
    ];
    for (const [rule, html, page, code] of cases) {
      const r = await read(rule, html, page);
      assert.deepEqual([r.ok, r.code], [false, code], `${JSON.stringify(page)} ${html.slice(0, 40)}`);
      assert.ok(r.reason && !r.reason.endsWith('.'), 'a reason in plain words, without a full stop, for the status line');
    }
    const normal = await read(
      { kind: 'text' },
      '<p>Welcome</p><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
    );
    assert.equal(normal.ok, true, "Cloudflare's script on an ordinary page is not a challenge");
  });

  /* ------------------------------------------------------------------------ */
  /* The safe fetch                                                            */
  /* ------------------------------------------------------------------------ */

  world();
  const fc = await load('src/lib/fast-checks.ts');
  const limits = { ...fc.FAST_FETCH };

  await section('the safe fetch: public addresses only, on the first request and every redirect, and the denylist', async () => {
    const s = fx.state;
    for (const url of ['http://127.0.0.1/admin', 'http://localhost:8080/', 'http://[::ffff:127.0.0.1]/', 'http://10.1.2.3/', 'http://metadata.google.internal/']) {
      s.fetches.length = 0;
      const r = await fc.fetchPage(url, 'desktop');
      assert.deepEqual([r.ok, r.code], [false, 'blocked'], url);
      assert.equal(s.fetches.length, 0, `${url} is never requested`);
    }
    const hop = (location, status = 302) => ({ respond: async () => new Response(null, { status, headers: { location } }) });
    s.sites.set('https://shop.example.test/start', hop('http://10.0.0.5/internal'));
    s.fetches.length = 0;
    let r = await fc.fetchPage('https://shop.example.test/start', 'desktop');
    assert.deepEqual([r.ok, r.code], [false, 'redirects']);
    assert.deepEqual(s.fetches.map((f) => f.url), ['https://shop.example.test/start'], 'the private hop is never requested');
    assert.ok(s.fetches.every((f) => f.init.redirect === 'manual'), 'redirects are followed by hand');

    s.sites.set('https://shop.example.test/www', hop('https://www.shop.example.test/', 301));
    site('https://www.shop.example.test/', { html: '<p>www</p>' });
    r = await fc.fetchPage('https://shop.example.test/www', 'desktop');
    assert.deepEqual([r.ok, r.url, r.html], [true, 'https://www.shop.example.test/', '<p>www</p>'], 'a public redirect is followed');

    for (let i = 0; i < 6; i++) s.sites.set(`https://loop.example.test/${i}`, hop(`https://loop.example.test/${i + 1}`));
    site('https://loop.example.test/6', { html: 'six' });
    r = await fc.fetchPage('https://loop.example.test/0', 'desktop');
    assert.deepEqual([r.ok, r.code], [false, 'redirects'], 'six redirects are too many');
    r = await fc.fetchPage('https://loop.example.test/1', 'desktop');
    assert.deepEqual([r.ok, r.html], [true, 'six'], 'five are followed');

    fx.env.CAPTURE_HOST_DENYLIST = 'denied.example.test, other.example.test';
    s.fetches.length = 0;
    r = await fc.fetchPage('https://denied.example.test/', 'desktop');
    assert.deepEqual([r.ok, r.code, s.fetches.length], [false, 'blocked', 0], 'a denied host, exactly as captures refuse it');
    s.sites.set('https://shop.example.test/to-denied', hop('https://denied.example.test./x'));
    r = await fc.fetchPage('https://shop.example.test/to-denied', 'desktop');
    assert.deepEqual([r.ok, r.code], [false, 'redirects'], 'and a redirect to one, trailing dot and all');
    fx.env.CAPTURE_HOST_DENYLIST = '';
  });

  await section('the safe fetch: the byte cap stops reading, the timeout ends it, and the device sends its user agent', async () => {
    const s = fx.state;
    let pulls = 0;
    let cancelled = false;
    s.sites.set('https://big.example.test/', {
      respond: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new TextEncoder().encode('a'.repeat(1_000_000)));
              if (pulls >= 10) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: HTML },
        ),
    });
    let r = await fc.fetchPage('https://big.example.test/', 'desktop');
    assert.deepEqual([r.ok, r.truncated, r.html.length], [true, true, 3_000_000], 'kept to 3 MB');
    assert.ok(pulls <= 5 && cancelled, `reading stops at the cap (${pulls} chunks of 1 MB pulled)`);

    s.sites.set('https://slow.example.test/', {
      respond: (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    });
    let started = Date.now();
    r = await fc.fetchPage('https://slow.example.test/', 'desktop', { ...limits, timeoutMs: 60 });
    assert.deepEqual([r.ok, r.code], [false, 'timeout']);
    assert.ok(Date.now() - started < 2_000, 'the deadline is honoured');
    assert.equal(fc.FAST_FETCH.timeoutMs, 10_000, 'ten seconds in production');

    s.sites.set('https://stall.example.test/', {
      respond: async (init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('<p>half'));
              init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
            },
          }),
          { headers: HTML },
        ),
    });
    started = Date.now();
    r = await fc.fetchPage('https://stall.example.test/', 'desktop', { ...limits, timeoutMs: 60 });
    assert.deepEqual([r.ok, r.code], [false, 'interrupted'], 'one deadline covers the body too');

    let bodyCancelled = false;
    s.sites.set('https://pdf.example.test/', {
      respond: async () =>
        new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1000)), cancel: () => void (bodyCancelled = true) }), {
          headers: { 'content-type': 'application/pdf' },
        }),
    });
    r = await fc.fetchPage('https://pdf.example.test/', 'desktop');
    assert.deepEqual([r.ok, r.html, bodyCancelled], [true, '', true], 'a body that is not HTML is not read');

    site('https://ua.example.test/', { html: '<p>ua</p>' });
    s.fetches.length = 0;
    await fc.fetchPage('https://ua.example.test/', 'mobile');
    await fc.fetchPage('https://ua.example.test/', 'tablet');
    await fc.fetchPage('https://ua.example.test/', 'desktop');
    const agents = s.fetches.map((f) => f.init.headers['user-agent']);
    assert.match(agents[0], /iPhone.*Mobile.*Safari/, 'a phone monitor asks as the iPhone the browser plays');
    assert.match(agents[1], /iPad/);
    assert.match(agents[2], /EasyScreenCapture/, 'desktop says what it is');
    assert.equal(s.fetches[0].init.headers.cookie, undefined, 'monitors carry no credentials, so none are sent');
  });

  /* ------------------------------------------------------------------------ */
  /* The learning rules                                                        */
  /* ------------------------------------------------------------------------ */

  await section('learning: three agreements go fast; a missed change, mismatches, noise or unavailable readings go to the browser', async () => {
    const rule = { kind: 'appeared', phrase: 'x', selector: '', region: '' };
    const ok = (signature) => ({ ok: true, signature, values: {}, textLength: 0, html: null });
    const step = (signature, changed, matches = true, method = 'learning') => ({ kind: 'rendered', method, read: ok(signature), changed, matches });
    let row = fc.newFastCheck('wat_1');
    let d = fc.nextFastCheck(row, step('a', null), rule);
    assert.deepEqual([d.row.mode, d.row.agreements, d.row.signature, Boolean(d.row.last_full_at)], ['learning', 0, 'a', true], 'the first reading has nothing to agree with');
    for (const expected of [1, 2]) {
      d = fc.nextFastCheck(d.row, step('a', false), rule);
      assert.deepEqual([d.row.mode, d.row.agreements], ['learning', expected]);
    }
    d = fc.nextFastCheck(d.row, step('b', true), rule);
    assert.deepEqual([d.row.mode, d.row.agreements, d.toBrowser], ['fast', 3, undefined], 'a change seen both ways agrees too');
    row = d.row;

    d = fc.nextFastCheck({ ...fc.newFastCheck('wat_2'), signature: 'a', agreements: 2 }, step('a', true), rule);
    assert.equal(d.row.mode, 'browser', 'the browser saw a change the HTML did not');
    assert.match(d.toBrowser, /builds its content with JavaScript/);
    assert.equal(d.row.reason, d.toBrowser);
    d = fc.nextFastCheck({ ...fc.newFastCheck('wat_3'), signature: 'a' }, step('a', true), { ...rule, kind: 'seo' });
    assert.match(d.toBrowser, /sets its SEO tags with JavaScript/);

    d = fc.nextFastCheck(fc.newFastCheck('wat_4'), step('a', null, false), rule);
    assert.deepEqual([d.row.mode, d.row.mismatches], ['learning', 1], 'one reading that disagrees with the page is noted');
    d = fc.nextFastCheck(d.row, step('a', false, false), rule);
    assert.equal(d.row.mode, 'browser', 'two go to the browser');

    const unavailable = { ok: false, code: 'challenge', reason: 'The site shows a bot check to anything but a full browser' };
    d = fc.nextFastCheck({ ...fc.newFastCheck('wat_5'), signature: 'a' }, { kind: 'rendered', method: 'learning', read: unavailable, changed: false, matches: null }, rule);
    assert.deepEqual([d.row.mode, d.row.unavailable, d.row.signature], ['learning', 1, null]);
    d = fc.nextFastCheck(d.row, step('a', null), rule);
    d = fc.nextFastCheck(d.row, { kind: 'rendered', method: 'learning', read: unavailable, changed: false, matches: null }, rule);
    assert.deepEqual([d.row.mode, d.toBrowser], ['browser', unavailable.reason], 'two unavailable learning checks, not necessarily in a row');

    d = { row: { ...fc.newFastCheck('wat_6'), signature: 'a' } };
    for (const signature of ['b', 'c', 'd']) d = fc.nextFastCheck(d.row, step(signature, false), rule);
    assert.equal(d.row.mode, 'browser', 'three readings that changed while the page did not');
    assert.match(d.toBrowser, /HTML changes on every visit/);

    // Fast.
    const fast = { ...row, signature: 'b' };
    d = fc.nextFastCheck(fast, { kind: 'rendered', method: 'gate', read: unavailable, changed: false, matches: null }, rule);
    assert.deepEqual([d.row.mode, d.row.unavailable, d.row.signature], ['fast', 1, 'b'], 'an unavailable reading keeps a signature the browser still agrees with');
    d = fc.nextFastCheck(d.row, { kind: 'rendered', method: 'gate', read: unavailable, changed: true, matches: null }, rule);
    assert.deepEqual([d.row.unavailable, d.row.signature], [2, null], 'not one the page has moved on from');
    d = fc.nextFastCheck(d.row, { kind: 'rendered', method: 'gate', read: unavailable, changed: null, matches: null }, rule);
    assert.deepEqual([d.row.mode, d.toBrowser], ['browser', unavailable.reason], 'three in a row go to the browser');
    d = fc.nextFastCheck({ ...fast, unavailable: 2 }, { kind: 'unchanged' }, rule);
    assert.equal(d.row.unavailable, 0, 'a reading that works resets the count');

    d = fc.nextFastCheck(fast, step('c', true, true, 'gate'), rule);
    assert.deepEqual([d.row.mode, d.row.signature], ['fast', 'c'], 'a change the browser confirmed is the new signature');
    d = fc.nextFastCheck(fast, step('c', false, true, 'gate'), rule);
    assert.deepEqual([d.row.mode, d.row.signature, d.row.noise], ['fast', 'b', 1], 'one it did not confirm is not kept, so it is looked for again');
    d = fc.nextFastCheck(d.row, step('c', false, true, 'gate'), rule);
    assert.deepEqual([d.row.mode, d.row.signature, d.toBrowser], ['learning', 'c', undefined], 'twice, and the monitor learns again');
    d = fc.nextFastCheck(fast, step('b', true, true, 'safety'), rule);
    assert.equal(d.row.mode, 'browser', 'the safety net catches a change the reading missed');
    d = fc.nextFastCheck(fast, step('b', false, false, 'safety'), rule);
    assert.deepEqual([d.row.mode, d.row.mismatches], ['learning', 1], 'and a reading that stopped matching the page');
    d = fc.nextFastCheck(fast, { kind: 'spotted' }, rule);
    assert.deepEqual([d.row.mode, d.row.signature], ['fast', 'b'], 'a change spotted with no screenshot to confirm it keeps the signature');

    const now = new Date('2026-10-09T10:00:03Z');
    const at = (iso) => fc.safetyNetDue({ last_full_at: iso }, now);
    assert.equal(at('2026-10-02T10:00:05Z'), true, 'a week to the hour is due, seconds aside');
    assert.equal(at('2026-10-02T11:00:00Z'), false);
    assert.equal(at(null), true);
    const recent = { ...fast, last_full_at: '2026-10-09T09:00:00Z' };
    assert.equal(fc.checkMethod(recent, true, now), 'gate');
    assert.equal(fc.checkMethod({ ...recent, last_full_at: '2026-10-01T09:00:00Z' }, true, now), 'safety');
    assert.equal(fc.checkMethod({ ...recent, signature: null }, true, now), 'safety', 'no signature: the full check takes one');
    assert.equal(fc.checkMethod(recent, false, now), 'safety', 'no baseline: nothing to gate against');
    assert.equal(fc.checkMethod({ ...recent, forced: 1 }, true, now), 'browser');
    assert.equal(fc.checkMethod({ ...recent, mode: 'browser' }, true, now), 'browser');
    assert.equal(fc.checkMethod({ ...recent, mode: 'learning' }, true, now), 'learning');
  });

  /* ------------------------------------------------------------------------ */
  /* The check flow                                                            */
  /* ------------------------------------------------------------------------ */

  const owner = { id: 'owner', plan: 'pro', email: 'owner@example.test', name: 'Pilot' };
  const plusUser = { id: 'plus', plan: 'plus', email: 'plus@example.test', name: 'Pilot' };
  const freeUser = { id: 'free', plan: 'free', email: 'free@example.test', name: 'Pilot' };
  const loadApp = async () => ({
    watches: await load('src/lib/watches.ts'),
    item: await load('src/pages/api/watches/[id].ts'),
    list: await load('src/pages/api/watches/index.ts'),
    rules: await load('src/pages/api/watches/[id]/rules.ts'),
    profile: await load('src/pages/api/mobile/profile.ts'),
    dashboard: await load('src/lib/monitor-dashboard.ts'),
  });
  const request = (path, body) =>
    new Request(`${ORIGIN}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const call = async (handler, path, { body, params = {}, user = owner } = {}) => {
    const response = await handler({ request: request(path, body), params, locals: { user }, url: new URL(`${ORIGIN}${path}`) });
    return { status: response.status, json: await response.json() };
  };
  const create = (app, body, user = owner) =>
    call(app.list.POST, '/api/watches', { body: { frequency: 'daily', threshold: '1', label: 'Monitor', ...body }, user });
  const act = (app, id, body, user = owner) => call(app.item.POST, `/api/watches/${id}`, { body, params: { id }, user });
  const detail = (app, id) => call(app.item.GET, `/api/watches/${id}`, { params: { id } });
  const fastRow = (id) => fx.state.db.prepare('SELECT * FROM watch_fast_checks WHERE watch_id = ?').get(id);
  const latestRun = (id) => fx.state.db.prepare('SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(id);
  const runs = (id) => fx.state.db.prepare('SELECT COUNT(*) AS n FROM watch_runs WHERE watch_id = ?').get(id).n;
  const check = async (app, id) => app.watches.runWatch(await app.watches.getWatch(id), ORIGIN);
  const pageFetches = (url) => fx.state.fetches.filter((f) => f.url === url).length;

  await section('without migration 0016 every monitor renders on every check, exactly as before', async () => {
    const s = world({ fast: false });
    const app = await loadApp();
    const url = 'https://shop.example.test/no-0016';
    site(url, { html: '<p>Sold out</p>', facts: phraseFacts('Sold out', 'Back in stock', false) });
    const created = await create(app, { url, rule_kind: 'appeared', rule_phrase: 'Back in stock' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual([created.json.check_mode, created.json.check_reason], ['browser', null]);
    for (let i = 0; i < 4; i++) await check(app, created.json.id);
    assert.equal(s.renders.length, 4, 'a capture on every check');
    assert.equal(s.spent, 4, 'and a screenshot');
    assert.equal(pageFetches(url), 0, 'the page is never read without a browser');
    for (const body of [{ action: 'check_mode', force_browser: '1' }, { action: 'retry_fast' }]) {
      const r = await act(app, created.json.id, body);
      assert.deepEqual([r.status, r.json.error.type], [503, 'setup_required'], body.action);
    }
    let r = await create(app, { url: `${url}/15`, rule_kind: 'text', frequency: 'quarter-hourly' });
    assert.deepEqual([r.status, r.json.error.type], [503, 'setup_required'], 'no 15-minute schedule before fast checks exist');
    r = await act(app, created.json.id, { action: 'schedule', frequency: 'quarter-hourly' });
    assert.equal(r.status, 503);
    const sweep = await app.watches.runDueWatches(ORIGIN, new Date(Date.now() + 2 * 86_400_000));
    assert.equal(sweep.ran, 1, 'the sweep runs as it always did');
    assert.equal(s.renders.length, 5);
  });

  await section('a new rule-based monitor learns for three agreeing checks, then reads its page and spends nothing until it changes', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/boots';
    const soldOut = () => site(url, { html: '<main><p>Sold out</p></main>', facts: phraseFacts('Sold out', 'Back in stock', false) });
    soldOut();
    const created = await create(app, { url, rule_kind: 'appeared', rule_phrase: 'Back in stock' });
    const id = created.json.id;
    assert.equal(created.json.check_mode, 'learning');
    for (let i = 1; i <= 4; i++) {
      const outcome = await check(app, id);
      assert.equal(outcome.status, 'done', JSON.stringify(outcome));
      assert.equal(s.renders.length, i, 'learning renders every check');
      assert.equal(pageFetches(url), i, 'and reads the page');
    }
    assert.deepEqual([fastRow(id).mode, fastRow(id).agreements], ['fast', 3], 'the first check records; three more agree');
    let dto = (await detail(app, id)).json;
    assert.equal(dto.check_mode, 'fast');
    const baseline = dto.baseline_capture_id;

    const spent = s.spent;
    let outcome = await check(app, id);
    assert.deepEqual([outcome.status, outcome.changed], ['done', false]);
    assert.equal(s.spent, spent, 'an unchanged fast check spends nothing');
    assert.equal(s.renders.length, 4, 'and takes no capture');
    const run = latestRun(id);
    assert.deepEqual(
      [run.capture_id, run.baseline_capture_id, run.status, run.changed, run.change_pct],
      [null, baseline, 'done', 0, null],
      'a run with the baseline and no capture: the iOS app titles it "Check completed"',
    );
    dto = (await detail(app, id)).json;
    const apiRun = dto.runs[0];
    assert.equal(apiRun.detail, 'No change · read the page, no screenshot needed');
    assert.ok(apiRun.capture_id === null && typeof apiRun.baseline_capture_id === 'string' && Number.isInteger(apiRun.changed) && typeof apiRun.created_at === 'string' && typeof apiRun.id === 'string' && typeof apiRun.status === 'string');
    assert.equal(apiRun.highlight_url, null);
    assert.ok(['id', 'label', 'url', 'display_url', 'device', 'frequency', 'status', 'next_run_at'].every((key) => typeof dto[key] === 'string'), 'the Monitor shape is intact');
    const health = await app.dashboard.monitorDashboard('owner');
    assert.equal(health.successes.get(id), run.created_at, 'a fast check counts as a successful check');
    assert.equal(health.latest.get(id).capture_id, null);

    // The page changes: exactly one full check, and the alert is its own.
    site(url, { html: '<main><p>Back in stock</p></main>', facts: phraseFacts('Back in stock', 'Back in stock', true) });
    const mails = s.mails.length;
    outcome = await check(app, id);
    assert.deepEqual([outcome.status, outcome.changed], ['done', true]);
    assert.equal(s.renders.length, 5, 'one full check');
    assert.equal(s.spent, spent + 1, 'one screenshot');
    assert.equal(s.mails.length, mails + 1, 'one alert');
    assert.match(s.mails.at(-1).subject, /“Back in stock” appeared/);
    assert.equal(latestRun(id).changed, 1);
    assert.notEqual(latestRun(id).capture_id, null);
    outcome = await check(app, id);
    assert.deepEqual([outcome.changed, s.renders.length, s.mails.length], [false, 5, mails + 1], 'then quiet and free again');

    // A reading that changed when the page did not: the full check runs, finds nothing, and sends nothing.
    s.db.prepare("UPDATE watch_fast_checks SET signature = 'stale' WHERE watch_id = ?").run(id);
    outcome = await check(app, id);
    assert.equal(outcome.changed, false, 'the browser saw no change, so no alert, whatever the reading said');
    assert.equal(s.mails.length, mails + 1);
    assert.equal(s.renders.length, 6);
    assert.equal(fastRow(id).signature, 'stale', 'and a reading it did not confirm is not kept');
  });

  await section('a page the browser builds with JavaScript moves to the browser, and the owner hears once', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/spa';
    const facts = (price) => ({ text: `Price ${price}`, text_length: 9, text_hash: price, monitored_element: { selector: '.price', found: true, text: price } });
    site(url, { html: '<span class="price">$19</span>', facts: facts('$19') });
    const id = (await create(app, { url, rule_kind: 'price', rule_selector: '.price' })).json.id;
    await check(app, id);
    await check(app, id);
    assert.equal(fastRow(id).agreements, 1);
    s.sites.get(url).facts = facts('$25');
    const outcome = await check(app, id);
    assert.equal(outcome.changed, true, 'the full check alerts as it always has');
    const row = fastRow(id);
    assert.equal(row.mode, 'browser', 'the reading missed a change the browser saw');
    assert.match(row.reason, /builds its content with JavaScript/);
    const notices = s.mails.filter((mail) => mail.subject.startsWith('Monitor now uses a full browser'));
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /Why: This page builds its content with JavaScript, so it needs a full browser\./);
    const dto = (await detail(app, id)).json;
    assert.deepEqual([dto.check_mode, dto.check_reason], ['browser', row.reason]);
    const fetched = pageFetches(url);
    for (let i = 0; i < 2; i++) await check(app, id);
    assert.equal(pageFetches(url), fetched, 'a browser monitor does not read its page');
    assert.equal(s.mails.filter((mail) => mail.subject.startsWith('Monitor now uses a full browser')).length, 1, 'told once');
  });

  /** A rule-based monitor taken through learning to fast, with its page as `html`. */
  async function fastMonitor(app, url, html, facts, body = {}) {
    site(url, { html, facts });
    const id = (await create(app, { url, rule_kind: 'text', ...body })).json.id;
    for (let i = 0; i < 4; i++) await check(app, id);
    assert.equal(fastRow(id).mode, 'fast', JSON.stringify(fastRow(id)));
    return id;
  }
  const textFacts = (text) => ({ text, text_length: text.length, text_hash: `h:${text}` });

  await section('out of screenshots, fast checks still run; a change they spot keeps its signature and is checked again, with one notice', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/terms';
    const id = await fastMonitor(app, url, '<p>Terms v1</p>', textFacts('Terms v1'));
    const signature = fastRow(id).signature;
    s.remaining = 0;
    let outcome = await check(app, id);
    assert.deepEqual([outcome.status, latestRun(id).capture_id], ['done', null], 'unchanged: an ordinary fast check');

    site(url, { html: '<p>Terms v2</p>', facts: textFacts('Terms v2') });
    const renders = s.renders.length;
    outcome = await check(app, id);
    assert.equal(outcome.status, 'skipped');
    let run = latestRun(id);
    assert.deepEqual([run.status, run.capture_id, run.changed], ['skipped', null, 0]);
    assert.equal(run.detail, 'Change spotted, but no screenshots are left this month to confirm it; it is checked again after your allowance renews · first skip this month');
    assert.equal(fastRow(id).signature, signature, 'the signature is kept, so the change is read again');
    assert.equal(s.renders.length, renders);
    const notices = () => s.mails.filter((mail) => mail.subject === 'Monitor checks paused: screenshot allowance used up');
    assert.equal(notices().length, 1);
    assert.match(notices()[0].text, /has changed, and confirming it takes a screenshot/);
    const next = Date.parse((await app.watches.getWatch(id)).next_run_at);
    assert.ok(next > Date.now() && next <= Date.now() + 25 * 3_600_000, 'tried again within a day, not every hour');
    outcome = await check(app, id);
    assert.equal(latestRun(id).detail, 'Change spotted, but no screenshots are left this month to confirm it; it is checked again after your allowance renews');
    assert.equal(notices().length, 1, 'one notice a month');

    s.remaining = 10;
    outcome = await check(app, id);
    assert.deepEqual([outcome.status, outcome.changed], ['done', true], 'with screenshots again, the change is confirmed and alerted');
    assert.notEqual(fastRow(id).signature, signature);
  });

  await section('the weekly safety net renders a fast monitor, and moves it to the browser if the reading missed a change', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/weekly';
    const id = await fastMonitor(app, url, '<p>Same</p>', textFacts('Same'));
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    s.db.prepare('UPDATE watch_fast_checks SET last_full_at = ? WHERE watch_id = ?').run(old, id);
    let renders = s.renders.length;
    await check(app, id);
    assert.equal(s.renders.length, renders + 1, 'a full check, though nothing changed');
    assert.ok(fastRow(id).last_full_at > old);
    assert.equal(fastRow(id).mode, 'fast');
    await check(app, id);
    assert.equal(s.renders.length, renders + 1, 'and fast again until next week');

    s.db.prepare('UPDATE watch_fast_checks SET last_full_at = ? WHERE watch_id = ?').run(old, id);
    s.sites.get(url).facts = textFacts('Changed by a script');
    const mails = s.mails.length;
    await check(app, id);
    assert.equal(fastRow(id).mode, 'browser', 'the HTML said nothing changed; the browser saw a change');
    assert.equal(s.mails.filter((mail) => mail.subject.startsWith('Monitor now uses a full browser')).length, 1);
    assert.ok(s.mails.length >= mails + 1);
  });

  await section('three unavailable readings in a row move a fast monitor to the browser; each falls back to a full check that decides', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/guarded';
    const id = await fastMonitor(app, url, '<p>Calm</p>', textFacts('Calm'));
    site(url, { html: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>', status: 503, facts: textFacts('Calm') });
    const renders = s.renders.length;
    for (let i = 1; i <= 3; i++) {
      const outcome = await check(app, id);
      assert.deepEqual([outcome.status, outcome.changed], ['done', false], 'the fallback succeeds, and a challenge is never a change');
      assert.equal(s.renders.length, renders + i);
    }
    assert.equal(fastRow(id).mode, 'browser');
    assert.equal(fastRow(id).reason, 'The site shows a bot check to anything but a full browser');
    assert.equal((await app.watches.getWatch(id)).consecutive_errors, 0, 'nothing counted toward the auto-pause');
  });

  await section('forced, retry, visual: the owner chooses the browser, tries fast checks again, and visual monitors never read', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/forced';
    const id = await fastMonitor(app, url, '<p>Plain</p>', textFacts('Plain'));
    let r = await act(app, id, { action: 'check_mode', force_browser: '1' });
    assert.deepEqual([r.status, r.json.check_mode, r.json.check_reason], [200, 'forced', null], 'answers with the Monitor');
    const fetched = pageFetches(url);
    const renders = s.renders.length;
    await check(app, id);
    assert.deepEqual([s.renders.length, pageFetches(url)], [renders + 1, fetched], 'forced: a full check, no reading');
    r = await act(app, id, { action: 'retry_fast' });
    assert.deepEqual([r.status, r.json.error.type], [400, 'invalid_request'], 'retry waits until the owner unticks the option');
    r = await act(app, id, { action: 'check_mode', force_browser: '0' });
    assert.equal(r.json.check_mode, 'fast', 'unticked, the monitor goes back to how it was');
    r = await act(app, id, { action: 'check_mode', force_browser: 'maybe' });
    assert.equal(r.status, 400);

    s.db.prepare("UPDATE watch_fast_checks SET mode = 'browser', reason = 'Because' WHERE watch_id = ?").run(id);
    r = await act(app, id, { action: 'retry_fast' });
    assert.deepEqual([r.status, r.json.check_mode, fastRow(id).agreements, fastRow(id).signature], [200, 'learning', 0, null], 'learning from nothing');

    const visualUrl = 'https://shop.example.test/visual';
    site(visualUrl, { html: '<p>v</p>', facts: textFacts('v') });
    const visual = (await create(app, { url: visualUrl })).json;
    assert.equal(visual.check_mode, 'visual');
    for (let i = 0; i < 3; i++) await check(app, visual.id);
    assert.equal(pageFetches(visualUrl), 0, 'a visual monitor never reads its page');
    assert.equal(fastRow(visual.id), undefined, 'nor has a fast check row');
    r = await act(app, visual.id, { action: 'check_mode', force_browser: '1' });
    assert.deepEqual([r.status, r.json.error.type], [400, 'invalid_request']);
    r = await act(app, visual.id, { action: 'retry_fast' });
    assert.equal(r.status, 400);
  });

  await section('15 minutes is for rule-based monitors that read first; one that goes to the browser drops to hourly, said once', async () => {
    const s = world();
    const app = await loadApp();
    let r = await create(app, { url: 'https://shop.example.test/q-visual', frequency: 'quarter-hourly' });
    assert.deepEqual([r.status, r.json.error.type, r.json.error.param], [400, 'invalid_request', 'frequency']);
    assert.match(r.json.error.message, /visual monitor takes a screenshot on every check/);
    r = await create(app, { url: 'https://shop.example.test/q-plus', rule_kind: 'text', frequency: 'quarter-hourly' }, plusUser);
    assert.deepEqual([r.status, r.json.error.type], [403, 'plan_required'], 'and only on Pro and Business');
    const url = 'https://shop.example.test/q-text';
    site(url, { html: '<p>Quarter</p>', facts: textFacts('Quarter') });
    r = await create(app, { url, rule_kind: 'text', frequency: 'quarter-hourly' });
    assert.deepEqual([r.status, r.json.frequency, r.json.check_mode], [201, 'quarter-hourly', 'learning']);
    const id = r.json.id;
    r = await call(app.rules.POST, `/api/watches/${id}/rules`, { body: { rule_kind: 'visual' }, params: { id } });
    assert.deepEqual([r.status, r.json.error.param], [400, 'rule_kind'], 'it cannot become visual while checked every 15 minutes');
    const visual = (await create(app, { url: 'https://shop.example.test/q-v2' })).json;
    r = await act(app, visual.id, { action: 'schedule', frequency: 'quarter-hourly' });
    assert.deepEqual([r.status, r.json.error.param], [400, 'frequency'], 'nor a visual one moved to it');

    site(url, { html: '<p>Quarter</p>', status: 403, facts: textFacts('Quarter') });
    await check(app, id);
    assert.equal((await app.watches.getWatch(id)).frequency, 'quarter-hourly');
    await check(app, id);
    const watch = await app.watches.getWatch(id);
    assert.equal(fastRow(id).mode, 'browser', 'two unavailable learning checks');
    assert.equal(watch.frequency, 'hourly', 'and the schedule drops to hourly');
    const notices = s.mails.filter((mail) => mail.subject.startsWith('Monitor now uses a full browser'));
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /checked every 15 minutes.*96 a day.*every hour/s);
    r = await act(app, id, { action: 'schedule', frequency: 'quarter-hourly' });
    assert.equal(r.status, 400, 'and stays off it while it needs the browser');

    // Forcing the browser on a 15-minute monitor moves it to hourly in the same step.
    const other = 'https://shop.example.test/q-force';
    site(other, { html: '<p>F</p>', facts: textFacts('F') });
    const forced = (await create(app, { url: other, rule_kind: 'text', frequency: 'quarter-hourly' })).json.id;
    r = await act(app, forced, { action: 'check_mode', force_browser: '1' });
    assert.deepEqual([r.json.frequency, r.json.check_mode], ['hourly', 'forced']);
  });

  await section('schedules: 15-minute monitors land on quarter hours; hourly, daily and weekly keep their alignment', async () => {
    world();
    const { watches } = await loadApp();
    const at = (frequency, iso) => watches.nextRunAt(frequency, new Date(iso));
    assert.equal(at('quarter-hourly', '2026-10-02T10:07:31.000Z'), '2026-10-02T10:15:00.000Z');
    assert.equal(at('quarter-hourly', '2026-10-02T10:15:00.500Z'), '2026-10-02T10:30:00.000Z');
    assert.equal(at('quarter-hourly', '2026-10-02T10:59:59.000Z'), '2026-10-02T11:00:00.000Z');
    assert.equal(at('hourly', '2026-10-02T10:00:37.123Z'), '2026-10-02T11:00:00.000Z');
    assert.equal(at('daily', '2026-10-02T10:42:00.000Z'), '2026-10-03T10:00:00.000Z');
    assert.equal(at('weekly', '2026-10-02T10:42:00.000Z'), '2026-10-09T10:00:00.000Z');
  });

  await section('the minute cron runs only 15-minute monitors at :15, :30 and :45; the hourly sweep runs everything, never twice', async () => {
    const calls = [];
    globalThis.__fcCalls = calls;
    const quiet = { failStrandedCaptures: 0, sweepExpiredCaptures: { scanned: 0, deleted: 0, filesDeleted: 0, bytesFreed: 0, tokensPurged: 0, failed: 0, truncated: false } };
    globalThis.__fcQuiet = quiet;
    const record = (name) =>
      `export const ${name} = async (...args) => { globalThis.__fcCalls.push([${JSON.stringify(name)}, ...args.slice(1)]);` +
      ` return globalThis.__fcQuiet[${JSON.stringify(name)}] ?? { due: 0, jobs: 0, batches: 0 }; };`;
    const workerStubs = {
      '@astrojs/cloudflare/entrypoints/server': 'export default { fetch: () => new Response("ok") };',
      './lib/apple-billing': record('refreshAppleSubscriptions'),
      './lib/push': record('drainPush'),
      './lib/retention': `${record('failStrandedCaptures')}\n${record('sweepExpiredCaptures')}`,
      './lib/watches': `${record('runDueWatches')}\n${record('retryAlerts')}`,
      './lib/digests': record('runProjectDigests'),
      './lib/capture-jobs': `${record('runCaptureJobs')}\n${record('pruneCaptureJobs')}`,
    };
    const exact = {
      name: 'worker-stubs',
      setup(b) {
        b.onResolve({ filter: /^(@astrojs\/cloudflare\/entrypoints\/server|\.\/lib\/(apple-billing|push|retention|watches|digests|capture-jobs))$/ }, (args) => ({ path: args.path, namespace: 'worker' }));
        b.onLoad({ filter: /.*/, namespace: 'worker' }, (args) => ({ contents: workerStubs[args.path], loader: 'js' }));
      },
    };
    const worker = await load('src/worker.ts', [exact]);
    const fire = async (cron, iso) => {
      calls.length = 0;
      const waited = [];
      await worker.default.scheduled({ cron, scheduledTime: Date.parse(iso) }, {}, { waitUntil: (promise) => waited.push(promise) });
      await Promise.all(waited);
      return calls.filter(([name]) => name === 'runDueWatches' || name === 'runCaptureJobs').map(([name, ...args]) => [name, ...args.slice(1)]);
    };
    for (const minute of ['15', '30', '45']) {
      assert.deepEqual(await fire('* * * * *', `2026-10-03T14:${minute}:00Z`), [['runCaptureJobs'], ['runDueWatches', { frequency: 'quarter-hourly' }]], `:${minute}`);
    }
    for (const minute of ['00', '07', '59']) {
      assert.deepEqual(await fire('* * * * *', `2026-10-03T14:${minute}:00Z`), [['runCaptureJobs']], `:${minute} is the queue alone`);
    }
    assert.deepEqual(await fire('0 * * * *', '2026-10-03T14:00:00Z'), [['runDueWatches']], 'the hourly sweep takes everything, as before');
    delete globalThis.__fcCalls;
    delete globalThis.__fcQuiet;

    // And the real sweep: the filter, the shared lease, and more fast checks at once than renders.
    const s = world();
    const app = await loadApp();
    const quarterUrl = 'https://shop.example.test/sweep-q';
    const quarter = await fastMonitor(app, quarterUrl, '<p>Q</p>', textFacts('Q'), { frequency: 'quarter-hourly' });
    const hourlyUrl = 'https://shop.example.test/sweep-h';
    site(hourlyUrl, { html: '<p>H</p>', facts: textFacts('H') });
    const hourly = (await create(app, { url: hourlyUrl, frequency: 'hourly' })).json.id;
    const past = new Date(Date.now() - 60_000).toISOString();
    s.db.prepare('UPDATE watches SET next_run_at = ?').run(past);
    const before = { q: runs(quarter), h: runs(hourly) };
    const [first, second] = await Promise.all([
      app.watches.runDueWatches(ORIGIN, new Date(), { frequency: 'quarter-hourly' }),
      app.watches.runDueWatches(ORIGIN, new Date(), { frequency: 'quarter-hourly' }),
    ]);
    assert.equal(first.ran + second.ran, 1, 'two sweeps at once run the monitor once');
    assert.deepEqual([runs(quarter), runs(hourly)], [before.q + 1, before.h], 'the quarter-hour sweep leaves the hourly monitor alone');
    await app.watches.runDueWatches(ORIGIN, new Date());
    assert.equal(runs(hourly), before.h + 1, 'the hourly sweep runs it');

    const many = [];
    for (let i = 0; i < 12; i++) many.push(await fastMonitor(app, `https://shop.example.test/many-${i}`, `<p>M${i}</p>`, textFacts(`M${i}`)));
    for (let i = 0; i < 6; i++) site(`https://shop.example.test/many-${i}`, { html: `<p>M${i} changed</p>`, facts: textFacts(`M${i} changed`) });
    s.db.prepare('UPDATE watches SET next_run_at = ?').run(past);
    Object.assign(s, { fetchMs: 30, renderMs: 30, maxFetching: 0, maxRendering: 0 });
    const result = await app.watches.runDueWatches(ORIGIN, new Date());
    assert.ok(result.ran >= 12, JSON.stringify(result));
    assert.ok(s.maxFetching > 3, `fast checks run wider than renders (${s.maxFetching} at once)`);
    assert.ok(s.maxRendering <= 3, `renders keep to three at once (${s.maxRendering})`);
    assert.ok(s.renders.length > 0);
  });

  await section('SEO: a canonical or noindex only JavaScript adds gets a note on the run, never an alert', async () => {
    const s = world();
    const app = await loadApp();
    const url = 'https://shop.example.test/seo-note';
    const seo = { title: 'Shop', description: '', canonical: 'https://shop.example.test/seo-note', robots: 'noindex', robots_header: '', h1: 'Shop', h1_count: 1, hreflang: [], og: { title: '', description: '', image: '' }, status: 200 };
    site(url, { html: '<title>Shop</title><h1>Shop</h1>', facts: { text: 'Shop', text_length: 4, seo } });
    const id = (await create(app, { url, rule_kind: 'seo' })).json.id;
    await check(app, id);
    let shown = (await detail(app, id)).json.runs[0].detail;
    assert.match(shown, /^first check — saved as the baseline\. Note: the canonical link is only added by JavaScript; crawlers that don’t run JavaScript won’t see it\./);
    assert.match(shown, /Note: noindex is only added by JavaScript/);
    assert.deepEqual([fastRow(id).mode, fastRow(id).mismatches], ['learning', 1], 'a reading that disagrees with the page counts against fast checks');
    await check(app, id);
    assert.equal(fastRow(id).mode, 'browser', 'twice, and the browser checks it');
    assert.match(fastRow(id).reason, /sets its SEO tags with JavaScript/);
    await check(app, id);
    shown = (await detail(app, id)).json.runs[0].detail;
    assert.match(shown, /^No watched SEO signal changed\. Note: the canonical link/, 'browser checks keep the notes');
    assert.ok((await detail(app, id)).json.runs.every((run) => run.changed === 0));
    assert.deepEqual(s.mails.map((mail) => mail.subject), ['Monitor now uses a full browser: Monitor'], 'no alert: the only mail says how it is checked');
  });

  await section('profile frequencies never offer 15 minutes; Free and Lite can now create weekly monitors', async () => {
    world();
    const app = await loadApp();
    const profile = async (user) => (await call(app.profile.GET, '/api/mobile/profile', { user })).json;
    assert.deepEqual((await profile(owner)).frequencies, ['hourly', 'daily', 'weekly']);
    assert.deepEqual((await profile(plusUser)).frequencies, ['daily', 'weekly']);
    assert.deepEqual((await profile(freeUser)).frequencies, ['weekly']);
    const url = 'https://shop.example.test/free';
    site(url, { html: '<p>f</p>', facts: textFacts('f') });
    let r = await create(app, { url, frequency: 'weekly', device: 'desktop', threshold: '1', notify_email: '1', mode: 'fullpage', format: 'png' }, freeUser);
    assert.equal(r.status, 201, 'the request the iOS app sends');
    assert.equal(r.json.frequency, 'weekly');
    r = await create(app, { url: `${url}/daily`, frequency: 'daily' }, freeUser);
    assert.deepEqual([r.status, r.json.error.type], [403, 'plan_required']);
    for (let i = 0; i < 2; i++) assert.equal((await create(app, { url: `${url}/${i}`, frequency: 'weekly' }, freeUser)).status, 201);
    r = await create(app, { url: `${url}/4`, frequency: 'weekly' }, freeUser);
    assert.deepEqual([r.status, r.json.error.type], [403, 'watch_limit'], 'three on Free');
  });
} finally {
  globalThis.fetch = realFetch;
  delete globalThis.__fc;
  await mf.dispose();
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\nall ${passed.length} checks passed`);
