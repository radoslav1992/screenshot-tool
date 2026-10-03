/** Shared forecast and run metadata. No captured URLs or provider responses are stored here. */
import type { ChangeRegion } from './visual-diff-fn';
export interface Schedule {
  id: string;
  frequency: string;
  status: string;
  next_run_at: string;
  /**
   * What a check costs: `check`, a screenshot every time (visual monitors, and
   * rule-based ones that need a full browser); `change`, a rule-based monitor
   * that reads its page and takes one only when something changed (fast-checks.ts).
   */
  cost?: 'check' | 'change';
}
export interface Budget {
  quota: number;
  remaining: number;
  renewsOn: string;
}
const HOURS: Record<string, number> = { 'quarter-hourly': 0.25, hourly: 1, daily: 24, weekly: 168 };
/**
 * A monitor that reads first still takes a full check at least weekly, as a
 * safety net. That is what it is certain to spend; each change it finds
 * costs one more, which no forecast can know.
 */
const SAFETY_NET_HOURS = 168;
export function forecast(schedules: Schedule[], budget: Budget, now = new Date()) {
  const reset = Date.parse(`${budget.renewsOn}T00:00:00Z`);
  let monthly = 0,
    untilReset = 0,
    active = 0,
    onChange = 0;
  for (const schedule of schedules) {
    if (schedule.status !== 'active') continue;
    const every = HOURS[schedule.frequency];
    if (!every) continue;
    active++;
    if (schedule.cost === 'change') onChange++;
    const hours = schedule.cost === 'change' ? Math.max(every, SAFETY_NET_HOURS) : every;
    monthly += 720 / hours;
    const next = Date.parse(schedule.next_run_at);
    const start = Math.max(now.getTime(), Number.isFinite(next) ? next : now.getTime());
    untilReset += Math.max(0, Math.ceil((reset - start) / (hours * 3_600_000)));
  }
  monthly = Math.ceil(monthly);
  return {
    active,
    /** Active monitors that spend a screenshot only when something changes; `monthly` counts their weekly full checks alone. */
    onChange,
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
/**
 * What a visual comparison found, kept with the run. Absent on older runs and
 * on rules that compare text.
 */
export interface RunChanges {
  /** Changed areas as fractions of the "after" image (see visual-diff-fn). */
  regions: ChangeRegion[];
  /** A highlighted copy of the "after" image was stored next to it. */
  highlight: boolean;
  /** Compared against a pinned baseline rather than the previous check. */
  pinned: boolean;
  /**
   * Differed from the pinned baseline, but not from the version last alerted
   * about, so no new alert went out. Recorded with `changed` 0.
   */
  repeat: boolean;
}
const PREFIX = 'esc-run-v1:';
export function encodeRunDetail(message: string | null, delivery: Delivery, changes: Partial<RunChanges> = {}): string {
  // Only what is there: most runs carry none of it, and the column stays small.
  const extra = {
    ...(changes.regions?.length ? { regions: changes.regions } : {}),
    ...(changes.highlight ? { highlight: true } : {}),
    ...(changes.pinned ? { pinned: true } : {}),
    ...(changes.repeat ? { repeat: true } : {}),
  };
  return PREFIX + JSON.stringify({ message, delivery, ...extra });
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
/** What a run's comparison found (see RunChanges); all empty for older runs and text rules. */
export function decodeRunChanges(detail: string | null): RunChanges {
  const none: RunChanges = { regions: [], highlight: false, pinned: false, repeat: false };
  if (!detail?.startsWith(PREFIX)) return none;
  try {
    const data = JSON.parse(detail.slice(PREFIX.length));
    if (!data || typeof data !== 'object') return none;
    return {
      regions: parseRegions(data.regions),
      highlight: data.highlight === true,
      pinned: data.pinned === true,
      repeat: data.repeat === true,
    };
  } catch {
    return none;
  }
}
/** Boxes that are not fractions inside the image are dropped rather than drawn; at most MAX_REGIONS (8). */
function parseRegions(value: unknown): ChangeRegion[] {
  if (!Array.isArray(value)) return [];
  const fraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  return value
    .filter((r) => r && fraction(r.x) && fraction(r.y) && fraction(r.w) && fraction(r.h) && r.w > 0 && r.h > 0)
    .slice(0, 8)
    .map((r) => ({ x: r.x, y: r.y, w: Math.min(r.w, 1 - r.x), h: Math.min(r.h, 1 - r.y) }));
}
export function runLabel(run: {
  status: string;
  changed: number;
  baseline_capture_id: string | null;
  change_pct: number | null;
  repeat?: boolean;
}) {
  if (run.status === 'error') return 'Check failed';
  if (run.status === 'skipped') return 'Check skipped';
  if (!run.baseline_capture_id) return 'Baseline saved';
  if (run.changed) return 'Change detected';
  if (run.repeat) return 'No new change';
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
