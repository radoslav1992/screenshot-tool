import { drainPush, pushQueueStatement } from './push';
import { getMonitorRule, workflowsReady } from './monitor-rule-store';
import { evaluateRule, type MonitorRule } from './monitor-rules';
import { watchSettingsReady, watchNoise, noiseStrings } from './watch-settings';
import { parseIgnoreRegions } from './ignore-regions';
import { decodeRunChanges, decodeRunDetail, encodeRunDetail, observeDelivery, type Delivery } from './monitor-health';
import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { toSessionUser, type UserRow } from './auth';
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
import { allowedFrequencies, frequencyHours, frequencyLabel, getPlan, watchLimit } from './plans';
import { compareImages, diffAvailable, type DiffResult } from './visual-diff';
import { safeParseFacts } from './page-facts';
import { diffText } from './text-diff';
import { summariseChange } from './summarise';
import { webhookBody, webhookFlavour } from './chat-webhook';
import { formatDate } from './dates';
import { highlightUrl, storeHighlight, type ChangeRegion } from './change-highlights';

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
 * Watches run at the same time. Every run holds a browser, and an unbounded
 * burst would contend with the captures customers are waiting on; strictly one
 * at a time could not get through a busy hour.
 */
const CONCURRENCY = 3;

const HOUR_MS = 3_600_000;

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

export function nextRunAt(frequency: string, from = new Date()): string {
  return new Date(hourTick(from.getTime() + frequencyHours(frequency) * HOUR_MS)).toISOString();
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
}

export function toWatchDTO(row: WatchRow): WatchDTO {
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
  };
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

export async function deleteWatch(id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM watch_runs WHERE watch_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM watches WHERE id = ?`).bind(id),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export async function dueWatches(now = new Date(), limit = MAX_PER_TICK): Promise<WatchRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM watches WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`,
  )
    .bind(now.toISOString(), limit)
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

/**
 * Runs one watch: capture, compare against the previous run, alert if the page
 * moved by more than the threshold.
 *
 * The row should be fresh — claimed by the sweep or by "Check now" — since
 * what it says about the baseline and errors is written back.
 *
 * Never throws. A cron tick handles many watches and one broken page must not
 * stop the rest.
 */
