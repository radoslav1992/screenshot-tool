/**
 * The capture engine's decisions, run without a Cloudflare browser.
 *
 * Most of what goes wrong in a capture is not the pixels: it is a request that
 * should not have left (a private address, a customer's Authorization header on
 * an analytics host), a fallback that drops what the caller asked for, a quota
 * two requests both spent, a file left in storage that nothing points at. Each
 * of those is a decision in shipped code, and each is checked here by running
 * that code — bundled with only the Worker bindings and the browser stubbed —
 * against a fake page, a real SQLite database, and, for the watermark, local
 * Chromium.
 *
 *   node scripts/capture-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const lib = (name) => new URL(`../src/lib/${name}.ts`, import.meta.url).pathname;

const cc = (globalThis.__cc = { env: {} });
/** The bundles hold on to this one object, so it is refilled rather than replaced. */
const setEnv = (values) => {
  for (const key of Object.keys(cc.env)) delete cc.env[key];
  Object.assign(cc.env, values);
};
const directory = mkdtempSync(join(tmpdir(), 'capture-check-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
let bundles = 0;

/**
 * Bundles one module of src/lib with the Worker-only imports replaced, plus any
 * sibling module named in `stubs` (by its `./name` import).
 */
async function load(entry, stubs = {}) {
  const contents = {
    'cloudflare:workers': 'export const env = globalThis.__cc.env;',
    '@cloudflare/puppeteer': 'export default globalThis.__cc.puppeteer;',
    ...stubs,
  };
  const plugin = {
    name: 'capture-check-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$|^@cloudflare\/puppeteer$/ }, (args) => ({
        path: args.path,
        namespace: 'stub',
      }));
      for (const name of Object.keys(stubs)) {
        builder.onResolve({ filter: new RegExp(`^\\./${name}$`) }, () => ({ path: name, namespace: 'stub' }));
      }
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: contents[args.path],
        loader: 'js',
        resolveDir: new URL('../src/lib/', import.meta.url).pathname,
      }));
    },
  };
  const result = await build({
    entryPoints: [lib(entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [plugin],
  });
  const out = join(directory, `${entry}-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

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

const passed = [];
const say = console.log.bind(console);
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  say(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

const options = await load('capture-options');
const parse = (input) => options.parseCaptureOptions(input);

await section('private hosts are refused however they are spelled', () => {
  for (const host of [
    'localhost',
    'localhost.',
    'foo.localhost.',
    'metadata.google.internal.',
    '127.0.0.1',
    '[::1]',
    '[::]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::ffff:a9fe:a9fe]',
    '[::127.0.0.1]',
    '[64:ff9b::a9fe:a9fe]',
    '[fe80::1]',
    '[febf::1]',
    '[fd00::1]',
    '2130706433',
    '10.0.0.1.',
  ]) {
    assert.throws(() => parse({ url: `http://${host}/` }), (error) => error.status === 400, host);
    assert.equal(options.isPrivateHost(new URL(`http://${host}/`).hostname), true, host);
  }
  for (const host of ['example.com', 'example.com.', '[2606:4700:4700::1111]', '[::ffff:8.8.8.8]', '8.8.8.8']) {
    assert.doesNotThrow(() => parse({ url: `https://${host}/` }), host);
    assert.equal(options.isPrivateHost(new URL(`https://${host}/`).hostname), false, host);
  }
});

await section('the host denylist ignores a trailing dot', () => {
  setEnv({ CAPTURE_HOST_DENYLIST: 'blocked.example' });
  assert.throws(() => parse({ url: 'https://blocked.example./' }), (error) => error.status === 400);
  setEnv({});
});

await section('prototype names are not devices', () => {
  for (const device of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(
      () => parse({ url: 'https://example.com', device }),
      (error) => error.status === 400 && error.param === 'device',
      device,
    );
  }
  assert.equal(options.isFrameId('constructor'), false);
  assert.equal(parse({ url: 'https://example.com', device: 'mobile' }).width, 390, 'presets still resolve');
});

/* -------------------------------------------------------------------------- */
/* Request bodies                                                              */
/* -------------------------------------------------------------------------- */

const http = await load('http');

await section('JSON bodies keep nested values usable', async () => {
  const body = await http.readBody(
    new Request('https://app.test/v1/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        headers: { 'x-token': 'secret' },
        actions: [{ kind: 'click', value: '.accept' }],
        sizes: ['desktop', 'mobile'],
        delay: 500,
        facts: true,
        skipped: null,
      }),
    }),
  );
  assert.deepEqual(body, {
    url: 'https://example.com',
    headers: '{"x-token":"secret"}',
    actions: '[{"kind":"click","value":".accept"}]',
    sizes: 'desktop,mobile',
    delay: '500',
    facts: 'true',
  });
  const parsed = parse(body);
  assert.deepEqual(parsed.auth.headers, { 'x-token': 'secret' });
  assert.deepEqual(parsed.actions, [{ kind: 'click', value: '.accept' }]);
  assert.deepEqual(parsed.sizes, ['desktop', 'mobile']);
});

