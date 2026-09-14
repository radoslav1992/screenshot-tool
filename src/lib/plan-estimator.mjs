/** Estimates a 30-day workload; supplied plan data remains the source of truth. */
export function estimatePlan(input, plans) {
  const count = (value, max) => Math.min(max, Math.max(0, Math.ceil(Number(value) || 0)));
  const pages = count(input.pages, 100000);
  const sizes = Math.max(1, count(input.sizes, 10));
  const monitors = count(input.monitors, 10000);
  const frequency = ['daily', 'hourly', 'weekly'].includes(input.frequency) ? input.frequency : 'daily';
  const runs = frequency === 'hourly' ? 720 : frequency === 'weekly' ? 5 : 30;
  const manual = pages * sizes;
  const scheduled = monitors * runs;
  const baselines = input.baselines ? monitors : 0;
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
  return { manual, scheduled, baselines, total, plan, remaining: plan ? plan.quota - total : null };
}
