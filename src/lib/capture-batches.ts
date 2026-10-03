import { env } from 'cloudflare:workers';
import { currentPeriod, type SessionUser } from './auth';
import { urlsFromSitemap } from './batch';
import {
  assertPlanAllows,
  captureInserts,
  getUsage,
  newCaptureRow,
  refundQuota,
  reserveQuota,
  toDTO,
  type CaptureDTO,
  type CaptureRow,
} from './captures';
import { PRESETS, assertPublicCaptureUrl, displayUrl, parseCaptureOptions, type CaptureOptions } from './capture-options';
import {
  batchCounts,
  jobInserts,
  jobShots,
  storedParams,
  type BatchCounts,
  type BatchRow,
  type JobRow,
} from './capture-jobs';
import { HttpError, badRequest } from './http';
import { prefixedId } from './ids';
import { APP_RATE_LIMIT, batchLimit, getPlan } from './plans';
import { ownProject, projectsReady } from './projects';
import { checkRateLimit } from './rate-limit';
import { hasRequestAuth, parseRequestAuth } from './request-auth';

/**
 * Background batches: many pages queued in one request and rendered by the
 * minute cron (see capture-jobs.ts), up to the plan's batch size rather than
 * the 25 a synchronous batch can finish inside one request.
 *
 * Everything is checked before anything is queued — every URL parsed, the
 * plan's limits applied, the whole cost reserved — so a batch either starts in
 * full or not at all, and cannot overrun the quota it was checked against.
 */

