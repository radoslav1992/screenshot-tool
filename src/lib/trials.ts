import { env } from 'cloudflare:workers';
import { loadSessionUser, toSessionUser, type SessionUser, type UserRow } from './auth';
import { clientIp, enforceThrottles } from './auth-throttle';
import { getBillingRow, hasActiveSubscription, type BillingRow } from './billing';
import { formatDate, formatDateTime } from './dates';
import { signupIpHash } from './growth';
import { HttpError } from './http';
import { canSendEmail, sendMail } from './mailer';
import { WATCH_FREQUENCIES, WATCH_LIMIT, getPlan, type PlanId } from './plans';
import { TRIAL_DAYS, TRIAL_PLAN, trialRaises, trialsAvailable, trialsReady } from './trial-plan';
import { hasConfirmedEmail } from './verification';

/**
 * Starting a 14-day Pro trial, and seeing it through: the reminder three days
 * before it ends, the note when it has, and closing it quietly when the
 * account pays for Pro first. What a trial gives is lib/trial-plan.ts.
 *
 * Once per account, from Free or Lite, with no card. The trial row is the
 * whole record: when it started and ends, whether each email went, and a
 * hashed address for the cap on trials from one place. Before migration 0019
 * nothing here offers, starts or sends anything.
 */

/** The plans an account may start a trial from. */
export const TRIAL_FROM: PlanId[] = ['free', 'lite'];
/** Trials started from one address — hashed as at signup — in TRIAL_IP_DAYS. */
export const TRIAL_IP_CAP = 3;
export const TRIAL_IP_DAYS = 30;
/** How long before the end the reminder goes. */
export const TRIAL_REMINDER_DAYS = 3;
/** POST /api/trial per account and per address, in KV. Generous: the cap above is what stops abuse. */
export const TRIAL_LIMITS = {
  user: { limit: 5, windowSeconds: 3600 },
  ip: { limit: 20, windowSeconds: 3600 },
} as const;

/** Trials one hourly sweep handles; the rest wait for the next hour. */
const SWEEP_BATCH = 100;

/**
 * Whether to offer this account a trial: the table exists, it never had one,
 * it holds Free or Lite (Apple's Lite included), and Stripe is not billing it.
 * Confirming the email and the cap on one address are checked when it is
 * started, where the answer can say why.
 */
export function trialOffered(user: SessionUser, billing: BillingRow | null, ready: boolean): boolean {
  return ready && !user.trial && TRIAL_FROM.includes(user.ownPlan) && !hasActiveSubscription(billing);
}

/** trialOffered for a page: reads the table probe and the billing row itself, and never fails it. */
export async function trialOfferFor(user: SessionUser | null): Promise<boolean> {
  if (!user || user.trial || !TRIAL_FROM.includes(user.ownPlan) || !(await trialsAvailable())) return false;
  const billing = await getBillingRow(user.id).catch(() => null);
  return trialOffered(user, billing, true);
}

/**
 * Whether the account's email allows a trial. Stricter than captures, which
 * follow REQUIRE_EMAIL_VERIFICATION: two weeks of Pro would be worth a
 * throwaway signup, so wherever this deployment can send the link the address
 * must be confirmed, whatever that setting says. A deployment that cannot send
 * mail never locks anyone out.
 */
export async function trialEmailConfirmed(userId: string): Promise<boolean> {
  return canSendEmail() ? hasConfirmedEmail(userId) : true;
}

/**
 * Starts the account's trial, or says why not: 404 before the migration, 429
 * for too many attempts or too many trials from one address, 403 while the
 * email waits to be confirmed (trialEmailConfirmed), 409 for a second
 * trial or an account already paying.
 */