await section('flat string bodies read exactly as before', async () => {
  const flat = { url: 'https://example.com', device: 'mobile', mode: 'fullpage', format: 'jpg' };
  const body = await http.readBody(
    new Request('https://app.test/api/captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(flat),
    }),
  );
  assert.deepEqual(body, flat);
});

/* -------------------------------------------------------------------------- */
/* Sitemaps                                                                    */
/* -------------------------------------------------------------------------- */

const captureStubs = {
  renderer: `import { HttpError } from './http';
             globalThis.__cc.HttpError = HttpError;
             export const render = (...args) => globalThis.__cc.render(...args);`,
  'visual-diff': `export const compareImages = async () => ({ changedPct: 0, changedPixels: 0, resized: false });
                  export const diffAvailable = () => true;`,
};
const batch = await load('batch', captureStubs);
const { parseSitemap } = await load('sitemap');

await section('sitemap locations are decoded, CDATA included', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/a?x=1&amp;y=2</loc></url>
    <url><loc> <![CDATA[https://example.com/b?x=1&y=2]]> </loc></url>
    <url><loc>https://example.com/caf&#233;</loc></url>
  </urlset>`;
  assert.deepEqual(parseSitemap(xml).pages, [
    'https://example.com/a?x=1&y=2',
    'https://example.com/b?x=1&y=2',
    'https://example.com/café',
  ]);
  assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc>https://example.com/s.xml</loc></sitemap></sitemapindex>'), {
    pages: [],
    indexes: ['https://example.com/s.xml'],
  });
});

await section('sitemap redirects are followed, and every hop is checked', async () => {
  const realFetch = globalThis.fetch;
  const routes = new Map();
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    assert.equal(init.redirect, 'manual');
    const route = routes.get(String(url));
    if (typeof route === 'function') return route();
    if (!route) throw new TypeError('fetch failed');
    return route;
  };
  const redirect = (to) => () => new Response(null, { status: 301, headers: { location: to } });
  const xml = (body) => () => new Response(`<urlset>${body}</urlset>`, { status: 200 });
  try {
    routes.set('http://example.com/sitemap.xml', redirect('https://example.com/sitemap.xml'));
    routes.set('https://example.com/sitemap.xml', redirect('https://www.example.com/sitemap.xml'));
    routes.set('https://www.example.com/sitemap.xml', xml('<url><loc>https://www.example.com/a?b=1&amp;c=2</loc></url>'));
    assert.deepEqual(await batch.urlsFromSitemap('http://example.com/sitemap.xml', 25), [
      'https://www.example.com/a?b=1&c=2',
    ]);

    for (const target of ['http://127.0.0.1/sitemap.xml', 'http://localhost./sitemap.xml', 'http://[::ffff:7f00:1]/']) {
      routes.set('https://evil.example/sitemap.xml', redirect(target));
      fetched.length = 0;
      await rejects(batch.urlsFromSitemap('https://evil.example/sitemap.xml', 25), statusOf(400, 'sitemap_unreachable'));
      assert.deepEqual(fetched, ['https://evil.example/sitemap.xml'], `${target} must never be fetched`);
    }

    for (let i = 0; i < 5; i++) routes.set(`https://loop.example/${i}`, redirect(`https://loop.example/${i + 1}`));
    await rejects(batch.urlsFromSitemap('https://loop.example/0', 25), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /too many/);
    });

    await rejects(batch.urlsFromSitemap('https://unresolvable.example/sitemap.xml', 25), statusOf(400, 'sitemap_unreachable'));
    routes.set('https://slow.example/sitemap.xml', () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await rejects(batch.urlsFromSitemap('https://slow.example/sitemap.xml', 25), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /too long/);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

const rate = await load('rate-limit');

await section('the rate limit counts cost, and fails open when KV does', async () => {
  const store = new Map();
  setEnv({ RATE: { get: async (key) => store.get(key) ?? null, put: async (key, value) => store.set(key, value) } });
  assert.equal((await rate.checkRateLimit('k', 3, 60, 2)).remaining, 1);
  assert.equal((await rate.checkRateLimit('k', 3, 60, 2)).ok, false, 'a comparison is two units');
  assert.equal((await rate.checkRateLimit('k', 3)).ok, true);

  const errors = console.error;
  let logged = 0;
  console.error = () => logged++;
  try {
    setEnv({ RATE: { get: async () => { throw new Error('KV GET failed: 500'); }, put: async () => {} } });
    assert.equal((await rate.checkRateLimit('x', 5)).ok, true);
    setEnv({ RATE: { get: async () => null, put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); } } });
    assert.equal((await rate.checkRateLimit('x', 5)).ok, true);
    assert.equal((await rate.checkRateLimit('x', 5)).ok, true);
  } finally {
    console.error = errors;
  }
  assert.equal(logged, 1, 'logged once, not on every request');
  assert.equal((await rate.checkRateLimit('none', 0)).ok, false, 'a plan without API access is still refused');
});

