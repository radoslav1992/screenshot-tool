import assert from 'node:assert/strict';
import { estimatePlan } from '../src/lib/plan-estimator.mjs';
import { TAX_CODE_PATTERN, productTaxCode, productTaxCodeIssue, taxCodeUpdate, validateStripePrice } from '../src/lib/stripe-price-check.mjs';
import { PLANS, PLAN_ORDER, WATCH_LIMIT, WATCH_FREQUENCIES } from '../src/lib/plans.ts';
const plans = PLAN_ORDER.map(id => ({
  id, name: PLANS[id].name, quota: PLANS[id].quota, priceMonthly: PLANS[id].priceMonthly,
  monitorLimit: WATCH_LIMIT[id], frequencies: WATCH_FREQUENCIES[id],
  pdf: PLANS[id].formats.includes('pdf'), api: PLANS[id].api, team: id === 'business',
}));
const choose = input => estimatePlan({ pages: 100, sizes: 1, monitors: 0, ...input }, plans);
assert.equal(choose({}).plan.id, 'lite');
assert.equal(choose({pages: 20}).plan.id, 'free');
assert.equal(choose({pages: 21}).plan.id, 'lite');
assert.equal(choose({pdf: true}).plan.id, 'plus');
assert.equal(choose({api: true}).plan.id, 'pro');
assert.equal(choose({team: true}).plan.id, 'business');
assert.equal(choose({pages: 100, sizes: 3}).manual, 300);
assert.equal(choose({monitors: 5, frequency: 'daily', baselines: true}).total, 255);
assert.equal(choose({monitors: 1, frequency: 'hourly'}).plan.id, 'pro');
assert.equal(choose({monitors: 25, frequency: 'hourly'}).plan, null);
// Monitors on every plan: Free 3 weekly, Lite 10, Plus 25, Pro 100, Business 300.
assert.equal(choose({pages: 5, monitors: 3, frequency: 'weekly'}).plan.id, 'free', 'three weekly monitors fit Free');
assert.equal(choose({pages: 5, monitors: 3, frequency: 'weekly'}).total, 20);
assert.equal(choose({pages: 0, monitors: 4, frequency: 'weekly'}).plan.id, 'lite', 'a fourth needs Lite');
assert.equal(choose({monitors: 6, frequency: 'weekly'}).plan.id, 'lite');
assert.equal(choose({pages: 0, monitors: 3, frequency: 'daily'}).plan.id, 'lite', 'daily checks start on Lite');
assert.equal(choose({pages: 0, monitors: 11, frequency: 'daily'}).plan.id, 'plus', 'more than ten need Plus');
assert.equal(choose({pages: 0, monitors: 26, frequency: 'weekly'}).plan.id, 'pro');
assert.equal(choose({pages: 0, monitors: 101, frequency: 'weekly'}).plan.id, 'business');
assert.equal(choose({pages: 0, monitors: 301, frequency: 'weekly'}).plan, null);
// Rule-based monitors spend a screenshot per change plus a weekly full check; visual ones spend one per check.
assert.equal(choose({monitors: 25, frequency: 'hourly', kind: 'rules'}).scheduled, 25 * 9, 'four changes and five safety-net checks each');
assert.equal(choose({monitors: 25, frequency: 'hourly', kind: 'rules'}).plan.id, 'pro', 'where 25 hourly visual monitors fit no plan');
assert.equal(choose({monitors: 100, frequency: 'quarter-hourly', kind: 'rules', changes: 10}).plan.id, 'pro');
assert.equal(choose({monitors: 3, frequency: 'weekly', kind: 'rules', changes: 0}).scheduled, 15, 'never more than one per check');
assert.equal(choose({monitors: 1, frequency: 'quarter-hourly'}).frequency, 'daily', 'a visual monitor cannot run every 15 minutes');
assert.equal(choose({monitors: 1, frequency: 'quarter-hourly', kind: 'rules'}).plan.id, 'pro', 'and a rule-based one does so on Pro');
assert.equal(choose({monitors: 2, kind: 'rules', baselines: true}).baselines, 8, 'it learns over its first four checks');
assert.equal(choose({pages: -10, monitors: NaN}).total, 0);
const price = {active: true, type: 'recurring', currency: 'usd', unit_amount: 700, billing_scheme: 'per_unit',
  livemode: true, product: {active: true}, recurring: {interval: 'month', interval_count: 1, usage_type: 'licensed'}};
const expected = {currency: 'usd', amount: 700, interval: 'month', live: true};
assert.deepEqual(validateStripePrice(price, expected), []);
for (const patch of [{active:false}, {type:'one_time'}, {currency:'eur'}, {unit_amount:999}, {livemode:false},
  {billing_scheme:'tiered'}, {product:{active:false}}, {recurring:{interval:'year',interval_count:1,usage_type:'licensed'}}])
  assert.ok(validateStripePrice({...price,...patch}, expected).length);
// Product tax codes: Managed Payments rejects checkout for a product without one.
assert.equal(productTaxCode({tax_code: 'txcd_10103001'}), 'txcd_10103001');
assert.equal(productTaxCode({tax_code: {id: 'txcd_10103000', object: 'tax_code'}}), 'txcd_10103000', 'expanded codes read too');
assert.equal(productTaxCode({tax_code: null}), null);
assert.equal(taxCodeUpdate({tax_code: null}, undefined), null, 'no STRIPE_TAX_CODE, no change');
assert.deepEqual(taxCodeUpdate({tax_code: null}, 'txcd_10103001'), {from: null, to: 'txcd_10103001'}, 'a missing code is set');
assert.deepEqual(taxCodeUpdate({tax_code: 'txcd_10000000'}, 'txcd_10103001'), {from: 'txcd_10000000', to: 'txcd_10103001'}, 'a different code is replaced');
assert.equal(taxCodeUpdate({tax_code: 'txcd_10103001'}, 'txcd_10103001'), null, 'a re-run changes nothing');
assert.equal(taxCodeUpdate({tax_code: {id: 'txcd_10103001'}}, 'txcd_10103001'), null);
const untaxed = productTaxCodeIssue({id: 'prod_1', active: true, tax_code: null});
assert.match(untaxed, /Product tax code is required for Managed Payments/, 'names the checkout error it causes');
assert.match(untaxed, /Product catalog/);
assert.match(untaxed, /STRIPE_TAX_CODE=txcd_… npm run stripe:setup/);
assert.match(untaxed, /txcd_10103001.*txcd_10103000/);
assert.equal(productTaxCodeIssue({id: 'prod_1', tax_code: 'txcd_10103001'}), null);
assert.equal(productTaxCodeIssue('prod_1'), null, 'an unexpanded product is not judged');
for (const code of ['txcd_10103001', 'txcd_10103000']) assert.match(code, TAX_CODE_PATTERN);
for (const code of ['10103001', 'txcd_1010300', 'txcd_10103001 ', 'TXCD_10103001']) assert.doesNotMatch(code, TAX_CODE_PATTERN);
console.log('Commerce checks passed: quota boundaries, feature requirements, monitor costs, Stripe price mismatches and product tax codes.');