export async function startTrial(
  user: SessionUser,
  request: Request,
  now = new Date(),
): Promise<{ plan: PlanId; endsAt: string }> {
  if (!(await trialsReady())) throw new HttpError(404, 'not_found', 'There is no trial to start.');

  await enforceThrottles(
    [
      { bucket: `trial-user:${user.id}`, ...TRIAL_LIMITS.user },
      { bucket: `trial-ip:${clientIp(request)}`, ...TRIAL_LIMITS.ip },
    ],
    (wait) => `Too many attempts. Wait ${wait} and try again.`,
  );

  if (!(await trialEmailConfirmed(user.id))) {
    throw new HttpError(
      403,
      'verification_required',
      'Confirm your email address to start your trial. Check your inbox for the link, or request a new one from your account page.',
    );
  }

  // Read again rather than from the session: a trial or a payment may have landed since.
  const fresh = (await loadSessionUser(user.id)) ?? user;
  if (fresh.trial) throw new HttpError(409, 'trial_used', 'This account has already had its Pro trial.');
  if (!TRIAL_FROM.includes(fresh.ownPlan) || hasActiveSubscription(await getBillingRow(user.id))) {
    throw new HttpError(
      409,
      'already_paid',
      'This account already pays for a plan, so it cannot start a trial. Change plan from Billing on your account page.',
    );
  }

  const ipHash = await signupIpHash(request);
  const startedAt = now.toISOString();
  const endsAt = new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
  const since = new Date(now.getTime() - TRIAL_IP_DAYS * 86_400_000).toISOString();
  /*
   * One statement decides, so two requests racing cannot both get past the
   * once-per-account rule or the cap. An unknown address (local runs) is no
   * address at all, so it is never capped.
   */
  const inserted = await env.DB.prepare(
    `INSERT INTO plan_trials (user_id, plan, started_at, ends_at, ip_hash)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM plan_trials WHERE user_id = ?1)
       AND (?5 IS NULL OR (SELECT COUNT(*) FROM plan_trials WHERE ip_hash = ?5 AND started_at > ?6) < ?7)`,
  )
    .bind(user.id, TRIAL_PLAN, startedAt, endsAt, ipHash, since, TRIAL_IP_CAP)
    .run()
    .catch((error) => {
      if (/UNIQUE|PRIMARY KEY/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    });
  if (!inserted?.meta?.changes) {
    const had = await env.DB.prepare(`SELECT 1 FROM plan_trials WHERE user_id = ?`).bind(user.id).first();
    if (had || !inserted) throw new HttpError(409, 'trial_used', 'This account has already had its Pro trial.');
    throw new HttpError(
      429,
      'trial_limit',
      'Too many trials have been started from this network recently. Try again later, or choose a plan.',
    );
  }
  return { plan: TRIAL_PLAN, endsAt };
}

/* -------------------------------------------------------------------------- */
/* The hourly sweep                                                            */
/* -------------------------------------------------------------------------- */

export interface TrialSweepResult {
  reminded: number;
  ended: number;
  /** Closed without an email: the account pays for Pro or more by now. */
  closed: number;
}

/**
 * Emails each trial twice, once each: a reminder when it has three days left,
 * and a note once it has ended. `reminded_at` and `ended_at` are claimed
 * before sending — a compare-and-set, so of two sweeps overlapping exactly one
 * sends — which makes each email at most once; one that fails is logged, not
 * retried. Where this deployment cannot send mail the claims are still made,
 * so the trial is closed all the same.
 *
 * The plan itself needs nothing from here: the account stops acting on Pro
 * the moment `ends_at` passes, sweep or no sweep.
 */
export async function runTrialLifecycle(origin: string, now = new Date()): Promise<TrialSweepResult> {
  const result: TrialSweepResult = { reminded: 0, ended: 0, closed: 0 };
  if (!(await trialsAvailable())) return result;

  const at = now.toISOString();
  const soon = new Date(now.getTime() + TRIAL_REMINDER_DAYS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT u.*, t.plan AS trial_plan, t.started_at AS trial_started_at, t.ends_at AS trial_ends_at,
            t.ended_at AS trial_ended_at, t.reminded_at
     FROM plan_trials t JOIN users u ON u.id = t.user_id
     WHERE t.ended_at IS NULL AND (t.ends_at <= ?1 OR (t.reminded_at IS NULL AND t.ends_at <= ?2))
     ORDER BY t.ends_at
     LIMIT ${SWEEP_BATCH}`,
  )
    .bind(at, soon)
    .all<UserRow & { reminded_at: string | null }>();

  const mail = canSendEmail();
  for (const row of results ?? []) {
    const user = toSessionUser(row);
    const trial = user.trial!;
    try {
      // Paying for Pro or Business already closed it, unless that write was lost.
      if (!trialRaises(user.ownPlan, trial.plan)) {
        if (await claim(user.id, 'ended_at', at)) result.closed++;
        continue;
      }
      if (trial.endsAt <= at) {
        if (!(await claim(user.id, 'ended_at', at))) continue;
        result.ended++;
        if (mail && !(await sendMail(endedEmail(user, origin)))) console.error(`[trials] ended email to ${user.id} was not sent`);
      } else {
        if (!(await claim(user.id, 'reminded_at', at))) continue;
        result.reminded++;
        if (mail && !(await sendMail(reminderEmail(user, origin, now)))) {
          console.error(`[trials] reminder to ${user.id} was not sent`);
        }
      }
    } catch (error) {
      console.error(`[trials] could not handle the trial of ${user.id}`, error);
    }
  }
  return result;
}

async function claim(userId: string, column: 'reminded_at' | 'ended_at', at: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE plan_trials SET ${column} = ? WHERE user_id = ? AND ${column} IS NULL AND ended_at IS NULL`,
  )
    .bind(at, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Emails                                                                      */
/* -------------------------------------------------------------------------- */

/** What the account's own plan includes, in a sentence's worth: "20 screenshots a month, 3 monitors checked weekly…". */
export function ownPlanSummary(user: Pick<SessionUser, 'ownPlan' | 'freeQuota'>): string {
  const plan = getPlan(user.ownPlan);
  const quota = plan.id === 'free' ? (user.freeQuota ?? plan.quota) : plan.quota;
  const monitors = WATCH_LIMIT[plan.id];
  return (
    `${quota.toLocaleString('en-US')} screenshots a month, ${monitors} ${monitors === 1 ? 'monitor' : 'monitors'} ` +
    `checked ${WATCH_FREQUENCIES[plan.id].join(' or ')} and ${plan.historyDays} days of capture history`
  );
}

/** The changes a trial's end makes, one line each; only the ones that apply to this account's own plan. */
function whatChanges(user: SessionUser): string[] {
  const own = getPlan(user.ownPlan);
  const trial = getPlan(user.trial!.plan);
  const lines = [
    `Monitors beyond the ${WATCH_LIMIT[own.id]} your plan includes, and schedules it does not include, are paused at their next check.`,
  ];
  if (trial.api && !own.api) lines.push('API keys stop working until the account is on Pro or Business. They are kept, not deleted.');
  if (own.historyDays < trial.historyDays) {
    lines.push(
      `Captures older than ${own.historyDays} days are deleted, as on every ${own.name} account, so download anything you want to keep.`,
    );
  }
  if (!own.formats.includes('pdf') && trial.formats.includes('pdf')) {
    lines.push(`PDF export and custom sizes are not included on ${own.name}.`);
  }
  return lines;
}

function reminderEmail(user: SessionUser, origin: string, now: Date) {
  const own = getPlan(user.ownPlan);
  const trial = user.trial!;
  const days = Math.max(1, Math.round((Date.parse(trial.endsAt) - now.getTime()) / 86_400_000));
  return {
    to: user.email,
    subject: `Your Pro trial ends in ${days} ${days === 1 ? 'day' : 'days'}`,
    text:
      `Your ${TRIAL_DAYS}-day Pro trial of Easy Screen Capture ends on ${formatDateTime(trial.endsAt)}.\n\n` +
      `After that your account goes back to ${own.name}: ${ownPlanSummary(user)}. ` +
      'Nothing is charged for the trial, and we never asked for a card.\n\n' +
      `When it ends:\n${whatChanges(user)
        .map((line) => `- ${line}`)
        .join('\n')}\n\n` +
      `To keep Pro, choose it here:\n${origin}/pricing#plan-pro`,
  };
}

function endedEmail(user: SessionUser, origin: string) {
  const own = getPlan(user.ownPlan);
  const trial = user.trial!;
  return {
    to: user.email,
    subject: 'Your Pro trial has ended',
    text:
      `Your ${TRIAL_DAYS}-day Pro trial ended on ${formatDate(trial.endsAt)}. Your account is back on ${own.name}: ` +
      `${ownPlanSummary(user)}. Nothing was charged for the trial.\n\n` +
      'Your captures, projects and monitors are still here. Screenshots already taken this month still count, ' +
      `so this month's ${own.name} allowance may already be used up.\n\n` +
      `${whatChanges(user)
        .map((line) => `- ${line}`)
        .join('\n')}\n\n` +
      `To keep Pro, choose it here:\n${origin}/pricing#plan-pro`,
  };
}

/* -------------------------------------------------------------------------- */
/* Account deletion                                                            */
/* -------------------------------------------------------------------------- */

/** What deleting an account removes here: its trial row. */
export async function trialCleanup(userId: string): Promise<D1PreparedStatement[]> {
  if (!(await trialsReady())) return [];
  return [env.DB.prepare(`DELETE FROM plan_trials WHERE user_id = ?`).bind(userId)];
}
