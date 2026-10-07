import { drainPush, pushQueueStatements } from './push';
import { getMonitorRule, ruleKinds, saveMonitorRule, workflowsReady } from './monitor-rule-store';
import { evaluateRule, type MonitorRule } from './monitor-rules';
import {
  FAST_UNCHANGED,
  SAFETY_NET_MS,
  browserChanged,
  checkMethod,
  checkStatuses,
  fastCheckFor,
  fastCheckStatement,
  fastChecksReady,
  getFastCheck,
  nextFastCheck,
  readPage,
  readingMatches,
  resetFastCheck,
  saveFastCheck,
  seoNote,
  setForced,
  type CheckMethod,
  type CheckStatus,
  type CheckStep,
  type FastCheckRow,
} from './fast-checks';
import { BASELINE_REFRESHED, shouldRefreshBaseline } from './capture-engine';
import { watchSettingsReady, watchNoise, noiseStrings } from './watch-settings';
import { parseIgnoreRegions } from './ignore-regions';
import { decodeRunChanges, decodeRunDetail, encodeRunDetail, observeDelivery, type Delivery, type Schedule } from './monitor-health';
import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { loadSessionUser } from './auth';
import { createCaptureRow, fileUrl, getUsage, runCapture, safeParseFiles, type CaptureRow } from './captures';
import {
  assertPublicCaptureUrl,
  displayUrl,
  type CaptureMode,
  type CaptureOptions,
  type ViewportId,
} from './capture-options';
import { HttpError, badRequest } from './http';
import { prefixedId } from './ids';
import { canSendEmail, sendMail } from './mailer';
import { RULE_ONLY_FREQUENCY, allowedFrequencies, frequencyHours, frequencyLabel, getPlan, watchLimit } from './plans';
import { compareImages, diffAvailable, type DiffResult } from './visual-diff';
import { safeParseFacts, type PageFacts } from './page-facts';
import { diffText } from './text-diff';
import { summariseChange } from './summarise';
import { webhookBody, webhookFlavour } from './chat-webhook';
import { formatDate } from './dates';
import { highlightUrl, storeHighlight, type ChangeRegion } from './change-highlights';
import { PINNED_REPEAT, PIN_RELEASED, lastAlertWhilePinned, pinReady } from './baseline-pin';
import { trialJustEnded } from './trial-plan';

export interface WatchRow {
  id: string;
  user_id: string;
  label: string;
  url: string;
  host: string;
  device: string;
  width: number;
  height: number;
  scale: number;
  mode: string;
  format: string;
  frequency: string;
  threshold: number;
  notify_email: number;
  webhook_url: string | null;
  status: string;
  baseline_capture_id: string | null;
  last_run_at: string | null;
  next_run_at: string;
  last_changed_at: string | null;
  last_change_pct: number | null;
  last_error: string | null;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
  /**
   * When the owner pinned the baseline, or null while it follows the latest
   * check (see baseline-pin). Absent until migration 0014 adds the column.
   */
  baseline_pinned_at?: string | null;
}

export interface WatchRunRow {
  id: string;
  watch_id: string;
  user_id: string;
  capture_id: string | null;
  baseline_capture_id: string | null;
  status: string;
  changed: number;
  change_pct: number | null;
  detail: string | null;
  created_at: string;
}

/**
 * A watch that fails this many times in a row is paused.
 *
 * A page that has moved permanently would otherwise burn a capture from the
 * quota on every tick, for ever, and send nothing anyone can act on. Failures
 * of the service itself (see `temporaryFailure`) do not count.
 */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Watches handled per cron tick. Bounded so one busy hour cannot run long. */
const MAX_PER_TICK = 60;

/**
 * Watches rendering at the same time. Every render holds a browser, and an
 * unbounded burst would contend with the captures customers are waiting on;
 * strictly one at a time could not get through a busy hour. Fast checks that
 * find a change share these slots for the render they then need.
 */
const CONCURRENCY = 3;

/**
 * Fast checks per tick, and at once. One is a plain request and a little
 * parsing, with no browser, so a tick takes far more of them than of renders —
 * for as long as FAST_BUDGET_MS lasts, after which the rest wait for the next.
 */
const MAX_FAST_PER_TICK = 240;
const FAST_CONCURRENCY = 8;
const FAST_BUDGET_MS = 4 * 60_000;

const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;

/**
 * The start of the hour a moment falls in.
 *
 * The cron fires at hh:00 and selects next_run_at <= that instant. A schedule
 * computed from when a check ran — always some seconds or minutes past the
 * hour — missed that tick and waited for the next, so an hourly watch ran every
 * two hours and a daily one every 25. Every schedule lands on the hour instead.
 */
export function hourTick(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * The start of the quarter hour a moment falls in. 15-minute monitors land on
 * :00, :15, :30 and :45, the ticks the hourly and minute crons run them at,
 * for the reason hourTick gives.
 */
export function quarterTick(ms: number): number {
  return Math.floor(ms / QUARTER_MS) * QUARTER_MS;
}

/** The tick a schedule lands on. */
function tickFor(frequency: string): (ms: number) => number {
  return frequency === RULE_ONLY_FREQUENCY ? quarterTick : hourTick;
}

export function nextRunAt(frequency: string, from = new Date()): string {
  return new Date(tickFor(frequency)(from.getTime() + frequencyHours(frequency) * HOUR_MS)).toISOString();
}

/**
 * How far a claim moves next_run_at past the moment it was taken. Neither an
 * overlapping sweep nor a second "Check now" can take the same watch while it
 * is held, and a run that dies mid-way becomes due again once it lapses.
 */
const LEASE_MS = 20 * 60_000;

/** A claim is the only write that leaves next_run_at exactly LEASE_MS after updated_at. */
export function checkInProgress(row: Pick<WatchRow, 'next_run_at' | 'updated_at'>, now = Date.now()): boolean {
  const lease = Date.parse(row.next_run_at);
  return lease > now && lease - Date.parse(row.updated_at) === LEASE_MS;
}

function lease(now = new Date()) {
  return { at: now.toISOString(), until: new Date(now.getTime() + LEASE_MS).toISOString() };
}

export interface WatchDTO {
  id: string;
  label: string;
  url: string;
  display_url: string;
  device: string;
  viewport: { width: number; height: number; scale: number };
  mode: string;
  format: string;
  frequency: string;
  threshold: number;
  status: string;
  notify_email: boolean;
  webhook_url: string | null;
  last_run_at: string | null;
  next_run_at: string;
  last_changed_at: string | null;
  last_change_pct: number | null;
  last_error: string | null;
  created_at: string;
  baseline_capture_id: string | null;
  /** True while every check compares against one approved capture rather than the previous check. */
  baseline_pinned: boolean;
  baseline_pinned_at: string | null;
  /**
   * How checks run (fast-checks.ts): `fast` reads the page and renders only on
   * a change, `learning` does both while it finds out whether it can, `browser`
   * renders every time (with `check_reason` saying why), `forced` renders every
   * time by the owner's choice, and `visual` compares screenshots. Additive;
   * every API answer carries both (watchDTOs).
   */
  check_mode?: CheckStatus['mode'];
  check_reason?: string | null;
}

export function toWatchDTO(row: WatchRow, check?: CheckStatus): WatchDTO {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    display_url: displayUrl(row.url),
    device: row.device,
    viewport: { width: row.width, height: row.height, scale: row.scale },
    mode: row.mode,
    format: row.format,
    frequency: row.frequency,
    threshold: row.threshold,
    status: row.status,
    notify_email: Boolean(row.notify_email),
    webhook_url: row.webhook_url,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_changed_at: row.last_changed_at,
    last_change_pct: row.last_change_pct,
    last_error: row.last_error,
    created_at: row.created_at,
    baseline_capture_id: row.baseline_capture_id,
    baseline_pinned: Boolean(row.baseline_pinned_at),
    baseline_pinned_at: row.baseline_pinned_at ?? null,
    ...(check ? { check_mode: check.mode, check_reason: check.reason } : {}),
  };
}

/** How each monitor is checked, for a list of them. */
export async function watchChecks(rows: Pick<WatchRow, 'id'>[]): Promise<Map<string, CheckStatus>> {
  const ids = rows.map((row) => row.id);
  return checkStatuses(ids, await ruleKinds(ids));
}

/** Monitors as the API answers them: every field, how each is checked included. */
export async function watchDTOs(rows: WatchRow[]): Promise<WatchDTO[]> {
  const checks = await watchChecks(rows);
  return rows.map((row) => toWatchDTO(row, checks.get(row.id)));
}

export async function watchDTO(row: WatchRow): Promise<WatchDTO> {
  return (await watchDTOs([row]))[0]!;
}

