import { getMonitorRule, workflowsReady } from './monitor-rule-store';
import { evaluateRule, type MonitorRule } from './monitor-rules';
import { watchSettingsReady, watchNoise, noiseStrings } from './watch-settings';
import { parseIgnoreRegions } from './ignore-regions';
import { decodeRunDetail, encodeRunDetail, observeDelivery, type Delivery } from './monitor-health';
import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { toSessionUser, type UserRow } from './auth';
import { createCaptureRow, fileUrl, getUsage, runCapture, safeParseFiles, type CaptureRow } from './captures';
import { displayUrl, type CaptureMode, type CaptureOptions, type ViewportId } from './capture-options';
import { HttpError } from './http';
import { prefixedId } from './ids';
import { canSendEmail, sendMail } from './mailer';
import { allowedFrequencies, frequencyHours, frequencyLabel, getPlan, watchLimit } from './plans';
import { compareImages, diffAvailable } from './visual-diff';
import { safeParseFacts } from './page-facts';
import { diffText } from './text-diff';
import { summariseChange } from './summarise';
import { webhookBody, webhookFlavour } from './chat-webhook';

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
 * quota on every tick, for ever, and send nothing anyone can act on.
 */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Watches handled per cron tick. Bounded so one busy hour cannot run long. */
const MAX_PER_TICK = 40;

