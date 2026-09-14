#!/usr/bin/env node
import { PLANS, PAID_PLANS } from '../src/lib/plans.ts';
import { validateStripePrice } from '../src/lib/stripe-price-check.mjs';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!/^(sk|rk)_(live|test)_/.test(key)) throw new Error('Set STRIPE_SECRET_KEY to a secret or restricted key.');
const live = /^(sk|rk)_live_/.test(key);
const origin = new URL(process.env.PUBLIC_SITE_URL || 'https://easyscreencapture.com');
if (origin.protocol !== 'https:') throw new Error('Production checkout needs an HTTPS site URL.');
let failures = 0;
const fail = message => { failures++; console.error('FAIL: ' + message); };
async function get(path) {
  const response = await fetch('https://api.stripe.com/v1' + path, {
    headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Stripe read failed (HTTP ' + response.status + '). Check account, mode and permissions.');
  return response.json();
}
console.log('Read-only Stripe configuration check: ' + (live ? 'LIVE' : 'TEST'));
for (const id of PAID_PLANS) {
  for (const interval of ['monthly', 'yearly']) {
    const name = PLANS[id].priceEnv[interval];
    const priceId = process.env[name] || '';
    if (!/^price_[a-zA-Z0-9]+$/.test(priceId)) { fail(name + ' is missing or invalid'); continue; }
    try {
      const price = await get('/prices/' + priceId + '?expand[]=product');
      const issues = validateStripePrice(price, {
        currency: 'usd', amount: PLANS[id][interval === 'yearly' ? 'priceYearly' : 'priceMonthly'] * 100,
        interval: interval === 'yearly' ? 'year' : 'month', live,
      });
      if (issues.length) fail(name + ': ' + issues.join('; '));
      else console.log('OK: ' + name);
    } catch (error) { fail(name + ': ' + error.message); }
  }
}
const required = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
try {
  let cursor = '';
  let found = false;
  for (let page = 0; page < 20; page++) {
    const list = await get('/webhook_endpoints?limit=100' + (cursor ? '&starting_after=' + encodeURIComponent(cursor) : ''));
    found ||= list.data.some(endpoint =>
      endpoint.url === origin.origin + '/api/billing/webhook' &&
      endpoint.status === 'enabled' && endpoint.livemode === live &&
      (endpoint.enabled_events.includes('*') || required.every(type => endpoint.enabled_events.includes(type)))
    );
    if (found || !list.has_more) break;
    cursor = list.data.at(-1).id;
  }
  if (!found) fail('No matching enabled webhook with all four required events was found.');
  else console.log('OK: webhook URL, mode and selected events');
} catch (error) { fail('Webhook configuration: ' + error.message); }
if (!process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) fail('STRIPE_WEBHOOK_SECRET is missing.');
console.log('This checks supplied configuration only. It cannot verify the deployed secret, webhook delivery, portal settings or payment completion.');
process.exitCode = failures ? 1 : 0;