/** What a check costs a monitor checked this way: learning soon becomes fast, so both count as on-change. */
export function checkCost(check: CheckStatus | undefined): 'check' | 'change' {
  return check?.mode === 'fast' || check?.mode === 'learning' ? 'change' : 'check';
}

/** Monitors as the schedule budget counts them (monitor-health forecast). */
export async function budgetSchedules(rows: WatchRow[]): Promise<Schedule[]> {
  const checks = await watchChecks(rows);
  return rows.map(({ id, frequency, status, next_run_at }) => ({
    id,
    frequency,
    status,
    next_run_at,
    cost: checkCost(checks.get(id)),
  }));
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export async function listWatches(userId: string): Promise<WatchRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all<WatchRow>();
  return results ?? [];
}

export async function getWatch(id: string): Promise<WatchRow | null> {
  return env.DB.prepare(`SELECT * FROM watches WHERE id = ?`).bind(id).first<WatchRow>();
}

export async function listRuns(
  watchId: string,
  limit = 30,
): Promise<Array<WatchRunRow & ReturnType<typeof decodeRunDetail> & ReturnType<typeof decodeRunChanges>>> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(watchId, limit)
    .all<WatchRunRow>();
  return (results ?? []).map((run) => ({ ...run, ...decodeRunDetail(run.detail), ...decodeRunChanges(run.detail) }));
}

export async function countWatches(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watches WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Creating and editing                                                        */
/* -------------------------------------------------------------------------- */

export interface WatchInput {
  options: CaptureOptions;
  rule?: MonitorRule;
  label: string;
  frequency: string;
  threshold: number;
  notifyEmail: boolean;
  webhookUrl: string | null;
}

/** Throws the reason this account may not have another watch, if there is one. */
export async function assertCanWatch(user: SessionUser, frequency: string): Promise<void> {
  const plan = getPlan(user.plan);
  const limit = watchLimit(user.plan);

  if (limit === 0) {
    throw new HttpError(
      403,
      'plan_required',
      'Watching pages is available on the paid plans. Upgrade to have a page checked for you.',
    );
  }

  const allowed = allowedFrequencies(user.plan);
  if (!allowed.includes(frequency as never)) {
    throw new HttpError(
      403,
      'plan_required',
      `Checks ${frequencyLabel(frequency).toLowerCase()} are not included on the ${plan.name} plan.`,
    );
  }

  if ((await countWatches(user.id)) >= limit) {
    throw new HttpError(
      403,
      'watch_limit',
      `The ${plan.name} plan covers ${limit} watched ${limit === 1 ? 'page' : 'pages'}. Delete one, or upgrade for more.`,
    );
  }
}

/**
 * Throws the reason a monitor may not be checked every 15 minutes, if there is
 * one. Only a monitor that reads its page first can afford it: a visual one,
 * or one that renders every check, would take 96 screenshots a day. Without
 * migration 0016 nothing reads first, so the schedule waits for it.
 */
export async function assertFrequencyFits(frequency: string, ruleKind: string, watchId?: string): Promise<void> {
  if (frequency !== RULE_ONLY_FREQUENCY) return;
  if (ruleKind === 'visual') {
    throw badRequest(
      'Checks every 15 minutes are for text, phrase, price, element and SEO rules. A visual monitor takes a screenshot on every check, so choose hourly or slower.',
      'frequency',
    );
  }
  if (!(await fastChecksReady())) {
    throw new HttpError(503, 'setup_required', 'Checks every 15 minutes are being set up. Choose hourly for now.', 'frequency');
  }
  const row = watchId ? await getFastCheck(watchId) : null;
  if (row?.forced) {
    throw badRequest('This monitor always uses a full browser, so it can be checked at most hourly.', 'frequency');
  }
  if (row?.mode === 'browser') {
    throw badRequest(
      'This page needs a full browser on every check, so it can be checked at most hourly. Try fast checks again first.',
      'frequency',
    );
  }
}

/**
 * Throws the reason a paused watch may not run again, if there is one. After a
 * downgrade an account can hold more watches than its plan runs, and resuming
 * one more would only see the sweep pause another.
 */
export async function assertCanResume(watch: WatchRow, user: SessionUser): Promise<void> {
  if (!allowedFrequencies(user.plan).includes(watch.frequency as never)) {
    throw new HttpError(403, 'plan_required', 'Choose a schedule included in your plan before resuming.');
  }
  const limit = watchLimit(user.plan);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watches WHERE user_id = ? AND status = 'active' AND id != ?`)
    .bind(user.id, watch.id)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) {
    throw new HttpError(
      403,
      'watch_limit',
      `The ${getPlan(user.plan).name} plan runs ${limit} ${limit === 1 ? 'monitor' : 'monitors'} at a time. Pause another one first, or upgrade for more.`,
    );
  }
}

/** A webhook destination, checked exactly as strictly as a page to capture. Empty means none. */
export function parseWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 2000 || !/^https:\/\/\S+$/i.test(value)) {
    throw badRequest('A webhook URL must start with https://.', 'webhook_url');
  }
  return assertPublicCaptureUrl(value).toString();
}

export async function createWatch(user: SessionUser, input: WatchInput): Promise<WatchRow> {
  await assertCanWatch(user, input.frequency);
  await assertFrequencyFits(input.frequency, input.rule?.kind ?? 'visual');
  const noise = noiseStrings(input.options);
  const noiseReady = await watchSettingsReady();
  if ((noise.hide || noise.ignore_regions) && !noiseReady)
    throw new HttpError(503, 'setup_required', 'Monitor noise controls are being prepared. Please try again later.');

  const now = new Date();
  const row: WatchRow = {
    id: prefixedId('wat', 12),
    user_id: user.id,
    label: input.label.slice(0, 80),
    url: input.options.url,
    host: input.options.host,
    device: input.options.device,
    width: input.options.width,
    height: input.options.height,
    scale: input.options.scale,
    mode: input.options.mode,
    format: input.options.format,
    frequency: input.frequency,
    threshold: input.threshold,
    notify_email: input.notifyEmail ? 1 : 0,
    webhook_url: input.webhookUrl,
    status: 'active',
    baseline_capture_id: null,
    last_run_at: null,
    // The first run is immediate: a watch with no baseline cannot report
    // anything, and waiting a week to take one reads as the feature being broken.
    next_run_at: now.toISOString(),
    last_changed_at: null,
    last_change_pct: null,
    last_error: null,
    consecutive_errors: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const insert = env.DB.prepare(
    `INSERT INTO watches (id, user_id, label, url, host, device, width, height, scale, mode, format,
                          frequency, threshold, notify_email, webhook_url, status, next_run_at,
                          created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(
    row.id,
    row.user_id,
    row.label,
    row.url,
    row.host,
    row.device,
    row.width,
    row.height,
    row.scale,
    row.mode,
    row.format,
    row.frequency,
    row.threshold,
    row.notify_email,
    row.webhook_url,
    row.next_run_at,
    row.created_at,
    row.updated_at,
  );
  const statements = [insert];
  if (noiseReady) statements.push(env.DB.prepare('INSERT INTO watch_settings VALUES(?,?,?)').bind(row.id, noise.hide, noise.ignore_regions));
  if (input.rule && await workflowsReady()) statements.push(env.DB.prepare('INSERT INTO monitor_rules VALUES(?,?,?,?,?)').bind(row.id,input.rule.kind,input.rule.phrase,input.rule.selector,input.rule.region));
  await env.DB.batch(statements);

  return row;
}

export async function setWatchStatus(id: string, status: 'active' | 'paused'): Promise<void> {
  const now = new Date();
  await env.DB.prepare(
    `UPDATE watches SET status = ?, updated_at = ?,
       next_run_at = CASE WHEN ? = 'active' THEN ? ELSE next_run_at END,
       consecutive_errors = CASE WHEN ? = 'active' THEN 0 ELSE consecutive_errors END
     WHERE id = ?`,
  )
    .bind(status, now.toISOString(), status, now.toISOString(), status, id)
    .run();
}

export async function setWatchFrequency(watch: WatchRow, user: SessionUser, frequency: string): Promise<void> {
  if (watch.user_id !== user.id || !allowedFrequencies(user.plan).includes(frequency as never)) {
    throw new HttpError(403, 'plan_required', 'Choose a check frequency included in your plan.');
  }
  await assertFrequencyFits(frequency, (await getMonitorRule(watch.id)).kind, watch.id);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE watches SET frequency = ?, updated_at = ?,
    next_run_at = CASE WHEN status = 'active' THEN ? ELSE next_run_at END WHERE id = ? AND user_id = ?`,
  )
    .bind(frequency, now, now, watch.id, user.id)
    .run();
}

/** Changing sensitivity keeps the existing baseline, schedule, and paused state. */
export async function setWatchThreshold(watch: WatchRow, user: SessionUser, raw: string): Promise<void> {
  if (watch.user_id !== user.id) throw new HttpError(404, 'not_found', 'No such watch.');
  const threshold = Number(raw);
  if (!raw.trim() || !Number.isFinite(threshold) || (threshold !== 0 && threshold < 0.1) || threshold > 100) {
    throw badRequest('Choose Any detected change (0), or a percentage between 0.1% and 100%.', 'threshold');
  }
  await env.DB.prepare('UPDATE watches SET threshold = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(threshold, new Date().toISOString(), watch.id, user.id).run();
}

/**
 * Where alerts go. A field left out of the body stays as it is; an empty
 * webhook URL removes the webhook. The URL is held to the same checks as at
 * creation, so editing cannot point a watch anywhere creating one could not.
 */
export async function setWatchAlerts(watch: WatchRow, user: SessionUser, body: Record<string, string>): Promise<void> {
  if (watch.user_id !== user.id) throw new HttpError(404, 'not_found', 'No such watch.');
  const notifyEmail =
    body.notify_email === undefined
      ? watch.notify_email
      : ['0', 'false', 'off'].includes(body.notify_email.trim().toLowerCase()) ? 0 : 1;
  const webhookUrl = body.webhook_url === undefined ? watch.webhook_url : parseWebhookUrl(body.webhook_url);
  await env.DB.prepare('UPDATE watches SET notify_email = ?, webhook_url = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(notifyEmail, webhookUrl, new Date().toISOString(), watch.id, user.id)
    .run();
}

/**
 * A new alert rule. A visual rule cannot run every 15 minutes, so that
 * schedule has to change first. A rule that watches something else starts
 * learning afresh: what the reading was trusted for no longer applies.
 */
export async function setWatchRule(watch: WatchRow, rule: MonitorRule): Promise<void> {
  if (watch.frequency === RULE_ONLY_FREQUENCY && rule.kind === 'visual') {
    throw badRequest(
      'A visual monitor takes a screenshot on every check, so it can be checked at most hourly. Choose another schedule first.',
      'rule_kind',
    );
  }
  const before = await getMonitorRule(watch.id);
  await saveMonitorRule(watch.id, rule);
  const watchesSame = before.kind === rule.kind && before.phrase === rule.phrase && before.selector === rule.selector;
  if (!watchesSame && (await fastChecksReady())) await resetFastCheck(watch.id);
}

async function assertFastChecks(watch: WatchRow, user: SessionUser): Promise<void> {
  if (watch.user_id !== user.id) throw new HttpError(404, 'not_found', 'No such watch.');
  if (!(await fastChecksReady())) throw new HttpError(503, 'setup_required', 'Smart checks are being set up. Please try again later.');
  if ((await getMonitorRule(watch.id)).kind === 'visual') {
    throw badRequest('A visual monitor compares screenshots, so every check uses a full browser.', 'action');
  }
}

/**
 * The owner's "Always use a full browser". A monitor checked every 15 minutes
 * moves to hourly with it, in the same write: every check is then a
 * screenshot, and 96 a day would drain any allowance.
 */
export async function setCheckMode(watch: WatchRow, user: SessionUser, forceBrowser: boolean): Promise<void> {
  await assertFastChecks(watch, user);
  await setForced(watch.id, forceBrowser);
  if (forceBrowser && watch.frequency === RULE_ONLY_FREQUENCY) await dropToHourly(watch);
}

/** "Try fast checks again": learning from nothing, as a new monitor does. */
export async function retryFastChecks(watch: WatchRow, user: SessionUser): Promise<void> {
  await assertFastChecks(watch, user);
  if ((await getFastCheck(watch.id))?.forced) {
    throw badRequest('This monitor is set to always use a full browser. Untick that option to use fast checks.', 'action');
  }
  await fastCheckFor(watch.id);
  await resetFastCheck(watch.id);
}

/**
 * Every 15 minutes becomes hourly. The next check stays when it was: at most
 * a quarter hour away, and the hourly sweep takes it at the top of the hour
 * either way. A claim in progress keeps its lease. True when it changed.
 */
async function dropToHourly(watch: Pick<WatchRow, 'id'>): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE watches SET frequency = 'hourly' WHERE id = ? AND frequency = ?`)
    .bind(watch.id, RULE_ONLY_FREQUENCY)
    .run();
  return Boolean(result.meta.changes);
}

export async function deleteWatch(id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM watch_runs WHERE watch_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM watches WHERE id = ?`).bind(id),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export async function dueWatches(now = new Date(), limit = MAX_PER_TICK, frequency?: string): Promise<WatchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM watches WHERE status = 'active' AND next_run_at <= ?${frequency ? ' AND frequency = ?' : ''}
     ORDER BY next_run_at ASC LIMIT ?`,
  )
    .bind(now.toISOString(), ...(frequency ? [frequency] : []), limit)
    .all<WatchRow>();
  return results ?? [];
}

