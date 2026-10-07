import { env } from 'cloudflare:workers';
import { PLAN_ORDER, getPlan, type PlanId } from './plans';

/**
 * Which plan a Pro trial gives an account, and whether migration 0019 has made
 * a table for trials yet.
 *
 * A trial never writes `users.plan`. While one runs the account acts on Pro
 * wherever a plan decides what it may do — the session user's `plan` says so,
 * decided once in toSessionUser — and billing and Apple keep reading and
 * writing the plan it actually has, `ownPlan`. Before the migration nobody has
 * a trial and every plan is exactly what it was.
 *
 * Kept apart from lib/trials.ts, which starts trials and sends their emails,
 * so auth and billing can read a trial without pulling those in.
 */

/** What a trial gives. */
export const TRIAL_PLAN: PlanId = 'pro';
export const TRIAL_DAYS = 14;
/** How long after a trial ends the app still says so, in notices and pause reasons. */
export const TRIAL_ENDED_NOTICE_DAYS = 30;

/** Cached per isolate like growthReady: a yes for good, a no for a minute. */
let trialTable: { ready: boolean; at: number } | undefined;
export async function trialsReady(): Promise<boolean> {
  if (trialTable && (trialTable.ready || Date.now() - trialTable.at < 60_000)) return trialTable.ready;
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='plan_trials'`).first<{
    n: number;
  }>();
  trialTable = { ready: row?.n === 1, at: Date.now() };
  return trialTable.ready;
}

/** For sign-in and pages that must not fail on a probe: an unreachable database reads as "not yet". */
export async function trialsAvailable(): Promise<boolean> {
  return trialsReady().catch(() => false);
}

export interface PlanTrial {
  plan: PlanId;
  startedAt: string;
  endsAt: string;
  /** Set once the trial has been closed: by the hourly sweep after it ended, or when the account paid for Pro or more. */
  endedAt: string | null;
  /** Running now: not closed, and not past its end. */
  active: boolean;
}

/** The columns a user row carries when it is read with trialColumns. */
export interface TrialColumns {
  trial_plan?: string | null;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  trial_ended_at?: string | null;
}

/**
 * What a query for a user row adds to read the account's trial alongside it:
 * a few columns and the join that supplies them. Nothing before the migration,
 * so the query is exactly what it was.
 */
export async function trialColumns(alias = 'u'): Promise<{ select: string; join: string }> {
  if (!(await trialsAvailable())) return { select: '', join: '' };
  return {
    select:
      ', t.plan AS trial_plan, t.started_at AS trial_started_at, t.ends_at AS trial_ends_at, t.ended_at AS trial_ended_at',
    join: ` LEFT JOIN plan_trials t ON t.user_id = ${alias}.id`,
  };
}

/** The trial on a row read with trialColumns, if the account ever started one. */
export function trialFrom(row: TrialColumns, now = new Date()): PlanTrial | undefined {
  if (!row.trial_started_at || !row.trial_ends_at) return undefined;
  const endedAt = row.trial_ended_at ?? null;
  return {
    plan: getPlan(row.trial_plan ?? TRIAL_PLAN).id,
    startedAt: row.trial_started_at,
    endsAt: row.trial_ends_at,
    endedAt,
    active: !endedAt && row.trial_ends_at > now.toISOString(),
  };
}

/** Whether a trial of `trial` would give an account on `own` anything: only a plan below it. */
export function trialRaises(own: PlanId, trial: PlanId = TRIAL_PLAN): boolean {
  return PLAN_ORDER.indexOf(own) < PLAN_ORDER.indexOf(trial);
}

/** The plan an account acts on: its own, or the trial's while one runs and its own is below it. */
export function effectivePlan(own: PlanId, trial: PlanTrial | undefined): PlanId {
  return trial?.active && trialRaises(own, trial.plan) ? trial.plan : own;
}

/**
 * The same decision in SQL, for queries over many accounts (retention) or
 * about someone other than the signed-in user (report branding). `now` is the
 * placeholder bound to the current ISO time; the Apple rule is toSessionUser's.
 */
export function planSql(alias: string, now: string, trials: boolean): string {
  const own = `(CASE WHEN ${alias}.plan = 'free' AND ${alias}.apple_expires_at > ${now} THEN 'lite' ELSE ${alias}.plan END)`;
  if (!trials) return own;
  const below = PLAN_ORDER.slice(0, PLAN_ORDER.indexOf(TRIAL_PLAN))
    .map((id) => `'${id}'`)
    .join(',');
  return `(CASE WHEN ${own} IN (${below}) AND EXISTS (SELECT 1 FROM plan_trials t WHERE t.user_id = ${alias}.id
            AND t.ended_at IS NULL AND t.ends_at > ${now}) THEN '${TRIAL_PLAN}' ELSE ${own} END)`;
}

/** Whole days left, counting a part day as one: "9 days left". */
export function trialDaysLeft(trial: Pick<PlanTrial, 'endsAt'>, now = new Date()): number {
  return Math.max(1, Math.ceil((Date.parse(trial.endsAt) - now.getTime()) / 86_400_000));
}

/** The trial is over, and the plan the account is back on is below the one it tried. */
export function trialEnded(user: { ownPlan: PlanId; trial?: PlanTrial }): boolean {
  return Boolean(user.trial && !user.trial.active && trialRaises(user.ownPlan, user.trial.plan));
}

/**
 * trialEnded, and recently enough to explain what changed: the notice in the
 * app and the reason a monitor was paused say so for a month.
 */
export function trialJustEnded(user: { ownPlan: PlanId; trial?: PlanTrial }, now = new Date()): boolean {
  if (!trialEnded(user)) return false;
  const ended = Math.min(Date.parse(user.trial!.endsAt), Date.parse(user.trial!.endedAt ?? user.trial!.endsAt));
  return now.getTime() - ended < TRIAL_ENDED_NOTICE_DAYS * 86_400_000;
}

/**
 * Closes a trial the account no longer needs, without the "ended" email:
 * called when it starts paying for a plan the trial does not raise. Nothing
 * before the migration, or once the trial is closed.
 */
export async function closeTrialForPayment(userId: string, plan: PlanId, now = new Date()): Promise<boolean> {
  if (trialRaises(plan) || !(await trialsAvailable())) return false;
  const result = await env.DB.prepare(`UPDATE plan_trials SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL`)
    .bind(now.toISOString(), userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