export async function runWatch(watch: WatchRow, origin: string): Promise<WatchOutcome> {
  const now = new Date();

  const userRow = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(watch.user_id).first<UserRow>();
  if (!userRow) {
    // The account went away between the sweep and now.
    await deleteWatch(watch.id);
    return { status: 'skipped', changed: false, detail: 'account no longer exists' };
  }
  const user = toSessionUser(userRow);
  const run: RunContext = { watch, user, now, origin };

  // A plan downgrade should stop the watch running, not silently keep spending.
  const limit = watchLimit(user.plan);
  if (limit === 0 || !allowedFrequencies(user.plan).includes(watch.frequency as never)) {
    return pauseForPlan(run, 'This monitoring schedule is not included on your current plan.', 'current schedule is not included in this plan');
  }
  // The oldest `limit` watches keep running; the ones beyond it pause.
  if ((await activeAhead(watch)) >= limit) {
    return pauseForPlan(
      run,
      `Paused: your plan includes ${limit} ${limit === 1 ? 'monitor' : 'monitors'}.`,
      'monitor limit for this plan reached',
    );
  }

  // Without the browser binding there is nothing to compare with, and a capture
  // taken anyway would be spent on a picture no check can use.
  if (!diffAvailable()) {
    return failed(run, 'Comparison unavailable: rendering service is not configured.', { temporary: true });
  }

  const usage = await getUsage(user);
  if (usage.remaining <= 0) return quotaSkip(run);

  const rule = await getMonitorRule(watch.id);
  let capture: CaptureRow;
  try {
    const noise = await watchNoise(watch.id);
    const options = {
      ...optionsFor(watch),
      monitorSelector: rule.selector || undefined,
      monitorPhrases: (rule.kind === 'appeared' || rule.kind === 'disappeared') && rule.phrase ? [rule.phrase] : undefined,
      hide: noise.hide.split(',').filter(Boolean),
      ignoreRegions: parseIgnoreRegions(noise.ignore_regions),
    };
    const row = await createCaptureRow(user, options, 'watch');
    capture = await runCapture(row, options);
  } catch (error) {
    // Another capture spent the last of the quota since it was read.
    if (errorType(error) === 'quota_exceeded') return quotaSkip(run);
    return failed(run, error instanceof Error ? error.message : String(error), { temporary: temporaryFailure(error) });
  }

  if (capture.status !== 'done') {
    return failed(run, capture.error ?? 'the capture failed', { temporary: temporaryFailure(capture.error) });
  }

  // First run: nothing to compare against yet, so this becomes the baseline.
  const baseline = watch.baseline_capture_id ? await captureById(watch.baseline_capture_id) : null;

  let changed = false;
  let changePct: number | null = null;
  let detail: string | null = null;
  let visual: DiffResult | null = null;

  if (!baseline) {
    detail = 'first check — saved as the baseline';
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
    let diff: DiffResult;
    try {
      const region = parseIgnoreRegions(rule.region)[0];
      const scaled = region ? { x: region.x * watch.scale, y: region.y * watch.scale, width: region.width * watch.scale, height: region.height * watch.scale } : undefined;
      diff = await compareImages(before, after, scaled, { highlight: watch.threshold });
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

  const highlighted = visual?.highlight ? await storeHighlight(capture, visual.highlight) : false;
  const changes = { regions: visual?.regions ?? [], highlight: highlighted };

  const runId = prefixedId('wrn', 10);
  const alerting = changed && Boolean(baseline);
  const retries = alerting && (await workflowsReady());
  const push = alerting ? await pushQueueStatement(runId, watch.user_id).catch(() => null) : null;
  const delivery: Delivery = changed
    ? { email: watch.notify_email ? 'pending' : 'disabled', webhook: watch.webhook_url ? 'pending' : 'disabled' }
    : { email: 'not_needed', webhook: 'not_needed' };

  /*
   * One batch, so the baseline only moves together with the run that records
   * the change and the jobs that will announce it. Before, a crash between the
   * baseline moving and the alert being queued lost the alert for good: the
   * next check compared against the new baseline and saw nothing.
   */
  const [moved] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE watches SET baseline_capture_id = ?, last_run_at = ?, next_run_at = ?, last_error = NULL,
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
        baseline_capture_id: baseline?.id ?? null,
        status: 'done',
        changed: changed ? 1 : 0,
        change_pct: changePct,
        detail: encodeRunDetail(detail, delivery, changes),
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
    ...(push ? [push] : []),
  ]);
  if (!moved?.meta.changes) return { status: 'skipped', changed: false, detail: 'the monitor was deleted during the check' };

  if (alerting && baseline) {
    // A push outage must not mark a successful comparison failed or block email.
    if (push) {
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
          .bind(encodeRunDetail(detail, delivery, changes), runId, watch.user_id)
          .run();
      },
      // Claimed exactly as a retry is, and only once there is something to
      // send: a crash before this is retried next hour, one after it is
      // ambiguous and never sent twice.
      retries ? () => claimRetry(runId) : undefined,
      { regions: changes.regions, highlightUrl: highlighted ? highlightUrl(capture, origin) : null },
    );
    if (sent && retries) await finishRetry(runId, delivery, 1);
  }

  return { status: 'done', changed, changePct: changePct ?? undefined, detail: detail ?? undefined };
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

/**
 * Out of quota is not a failure of the watch, so it never counts toward the
 * error budget. Nor should it push a weekly watch back a week: it tries again
 * the next day, or when the allowance renews if that is sooner, and never
 * later than its own schedule.
 */