/**
 * Takes a due watch for this sweep and returns it as it is now. Null when it
 * was paused, deleted, rescheduled or taken since the sweep listed it — the
 * list is a snapshot, and running from it would run what is no longer there.
 */
async function claimDue(id: string, tick: Date): Promise<WatchRow | null> {
  const { at, until } = lease();
  return env.DB.prepare(
    `UPDATE watches SET next_run_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND next_run_at <= ? RETURNING *`,
  )
    .bind(until, at, id, tick.toISOString())
    .first<WatchRow>();
}

/**
 * "Check now". Claimed like a scheduled run, so it cannot overlap one: a watch
 * the sweep is running is refused, and the sweep skips one being run here.
 */
export async function runWatchNow(watch: WatchRow, origin: string): Promise<WatchOutcome> {
  const busy = new HttpError(409, 'check_in_progress', 'This monitor is being checked right now. Try again in a minute.');
  const fresh = await getWatch(watch.id);
  if (!fresh || fresh.user_id !== watch.user_id) throw new HttpError(404, 'not_found', 'No such watch.');
  if (checkInProgress(fresh)) throw busy;
  const { at, until } = lease();
  // Compare-and-set on updated_at: any write since the read, a sweep's claim included, wins.
  const claimed = await env.DB.prepare(
    `UPDATE watches SET next_run_at = ?, updated_at = ? WHERE id = ? AND updated_at = ? RETURNING *`,
  )
    .bind(until, at, fresh.id, fresh.updated_at)
    .first<WatchRow>();
  if (!claimed) throw busy;
  return runWatch(claimed, origin);
}

function optionsFor(watch: WatchRow): CaptureOptions {
  return {
    url: watch.url,
    host: watch.host,
    device: watch.device as ViewportId,
    width: watch.width,
    height: watch.height,
    scale: watch.scale,
    mode: watch.mode as CaptureMode,
    format: watch.format as 'png' | 'jpg',
    fullPage: watch.mode === 'fullpage',
    delayMs: 0,
    // A page checked unattended should look the same every time. Ads are the
    // single largest source of pixels that differ for no reason worth an alert.
    blockAds: true,
    darkMode: false,
    quality: 90,
    maxFrames: 1,
    // Facts are on for a watch because they carry the page's visible text, and
    // the text is what lets an alert say what changed rather than only that
    // something did.
    facts: true,
    sizes: [],
    hide: [],
    blur: [],
    redactPii: false,
    actions: [],
    // A page that needs a consent click to be worth photographing needs it
    // every run, not just the one a person watched.
    dismissConsent: true,
    // Watches cannot carry credentials: storing them would mean keeping a
    // customer's session cookie at rest, which needs an encryption key and a
    // rotation story this does not have yet.
    auth: { headers: {}, cookies: [] },
    watermark: false,
  };
}

/**
 * A run row, inserted only while its watch still exists: a watch deleted
 * mid-check takes its history with it, and the insert must not fail the batch.
 */
function runStatement(run: Omit<WatchRunRow, 'id' | 'created_at'>, id = prefixedId('wrn', 10)) {
  return env.DB.prepare(
    `INSERT INTO watch_runs (id, watch_id, user_id, capture_id, baseline_capture_id, status, changed, change_pct, detail, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)`,
  ).bind(
    id,
    run.watch_id,
    run.user_id,
    run.capture_id,
    run.baseline_capture_id,
    run.status,
    run.changed,
    run.change_pct,
    run.detail,
    new Date().toISOString(),
    run.watch_id,
  );
}

export interface WatchOutcome {
  status: 'done' | 'error' | 'skipped';
  changed: boolean;
  changePct?: number;
  detail?: string;
}

/** What every step of one run needs to know. */
interface RunContext {
  watch: WatchRow;
  user: SessionUser;
  now: Date;
  origin: string;
}