/* -------------------------------------------------------------------------- */
/* The renderer                                                                */
/* -------------------------------------------------------------------------- */

const renderer = await load('renderer', {
  'browser-pool': `export const openPage = (...args) => globalThis.__cc.openPage(...args);
                   export const closePage = (...args) => globalThis.__cc.closePage(...args);`,
});

await section('ad blocking matches hostnames, not text in a URL', () => {
  for (const url of [
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://doubleclick.net/x',
    'https://www.google-analytics.com/analytics.js',
    'https://adservice.google.com/adsid/integrator.js',
    'https://adservice.google.co.uk/x',
    'https://static.criteo.net/js/ld/publishertag.js',
    'https://criteo.com/',
    'https://connect.facebook.net/en_US/fbevents.js',
  ]) {
    assert.equal(renderer.isAdHost(url), true, url);
  }
  for (const url of [
    'https://example.com/?ref=doubleclick.net',
    'https://example.com/assets/facebook.net.js',
    'https://notdoubleclick.net/',
    'https://facebook.com/',
    'not a url',
  ]) {
    assert.equal(renderer.isAdHost(url), false, url);
  }
});

await section('subrequests to private addresses are refused', () => {
  for (const url of [
    'http://localhost./',
    'http://foo.localhost./',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::]/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ]) {
    assert.equal(renderer.isPublicResource(url), false, url);
  }
  for (const url of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'blob:https://example.com/x']) {
    assert.equal(renderer.isPublicResource(url), true, url);
  }
});

await section('credentials are scoped to the page being captured', () => {
  assert.deepEqual([...renderer.targetOrigins('https://example.com/a')], ['https://example.com']);
  assert.deepEqual([...renderer.targetOrigins('http://example.com/a')], ['http://example.com', 'https://example.com']);
  assert.deepEqual([...renderer.targetOrigins('http://example.com:8080/a')], ['http://example.com:8080']);
});

await section('REST stands in only for what it can do', () => {
  const plain = parse({ url: 'https://example.com', block_ads: '0' });
  assert.deepEqual(renderer.restUnsupported(plain, true), []);
  assert.deepEqual(renderer.restUnsupported(parse({ url: 'https://example.com' }), true), ['block_ads']);
  assert.deepEqual(renderer.restUnsupported(parse({ url: 'https://example.com' }), false), []);
  for (const [param, value] of [
    ['hide', '.x'],
    ['blur', '.x'],
    ['redact_pii', '1'],
    ['ignore_regions', '0,0,10,10'],
    ['basic_auth', 'a:b'],
    ['cookies', '{"s":"1"}'],
    ['headers', '{"x-a":"1"}'],
    ['actions', 'click:.a'],
    ['dark_mode', '1'],
    ['sizes', 'mobile'],
  ]) {
    const asked = parse({ url: 'https://example.com', block_ads: '0', [param]: value });
    assert.notDeepEqual(renderer.restUnsupported(asked, false), [], param);
    assert.notDeepEqual(renderer.restUnsupported(asked, true), [], param);
  }
  for (const [param, value] of [['dismiss_consent', '1'], ['facts', '1'], ['mode', 'series']]) {
    const asked = parse({ url: 'https://example.com', block_ads: '0', [param]: value });
    assert.notDeepEqual(renderer.restUnsupported(asked, true), [], param);
  }
});

await section('a deadline frees a hung capture', async () => {
  let closed = false;
  await rejects(
    renderer.withDeadline(new Promise(() => {}), 20, () => (closed = true)),
    statusOf(504, 'render_timeout'),
  );
  assert.equal(closed, true);
  let expired = false;
  assert.equal(await renderer.withDeadline(Promise.resolve('done'), 20, () => (expired = true)), 'done');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(expired, false);
});

