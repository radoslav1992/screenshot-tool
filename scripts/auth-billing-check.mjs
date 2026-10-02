/**
 * Accounts, security and billing: safe `next` handling, login/signup
 * throttling, the password reset token lifecycle, password changes and Stripe
 * webhook ordering. Real SQLite (every migration), an in-memory KV, a mocked
 * mailer and a fake Stripe API. No network calls.
 *
 *   node scripts/auth-billing-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ fixtures */

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort())
  db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

const statement = (sql, args = []) => ({
  bind: (...a) => statement(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});

let clock = 0; // Seconds added to the real clock, for KV expiry.
const kv = new Map();
const RATE = {
  get: async (key) => {
    const entry = kv.get(key);
    if (!entry) return null;
    if (entry.expires && entry.expires <= Date.now() / 1000 + clock) {
      kv.delete(key);
      return null;
    }
    return entry.value;
  },
  put: async (key, value, options = {}) => {
    kv.set(key, { value, expires: options.expirationTtl ? Date.now() / 1000 + clock + options.expirationTtl : 0 });
  },
  delete: async (key) => void kv.delete(key),
};

const mails = [];
const fixture = {
  mailReady: true,
  mails,
  env: {
    DB: {
      prepare: (sql) => statement(sql),
      batch: async (statements) => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const q of statements) results.push(await q.run());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
    RATE,
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m',
    STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
    STRIPE_PRICE_PRO_YEARLY: 'price_pro_y',
    STRIPE_PRICE_BUSINESS_MONTHLY: 'price_business_m',
    REQUIRE_EMAIL_VERIFICATION: '0',
  },
};
globalThis.__authBilling = fixture;

/* -------------------------------------------------------------- fake Stripe */

const stripe = { subscriptions: new Map(), sessions: new Map(), calls: [], fail: null, hang: null };
const subscription = (id, fields = {}) => ({
  id,
  status: 'active',
  customer: 'cus_paid',
  metadata: { user_id: 'paid', plan: 'pro' },
  items: { data: [{ id: `si_${id}`, price: { id: 'price_pro_m', recurring: { interval: 'month' } }, current_period_end: 1_900_000_000 }] },
  ...fields,
});
const stripeError = (status, message) => Response.json({ error: { message, code: 'fixture' } }, { status });

const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.stripe.com') throw new Error(`Unexpected network request: ${url}`);
  assert.ok(init.signal instanceof AbortSignal, 'every Stripe call carries a timeout signal');
  const method = init.method ?? 'GET';
  const path = url.pathname.replace(/^\/v1/, '');
  const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
  stripe.calls.push({ method, path, query: url.searchParams, form });
  if (stripe.hang?.(method, path)) throw new DOMException('The operation timed out.', 'TimeoutError');
  if (stripe.fail?.(method, path)) return stripeError(500, 'Fixture outage');

  let match;
  if ((match = path.match(/^\/subscriptions\/([^/]+)$/))) {
    const found = stripe.subscriptions.get(decodeURIComponent(match[1]));
    if (!found) return stripeError(404, 'No such subscription');
    if (method === 'DELETE') found.status = 'canceled';
    if (method === 'POST') for (const [key, value] of form) if (key.startsWith('metadata[')) found.metadata[key.slice(9, -1)] = value;
    return Response.json(structuredClone(found));
  }
  if (method === 'GET' && path === '/subscriptions') {
    const data = [...stripe.subscriptions.values()].filter((s) => s.customer === url.searchParams.get('customer'));
    return Response.json({ data: structuredClone(data) });
  }
  if (method === 'GET' && path === '/checkout/sessions') {
    const data = [...stripe.sessions.values()].filter(
      (s) => s.customer === url.searchParams.get('customer') && s.status === url.searchParams.get('status'),
    );
    return Response.json({ data });
  }
  if (method === 'POST' && (match = path.match(/^\/checkout\/sessions\/([^/]+)\/expire$/))) {
    const found = stripe.sessions.get(decodeURIComponent(match[1]));
    if (!found || found.status !== 'open') return stripeError(400, 'Only open sessions can be expired');
    found.status = 'expired';
    return Response.json(found);
  }
  if (method === 'POST' && path === '/checkout/sessions') {
    const id = `cs_${stripe.sessions.size + 1}`;
    const session = { id, customer: form.get('customer'), status: 'open', url: `https://checkout.stripe.test/${id}` };
    stripe.sessions.set(id, session);
    return Response.json(session);
  }
  if (method === 'POST' && path === '/customers') return Response.json({ id: `cus_${form.get('metadata[user_id]')}` });
  return stripeError(404, `No fixture for ${method} ${path}`);
};