/** What a sweep lends one run: a slot to render in, shared by every lane of the tick (see CONCURRENCY). */
export interface RunOptions {
  permit?: () => Promise<() => void>;
}

/**
 * Runs one watch: capture, compare against the previous run, alert if the page
 * moved by more than the threshold — or, for a rule-based monitor that can,
 * read the page first and do all that only when it changed (checkWatch).
 *
 * The row should be fresh — claimed by the sweep or by "Check now" — since
 * what it says about the baseline and errors is written back.
 *
 * Never throws. A cron tick handles many watches and one broken page must not
 * stop the rest.
 */
export async function runWatch(watch: WatchRow, origin: string, options: RunOptions = {}): Promise<WatchOutcome> {
  const now = new Date();

  // With its trial, if it has one: a trial that has ended reads as the plan it went back to.
  const user = await loadSessionUser(watch.user_id);
  if (!user) {
    // The account went away between the sweep and now.
    await deleteWatch(watch.id);
    return { status: 'skipped', changed: false, detail: 'account no longer exists' };
  }
  const run: RunContext = { watch, user, now, origin };

  // A plan downgrade should stop the watch running, not silently keep spending.
  // When it was a Pro trial that ended, the reason says so.
  const trialOver = trialJustEnded(user, now);
  const limit = watchLimit(user.plan);
  if (limit === 0 || !allowedFrequencies(user.plan).includes(watch.frequency as never)) {
    return pauseForPlan(
      run,
      trialOver
        ? `Paused: your Pro trial ended; checks ${frequencyLabel(watch.frequency).toLowerCase()} are not included on your plan.`
        : 'This monitoring schedule is not included on your current plan.',
      'current schedule is not included in this plan',
    );
  }
  // The oldest `limit` watches keep running; the ones beyond it pause.
  if ((await activeAhead(watch)) >= limit) {
    const monitors = `${limit} ${limit === 1 ? 'monitor' : 'monitors'}`;
    return pauseForPlan(
      run,
      trialOver ? `Paused: your Pro trial ended; your plan includes ${monitors}.` : `Paused: your plan includes ${monitors}.`,
      'monitor limit for this plan reached',
    );
  }

  // Without the browser binding there is nothing to compare with, and a capture
  // taken anyway would be spent on a picture no check can use.
  if (!diffAvailable()) {
    return failed(run, 'Comparison unavailable: rendering service is not configured.', { temporary: true });
  }

  return checkWatch(run, await getMonitorRule(watch.id), options);
}

/**
 * How this check runs (fast-checks.ts), and running it. A visual monitor, and
 * every monitor until migration 0016 exists, takes the full check alone,
 * exactly as before. A rule-based one reads its page first unless it renders
 * every check; then the full check runs when the reading found a change, could
 * not be taken, or the monitor is still learning or due its weekly full check.
 * Only the full check ever decides an alert.
 */
async function checkWatch(run: RunContext, rule: MonitorRule, options: RunOptions): Promise<WatchOutcome> {
  const { watch, user, now } = run;
  const render = async (extras: FullCheckExtras = {}) => {
    const release = await options.permit?.();
    try {
      return await fullCheck(run, rule, extras);
    } finally {
      release?.();
    }
  };
  if (rule.kind === 'visual' || !(await fastChecksReady())) return render();

  // Whatever cannot be read here leaves the check as it always was.
  const [row, noise] = await Promise.all([
    fastCheckFor(watch.id, now).catch(() => null),
    watchNoise(watch.id).catch(() => null),
  ]);
  if (!row || !noise) return render();
  const hide = noise.hide.split(',').filter(Boolean);
  let method: CheckMethod = checkMethod(row, Boolean(watch.baseline_capture_id), now);

  if (method === 'browser') {
    // An SEO monitor's notes compare the page's HTML with what renders; the owner's own choice of the browser skips even that.
    const read = rule.kind === 'seo' && !row.forced ? await readPage(watch, rule, hide) : null;
    return render({ noise, note: (capture) => seoNote(rule, read, safeParseFacts(capture.facts)) });
  }
  if (method === 'learning' && (await getUsage(user)).remaining <= 0) return quotaSkip(run);
  // Out of screenshots, a fast monitor's weekly full check waits for them; its reading goes on.
  if (method === 'safety' && row.signature && watch.baseline_capture_id && (await getUsage(user)).remaining <= 0) method = 'gate';

  const read = await readPage(watch, rule, hide);
  if (method === 'gate' && read.ok && read.signature === row.signature) return unchangedRun(run, rule, row);

  // Taken before the full check records its own run.
  const before = await lastRenderedFacts(watch.id);
  const extras: FullCheckExtras = {
    noise,
    spotted: method === 'gate' && read.ok,
    note: (capture) => seoNote(rule, read, safeParseFacts(capture.facts)),
  };
  const outcome = await render(extras);
  if (extras.quota && extras.spotted) {
    await learn(run, rule, row, { kind: 'spotted' });
  } else if (extras.capture) {
    const after = safeParseFacts(extras.capture.facts);
    await learn(run, rule, row, {
      kind: 'rendered',
      method,
      read,
      changed: extras.fresh ? null : browserChanged(rule, before, after),
      matches: read.ok ? readingMatches(rule, read, after) : null,
    });
  }
  return outcome;
}

/** Records what one check taught a monitor's fast check, and tells the owner when it moved to the browser. */
async function learn(run: RunContext, rule: MonitorRule, row: FastCheckRow, step: CheckStep): Promise<void> {
  const decision = nextFastCheck(row, step, rule, new Date());
  const saved = await saveFastCheck(decision.row, row.updated_at).catch((error) => {
    console.error(`[watch] ${run.watch.id} fast check state not saved`, error);
    return false;
  });
  if (saved && decision.toBrowser) await movedToBrowser(run, decision.toBrowser);
}

/**
 * A monitor whose page needs the browser on every check. Every 15 minutes
 * would then be 96 screenshots a day, so such a monitor moves to hourly. Sent
 * once: the move is a compare-and-set, and only the check that made it gets here.
 */
async function movedToBrowser(run: RunContext, reason: string): Promise<void> {
  const { watch, user, origin } = run;
  const hourly = await dropToHourly(watch);
  const name = watchName(watch);
  await tellOwner(
    user,
    `Monitor now uses a full browser: ${name}`.slice(0, 120),
    `${name} is now checked in a full browser every time, so each check uses one screenshot.\n\n` +
      `Why: ${reason}.\n\n` +
      (hourly
        ? 'It was checked every 15 minutes. With a screenshot on every check that would be 96 a day, so it now runs every hour.\n\n'
        : '') +
      `If the page changes how it is built, you can try fast checks again here:\n${origin}/app/watches/${watch.id}`,
  );
}

/**
 * A fast check that read nothing new: recorded like any check, against the
 * baseline it still has, with no capture and nothing spent. With a baseline,
 * `changed` 0 and no `change_pct`, the iOS app titles it "Check completed".
 *
 * consecutive_errors is left as it is: a reading neither counts toward the
 * auto-pause nor excuses a page whose renders keep failing.
 */
