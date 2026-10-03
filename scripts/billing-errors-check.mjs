/**
 * What a customer sees when checkout or the billing portal fails: a fixed
 * message looked up from a code, never text carried in the URL and never
 * Stripe's developer wording — while the operator gets Stripe's words by email,
 * at most once per error code per hour. Real SQLite (every migration), an
 * in-memory KV, a mocked mailer and a fake Stripe API. No network calls.
 *
 *   node scripts/billing-errors-check.mjs
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
for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort())
  db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

const statement = (sql, args = []) => ({
  bind: (...a) => statement(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});

const kv = new Map();
const RATE = {
  broken: false,
  get: async (key) => {
    if (RATE.broken) throw new Error('KV unavailable');
    return kv.get(key)?.value ?? null;
  },
  put: async (key, value, options = {}) => {
    if (RATE.broken) throw new Error('KV unavailable');
    kv.set(key, { value, ttl: options.expirationTtl });
  },
};

const mails = [];
const fixture = {
  mailReady: true,
  mails,
  env: {
    DB: { prepare: (sql) => statement(sql) },
    RATE,
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
    STRIPE_PRICE_PRO_YEARLY: 'price_pro_y',
    BILLING_ALERT_EMAIL: 'ops@example.test',
  },
};
globalThis.__billingErrors = fixture;

const now = new Date().toISOString();
const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
const addUser = (id, fields = {}) =>
  db
    .prepare(
      `INSERT INTO users(id,email,email_lower,name,plan,period_start,created_at,updated_at,stripe_customer_id,stripe_subscription_id,plan_status,apple_expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, `${id}@example.test`, `${id}@example.test`, id, fields.plan ?? 'free', now, now, now,
      fields.customer ?? null, fields.subscription ?? null, fields.status ?? '', fields.apple ?? null);
addUser('buyer', { customer: 'cus_buyer' });
addUser('subbed', { plan: 'pro', customer: 'cus_subbed', subscription: 'sub_live', status: 'active' });
addUser('apple', { apple: later });
addUser('nobody');
const userOf = (id) => ({ id, email: `${id}@example.test`, name: id, plan: db.prepare('SELECT plan FROM users WHERE id=?').get(id).plan });

/* -------------------------------------------------------------- fake Stripe */

const TAX_DETAIL =
  'Invalid line_items[0]: the product tax code is missing for prod_Plus. Product tax code is required for Managed Payments.';
const stripe = { reject: null, outage: null, hang: null, calls: [] };
const stripeError = (status, message, code) => Response.json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } }, { status });

const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.stripe.com') throw new Error(`Unexpected network request: ${url}`);
  const method = init.method ?? 'GET';
  const path = url.pathname.replace(/^\/v1/, '');
  stripe.calls.push(`${method} ${path}`);
  if (stripe.hang?.(method, path)) throw new DOMException('The operation timed out.', 'TimeoutError');
  if (stripe.outage?.(method, path)) return stripeError(500, 'Fixture outage');
  const rejection = stripe.reject?.(method, path);
  if (rejection) return stripeError(400, rejection.message, rejection.code);

  if (method === 'GET' && path === '/checkout/sessions') return Response.json({ data: [] });
  if (method === 'POST' && path === '/checkout/sessions') return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  if (method === 'POST' && path === '/customers') return Response.json({ id: 'cus_new' });
  if (method === 'GET' && path === '/subscriptions/sub_live')
    return Response.json({ id: 'sub_live', items: { data: [{ id: 'si_1', price: { id: 'price_pro_m' } }] } });
  if (method === 'POST' && path === '/billing_portal/sessions') return Response.json({ url: 'https://portal.stripe.test/1' });
  if (method === 'GET' && path === '/subscriptions') return Response.json({ data: [] });
  return stripeError(404, `No fixture for ${method} ${path}`);
};

/* ------------------------------------------------------------------ bundling */