/** A Puppeteer page that answers the calls the renderer makes, and records them. */
function fakePage({ redirectTo, subrequests = [], navigateTo } = {}) {
  const handlers = {};
  const mainFrame = {};
  const page = {
    requests: [],
    evaluated: [],
    viewports: [],
    closed: false,
    extraHeaders: null,
    authenticated: null,
    on: (event, fn) => (handlers[event] ??= []).push(fn),
    setViewport: async (viewport) => page.viewports.push(viewport),
    setRequestInterception: async (on) => (page.interception = on),
    setExtraHTTPHeaders: async (headers) => (page.extraHeaders = headers),
    authenticate: async (credentials) => (page.authenticated = credentials),
    setCookie: async (...cookies) => (page.cookies = cookies),
    emulateMediaFeatures: async () => {},
    mainFrame: () => mainFrame,
    url: () => page.current,
    waitForNetworkIdle: async () => {},
    addStyleTag: async () => {},
    evaluate: async (fn) => {
      page.evaluated.push(typeof fn === 'function' ? fn.name || 'anonymous' : 'script');
      return 1000;
    },
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    close: async () => (page.closed = true),
    /** Sends a request through the renderer's interception and reports what it decided. */
    request(url, { navigation = false, frame = mainFrame } = {}) {
      const request = {
        url: () => url,
        isNavigationRequest: () => navigation,
        frame: () => frame,
        headers: () => ({ accept: '*/*' }),
        abort: async () => (request.outcome = 'abort'),
        continue: async (overrides) => {
          request.outcome = 'continue';
          request.overrides = overrides;
        },
      };
      for (const fn of handlers.request ?? []) fn(request);
      page.requests.push(request);
      return request;
    },
    goto: async (url) => {
      const first = page.request(url, { navigation: true });
      if (first.outcome !== 'continue') throw new Error('net::ERR_FAILED');
      if (redirectTo) {
        const hop = page.request(redirectTo, { navigation: true });
        if (hop.outcome !== 'continue') throw new Error('net::ERR_FAILED');
      }
      for (const sub of subrequests) page.request(sub, { frame: {} });
      page.current = navigateTo ?? url;
      return { status: () => 200 };
    },
  };
  return page;
}

function useBrowser(page) {
  const lease = { page, context: {}, lease: { browser: {}, reused: false } };
  cc.openPage = async () => lease;
  cc.closePage = async (session, succeeded) => {
    lease.released = { succeeded };
    await session.page.close();
  };
  return lease;
}

const realFetch = globalThis.fetch;
let restCalls = 0;
globalThis.fetch = async () => {
  restCalls++;
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
};
const quietErrors = console.error;
const quietLogs = console.log;
console.error = () => {};
console.log = () => {};