async function unchangedRun(run: RunContext, rule: MonitorRule, row: FastCheckRow): Promise<WatchOutcome> {
  const { watch, now } = run;
  const at = now.toISOString();
  const statements = [
    env.DB.prepare(`UPDATE watches SET last_run_at = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
      .bind(at, nextRunAt(watch.frequency, now), at, watch.id),
    runStatement({
      watch_id: watch.id,
      user_id: watch.user_id,
      capture_id: null,
      baseline_capture_id: watch.baseline_capture_id,
      status: 'done',
      changed: 0,
      change_pct: null,
      detail: encodeRunDetail(FAST_UNCHANGED, { email: 'not_needed', webhook: 'not_needed' }),
    }),
  ];
  // Only when there is something to reset: most fast checks write nothing here.
  if (row.noise || row.unavailable) {
    statements.push(fastCheckStatement(nextFastCheck(row, { kind: 'unchanged' }, rule, now).row, row.updated_at));
  }
  const [moved] = await env.DB.batch(statements);
  if (!moved?.meta.changes) return { status: 'skipped', changed: false, detail: 'the monitor was deleted during the check' };
  return { status: 'done', changed: false, detail: FAST_UNCHANGED };
}

/** The facts of the capture this monitor's last full check took: what this check's are compared with. */
async function lastRenderedFacts(watchId: string): Promise<PageFacts | null> {
  const row = await env.DB.prepare(
    `SELECT facts FROM captures WHERE id = (
       SELECT capture_id FROM watch_runs WHERE watch_id = ? AND status = 'done' AND capture_id IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  )
    .bind(watchId)
    .first<{ facts: string | null }>();
  return safeParseFacts(row?.facts ?? null);
}

/** What a full check is lent, and what it reports back about itself. */
interface FullCheckExtras {
  /** The monitor's noise settings, when the caller has read them already. */
  noise?: { hide: string; ignore_regions: string };
  /** A fast check spotted a change; out of screenshots, the skip says so. */
  spotted?: boolean;
  /** A line for the run history that never alerts (seoNote). */
  note?: (capture: CaptureRow) => string | null;
  /** Set when the check was skipped for want of screenshots. */
  quota?: boolean;
  /** Set when the check compared and recorded its run: the capture it took. */
  capture?: CaptureRow;
  /** Set with `capture` when there was nothing to compare with: a first baseline, or one an engine update replaced. */
  fresh?: boolean;
}

/**
 * The check a monitor has always run: capture, compare with the baseline,
 * record, alert. Every alert comes from here.
 */
async function fullCheck(run: RunContext, rule: MonitorRule, extras: FullCheckExtras = {}): Promise<WatchOutcome> {
  const { watch, user, origin } = run;
  const now = run.now;

  const usage = await getUsage(user);
  if (usage.remaining <= 0) {
    extras.quota = true;
    return quotaSkip(run, extras.spotted);
  }

  let capture: CaptureRow;
  try {
    const noise = extras.noise ?? (await watchNoise(watch.id));
    const options = {
      ...optionsFor(watch),
      // An SEO rule keeps its signal list in `selector`; only element rules name an element there.
      monitorSelector: (rule.kind === 'price' || rule.kind === 'element') && rule.selector ? rule.selector : undefined,
      monitorPhrases: (rule.kind === 'appeared' || rule.kind === 'disappeared') && rule.phrase ? [rule.phrase] : undefined,
      monitorSeo: rule.kind === 'seo',
      hide: noise.hide.split(',').filter(Boolean),
      ignoreRegions: parseIgnoreRegions(noise.ignore_regions),
    };
    const row = await createCaptureRow(user, options, 'watch');
    capture = await runCapture(row, options);
  } catch (error) {
    // Another capture spent the last of the quota since it was read.
    if (errorType(error) === 'quota_exceeded') {
      extras.quota = true;
      return quotaSkip(run, extras.spotted);
    }
    return failed(run, error instanceof Error ? error.message : String(error), { temporary: temporaryFailure(error) });
  }

  if (capture.status !== 'done') {
    return failed(run, capture.error ?? 'the capture failed', { temporary: temporaryFailure(capture.error) });
  }

  // First run: nothing to compare against yet, so this becomes the baseline.
  const baseline = watch.baseline_capture_id ? await captureById(watch.baseline_capture_id) : null;
  /*
   * A baseline an older capture engine took differs from this capture because
   * of the engine. It is replaced the way a first check saves one: no
   * comparison, no alert, and a run that says why.
   */
  const refresh = Boolean(baseline && shouldRefreshBaseline(baseline));

  // A pinned baseline is compared against every check and replaced by none (see
  // baseline-pin). A row read with `*` carries the column once it exists, which
  // no probe cached a minute ago can contradict.
  const pins = watch.baseline_pinned_at !== undefined || (await pinReady());
  const pinned = pins && Boolean(watch.baseline_pinned_at) && Boolean(baseline);
  const alertedId = pinned ? await lastAlertWhilePinned(watch) : null;
  const lastAlerted = alertedId ? await captureById(alertedId) : null;

  let changed = false;
  let changePct: number | null = null;
  let detail: string | null = null;
  let visual: (DiffResult & { previous?: DiffResult }) | null = null;

  if (!baseline) {
    detail = 'first check — saved as the baseline';
  } else if (refresh) {
    // A pin on a capture the engine has moved past cannot stand: comparing with
    // it reports the engine, and keeping the new capture pinned instead would
    // approve a version nobody looked at. So the pin is released, and said so.
    detail = pinned ? `${BASELINE_REFRESHED}. ${PIN_RELEASED}` : BASELINE_REFRESHED;
  } else if (rule.kind !== 'visual') {
    try {
      const result = evaluateRule(rule, safeParseFacts(baseline.facts), safeParseFacts(capture.facts));
      changed = result.changed; detail = result.detail;
    } catch (error) {
      return failed(run, error instanceof Error ? error.message : 'Rule comparison failed.', { captureId: capture.id });
    }
  } else {
    const before = firstFileUrl(baseline, origin);
    const after = firstFileUrl(capture, origin);
    if (!before || !after) {
      return failed(run, 'Comparison unavailable: a capture has no comparable image.', { captureId: capture.id });
    }
    let diff: DiffResult & { previous?: DiffResult };
    try {
      const region = parseIgnoreRegions(rule.region)[0];
      const scaled = region ? { x: region.x * watch.scale, y: region.y * watch.scale, width: region.width * watch.scale, height: region.height * watch.scale } : undefined;
      const previous = lastAlerted ? firstFileUrl(lastAlerted, origin) ?? undefined : undefined;
      diff = await compareImages(before, after, scaled, { highlight: watch.threshold, previous });
    } catch (error) {
      // Preserve the last good baseline so the next successful check can still detect the change.
      const message = error instanceof Error ? error.message : '';
      // A region that does not fit or does not parse is the watch's configuration, and counts.
      if (/outside the captured page/i.test(message)) {
        return failed(run, 'The watched region is outside the captured page. Adjust the alert rule.', { captureId: capture.id });
      }
      if (errorType(error) === 'invalid_request') return failed(run, message, { captureId: capture.id });
      // The comparison browser, not the page: back off rather than count it.
      return failed(run, 'Comparison failed. The previous baseline has been kept.', { captureId: capture.id, temporary: true });
    }
    changePct = diff.changedPct;
    // "Any detected change" (0) alerts on a single pixel or any resize; a
    // percentage threshold weighs a resize by the area it added or removed.
    changed = watch.threshold === 0 ? diff.changedPixels > 0 || diff.resized : diff.changedPct >= watch.threshold;
    detail = visualDetail(diff, watch.threshold, changed);
    visual = diff;
  }

  // Pinned, a page that moved away from the baseline differs from it on every
  // check after; only one that moved again since the last alert is news.
  let repeat = false;
  if (changed && lastAlerted && !movedSinceAlert(rule, watch.threshold, lastAlerted, capture, visual)) {
    repeat = true;
    changed = false;
    detail = `${detail ?? ''} ${PINNED_REPEAT}`.trim();
  }
  const highlighted = visual?.highlight ? await storeHighlight(capture, visual.highlight) : false;
  const changes = { regions: visual?.regions ?? [], highlight: highlighted, pinned, repeat };
  // The history shows the note; the alert says only what the rule found.
  const note = extras.note?.(capture);
  const recorded = note && detail ? `${detail.replace(/([^.!?])$/, '$1.')} ${note}` : (note ?? detail);

  const runId = prefixedId('wrn', 10);
  const alerting = changed && Boolean(baseline);
  const retries = alerting && (await workflowsReady());
  const push = alerting ? await pushQueueStatements(runId, watch.user_id).catch(() => []) : [];
  const delivery: Delivery = changed
    ? { email: watch.notify_email ? 'pending' : 'disabled', webhook: watch.webhook_url ? 'pending' : 'disabled' }
    : { email: 'not_needed', webhook: 'not_needed' };

  /*
   * One batch, so the baseline only moves together with the run that records
   * the change and the jobs that will announce it. Before, a crash between the
   * baseline moving and the alert being queued lost the alert for good: the
   * next check compared against the new baseline and saw nothing.
   *
   * A pinned baseline stays, decided by the row as it is at the write, so a pin
   * or unpin made during the check holds. A pin whose capture is gone is let go.
   */
  const baselineSet = !pins
    ? 'baseline_capture_id = ?'
    : (watch.baseline_pinned_at && !baseline) || refresh
      ? 'baseline_capture_id = ?, baseline_pinned_at = NULL'
      : 'baseline_capture_id = CASE WHEN baseline_pinned_at IS NULL THEN ? ELSE baseline_capture_id END';
  const [moved] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE watches SET ${baselineSet}, last_run_at = ?, next_run_at = ?, last_error = NULL,
         consecutive_errors = 0, updated_at = ?,
         last_changed_at = CASE WHEN ? = 1 THEN ? ELSE last_changed_at END,
         last_change_pct = ?
       WHERE id = ?`,
    ).bind(
      capture.id,
      now.toISOString(),
      nextRunAt(watch.frequency, now),
      now.toISOString(),
      changed ? 1 : 0,
      now.toISOString(),
      changePct,
      watch.id,
    ),
    runStatement(
      {
        watch_id: watch.id,
        user_id: watch.user_id,
        capture_id: capture.id,
        baseline_capture_id: refresh ? null : baseline?.id ?? null,
        status: 'done',
        changed: changed ? 1 : 0,
        change_pct: changePct,
        detail: encodeRunDetail(recorded, delivery, changes),
      },
      runId,
    ),
    // Due next hour, so a crash before delivery below is picked up by the retry sweep.
    ...(retries
      ? [
          env.DB.prepare(
            `INSERT INTO alert_retries (run_id, attempts, next_attempt_at, status, updated_at)
             SELECT ?, 0, ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM watch_runs WHERE id = ?)`,
          ).bind(runId, new Date(hourTick(Date.now() + HOUR_MS)).toISOString(), now.toISOString(), runId),
        ]
      : []),
    ...push,
  ]);
  if (!moved?.meta.changes) return { status: 'skipped', changed: false, detail: 'the monitor was deleted during the check' };
  extras.capture = capture;
  extras.fresh = !baseline || refresh;

  if (alerting && baseline) {
    // A push outage must not mark a successful comparison failed or block email.
    if (push.length) {
      try { await drainPush(runId); }
      catch { console.error('[push] delivery failed'); }
    }
    const sent = await notify(
      watch,
      user,
      baseline,
      capture,
      changePct ?? 0,
      origin,
      delivery,
      { kind: rule.kind, detail },
      async () => {
        await env.DB.prepare('UPDATE watch_runs SET detail = ? WHERE id = ? AND user_id = ?')
          .bind(encodeRunDetail(recorded, delivery, changes), runId, watch.user_id)
          .run();
      },
      // Claimed exactly as a retry is, and only once there is something to
      // send: a crash before this is retried next hour, one after it is
      // ambiguous and never sent twice.
      retries ? () => claimRetry(runId) : undefined,
      { regions: changes.regions, highlightUrl: highlighted ? highlightUrl(capture, origin) : null, pinned },
    );
    if (sent && retries) await finishRetry(runId, delivery, 1);
  }

  return { status: 'done', changed, changePct: changePct ?? undefined, detail: recorded ?? undefined };
}

/**
 * Whether a check that differs from its pinned baseline also differs from the
 * version last alerted about, by the same rule and threshold. Whatever cannot
 * be told counts as moved: a second alert is better than a missed one.
 */
function movedSinceAlert(
  rule: MonitorRule,
  threshold: number,
  alerted: CaptureRow,
  capture: CaptureRow,
  visual: (DiffResult & { previous?: DiffResult }) | null,
): boolean {
  if (rule.kind !== 'visual') {
    try {
      return evaluateRule(rule, safeParseFacts(alerted.facts), safeParseFacts(capture.facts)).changed;
    } catch {
      return true;
    }
  }
  const previous = visual?.previous;
  if (!previous) return true;
  return threshold === 0 ? previous.changedPixels > 0 || previous.resized : previous.changedPct >= threshold;
}

/** The run history line for a visual comparison, naming the sensitivity it used. */
function visualDetail(diff: DiffResult, threshold: number, changed: boolean): string {
  const pct = changed && diff.changedPct === 0 ? '<0.01' : String(diff.changedPct);
  const verdict = threshold === 0
    ? 'Any detected change was enabled for this check.'
    : `${changed ? 'Met' : 'Below'} the ${threshold}% threshold used for this check.`;
  if (diff.resized) {
    return `Page dimensions changed · ${pct}% of the page differs, counting area only one version has (${diff.sharedPct}% of the shared area). ${verdict}`;
  }
  if (threshold === 0) {
    return changed ? `${pct}% changed · ${verdict}` : `No visual change detected · ${verdict}`;
  }
  return `${diff.changedPct}% changed · ${verdict}`;
}

async function captureById(id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT * FROM captures WHERE id = ? AND status = 'done'`).bind(id).first<CaptureRow>();
}

