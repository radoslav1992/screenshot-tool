/**
 * The free tools under /tools, and what keeps them cheap.
 *
 * Anonymous captures cost real browser time, so most of what matters here is a
 * refusal: a visitor over their daily renders, a day over everyone's, a pool
 * with nothing to spare, a private address, a request from another site. Each
 * is checked by running the shipped module (src/lib/free-tools.ts) bundled with
 * only the Worker bindings, the renderer and the diff stubbed, against an
 * in-memory KV. The renderer itself then runs a free render against a fake page
 * to show it stays bounded: scale 1 everywhere, cut at 8,000 px, marked, and
 * never waiting for a browser.
 *
 * The SEO checker reads HTML with HTMLRewriter, so — as in
 * scripts/fast-checks-check.mjs — it runs in workerd through Miniflare against
 * the real parser, with `fetch` answered from fixtures. No network calls.
 *
 *   node scripts/free-tools-check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
// Installed with wrangler, which runs this same workerd for `astro dev`.
import { Miniflare } from 'miniflare';

const root = new URL('../', import.meta.url).pathname;
const lib = (name) => join(root, `src/lib/${name}.ts`);
const directory = mkdtempSync(join(tmpdir(), 'free-tools-check-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};
const rejects = async (promise, check, message) => {
  try {
    await promise;
  } catch (error) {
    check(error);
    return;
  }
  assert.fail(message ?? 'expected a rejection');
};
const statusOf = (status, type) => (error) => {
  assert.equal(error.status, status, `${error.type}: ${error.message}`);
  if (type) assert.equal(error.type, type);
};

/* -------------------------------------------------------------------------- */
/* Bundles                                                                     */
/* -------------------------------------------------------------------------- */

const ft = (globalThis.__ft = { env: {}, puppeteer: null });
let bundles = 0;

/**
 * Bundles one module of src/lib with the Worker-only imports replaced, plus any
 * sibling module named in `stubs` (by its `./name` import). Stubs may import
 * the real siblings, so an HttpError they throw is the module's own class.
 */
