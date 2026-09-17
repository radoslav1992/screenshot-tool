/** Shared forecast and run metadata. No captured URLs or provider responses are stored here. */
export interface Schedule {
  id: string;
  frequency: string;
  status: string;
  next_run_at: string;
}
export interface Budget {
  quota: number;
  remaining: number;
  renewsOn: string;
}
const HOURS: Record<string, number> = { hourly: 1, daily: 24, weekly: 168 };
export function forecast(schedules: Schedule[], budget: Budget, now = new Date()) {
  const reset = Date.parse(`${budget.renewsOn}T00:00:00Z`);
  let monthly = 0,
    untilReset = 0,
    active = 0;
  for (const schedule of schedules) {
    if (schedule.status !== 'active') continue;
    const hours = HOURS[schedule.frequency];
    if (!hours) continue;
    active++;
    monthly += 720 / hours;
    const next = Date.parse(schedule.next_run_at);
    const start = Math.max(now.getTime(), Number.isFinite(next) ? next : now.getTime());
    untilReset += Math.max(0, Math.ceil((reset - start) / (hours * 3_600_000)));
  }
  monthly = Math.ceil(monthly);
  return {
    active,
    monthly,
    untilReset,
    shortfall: Math.max(0, untilReset - budget.remaining),
    monthlyOver: monthly > budget.quota,
    remainingAfter: budget.remaining - untilReset,
  };
}
export function suggestFrequency(
  schedules: Schedule[],
  candidate: Schedule,
  budget: Budget,
  allowed: string[],
  now = new Date(),
) {
  const others = schedules.filter((item) => item.id !== candidate.id);
  return (
    allowed
      .filter((value) => HOURS[value] > HOURS[candidate.frequency])
      .sort((a, b) => HOURS[a] - HOURS[b])
      .find((frequency) => {
        const result = forecast([...others, { ...candidate, frequency }], budget, now);
        return !result.monthlyOver && result.shortfall === 0;
      }) ?? null
  );
}
export type DeliveryState =
  'pending' | 'accepted' | 'failed' | 'not_configured' | 'disabled' | 'not_needed' | 'unknown';
export interface Delivery {
  email: DeliveryState;
  webhook: DeliveryState;
}
export const deliveryLabel: Record<DeliveryState, string> = {
  pending: 'Pending / not confirmed',
  accepted: 'Accepted by provider',
  failed: 'Failed',
  not_configured: 'Email service not configured',
  disabled: 'Not enabled',
  not_needed: 'No alert needed',
  unknown: 'Not confirmed',
};
const PREFIX = 'esc-run-v1:';
export function encodeRunDetail(message: string | null, delivery: Delivery): string {
  return PREFIX + JSON.stringify({ message, delivery });
}
export function decodeRunDetail(detail: string | null): { detail: string | null; delivery: Delivery } {
  const fallback = { detail, delivery: { email: 'unknown', webhook: 'unknown' } as Delivery };
  if (!detail?.startsWith(PREFIX)) return fallback;
  try {
    const data = JSON.parse(detail.slice(PREFIX.length));
    if (!data || typeof data !== 'object') return fallback;
    const state = (value: unknown): DeliveryState =>
      typeof value === 'string' && Object.hasOwn(deliveryLabel, value) ? (value as DeliveryState) : 'unknown';
    return {
      detail: typeof data.message === 'string' ? data.message : null,
      delivery: { email: state(data.delivery?.email), webhook: state(data.delivery?.webhook) },
    };
  } catch {
    return fallback;
  }
}
export function runLabel(run: {
  status: string;
  changed: number;
  baseline_capture_id: string | null;
  change_pct: number | null;
}) {
  if (run.status === 'error') return 'Check failed';
  if (run.status === 'skipped') return 'Check skipped';
  if (!run.baseline_capture_id) return 'Baseline saved';
  if (run.changed) return 'Change detected';
  if (run.change_pct === null) return 'Check completed';
  return 'No significant change';
}
/** A timed-out request may have reached the provider; never report it as delivered or retry it automatically. */
export async function observeDelivery(send: () => Promise<boolean>, timeoutMs = 15000): Promise<DeliveryState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(send)
        .then(
          (ok) => (ok ? ('accepted' as const) : ('failed' as const)),
          (error) =>
            error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
              ? ('unknown' as const)
              : ('failed' as const),
        ),
      new Promise<DeliveryState>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