function firstFileUrl(row: CaptureRow, origin: string): string | null {
  const file = safeParseFiles(row.files)[0];
  return file ? fileUrl(row, file, origin) : null;
}

function watchName(watch: WatchRow): string {
  return watch.label || displayUrl(watch.url);
}

/** Active watches on the account created before this one. */
async function activeAhead(watch: WatchRow): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM watches WHERE user_id = ? AND status = 'active' AND id != ?
       AND (created_at < ? OR (created_at = ? AND id < ?))`,
  )
    .bind(watch.user_id, watch.id, watch.created_at, watch.created_at, watch.id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function pauseForPlan(run: RunContext, reason: string, detail: string): Promise<WatchOutcome> {
  const { watch, now } = run;
  await env.DB.batch([
    // next_run_at is reset so the claim's lease is released; resuming schedules it afresh.
    env.DB.prepare(`UPDATE watches SET status = 'paused', last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .bind(reason.slice(0, 300), nextRunAt(watch.frequency, now), now.toISOString(), watch.id),
    runStatement({
      watch_id: watch.id,
      user_id: watch.user_id,
      capture_id: null,
      baseline_capture_id: watch.baseline_capture_id,
      status: 'skipped',
      changed: 0,
      change_pct: null,
      detail,
    }),
  ]);
  return { status: 'skipped', changed: false, detail };
}

const QUOTA_SKIP = 'monthly quota used up';
const FIRST_QUOTA_SKIP = `${QUOTA_SKIP} · first skip this month`;
/** A fast check read a change with no screenshot left to confirm it. Its signature stays, so the change is read again. */
const SPOTTED_SKIP =
  'Change spotted, but no screenshots are left this month to confirm it; it is checked again after your allowance renews';
const FIRST_SPOTTED_SKIP = `${SPOTTED_SKIP} · first skip this month`;

/**
 * Out of quota is not a failure of the watch, so it never counts toward the
 * error budget. Nor should it push a weekly watch back a week: it tries again
 * the next day, or when the allowance renews if that is sooner, and never
 * later than its own schedule — nor sooner than the next hour, or a 15-minute
 * monitor would record a skip every quarter hour.
 *
 * `spotted` is a fast check that read a change it could not confirm. Its skip
 * says so, and shares the one notice a month with every other skip.
 */