async function load(entry, stubs = {}) {
  const contents = {
    'cloudflare:workers': 'export const env = globalThis.__ft.env;',
    '@cloudflare/puppeteer': 'export default globalThis.__ft.puppeteer;',
    ...stubs,
  };
  const plugin = {
    name: 'free-tools-check-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$|^@cloudflare\/puppeteer$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      for (const name of Object.keys(stubs)) {
        builder.onResolve({ filter: new RegExp(`^\\./${name}$`) }, () => ({ path: name, namespace: 'stub' }));
      }
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: contents[args.path],
        loader: 'ts',
        resolveDir: join(root, 'src/lib'),
      }));
    },
  };
  const result = await build({ entryPoints: [lib(entry)], bundle: true, format: 'esm', platform: 'neutral', write: false, plugins: [plugin] });
  const out = join(directory, `${entry}-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

const tools = await load('free-tools', {
  renderer: `import { HttpError } from './http';
    export async function render(options) {
      const s = globalThis.__ft;
      s.renders.push(options);
      // A spec ({ status, type, message }) is thrown as the renderer's own HttpError; a function picks by call.
      const failure = typeof s.renderError === 'function' ? s.renderError(s.renders.length) : s.renderError;
      if (typeof s.renderError !== 'function') s.renderError = null;
      if (failure) throw failure.type ? new HttpError(failure.status, failure.type, failure.message) : failure;
      const file = (name, width, height) => ({ data: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg', ext: 'jpg', index: 1, name, width, height });
      if (options.sizes.length) return { engine: 'binding', durationMs: 1, files: [file('desktop.jpg', 1440, 900), file('tablet.jpg', 834, 1194), file('mobile.jpg', 390, 844)] };
      return { engine: 'binding', durationMs: 1, files: [file(undefined, options.width, s.pageHeight ?? 3000)] };
    }`,
  'visual-diff': `import { HttpError } from './http';
    export async function compareImages(before, after, region, options) {
      const s = globalThis.__ft;
      s.diffs.push({ before, after, options });
      if (s.diffError) throw new HttpError(s.diffError.status, s.diffError.type, s.diffError.message);
      return { changedPct: 12.5, changedPixels: 10, sharedPct: 12.5, resized: false, width: 1440, height: 900,
        regions: [{ x: 0, y: 0, w: 0.5, h: 0.1 }], highlight: 'data:image/jpeg;base64,AAAA' };
    }`,
  'seo-check': `export async function checkSeo(url) {
      globalThis.__ft.seoChecks.push(url);
      return { url, finalUrl: url, status: 200, redirects: [], contentType: 'text/html', truncated: false, tags: null, findings: [] };
    }`,
});
const busyPool = { status: 503, type: 'browser_unavailable', message: 'All 10 browser sessions are in use (10 active).' };

/** An in-memory KV; `broken` makes every call throw, as an unreachable namespace does. */
function kv() {
  const store = new Map();
  return {
    store,
    broken: false,
    async get(key) {
      if (this.broken) throw new Error('KV GET failed: 503');
      return store.get(key) ?? null;
    },
    async put(key, value) {
      if (this.broken) throw new Error('KV PUT failed: 503');
      store.set(key, value);
    },
  };
}

const ORIGIN = 'https://easyscreencapture.com';
const ROOMY = { maxConcurrentSessions: 10, activeSessions: [], allowedBrowserAcquisitions: 10, timeUntilNextAllowedBrowserAcquisition: 0 };

/** A fresh deployment: empty counters, a roomy pool, nothing rendered. */
function reset(env = {}) {
  ft.env = Object.assign(ft.env, { RATE: kv(), BROWSER: {}, CAPTURE_HOST_DENYLIST: '', FREE_TOOLS_DAILY_RENDERS: '' }, env);
  for (const key of Object.keys(ft.env)) if (ft.env[key] === undefined) delete ft.env[key];
  ft.limits = ROOMY;
  ft.puppeteer = { limits: async () => ft.limits };
  Object.assign(ft, { renders: [], diffs: [], seoChecks: [], renderError: null, diffError: null, pageHeight: undefined });
}

/** A POST from the tool's own page, as a browser sends it. */
function post(ip = '203.0.113.7', headers = {}) {
  return new Request(`${ORIGIN}/tools/full-page-screenshot`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': ip, ...headers },
  });
}
const run = (tool, input, request = post()) => tools.runTool(request, tool, input);
const counted = () => [...ft.env.RATE.store.entries()].filter(([key]) => key.startsWith('rl:tools:render:') && !key.includes(':all:'));
const total = () => Number([...ft.env.RATE.store.entries()].find(([key]) => key.startsWith('rl:tools:render:all:'))?.[1] ?? 0);

const quiet = console.error;
console.error = () => {};

/* -------------------------------------------------------------------------- */
/* Who may ask                                                                 */
/* -------------------------------------------------------------------------- */

await section('only a same-origin POST from the tool page runs a tool', async () => {
  reset();
  const page = (headers, method = 'POST') => new Request(`${ORIGIN}/tools/seo-tag-checker`, { method, headers: { 'cf-connecting-ip': '203.0.113.7', ...headers } });
  // Another site's form, and anything without the headers every browser sends on a POST.
  await rejects(run('seo-tag-checker', { url: 'https://example.com' }, page({ origin: 'https://evil.example' })), statusOf(403, 'forbidden'));
  await rejects(run('seo-tag-checker', { url: 'https://example.com' }, page({})), statusOf(403, 'forbidden'));
  await rejects(run('seo-tag-checker', { url: 'https://example.com' }, page({ 'sec-fetch-site': 'cross-site' })), statusOf(403, 'forbidden'));
  await rejects(run('seo-tag-checker', { url: 'https://example.com' }, page({ origin: ORIGIN }, 'GET')), statusOf(405));
  // An API key is no way in: nothing reads it, and the origin check still applies.
  await rejects(
    run('full-page-screenshot', { url: 'https://example.com' }, page({ authorization: 'Bearer sk_live_x' })),
    statusOf(403, 'forbidden'),
  );
  assert.equal(ft.seoChecks.length + ft.renders.length, 0, 'nothing ran');
  assert.equal(ft.env.RATE.store.size, 0, 'and nothing was counted');

  await run('seo-tag-checker', { url: 'https://example.com' }, page({ origin: ORIGIN }));
  await run('seo-tag-checker', { url: 'https://example.com' }, page({ 'sec-fetch-site': 'same-origin' }));
  assert.equal(ft.seoChecks.length, 2);
});

await section('private addresses and denylisted hosts are refused before anything is spent', async () => {
  reset({ CAPTURE_HOST_DENYLIST: 'blocked.example, internal.example.' });
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://10.0.0.8/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal./',
    'http://printer.local/',
    'https://blocked.example/',
    'https://BLOCKED.example./x',
    'https://internal.example/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'nohost',
    '',
  ]) {
    for (const tool of ['full-page-screenshot', 'responsive-preview', 'seo-tag-checker']) {
      await rejects(run(tool, { url }), statusOf(400), `${tool} ${url}`);
    }
    await rejects(run('compare-pages', { a_url: 'https://example.com', b_url: url }), (error) => {
      assert.equal(error.status, 400, url);
      assert.equal(error.param, 'b_url');
    });
  }
  assert.equal(ft.renders.length + ft.seoChecks.length + ft.diffs.length, 0, 'nothing rendered or fetched');
  assert.equal(ft.env.RATE.store.size, 0, 'nothing counted');
  // Only the preset devices a visitor can pick; no custom sizes.
  await rejects(run('full-page-screenshot', { url: 'https://example.com', device: 'tablet' }), statusOf(400));
  await rejects(run('full-page-screenshot', { url: 'https://example.com', device: 'custom' }), statusOf(400));
});

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

await section('a preview costs three renders and a comparison two', async () => {
  assert.deepEqual(tools.RENDER_COST, { 'full-page-screenshot': 1, 'responsive-preview': 3, 'compare-pages': 2 });
  reset();
  await run('responsive-preview', { url: 'https://example.com' });
  assert.equal(Number(counted()[0][1]), 3);
  assert.equal(total(), 3);
  await run('compare-pages', { a_url: 'https://staging.example.com', b_url: 'https://example.com' }, post('198.51.100.4'));
  assert.equal(total(), 5);
  assert.deepEqual(counted().map(([, value]) => Number(value)).sort(), [2, 3]);
});

await section('each visitor gets five renders a day, across the browser tools', async () => {
  reset();
  assert.equal(tools.FREE_TOOL_LIMITS.rendersPerVisitor, 5);
  await run('responsive-preview', { url: 'https://example.com' });
  await run('full-page-screenshot', { url: 'https://example.com' });
  // One left: a comparison needs two, and says so.
  await rejects(run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com' }), (error) => {
    statusOf(429, 'rate_limited')(error);
    assert.match(error.message, /takes 2 of your free renders and you have 1 left today/);
    assert.match(error.message, /Sign up free/);
  });
  await run('full-page-screenshot', { url: 'https://example.com' });
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), (error) => {
    statusOf(429, 'rate_limited')(error);
    assert.match(error.message, /used today’s 5 free renders/);
  });
  assert.equal(ft.renders.length, 3, 'three renders: the preview counts once as a render call');
  // Another visitor is not affected; the SEO checker has its own allowance.
  await run('full-page-screenshot', { url: 'https://example.com' }, post('198.51.100.9'));
  await run('seo-tag-checker', { url: 'https://example.com' });
});

await section('an IPv6 visitor is one /64, and no key holds an address', async () => {
  assert.equal(tools.addressPrefix('203.0.113.7'), '203.0.113.7');
  assert.equal(tools.addressPrefix('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(tools.addressPrefix('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(tools.addressPrefix('2001:0db8:00aa:00bb::9'), '2001:db8:aa:bb::/64');
  assert.equal(tools.addressPrefix('2001:db8::1'), '2001:db8:0:0::/64');

  reset();
  for (let i = 1; i <= 5; i++) await run('full-page-screenshot', { url: 'https://example.com' }, post(`2001:db8:aa:bb::${i}`));
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }, post('2001:db8:aa:bb:ffff::1')), statusOf(429));
  await run('full-page-screenshot', { url: 'https://example.com' }, post('2001:db8:aa:bc::1'));

  for (const key of ft.env.RATE.store.keys()) {
    assert.doesNotMatch(key, /2001|db8|203\.0|::/, `a counter key names no address: ${key}`);
  }
  const day = new Date('2026-10-03T12:00:00Z');
  const one = await tools.visitorKey(post('203.0.113.7'), day);
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.equal(one, await tools.visitorKey(post('203.0.113.7'), new Date('2026-10-03T23:59:00Z')));
  assert.notEqual(one, await tools.visitorKey(post('203.0.113.7'), new Date('2026-10-04T00:00:00Z')), 'a new day, a new key');
  assert.notEqual(one, await tools.visitorKey(post('203.0.113.8'), day));
});

await section('a daily cap across every visitor, set by FREE_TOOLS_DAILY_RENDERS', async () => {
  reset({ FREE_TOOLS_DAILY_RENDERS: '4' });
  await run('responsive-preview', { url: 'https://example.com' }, post('198.51.100.1'));
  await run('full-page-screenshot', { url: 'https://example.com' }, post('198.51.100.2'));
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }, post('198.51.100.3')), (error) => {
    statusOf(503, 'tools_busy')(error);
    assert.match(error.message, /busy today\. Sign up free to keep going/);
  });
  assert.equal(ft.renders.length, 2);
  // The SEO checker uses no browser, so the cap does not touch it.
  await run('seo-tag-checker', { url: 'https://example.com' }, post('198.51.100.3'));

  reset({ FREE_TOOLS_DAILY_RENDERS: '0' });
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), statusOf(503, 'tools_busy'));
  assert.equal(ft.renders.length, 0, '0 switches the browser tools off');

  for (const [raw, cap] of [['', 300], [undefined, 300], ['abc', 300], ['-5', 300], ['12', 12], [' 7 ', 7]]) {
    reset({ FREE_TOOLS_DAILY_RENDERS: raw });
    assert.equal(tools.dailyRenderCap(), cap, String(raw));
  }
});

await section('an unreadable KV lets visitors through rather than failing', async () => {
  reset();
  ft.env.RATE.broken = true;
  for (let i = 0; i < 8; i++) await run('full-page-screenshot', { url: 'https://example.com' });
  for (let i = 0; i < 40; i++) await run('seo-tag-checker', { url: 'https://example.com' });
  assert.equal(ft.renders.length, 8);
  // The pool check still stands without KV.
  ft.limits = { ...ROOMY, activeSessions: Array.from({ length: 9 }, (_, id) => ({ id })) };
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), statusOf(503, 'browser_busy'));
});

await section('thirty SEO checks an hour per visitor', async () => {
  reset();
  for (let i = 0; i < 30; i++) await run('seo-tag-checker', { url: 'https://example.com' });
  await rejects(run('seo-tag-checker', { url: 'https://example.com' }), statusOf(429, 'rate_limited'));
  await run('seo-tag-checker', { url: 'https://example.com' }, post('198.51.100.20'));
  assert.equal(ft.seoChecks.length, 31);
});

/* -------------------------------------------------------------------------- */
/* Customers first                                                             */
/* -------------------------------------------------------------------------- */

await section('a busy pool answers "try again in a minute", and costs nothing', async () => {
  reset();
  // Ten sessions, eight in use: two spare is exactly the reserve, so a visitor is turned away.
  ft.limits = { ...ROOMY, activeSessions: Array.from({ length: 8 }, (_, id) => ({ id })) };
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), (error) => {
    statusOf(503, 'browser_busy')(error);
    assert.match(error.message, /Try again in a minute/);
  });
  ft.limits = { ...ROOMY, allowedBrowserAcquisitions: 0 };
  await rejects(run('responsive-preview', { url: 'https://example.com' }), statusOf(503, 'browser_busy'));
  assert.equal(ft.renders.length, 0);
  assert.equal(ft.env.RATE.store.size, 0, 'no renders were drawn');

  // Three spare: room for one visitor.
  ft.limits = { ...ROOMY, activeSessions: Array.from({ length: 7 }, (_, id) => ({ id })) };
  await run('full-page-screenshot', { url: 'https://example.com' });

  // The pool filled between the check and the launch: busy, and the renders come back.
  reset();
  ft.renderError = busyPool;
  await rejects(run('responsive-preview', { url: 'https://example.com' }), statusOf(503, 'browser_busy'));
  assert.equal(Number(counted()[0][1]), 0, 'the visitor got the three back');
  assert.equal(total(), 0);
  // A comparison whose second page found the pool full gives back one.
  reset();
  ft.renderError = (call) => (call === 2 ? busyPool : null);
  await rejects(run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com' }), statusOf(503, 'browser_busy'));
  assert.equal(ft.renders.length, 2);
  assert.equal(Number(counted()[0][1]), 1, 'one render was used');
  assert.equal(total(), 1);

  // No binding at all: said plainly, nothing counted.
  reset({ BROWSER: undefined });
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), statusOf(503, 'renderer_unavailable'));
  assert.equal(ft.env.RATE.store.size, 0);
});

await section('a failed render says why in plain words, and keeps its cost', async () => {
  reset();
  ft.renderError = { status: 504, type: 'render_timeout', message: 'The page took too long to capture and was stopped.' };
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), statusOf(504, 'render_timeout'));
  ft.renderError = { status: 400, type: 'unreachable_url', message: 'That URL could not be resolved.' };
  await rejects(run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com' }), (error) => {
    statusOf(400, 'unreachable_url')(error);
    assert.equal(error.message, 'Page A: That URL could not be resolved.');
  });
  ft.renderError = new Error('Protocol error (Page.captureScreenshot): Target closed. at https://example.com/');
  await rejects(run('full-page-screenshot', { url: 'https://example.com' }), (error) => {
    statusOf(502, 'render_failed')(error);
    assert.doesNotMatch(error.message, /Protocol|example\.com/, 'no internals or addresses in the message');
  });
  // The browser ran each time, so each time is counted: 1 + 2 + 1.
  assert.equal(total(), 4);
});

/* -------------------------------------------------------------------------- */
/* Bounded renders                                                             */
/* -------------------------------------------------------------------------- */

await section('every free render is scale 1, JPEG, marked, cut at 8,000 px, with no credentials', async () => {
  reset();
  const extras = {
    headers: '{"authorization":"Bearer x"}',
    cookies: '{"session":"1"}',
    basic_auth: 'a:b',
    actions: 'click:.buy',
    hide: '.x',
    scale: '3',
    width: '3840',
    height: '4000',
    delay: '15000',
    format: 'png',
    mode: 'series',
    sizes: 'mobile',
    html: '<script>alert(1)</script>',
    dark_mode: '1',
  };
  await run('full-page-screenshot', { url: 'https://user:pass@example.com/a#top', device: 'mobile', ...extras });
  await run('responsive-preview', { url: 'https://example.com', ...extras }, post('198.51.100.40'));
  await run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com', ...extras }, post('198.51.100.41'));
  assert.equal(ft.renders.length, 4);
  for (const options of ft.renders) {
    assert.equal(options.scale, 1);
    assert.deepEqual(options.bounded, { scale: 1, maxHeight: 8000 });
    assert.equal(options.format, 'jpg');
    assert.ok(options.quality <= 80);
    assert.equal(options.watermark, true);
    assert.deepEqual(options.auth, { headers: {}, cookies: [] });
    assert.deepEqual(options.actions, []);
    assert.deepEqual(options.hide, []);
    assert.deepEqual(options.blur, []);
    assert.equal(options.delayMs, 0);
    assert.equal(options.darkMode, false);
    assert.equal(options.html, undefined);
    assert.equal(options.facts, false);
    assert.ok(['desktop', 'mobile'].includes(options.device));
    assert.ok(options.width <= 1440 && options.height <= 900);
  }
  const [full, preview, a, b] = ft.renders;
  assert.equal(full.url, 'https://example.com/a', 'credentials and fragment are dropped from the address');
  assert.equal(full.mode, 'fullpage');
  assert.equal(full.device, 'mobile');
  assert.equal(preview.mode, 'visible');
  assert.deepEqual(preview.sizes, ['tablet', 'mobile']);
  assert.equal(a.mode, 'fullpage');
  assert.equal(b.url, 'https://b.example.com/');
  assert.equal(tools.TOOL_RENDER.maxHeight, 8000);
});

await section('results come back as bytes in the response, and nothing is stored', async () => {
  reset();
  ft.env.SHOTS = { put: () => assert.fail('nothing goes to R2') };
  ft.env.DB = { prepare: () => assert.fail('nothing goes to D1') };
  const full = await run('full-page-screenshot', { url: 'https://example.com' });
  assert.equal(full.image.contentType, 'image/jpeg');
  assert.ok(full.image.data instanceof Uint8Array);
  assert.equal(tools.imageDataUrl(full.image), 'data:image/jpeg;base64,/9j/');
  ft.pageHeight = 8000;
  assert.equal((await run('full-page-screenshot', { url: 'https://example.com' }, post('198.51.100.30'))).cut, true);

  const preview = await run('responsive-preview', { url: 'https://example.com' }, post('198.51.100.31'));
  assert.deepEqual(preview.images.map((image) => image.device), ['mobile', 'tablet', 'desktop'], 'smallest first');

  const compared = await run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com' }, post('198.51.100.32'));
  assert.equal(compared.diff.changedPct, 12.5);
  assert.equal(compared.diff.highlight, 'data:image/jpeg;base64,AAAA');
  const [diff] = ft.diffs;
  assert.match(diff.before, /^data:image\/jpeg;base64,/, 'the diff reads the images from the request, not storage');
  assert.equal(diff.options.wait, false, 'the diff does not wait for a browser either');
  assert.equal(diff.options.highlight, 0);

  // No browser free for the diff: both images still come back, with a reason.
  ft.diffError = busyPool;
  const undiffed = await run('compare-pages', { a_url: 'https://a.example.com', b_url: 'https://b.example.com' }, post('198.51.100.33'));
  assert.equal(undiffed.diff, null);
  assert.match(undiffed.detail, /no browser was free/);
  assert.ok(undiffed.a.image && undiffed.b.image);
  delete ft.env.SHOTS;
  delete ft.env.DB;
});

/* -------------------------------------------------------------------------- */
/* The renderer, bounded                                                       */
/* -------------------------------------------------------------------------- */

const renderer = await load('renderer', {
  'browser-pool': `export const openPage = (...args) => globalThis.__ft.openPage(...args);
                   export const closePage = async (session) => { await session.page.close(); };`,
});

/** A Puppeteer page whose document is 20,000 px tall, recording what is done to it. */
function tallPage() {
  const page = {
    viewports: [],
    scripts: [],
    shots: [],
    calls: [],
    on: () => {},
    setViewport: async (viewport) => page.viewports.push(viewport),
    setUserAgent: async () => {},
    setRequestInterception: async () => {},
    setCookie: async () => page.calls.push('setCookie'),
    authenticate: async () => page.calls.push('authenticate'),
    setExtraHTTPHeaders: async () => page.calls.push('setExtraHTTPHeaders'),
    emulateMediaFeatures: async () => {},
    mainFrame: () => ({}),
    url: () => 'https://example.com/',
    waitForNetworkIdle: async () => {},
    addStyleTag: async () => {},
    goto: async () => ({ status: () => 200, headers: () => ({}) }),
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'string') page.scripts.push(fn);
      else if (fn.toString().includes('stepSize')) page.scrollCap = args[1];
      return 20_000;
    },
    screenshot: async (options) => {
      page.shots.push(options);
      return new Uint8Array([255, 216, 255]);
    },
    close: async () => {},
  };
  return page;
}

await section('the renderer holds a free render to its bounds', async () => {
  const realTimeout = globalThis.setTimeout;
  // Settling pauses run at once; the capture deadline keeps its real length.
  globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms >= 10_000 ? ms : 0, ...args);
  const logs = console.log;
  console.log = () => {};
  try {
    reset();
    const url = new URL('https://example.com/');

    let page = tallPage();
    const asked = [];
    ft.openPage = async (_puppeteer, options) => {
      asked.push(options);
      return { page, context: {}, lease: { browser: {}, reused: false } };
    };
    const full = await renderer.render(tools.toolOptions(url, 'desktop', 'fullpage'));
    assert.deepEqual(asked[0], { wait: false }, 'never waits for a session');
    assert.equal(full.files[0].height, 8000);
    assert.ok(Math.max(...page.viewports.map((viewport) => viewport.height)) <= 8000, 'the viewport never grows past the cap');
    assert.ok(page.viewports.every((viewport) => viewport.deviceScaleFactor === 1));
    assert.equal(page.scrollCap, 8000, 'lazy-load scrolling stops at the cap');
    assert.equal(page.shots[0].type, 'jpeg');
    assert.equal(page.shots[0].quality, tools.TOOL_RENDER.quality);
    assert.ok(page.scripts.some((script) => script.includes('Math.min(document.documentElement.scrollHeight, 8000)')), 'the mark sits inside the cut');
    assert.deepEqual(page.calls, [], 'no cookies, credentials or headers are set');

    page = tallPage();
    const preview = await renderer.render(tools.toolOptions(url, 'desktop', 'visible', ['tablet', 'mobile']));
    assert.deepEqual(preview.files.map((file) => file.name), ['desktop.jpg', 'tablet.jpg', 'mobile.jpg']);
    assert.deepEqual(page.viewports.map((viewport) => viewport.deviceScaleFactor), [1, 1, 1, 1], 'phone and tablet at scale 1 too');
    assert.equal(page.scripts.filter((script) => script.includes('easyscreencapture.com')).length >= 3, true, 'each size is marked');

    // A customer's capture is untouched: its own scale, the 20,000 px ceiling, and it may wait.
    page = tallPage();
    asked.length = 0;
    const paid = { ...tools.toolOptions(url, 'mobile', 'fullpage'), scale: 3, watermark: false, bounded: undefined };
    const shot = await renderer.render(paid);
    assert.deepEqual(asked[0], { wait: true });
    assert.equal(shot.files[0].height, 20_000);
    assert.ok(page.viewports.every((viewport) => viewport.deviceScaleFactor === 3));
  } finally {
    globalThis.setTimeout = realTimeout;
    console.log = logs;
  }
});

/* -------------------------------------------------------------------------- */
/* Calls to action                                                             */
/* -------------------------------------------------------------------------- */

const { safeNext } = await load('safe-next');

await section('every call to action signs up with ref=tool-<name>, then opens the monitor for the page', async () => {
  const page = 'https://example.com/pricing?plan=pro&x=1#top';
  for (const tool of ['full-page-screenshot', 'responsive-preview', 'seo-tag-checker', 'compare-pages']) {
    const href = tools.monitorHref(tool, page);
    const link = new URL(href, ORIGIN);
    assert.equal(link.pathname, '/signup');
    assert.equal(link.searchParams.get('ref'), `tool-${tool}`);
    const next = safeNext(link.searchParams.get('next'), ORIGIN);
    assert.equal(next, link.searchParams.get('next'), 'next survives safeNext unchanged');
    const setup = new URL(next, ORIGIN);
    assert.equal(setup.pathname, '/app/watches/setup');
    assert.equal(setup.searchParams.get('url'), page, 'the page arrives prefilled, whole');
    // Signed in: straight to the monitor, nothing to attribute.
    assert.equal(tools.monitorHref(tool, page, true), `/app/watches/setup?url=${encodeURIComponent(page)}`);

    // The page renders that call to action, for its own tool, at the end of a result.
    const source = readFileSync(join(root, `src/pages/tools/${tool}.astro`), 'utf8');
    assert.match(source, new RegExp(`<ToolCta tool="${tool}"`), `${tool} ends its result with the call to action`);
    assert.match(source, new RegExp(`<ToolShell tool="${tool}"`));
  }
  assert.equal(new URL(tools.monitorHref('index'), ORIGIN).searchParams.get('ref'), 'tool-index');
  assert.equal(new URL(tools.monitorHref('index'), ORIGIN).searchParams.get('next'), '/app/watches/setup');
  const cta = readFileSync(join(root, 'src/components/ToolCta.astro'), 'utf8');
  assert.match(cta, /monitorHref\(tool, url/);
  assert.match(readFileSync(join(root, 'src/components/ToolShell.astro'), 'utf8'), /Made with <a href="\/">Easy Screen Capture<\/a>/);
  // The setup page reads the prefill.
  assert.match(readFileSync(join(root, 'src/pages/app/watches/setup.astro'), 'utf8'), /searchParams\.get\('url'\)/);
});

/* -------------------------------------------------------------------------- */
/* The SEO checker, in workerd                                                 */
/* -------------------------------------------------------------------------- */

const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))[1];
const checkerModule = await build({
  entryPoints: [lib('seo-check')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'workers-env',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'env', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const env = new Proxy({}, { get: (_, key) => (globalThis.__env ?? {})[key] });', loader: 'js' }));
      },
    },
  ],
});
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: 'seo-check',
        compatibilityDate,
        manifest: {
          mainModule: 'index.mjs',
          modules: {
            'seo-check.mjs': { type: 'esm', contents: checkerModule.outputFiles[0].text },
            'index.mjs': {
              type: 'esm',
              contents: `import { analyseSeoPage, checkSeo, googlePreview, socialPreview } from './seo-check.mjs';
                export default { async fetch(request) {
                  const body = await request.json();
                  try {
                    let report;
                    if (body.routes) {
                      // fetch() answered from fixtures: no network, every hop seen.
                      globalThis.__env = { CAPTURE_HOST_DENYLIST: body.denylist ?? '' };
                      globalThis.fetch = async (url, init) => {
                        const route = body.routes[String(url)];
                        if (!route) throw new TypeError('connection refused: ' + url);
                        if (init?.redirect !== 'manual') throw new Error('redirects must be followed by hand');
                        return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers ?? { 'content-type': 'text/html' } });
                      };
                      report = await checkSeo(body.url);
                    } else {
                      report = await analyseSeoPage(body.url, body.page);
                    }
                    return Response.json({ report, google: googlePreview(report), social: socialPreview(report) });
                  } catch (error) {
                    return Response.json({ error: { status: error.status, type: error.type, message: error.message } });
                  }
                } };`,
            },
          },
        },
      },
    },
  ],
});

async function inWorkerd(body) {
  const response = await mf.dispatchFetch('http://checker/', { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}
const PAGE = 'https://shop.example.test/item';
/** analyseSeoPage on one response. */
const analyse = (html, page = {}) =>
  inWorkerd({
    url: PAGE,
    page: { html, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, url: PAGE, truncated: false, redirects: [], contentType: 'text/html; charset=utf-8', ...page },
  });
const codes = (result) => result.report.findings.map((finding) => finding.code);

const GOOD = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blue Widget – Hand-made in Sofia | Shop</title>
  <meta name="description" content="A hand-made blue widget, finished in Sofia and shipped worldwide within two days. Free returns for thirty days on every order.">
  <link rel="canonical" href="https://shop.example.test/item">
  <link rel="alternate" hreflang="en" href="https://shop.example.test/item">
  <link rel="alternate" hreflang="bg" href="https://shop.example.test/bg/item">
  <meta property="og:title" content="Blue Widget"><meta property="og:description" content="Hand-made in Sofia.">
  <meta property="og:image" content="https://shop.example.test/widget.jpg">
  <meta name="twitter:card" content="summary_large_image">
</head><body><h1>Blue &amp; Widget</h1><p>Text</p></body></html>`;

try {
  await section('SEO: a well-tagged page has nothing to fix', async () => {
    const result = await analyse(GOOD);
    assert.deepEqual(codes(result), []);
    const tags = result.report.tags;
    assert.equal(tags.title, 'Blue Widget – Hand-made in Sofia | Shop');
    assert.deepEqual(tags.h1, ['Blue & Widget'], 'entities decoded as on screen');
    assert.equal(tags.canonical, PAGE);
    assert.equal(tags.lang, 'en');
    assert.equal(tags.twitter.card, 'summary_large_image');
    assert.equal(tags.hreflang.length, 2);
    assert.equal(result.google.title, tags.title);
    assert.equal(result.google.crumbs, 'item');
    assert.equal(result.social.image, 'https://shop.example.test/widget.jpg');
  });

  await section('SEO: missing tags, noindex, a canonical elsewhere and several h1s are each named', async () => {
    const result = await analyse(`<html><head>
      <meta name="robots" content="noindex, nofollow">
      <link rel="canonical" href="https://other.example.test/item">
      </head><body><h1>One</h1><template><h1>Not shown</h1></template><h1>Two</h1>
      <svg><title>An icon</title></svg></body></html>`);
    const found = codes(result);
    for (const code of [
      'title_missing',
      'description_missing',
      'noindex',
      'canonical_elsewhere',
      'h1_several',
      'og_image_missing',
      'og_title_missing',
      'twitter_card_missing',
      'viewport_missing',
      'lang_missing',
    ]) {
      assert.ok(found.includes(code), `${code} in ${found.join(', ')}`);
    }
    assert.ok(!found.includes('nofollow'), 'noindex already says it; nofollow is not repeated');
    assert.equal(result.report.tags.title, null, 'an SVG title is not the page title');
    assert.deepEqual(result.report.tags.h1, ['One', 'Two'], 'a template’s h1 is not on the page');
    assert.equal(result.report.tags.h1Count, 2);
    const levels = result.report.findings.map((finding) => finding.level);
    assert.deepEqual(levels, [...levels].sort((a, b) => ['error', 'warning', 'notice'].indexOf(a) - ['error', 'warning', 'notice'].indexOf(b)), 'worst first');
    const noindex = result.report.findings.find((finding) => finding.code === 'noindex');
    assert.equal(noindex.level, 'error');
    assert.match(noindex.message, /leave this page out of their results/);
    assert.match(result.report.findings.find((finding) => finding.code === 'canonical_elsewhere').message, /other\.example\.test/);
  });

  await section('SEO: long and short text, relative addresses and hreflang without the page itself', async () => {
    const title = 'A very long product title that goes on and on well past what Google shows';
    const description = 'D'.repeat(200);
    const result = await analyse(`<html lang="en"><head><meta name="viewport" content="width=device-width">
      <title>${title}</title><meta name="description" content="${description}">
      <link rel="canonical" href="/item">
      <link rel="alternate" hreflang="de" href="/de/item">
      <meta property="og:image" content="/img/card.png">
      <meta property="twitter:card" content="summary">
      </head><body><h1></h1></body></html>`);
    const found = codes(result);
    for (const code of ['title_long', 'description_long', 'canonical_relative', 'og_image_relative', 'hreflang_no_self', 'h1_empty']) {
      assert.ok(found.includes(code), `${code} in ${found.join(', ')}`);
    }
    assert.ok(!found.includes('canonical_elsewhere'), 'a relative canonical to this page is this page');
    assert.ok(!found.includes('twitter_card_missing'), 'twitter:card written as a property still counts');
    assert.match(result.report.findings.find((finding) => finding.code === 'title_long').message, /is 73 characters/);
    assert.equal(result.google.title.length, 60);
    assert.ok(result.google.title.endsWith('…'));
    assert.equal(result.google.description.length, 160);
    assert.equal(result.social.image, 'https://shop.example.test/img/card.png');

    const short = await analyse(`<html lang="en"><head><meta name="viewport" content="width=device-width"><title>Shop</title>
      <meta name="description" content="Widgets."><meta property="og:image" content="javascript:alert(1)"></head><body><h1>Shop</h1></body></html>`);
    assert.ok(codes(short).includes('title_short'));
    assert.ok(codes(short).includes('description_short'));
    assert.equal(short.social.image, null, 'only an http(s) image is shown');
  });

  await section('SEO: status, X-Robots-Tag, bot checks and other content types', async () => {
    const gone = await analyse(GOOD, { status: 404 });
    assert.deepEqual(codes(gone), ['http_error']);
    const header = await analyse(GOOD, { headers: { 'content-type': 'text/html', 'x-robots-tag': 'googlebot: noindex' } });
    assert.deepEqual(codes(header), ['noindex_header']);
    const otherBot = await analyse(GOOD, { headers: { 'content-type': 'text/html', 'x-robots-tag': 'otherbot: noindex' } });
    assert.deepEqual(codes(otherBot), [], 'another crawler’s noindex is not Google’s');
    const challenge = await analyse('<html><title>Just a moment...</title></html>', { status: 403 });
    assert.ok(codes(challenge).includes('bot_check'));
    const pdf = await analyse('', { contentType: 'application/pdf', headers: { 'content-type': 'application/pdf' } });
    assert.deepEqual(codes(pdf), ['not_html']);
    assert.equal(pdf.report.tags, null);
    const cut = await analyse(GOOD, { truncated: true });
    assert.deepEqual(codes(cut), ['truncated']);
  });

  await section('SEO: the fetch follows redirects by hand, lists them, and refuses private hops', async () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    const result = await inWorkerd({
      url: 'http://shop.example.test/item',
      routes: {
        'http://shop.example.test/item': { status: 301, headers: { location: 'https://shop.example.test/item/' } },
        'https://shop.example.test/item/': { status: 308, headers: { location: '/item' } },
        'https://shop.example.test/item': { body: GOOD, headers: { ...html, 'x-robots-tag': 'noindex' } },
      },
    });
    assert.equal(result.report.finalUrl, 'https://shop.example.test/item');
    assert.deepEqual(result.report.redirects, [
      { url: 'http://shop.example.test/item', status: 301 },
      { url: 'https://shop.example.test/item/', status: 308 },
    ]);
    assert.deepEqual(codes(result).sort(), ['noindex_header', 'redirect_chain']);

    const blocked = await inWorkerd({
      url: 'https://shop.example.test/go',
      routes: { 'https://shop.example.test/go': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } },
    });
    assert.equal(blocked.error.status, 400);
    assert.equal(blocked.error.type, 'unreachable_url');
    assert.match(blocked.error.message, /cannot be checked/);

    const denied = await inWorkerd({
      url: 'https://shop.example.test/go',
      denylist: 'blocked.example.test',
      routes: { 'https://shop.example.test/go': { status: 302, headers: { location: 'https://blocked.example.test/' } } },
    });
    assert.match(denied.error.message, /cannot be checked/, 'a denylisted hop is refused like a private one');

    const loop = await inWorkerd({
      url: 'https://shop.example.test/a',
      routes: {
        'https://shop.example.test/a': { status: 302, headers: { location: '/b' } },
        'https://shop.example.test/b': { status: 302, headers: { location: '/a' } },
      },
    });
    assert.match(loop.error.message, /redirects more than 5 times/);

    const down = await inWorkerd({ url: 'https://down.example.test/', routes: {} });
    assert.match(down.error.message, /could not be reached/);
  });
} finally {
  await mf.dispose();
  console.error = quiet;
}

console.log(`\nall ${passed.length} checks passed`);
