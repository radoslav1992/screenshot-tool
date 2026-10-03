/**
 * Growth: first-touch signup attribution, the referral programme, bonus
 * screenshots in the quota, the owner dashboard and the report link — with
 * migration 0017 and without it. Real SQLite (every migration), an in-memory
 * KV, a mocked mailer and a stubbed renderer. No network calls.
 *
 *   node scripts/growth-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'growth-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__growth = {
  env: {},
  mails: [],
  mailReady: true,
  render: async () => {
    throw new Error('no render set');
  },
});

const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__growth.env;',
  'astro:middleware': 'export const defineMiddleware = (fn) => fn;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts':
    'export const canSendEmail = () => globalThis.__growth.mailReady;' +
    'export async function sendMail(mail) { globalThis.__growth.mails.push(mail); return globalThis.__growth.mailReady; }',
  '/lib/renderer.ts': 'export const render = (...args) => globalThis.__growth.render(...args);',
  '/lib/visual-diff.ts':
    'export const diffAvailable = () => true;' +
    'export async function compareImages() { return { changedPct: 0, changedPixels: 0, sharedPct: 0, resized: false, width: 1440, height: 900, regions: [] }; }',
  '/lib/summarise.ts': 'export async function summariseChange() { return { sentence: "", detail: "", source: "plain" }; }',
  '/lib/apple-billing.ts': 'export async function refreshAppleUser() {} export async function refreshAppleSubscriptions() {}',
};

const plugin = {
  name: 'growth-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|astro:middleware|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
  },
};

let bundles = 0;
/** A fresh copy of a module, with its own per-isolate probe caches, as a new isolate would have. */
async function load(entry) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [plugin],
    logLevel: 'silent',
  });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

/** A database with every migration, or every one but 0017. */
function database({ growth = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!growth && file === '0017_growth.sql') continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** D1 over node:sqlite: each statement atomic, a batch one transaction that nothing interleaves with. */
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

const kv = new Map();
const RATE = {
  get: async (key) => kv.get(key) ?? null,
  put: async (key, value) => void kv.set(key, value),
  delete: async (key) => void kv.delete(key),
};
const objects = new Map();
const SHOTS = {
  put: async (key, data) => void objects.set(key, data),
  get: async () => null,
  head: async () => null,
  delete: async (keys) => {
    for (const key of [keys].flat()) objects.delete(key);
  },
  list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
};

/** A new world: its own database, the same env object every bundle holds on to. */
function world({ growth = true } = {}) {
  const db = database({ growth });
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, {
    DB: d1(db),
    RATE,
    SHOTS,
    BROWSER: {},
    PUBLIC_SITE_URL: 'https://easyscreencapture.test',
    REQUIRE_EMAIL_VERIFICATION: '0',
    CAPTURE_HOST_DENYLIST: '',
    // Most sections exercise the opt-in cookie; 'by default nothing is stored in the browser' runs without it.
    ATTRIBUTION_COOKIE: '1',
  });
  kv.clear();
  objects.clear();
  fx.mails.length = 0;
  fx.mailReady = true;
  fx.render = async () => ({ files: [png()], engine: 'binding', durationMs: 5 });
  return db;
}

const png = (index = 1) => ({ data: new Uint8Array([1, 2, 3]), contentType: 'image/png', ext: 'png', index, width: 1440, height: 900 });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ORIGIN = 'https://easyscreencapture.test';
const now = () => new Date().toISOString();
const period = () => now().slice(0, 7);

