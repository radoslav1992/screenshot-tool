import { env } from 'cloudflare:workers';
import { currentPeriod, toSessionUser, type SessionUser, type UserRow } from './auth';
import {
  assertPlanAllows,
  captureInsert,
  getCapture,
  getUsage,
  refundQuota,
  reserveCaptureRow,
  reserveQuota,
  runCapture,
  type CaptureRow,
  type CaptureSource,
} from './captures';
import { parseCaptureOptions, plannedShots, type CaptureOptions } from './capture-options';
import { HttpError, badRequest } from './http';
import { prefixedId } from './ids';
import { canSendEmail, sendMail } from './mailer';
import { getPlan } from './plans';
import { projectsReady } from './projects';
import { hasRequestAuth } from './request-auth';

/**
 * Background captures.
 *
 * A capture normally runs inside the request that asked for it, which caps it
 * at what a client will wait for, and a batch at what one request can hold. A
 * job is a capture that waits its turn instead: its row and its screenshots are
 * taken when it is asked for, and the minute cron renders it later, a few at a
 * time, next to the monitor sweep and the captures people are waiting on.
 *
 * There is no queue service behind this — a Queue is a resource the deployment
 * would have to create first — just a table, claimed with a lease. A tick that
 * dies mid-render leaves its jobs `running` under a lease that lapses, and a
 * later tick takes them again.
 *
 * The capture row is the record of what happened; the job only says when it is
 * to happen. A capture row says `queued` while its job waits and `running`
 * while it renders, and lists leave both out unless asked (BACKGROUND_STATUSES
 * in capture-list.ts).
 */

export interface JobRow {
  id: string;
  user_id: string;
  batch_id: string | null;
  position: number;
  capture_id: string;
  url: string;
  device: string;
  /** JSON request parameters, re-parsed when the job runs. */
  options: string;
  source: string;
  reserved: number;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  attempts: number;
  lease_until: string | null;
  run_after: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchRow {
  id: string;
  user_id: string;
  label: string;
  source: string;
  project_id: string | null;
  total: number;
  shots: number;
  notify: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
}

/** How long a claim holds a job: the 100 s capture deadline, a launch and the uploads, with room to spare. */
const LEASE_MS = 5 * 60_000;

/** A job runs at most twice: again after a tick died under it, or after a full browser pool turned it away. */
export const MAX_ATTEMPTS = 2;

/**
 * Jobs rendering at once, across every tick still running. Each holds a browser,
 * and the hourly monitor sweep holds three of its own; the account's sessions
 * are shared with every capture someone is waiting on.
 */
export const JOB_SLOTS = 2;

/** For the first minutes of each hour, while the monitor sweep has its browsers out, the queue keeps to one. */
export const SWEEP_SLOTS = 1;
const SWEEP_MINUTES = 10;

/** A tick stops taking new jobs after this; what it has started, it finishes. */
const CLAIM_BUDGET_MS = 45_000;

/** How often a lane looks again while every slot is held by an earlier tick's jobs. */
const BUSY_POLL_MS = 5_000;

/** A job the browser pool turned away waits this long before it is tried again. */
const RETRY_DELAY_MS = 60_000;

/** Finished jobs and batches are kept this long; their captures follow the plan's own retention. */
const KEEP_DAYS = 30;

/** What a job whose lease lapsed with no attempts left tells its capture. Same words as a stranded sync capture. */
const LOST = 'The capture did not finish. Try again.';

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * capture_jobs and capture_batches arrived with migration 0013. Cached per
 * isolate like pushReady: a yes for good, a no re-checked after a minute, so
 * applying the migration takes effect without a redeploy.
 */
let jobTables: { ready: boolean; at: number } | undefined;
export async function captureJobsReady(): Promise<boolean> {
  if (jobTables && (jobTables.ready || Date.now() - jobTables.at < 60_000)) return jobTables.ready;
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('capture_jobs','capture_batches')",
  ).first<{ n: number }>();
  jobTables = { ready: row?.n === 2, at: Date.now() };
  return jobTables.ready;
}

/** For pages and decisions that must not fail on a probe: an unreachable database reads as "not yet". */
export async function captureJobsAvailable(): Promise<boolean> {
  return captureJobsReady().catch(() => false);
}

