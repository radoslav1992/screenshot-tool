#!/usr/bin/env node
/*
 * Creates the Easy Screen Capture products and prices in Stripe, and prints the
 * price ids ready to paste into Cloudflare.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup
 *
 * Safe to re-run. Every price is created with a stable `lookup_key`, and the
 * script looks those up first — so a second run reports what already exists
 * instead of creating a duplicate product for every plan.
 *
 * Test and live are separate worlds in Stripe: run this once with your
 * sk_test_… key and once with sk_live_…, and keep the two sets of price ids
 * apart. Nothing here reads or writes your Cloudflare config; it only prints.
 */

import { PLANS, PAID_PLANS } from '../src/lib/plans.ts';

const KEY = process.env.STRIPE_SECRET_KEY;
const CURRENCY = (process.env.STRIPE_CURRENCY ?? 'usd').toLowerCase();

/**
 * Optional Stripe Tax product tax code. Leave unset to inherit the account's
 * default. The right code depends on what you sell and where — find yours at
 * https://stripe.com/docs/tax/tax-codes rather than guessing.
 */
const TAX_CODE = process.env.STRIPE_TAX_CODE;

if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set.\n');
  console.error('  STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup');
  process.exit(1);
}

const MODE = KEY.startsWith('sk_live') ? 'LIVE' : 'test';

/* -------------------------------------------------------------------------- */

function encodeForm(value, prefix = '', out = new URLSearchParams()) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => encodeForm(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      encodeForm(item, prefix ? `${prefix}[${key}]` : key, out);
    }
    return out;
  }
  out.append(prefix, String(value));
  return out;
}

async function stripe(method, path, body) {
  const headers = { authorization: `Bearer ${KEY}` };
  let url = `https://api.stripe.com/v1${path}`;
  let payload;

  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = encodeForm(body ?? {}).toString();
  } else if (body) {
    url += `?${encodeForm(body).toString()}`;
  }

  const response = await fetch(url, { method, headers, body: payload });
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const message = json?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${path} → ${message}`);
  }
  return json;
}

/* -------------------------------------------------------------------------- */

const INTERVALS = [
  { key: 'monthly', interval: 'month', amountOf: (plan) => plan.priceMonthly },
  { key: 'yearly', interval: 'year', amountOf: (plan) => plan.priceYearly },
];

const lookupKey = (planId, interval) => `esc_${planId}_${interval}`;

/** Finds a plan's product via an existing price, which is immediately consistent. */
async function findProductViaPrices(planId) {
  const keys = INTERVALS.map((entry) => lookupKey(planId, entry.key));
  const { data } = await stripe('GET', '/prices', {
    lookup_keys: keys,
    active: true,
    expand: ['data.product'],
    limit: 10,
  });

  const byLookupKey = new Map();
  for (const price of data) byLookupKey.set(price.lookup_key, price);
  const product = data[0]?.product ?? null;
  return { product, byLookupKey };
}

/** Falls back to search, so a product created without prices is still reused. */
async function findProductBySearch(planId) {
  try {
    const { data } = await stripe('GET', '/products/search', {
      query: `metadata['esc_plan']:'${planId}'`,
      limit: 1,
    });
    return data[0] ?? null;
  } catch {
    // Search is unavailable on brand-new accounts until indexing is ready.
    return null;
  }
}

async function ensureProduct(plan) {
  const viaPrices = await findProductViaPrices(plan.id);
  if (viaPrices.product) {
    return { product: viaPrices.product, prices: viaPrices.byLookupKey, created: false };
  }

  const found = await findProductBySearch(plan.id);
  if (found) return { product: found, prices: viaPrices.byLookupKey, created: false };

  const product = await stripe('POST', '/products', {
    name: `Easy Screen Capture ${plan.name}`,
    description: plan.tagline,
    metadata: { esc_plan: plan.id },
    ...(TAX_CODE ? { tax_code: TAX_CODE } : {}),
  });
  return { product, prices: viaPrices.byLookupKey, created: true };
}

async function ensurePrice(plan, product, existing, entry) {
  const key = lookupKey(plan.id, entry.key);
  const found = existing.get(key);
  if (found) return { price: found, created: false };

  const price = await stripe('POST', '/prices', {
    product: product.id,
    currency: CURRENCY,
    unit_amount: entry.amountOf(plan) * 100,
    recurring: { interval: entry.interval },
    lookup_key: key,
    // Lets a re-run with changed pricing take the key over rather than failing.
    transfer_lookup_key: true,
    nickname: `${plan.name} ${entry.key}`,
    metadata: { esc_plan: plan.id, esc_interval: entry.key },
  });
  return { price, created: true };
}

/* -------------------------------------------------------------------------- */

// Also the auth probe: a bad key should say so here, not four calls later.
let account;
try {
  account = await stripe('GET', '/account');
} catch (error) {
  console.error(`\n  Could not reach Stripe: ${error.message}\n`);
  console.error('  Check that STRIPE_SECRET_KEY is a valid secret key (sk_test_… or sk_live_…).\n');
  process.exit(1);
}

console.log(`\n  Easy Screen Capture — Stripe setup`);
console.log(`  ${MODE} mode${account?.id ? ` · ${account.id}` : ''} · ${CURRENCY.toUpperCase()}`);
if (MODE === 'LIVE') console.log(`  \x1b[33mThis is your live account. Real prices, real customers.\x1b[0m`);
console.log('');

const secrets = [];

try {
  for (const planId of PAID_PLANS) {
    const plan = PLANS[planId];
    const { product, prices, created } = await ensureProduct(plan);
    console.log(`  ${created ? '+' : '='} ${product.name.padEnd(34)} ${product.id}`);

    for (const entry of INTERVALS) {
      const { price, created: isNew } = await ensurePrice(plan, product, prices, entry);
      const amount = (price.unit_amount / 100).toFixed(2);
      console.log(
        `      ${isNew ? '+' : '='} ${entry.key.padEnd(8)} ${`${CURRENCY.toUpperCase()} ${amount}`.padEnd(12)} ${price.id}`,
      );
      secrets.push([`STRIPE_PRICE_${planId.toUpperCase()}_${entry.key.toUpperCase()}`, price.id]);
    }
  }
} catch (error) {
  console.error(`\n  Stopped: ${error.message}\n`);
  console.error('  Anything listed above was created. Re-running picks up where this left off.\n');
  process.exit(1);
}

const width = Math.max(...secrets.map(([name]) => name.length));

console.log(`\n  Set these in Cloudflare (Settings → Variables and Secrets → encrypt each one):\n`);
for (const [name, id] of secrets) console.log(`    ${name.padEnd(width)}  ${id}`);

console.log(`\n  Or from the CLI:\n`);
for (const [name, id] of secrets) console.log(`    echo -n "${id}" | npx wrangler secret put ${name}`);

console.log(`\n  Still to do by hand, because they are account settings rather than objects:`);
console.log(`    · webhook endpoint → https://easyscreencapture.com/api/billing/webhook`);
console.log(`    · customer portal  → Settings → Billing → Customer portal`);
if (!TAX_CODE) console.log(`    · Stripe Tax       → Settings → Tax, then set STRIPE_AUTOMATIC_TAX=1`);
console.log('');