function addUser(db, id, { email = `${id}@example.test`, plan = 'free', verified = false, freeQuota = 20 } = {}) {
  const at = now();
  db.prepare(
    `INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at, email_verified_at, free_quota)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, email.toLowerCase(), id, plan, at, at, at, verified ? at : null, freeQuota);
  return { id, email, name: id, plan, freeQuota, periodStart: at, createdAt: at };
}
const setUsed = (db, userId, used) =>
  db.prepare('INSERT OR REPLACE INTO usage_counters (user_id, period, used) VALUES (?, ?, ?)').run(userId, period(), used);
const setBonus = (db, userId, screenshots) =>
  db.prepare('INSERT OR REPLACE INTO bonus_balances (user_id, screenshots, updated_at) VALUES (?, ?, ?)').run(userId, screenshots, now());
const bonusOf = (db, userId) => db.prepare('SELECT screenshots FROM bonus_balances WHERE user_id = ?').get(userId)?.screenshots ?? 0;
const usedOf = (db, userId) => db.prepare('SELECT used FROM usage_counters WHERE user_id = ? AND period = ?').get(userId, period())?.used ?? 0;
const drawnOf = (db, userId) => db.prepare('SELECT used FROM bonus_usage WHERE user_id = ? AND period = ?').get(userId, period())?.used ?? 0;
const referralOf = (db, referredId) => db.prepare('SELECT * FROM referrals WHERE referred_id = ?').get(referredId);
const sourceOf = (db, userId) => db.prepare('SELECT * FROM signup_sources WHERE user_id = ?').get(userId);

const errors = [];
const originalError = console.error;
const originalLog = console.log;

try {
  /* ------------------------------------------------------------------------ */
  /* Bundles                                                                   */
  /* ------------------------------------------------------------------------ */

  world();
  const attribution = await load('src/lib/attribution.ts');
  const middleware = await load('src/middleware.ts');
  const growth = await load('src/lib/growth.ts');
  const report = await load('src/lib/growth-report.ts');
  const captures = await load('src/lib/captures.ts');
  const options = await load('src/lib/capture-options.ts');
  const verification = await load('src/lib/verification.ts');
  const watches = await load('src/lib/watches.ts');
  const deletion = await load('src/lib/account-deletion.ts');
  const signup = (await load('src/pages/api/auth/signup.ts')).POST;
  const join_ = await load('src/pages/join/[code].ts');
  const profile = (await load('src/pages/api/mobile/profile.ts')).GET;
  const parse = (input) => options.parseCaptureOptions(input);

  console.error = (...args) => errors.push(args.map(String).join(' '));
  console.log = (...args) => {
    if (String(args[0]).startsWith('ok ')) originalLog(...args);
  };

  /** Signs up like the web form (Origin, cookie) or like the iOS app (JSON, no Origin, no cookie). */
  const signUp = async (email, { cookie, origin = ORIGIN, ip = '203.0.113.1', agent = 'Mozilla/5.0 (Macintosh)', json = true } = {}) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'user-agent': agent };
    if (json) headers.accept = 'application/json';
    if (origin) headers.origin = origin;
    const request = new Request(`${ORIGIN}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ email, password: 'growth-pass-1', name: 'G' }) });
    // Astro's cookies.get() hands the value over decoded once.
    const cookies = { get: (name) => (name === 'sf_src' && cookie !== undefined ? { value: decodeURIComponent(cookie) } : undefined) };
    const response = await signup({ request, locals: {}, cookies });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, setCookie: response.headers.getSetCookie(), headers: response.headers };
  };
  /** The value an sf_src Set-Cookie carries. */
  const valueOf = (setCookie) => /^sf_src=([^;]*)/.exec(setCookie)?.[1];

  /* ------------------------------------------------------------------------ */
  /* Attribution                                                               */
  /* ------------------------------------------------------------------------ */

  await section('attribution: sanitised and capped, referrer host only, never a query or full URL', async () => {
    const long = 'x'.repeat(300);
    const url = new URL(
      `${ORIGIN}/pricing/plans?ref=Report%3Cscript%3E&utm_source=News%20Letter!!&utm_medium=E-Mail&utm_campaign=${long}&secret=1`,
    );
    const touch = attribution.touchFrom(url, 'https://news.example.org/a/b?token=SECRET#frag', new Date('2026-10-03T08:00:00.000Z'));
    assert.deepEqual(touch, {
      ref: 'reportscript',
      source: 'news letter',
      medium: 'e-mail',
      campaign: 'x'.repeat(64),
      landing: '/pricing/plans',
      referrerHost: 'news.example.org',
      at: '2026-10-03T08:00:00.000Z',
    });
    assert.equal(attribution.cleanRef('a'.repeat(100)).length, 64);
    assert.equal(attribution.cleanLanding(`/${'p'.repeat(300)}?q=1`).length, 120);
    assert.equal(attribution.cleanLanding('/tools/og?id=secret#x'), '/tools/og');
    for (const own of ['https://www.easyscreencapture.test/pricing', 'https://easyscreencapture.test/'])
      assert.equal(attribution.touchFrom(new URL(`${ORIGIN}/`), own), null, `${own} is this site, not a referrer`);
    for (const [referer, expected] of [
      ['javascript:alert(1)', null],
      ['ftp://files.example.org/x', null],
      ['not a url', null],
      ['https://user:pass@Search.Example.COM:8443/q?x=1', 'search.example.com'],
    ])
      assert.equal(attribution.referrerHostOf(referer), expected, referer);
    assert.equal(attribution.touchFrom(new URL(`${ORIGIN}/`), null), null, 'a direct visit says nothing');
    assert.equal(attribution.touchFrom(new URL(`${ORIGIN}/?ref=%00%01`), null), null, 'a ref with nothing allowed in it is no ref');
  });

  await section('attribution: the cookie is HttpOnly, SameSite=Lax, 30 days, Secure on https, first touch only', async () => {
    const request = (path, headers = {}, method = 'GET') => new Request(`${ORIGIN}${path}`, { method, headers });
    const at = new Date('2026-10-03T08:00:00.000Z');
    const set = attribution.firstTouchCookie(request('/?utm_source=x'), new URL(`${ORIGIN}/?utm_source=x`), undefined, at);
    assert.match(set, /^sf_src=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);
    const plain = attribution.firstTouchCookie(request('/?ref=a'), new URL('http://localhost:4408/?ref=a'), undefined, at);
    assert.ok(plain && !plain.includes('Secure'), 'not Secure over plain http (local dev)');
    assert.equal(attribution.firstTouchCookie(request('/?ref=b'), new URL(`${ORIGIN}/?ref=b`), 'anything'), null, 'never over an existing cookie');
    assert.equal(attribution.firstTouchCookie(request('/?ref=b', {}, 'POST'), new URL(`${ORIGIN}/?ref=b`), undefined), null, 'GET only');
    for (const path of ['/app?ref=x', '/api/captures?ref=x', '/v1/capture?ref=x', `/r/${'a'.repeat(64)}?ref=x`, '/f/cap_1/capture.png?ref=x', '/verify?token=abc&ref=x', '/reset-password?ref=x', '/join/abc123?ref=x', '/sw.js?ref=x'])
      assert.equal(attribution.firstTouchCookie(request(path), new URL(`${ORIGIN}${path}`), undefined), null, `${path} is never a landing`);
    assert.equal(attribution.firstTouchCookie(request('/pricing'), new URL(`${ORIGIN}/pricing`), undefined), null, 'no signal, no cookie');
    assert.ok(attribution.firstTouchCookie(request('/pricing', { referer: 'https://twitter.example/x' }), new URL(`${ORIGIN}/pricing`), undefined), 'another site is a signal');

    // Round trip, raw or decoded once by Astro; tampering is sanitised again on the way in.
    const value = valueOf(set);
    const raw = attribution.parseAttribution(value);
    assert.deepEqual(raw, attribution.parseAttribution(decodeURIComponent(value)));
    assert.equal(raw.source, 'x');
    const forged = encodeURIComponent('ref=<b>Evil</b>&src=a%26b&host=evil.example/path&land=/x?y=1&at=2026-10-03T08:00:00.000Z');
    assert.deepEqual(attribution.parseAttribution(forged), {
      ref: 'bevilb',
      source: 'ab',
      medium: null,
      campaign: null,
      landing: '/x',
      referrerHost: null,
      at: '2026-10-03T08:00:00.000Z',
    });
    for (const junk of ['', '%E0%A4%A', 'ref=a', 'ref=a&at=yesterday', 'x'.repeat(3000)]) assert.equal(attribution.parseAttribution(junk), null, junk.slice(0, 20));
  });

  await section('middleware: sets the cookie after the page’s headers, keeping cache and security headers', async () => {
    const context = (path, { cookie, referer, session } = {}) => {
      const url = new URL(`${ORIGIN}${path}`);
      const headers = referer ? { referer } : {};
      return {
        url,
        request: new Request(url, { headers }),
        cookies: { get: (name) => (name === 'sf_src' && cookie ? { value: cookie } : name === 'sf_session' && session ? { value: session } : undefined) },
        locals: {},
        redirect: (to, status) => new Response(null, { status, headers: { location: to } }),
      };
    };
    const page = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    let response = await middleware.onRequest(context('/client-sign-off?ref=report'), async () => page());
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.equal(attribution.parseAttribution(valueOf(cookies[0])).ref, 'report');
    assert.equal(attribution.parseAttribution(valueOf(cookies[0])).landing, '/client-sign-off');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300', 'the page’s caching header is untouched');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');

    response = await middleware.onRequest(context('/client-sign-off?ref=other', { cookie: 'ref%3Dreport' }), async () => page());
    assert.equal(response.headers.getSetCookie().length, 0, 'first touch only');
    response = await middleware.onRequest(context('/nope?ref=x'), async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } }));
    assert.equal(response.headers.getSetCookie().length, 0, 'not on an error page');
    // Immutable headers (a proxied fetch, Response.redirect) are copied, not dropped.
    response = await middleware.onRequest(context('/pricing?utm_source=ads'), async () => Response.redirect(`${ORIGIN}/pricing#plans`, 302));
    assert.equal(response.status, 302);
    assert.equal(response.headers.getSetCookie().length, 1);

    const db = world();
    addUser(db, 'member');
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256('tok'), 'member', now(), '2999-01-01T00:00:00.000Z');
    response = await middleware.onRequest(context('/pricing?utm_source=ads', { session: 'tok' }), async () => page());
    assert.equal(response.headers.getSetCookie().length, 0, 'never for someone signed in');
  });

  /* ------------------------------------------------------------------------ */
  /* Signup                                                                    */
  /* ------------------------------------------------------------------------ */

  await section('signup saves the first touch, clears the cookie and answers exactly as before', async () => {
    const db = world();
    const touch = attribution.firstTouchCookie(
      new Request(`${ORIGIN}/client-sign-off?ref=report&utm_source=newsletter&utm_medium=email&utm_campaign=october`, { headers: { referer: 'https://mail.example.org/inbox?id=1' } }),
      new URL(`${ORIGIN}/client-sign-off?ref=report&utm_source=newsletter&utm_medium=email&utm_campaign=october`),
      undefined,
    );
    const r = await signUp('web@studio.test', { cookie: valueOf(touch), ip: '198.51.100.7' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json).sort(), ['redirect', 'user']);
    assert.deepEqual(Object.keys(r.json.user).sort(), ['email', 'id', 'name']);
    assert.ok(r.setCookie.some((c) => c.startsWith('sf_session=')), 'the session cookie is still set');
    assert.ok(r.setCookie.some((c) => /^sf_src=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/.test(c)), 'the attribution cookie is cleared');
    const row = sourceOf(db, r.json.user.id);
    assert.equal(row.ref, 'report');
    assert.equal(row.source, 'newsletter');
    assert.equal(row.medium, 'email');
    assert.equal(row.campaign, 'october');
    assert.equal(row.landing, '/client-sign-off');
    assert.equal(row.referrer_host, 'mail.example.org');
    assert.match(row.touched_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(row.ip_hash, sha256('signup-ip:198.51.100.7').slice(0, 32));
    assert.ok(!JSON.stringify(row).includes('inbox') && !JSON.stringify(row).includes('198.51.100.7'), 'no referrer path, no raw address');

    // The iOS app: JSON, no Origin, no cookie, URLSession's agent. Same response shape.
    const ios = await signUp('phone@studio.test', { origin: null, ip: '198.51.100.8', agent: 'EasyScreenCapture/42 CFNetwork/3826.500.111.2.2 Darwin/24.4.0' });
    assert.equal(ios.status, 201);
    assert.deepEqual(Object.keys(ios.json).sort(), ['redirect', 'user']);
    assert.equal(ios.setCookie.length, 1, 'only the session cookie');
    assert.equal(sourceOf(db, ios.json.user.id).source, 'ios');
    // Any JSON client without Origin or cookie reads as the app; a browser without a cookie is direct.
    assert.equal(sourceOf(db, (await signUp('node@studio.test', { origin: null, agent: 'node' })).json.user.id).source, 'ios');
    const direct = await signUp('direct@studio.test');
    assert.deepEqual(
      Object.values(sourceOf(db, direct.json.user.id)).slice(1, 7),
      [null, null, null, null, null, null],
      'a direct web signup is recorded with nothing noted',
    );
    assert.equal(direct.setCookie.length, 1, 'no cookie to clear');
    assert.equal(errors.filter((e) => e.includes('[signup]')).length, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Referrals                                                                 */
  /* ------------------------------------------------------------------------ */

  const joinLink = async (code, { cookie, user, ip = '192.0.2.10', referer } = {}) => {
    const url = new URL(`${ORIGIN}/join/${code}`);
    const request = new Request(url, { headers: { 'cf-connecting-ip': ip, ...(referer ? { referer } : {}) } });
    const cookies = { get: (name) => (name === 'sf_src' && cookie !== undefined ? { value: decodeURIComponent(cookie) } : undefined) };
    const response = await join_.GET({ params: { code }, request, locals: { user: user ?? null }, cookies, url });
    return { status: response.status, location: response.headers.get('location'), setCookie: response.headers.getSetCookie(), headers: response.headers };
  };

  await section('referral codes are stable; /join notes the referral and redirects to signup', async () => {
    const db = world();
    addUser(db, 'ref1', { email: 'ref1@agency.test' });
    addUser(db, 'ref2');
    const code = await growth.referralCodeFor('ref1');
    assert.match(code, /^[a-z0-9]{8}$/);
    assert.equal(await growth.referralCodeFor('ref1'), code, 'the same code every time');
    assert.notEqual(await growth.referralCodeFor('ref2'), code);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM referral_codes').get().n, 2);
    assert.equal(growth.referralUrl(ORIGIN, code), `${ORIGIN}/join/${code}`);

    let r = await joinLink(code);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/signup');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.setCookie.length, 1);
    assert.match(r.setCookie[0], /HttpOnly; SameSite=Lax; Secure$/);
    const noted = attribution.parseAttribution(valueOf(r.setCookie[0]));
    assert.equal(noted.ref, `referral:${code}`);
    assert.equal(noted.landing, '/join');

    // Over an earlier first touch: the referral names the referrer, the campaign stays.
    const earlier = valueOf(attribution.firstTouchCookie(new Request(`${ORIGIN}/?utm_source=ads&utm_campaign=fall`), new URL(`${ORIGIN}/?utm_source=ads&utm_campaign=fall`), undefined));
    r = await joinLink(code, { cookie: earlier });
    const merged = attribution.parseAttribution(valueOf(r.setCookie[0]));
    assert.deepEqual([merged.ref, merged.source, merged.campaign, merged.landing], [`referral:${code}`, 'ads', 'fall', '/']);
    // The first referral link followed wins.
    r = await joinLink(await growth.referralCodeFor('ref2'), { cookie: valueOf((await joinLink(code)).setCookie[0]) });
    assert.equal(r.setCookie.length, 0);

    for (const bad of ['nothere1', 'ABC', '../../x', 'a'.repeat(40)]) {
      r = await joinLink(bad);
      assert.deepEqual([r.status, r.location, r.setCookie.length], [302, '/signup', 0], bad);
    }
    r = await joinLink(code, { user: { id: 'ref2' } });
    assert.deepEqual([r.location, r.setCookie.length], ['/app/account#invite', 0], 'someone signed in goes to their own invite link');

    kv.clear();
    for (let i = 0; i < 30; i++) assert.equal((await joinLink(code, { ip: '192.0.2.99' })).status, 302);
    r = await joinLink(code, { ip: '192.0.2.99' });
    assert.equal(r.status, 429, '/join is rate-limited per address in KV');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await joinLink(code, { ip: '192.0.2.100' })).status, 302, 'other addresses are unaffected');
  });

  await section('by default nothing is stored in the browser: the links carry the first touch to signup', async () => {
    const db = world();
    delete fx.env.ATTRIBUTION_COOKIE;
    addUser(db, 'carrier', { email: 'carrier@agency.test' });
    const at = new Date('2026-10-03T09:00:00.000Z');

    // What a landing page knows, and the links it carries it on.
    const touch = attribution.carriedTouch(new URL(`${ORIGIN}/client-sign-off?ref=report&utm_campaign=fall`), null, at);
    assert.deepEqual([touch.ref, touch.campaign, touch.landing], ['report', 'fall', '/client-sign-off']);
    const signupLink = attribution.withTouch('/signup?next=%2Fapp', touch, ORIGIN);
    const carried = new URL(signupLink, ORIGIN);
    assert.equal(carried.searchParams.get('next'), '/app', 'the link keeps its own parameters');
    assert.deepEqual(attribution.parseAttribution(carried.searchParams.get('src')), touch);
    for (const href of ['/login', '/app/watches', 'https://other.example/signup', '//other.example/signup', 'mailto:x@y.z', '#plans'])
      assert.equal(attribution.withTouch(href, touch, ORIGIN), null, `${href} is left alone`);
    assert.equal(attribution.withTouch(signupLink, touch, ORIGIN), null, 'never twice');
    // A tool's call to action names the tool when the visitor's first touch had no ref of its own.
    const fromSearch = attribution.carriedTouch(new URL(`${ORIGIN}/tools/seo-tag-checker`), 'https://www.google.com/', at);
    assert.deepEqual([fromSearch.ref, fromSearch.referrerHost], [null, 'www.google.com']);
    const cta = new URL(attribution.withTouch('/signup?ref=tool-seo-tag-checker', fromSearch, ORIGIN), ORIGIN);
    assert.deepEqual(
      [attribution.parseAttribution(cta.searchParams.get('src')).ref, attribution.parseAttribution(cta.searchParams.get('src')).referrerHost],
      ['tool-seo-tag-checker', 'www.google.com'],
    );
    // The signup page reads what it was carried, or its own ref.
    assert.equal(attribution.carriedTouch(new URL(`${ORIGIN}/signup?${new URLSearchParams({ src: attribution.touchParam(touch) })}`), null).ref, 'report');
    assert.equal(attribution.carriedTouch(new URL(`${ORIGIN}/signup?ref=tool-compare-pages`), null).ref, 'tool-compare-pages');

    // The middleware sets no cookie. (It rewrites links with HTMLRewriter, which only workerd has: checked live.)
    const url = new URL(`${ORIGIN}/client-sign-off?ref=report`);
    const response = await middleware.onRequest(
      { url, request: new Request(url), cookies: { get: () => undefined }, locals: {}, redirect: () => null },
      async () => new Response('<a href="/signup">Start</a>', { headers: { 'content-type': 'text/html' } }),
    );
    assert.equal(response.headers.getSetCookie().length, 0, 'no attribution cookie');

    // The signup form posts it; it is saved, and no cookie is set or cleared.
    const request = new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.20', 'user-agent': 'Mozilla/5.0 (Macintosh)' },
      body: JSON.stringify({ email: 'carried@studio.test', password: 'growth-pass-1', src: attribution.touchParam(touch) }),
    });
    const r = await signup({ request, locals: {}, cookies: { get: () => undefined } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.headers.getSetCookie().map((c) => c.split('=')[0]), ['sf_session'], 'only the session cookie');
    const saved = db.prepare('SELECT ref, campaign, landing FROM signup_sources WHERE user_id = ?').get((await r.json()).user.id);
    assert.deepEqual({ ...saved }, { ref: 'report', campaign: 'fall', landing: '/client-sign-off' });

    // A referral link carries the referral in the signup link instead of a cookie.
    const code = await growth.referralCodeFor('carrier');
    const joined = await joinLink(code, { referer: 'https://news.example.org/post' });
    assert.equal(joined.setCookie.length, 0, 'no cookie');
    const next = new URL(joined.location, ORIGIN);
    assert.equal(next.pathname, '/signup');
    const noted = attribution.parseAttribution(next.searchParams.get('src'));
    assert.deepEqual([noted.ref, noted.landing, noted.referrerHost], [`referral:${code}`, '/join', 'news.example.org']);
    const invitedRequest = new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.21', 'user-agent': 'Mozilla/5.0 (Macintosh)' },
      body: JSON.stringify({ email: 'invited@other.test', password: 'growth-pass-1', src: next.searchParams.get('src') }),
    });
    const invited = await signup({ request: invitedRequest, locals: {}, cookies: { get: () => undefined } });
    assert.equal(invited.status, 201);
    const referral = db.prepare('SELECT status FROM referrals WHERE referrer_id = ?').get('carrier');
    assert.equal(referral?.status, 'pending', 'the referral is opened from the carried touch');
  });

  /** A referrer, and a signup through their link. */
  const referredSignup = async (db, referrer, email, ip) => {
    const code = await growth.referralCodeFor(referrer);
    const r = await signUp(email, { cookie: valueOf((await joinLink(code, { ip })).setCookie[0]), ip });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.user;
  };
  const capture = async (user) => {
    const opts = parse({ url: 'https://example.com' });
    const row = await captures.createCaptureRow(user, opts, 'app');
    return captures.runCapture(row, opts);
  };
  const sessionUser = (db, id) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return { id: row.id, email: row.email, name: row.name, plan: row.plan, freeQuota: row.free_quota, periodStart: row.period_start, createdAt: row.created_at };
  };

  await section('a referral pays only once the account is confirmed and has captured; both sides, once', async () => {
    const db = world();
    addUser(db, 'inviter', { email: 'inviter@agency.test' });
    // The referrer signed up from somewhere else: no signup_sources row of theirs to match.
    const friend = await referredSignup(db, 'inviter', 'friend@studio.test', '198.51.100.20');
    assert.deepEqual([referralOf(db, friend.id).status, referralOf(db, friend.id).referrer_id], ['pending', 'inviter']);
    assert.equal(await growth.rewardReferral(friend.id), false, 'not confirmed, no capture');

    const done = await capture(sessionUser(db, friend.id));
    assert.equal(done.status, 'done');
    assert.equal(referralOf(db, friend.id).status, 'pending', 'a capture alone is not enough while mail works');
    assert.equal(bonusOf(db, 'inviter'), 0);

    // Confirming the address is what /verify does; its hook pays the referral.
    const issued = await verification.issueVerificationToken({ id: friend.id, email: friend.email }, ORIGIN);
    assert.equal(await verification.consumeVerificationToken(issued.token), friend.id);
    const mailsBefore = fx.mails.length;
    assert.equal(await growth.rewardReferral(friend.id, ORIGIN), true);
    const paid = referralOf(db, friend.id);
    assert.equal(paid.status, 'rewarded');
    assert.ok(paid.rewarded_at);
    assert.deepEqual([bonusOf(db, 'inviter'), bonusOf(db, friend.id)], [100, 100]);
    const mail = fx.mails.slice(mailsBefore);
    assert.equal(mail.length, 1, 'the referrer is emailed once');
    assert.equal(mail[0].to, 'inviter@agency.test');
    assert.match(mail[0].subject, /100 bonus screenshots/);
    assert.match(mail[0].text, /You now have 100\./);
    assert.ok(!mail[0].text.includes('friend@studio.test'), 'the email does not say who signed up');

    // Again, and again at once: nothing more.
    assert.deepEqual(await Promise.all([1, 2, 3].map(() => growth.rewardReferral(friend.id))), [false, false, false]);
    await capture(sessionUser(db, friend.id));
    assert.deepEqual([bonusOf(db, 'inviter'), bonusOf(db, friend.id), fx.mails.length - mailsBefore], [100, 100, 1]);
    // The friend's capture above came from the allowance; the bonus waits behind it.
    assert.equal(drawnOf(db, friend.id), 0);

    // Racing first payments of one referral: one wins.
    const twin = await referredSignup(db, 'inviter', 'twin@other.test', '198.51.100.21');
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), twin.id);
    await capture(sessionUser(db, twin.id)); // runCapture's own hook pays it
    assert.equal(referralOf(db, twin.id).status, 'rewarded', 'the capture hook paid the confirmed account');
    assert.deepEqual([bonusOf(db, 'inviter'), bonusOf(db, twin.id)], [200, 100]);
    const third = await referredSignup(db, 'inviter', 'third@other.test', '198.51.100.22');
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), third.id);
    db.prepare(
      `INSERT INTO captures (id, user_id, url, host, device, width, height, mode, format, status, source, share_token, created_at)
       VALUES ('cap_third', ?, 'https://example.com', 'example.com', 'desktop', 1440, 900, 'fullpage', 'png', 'done', 'app', 't', ?)`,
    ).run(third.id, now());
    const raced = await Promise.all(Array.from({ length: 6 }, () => growth.rewardReferral(third.id)));
    assert.equal(raced.filter(Boolean).length, 1, 'exactly one call pays');
    assert.deepEqual([bonusOf(db, 'inviter'), bonusOf(db, third.id)], [300, 100]);

    // Where this deployment cannot send the confirmation, activity alone is the signal.
    fx.mailReady = false;
    const quiet = await referredSignup(db, 'inviter', 'quiet@other.test', '198.51.100.23');
    assert.equal(await growth.rewardReferral(quiet.id), false, 'no activity yet');
    await capture(sessionUser(db, quiet.id));
    assert.equal(referralOf(db, quiet.id).status, 'rewarded');
    fx.mailReady = true;

    const summary = await growth.referralSummary('inviter');
    assert.deepEqual([summary.invited, summary.rewarded, summary.pending, summary.bonus], [4, 4, 0, 400]);
  });

  await section('self-referrals and the 20-reward cap are refused', async () => {
    const db = world();
    // The referrer signs up through the site, so their address is on record.
    const owner = await signUp('owner@studio.test', { ip: '203.0.113.50' });
    const ownerId = owner.json.user.id;
    const same = await referredSignup(db, ownerId, 'second@studio.test', '203.0.113.50');
    assert.deepEqual([referralOf(db, same.id).status, referralOf(db, same.id).reason], ['rejected', 'same_person']);
    // Either one alone is not the same person.
    assert.equal(referralOf(db, (await referredSignup(db, ownerId, 'colleague@studio.test', '203.0.113.51')).id).status, 'pending');
    assert.equal(referralOf(db, (await referredSignup(db, ownerId, 'flatmate@home.test', '203.0.113.50')).id).status, 'pending');
    // A rejected referral is never paid.
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), same.id);
    await capture(sessionUser(db, same.id));
    assert.equal(referralOf(db, same.id).status, 'rejected');
    assert.equal(bonusOf(db, ownerId), 0);

    // At the cap, a new referral is refused at signup…
    addUser(db, 'popular', { email: 'popular@agency.test' });
    for (let i = 0; i < 20; i++) {
      addUser(db, `paid${i}`);
      db.prepare(`INSERT INTO referrals (id, referrer_id, referred_id, status, created_at, rewarded_at) VALUES (?, 'popular', ?, 'rewarded', ?, ?)`).run(`r${i}`, `paid${i}`, now(), now());
    }
    const late = await referredSignup(db, 'popular', 'late@other.test', '203.0.113.60');
    assert.deepEqual([referralOf(db, late.id).status, referralOf(db, late.id).reason], ['rejected', 'limit_reached']);

    // …and inside the reward batch, where two pending referrals race for the last reward.
    db.prepare(`DELETE FROM referrals WHERE id = 'r19'`).run();
    const a = await referredSignup(db, 'popular', 'a@one.test', '203.0.113.61');
    const b = await referredSignup(db, 'popular', 'b@two.test', '203.0.113.62');
    for (const user of [a, b]) {
      db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), user.id);
      db.prepare(
        `INSERT INTO captures (id, user_id, url, host, device, width, height, mode, format, status, source, share_token, created_at)
         VALUES (?, ?, 'https://example.com', 'example.com', 'desktop', 1440, 900, 'fullpage', 'png', 'done', 'app', 't', ?)`,
      ).run(`cap_${user.id}`, user.id, now());
    }
    const results = await Promise.all([growth.rewardReferral(a.id), growth.rewardReferral(b.id)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM referrals WHERE referrer_id = 'popular' AND status = 'rewarded'`).get().n, 20);
    const loser = [a, b].find((_, i) => !results[i]);
    assert.deepEqual([referralOf(db, loser.id).status, referralOf(db, loser.id).reason], ['rejected', 'limit_reached']);
    assert.equal(bonusOf(db, 'popular'), 100, 'only the one reward inside the cap was paid');
    assert.equal(bonusOf(db, loser.id), 0);

    // One referral per account, whoever's link: the unique index holds even if asked twice.
    assert.throws(() =>
      db.prepare(`INSERT INTO referrals (id, referrer_id, referred_id, status, created_at) VALUES ('dupe', ?, ?, 'pending', ?)`).run(ownerId, a.id, now()),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Bonus screenshots in the quota                                            */
  /* ------------------------------------------------------------------------ */

  await section('bonus screenshots are spent only after the allowance, and refunds go back where they came from', async () => {
    const db = world();
    const user = addUser(db, 'spender');
    setBonus(db, 'spender', 10);
    setUsed(db, 'spender', 10);
    let usage = await captures.getUsage(user);
    assert.deepEqual([usage.used, usage.quota, usage.bonus, usage.remaining], [10, 20, 10, 20]);

    assert.equal(await captures.reserveQuota('spender', period(), 8, 20, 'app'), true);
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender'), drawnOf(db, 'spender')], [18, 10, 0], 'the allowance first');

    assert.equal(await captures.reserveQuota('spender', period(), 5, 20, 'api'), true);
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender'), drawnOf(db, 'spender')], [20, 7, 3], 'two from the allowance, three from the bonus');
    const counters = db.prepare('SELECT via_app, via_api FROM usage_counters WHERE user_id = ?').get('spender');
    assert.deepEqual([counters.via_app, counters.via_api], [8, 5], 'the source counters count every screenshot');
    usage = await captures.getUsage(user);
    assert.deepEqual([usage.used, usage.quota, usage.bonus, usage.remaining], [20, 20, 7, 7]);

    const snapshot = (id) => JSON.stringify([
      db.prepare('SELECT * FROM usage_counters WHERE user_id = ?').all(id),
      db.prepare('SELECT user_id, screenshots FROM bonus_balances WHERE user_id = ?').all(id),
      // A refused attempt may leave the month's row at 0 drawn; what matters is the draw.
      db.prepare('SELECT user_id, period, used FROM bonus_usage WHERE user_id = ? AND used > 0').all(id),
    ]);
    let before = snapshot('spender');
    assert.equal(await captures.reserveQuota('spender', period(), 8, 20, 'app'), false, 'more than allowance and bonus together');
    assert.equal(snapshot('spender'), before, 'a refused reservation changes nothing');
    // Part of the allowance left, not enough bonus for the rest: still nothing, the allowance included.
    const partial = addUser(db, 'partial');
    setUsed(db, 'partial', 18);
    setBonus(db, 'partial', 1);
    before = snapshot('partial');
    assert.equal(await captures.reserveQuota('partial', period(), 5, 20, 'app'), false);
    assert.equal(snapshot('partial'), before, 'neither the allowance nor the bonus is touched');
    assert.equal((await captures.getUsage(partial)).remaining, 3);
    assert.equal(await captures.reserveQuota('partial', period(), 3, 20, 'app'), true, 'exactly what is left of both');
    assert.deepEqual([usedOf(db, 'partial'), bonusOf(db, 'partial'), drawnOf(db, 'partial')], [20, 0, 1]);

    await captures.refundQuota('spender', period(), 5, 'api');
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender'), drawnOf(db, 'spender')], [18, 10, 0], 'bonus first, then the allowance');
    await captures.refundQuota('spender', period(), 8, 'app');
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender')], [10, 10]);

    // A failed capture paid from the bonus gives it back to the bonus.
    setUsed(db, 'spender', 20);
    fx.render = async () => {
      throw new Error('The page took too long to load.');
    };
    const failed = await capture(user);
    assert.equal(failed.status, 'error');
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender'), drawnOf(db, 'spender')], [20, 10, 0]);
    // A short series is settled the same way.
    fx.render = async () => ({ files: [png(1), png(2)], engine: 'binding', durationMs: 5 });
    const opts = parse({ url: 'https://example.com', mode: 'series' });
    const row = await captures.createCaptureRow(user, opts, 'app');
    assert.equal(row.reserved, 10, 'a series is capped at what is left, bonus included');
    assert.deepEqual([bonusOf(db, 'spender'), drawnOf(db, 'spender')], [0, 10]);
    await captures.runCapture(row, opts);
    assert.deepEqual([usedOf(db, 'spender'), bonusOf(db, 'spender'), drawnOf(db, 'spender')], [20, 8, 2]);

  });

  await section('racing reservations never overspend the bonus', async () => {
    const db = world();
    const user = addUser(db, 'racer');
    setUsed(db, 'racer', 15);
    setBonus(db, 'racer', 3);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => captures.createCaptureRow(user, parse({ url: 'https://example.com' }), 'app')));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 8, 'five from the allowance, three from the bonus');
    for (const failed of attempts.filter((a) => a.status === 'rejected')) assert.equal(failed.reason.type, 'quota_exceeded');
    assert.deepEqual([usedOf(db, 'racer'), bonusOf(db, 'racer'), drawnOf(db, 'racer')], [20, 0, 3]);

    // Straight at the quota functions: twenty at once against ten.
    setUsed(db, 'racer', 20);
    setBonus(db, 'racer', 10);
    db.prepare('DELETE FROM bonus_usage').run();
    const reserved = await Promise.all(Array.from({ length: 20 }, () => captures.reserveQuota('racer', period(), 1, 20, 'watch')));
    assert.equal(reserved.filter(Boolean).length, 10);
    assert.deepEqual([usedOf(db, 'racer'), bonusOf(db, 'racer'), drawnOf(db, 'racer')], [20, 0, 10]);
    await Promise.all(Array.from({ length: 10 }, () => captures.refundQuota('racer', period(), 1, 'watch')));
    assert.deepEqual([usedOf(db, 'racer'), bonusOf(db, 'racer'), drawnOf(db, 'racer')], [20, 10, 0]);
  });

  await section('a monitor out of its allowance checks on its bonus, and skips only when both are spent', async () => {
    const db = world();
    const user = addUser(db, 'watcher', { verified: true });
    const watch = await watches.createWatch(user, {
      options: parse({ url: 'https://example.com/pricing', device: 'desktop', mode: 'fullpage' }),
      label: 'Pricing',
      frequency: 'weekly',
      threshold: 1,
      notifyEmail: false,
      webhookUrl: null,
    });
    setUsed(db, 'watcher', 20);
    let outcome = await watches.runWatch(watch, ORIGIN);
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.detail, /monthly quota used up/);

    setBonus(db, 'watcher', 1);
    outcome = await watches.runWatch(await watches.getWatch(watch.id), ORIGIN);
    assert.equal(outcome.status, 'done', JSON.stringify(outcome));
    assert.deepEqual([usedOf(db, 'watcher'), bonusOf(db, 'watcher'), drawnOf(db, 'watcher')], [20, 0, 1]);
    assert.equal(db.prepare('SELECT via_watch FROM usage_counters WHERE user_id = ?').get('watcher').via_watch, 1);

    outcome = await watches.runWatch(await watches.getWatch(watch.id), ORIGIN);
    assert.equal(outcome.status, 'skipped', 'both spent');
    // Smart checks ask getUsage().remaining the same way (fast-checks.ts), which counts the bonus.
    const source = readFileSync(join(root, 'src/lib/watches.ts'), 'utf8');
    assert.equal((source.match(/\(await getUsage\(user\)\)\.remaining <= 0/g) ?? []).length, 2, 'smart checks read remaining, bonus included');
  });

  /* ------------------------------------------------------------------------ */
  /* Mobile profile                                                            */
  /* ------------------------------------------------------------------------ */

  await section('the iOS profile adds optional referral_url and usage.bonus; remaining includes the bonus', async () => {
    const db = world();
    addUser(db, 'phone');
    setUsed(db, 'phone', 18);
    setBonus(db, 'phone', 100);
    const response = await profile({ locals: { user: { id: 'phone' } }, url: new URL(`${ORIGIN}/api/mobile/profile`) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual([body.usage.used, body.usage.quota, body.usage.remaining, body.usage.bonus], [18, 20, 102, 100]);
    assert.match(body.referral_url, new RegExp(`^${ORIGIN}/join/[a-z0-9]{8}$`));
    assert.deepEqual(Object.keys(body).sort(), ['frequencies', 'plan', 'referral_url', 'retentionDays', 'usage', 'user', 'verified']);
  });

  /* ------------------------------------------------------------------------ */
  /* Owner dashboard and the report link                                       */
  /* ------------------------------------------------------------------------ */

  await section('the growth dashboard is for OWNER_EMAILS only, and counts what happened', async () => {
    const db = world();
    for (const [value, email, expected] of [
      [undefined, 'owner@example.test', false],
      ['', 'owner@example.test', false],
      ['Owner@Example.test, second@example.test', 'owner@example.TEST', true],
      ['owner@example.test,second@example.test', ' second@example.test ', true],
      ['owner@example.test', 'notowner@example.test', false],
      ['owner@example.test', '', false],
      ['owner@example.test,', null, false],
    ]) {
      fx.env.OWNER_EMAILS = value;
      assert.equal(report.isOwner(email), expected, `${value} / ${email}`);
    }
    const page = readFileSync(join(root, 'src/pages/app/growth.astro'), 'utf8');
    const gate = page.indexOf("if (!isOwner(user.email)) return new Response('Not found', { status: 404 });");
    assert.ok(gate > 0, 'non-owners get a 404');
    assert.ok(gate < page.indexOf('growthReport()') && gate < page.indexOf('growthAvailable()'), 'before anything is read');
    assert.match(page, /Apply migration 0017/);

    const tool = valueOf(attribution.firstTouchCookie(new Request(`${ORIGIN}/tools/og?ref=tool-og-preview`), new URL(`${ORIGIN}/tools/og?ref=tool-og-preview`), undefined));
    const fromReport = valueOf(attribution.firstTouchCookie(new Request(`${ORIGIN}/client-sign-off?ref=report`), new URL(`${ORIGIN}/client-sign-off?ref=report`), undefined));
    const a = (await signUp('a@one.test', { cookie: tool, ip: '198.51.100.1' })).json.user;
    await signUp('b@two.test', { cookie: fromReport, ip: '198.51.100.2' });
    await signUp('c@three.test', { origin: null, ip: '198.51.100.3' });
    await signUp('d@four.test', { ip: '198.51.100.4' });
    addUser(db, 'host', { email: 'host@agency.test' });
    const referred = await referredSignup(db, 'host', 'e@five.test', '198.51.100.5');
    db.prepare(`UPDATE users SET plan = 'pro' WHERE id = ?`).run(a.id);
    await capture(sessionUser(db, a.id));
    await capture(sessionUser(db, referred.id));
    // An old signup outside every window, and one between 30 and 90 days.
    db.prepare(`UPDATE signup_sources SET created_at = '2020-01-01T00:00:00.000Z' WHERE user_id = (SELECT id FROM users WHERE email = 'd@four.test')`).run();
    db.prepare(`UPDATE signup_sources SET created_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'c@three.test')`).run(new Date(Date.now() - 45 * 86_400_000).toISOString());

    const r = await report.growthReport();
    assert.deepEqual(r.overview.signups, [3, 3, 4]);
    assert.deepEqual(r.overview.report, [1, 1, 1]);
    assert.deepEqual(r.overview.tools, [1, 1, 1]);
    assert.deepEqual(r.overview.referral, [1, 1, 1]);
    assert.deepEqual(r.overview.ios, [0, 0, 1]);
    assert.deepEqual(r.overview.active, [2, 2, 2]);
    assert.deepEqual(r.overview.paid, [1, 1, 1]);
    assert.deepEqual(r.refs.map((row) => row.label).sort(), ['referral (all links)', 'report', 'tool-og-preview']);
    assert.deepEqual(r.campaigns.map((row) => [row.label, row.counts]), [['ios / — / —', [0, 0, 1]]]);
    assert.deepEqual(r.referrals.invited, [1, 1, 1]);
    assert.deepEqual(r.referrals.pending, [1, 1, 1]);
    const paidRow = r.paidByChannel.find((row) => row.label === 'ref: tool-og-preview');
    assert.deepEqual([paidRow.paid, paidRow.signups], [[1, 1, 1], [1, 1, 1]]);
    assert.ok(r.paidByChannel.find((row) => row.label === 'ios'));
  });

  await section('the report links to the landing page with ref=report, and white-labelled reports show nothing', async () => {
    const source = readFileSync(join(root, 'src/components/ReviewReport.astro'), 'utf8');
    const links = source.match(/href="\/client-sign-off\?ref=report"/g) ?? [];
    assert.equal(links.length, 1);
    const block = source.slice(source.indexOf('branding?.attribution && ('), source.indexOf('</footer>'));
    assert.ok(block.includes('href="/client-sign-off?ref=report"'), 'the link only renders inside the attribution condition');
    assert.ok(!source.slice(0, source.indexOf('branding?.attribution && (')).includes('client-sign-off'));
    // Hiding the attribution is what turns the line, and with it the link, off.
    const rules = await load('src/lib/branding-rules.ts');
    const hidden = { logo_key: '', logo_type: '', logo_width: 0, logo_height: 0, accent: '', footer: '', hide_attribution: 1 };
    assert.equal(rules.resolveBranding(hidden, 'pro').attribution, false);
    assert.equal(rules.resolveBranding(hidden, 'plus').attribution, true);
    assert.equal(rules.resolveBranding(null, 'free').attribution, true);
    assert.ok(!readFileSync(join(root, 'src/lib/report-pdf.ts'), 'utf8').includes('client-sign-off'), 'PDF exports still carry no attribution');
  });

  /* ------------------------------------------------------------------------ */
  /* Account deletion                                                          */
  /* ------------------------------------------------------------------------ */

  await section('deleting an account clears its rows; a referred account’s deletion keeps the referrer’s bonus', async () => {
    const db = world();
    addUser(db, 'keeper', { email: 'keeper@agency.test' });
    const paid = await referredSignup(db, 'keeper', 'paid@one.test', '198.51.100.30');
    const waiting = await referredSignup(db, 'keeper', 'waiting@two.test', '198.51.100.31');
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), paid.id);
    await capture(sessionUser(db, paid.id));
    assert.deepEqual([bonusOf(db, 'keeper'), bonusOf(db, paid.id)], [100, 100]);
    await growth.referralCodeFor(paid.id);
    await captures.reserveQuota(paid.id, period(), 25, 20, 'app');
    assert.ok(drawnOf(db, paid.id) > 0);

    await deletion.deleteAccount(paid.id);
    for (const table of ['signup_sources', 'referral_codes', 'bonus_balances', 'bonus_usage'])
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`).get(paid.id).n, 0, table);
    const kept = db.prepare(`SELECT * FROM referrals WHERE referrer_id = 'keeper' AND status = 'rewarded'`).get();
    assert.equal(kept.referred_id, null, 'the referrer’s row stays, pointing nowhere');
    assert.equal(bonusOf(db, 'keeper'), 100, 'and the bonus already paid stays');

    await deletion.deleteAccount(waiting.id);
    const closed = db.prepare(`SELECT * FROM referrals WHERE referrer_id = 'keeper' AND status = 'rejected'`).get();
    assert.deepEqual([closed.referred_id, closed.reason], [null, 'account_deleted']);
    assert.deepEqual((await growth.referralSummary('keeper')).invited, 2);

    await deletion.deleteAccount('keeper');
    for (const table of ['referrals', 'referral_codes', 'bonus_balances'])
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Without migration 0017                                                    */
  /* ------------------------------------------------------------------------ */

  await section('without 0017 everything works as before: the cookie is set, nothing is saved, nothing is shown', async () => {
    const db = world({ growth: false });
    // A new isolate: no probe cached from the migrated worlds above.
    const fresh = {
      growth: await load('src/lib/growth.ts'),
      captures: await load('src/lib/captures.ts'),
      deletion: await load('src/lib/account-deletion.ts'),
      signup: (await load('src/pages/api/auth/signup.ts')).POST,
      join: await load('src/pages/join/[code].ts'),
      profile: (await load('src/pages/api/mobile/profile.ts')).GET,
      middleware: await load('src/middleware.ts'),
    };
    assert.equal(await fresh.growth.growthReady(), false);

    const url = new URL(`${ORIGIN}/?utm_source=ads`);
    const response = await fresh.middleware.onRequest(
      { url, request: new Request(url), cookies: { get: () => undefined }, locals: {}, redirect: () => null },
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    const cookie = valueOf(response.headers.getSetCookie()[0]);
    assert.ok(cookie, 'the cookie is still set');

    const request = new Request(`${ORIGIN}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ email: 'old@world.test', password: 'growth-pass-1' }),
    });
    const r = await fresh.signup({ request, locals: {}, cookies: { get: (name) => (name === 'sf_src' ? { value: decodeURIComponent(cookie) } : undefined) } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.headers.getSetCookie().map((c) => c.split('=')[0]), ['sf_session'], 'nothing saved, so the cookie is kept');
    const id = (await r.json()).user.id;

    assert.equal(await fresh.growth.referralCodeFor(id), null);
    assert.equal(await fresh.growth.referralSummary(id), null);
    assert.equal(await fresh.growth.rewardReferral(id), false);
    assert.deepEqual(await fresh.growth.growthCleanup(id), []);
    const joined = await fresh.join.GET({ params: { code: 'abcdefgh' }, request: new Request(`${ORIGIN}/join/abcdefgh`), locals: {}, cookies: { get: () => undefined }, url: new URL(`${ORIGIN}/join/abcdefgh`) });
    assert.deepEqual([joined.status, joined.headers.get('location'), joined.headers.getSetCookie().length], [302, '/signup', 0]);

    const user = sessionUser(db, id);
    setUsed(db, id, 19);
    let usage = await fresh.captures.getUsage(user);
    assert.deepEqual([usage.used, usage.quota, usage.bonus, usage.remaining], [19, 20, 0, 1]);
    assert.equal(await fresh.captures.reserveQuota(id, period(), 2, 20, 'app'), false);
    assert.equal(await fresh.captures.reserveQuota(id, period(), 1, 20, 'app'), true);
    await fresh.captures.refundQuota(id, period(), 1, 'app');
    assert.equal(usedOf(db, id), 19);

    const body = await (await fresh.profile({ locals: { user: { id } }, url: new URL(`${ORIGIN}/api/mobile/profile`) })).json();
    assert.equal(body.referral_url, undefined);
    assert.equal(body.usage.bonus, 0);
    assert.equal(body.usage.remaining, 1);

    await fresh.deletion.deleteAccount(id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* The migration and its console files                                       */
  /* ------------------------------------------------------------------------ */

  await section('the console upgrade carries no comments and records the migration', async () => {
    const upgrade = readFileSync(join(root, 'db/0017-upgrade.sql'), 'utf8');
    assert.ok(!upgrade.includes('--') && !upgrade.includes('/*'));
    assert.match(upgrade, /INSERT OR IGNORE INTO d1_migrations \(name\) VALUES \('0017_growth\.sql'\);/);
    assert.match(readFileSync(join(root, 'db/apply-manually.sql'), 'utf8'), /VALUES \('0017_growth\.sql'\)/);
    const manifest = readFileSync(join(root, 'src/lib/schema-manifest.ts'), 'utf8');
    assert.match(manifest, /name: '0017_growth\.sql',\s*optional: true/);
  });

  assert.deepEqual(
    // The one expected: a reward email while this fixture's mailer refuses to send.
    errors.filter((e) => !/^\[referrals\] reward email to \S+ was not sent$/.test(e)),
    [],
    'nothing logged an unexpected error',
  );
  console.log = originalLog;
  console.error = originalError;
  console.log(
    `\nGrowth checks passed (${passed.length}): first-touch attribution (sanitising, caps, host-only referrers, cookie flags, ` +
      'middleware headers), signup persistence and iOS signups, stable referral codes, /join and its rate limit, rewards ' +
      'after confirmation and activity paid once to both sides, self-referral and cap rejections, bonus quota order, ' +
      'refunds and races, the monitor quota skip, the iOS profile, the owner dashboard, the report link, account ' +
      'deletion and the no-migration fallback.',
  );
} catch (error) {
  console.log = originalLog;
  console.error = originalError;
  if (errors.length) console.error(errors.join('\n'));
  throw error;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