export async function requireCaptureJobs(): Promise<void> {
  if (!(await captureJobsReady())) {
    throw new HttpError(
      503,
      'setup_required',
      'Background captures are being prepared. Please try again after setup is complete.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Queueing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The request parameters a job keeps, to be parsed again when it runs — so a
 * URL is checked against the denylist as it stands then, not as it stood when
 * it was queued. A list of what to keep rather than of what to drop: `headers`,
 * `cookies` and `basic_auth` are never written down (see request-auth.ts), and
 * neither is anything a parameter added later might mean.
 */
const STORED_PARAMS = [
  'url',
  'html',
  'device',
  'mode',
  'format',
  'width',
  'height',
  'scale',
  'sizes',
  'delay',
  'quality',
  'block_ads',
  'dark_mode',
  'max_frames',
  'facts',
  'hide',
  'blur',
  'ignore_regions',
  'redact_pii',
  'actions',
  'dismiss_consent',
];

export function storedParams(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STORED_PARAMS) {
    const value = input[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Screenshots a job reserves: the files it plans, or for a series its whole
 * frame cap, given back in part when the page turns out shorter.
 */
export function jobShots(options: CaptureOptions): number {
  return options.mode === 'series' ? options.maxFrames : plannedShots(options);
}

/**
 * Whether a capture request asks to be answered before it renders: `async=1`,
 * or the standard `Prefer: respond-async`. A preference, so it may be declined
 * — without the queue's tables the capture runs inline as it always has.
 */
export function asksForAsync(request: Request, body: Record<string, string>): boolean {
  const flag = (body.async ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || /(^|[\s,;])respond-async\b/i.test(request.headers.get('prefer') ?? '');
}

/** A job is stored by definition, and credentials never are. */
export function assertQueueable(options: CaptureOptions): void {
  if (hasRequestAuth(options.auth)) {
    throw badRequest(
      '`headers`, `cookies` and `basic_auth` are never stored, so a capture that sends them cannot wait in the background. Send it without `async`.',
      'async',
    );
  }
}

export interface NewJob {
  id: string;
  /** Its capture row, with `reserved` set. */
  capture: CaptureRow;
  params: Record<string, string>;
  position: number;
}

/** Jobs a single insert carries, as one JSON parameter, like captureInserts. */
const JOBS_PER_INSERT = 100;

export function jobInserts(jobs: NewJob[], batchId: string | null, at: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < jobs.length; start += JOBS_PER_INSERT) {
    const chunk = jobs.slice(start, start + JOBS_PER_INSERT).map((job) => ({
      id: job.id,
      user_id: job.capture.user_id,
      position: job.position,
      capture_id: job.capture.id,
      url: job.capture.url,
      device: job.capture.device,
      options: JSON.stringify(job.params),
      source: job.capture.source,
      reserved: job.capture.reserved ?? 0,
    }));
    statements.push(
      env.DB.prepare(
        `INSERT INTO capture_jobs (id, user_id, batch_id, position, capture_id, url, device, options, source,
                                   reserved, status, attempts, run_after, created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.user_id'), ?1, json_extract(value, '$.position'),
                json_extract(value, '$.capture_id'), json_extract(value, '$.url'), json_extract(value, '$.device'),
                json_extract(value, '$.options'), json_extract(value, '$.source'), json_extract(value, '$.reserved'),
                'queued', 0, ?2, ?2, ?2
         FROM json_each(?3)`,
      ).bind(batchId, at, JSON.stringify(chunk)),
    );
  }
  return statements;
}

/**
 * Queues one capture: `async` on /api/captures and /v1/capture. Every check a
 * synchronous capture makes happens now and its screenshots are reserved now;
 * the row and its job are written in one batch, so neither exists without the
 * other.
 */
export async function enqueueCapture(
  user: SessionUser,
  options: CaptureOptions,
  input: Record<string, string>,
  source: 'app' | 'api',
): Promise<CaptureRow> {
  assertQueueable(options);
  const row = await reserveCaptureRow(user, options, source, 'queued');
  const params = storedParams(input);
  // reserveCaptureRow caps a series at what is left; the job renders with that cap.
  if (options.mode === 'series') params.max_frames = String(options.maxFrames);

  try {
    await env.DB.batch([
      captureInsert(row),
      ...jobInserts([{ id: prefixedId('job', 12), capture: row, params, position: 0 }], null, row.created_at),
    ]);
  } catch (error) {
    await refundQuota(user.id, currentPeriod(new Date(row.created_at)), row.reserved ?? 0, source).catch(() => undefined);
    throw error;
  }
  return row;
}

function jobPeriod(job: Pick<JobRow, 'created_at'>): string {
  return currentPeriod(new Date(job.created_at));
}

/** Gives back what jobs that will never render reserved, one refund per account, month and counter. */
export async function refundJobs(jobs: JobRow[]): Promise<void> {
  const groups = new Map<string, { job: JobRow; count: number }>();
  for (const job of jobs) {
    const key = `${job.user_id} ${jobPeriod(job)} ${job.source}`;
    const group = groups.get(key) ?? { job, count: 0 };
    group.count += job.reserved;
    groups.set(key, group);
  }
  for (const { job, count } of groups.values()) {
    await refundQuota(job.user_id, jobPeriod(job), count, job.source as CaptureSource).catch((error) =>
      console.error(`[jobs] could not refund ${count} screenshot(s) to ${job.user_id}`, error),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Batches                                                                     */
/* -------------------------------------------------------------------------- */

export interface BatchCounts {
  queued: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
}

export async function batchCounts(batchId: string): Promise<BatchCounts> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM capture_jobs WHERE batch_id = ? GROUP BY status`,
  )
    .bind(batchId)
    .all<{ status: string; n: number }>();
  const counts: BatchCounts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  for (const row of results ?? []) {
    if (row.status in counts) counts[row.status as keyof BatchCounts] = row.n;
  }
  return counts;
}

/**
 * Marks a batch finished once nothing in it is left to run, and sends the email
 * it asked for. The UPDATE is the claim: of two jobs finishing together, only
 * one sees the batch change, so the email goes once.
 */
async function settleBatch(batchId: string, origin: string): Promise<void> {
  const at = new Date().toISOString();
  const batch = await env.DB.prepare(
    `UPDATE capture_batches SET completed_at = ?1, updated_at = ?1
     WHERE id = ?2 AND completed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM capture_jobs WHERE batch_id = ?2 AND status IN ('queued', 'running'))
     RETURNING *`,
  )
    .bind(at, batchId)
    .first<BatchRow>();
  // Someone who cancelled already knows it has stopped.
  if (batch?.notify && !batch.cancelled_at) await notifyBatch(batch, origin);
}

/** Best effort: a batch whose email could not be sent is still finished. */
async function notifyBatch(batch: BatchRow, origin: string): Promise<void> {
  if (!canSendEmail()) return;
  try {
    const owner = await env.DB.prepare('SELECT email, plan FROM users WHERE id = ?')
      .bind(batch.user_id)
      .first<{ email: string; plan: string }>();
    if (!owner) return;
    const counts = await batchCounts(batch.id);
    const name = batch.label || 'Batch';
    await sendMail({
      to: owner.email,
      subject: `${name}: ${counts.done} of ${batch.total} captured`,
      text:
        `Your batch “${name}” has finished.\n\n` +
        `Captured: ${counts.done} of ${batch.total}\n` +
        (counts.error ? `Failed: ${counts.error}\n` : '') +
        `\nResults: ${origin}/app/batch?batch=${batch.id}\n\n` +
        `Screenshots are kept for ${getPlan(owner.plan).historyDays} days on your plan. ` +
        'You get this email because you asked to be told when this batch finished.',
    });
  } catch (error) {
    console.error(`[jobs] batch ${batch.id} finished but its email failed`, error);
  }
}

/**
 * Takes a batch's waiting jobs out of the queue and gives their screenshots
 * back. Jobs already rendering finish: stopping a browser mid-page saves
 * nothing that was not spent. Returns how many were cancelled.
 */
export async function cancelBatch(userId: string, batchId: string, origin: string): Promise<number> {
  const at = new Date().toISOString();
  // The same WHERE status = 'queued' a claim uses, so each job goes one way or the other.
  const { results } = await env.DB.prepare(
    `UPDATE capture_jobs SET status = 'cancelled', error = NULL, lease_until = NULL, updated_at = ?1
     WHERE batch_id = ?2 AND user_id = ?3 AND status = 'queued'
     RETURNING *`,
  )
    .bind(at, batchId, userId)
    .all<JobRow>();
  const jobs = results ?? [];
  await refundJobs(jobs);

  // They never ran: there is nothing to keep, and nothing to show in the library.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM captures WHERE user_id = ? AND status = 'queued' AND id IN (SELECT value FROM json_each(?))`,
    ).bind(userId, JSON.stringify(jobs.map((job) => job.capture_id))),
    env.DB.prepare(
      `UPDATE capture_batches SET cancelled_at = COALESCE(cancelled_at, ?1), updated_at = ?1 WHERE id = ?2 AND user_id = ?3`,
    ).bind(at, batchId, userId),
  ]);
  await settleBatch(batchId, origin);
  return jobs.length;
}

/* -------------------------------------------------------------------------- */
/* The minute tick                                                             */
/* -------------------------------------------------------------------------- */

export interface JobTickResult {
  /** Jobs waiting when the tick started. */
  due: number;
  claimed: number;
  done: number;
  failed: number;
  /** Turned away by a full browser pool and queued again for a later tick. */
  retried: number;
  /** Their capture or account was deleted before they ran. */
  cancelled: number;
  /** Found running under a lapsed lease, and queued again. */
  recovered: number;
  /** Found running under a lapsed lease with no attempts left, and failed. */
  expired: number;
  /** Still waiting when the tick stopped taking work. */
  backlog: number;
  /** How long past its due time the latest-starting job began. */
  maxLateMs: number;
}

export interface JobTiming {
  budgetMs: number;
  pollMs: number;
}

const TIMING: JobTiming = { budgetMs: CLAIM_BUDGET_MS, pollMs: BUSY_POLL_MS };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Slots for a tick starting at `now`. */
export function jobSlots(now: Date): number {
  return now.getUTCMinutes() < SWEEP_MINUTES ? SWEEP_SLOTS : JOB_SLOTS;
}

async function countWaiting(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM capture_jobs WHERE status = 'queued' AND run_after <= ?`)
    .bind(new Date().toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Takes the next job, or null when there is none to take or every slot is
 * held. One statement, so two ticks cannot take the same job: the subquery
 * picks it and the outer WHERE takes it only while it is still queued and a
 * slot is still free.
 *
 * Fairness comes first in the order: the account with the fewest jobs already
 * rendering goes next, so one customer's 500-page batch does not hold everyone
 * else's for an hour. Then single captures before batches, then the oldest.
 */
async function claimJob(slots: number): Promise<JobRow | null> {
  const at = Date.now();
  return env.DB.prepare(
    `UPDATE capture_jobs SET status = 'running', attempts = attempts + 1, lease_until = ?1, updated_at = ?2
     WHERE status = 'queued'
       AND id = (
         SELECT j.id FROM capture_jobs j
         WHERE j.status = 'queued' AND j.run_after <= ?2
         ORDER BY (SELECT COUNT(*) FROM capture_jobs r
                   WHERE r.user_id = j.user_id AND r.status = 'running' AND r.lease_until > ?2),
                  j.batch_id IS NOT NULL, j.run_after, j.position, j.id
         LIMIT 1)
       AND (SELECT COUNT(*) FROM capture_jobs WHERE status = 'running' AND lease_until > ?2) < ?3
     RETURNING *`,
  )
    .bind(new Date(at + LEASE_MS).toISOString(), new Date(at).toISOString(), slots)
    .first<JobRow>();
}

/** Closes a job the tick ran, and its batch if that was the last of it. */
async function finishJob(
  job: JobRow,
  status: 'done' | 'error' | 'cancelled',
  error: string | null,
  origin: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE capture_jobs SET status = ?, error = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'`,
  )
    .bind(status, error ? error.slice(0, 500) : null, new Date().toISOString(), job.id)
    .run();
  if (job.batch_id) await settleBatch(job.batch_id, origin);
}

/**
 * Fails the capture of a job that will not run, and gives back what it held —
 * unless the capture already finished, in which case runCapture settled the
 * quota and the capture's own outcome stands.
 */
async function abandonCapture(job: JobRow, message: string): Promise<void> {
  const capture = await env.DB.prepare('SELECT status FROM captures WHERE id = ?')
    .bind(job.capture_id)
    .first<{ status: string }>();
  if (capture && (capture.status === 'done' || capture.status === 'error')) return;
  await refundJobs([job]);
  if (!capture) return;
  await env.DB.prepare(
    `UPDATE captures SET status = 'error', error = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
  )
    .bind(message.slice(0, 500), new Date().toISOString(), job.capture_id)
    .run();
}

/**
 * Jobs whose lease lapsed: the tick that held them died, or ran far longer than
 * any capture can. With attempts left they wait again; without, they fail and
 * their screenshots go back.
 */
async function recoverLapsed(result: JobTickResult, origin: string): Promise<void> {
  const at = new Date().toISOString();
  const { results: expired } = await env.DB.prepare(
    `UPDATE capture_jobs SET status = 'error', error = ?1, lease_until = NULL, updated_at = ?2
     WHERE status = 'running' AND lease_until <= ?2 AND attempts >= ?3
     RETURNING *`,
  )
    .bind(LOST, at, MAX_ATTEMPTS)
    .all<JobRow>();
  for (const job of expired ?? []) {
    await abandonCapture(job, LOST).catch((error) => console.error(`[jobs] ${job.id} could not be closed`, error));
  }
  result.expired = expired?.length ?? 0;

  const { results: recovered } = await env.DB.prepare(
    `UPDATE capture_jobs SET status = 'queued', lease_until = NULL, updated_at = ?1
     WHERE status = 'running' AND lease_until <= ?1 AND attempts < ?2
     RETURNING capture_id`,
  )
    .bind(at, MAX_ATTEMPTS)
    .all<{ capture_id: string }>();
  result.recovered = recovered?.length ?? 0;
  if (result.recovered) {
    await env.DB.prepare(
      `UPDATE captures SET status = 'queued' WHERE status = 'running' AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(recovered!.map((row) => row.capture_id)))
      .run();
  }

  for (const batchId of new Set((expired ?? []).map((job) => job.batch_id).filter(Boolean) as string[])) {
    await settleBatch(batchId, origin);
  }
}

/** Adds a finished batch capture to the project the batch was started from. */
async function addToProject(job: JobRow): Promise<void> {
  if (!job.batch_id) return;
  try {
    const batch = await env.DB.prepare('SELECT project_id FROM capture_batches WHERE id = ?')
      .bind(job.batch_id)
      .first<{ project_id: string | null }>();
    if (!batch?.project_id || !(await projectsReady())) return;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO project_captures (project_id, capture_id) SELECT id, ? FROM projects WHERE id = ? AND user_id = ?`,
    )
      .bind(job.capture_id, batch.project_id, job.user_id)
      .run();
  } catch (error) {
    // The capture is in the library either way; adding it to the project can be done by hand.
    console.error(`[jobs] ${job.id} could not be added to its project`, error);
  }
}

/**
 * A full browser pool is the one failure worth another try: it says nothing
 * about the page. runCapture gave the reservation back when it failed, so the
 * second try takes it again — or, with the quota spent in the meantime, the
 * capture stays failed.
 */
async function requeueJob(job: JobRow, user: SessionUser): Promise<boolean> {
  const usage = await getUsage(user);
  if (!(await reserveQuota(job.user_id, jobPeriod(job), job.reserved, usage.quota, job.source as CaptureSource))) {
    return false;
  }
  const at = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE capture_jobs SET status = 'queued', lease_until = NULL, run_after = ?, error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(
      new Date(at + RETRY_DELAY_MS).toISOString(),
      'Every browser was busy; it will be tried again shortly.',
      new Date(at).toISOString(),
      job.id,
    ),
    env.DB.prepare(`UPDATE captures SET status = 'queued', error = NULL, completed_at = NULL WHERE id = ?`).bind(
      job.capture_id,
    ),
  ]);
  return true;
}

type Outcome = 'done' | 'error' | 'retry' | 'cancelled';

/** Renders one claimed job and closes it. */
async function runJob(job: JobRow, origin: string): Promise<Outcome> {
  const capture = await getCapture(job.capture_id);
  if (!capture || capture.user_id !== job.user_id) {
    // Deleted while it waited: there is nothing to fill in, and the screenshots go back.
    await refundJobs([job]);
    await finishJob(job, 'cancelled', 'The capture was deleted before it ran.', origin);
    return 'cancelled';
  }
  if (capture.status === 'done' || capture.status === 'error') {
    // A tick that died after the capture settled and before the job did. The
    // capture is the outcome, and it settled its own quota.
    await finishJob(job, capture.status, capture.error, origin);
    return capture.status;
  }

  const owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(job.user_id).first<UserRow>();
  if (!owner) {
    await finishJob(job, 'cancelled', 'The account was deleted before the capture ran.', origin);
    return 'cancelled';
  }
  const user = toSessionUser(owner);

  let options: CaptureOptions;
  try {
    // Parsed again rather than trusted: a host denied since it was queued is
    // refused now, and a plan given up since no longer covers a PDF.
    options = parseCaptureOptions(JSON.parse(job.options) as Record<string, string>);
    assertPlanAllows(user, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await abandonCapture(job, message);
    await finishJob(job, 'error', message, origin);
    return 'error';
  }
  options.watermark = getPlan(user.plan).watermark;
  // What it reserved is the most it may take.
  if (options.mode === 'series') options.maxFrames = Math.max(1, Math.min(options.maxFrames, job.reserved));

  await env.DB.prepare(`UPDATE captures SET status = 'running' WHERE id = ? AND status IN ('queued', 'running')`)
    .bind(capture.id)
    .run();
  const finished = await runCapture({ ...capture, status: 'running', reserved: job.reserved }, options);

  if (finished.status === 'done') {
    await addToProject(job);
    await finishJob(job, 'done', null, origin);
    return 'done';
  }
  if (finished.failure?.type === 'not_found') {
    await finishJob(job, 'cancelled', finished.error, origin);
    return 'cancelled';
  }
  if (finished.failure?.type === 'browser_unavailable' && job.attempts < MAX_ATTEMPTS && (await requeueJob(job, user))) {
    return 'retry';
  }
  await finishJob(job, 'error', finished.error ?? 'The capture failed.', origin);
  return 'error';
}

/**
 * The minute cron's work: recover what a dead tick left, then render waiting
 * jobs in `slots` lanes until the claim budget is spent. Lanes stop taking work
 * after the budget but finish what they hold, so a tick lasts at most the
 * budget plus one capture, and the next tick's lanes wait for a free slot
 * rather than piling more browsers on.
 */
export async function runCaptureJobs(origin: string, now = new Date(), timing: JobTiming = TIMING): Promise<JobTickResult> {
  const result: JobTickResult = {
    due: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    recovered: 0,
    expired: 0,
    backlog: 0,
    maxLateMs: 0,
  };
  if (!(await captureJobsReady())) return result;
  const started = Date.now();

  await recoverLapsed(result, origin);
  result.due = await countWaiting();
  if (!result.due) return result;

  const slots = jobSlots(now);
  const lane = async () => {
    while (Date.now() - started < timing.budgetMs) {
      const job = await claimJob(slots);
      if (!job) {
        // Nothing left to take — or every slot is held by an earlier tick.
        if (!(await countWaiting())) return;
        await sleep(timing.pollMs);
        continue;
      }
      result.claimed++;
      result.maxLateMs = Math.max(result.maxLateMs, Date.now() - Date.parse(job.run_after));
      const outcome = await runJob(job, origin).catch((error) => {
        // Left running: its lease lapses and a later tick takes it again.
        console.error(`[jobs] ${job.id} threw`, error);
        return null;
      });
      if (outcome === 'done') result.done++;
      if (outcome === 'error') result.failed++;
      if (outcome === 'retry') result.retried++;
      if (outcome === 'cancelled') result.cancelled++;
    }
  };
  await Promise.all(Array.from({ length: slots }, lane));

  result.backlog = await countWaiting();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/** Bounded per hourly run, like the capture sweep. */
const PRUNE_JOBS = 500;
const PRUNE_BATCHES = 20;

/**
 * Removes finished jobs and batches past KEEP_DAYS. Their captures are not
 * touched — those follow the plan's own retention — so this only forgets which
 * request queued them. A batch goes with its jobs.
 */
export async function pruneCaptureJobs(now = Date.now()): Promise<{ jobs: number; batches: number }> {
  const result = { jobs: 0, batches: 0 };
  if (!(await captureJobsReady())) return result;
  const cutoff = new Date(now - KEEP_DAYS * 86_400_000).toISOString();

  const single = await env.DB.prepare(
    `DELETE FROM capture_jobs WHERE id IN (
       SELECT id FROM capture_jobs
       WHERE batch_id IS NULL AND status IN ('done', 'error', 'cancelled') AND updated_at < ?
       LIMIT ?)`,
  )
    .bind(cutoff, PRUNE_JOBS)
    .run();
  result.jobs += single.meta.changes ?? 0;

  const { results } = await env.DB.prepare(
    `SELECT id FROM capture_batches WHERE completed_at IS NOT NULL AND completed_at < ? ORDER BY completed_at LIMIT ?`,
  )
    .bind(cutoff, PRUNE_BATCHES)
    .all<{ id: string }>();
  const ids = JSON.stringify((results ?? []).map((row) => row.id));
  if (results?.length) {
    const [jobs, batches] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM capture_jobs WHERE batch_id IN (SELECT value FROM json_each(?))`).bind(ids),
      env.DB.prepare(`DELETE FROM capture_batches WHERE id IN (SELECT value FROM json_each(?))`).bind(ids),
    ]);
    result.jobs += jobs?.meta.changes ?? 0;
    result.batches += batches?.meta.changes ?? 0;
  }
  return result;
}