export function nextRunAt(frequency: string, from = new Date()): string {
  return new Date(from.getTime() + frequencyHours(frequency) * 3_600_000).toISOString();
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

export async function listRuns(watchId: string, limit = 30): Promise<Array<WatchRunRow & { delivery: Delivery }>> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(watchId, limit)
    .all<WatchRunRow>();
  return (results ?? []).map((run) => ({ ...run, ...decodeRunDetail(run.detail) }));
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

async function recordRun(run: Omit<WatchRunRow, 'id' | 'created_at'>): Promise<string> {
  const id = prefixedId('wrn', 10);
  await env.DB.prepare(
    `INSERT INTO watch_runs (id, watch_id, user_id, capture_id, baseline_capture_id, status, changed, change_pct, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
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
    )
    .run();
  return id;
}

export interface WatchOutcome {
  status: 'done' | 'error' | 'skipped';
  changed: boolean;
  changePct?: number;
  detail?: string;
}

/**
 * Runs one watch: capture, compare against the previous run, alert if the page
 * moved by more than the threshold.
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

  // A plan downgrade should stop the watch running, not silently keep spending.
  if (watchLimit(user.plan) === 0 || !allowedFrequencies(user.plan).includes(watch.frequency as never)) {
    await pause(watch.id, 'This monitoring schedule is not included on your current plan.');
    await recordRun({
      watch_id: watch.id,
      user_id: watch.user_id,
      capture_id: null,
      baseline_capture_id: watch.baseline_capture_id,
      status: 'skipped',
      changed: 0,
      change_pct: null,
      detail: 'current schedule is not included in this plan',
    });
    return { status: 'skipped', changed: false, detail: 'current schedule is not included in this plan' };
  }

  const usage = await getUsage(user);
  if (usage.remaining <= 0) {
    // Out of quota is not a failure of the watch; try again next tick rather
    // than counting it toward the error budget.
    await env.DB.prepare(`UPDATE watches SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now.toISOString(), nextRunAt(watch.frequency, now), now.toISOString(), watch.id)
      .run();
    await recordRun({
      watch_id: watch.id,
      user_id: watch.user_id,
      capture_id: null,
      baseline_capture_id: watch.baseline_capture_id,
      status: 'skipped',
      changed: 0,
      change_pct: null,
      detail: 'monthly quota used up',
    });
    return { status: 'skipped', changed: false, detail: 'monthly quota used up' };
  }

  const rule = await getMonitorRule(watch.id);
  let capture: CaptureRow;
  try {
    const noise = await watchNoise(watch.id);
    const options = {
      ...optionsFor(watch),
      monitorSelector: rule.selector || undefined,
      hide: noise.hide.split(',').filter(Boolean),
      ignoreRegions: parseIgnoreRegions(noise.ignore_regions),
    };
    const row = await createCaptureRow(user, options, 'watch');
    capture = await runCapture(row, options);
  } catch (error) {
    return failed(watch, error instanceof Error ? error.message : String(error), now);
  }

  if (capture.status !== 'done') {
    return failed(watch, capture.error ?? 'the capture failed', now);
  }

  // First run: nothing to compare against yet, so this becomes the baseline.
  const baseline = watch.baseline_capture_id ? await captureById(watch.baseline_capture_id) : null;

  let changed = false;
  let changePct: number | null = null;
  let detail: string | null = null;

  if (!baseline) {
    detail = 'first check — saved as the baseline';
  } else if (rule.kind !== 'visual') {
    try {
      const result = evaluateRule(rule, safeParseFacts(baseline.facts), safeParseFacts(capture.facts));
      changed = result.changed; detail = result.detail;
    } catch (error) {
      return failed(watch, error instanceof Error ? error.message : 'Rule comparison failed.', now, capture.id);
    }
  } else if (!diffAvailable()) {
    return failed(watch, 'Comparison unavailable: rendering service is not configured.', now, capture.id);
  } else {
    try {
      const before = firstFileUrl(baseline, origin);
      const after = firstFileUrl(capture, origin);
      if (!before || !after) {
        return failed(watch, 'Comparison unavailable: a capture has no comparable image.', now, capture.id);
      } else {
        const region = parseIgnoreRegions(rule.region)[0];
        const scaled = region ? { x: region.x * watch.scale, y: region.y * watch.scale, width: region.width * watch.scale, height: region.height * watch.scale } : undefined;
        const diff = await compareImages(before, after, scaled);
        changePct = diff.changedPct;
        changed = diff.resized || diff.changedPct >= watch.threshold;
        detail = diff.resized ? `page height changed, ${diff.changedPct}% of the shared area differs` : null;
      }
    } catch (error) {
      // Preserve the last good baseline so the next successful check can still detect the change.
      return failed(watch, 'Comparison failed. The previous baseline has been kept.', now, capture.id);
    }
  }

  await env.DB.prepare(
    `UPDATE watches SET baseline_capture_id = ?, last_run_at = ?, next_run_at = ?, last_error = NULL,
       consecutive_errors = 0, updated_at = ?,
       last_changed_at = CASE WHEN ? = 1 THEN ? ELSE last_changed_at END,
       last_change_pct = ?
     WHERE id = ?`,
  )
    .bind(
      capture.id,
      now.toISOString(),
      nextRunAt(watch.frequency, now),
      now.toISOString(),
      changed ? 1 : 0,
      now.toISOString(),
      changePct,
      watch.id,
    )
    .run();

  const delivery: Delivery = changed
    ? { email: watch.notify_email ? 'pending' : 'disabled', webhook: watch.webhook_url ? 'pending' : 'disabled' }
    : { email: 'not_needed', webhook: 'not_needed' };
  const runId = await recordRun({
    watch_id: watch.id,
    user_id: watch.user_id,
    capture_id: capture.id,
    baseline_capture_id: baseline?.id ?? null,
    status: 'done',
    changed: changed ? 1 : 0,
    change_pct: changePct,
    detail: encodeRunDetail(detail, delivery),
  });

  if (changed && baseline) {
    const queued = await workflowsReady();
    if (queued) await env.DB.prepare("INSERT INTO alert_retries VALUES(?,1,?,'sending',?)").bind(runId, new Date(Date.now()+3600000).toISOString(), now.toISOString()).run();
    await notify(watch, user, baseline, capture, changePct ?? 0, origin, delivery, async () => {
      await env.DB.prepare('UPDATE watch_runs SET detail = ? WHERE id = ? AND user_id = ?')
        .bind(encodeRunDetail(detail, delivery), runId, watch.user_id)
        .run();
    });
    if (queued) await finishRetry(runId, delivery, 1);
  }

  return { status: 'done', changed, changePct: changePct ?? undefined, detail: detail ?? undefined };
}

async function captureById(id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT * FROM captures WHERE id = ? AND status = 'done'`).bind(id).first<CaptureRow>();
}

function firstFileUrl(row: CaptureRow, origin: string): string | null {
  const file = safeParseFiles(row.files)[0];
  return file ? fileUrl(row, file, origin) : null;
}

async function pause(id: string, reason: string): Promise<void> {
  await env.DB.prepare(`UPDATE watches SET status = 'paused', last_error = ?, updated_at = ? WHERE id = ?`)
    .bind(reason.slice(0, 300), new Date().toISOString(), id)
    .run();
}

async function failed(
  watch: WatchRow,
  message: string,
  now: Date,
  captureId: string | null = null,
): Promise<WatchOutcome> {
  const errors = watch.consecutive_errors + 1;
  const givingUp = errors >= MAX_CONSECUTIVE_ERRORS;

  await env.DB.prepare(
    `UPDATE watches SET last_run_at = ?, next_run_at = ?, last_error = ?, consecutive_errors = ?,
       status = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      now.toISOString(),
      nextRunAt(watch.frequency, now),
      message.slice(0, 300),
      errors,
      givingUp ? 'paused' : watch.status,
      now.toISOString(),
      watch.id,
    )
    .run();

  await recordRun({
    watch_id: watch.id,
    user_id: watch.user_id,
    capture_id: captureId,
    baseline_capture_id: watch.baseline_capture_id,
    status: 'error',
    changed: 0,
    change_pct: null,
    detail: message.slice(0, 300),
  });

  return { status: 'error', changed: false, detail: message };
}