async function quotaSkip(run: RunContext): Promise<WatchOutcome> {
  const { watch, user, now, origin } = run;
  // Allowances renew at the start of each UTC month, as getUsage counts them.
  const renews = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const retry = Math.max(hourTick(now.getTime() + HOUR_MS), Math.min(renews, hourTick(now.getTime() + 24 * HOUR_MS)));
  const next = new Date(Math.min(Date.parse(nextRunAt(watch.frequency, now)), retry)).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
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
                                  AND detail IN (?, ?) AND created_at >= ?) THEN ? ELSE ? END, ?
       WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?)`,
    ).bind(
      runId,
      watch.id,
      watch.user_id,
      watch.baseline_capture_id,
      watch.user_id,
      QUOTA_SKIP,
      FIRST_QUOTA_SKIP,
      monthStart,
      QUOTA_SKIP,
      FIRST_QUOTA_SKIP,
      new Date().toISOString(),
      watch.id,
    ),
  ]);

  const recorded = await env.DB.prepare(`SELECT detail FROM watch_runs WHERE id = ?`).bind(runId).first<{ detail: string }>();
  if (recorded?.detail === FIRST_QUOTA_SKIP) {
    await tellOwner(
      user,
      'Monitor checks paused: screenshot allowance used up',
      `You have used all the screenshots in your plan this month, so scheduled monitor checks are being skipped.\n\n` +
        `They start again on their own when your allowance renews on ${formatDate(renews)}. ` +
        `To keep monitoring before then, upgrade your plan:\n${origin}/app/upgrade\n\n` +
        `Your monitors, baselines and history are unchanged.`,
    );
  }
  return { status: 'skipped', changed: false, detail: QUOTA_SKIP };
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
 * long after each temporary failure in a row, never later than its schedule.
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
  return new Date(hourTick(now.getTime() + hours * HOUR_MS)).toISOString();
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
  changes: AlertChanges = { regions: [], highlightUrl: null },
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
              `Before: ${firstFileUrl(before, origin) ?? '—'}\n` +
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
  /** Due but left for a later tick by MAX_PER_TICK. */
  backlog: number;
  /** How long past its due time the latest-running watch started. */
  maxLateMs: number;
}

/** Runs every watch that is due. Called from the cron handler. */
export async function runDueWatches(origin: string, now = new Date()): Promise<WatchSweepResult> {
  const [due, total] = await Promise.all([
    dueWatches(now),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM watches WHERE status = 'active' AND next_run_at <= ?`)
      .bind(now.toISOString())
      .first<{ n: number }>(),
  ]);
  const result: WatchSweepResult = {
    due: Math.max(total?.n ?? 0, due.length),
    ran: 0,
    changed: 0,
    errors: 0,
    skipped: 0,
    backlog: Math.max(0, (total?.n ?? 0) - due.length),
    maxLateMs: 0,
  };

  // A few at a time, each claimed just before it runs (see CONCURRENCY).
  let next = 0;
  const lane = async () => {
    for (let listed = due[next++]; listed; listed = due[next++]) {
      const watch = await claimDue(listed.id, now).catch((error) => {
        console.error(`[watch] ${listed.id} could not be claimed`, error);
        return null;
      });
      if (!watch) continue;
      result.maxLateMs = Math.max(result.maxLateMs, Date.now() - Date.parse(listed.next_run_at));
      const outcome = await runWatch(watch, origin).catch((error) => {
        console.error(`[watch] ${watch.id} threw`, error);
        return { status: 'error', changed: false } as WatchOutcome;
      });
      if (outcome.status === 'done') result.ran++;
      if (outcome.status === 'error') result.errors++;
      if (outcome.status === 'skipped') result.skipped++;
      if (outcome.changed) result.changed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, lane));

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
      const owner = watch ? await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(watch.user_id).first<UserRow>() : null;
      const before = run?.baseline_capture_id ? await captureById(run.baseline_capture_id) : null;
      const after = run?.capture_id ? await captureById(run.capture_id) : null;
      if (!run || !watch || !owner || !before || !after || watch.status !== 'active' || watchLimit(owner.plan) === 0 || run.user_id !== watch.user_id || before.user_id !== watch.user_id || after.user_id !== watch.user_id || Date.parse(run.created_at) < Date.now()-86400000) {
        await env.DB.prepare("UPDATE alert_retries SET status='done' WHERE run_id=?").bind(job.run_id).run(); continue;
      }
      const decoded = decodeRunDetail(run.detail);
      const changes = decodeRunChanges(run.detail);
      const rule = await getMonitorRule(watch.id);
      await notify(watch,toSessionUser(owner),before,after,run.change_pct || 0,origin,decoded.delivery,{ kind: rule.kind, detail: decoded.detail },async()=>{
        await env.DB.prepare('UPDATE watch_runs SET detail=? WHERE id=?').bind(encodeRunDetail(decoded.detail,decoded.delivery,changes),run.id).run();
      },undefined,{ regions: changes.regions, highlightUrl: changes.highlight ? highlightUrl(after, origin) : null });
      await finishRetry(run.id,decoded.delivery,job.attempts+1);
    } catch (error) { console.error('[alerts] retry interrupted',error); }
  }
}