try {
  await section('credentials go only to the target origin; every hop is guarded', async () => {
    setEnv({ BROWSER: {} });
    const page = fakePage({
      subrequests: [
        'https://example.com/app.js',
        'https://cdn.thirdparty.test/lib.js',
        'https://www.google-analytics.com/analytics.js',
        'https://example.com/?ref=doubleclick.net',
        'http://[::ffff:7f00:1]/admin',
        'http://192.168.0.1/router.png',
      ],
    });
    const lease = useBrowser(page);
    const result = await renderer.render(
      parse({ url: 'https://example.com/', headers: '{"x-token":"s3cret"}', basic_auth: 'user:pw' }),
    );
    assert.equal(result.engine, 'binding');
    assert.equal(page.interception, true);
    assert.equal(page.extraHeaders, null, 'never as headers on every request');
    assert.deepEqual(page.authenticated, { username: 'user', password: 'pw' });
    const [main, own, third, analytics, query, mapped, lan] = page.requests;
    for (const request of [main, own]) {
      assert.equal(request.overrides.headers['x-token'], 's3cret');
      assert.equal(request.overrides.headers.authorization, `Basic ${btoa('user:pw')}`);
      assert.equal(request.overrides.headers.accept, '*/*', 'the browser’s own headers are kept');
    }
    assert.equal(third.outcome, 'continue');
    assert.equal(third.overrides, undefined, 'a third-party host gets no credentials');
    assert.equal(analytics.outcome, 'abort');
    assert.equal(query.outcome, 'continue', 'an ad host named in a query string is not an ad');
    assert.equal(mapped.outcome, 'abort');
    assert.equal(lan.outcome, 'abort');
    assert.deepEqual(lease.released, { succeeded: true });
    assert.equal(page.closed, true);
  });

  await section('a redirect to a private address fails the capture', async () => {
    const page = fakePage({ redirectTo: 'http://169.254.169.254/latest/meta-data/' });
    const lease = useBrowser(page);
    await rejects(renderer.render(parse({ url: 'https://example.com/' })), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.type, 'unreachable_url');
      assert.match(error.message, /private/);
    });
    assert.deepEqual(lease.released, { succeeded: false });
    assert.equal(restCalls, 0);
  });

  await section('the page’s own document is never blocked as an ad', async () => {
    const page = fakePage();
    useBrowser(page);
    await renderer.render(parse({ url: 'https://ads.doubleclick.net/landing' }));
    assert.equal(page.requests[0].outcome, 'continue');
  });

  await section('each size is masked against its own layout and handed on as shot', async () => {
    const page = fakePage();
    useBrowser(page);
    const handed = [];
    const options = parse({ url: 'https://example.com/', sizes: 'desktop,mobile', hide: '.x', ignore_regions: '0,0,5,5' });
    options.watermark = true;
    const result = await renderer.render(options, async (file) => handed.push(file.name));
    assert.deepEqual(handed, ['desktop.png', 'mobile.png']);
    assert.deepEqual(result.files, [], 'handed-on files are not also held');
    const redactions = page.evaluated.filter((name) => name === 'redactInPage').length;
    assert.equal(redactions, 3, 'once for the page, then again for each viewport');
  });

  await section('monitor phrases and redaction reach the facts reader', async () => {
    const page = fakePage();
    const evaluate = page.evaluate;
    let request = null;
    page.evaluate = async (fn, ...args) => {
      if (fn?.name === 'readFactsInPage') {
        request = args[0] ?? null;
        throw new Error('facts are not under test here');
      }
      return evaluate(fn, ...args);
    };
    useBrowser(page);
    const options = parse({ url: 'https://example.com/', facts: '1', redact_pii: '1' });
    options.monitorPhrases = ['In stock'];
    await renderer.render(options).catch(() => undefined);
    assert.ok(request, 'the facts reader was called with a request');
    assert.deepEqual(request.phrases, ['In stock'], 'the phrase is answered against the whole page');
    assert.ok(request.redact?.some((pattern) => pattern.source.includes('@')), 'the head is covered by the PII patterns');
  });

  await section('an error inside the page is never retried through REST', async () => {
    setEnv({ BROWSER: {}, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'token' });
    const page = fakePage();
    page.evaluate = async (fn) => {
      if (fn?.name === 'redactInPage') throw new Error('Execution context was destroyed');
      return 1000;
    };
    useBrowser(page);
    await rejects(
      renderer.render(parse({ url: 'https://example.com/', block_ads: '0', redact_pii: '1' })),
      statusOf(502, 'redaction_failed'),
    );
    const failing = fakePage();
    failing.goto = async () => {
      throw new Error('Navigation timeout of 30000 ms exceeded');
    };
    useBrowser(failing);
    await rejects(renderer.render(parse({ url: 'https://example.com/', block_ads: '0' })), statusOf(504, 'render_timeout'));
    assert.equal(restCalls, 0);
  });

  await section('an unreachable binding falls back only for what REST can honour', async () => {
    setEnv({ BROWSER: {}, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'token' });
    cc.openPage = async () => {
      throw new Error('Unable to connect to the browser');
    };
    await rejects(renderer.render(parse({ url: 'https://example.com/' })), statusOf(503, 'browser_unavailable'));
    await rejects(
      renderer.render(parse({ url: 'https://example.com/', block_ads: '0', hide: '.secret' })),
      statusOf(503, 'browser_unavailable'),
    );
    assert.equal(restCalls, 0, 'block_ads and hide cannot be honoured, so REST is not asked');
    const result = await renderer.render(parse({ url: 'https://example.com/', block_ads: '0' }));
    assert.equal(result.engine, 'rest');
    assert.equal(restCalls, 1);

    setEnv({ BROWSER: {} });
    await rejects(renderer.render(parse({ url: 'https://example.com/', block_ads: '0' })), statusOf(503, 'browser_unavailable'));
  });

  await section('a REST-only deployment refuses what it cannot do', async () => {
    setEnv({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'token' });
    restCalls = 0;
    await rejects(renderer.render(parse({ url: 'https://example.com/', hide: '.x' })), statusOf(501, 'unsupported_option'));
    assert.equal(restCalls, 0);
    assert.equal((await renderer.render(parse({ url: 'https://example.com/' }))).engine, 'rest');
  });
} finally {
  globalThis.fetch = realFetch;
  console.error = quietErrors;
  console.log = quietLogs;
}

/* -------------------------------------------------------------------------- */
/* The browser pool                                                            */
/* -------------------------------------------------------------------------- */

const pool = await load('browser-pool');

await section('a full pool is waited out, briefly and with jitter', async () => {
  setEnv({ BROWSER: {}, BROWSER_KEEP_ALIVE_MS: '0' });
  const realTimeout = globalThis.setTimeout;
  const waits = [];
  globalThis.setTimeout = (fn, ms) => {
    waits.push(ms);
    return realTimeout(fn, 0);
  };
  const logs = console.log;
  console.log = () => {};
  try {
    let launches = 0;
    const full = { allowedBrowserAcquisitions: 0, maxConcurrentSessions: 2, activeSessions: [{}, {}] };
    const puppeteer = (succeedOn) => ({
      sessions: async () => [],
      launch: async () => {
        launches++;
        if (launches === succeedOn) return { id: 'fresh' };
        throw new Error('Unable to create new browser: code: 429');
      },
      limits: async () => full,
    });

    launches = 0;
    const lease = await pool.acquireBrowser(puppeteer(2));
    assert.equal(lease.browser.id, 'fresh');
    assert.equal(launches, 2);

    launches = 0;
    waits.length = 0;
    await rejects(pool.acquireBrowser(puppeteer(0)), statusOf(503, 'browser_unavailable'));
    assert.equal(launches, 3, 'three tries');
    assert.equal(waits.length, 2);
    for (const ms of waits) assert.ok(ms >= 1500 && ms <= 2500, `waited ${ms} ms`);

    launches = 0;
    const broken = { ...puppeteer(0), limits: async () => ({ ...full, allowedBrowserAcquisitions: 1 }) };
    await rejects(pool.acquireBrowser(broken), (error) => assert.match(error.message, /429/));
    assert.equal(launches, 1, 'any other launch failure is not retried');
  } finally {
    globalThis.setTimeout = realTimeout;
    console.log = logs;
  }
});

