/** Checks per 30 days at each schedule; weekly allows five, for the months that hold five. */
const RUNS = { 'quarter-hourly': 2880, hourly: 720, daily: 30, weekly: 5 };

/**
 * A rule-based monitor reads its page and takes a screenshot only when what it
 * watches changed, plus a full check at least weekly as a safety net — about
 * five a month. Its first four checks render too, while it learns.
 */
const SAFETY_NET_RUNS = 5;
const LEARNING_CHECKS = 4;

/** Estimates a 30-day workload; supplied plan data remains the source of truth. */
export function estimatePlan(input, plans) {
  const count = (value, max) => Math.min(max, Math.max(0, Math.ceil(Number(value) || 0)));
  const pages = count(input.pages, 100000);
  const sizes = Math.max(1, count(input.sizes, 10));
  const monitors = count(input.monitors, 10000);
  const rules = input.kind === 'rules';
  // Every 15 minutes is for rule-based monitors only.
  const frequencies = rules ? ['daily', 'hourly', 'weekly', 'quarter-hourly'] : ['daily', 'hourly', 'weekly'];
  const frequency = frequencies.includes(input.frequency) ? input.frequency : 'daily';
  const runs = RUNS[frequency];
  const changes = input.changes === undefined || input.changes === '' ? 4 : count(input.changes, 100000);
  const perMonitor = rules ? Math.min(runs, changes + SAFETY_NET_RUNS) : runs;
  const manual = pages * sizes;
  const scheduled = monitors * perMonitor;
  const baselines = input.baselines ? monitors * (rules ? LEARNING_CHECKS : 1) : 0;
  const total = manual + scheduled + baselines;
  const matching = plans.filter(plan =>
    plan.quota >= total &&
    plan.monitorLimit >= monitors &&
    (!monitors || plan.frequencies.includes(frequency)) &&
    (!input.pdf || plan.pdf) &&
    (!input.api || plan.api) &&
    (!input.team || plan.team)
  );
  const plan = matching.sort((a, b) => a.priceMonthly - b.priceMonthly)[0] ?? null;
  return { manual, scheduled, baselines, total, plan, remaining: plan ? plan.quota - total : null, frequency, perMonitor };
}