/* -------------------------------------------------------------------------- */
/* Alerts                                                                      */
/* -------------------------------------------------------------------------- */

async function notify(
  watch: WatchRow,
  user: SessionUser,
  before: CaptureRow,
  after: CaptureRow,
  changePct: number,
  origin: string,
  delivery: Delivery,
  saveDelivery: () => Promise<void>,
): Promise<void> {
  const name = watch.label || displayUrl(watch.url);
  const link = `${origin}/app/watches/${watch.id}`;

  /*
   * The percentage says a page moved. It cannot say a price went from $19 to
   * $29, which is the thing anyone actually wants from an alert — so the text
   * captured with each run is diffed and, where a model is available,
   * summarised into one sentence.
   */
  const change = diffText(safeParseFacts(before.facts)?.text ?? '', safeParseFacts(after.facts)?.text ?? '');
  const summary = await summariseChange(change, name).catch(() => ({ sentence: '', detail: '' }));

  if (watch.notify_email && ['pending','failed','not_configured'].includes(delivery.email)) {
    const headline = summary.sentence ? `${summary.sentence}\n\n` : '';
    const body = summary.detail ? `${summary.detail}\n\n` : '';
    delivery.email = canSendEmail()
      ? await observeDelivery(() =>
          sendMail({
            to: user.email,
            subject: summary.sentence ? `${name}: ${summary.sentence.slice(0, 80)}` : `${name} changed`,
            text:
              `${name}: a monitored change was detected.\n\n` +
              headline +
              body +
              (changePct > 0 ? `${changePct}% of the picture changed.\n\n` : '') +
              `Before: ${firstFileUrl(before, origin) ?? '—'}\n` +
              `After:  ${firstFileUrl(after, origin) ?? '—'}\n\n` +
              `History and settings: ${link}\n\n` +
              `Stop these emails by pausing or deleting the watch on that page.`,
          }),
        )
      : 'not_configured';
    await saveDelivery();
  }

  if (watch.webhook_url && ['pending','failed'].includes(delivery.webhook)) {
    /*
     * Slack and Discord render whatever shape they are handed, so a raw JSON
     * post lands there as noise. Recognising those two hosts turns "paste your
     * webhook URL" into a working integration; everything else — Zapier, n8n,
     * a customer's own endpoint — keeps the JSON.
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
}

/** Runs every watch that is due. Called from the cron handler. */
export async function runDueWatches(origin: string, now = new Date()): Promise<WatchSweepResult> {
  const due = await dueWatches(now);
  const result: WatchSweepResult = { due: due.length, ran: 0, changed: 0, errors: 0, skipped: 0 };

  // Sequential on purpose. Every run holds a browser, and a burst of parallel
  // renders would contend with the captures customers are waiting on.
  for (const watch of due) {
    const outcome = await runWatch(watch, origin).catch((error) => {
      console.error(`[watch] ${watch.id} threw`, error);
      return { status: 'error', changed: false } as WatchOutcome;
    });
    if (outcome.status === 'done') result.ran++;
    if (outcome.status === 'error') result.errors++;
    if (outcome.status === 'skipped') result.skipped++;
    if (outcome.changed) result.changed++;
  }

  return result;
}


async function finishRetry(runId: string, delivery: Delivery, attempts: number) {
  const retry = Object.values(delivery).some(state => state === 'failed' || state === 'not_configured');
  await env.DB.prepare('UPDATE alert_retries SET status=?,next_attempt_at=?,updated_at=? WHERE run_id=?')
    .bind(retry && attempts < 3 ? 'pending' : 'done', new Date(Date.now()+attempts*3600000).toISOString(),new Date().toISOString(),runId).run();
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
      await notify(watch,toSessionUser(owner),before,after,run.change_pct || 0,origin,decoded.delivery,async()=>{
        await env.DB.prepare('UPDATE watch_runs SET detail=? WHERE id=?').bind(encodeRunDetail(decoded.detail,decoded.delivery),run.id).run();
      });
      await finishRetry(run.id,decoded.delivery,job.attempts+1);
    } catch (error) { console.error('[alerts] retry interrupted',error); }
  }
}