await section('every capture gets its own browser context', async () => {
  setEnv({ BROWSER: {}, BROWSER_KEEP_ALIVE_MS: '60000' });
  const logs = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    const events = [];
    const browser = (name, { contextFails = false, pageFails = false } = {}) => ({
      createBrowserContext: async () => {
        if (contextFails) throw new Error('not supported');
        return {
          newPage: async () => {
            if (pageFails) throw new Error('Target closed');
            return { name: `${name}-page`, close: async () => events.push(`${name}:page.close`) };
          },
          close: async () => events.push(`${name}:context.close`),
        };
      },
      newPage: async () => ({ name: `${name}-default-page`, close: async () => events.push(`${name}:page.close`) }),
      close: async () => events.push(`${name}:close`),
      disconnect: async () => events.push(`${name}:disconnect`),
    });

    // A reused session that will not open a page is closed, and a fresh one launched.
    const stale = browser('stale', { pageFails: true });
    const fresh = browser('fresh');
    const session = await pool.openPage({
      sessions: async () => [{ sessionId: 's1' }],
      connect: async () => stale,
      launch: async () => fresh,
    });
    assert.equal(session.page.name, 'fresh-page');
    assert.equal(session.lease.reused, false);
    assert.ok(events.includes('stale:close'));

    // Warm sessions are kept only when the page had a context of its own.
    events.length = 0;
    await pool.closePage(session, true);
    assert.deepEqual(events, ['fresh:page.close', 'fresh:context.close', 'fresh:disconnect']);

    events.length = 0;
    const shared = await pool.openPage({ sessions: async () => [], launch: async () => browser('plain', { contextFails: true }) });
    assert.equal(shared.context, null);
    assert.equal(shared.page.name, 'plain-default-page');
    await pool.closePage(shared, true);
    assert.deepEqual(events, ['plain:page.close', 'plain:close'], 'a default-context session is never kept warm');
  } finally {
    [console.log, console.error] = logs;
  }
});

/* -------------------------------------------------------------------------- */
/* Quota, storage and failures                                                 */
/* -------------------------------------------------------------------------- */

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort().filter((f) => f.endsWith('.sql'))) {
  db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
const now = new Date().toISOString();
for (const id of ['racer', 'series', 'failer', 'pair'])
  db.prepare(
    `INSERT INTO users(id,email,email_lower,plan,period_start,created_at,updated_at) VALUES(?,?,?,'free',?,?,?)`,
  ).run(id, `${id}@example.test`, `${id}@example.test`, now, now, now);

const statement = (sql, args = []) => ({
  sql,
  args,
  bind: (...values) => statement(sql, values),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});
const objects = new Map();
let failPutAfter = Infinity;
const D1 = {
  prepare: (sql) => statement(sql),
  // Synchronous, as D1 runs a batch: one transaction, nothing interleaved.
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
const env = {
  DB: D1,
  SHOTS: {
    put: async (key) => {
      if (objects.size >= failPutAfter) throw new Error('R2 put failed');
      objects.set(key, true);
    },
    delete: async (key) => objects.delete(key),
  },
};

const captures = await load('captures', captureStubs);
// Each bundle has its own copy of http.ts; failures must be this bundle's kind.
const HttpError = cc.HttpError;
const compare = await load('compare', captureStubs);
setEnv(env);
const used = (user) => db.prepare('SELECT used FROM usage_counters WHERE user_id = ?').get(user)?.used ?? 0;
const setUsed = (user, count) =>
  db.prepare('INSERT OR REPLACE INTO usage_counters (user_id, period, used) VALUES (?, ?, ?)').run(
    user,
    new Date().toISOString().slice(0, 7),
    count,
  );
const user = (id, freeQuota = 5) => ({ id, email: `${id}@example.test`, plan: 'free', freeQuota });
const file = (name, index = 1) => ({
  data: new Uint8Array([1, 2, 3]),
  contentType: 'image/png',
  ext: 'png',
  index,
  ...(name ? { name } : {}),
  width: 1440,
  height: 900,
});
const rows = (userId) => db.prepare('SELECT id, status FROM captures WHERE user_id = ?').all(userId);

await section('parallel captures cannot spend the same screenshots', async () => {
  setUsed('racer', 2);
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => captures.createCaptureRow(user('racer'), parse({ url: 'https://example.com' }), 'app')),
  );
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 3);
  for (const attempt of attempts.filter((a) => a.status === 'rejected')) {
    assert.equal(attempt.reason.status, 402);
    assert.equal(attempt.reason.type, 'quota_exceeded');
  }
  assert.equal(used('racer'), 5, 'reserved up to the quota and not past it');
  assert.equal(rows('racer').length, 3);
});