/* ------------------------------------------------------------------ bundling */

const directory = mkdtempSync(join(tmpdir(), 'auth-billing-check-'));
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: 'export const env=globalThis.__authBilling.env;',
      loader: 'js',
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export const canSendEmail=()=>globalThis.__authBilling.mailReady;' +
        'export async function sendMail(mail){globalThis.__authBilling.mails.push(mail);return true;}',
      loader: 'js',
    }));
  },
};
const entries = {
  'safe-next': 'src/lib/safe-next.ts',
  auth: 'src/lib/auth.ts',
  reset: 'src/lib/password-reset.ts',
  billing: 'src/lib/billing.ts',
  login: 'src/pages/api/auth/login.ts',
  signup: 'src/pages/api/auth/signup.ts',
  forgot: 'src/pages/api/auth/forgot-password.ts',
  resetRoute: 'src/pages/api/auth/reset-password.ts',
  change: 'src/pages/api/auth/change-password.ts',
  others: 'src/pages/api/auth/sign-out-others.ts',
};

const errors = [];
const originalError = console.error;
const originalLog = console.log;
console.error = (...args) => errors.push(args.map(String).join(' '));
console.log = () => {};
const restoreConsole = () => {
  console.error = originalError;
  console.log = originalLog;
};

try {
  for (const [name, entry] of Object.entries(entries))
    await build({
      entryPoints: [new URL(`../${entry}`, import.meta.url).pathname],
      outfile: join(directory, `${name}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [plugin],
      logLevel: 'silent',
    });
  const load = async (name) => import(pathToFileURL(join(directory, `${name}.mjs`)));
  const { safeNext } = await load('safe-next');
  const auth = await load('auth');
  const reset = await load('reset');
  const billing = await load('billing');
  const routes = Object.fromEntries(
    await Promise.all(['login', 'signup', 'forgot', 'resetRoute', 'change', 'others'].map(async (n) => [n, (await load(n)).POST])),
  );

  const origin = 'https://fixture.test';

  /* ------------------------------------------------------------ safe next */

  for (const [value, expected] of [
    ['/app/invite?token=abc', '/app/invite?token=abc'],
    ['/app/watches#top', '/app/watches#top'],
    ['/\\evil.com', '/app'],
    ['/\\/evil.com', '/app'],
    ['/\t/evil.com', '/app'],
    ['/\n/evil.com', '/app'],
    ['//evil.com', '/app'],
    ['/.//evil.com', '/app'],
    ['https://evil.com/app', '/app'],
    ['javascript:alert(1)', '/app'],
    ['app', '/app'],
    ['', '/app'],
    [undefined, '/app'],
    ['/' + 'a'.repeat(3000), '/app'],
  ])
    assert.equal(safeNext(value, origin), expected, `safeNext(${JSON.stringify(value)})`);
  // Whatever comes out must resolve to this origin, however a browser reads it.
  for (const tricky of ['/%2F%2Fevil.com', '/%5Cevil.com', '/..//evil.com', '/a/../../evil.com', '/ /evil.com', '/@evil.com'])
    assert.equal(new URL(safeNext(tricky, origin), origin).origin, origin, tricky);

  /* -------------------------------------------------------------- helpers */

  const call = async (route, body, { ip = '203.0.113.1', json = true, cookie, user } = {}) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
    if (json) headers.accept = 'application/json';
    const request = new Request(`${origin}/api/auth/x`, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await route({
      request,
      locals: { user: user ?? null },
      cookies: { get: (name) => (name === 'sf_session' && cookie ? { value: cookie } : undefined) },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    const session = (response.headers.get('set-cookie') ?? '').match(/sf_session=([^;]*)/)?.[1] ?? '';
    return { status: response.status, json: payload, headers: response.headers, session };
  };
  const isProblem = (r, type) => r.json?.error?.type === (type ?? r.json?.error?.type) && typeof r.json?.error?.message === 'string';
  const sessionsOf = (userId) => db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(userId).n;

  /* ------------------------------------------------ signup and login (iOS) */

  const email = 'mia@example.test';
  let r = await call(routes.signup, { email, password: 'first-pass-1', name: 'Mia' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json.user).sort(), ['email', 'id', 'name']);
  assert.ok(r.session, 'signup sets sf_session');
  const userId = r.json.user.id;
  assert.equal(mails.length, 1, 'a confirmation email goes out at signup whenever mail works, gate or not');
  assert.match(mails[0].text, /\/verify\?token=[a-f0-9]{64}/);
  assert.match(mails[0].text, /team invitations/, 'the email does not claim capturing waits on it');

  r = await call(routes.signup, { email, password: 'another-pass-1' });
  assert.equal(r.status, 409);
  assert.ok(isProblem(r, 'email_taken'), '"already registered" stays a deliberate answer');

  r = await call(routes.login, { email, password: 'wrong-password' });
  assert.equal(r.status, 401);
  assert.ok(isProblem(r, 'invalid_credentials'));

  r = await call(routes.login, { email: 'MIA@example.test', password: 'first-pass-1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, userId);
  assert.ok(r.session && !r.headers.get('location'), 'JSON login answers with a cookie, never a redirect');

  r = await call(routes.login, { email, password: 'first-pass-1', next: '/\\evil.com' }, { json: false });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/app', 'form login never redirects off-site');
  r = await call(routes.login, { email, password: 'first-pass-1', next: '/app/invite?token=1' }, { json: false });
  assert.equal(r.headers.get('location'), '/app/invite?token=1');

  // Unknown emails cost a PBKDF2 run too.
  const deriveBits = SubtleCrypto.prototype.deriveBits;
  let derivations = 0;
  SubtleCrypto.prototype.deriveBits = function (...args) {
    derivations++;
    return deriveBits.apply(this, args);
  };
  r = await call(routes.login, { email: 'nobody@example.test', password: 'whatever-1' }, { ip: '203.0.113.9' });
  SubtleCrypto.prototype.deriveBits = deriveBits;
  assert.equal(r.status, 401);
  assert.ok(isProblem(r, 'invalid_credentials'));
  assert.equal(derivations, 1, 'an unknown email still runs one PBKDF2 derivation');

  /* --------------------------------------------------------- throttling */

  // Per email: many addresses' worth of IPs cannot keep guessing one account.
  const target = 'target@example.test';
  for (let i = 0; i < 10; i++) {
    r = await call(routes.login, { email: target, password: 'guess-guess' }, { ip: `198.51.100.${i}` });
    assert.equal(r.status, 401, `attempt ${i + 1} is allowed`);
  }
  r = await call(routes.login, { email: target, password: 'guess-guess' }, { ip: '198.51.100.200' });
  assert.equal(r.status, 429);
  assert.ok(isProblem(r, 'rate_limited'));
  assert.ok(Number(r.headers.get('retry-after')) > 0, '429 carries Retry-After');
  r = await call(routes.login, { email: target, password: 'guess-guess' }, { ip: '198.51.100.201', json: false });
  assert.equal(r.status, 303, 'a throttled form post is redirected, not shown JSON');
  assert.match(r.headers.get('location'), /^\/login\?error=Too\+many/);

  // Per IP: one machine cannot walk a list of accounts.
  for (let i = 0; i < 30; i++) {
    r = await call(routes.login, { email: `walk${i}@example.test`, password: 'guess-guess' }, { ip: '192.0.2.50' });
    assert.equal(r.status, 401);
  }
  r = await call(routes.login, { email: 'walk-last@example.test', password: 'guess-guess' }, { ip: '192.0.2.50' });
  assert.equal(r.status, 429);

  // Signup: the "already registered" answer is throttled per address. Two
  // attempts on this address were made above.
  for (let i = 0; i < 3; i++) {
    r = await call(routes.signup, { email, password: 'another-pass-1' }, { ip: `192.0.2.${100 + i}` });
    assert.equal(r.status, 409);
  }
  r = await call(routes.signup, { email, password: 'another-pass-1' }, { ip: '192.0.2.120' });
  assert.equal(r.status, 429);
  assert.ok(isProblem(r, 'rate_limited'));
  assert.ok(r.headers.get('retry-after'));

  /* --------------------------------------------------- password reset */

  mails.length = 0;
  for (let i = 0; i < 2; i++) await call(routes.login, { email, password: 'first-pass-1' }, { ip: '203.0.113.20' });
  assert.ok(sessionsOf(userId) >= 3);

  const unknown = await call(routes.forgot, { email: 'stranger@example.test' }, { ip: '203.0.113.30' });
  const known = await call(routes.forgot, { email }, { ip: '203.0.113.31' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, known.json, 'same answer whether or not the account exists');
  assert.equal(mails.length, 1, 'only the real account is emailed');
  const token = mails[0].text.match(/reset-password\?token=([a-f0-9]{64})/)[1];
  assert.equal(mails[0].to, email);
  const keys = [...kv.keys()].filter((k) => k.startsWith('pwreset:'));
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(token), 'only a hash of the token is stored');
  const ttl = kv.get(keys[0]).expires - (Date.now() / 1000 + clock);
  assert.ok(ttl > 3500 && ttl <= 3600, 'reset entries expire after an hour');

  assert.equal((await reset.findResetUser(token)).id, userId);
  assert.equal(await reset.findResetUser('0'.repeat(64)), null);
  assert.equal(await reset.findResetUser('not-a-token'), null);

  r = await call(routes.resetRoute, { token, password: 'short' }, { ip: '203.0.113.40' });
  assert.equal(r.status, 400);
  assert.ok(await reset.findResetUser(token), 'a rejected password leaves the link usable');

  db.prepare('UPDATE users SET email_verified_at=NULL WHERE id=?').run(userId);
  // The same link submitted twice at once works exactly once.
  const [first, second] = await Promise.all([
    call(routes.resetRoute, { token, password: 'second-pass-2' }, { ip: '203.0.113.41' }),
    call(routes.resetRoute, { token, password: 'third-pass-3' }, { ip: '203.0.113.42' }),
  ]);
  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 400);
  assert.ok(isProblem(loser, 'invalid_token'));
  assert.deepEqual(Object.keys(winner.json.user).sort(), ['email', 'id', 'name']);
  assert.ok(winner.session, 'a reset signs the person in afresh');
  assert.equal(sessionsOf(userId), 1, 'every earlier session ended');
  assert.ok(db.prepare('SELECT email_verified_at v FROM users WHERE id=?').get(userId).v, 'a reset confirms the address');
  const newPassword = first.status === 200 ? 'second-pass-2' : 'third-pass-3';

  r = await call(routes.login, { email, password: 'first-pass-1' }, { ip: '203.0.113.43' });
  assert.equal(r.status, 401, 'the old password is gone');
  r = await call(routes.login, { email, password: newPassword }, { ip: '203.0.113.43' });
  assert.equal(r.status, 200);

  r = await call(routes.resetRoute, { token, password: 'fourth-pass-4' }, { ip: '203.0.113.44' });
  assert.equal(r.status, 400, 'a used link is dead');
  // Even if the KV delete has not reached this location yet.
  const stale = await reset.issueResetToken({ id: userId, password_hash: 'pbkdf2$old' });
  assert.equal(await reset.findResetUser(stale), null, 'links issued against an older password do not work');

  // Changing the password any other way retires outstanding links.
  const pending = await reset.issueResetToken(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  assert.ok(await reset.findResetUser(pending));
  r = await call(routes.change, { current_password: newPassword, password: 'changed-pass-5' }, {
    user: { id: userId, email },
    cookie: winner.session,
  });
  assert.equal(r.status, 200);
  assert.equal(await reset.findResetUser(pending), null);

  // Expiry.
  const expiring = await reset.issueResetToken(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  clock += 3601;
  assert.equal(await reset.findResetUser(expiring), null, 'links expire');
  clock -= 3601;

  // Request throttle, per address.
  for (let i = 0; i < 2; i++) assert.equal((await call(routes.forgot, { email }, { ip: `203.0.113.${50 + i}` })).status, 200);
  r = await call(routes.forgot, { email }, { ip: '203.0.113.60' });
  assert.equal(r.status, 429);
  assert.ok(isProblem(r, 'rate_limited'));

  // No mailer: the page and the API point people at support instead.
  fixture.mailReady = false;
  r = await call(routes.forgot, { email: 'other@example.test' }, { ip: '203.0.113.61' });
  assert.equal(r.status, 503);
  assert.ok(isProblem(r, 'email_unavailable'));
  assert.match(r.json.error.message, /hello@easyscreencapture\.com/);
  fixture.mailReady = true;

  /* ------------------------------------- change password, other sessions */

  // This account has used its sign-in allowance above; let the window pass.
  for (const key of [...kv.keys()]) if (key.startsWith('rl:login-email:')) kv.delete(key);

  const sessionA = (await call(routes.login, { email, password: 'changed-pass-5' }, { ip: '203.0.113.70' })).session;
  await call(routes.login, { email, password: 'changed-pass-5' }, { ip: '203.0.113.71' });
  await call(routes.login, { email, password: 'changed-pass-5' }, { ip: '203.0.113.72' });
  const me = { user: { id: userId, email }, cookie: sessionA };
  r = await call(routes.change, { current_password: 'wrong-pass', password: 'changed-pass-6' }, me);
  assert.equal(r.status, 403);
  assert.ok(isProblem(r, 'invalid_credentials'));
  const before = sessionsOf(userId);
  r = await call(routes.change, { current_password: 'changed-pass-5', password: 'changed-pass-6' }, me);
  assert.equal(r.status, 200);
  assert.equal(r.json.signed_out, before - 1);
  assert.equal(sessionsOf(userId), 1, 'only the session that changed it survives');
  assert.ok(await auth.resolveSession(sessionA), 'and it is this one');

  await call(routes.login, { email, password: 'changed-pass-6' }, { ip: '203.0.113.73' });
  r = await call(routes.others, {}, me);
  assert.equal(r.status, 200);
  assert.equal(r.json.signed_out, 1);
  assert.ok(await auth.resolveSession(sessionA));
  assert.equal(sessionsOf(userId), 1);

  /* ------------------------------------------------ Stripe webhooks */

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users(id,email,email_lower,name,password_hash,plan,period_start,created_at,updated_at,stripe_customer_id)
     VALUES('paid','paid@example.test','paid@example.test','Paid',NULL,'free',?,?,?,'cus_paid')`,
  ).run(now, now, now);
  const account = () => ({ ...db.prepare("SELECT plan,plan_status,stripe_subscription_id sub,plan_interval FROM users WHERE id='paid'").get() });
  const event = (id, type, object) => ({ id, type, data: { object } });
  const recorded = (id) => db.prepare('SELECT user_id FROM billing_events WHERE id=?').get(id);

  // Created → applied from Stripe's current state.
  stripe.subscriptions.set('sub_A', subscription('sub_A'));
  let outcome = await billing.handleWebhookEvent(event('evt_1', 'customer.subscription.created', subscription('sub_A')));
  assert.equal(outcome.handled, true);
  assert.deepEqual(account(), { plan: 'pro', plan_status: 'active', sub: 'sub_A', plan_interval: 'monthly' });
  assert.equal(recorded('evt_1').user_id, 'paid');
  assert.equal((await billing.handleWebhookEvent(event('evt_1', 'customer.subscription.created', {}))).reason, 'duplicate');

  // Out of order: the cancellation is applied, then a stale "active" update
  // arrives. It is re-read from Stripe, so the plan stays gone.
  stripe.subscriptions.get('sub_A').status = 'canceled';
  await billing.handleWebhookEvent(event('evt_3', 'customer.subscription.deleted', subscription('sub_A', { status: 'canceled' })));
  assert.equal(account().plan, 'free');
  await billing.handleWebhookEvent(event('evt_2', 'customer.subscription.updated', subscription('sub_A', { status: 'active' })));
  assert.equal(account().plan, 'free', 'a late update cannot resurrect a cancelled plan');

  // A worker that fails mid-handler leaves the event unrecorded, so the retry runs.
  stripe.subscriptions.set('sub_B', subscription('sub_B'));
  stripe.fail = (method, path) => method === 'GET' && path === '/subscriptions/sub_B';
  await assert.rejects(() => billing.handleWebhookEvent(event('evt_4', 'checkout.session.completed', { subscription: 'sub_B' })));
  assert.equal(recorded('evt_4'), undefined, 'a failed event is not recorded');
  stripe.fail = null;
  outcome = await billing.handleWebhookEvent(event('evt_4', 'checkout.session.completed', { subscription: 'sub_B' }));
  assert.equal(outcome.handled, true, 'the retry is processed, not treated as a duplicate');
  assert.equal(account().sub, 'sub_B');

  // A Stripe call that never answers is a clean 502 — and still unrecorded.
  stripe.hang = (method, path) => path === '/subscriptions/sub_B';
  await assert.rejects(
    () => billing.handleWebhookEvent(event('evt_5', 'customer.subscription.updated', subscription('sub_B'))),
    (error) => error.status === 502 && error.type === 'billing_error',
  );
  stripe.hang = null;
  assert.equal(recorded('evt_5'), undefined);

  // Events for a subscription that is not the recorded one, while it is live.
  stripe.subscriptions.set('sub_OLD', subscription('sub_OLD', { status: 'canceled' }));
  outcome = await billing.handleWebhookEvent(event('evt_6', 'customer.subscription.deleted', subscription('sub_OLD')));
  assert.equal(outcome.reason, 'not_current_subscription');
  assert.deepEqual([account().plan, account().sub], ['pro', 'sub_B'], 'an old cancellation does not take the plan away');

  // A second live subscription from a second checkout: kept off, loudly.
  stripe.subscriptions.set('sub_C', subscription('sub_C', { metadata: { user_id: 'paid', plan: 'plus' } }));
  stripe.subscriptions.get('sub_C').items.data[0].price.id = 'price_plus_m';
  errors.length = 0;
  outcome = await billing.handleWebhookEvent(event('evt_7', 'checkout.session.completed', { subscription: 'sub_C' }));
  assert.equal(outcome.reason, 'duplicate_subscription');
  assert.equal(account().sub, 'sub_B', 'the recorded subscription is kept');
  assert.ok(errors.some((line) => /two live subscriptions/.test(line) && line.includes('sub_C')), 'and a clear warning is logged');
  assert.ok(!stripe.calls.some((c) => c.method === 'DELETE'), 'nothing is cancelled automatically');

  // ...unless the recorded one has in fact ended and our record is behind.
  stripe.subscriptions.get('sub_B').status = 'canceled';
  outcome = await billing.handleWebhookEvent(event('evt_8', 'customer.subscription.updated', subscription('sub_C')));
  assert.equal(outcome.handled, true);
  assert.deepEqual([account().plan, account().sub], ['plus', 'sub_C']);

  // Price rotation: an unknown price keeps the plan recorded for this subscription,
  // even when the checkout metadata still names an older plan.
  const rotated = stripe.subscriptions.get('sub_C');
  rotated.items.data[0].price.id = 'price_pro_m';
  await billing.handleWebhookEvent(event('evt_9', 'customer.subscription.updated', subscription('sub_C')));
  assert.equal(account().plan, 'pro', 'a portal upgrade to Pro is applied');
  assert.equal(rotated.metadata.plan, 'pro', 'and the subscription metadata is brought in step');
  rotated.metadata.plan = 'plus'; // As if the metadata write had been lost.
  rotated.items.data[0].price.id = 'price_pro_retired';
  await billing.handleWebhookEvent(event('evt_10', 'customer.subscription.updated', subscription('sub_C')));
  assert.equal(account().plan, 'pro', 'a retired price does not downgrade to stale metadata');
  assert.deepEqual(
    billing.subscriptionPlan(
      { id: 'sub_new', items: { data: [{ price: { id: 'price_unknown', recurring: { interval: 'year' } } }] }, metadata: { plan: 'plus' } },
      { plan: 'pro', stripe_subscription_id: 'sub_C' },
    ),
    { plan: 'plus', interval: 'yearly' },
    'another subscription falls back to its own metadata',
  );
  assert.equal(billing.subscriptionDecision({ id: 'x', status: 'active' }, null), 'apply');
  assert.equal(billing.subscriptionDecision({ id: 'x', status: 'canceled' }, { stripe_subscription_id: 'y', plan_status: 'active' }), 'ignore');
  assert.equal(billing.subscriptionDecision({ id: 'x', status: 'active' }, { stripe_subscription_id: 'y', plan_status: 'trialing' }), 'needsCheck');
  assert.equal(billing.subscriptionDecision({ id: 'x', status: 'active' }, { stripe_subscription_id: 'y', plan_status: 'canceled' }), 'apply');

  // Checkout expires the customer's other open sessions first.
  db.prepare("INSERT INTO users(id,email,email_lower,name,plan,period_start,created_at,updated_at,stripe_customer_id) VALUES('buyer','b@example.test','b@example.test','B','free',?,?,?,'cus_buyer')").run(now, now, now);
  stripe.sessions.set('cs_old1', { id: 'cs_old1', customer: 'cus_buyer', status: 'open' });
  stripe.sessions.set('cs_old2', { id: 'cs_old2', customer: 'cus_buyer', status: 'open' });
  stripe.sessions.set('cs_other', { id: 'cs_other', customer: 'cus_someone', status: 'open' });
  const url = await billing.createCheckoutSession({
    user: { id: 'buyer', email: 'b@example.test', name: 'B', plan: 'free' },
    plan: 'pro',
    interval: 'monthly',
    origin,
  });
  assert.match(url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(stripe.sessions.get('cs_old1').status, 'expired');
  assert.equal(stripe.sessions.get('cs_old2').status, 'expired');
  assert.equal(stripe.sessions.get('cs_other').status, 'open', "another customer's checkout is untouched");
  const created = stripe.calls.findLastIndex((c) => c.method === 'POST' && c.path === '/checkout/sessions');
  const expiredAt = stripe.calls.findLastIndex((c) => c.path.endsWith('/expire'));
  assert.ok(expiredAt < created, 'old sessions are expired before the new one is created');

  // Account deletion cancels every subscription Stripe could still bill.
  for (const [id, status] of [['sub_d1', 'active'], ['sub_d2', 'unpaid'], ['sub_d3', 'incomplete'], ['sub_d4', 'past_due'], ['sub_d5', 'canceled'], ['sub_d6', 'incomplete_expired'], ['sub_d7', 'paused']])
    stripe.subscriptions.set(id, subscription(id, { status, customer: 'cus_buyer', metadata: { user_id: 'buyer' } }));
  stripe.sessions.set('cs_late', { id: 'cs_late', customer: 'cus_buyer', status: 'open' });
  const { cancelled } = await billing.cancelBillingForDeletion('buyer');
  assert.deepEqual(cancelled.sort(), ['sub_d1', 'sub_d2', 'sub_d3', 'sub_d4', 'sub_d7']);
  assert.equal(stripe.sessions.get('cs_late').status, 'expired', 'an open checkout cannot be paid after deletion');

  // The cancellation's webhook arrives after the account is gone: it is not
  // filed against the deleted id.
  db.prepare("DELETE FROM users WHERE id='buyer'").run();
  outcome = await billing.handleWebhookEvent(event('evt_11', 'customer.subscription.deleted', subscription('sub_d1')));
  assert.equal(outcome.handled, false);
  assert.equal(outcome.reason, 'no_account');
  assert.equal(recorded('evt_11').user_id, null);

  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  restoreConsole();
  console.log(
    'Auth & billing checks passed: safe next, login/signup throttles and even-cost lookups, reset tokens (hashed, 1h, single-use, ' +
      'stamp-bound, concurrent), password change and other-session sign-out, webhook ordering/idempotency/retries/timeouts, ' +
      'duplicate subscriptions, price rotation, checkout expiry and deletion cancellation.',
  );
} finally {
  restoreConsole();
  globalThis.fetch = previousFetch;
  delete globalThis.__authBilling;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