export interface BatchDTO {
  id: string;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  label: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Screenshots reserved when it was created; a short series gives some back. */
  shots: number;
  notify: boolean;
  project_id: string | null;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface BatchItem {
  id: string;
  url: string;
  display_url: string;
  device: string;
  status: JobRow['status'];
  capture_id: string;
  error?: string;
  updated_at: string;
}

export interface BatchDetail extends BatchDTO {
  /** Every capture in the batch, in the order asked for — or only those changed since `changed_since`. */
  items: BatchItem[];
  /** The finished captures among `items`. */
  captures: CaptureDTO[];
  failures: Array<{ url: string; device: string; error: string }>;
  /** Pass as `changed_since` on the next poll to get only what moved; it trails slightly, so nothing is missed. */
  as_of: string;
}

function batchStatus(row: BatchRow, counts: BatchCounts): BatchDTO['status'] {
  if (counts.queued + counts.running > 0) return counts.running || counts.done || counts.error ? 'running' : 'queued';
  return row.cancelled_at ? 'cancelled' : 'done';
}

export function batchDTO(row: BatchRow, counts: BatchCounts): BatchDTO {
  return {
    id: row.id,
    status: batchStatus(row, counts),
    label: row.label,
    total: row.total,
    queued: counts.queued,
    running: counts.running,
    done: counts.done,
    failed: counts.error,
    cancelled: counts.cancelled,
    shots: row.shots,
    notify: Boolean(row.notify),
    project_id: row.project_id,
    created_at: row.created_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a request                                                           */
/* -------------------------------------------------------------------------- */

export interface BatchRequest {
  urls: string[];
  /** Capture parameters applied to every page. */
  shared: Record<string, string>;
  /** One capture per device per page; empty for just the shared `device`. */
  devices: string[];
  label: string;
  notify: boolean;
  projectId: string | null;
}

/** Parameters about the batch itself rather than each capture in it. */
const BATCH_PARAMS = new Set(['urls', 'sitemap', 'url', 'url_lines', 'devices', 'label', 'notify', 'project', 'async']);

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/** A JSON array of strings, or a list separated by newlines (with `url_lines=1`) or by newlines and commas. */
function splitUrls(raw: string, linesOnly: boolean): string[] {
  const text = raw.trim();
  let entries: unknown[];
  if (text.startsWith('[')) {
    try {
      entries = JSON.parse(text);
    } catch {
      throw badRequest('`urls` looks like a JSON array but is not valid JSON.', 'urls');
    }
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw badRequest('`urls` must be a JSON array of strings.', 'urls');
    }
  } else {
    entries = text.split(linesOnly ? /\r?\n/ : /[\n,]/);
  }
  return (entries as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function parseDevices(raw: string | undefined): string[] {
  const devices: string[] = [];
  for (const entry of (raw ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    // Own keys only, as parseCaptureOptions checks them.
    if (!Object.hasOwn(PRESETS, entry)) {
      throw badRequest(`\`devices\` may list only: ${Object.keys(PRESETS).join(', ')}.`, 'devices');
    }
    if (!devices.includes(entry)) devices.push(entry);
  }
  return devices;
}

/**
 * Reads `urls` or `sitemap` and the batch's own parameters. A sitemap is read
 * up to what the plan's batch size could take; a list longer than that is
 * refused in createBatch rather than cut short, since its author chose it.
 */
export async function readBatchRequest(body: Record<string, string>, user: SessionUser): Promise<BatchRequest> {
  const devices = parseDevices(body.devices);
  let urls: string[];
  if (body.sitemap) {
    const sitemap = assertPublicCaptureUrl(body.sitemap.trim());
    const pages = Math.max(1, Math.floor(batchLimit(user.plan) / Math.max(1, devices.length)));
    urls = await urlsFromSitemap(sitemap.toString(), pages);
    if (!urls.length) throw badRequest('That sitemap listed no pages.', 'sitemap');
  } else {
    urls = splitUrls(body.urls ?? '', body.url_lines === '1');
    if (!urls.length) throw badRequest('Send `urls` or a `sitemap`.', 'urls');
  }

  const shared: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!BATCH_PARAMS.has(key)) shared[key] = value;
  }

  return {
    urls,
    shared,
    devices,
    label: (body.label ?? '').trim().slice(0, 100),
    notify: truthy(body.notify),
    projectId: (body.project ?? '').trim() || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

export interface BatchCreated extends BatchDTO {
  /** URLs that could not be queued, and why. The rest of the batch went ahead. */
  rejected: Array<{ url: string; error: string }>;
}

function quotaError(user: SessionUser, shots: number, remaining: number): HttpError {
  return new HttpError(
    402,
    'quota_exceeded',
    `That batch needs ${shots} screenshot${shots === 1 ? '' : 's'} and you have ${remaining} left on the ${getPlan(user.plan).name} plan this month.`,
  );
}

function defaultLabel(planned: Array<{ options: CaptureOptions }>, pages: number): string {
  const first = planned[0]?.options.url ?? '';
  let host = first;
  try {
    host = new URL(first).hostname.replace(/^www\./, '');
  } catch {
    /* keep the URL as it is */
  }
  return `${host} · ${pages} page${pages === 1 ? '' : 's'}`;
}

export async function createBatch(
  user: SessionUser,
  request: BatchRequest,
  source: 'app' | 'api',
): Promise<BatchCreated> {
  if (request.shared.html) throw badRequest('A batch captures URLs. Send `html` to a single capture instead.', 'html');
  if (hasRequestAuth(parseRequestAuth(request.shared))) {
    throw badRequest(
      '`headers`, `cookies` and `basic_auth` are never stored, so they cannot be used in a background batch.',
      'headers',
    );
  }

  const plan = getPlan(user.plan);
  const limit = batchLimit(user.plan);
  const devices: Array<string | undefined> = request.devices.length ? request.devices : [undefined];
  const urls = [...new Set(request.urls)];
  if (urls.length * devices.length > limit) {
    throw new HttpError(
      400,
      'batch_too_large',
      `A batch on the ${plan.name} plan takes up to ${limit} captures; this one is ${urls.length * devices.length}.`,
      'urls',
    );
  }

  /*
   * Every page is parsed before anything is spent, as runBatch does: one
   * malformed URL is reported now rather than after the others were paid for,
   * and the real cost is only known once each capture's options are.
   */
  const rejected: BatchCreated['rejected'] = [];
  const planned: Array<{ options: CaptureOptions; params: Record<string, string> }> = [];
  const seen = new Set<string>();
  for (const url of urls) {
    for (const device of devices) {
      const params = storedParams({ ...request.shared, url, ...(device ? { device } : {}) });
      let options: CaptureOptions;
      try {
        options = parseCaptureOptions(params);
      } catch (error) {
        if (!rejected.some((entry) => entry.url === url)) {
          rejected.push({ url, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      // `example.com` and `https://example.com/` are one page.
      const key = `${options.url} ${options.device} ${options.width}x${options.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      planned.push({ options, params });
    }
  }
  if (!planned.length) throw badRequest(rejected[0]?.error ?? 'No URLs to capture.', 'urls');
  for (const { options } of planned) assertPlanAllows(user, options);

  let projectId: string | null = null;
  if (request.projectId) {
    if (!(await projectsReady())) throw badRequest('Projects are not available yet.', 'project');
    projectId = (await ownProject(user.id, request.projectId)).id;
  }

  const shots = planned.reduce((total, { options }) => total + jobShots(options), 0);
  const usage = await getUsage(user);
  if (shots > usage.remaining) throw quotaError(user, shots, usage.remaining);

  // The burst limit is charged for the whole batch, not per page — otherwise a
  // batch is the way around it. Checked after the quota, so a batch refused for
  // that does not spend the hour's allowance as well.
  const hourly = APP_RATE_LIMIT[plan.id] ?? APP_RATE_LIMIT.free;
  const rate = await checkRateLimit(`app:${user.id}`, hourly, 3600, planned.length);
  if (!rate.ok) {
    throw new HttpError(
      429,
      'rate_limited',
      `That batch needs ${planned.length} of the ${hourly} captures an hour on the ${plan.name} plan, and ${rate.remaining} are left.`,
    );
  }

  // The checks read the counter; this takes from it, all at once.
  const at = new Date().toISOString();
  const period = currentPeriod(new Date(at));
  if (!(await reserveQuota(user.id, period, shots, usage.quota, source))) {
    throw quotaError(user, shots, (await getUsage(user)).remaining);
  }

  const batch: BatchRow = {
    id: prefixedId('bat', 12),
    user_id: user.id,
    label: request.label || defaultLabel(planned, new Set(planned.map(({ options }) => options.url)).size),
    source,
    project_id: projectId,
    total: planned.length,
    shots,
    notify: request.notify ? 1 : 0,
    created_at: at,
    updated_at: at,
    cancelled_at: null,
    completed_at: null,
  };
  const rows: CaptureRow[] = planned.map(({ options }) => ({
    ...newCaptureRow(user.id, options, source, 'queued', at),
    reserved: jobShots(options),
  }));

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO capture_batches (id, user_id, label, source, project_id, total, shots, notify, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        batch.id,
        batch.user_id,
        batch.label,
        batch.source,
        batch.project_id,
        batch.total,
        batch.shots,
        batch.notify,
        batch.created_at,
        batch.updated_at,
      ),
      ...captureInserts(rows),
      ...jobInserts(
        rows.map((capture, index) => ({ id: prefixedId('job', 12), capture, params: planned[index]!.params, position: index })),
        batch.id,
        at,
      ),
    ]);
  } catch (error) {
    await refundQuota(user.id, period, shots, source).catch(() => undefined);
    throw error;
  }

  return {
    ...batchDTO(batch, { queued: planned.length, running: 0, done: 0, error: 0, cancelled: 0 }),
    rejected,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export async function ownBatch(userId: string, batchId: string): Promise<BatchRow> {
  const batch = await env.DB.prepare('SELECT * FROM capture_batches WHERE id = ? AND user_id = ?')
    .bind(batchId, userId)
    .first<BatchRow>();
  if (!batch) throw new HttpError(404, 'not_found', 'No batch with that id.');
  return batch;
}

/** Most recent first, with each batch's progress. */
export async function listBatches(userId: string, limit = 20): Promise<BatchDTO[]> {
  const { results } = await env.DB.prepare(
    `SELECT b.*,
            COALESCE(SUM(j.status = 'queued'), 0) AS queued,
            COALESCE(SUM(j.status = 'running'), 0) AS running,
            COALESCE(SUM(j.status = 'done'), 0) AS done,
            COALESCE(SUM(j.status = 'error'), 0) AS error,
            COALESCE(SUM(j.status = 'cancelled'), 0) AS cancelled
     FROM capture_batches b LEFT JOIN capture_jobs j ON j.batch_id = b.id
     WHERE b.user_id = ?
     GROUP BY b.id
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT ?`,
  )
    .bind(userId, Math.min(Math.max(Math.trunc(limit) || 20, 1), 50))
    .all<BatchRow & BatchCounts>();
  return (results ?? []).map((row) => batchDTO(row, row));
}

/**
 * How far `as_of` trails the moment an answer was read. A job's `updated_at` is
 * stamped by the tick that ran it, on another machine, a moment before its write
 * lands; an item stamped just before one answer and written just after it would
 * otherwise be missing from that answer and from every later one. With the
 * margin it is sent again instead — a few repeated items a poll, never a lost one.
 */
const AS_OF_MARGIN_MS = 15_000;

/**
 * A batch's progress, its items and its finished captures. `changedSince`
 * narrows the items to those that moved since an earlier answer's `as_of`, so
 * a page polling a batch of hundreds is not sent all of them every time.
 */
export async function batchDetail(
  userId: string,
  batchId: string,
  origin: string,
  changedSince?: string | null,
): Promise<BatchDetail> {
  const asOf = new Date(Date.now() - AS_OF_MARGIN_MS).toISOString();
  const batch = await ownBatch(userId, batchId);
  const since = changedSince && Number.isFinite(Date.parse(changedSince)) ? changedSince : null;
  const [counts, jobs] = await Promise.all([
    batchCounts(batch.id),
    env.DB.prepare(
      `SELECT * FROM capture_jobs WHERE batch_id = ? AND user_id = ? ${since ? 'AND updated_at >= ?' : ''}
       ORDER BY position, id`,
    )
      .bind(batch.id, userId, ...(since ? [since] : []))
      .all<JobRow>(),
  ]);
  const items = jobs.results ?? [];

  const doneIds = items.filter((job) => job.status === 'done').map((job) => job.capture_id);
  const captures = doneIds.length
    ? ((
        await env.DB.prepare(
          `SELECT * FROM captures WHERE user_id = ? AND status = 'done' AND id IN (SELECT value FROM json_each(?))`,
        )
          .bind(userId, JSON.stringify(doneIds))
          .all<CaptureRow>()
      ).results ?? [])
    : [];
  const order = new Map(doneIds.map((id, index) => [id, index]));
  captures.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return {
    ...batchDTO(batch, counts),
    items: items.map((job) => ({
      id: job.id,
      url: job.url,
      display_url: displayUrl(job.url),
      device: job.device,
      status: job.status,
      capture_id: job.capture_id,
      ...(job.error ? { error: job.error } : {}),
      updated_at: job.updated_at,
    })),
    captures: captures.map((row) => toDTO(row, origin)),
    failures: items
      .filter((job) => job.status === 'error')
      .map((job) => ({ url: job.url, device: job.device, error: job.error ?? 'The capture failed.' })),
    as_of: asOf,
  };
}