await section('a short series gets its unused frames back', async () => {
  const options = parse({ url: 'https://example.com', mode: 'series' });
  const row = await captures.createCaptureRow(user('series', 50), options, 'api');
  assert.equal(row.reserved, 20);
  assert.equal(used('series'), 20);
  cc.render = async () => ({ files: [file(null, 1), file(null, 2), file(null, 3)], engine: 'binding', durationMs: 5 });
  const done = await captures.runCapture(row, options);
  assert.equal(done.status, 'done');
  assert.equal(used('series'), 3, 'charged for the three frames it produced');
  assert.equal(db.prepare('SELECT via_api FROM usage_counters WHERE user_id = ?').get('series').via_api, 3);
  assert.deepEqual(
    captures.safeParseFiles(done.files).map((f) => f.name),
    ['01.png', '02.png', '03.png'],
  );
});

await section('a failed capture is refunded, keeps its error type, and leaves no files', async () => {
  setUsed('failer', 0);
  objects.clear();
  const options = parse({ url: 'https://example.com', mode: 'series' });
  const row = await captures.createCaptureRow(user('failer', 50), options, 'app');
  cc.render = async () => {
    throw new HttpError(504, 'render_timeout', 'The page took too long to load and the capture timed out.');
  };
  const failed = await captures.runCapture(row, options);
  assert.equal(used('failer'), 0);
  assert.equal(failed.status, 'error');
  const dto = captures.toDTO(failed, 'https://app.test');
  assert.equal(dto.error, 'The page took too long to load and the capture timed out.');
  assert.equal(dto.error_type, 'render_timeout');
  assert.equal(captures.captureErrorStatus(failed), 504);
  const stored = db.prepare('SELECT * FROM captures WHERE id = ?').get(row.id);
  assert.equal(captures.toDTO(stored, 'https://app.test').error_type, 'render_timeout', 'classified from the stored message');
  for (const key of ['id', 'status', 'url', 'display_url', 'device', 'mode', 'format', 'source', 'images', 'created_at']) {
    assert.ok(key in dto, `${key} stays in the capture`);
  }

  // Two files due, the second upload fails: the first must not be left behind.
  const second = await captures.createCaptureRow(user('failer', 50), parse({ url: 'https://example.com', mode: 'series' }), 'app');
  cc.render = async () => ({ files: [file(null, 1), file(null, 2)], engine: 'binding', durationMs: 5 });
  failPutAfter = 1;
  const partial = await captures.runCapture(second, options);
  failPutAfter = Infinity;
  assert.equal(partial.status, 'error');
  assert.equal(objects.size, 0, 'the uploaded half is deleted');
  assert.equal(used('failer'), 0);
});

await section('a capture deleted while pending leaves no files', async () => {
  objects.clear();
  const options = parse({ url: 'https://example.com', sizes: 'mobile' });
  const row = await captures.createCaptureRow(user('failer', 50), options, 'app');
  cc.render = async (_options, onFile) => {
    await onFile(file('desktop.png'));
    await onFile(file('mobile.png'));
    db.prepare('DELETE FROM captures WHERE id = ?').run(row.id);
    return { files: [], engine: 'binding', durationMs: 5 };
  };
  const result = await captures.runCapture(row, options);
  assert.equal(result.status, 'error');
  assert.equal(objects.size, 0);

  const kept = await captures.createCaptureRow(user('failer', 50), options, 'app');
  cc.render = async (_options, onFile) => {
    await onFile(file('desktop.png'));
    await onFile(file('mobile.png'));
    return { files: [], engine: 'binding', durationMs: 5 };
  };
  const done = await captures.runCapture(kept, options);
  assert.deepEqual(captures.safeParseFiles(done.files).map((f) => f.name), ['desktop.png', 'mobile.png']);
  assert.equal(objects.size, 2);
});