async function quotaSkip(run: RunContext, spotted = false): Promise<WatchOutcome> {
  const { watch, user, now, origin } = run;
  // Allowances renew at the start of each UTC month, as getUsage counts them.
  const renews = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const soonest = hourTick(now.getTime() + HOUR_MS);
  const retry = Math.max(soonest, Math.min(renews, hourTick(now.getTime() + 24 * HOUR_MS)));
  const next = new Date(Math.max(soonest, Math.min(Date.parse(nextRunAt(watch.frequency, now)), retry))).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [plain, first] = spotted ? [SPOTTED_SKIP, FIRST_SPOTTED_SKIP] : [QUOTA_SKIP, FIRST_QUOTA_SKIP];
  const runId = prefixedId('wrn', 10);
  /*
   * One notice per account per month. The run row decides it as it is
   * inserted — D1 applies writes one at a time, so of several watches skipping
   * at once exactly one finds no earlier skip this month and is marked first.
   */
  await env.DB.batch([
    env.DB.prepare(`UPDATE watches SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now.toISOString(), next, now.toISOString(), watch.id),
    env.DB.prepare(
      `INSERT INTO watch_runs (id, watch_id, user_id, capture_id, baseline_capture_id, status, changed, change_pct, detail, created_at)
       SELECT ?, ?, ?, NULL, ?, 'skipped', 0, NULL,
              CASE WHEN EXISTS (SELECT 1 FROM watch_runs WHERE user_id = ? AND status = 'skipped'
                                  AND detail IN (?, ?, ?, ?) AND created_at >= ?) THEN ? ELSE ? END, ?
       WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)`,
    ).bind(
      runId,
      watch.id,
      watch.user_id,
      watch.baseline_capture_id,
      watch.user_id,
      QUOTA_SKIP,
      FIRST_QUOTA_SKIP,
      SPOTTED_SKIP,
      FIRST_SPOTTED_SKIP,
      monthStart,
      plain,
      first,
      new Date().toISOString(),
      watch.id,
    ),
  ]);

  const recorded = await env.DB.prepare(`SELECT detail FROM watch_runs WHERE id = ?`).bind(runId).first<{ detail: string }>();
  if (recorded?.detail === first) {
    await tellOwner(
      user,
      'Monitor checks paused: screenshot allowance used up',
      `You have used all the screenshots in your plan this month, so scheduled monitor checks are being skipped.\n\n` +
        (spotted
          ? `${watchName(watch)} has changed, and confirming it takes a screenshot. It is checked again once you have screenshots.\n\n`
          : '') +
        `They start again on their own when your allowance renews on ${formatDate(renews)}. ` +
        `To keep monitoring before then, upgrade your plan:\n${origin}/app/upgrade\n\n` +
        `Your monitors, baselines and history are unchanged.`,
    );
  }
  return { status: 'skipped', changed: false, detail: plain };
}

/**
 * Failures of the service rather than of the page: the browser pool is full,
 * rendering is not configured or is rate limited, the network blinked. None
 * says anything about the watched page, so none counts toward the auto-pause.
 */
const TEMPORARY_FAILURE =
  /browser sessions are in use|no rendering backend|browser rendering api responded (?:429|5\d\d)|unable to create new browser|time limit exceeded|too many (?:browsers|requests)|rate limit|network connection lost/i;

function temporaryFailure(error: unknown): boolean {
  if (['browser_unavailable', 'renderer_unavailable'].includes(errorType(error))) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TEMPORARY_FAILURE.test(message);
}

/** An HttpError's `type`, read by shape so errors from any copy of the class are recognised. */
function errorType(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { type?: unknown }).type === 'string'
    ? (error as { type: string }).type
    : '';
}

/** Marks a temporary failure in the run history, which is also what the backoff counts. */
const TEMPORARY = 'Temporarily unavailable: ';

/**
 * When a temporarily failing watch tries again: the next hour, then twice as
 * long after each temporary failure in a row, never later than its schedule —
 * so a 15-minute monitor simply tries again at the next quarter hour.
 */
async function backoff(watch: WatchRow, now: Date): Promise<string> {
  const { results } = await env.DB.prepare(
    // rowid breaks ties in insertion order; run ids are random.
    `SELECT status, detail FROM watch_runs WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 8`,
  )
    .bind(watch.id)
    .all<{ status: string; detail: string | null }>();
  let streak = 0;
  for (const row of results ?? []) {
    if (row.status !== 'error' || !row.detail?.startsWith(TEMPORARY)) break;
    streak++;
  }
  const hours = Math.min(frequencyHours(watch.frequency), 2 ** streak);
  return new Date(tickFor(watch.frequency)(now.getTime() + hours * HOUR_MS)).toISOString();
}

async function failed(
  run: RunContext,
  message: string,
  options: { captureId?: string | null; temporary?: boolean } = {},
): Promise<WatchOutcome> {
  const { watch, user, now, origin } = run;
  const at = now.toISOString();
  const record = (detail: string) =>
    runStatement({
      watch_id: watch.id,
      user_id: watch.user_id,
      capture_id: options.captureId ?? null,
      baseline_capture_id: watch.baseline_capture_id,
      status: 'error',
      changed: 0,
      change_pct: null,
      detail,
    });

  if (options.temporary) {
    const detail = `${TEMPORARY}${message}`.slice(0, 300);
    await env.DB.batch([
      env.DB.prepare(`UPDATE watches SET last_run_at = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .bind(at, await backoff(watch, now), detail, at, watch.id),
      record(detail),
    ]);
    return { status: 'error', changed: false, detail };
  }

  const reason = message.slice(0, 300);
  const [paused] = await env.DB.batch([
    // Read against the count before this failure, and never against a status
    // the run started with: a watch paused or resumed meanwhile keeps that.
    env.DB.prepare(`UPDATE watches SET status = 'paused' WHERE id = ? AND status = 'active' AND consecutive_errors + 1 >= ?`)
      .bind(watch.id, MAX_CONSECUTIVE_ERRORS),
    env.DB.prepare(
      `UPDATE watches SET last_run_at = ?, next_run_at = ?, last_error = ?, consecutive_errors = consecutive_errors + 1,
         updated_at = ? WHERE id = ?`,
    ).bind(at, nextRunAt(watch.frequency, now), reason, at, watch.id),
    record(reason),
  ]);

  if (paused?.meta.changes) {
    const name = watchName(watch);
    await tellOwner(
      user,
      `Monitor paused: ${name}`.slice(0, 120),
      `${name} failed ${MAX_CONSECUTIVE_ERRORS} checks in a row, so it has been paused and is no longer using your screenshots.\n\n` +
        `Last error: ${reason}\n\n` +
        `Check that the page still loads, then resume the monitor here:\n${origin}/app/watches/${watch.id}`,
    );
  }

  return { status: 'error', changed: false, detail: message };
}

/** An account notice. Best effort: a notice that cannot be sent changes nothing the check recorded. */
async function tellOwner(user: SessionUser, subject: string, text: string): Promise<void> {
  if (!canSendEmail()) return;
  await observeDelivery(() => sendMail({ to: user.email, subject, text }));
}

/* -------------------------------------------------------------------------- */
/* Alerts                                                                      */
/* -------------------------------------------------------------------------- */

/** Where the picture changed, for an alert to point at. Empty for text rules and older runs. */
interface AlertChanges {
  regions: ChangeRegion[];
  highlightUrl: string | null;
  pinned: boolean;
}

