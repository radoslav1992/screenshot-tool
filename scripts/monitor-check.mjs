import assert from 'node:assert/strict';
import {
  forecast,
  suggestFrequency,
  encodeRunDetail,
  decodeRunDetail,
  runLabel,
  observeDelivery,
} from '../src/lib/monitor-health.ts';
const now = new Date('2026-09-12T00:00:00Z');
const budget = { quota: 2000, remaining: 1500, renewsOn: '2026-10-01' };
const schedule = (id, frequency, status = 'active', next = '2026-09-12T00:00:00Z') => ({
  id,
  frequency,
  status,
  next_run_at: next,
});
assert.equal(forecast([schedule('a', 'hourly')], budget, now).monthly, 720);
assert.equal(forecast([schedule('a', 'hourly')], budget, now).untilReset, 456);
assert.equal(forecast([schedule('a', 'daily', 'paused')], budget, now).monthly, 0);
assert.equal(forecast([schedule('a', 'daily', 'active', '2026-10-01T00:00:00Z')], budget, now).untilReset, 0);
assert.equal(
  forecast([schedule('a', 'daily', 'active', '2026-08-01T00:00:00Z')], budget, now).untilReset,
  19,
  'overdue checks do not backfill missed runs',
);
assert.equal(forecast([schedule('a', 'weekly')], budget, now).untilReset, 3);
const many = Array.from({ length: 25 }, (_, i) => schedule(String(i), 'hourly'));
assert.equal(forecast(many, budget, now).monthly, 18000);
assert.equal(forecast(many, budget, now).shortfall, 9900);
assert.equal(
  suggestFrequency([], schedule('new', 'hourly'), { ...budget, quota: 500, remaining: 100 }, ['daily', 'weekly'], now),
  'daily',
);
assert.equal(
  suggestFrequency(
    [schedule('new', 'hourly')],
    schedule('new', 'hourly'),
    { ...budget, quota: 500, remaining: 100 },
    ['daily', 'weekly'],
    now,
  ),
  'daily',
  'editing replaces an existing schedule',
);
assert.equal(
  suggestFrequency(many, schedule('new', 'hourly'), budget, ['daily', 'weekly'], now),
  null,
  'do not recommend a cadence that still exceeds the account budget',
);
assert.equal(forecast([], budget, new Date('2026-10-01')).untilReset, 0);
const detail = encodeRunDetail('first baseline', { email: 'accepted', webhook: 'failed' });
assert.deepEqual(decodeRunDetail(detail), {
  detail: 'first baseline',
  delivery: { email: 'accepted', webhook: 'failed' },
});
assert.equal(decodeRunDetail('legacy detail').delivery.email, 'unknown');
assert.equal(decodeRunDetail('esc-run-v1:{bad').detail, 'esc-run-v1:{bad');
assert.equal(decodeRunDetail('esc-run-v1:{"delivery":{"email":"__proto__"}}').delivery.email, 'unknown');
assert.equal(runLabel({ status: 'done', changed: 0, baseline_capture_id: null, change_pct: null }), 'Baseline saved');
assert.equal(
  runLabel({ status: 'done', changed: 0, baseline_capture_id: 'before', change_pct: null }),
  'Check completed',
);
assert.equal(runLabel({ status: 'skipped' }), 'Check skipped');
assert.equal(await observeDelivery(async () => true), 'accepted');
assert.equal(await observeDelivery(async () => false), 'failed');
assert.equal(
  await observeDelivery(async () => {
    throw new Error('provider failed');
  }),
  'failed',
);
assert.equal(await observeDelivery(() => new Promise(() => {}), 5), 'unknown');
assert.equal(
  await observeDelivery(async () => {
    throw new DOMException('timeout', 'TimeoutError');
  }),
  'unknown',
);
console.log(
  'Monitor checks passed: quota forecasts, reset boundaries, paused schedules, suggestions, legacy metadata, and notification outcomes.',
);