const directory = mkdtempSync(join(tmpdir(), 'billing-errors-check-'));
const plugin = {
  name: 'fixtures',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const env=globalThis.__billingErrors.env;', loader: 'js' }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents:
        'export const canSendEmail=()=>globalThis.__billingErrors.mailReady;' +
        'export async function sendMail(mail){globalThis.__billingErrors.mails.push(mail);return true;}',
      loader: 'js',
    }));
  },
};
const entries = {
  errors: 'src/lib/billing-errors.ts',
  billing: 'src/lib/billing.ts',
  checkout: 'src/pages/api/billing/checkout.ts',
  portal: 'src/pages/api/billing/portal.ts',
};

const logged = [];
const originalError = console.error;
const originalLog = console.log;
console.error = (...args) => logged.push(args.map(String).join(' '));
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
  const errors = await load('errors');
  const billing = await load('billing');
  const routes = { checkout: (await load('checkout')).POST, portal: (await load('portal')).POST };
  const { BILLING_ERROR_MESSAGES: MESSAGES, GENERIC_BILLING_ERROR: GENERIC, billingErrorMessage } = errors;

  /* --------------------------------------------------- code -> message */

  for (const [code, message] of Object.entries(MESSAGES)) {
    assert.equal(billingErrorMessage(code), message, code);
    assert.doesNotMatch(message, /stripe|line_items|tax code|txcd|managed payments|deployment/i, `${code} is plain language`);
  }
  assert.match(MESSAGES.checkout_unavailable, /checkout isn't available right now/i);
  assert.match(MESSAGES.checkout_unavailable, /site owner has been told/i);
  assert.equal(MESSAGES.already_subscribed, 'This account already has a subscription. Change plan from Billing on your account screen.');
  assert.equal(billingErrorMessage(null), null, 'no parameter, no notice');
  assert.equal(billingErrorMessage(''), null);

  // Anything else — including text someone put in a link — gets the one
  // generic message, and nothing of what was sent is echoed.
  const crafted = [
    'Payments have moved. Pay at https://evil.example/pay',
    'unexpected',
    'CHECKOUT_UNAVAILABLE',
    'checkout_unavailable ',
    '<script>alert(1)</script>',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'x'.repeat(5000),
  ];
  for (const text of crafted) {
    const shown = billingErrorMessage(text);
    assert.equal(shown, GENERIC, `${JSON.stringify(text.slice(0, 40))} gets the generic message`);
    assert.ok(!shown.includes(text.trim()), 'no URL text is echoed');
  }
  assert.doesNotMatch(GENERIC, /stripe/i);

  // The pages show only what the lookup returns.
  for (const page of ['src/pages/pricing.astro', 'src/pages/app/account.astro']) {
    const source = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const reads = source.match(/^.*get\('billing_error'\).*$/gm) ?? [];
    assert.equal(reads.length, 1, `${page} reads billing_error once`);
    assert.match(reads[0], /billingErrorMessage\(\s*[\w.]+\.get\('billing_error'\)\s*\)/, `${page} looks the code up`);
  }

  /* ----------------------------------------------------------- routes */

  const origin = 'https://fixture.test';
  const call = async (flow, user, body, { json = false } = {}) => {
    const headers = json
      ? { 'content-type': 'application/json', accept: 'application/json' }
      : { 'content-type': 'application/x-www-form-urlencoded' };
    const request = new Request(`${origin}/api/billing/${flow}`, {
      method: 'POST',
      headers,
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    const response = await routes[flow]({ request, locals: { user: user ? userOf(user) : null } });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), json: text ? JSON.parse(text) : null };
  };

  /** The redirect carries one parameter, a known code, and nothing else. */
  const codeIn = (location, page) => {
    const target = new URL(location, origin);
    assert.equal(target.origin, origin);
    assert.equal(target.pathname, page);
    assert.deepEqual([...target.searchParams.keys()], ['billing_error'], 'only the code travels in the URL');
    const code = target.searchParams.get('billing_error');
    assert.match(code, /^[a-z_]+$/);
    assert.equal(location, `${page}?billing_error=${code}`);
    return code;
  };

  // Stripe turns checkout down over a product setting.
  stripe.reject = (method, path) => (method === 'POST' && path === '/checkout/sessions' ? { message: TAX_DETAIL } : null);
  let r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(r.status, 303);
  assert.equal(codeIn(r.location, '/pricing'), 'checkout_unavailable');
  assert.ok(!r.location.includes('tax') && !r.location.includes('Stripe'));
  assert.ok(logged.some((line) => line.includes(TAX_DETAIL)), "Stripe's detail is still logged");

  assert.equal(mails.length, 1, 'the operator is emailed');
  assert.equal(mails[0].to, 'ops@example.test');
  assert.match(mails[0].subject, /checkout/);
  assert.ok(mails[0].text.includes(TAX_DETAIL), "the email carries Stripe's message");
  assert.match(mails[0].text, /POST \/api\/billing\/checkout/, 'and the request path');
  assert.match(mails[0].text, /POST \/checkout\/sessions → 400/);
  assert.match(mails[0].text, /Product catalog.*txcd_10103001/, 'and the fix for a missing tax code');
  assert.deepEqual([...kv.entries()], [['billing-alert:invalid_request_error', { value: '1', ttl: 3600 }]]);

  // JSON callers (the iOS app) keep {error:{type,message}}, with the fixed text.
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' }, { json: true });
  assert.equal(r.status, 502);
  assert.equal(r.location, null, 'JSON callers are never redirected');
  assert.deepEqual(Object.keys(r.json), ['error']);
  assert.deepEqual(Object.keys(r.json.error).sort(), ['message', 'type']);
  assert.equal(r.json.error.type, 'billing_error');
  assert.equal(r.json.error.message, MESSAGES.checkout_unavailable);
  assert.equal(mails.length, 1, 'the same Stripe code within the hour sends nothing more');

  // A different Stripe code is its own alert; the portal says "billing".
  stripe.reject = (method, path) =>
    method === 'POST' && path === '/billing_portal/sessions'
      ? { message: 'No configuration provided and your test mode default configuration has not been created.', code: 'resource_missing' }
      : null;
  r = await call('portal', 'buyer', {});
  assert.equal(codeIn(r.location, '/app/account'), 'portal_unavailable');
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /portal.*resource_missing/);
  assert.match(mails[1].text, /POST \/api\/billing\/portal/);
  assert.match(mails[1].text, /Customer portal/, 'with the portal hint');
  r = await call('portal', 'buyer', {}, { json: true });
  assert.equal(r.json.error.message, MESSAGES.portal_unavailable);

  // The throttle fails open: with KV down the operator still hears.
  kv.clear();
  RATE.broken = true;
  stripe.reject = (method, path) => (path === '/checkout/sessions' && method === 'POST' ? { message: TAX_DETAIL } : null);
  await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(mails.length, 3, 'a broken throttle does not swallow the alert');
  RATE.broken = false;

  // No BILLING_ALERT_EMAIL: the company contact address. No mailer: nothing, and nothing claimed.
  kv.clear();
  delete fixture.env.BILLING_ALERT_EMAIL;
  await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(mails.at(-1).to, 'hello@easyscreencapture.com');
  kv.clear();
  fixture.mailReady = false;
  const before = mails.length;
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(codeIn(r.location, '/pricing'), 'checkout_unavailable');
  assert.equal(mails.length, before);
  assert.equal(kv.size, 0);
  fixture.mailReady = true;
  fixture.env.BILLING_ALERT_EMAIL = 'ops@example.test';
  stripe.reject = null;

  // Stripe down or slow is not a setting to fix: a retry message, and no email.
  const quiet = mails.length;
  stripe.outage = (method, path) => method === 'POST' && path === '/checkout/sessions';
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(codeIn(r.location, '/pricing'), 'temporarily_unavailable');
  stripe.outage = null;
  stripe.hang = (method, path) => method === 'POST' && path === '/checkout/sessions';
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(codeIn(r.location, '/pricing'), 'temporarily_unavailable');
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' }, { json: true });
  assert.equal(r.json.error.message, 'Payments are temporarily unavailable. Try again in a moment.');
  stripe.hang = null;
  assert.equal(mails.length, quiet);

  // Customer-actionable failures keep their message, by code.
  const expect = async (flow, user, body, page, code, json) => {
    const form = await call(flow, user, body);
    assert.equal(form.status, 303, `${code} redirects`);
    assert.equal(codeIn(form.location, page), code);
    const api = await call(flow, user, body, { json: true });
    assert.equal(api.json.error.type, json.type, `${code} keeps its API type`);
    if (json.message) assert.equal(api.json.error.message, json.message);
  };
  await expect('checkout', 'subbed', { plan: 'pro' }, '/pricing', 'already_subscribed', {
    type: 'already_subscribed',
    message: MESSAGES.already_subscribed,
  });
  await expect('checkout', 'apple', { plan: 'pro' }, '/pricing', 'apple_subscription', { type: 'already_subscribed' });
  assert.equal(MESSAGES.apple_subscription, 'Manage your Apple subscription before starting a different subscription.');
  await expect('checkout', 'buyer', {}, '/pricing', 'plan_required', { type: 'invalid_request' });
  await expect('checkout', 'buyer', { plan: 'nonsense' }, '/pricing', 'plan_required', { type: 'invalid_request' });
  await expect('portal', 'nobody', {}, '/app/account', 'no_customer', { type: 'no_customer', message: MESSAGES.no_customer });
  delete fixture.env.STRIPE_PRICE_PLUS_MONTHLY;
  await expect('checkout', 'buyer', { plan: 'plus', interval: 'monthly' }, '/pricing', 'plan_unavailable', { type: 'billing_unavailable' });
  delete fixture.env.STRIPE_SECRET_KEY;
  await expect('checkout', 'buyer', { plan: 'pro' }, '/pricing', 'billing_unavailable', { type: 'billing_unavailable' });
  await expect('portal', 'buyer', {}, '/app/account', 'billing_unavailable', { type: 'billing_unavailable' });
  fixture.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  // Whatever else goes wrong maps to a code too, never to its message.
  db.exec('ALTER TABLE users RENAME COLUMN apple_expires_at TO apple_expires_later');
  r = await call('checkout', 'buyer', { plan: 'pro' });
  assert.equal(codeIn(r.location, '/pricing'), 'unexpected');
  db.exec('ALTER TABLE users RENAME COLUMN apple_expires_later TO apple_expires_at');
  assert.equal(mails.length, quiet, 'only Stripe rejections email the operator');

  // Every code a route can produce has a message of its own.
  for (const code of ['checkout_unavailable', 'portal_unavailable', 'temporarily_unavailable', 'already_subscribed', 'apple_subscription', 'plan_required', 'no_customer', 'plan_unavailable', 'billing_unavailable'])
    assert.ok(Object.hasOwn(MESSAGES, code), code);
  assert.equal(billingErrorMessage('unexpected'), GENERIC);

  // The success path is untouched.
  r = await call('checkout', 'buyer', { plan: 'pro', interval: 'monthly' });
  assert.equal(r.location, 'https://checkout.stripe.test/cs_1');

  /* --------------------------------------- other places billing errors show */

  // Account deletion surfaces Stripe failures as JSON: plain words there too.
  stripe.reject = (method, path) => (method === 'GET' && path === '/subscriptions' ? { message: 'No such customer: cus_buyer' } : null);
  await assert.rejects(
    () => billing.cancelBillingForDeletion('buyer'),
    (error) => error.type === 'billing_error' && !/stripe|cus_buyer/i.test(error.message) && error.stripeDetail.includes('cus_buyer'),
  );

  // The signed-in diagnosis exists to explain plan-change failures to the
  // account owner, so it keeps Stripe's own words.
  stripe.reject = (method, path) =>
    method === 'POST' && path === '/billing_portal/sessions' ? { message: 'This configuration does not allow subscription updates.' } : null;
  const report = await billing.diagnosePlanChange(userOf('subbed'), { plan: 'pro', interval: 'yearly' }, origin);
  assert.equal(report.reason, 'Stripe rejected the request: This configuration does not allow subscription updates.');
  stripe.reject = null;

  assert.match(errors.billingFailureHint(TAX_DETAIL), /txcd_10103001/);
  assert.equal(errors.billingFailureHint('Something nobody has seen before'), null);

  restoreConsole();
  console.log(
    'Billing error checks passed: fixed messages by code, generic for unknown or crafted codes, no URL text echoed, ' +
      'code-only redirects, JSON shape and wording, operator alerts (hint, path, throttle, fail-open, fallback address) and the diagnosis detail.',
  );
} finally {
  restoreConsole();
  globalThis.fetch = previousFetch;
  delete globalThis.__billingErrors;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