async function notify(
  watch: WatchRow,
  user: SessionUser,
  before: CaptureRow,
  after: CaptureRow,
  changePct: number,
  origin: string,
  delivery: Delivery,
  rule: { kind: string; detail: string | null },
  saveDelivery: () => Promise<void>,
  claim?: () => Promise<boolean>,
  changes: AlertChanges = { regions: [], highlightUrl: null, pinned: false },
): Promise<boolean> {
  const name = watchName(watch);
  const link = `${origin}/app/watches/${watch.id}`;
  // A text, phrase, price or element rule says what it found; that is the news.
  const finding = rule.kind !== 'visual' && rule.detail ? rule.detail : '';

  /*
   * The percentage says a page moved. It cannot say a price went from $19 to
   * $29, which is the thing anyone actually wants from an alert — so the text
   * captured with each run is diffed and, where a model is available,
   * summarised into one sentence.
   */
  const change = diffText(safeParseFacts(before.facts)?.text ?? '', safeParseFacts(after.facts)?.text ?? '');
  const summary = await summariseChange(change, name).catch(() => ({ sentence: '', detail: '' }));
  if (claim && !(await claim())) return false;

  if (watch.notify_email && ['pending','failed','not_configured'].includes(delivery.email)) {
    const headline = summary.sentence ? `${summary.sentence}\n\n` : '';
    const body = summary.detail ? `${summary.detail}\n\n` : '';
    const lead = finding || summary.sentence;
    delivery.email = canSendEmail()
      ? await observeDelivery(() =>
          sendMail({
            to: user.email,
            subject: lead ? `${name}: ${lead.slice(0, 80)}` : `${name} changed`,
            text:
              `${name}: ${finding || 'a monitored change was detected.'}\n\n` +
              headline +
              body +
              (changePct > 0 ? `${changePct}% of the picture changed.\n\n` : '') +
              (changes.regions.length ? `Changed areas: ${changes.regions.length}\n\n` : '') +
              `Before: ${firstFileUrl(before, origin) ?? '—'}${changes.pinned ? ' (your pinned baseline)' : ''}\n` +
              `After:  ${firstFileUrl(after, origin) ?? '—'}\n` +
              (changes.highlightUrl ? `Changes highlighted: ${changes.highlightUrl}\n` : '') +
              `\nHistory and settings: ${link}\n\n` +
              `Stop these emails by pausing or deleting the monitor on that page.`,
          }),
        )
      : 'not_configured';
    await saveDelivery();
  }

  if (watch.webhook_url && ['pending','failed'].includes(delivery.webhook)) {
    /*
     * Chat apps render whatever shape they are handed, so a raw JSON post
     * lands there as noise. Recognising their hosts turns "paste your webhook
     * URL" into a working integration; everything else — Zapier, n8n, a
     * customer's own endpoint — keeps the JSON.
     */
    const flavour = webhookFlavour(watch.webhook_url);
    const payload = webhookBody(flavour, {
      name,
      url: watch.url,
      changePct,
      summary: summary.sentence || null,
      beforeUrl: firstFileUrl(before, origin),
      afterUrl: firstFileUrl(after, origin),
      watchUrl: link,
      rule,
      highlightUrl: changes.highlightUrl,
      regions: changes.regions,
    });

    const body =
      flavour === 'json'
        ? {
            ...(payload as Record<string, unknown>),
            watch: { id: watch.id, label: watch.label, url: watch.url, frequency: watch.frequency },
            text_added: change.added.slice(0, 20),
            text_removed: change.removed.slice(0, 20),
            detected_at: new Date().toISOString(),
          }
        : payload;

    delivery.webhook = await observeDelivery(async () => {
      const response = await fetch(watch.webhook_url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'EasyScreenCapture-Watch/1' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (response.body) await response.body.cancel().catch(() => undefined);
      return response.ok;
    });
    await saveDelivery();
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* The scheduled sweep                                                         */
/* -------------------------------------------------------------------------- */

export interface WatchSweepResult {
  due: number;
  ran: number;
  changed: number;
  errors: number;
  skipped: number;
  /** Due but left for a later tick by MAX_PER_TICK, MAX_FAST_PER_TICK or FAST_BUDGET_MS. */
  backlog: number;
  /** How long past its due time the latest-running watch started. */
  maxLateMs: number;
}

export interface SweepOptions {
  /** Only watches on this schedule: the minute cron's quarter-hour sweeps take the 15-minute ones. */
  frequency?: string;
}

/** At most `size` holders at once; the rest wait their turn, first come first served. */
function slots(size: number): () => Promise<() => void> {
  let free = size;
  const waiting: Array<() => void> = [];
  return async () => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else free++;
    };
  };
}

/**
 * Due watches with whether each is a fast monitor whose check will most likely
 * be a reading alone (fast-checks.ts): fast, not forced, with a signature and a
 * baseline, its weekly full check not yet due. The check decides for itself;
 * this only picks its lane.
 */
async function dueWithLanes(now: Date, where: string, binds: string[]): Promise<Array<{ row: WatchRow; fast: boolean }>> {
  const since = new Date((Math.floor(now.getTime() / HOUR_MS) - SAFETY_NET_MS / HOUR_MS + 1) * HOUR_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT w.*, CASE WHEN f.mode = 'fast' AND f.forced = 0 AND f.signature IS NOT NULL AND f.last_full_at >= ?
                           AND w.baseline_capture_id IS NOT NULL THEN 1 ELSE 0 END AS fast_lane
     FROM watches w LEFT JOIN watch_fast_checks f ON f.watch_id = w.id
     WHERE ${where} ORDER BY w.next_run_at ASC LIMIT ?`,
  )
    .bind(since, ...binds, MAX_PER_TICK + MAX_FAST_PER_TICK)
    .all<WatchRow & { fast_lane: number }>();
  return (results ?? []).map(({ fast_lane, ...row }) => ({ row, fast: fast_lane === 1 }));
}

/**
 * Runs every watch that is due. Called from the cron handlers: the hourly one
 * for everything, the minute one at :15, :30 and :45 for 15-minute monitors
 * only. Both claim a watch before running it (claimDue), under the same
 * lease, so neither runs one the other has.
 *
 * Renders go a few at a time, as they always have (CONCURRENCY). Fast monitors
 * get lanes of their own, many more per tick, until FAST_BUDGET_MS is spent;
 * one whose page changed waits for a render slot like any other. Before
 * migration 0016 there are none, and the sweep is the one it always was.
 */
export async function runDueWatches(origin: string, now = new Date(), options: SweepOptions = {}): Promise<WatchSweepResult> {
  const where = `status = 'active' AND next_run_at <= ?${options.frequency ? ' AND frequency = ?' : ''}`;
  const binds = [now.toISOString(), ...(options.frequency ? [options.frequency] : [])];
  const [listed, total] = await Promise.all([
    (await fastChecksReady())
      ? dueWithLanes(now, where, binds)
      : dueWatches(now, MAX_PER_TICK, options.frequency).then((rows) => rows.map((row) => ({ row, fast: false }))),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM watches WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  const renders = listed.filter((entry) => !entry.fast).slice(0, MAX_PER_TICK).map((entry) => entry.row);
  const reads = listed.filter((entry) => entry.fast).slice(0, MAX_FAST_PER_TICK).map((entry) => entry.row);
  const taken = renders.length + reads.length;
  const result: WatchSweepResult = {
    due: Math.max(total?.n ?? 0, taken),
    ran: 0,
    changed: 0,
    errors: 0,
    skipped: 0,
    backlog: Math.max(0, (total?.n ?? 0) - taken),
    maxLateMs: 0,
  };

  const permit = slots(CONCURRENCY);
  const started = Date.now();
  // Each queue in `width` lanes, every watch claimed just before it runs. A
  // budgeted queue stops taking watches once it is spent; they stay due.
  const lanes = (queue: WatchRow[], width: number, budget = Infinity) => {
    let next = 0;
    const lane = async () => {
      for (let listed = queue[next++]; listed; listed = queue[next++]) {
        if (Date.now() - started >= budget) {
          // This lane's watch, and every one no lane has taken yet.
          result.backlog += 1 + Math.max(0, queue.length - next);
          next = queue.length;
          return;
        }
        const watch = await claimDue(listed.id, now).catch((error) => {
          console.error(`[watch] ${listed.id} could not be claimed`, error);
          return null;
        });
        if (!watch) continue;
        result.maxLateMs = Math.max(result.maxLateMs, Date.now() - Date.parse(listed.next_run_at));
        const outcome = await runWatch(watch, origin, { permit }).catch((error) => {
          console.error(`[watch] ${watch.id} threw`, error);
          return { status: 'error', changed: false } as WatchOutcome;
        });
        if (outcome.status === 'done') result.ran++;
        if (outcome.status === 'error') result.errors++;
        if (outcome.status === 'skipped') result.skipped++;
        if (outcome.changed) result.changed++;
      }
    };
    return Array.from({ length: Math.min(width, queue.length) }, lane);
  };
  await Promise.all([...lanes(renders, CONCURRENCY), ...lanes(reads, FAST_CONCURRENCY, FAST_BUDGET_MS)]);

  return result;
}

async function claimRetry(runId: string): Promise<boolean> {
  const claim = await env.DB.prepare(
    "UPDATE alert_retries SET status='sending',attempts=attempts+1,updated_at=? WHERE run_id=? AND status='pending'",
  )
    .bind(new Date().toISOString(), runId)
    .run();
  return Boolean(claim.meta.changes);
}

async function finishRetry(runId: string, delivery: Delivery, attempts: number) {
  const retry = Object.values(delivery).some(state => state === 'failed' || state === 'not_configured');
  // On the hour, like every schedule here, so the retry is due at the tick it was meant for.
  await env.DB.prepare('UPDATE alert_retries SET status=?,next_attempt_at=?,updated_at=? WHERE run_id=?')
    .bind(retry && attempts < 3 ? 'pending' : 'done', new Date(hourTick(Date.now()+attempts*HOUR_MS)).toISOString(),new Date().toISOString(),runId).run();
}
/** Retry only explicit failures, never an accepted or ambiguous send. Three total attempts. */
export async function retryAlerts(origin: string) {
  if (!await workflowsReady()) return;
  const now = new Date().toISOString();
  // A process lost during sending has an ambiguous outcome. Do not send it twice.
  await env.DB.prepare("UPDATE alert_retries SET status='unknown' WHERE status='sending' AND updated_at < ?")
    .bind(new Date(Date.now()-3600000).toISOString()).run();
  const { results } = await env.DB.prepare("SELECT * FROM alert_retries WHERE status='pending' AND next_attempt_at<=? AND attempts<3 ORDER BY next_attempt_at LIMIT 20").bind(now).all<{run_id:string;attempts:number}>();
  for (const job of results || []) {
    const claim = await env.DB.prepare("UPDATE alert_retries SET status='sending',attempts=attempts+1,updated_at=? WHERE run_id=? AND status='pending'").bind(now,job.run_id).run();
    if (!claim.meta.changes) continue;
    try {
      const run = await env.DB.prepare('SELECT * FROM watch_runs WHERE id=?').bind(job.run_id).first<WatchRunRow>();
      const watch = run ? await getWatch(run.watch_id) : null;
      const owner = watch ? await loadSessionUser(watch.user_id) : null;
      const before = run?.baseline_capture_id ? await captureById(run.baseline_capture_id) : null;
      const after = run?.capture_id ? await captureById(run.capture_id) : null;
      if (!run || !watch || !owner || !before || !after || watch.status !== 'active' || watchLimit(owner.plan) === 0 || run.user_id !== watch.user_id || before.user_id !== watch.user_id || after.user_id !== watch.user_id || Date.parse(run.created_at) < Date.now()-86400000) {
        await env.DB.prepare("UPDATE alert_retries SET status='done' WHERE run_id=?").bind(job.run_id).run(); continue;
      }
      const decoded = decodeRunDetail(run.detail);
      const changes = decodeRunChanges(run.detail);
      const rule = await getMonitorRule(watch.id);
      await notify(watch,owner,before,after,run.change_pct || 0,origin,decoded.delivery,{ kind: rule.kind, detail: decoded.detail },async()=>{
        await env.DB.prepare('UPDATE watch_runs SET detail=? WHERE id=?').bind(encodeRunDetail(decoded.detail,decoded.delivery,changes),run.id).run();
      },undefined,{ regions: changes.regions, highlightUrl: changes.highlight ? highlightUrl(after, origin) : null, pinned: changes.pinned });
      await finishRetry(run.id,decoded.delivery,job.attempts+1);
    } catch (error) { console.error('[alerts] retry interrupted',error); }
  }
}