await section('a comparison is refused before anything renders', async () => {
  assert.throws(
    () => compare.splitCompareInput({ a_url: 'https://a.test', b_url: 'https://b.test', basic_auth: 'u:p' }),
    (error) => error.status === 400 && error.param === 'basic_auth',
  );
  const sides = compare.splitCompareInput({
    a_url: 'https://a.test',
    b_url: 'https://b.test',
    a_cookies: '{"s":"1"}',
    device: 'mobile',
  });
  assert.equal(sides.before.cookies, '{"s":"1"}');
  assert.equal(sides.after.cookies, undefined, 'one side’s credentials stay on that side');
  assert.equal(sides.after.device, 'mobile');

  setUsed('pair', 0);
  let rendered = 0;
  cc.render = async () => {
    rendered++;
    return { files: [file()], engine: 'binding', durationMs: 5 };
  };
  const a = () => parse({ url: 'https://a.test' });
  await rejects(
    compare.compareCaptures(user('pair'), a(), parse({ url: 'https://b.test', sizes: 'mobile' }), 'https://app.test'),
    (error) => assert.equal(error.param, 'sizes'),
  );
  await rejects(
    compare.compareCaptures(user('pair'), a(), parse({ url: 'https://b.test', width: '1000' }), 'https://app.test'),
    statusOf(403, 'plan_required'),
  );
  setUsed('pair', 4);
  await rejects(compare.compareCaptures(user('pair'), a(), a(), 'https://app.test'), statusOf(402, 'quota_exceeded'));
  assert.equal(rows('pair').length, 0);
  assert.equal(used('pair'), 4);

  // The second side loses its reservation: the first is taken back, unrendered.
  setUsed('pair', 0);
  const batchRun = D1.batch;
  let reservations = 0;
  D1.batch = async (statements) => {
    if (++reservations === 2) throw new Error('D1_ERROR: database is locked');
    return batchRun(statements);
  };
  try {
    await rejects(compare.compareCaptures(user('pair'), a(), a(), 'https://app.test'), (error) =>
      assert.match(error.message, /locked/),
    );
  } finally {
    D1.batch = batchRun;
  }
  assert.equal(rows('pair').length, 0);
  assert.equal(used('pair'), 0);
  assert.equal(rendered, 0);

  const result = await compare.compareCaptures(user('pair'), a(), a(), 'https://app.test');
  assert.equal(result.identical, true);
  assert.equal(used('pair'), 2);
});

/* -------------------------------------------------------------------------- */
/* The watermark                                                               */
/* -------------------------------------------------------------------------- */

const watermark = await load('watermark');

await section('the watermark survives the page’s stylesheet and looks as it always has', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
    const id = watermark.watermarkId();
    assert.notEqual(id, watermark.watermarkId(), 'a new id every capture');
    assert.match(id, /^m[0-9a-f]{16}$/);

    await page.setContent(`<!doctype html><style>
      #__esc_mark, html > div, div[id^="m"] { display: none !important; opacity: 0 !important;
        visibility: hidden !important; transform: scale(0) !important; }
    </style><body style="margin:0;background:#fff">`);
    await page.evaluate(watermark.watermarkScript('visible', id));
    await page.evaluate(watermark.watermarkScript('visible', id));
    const seen = await page.evaluate((markId) => {
      const marks = document.querySelectorAll(`#${markId}`);
      const box = marks[0].getBoundingClientRect();
      const style = getComputedStyle(marks[0]);
      return { count: marks.length, width: box.width, display: style.display, opacity: style.opacity, visibility: style.visibility };
    }, id);
    assert.deepEqual(
      { ...seen, width: seen.width > 100 },
      { count: 1, width: true, display: 'flex', opacity: '1', visibility: 'visible' },
    );

    /*
     * What the mark has always been, declaration for declaration. The new one
     * must paint the same pixels on an ordinary page.
     */
    const original = () => {
      const badge = document.createElement('div');
      const dot = document.createElement('span');
      dot.style.cssText =
        'width:6px;height:6px;border-radius:50%;background:#D7F25F;display:inline-block;margin-right:6px;flex:0 0 auto';
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode('easyscreencapture.com'));
      badge.style.cssText = [
        'position:fixed', 'right:14px', 'z-index:2147483647', 'display:inline-flex', 'align-items:center',
        'padding:6px 11px', 'border-radius:999px', 'background:rgba(15,17,12,0.82)', 'color:#F5F3EE',
        'font:600 11px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif', 'letter-spacing:0.02em',
        'box-shadow:0 2px 10px rgba(0,0,0,0.25)', 'pointer-events:none', 'margin:0',
      ].join(';');
      badge.style.bottom = '14px';
      document.documentElement.appendChild(badge);
    };
    const plain = '<!doctype html><body style="margin:0;background:linear-gradient(#fff,#9ab)"><p>Page</p>';
    await page.setContent(plain);
    await page.evaluate(original);
    const before = await page.screenshot();
    await page.setContent(plain);
    await page.evaluate(watermark.watermarkScript('visible'));
    const after = await page.screenshot();
    assert.ok(before.equals(after), 'the mark looks exactly as it did');
  } finally {
    await browser.close();
  }
});

say(`\nall ${passed.length} checks passed`);
