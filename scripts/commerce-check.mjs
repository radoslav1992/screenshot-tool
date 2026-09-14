import assert from 'node:assert/strict';
import { estimatePlan } from '../src/lib/plan-estimator.mjs';
import { validateStripePrice } from '../src/lib/stripe-price-check.mjs';
import { PLANS, PLAN_ORDER, WATCH_LIMIT, WATCH_FREQUENCIES } from '../src/lib/plans.ts';
const plans = PLAN_ORDER.map(id => ({
  id, name: PLANS[id].name, quota: PLANS[id].quota, priceMonthly: PLANS[id].priceMonthly,
  monitorLimit: WATCH_LIMIT[id], frequencies: WATCH_FREQUENCIES[id],
  pdf: PLANS[id].formats.includes('pdf'), api: PLANS[id].api, team: id === 'business',
}));
const choose = input => estimatePlan({ pages: 100, sizes: 1, monitors: 0, ...input }, plans);
assert.equal(choose({}).plan.id, 'free');
assert.equal(choose({pages: 200}).plan.id, 'free');
assert.equal(choose({pages: 201}).plan.id, 'plus');
assert.equal(choose({pdf: true}).plan.id, 'plus');
assert.equal(choose({api: true}).plan.id, 'pro');
assert.equal(choose({team: true}).plan.id, 'business');
assert.equal(choose({pages: 100, sizes: 3}).manual, 300);
assert.equal(choose({monitors: 5, frequency: 'daily', baselines: true}).total, 255);
assert.equal(choose({monitors: 1, frequency: 'hourly'}).plan.id, 'pro');
assert.equal(choose({monitors: 25, frequency: 'hourly'}).plan, null);
assert.equal(choose({monitors: 6, frequency: 'weekly'}).plan.id, 'pro');
assert.equal(choose({pages: -10, monitors: NaN}).total, 0);
const price = {active: true, type: 'recurring', currency: 'usd', unit_amount: 700, billing_scheme: 'per_unit',
  livemode: true, product: {active: true}, recurring: {interval: 'month', interval_count: 1, usage_type: 'licensed'}};
const expected = {currency: 'usd', amount: 700, interval: 'month', live: true};
assert.deepEqual(validateStripePrice(price, expected), []);
for (const patch of [{active:false}, {type:'one_time'}, {currency:'eur'}, {unit_amount:999}, {livemode:false},
  {billing_scheme:'tiered'}, {product:{active:false}}, {recurring:{interval:'year',interval_count:1,usage_type:'licensed'}}])
  assert.ok(validateStripePrice({...price,...patch}, expected).length);
console.log('Commerce checks passed: quota boundaries, feature requirements, monitor costs and Stripe price mismatches.');
