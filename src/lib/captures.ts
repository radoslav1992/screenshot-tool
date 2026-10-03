import { captureListQuery, type CaptureListOptions } from './capture-list';
import { env } from 'cloudflare:workers';
import { currentPeriod, type SessionUser } from './auth';
import { displayUrl, plannedShots, type CaptureOptions } from './capture-options';
import { HttpError } from './http';
import { prefixedId, randomToken } from './ids';
import { getPlan } from './plans';
import { render, type RenderedFile } from './renderer';
import { safeParseFacts, type PageFacts } from './page-facts';
import { highlightFile } from './change-highlights';

/** Where a capture was asked for. Watch runs are nobody's click, so they count separately. */
export type CaptureSource = 'app' | 'api' | 'watch';

export interface CaptureFile {
  key: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
  contentType: string;
}

export interface CaptureRow {
  id: string;
  user_id: string;
  url: string;
  host: string;
  device: string;
  width: number;
  height: number;
  scale: number;
  mode: string;
  format: string;
  status: string;
  error: string | null;
  source: string;
  share_token: string;
  files: string;
  bytes: number;
  duration_ms: number;
  created_at: string;
  completed_at: string | null;
  /** JSON PageFacts, when the capture asked for them. */
  facts: string | null;
  /**
   * Screenshots taken from the quota when the row was created and not yet
   * settled. In memory only, never a column: set by createCaptureRow, settled
   * by runCapture or discardCaptureRow.
   */
  reserved?: number;
  /** Why a capture run in this request failed. In memory only, never a column. */
  failure?: { type: string; status: number };
}

export interface CaptureDTO {
  id: string;
  status: string;
  url: string;
  display_url: string;
  device: string;
  viewport: { width: number; height: number; scale: number };
  mode: string;
  format: string;
  source: string;
  error?: string;
  /** The machine-readable kind of `error`, e.g. `render_timeout` or `unreachable_url`. */
  error_type?: string;
  images: string[];
  files: Array<{ url: string; name: string; bytes: number; width: number; height: number }>;
  bytes: number;
  duration_ms: number;
  created_at: string;
  completed_at: string | null;
  page?: PageFacts;
}

export function fileUrl(row: Pick<CaptureRow, 'id' | 'share_token'>, file: CaptureFile, origin: string): string {
  return `${origin}/f/${row.id}/${file.name}?t=${row.share_token}`;
}

export function toDTO(row: CaptureRow, origin: string): CaptureDTO {
  const files: CaptureFile[] = safeParseFiles(row.files);
  const facts = safeParseFacts(row.facts);
  const urls = files.map((file) => fileUrl(row, file, origin));
  return {
    id: row.id,
    status: row.status,
    url: row.url,
    display_url: displayUrl(row.url),
    device: row.device,
    viewport: { width: row.width, height: row.height, scale: row.scale },
    mode: row.mode,
    format: row.format,
    source: row.source,
    ...(row.error ? { error: row.error, error_type: captureErrorType(row) } : {}),
    images: urls,
    files: files.map((file, index) => ({
      url: urls[index]!,
      name: file.name,
      bytes: file.bytes,
      width: file.width,
      height: file.height,
    })),
    bytes: row.bytes,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    completed_at: row.completed_at,
    ...(facts ? { page: facts } : {}),
  };
}

export function safeParseFiles(raw: string): CaptureFile[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CaptureFile[]) : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Failure kinds                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The renderer's own messages, mapped back to the error type that raised them.
 *
 * Only the message is stored — the type has no column — so a capture read back
 * later is classified by what it says. A capture failed in this request carries
 * its real type in `failure` and never needs this.
 */
const ERROR_MESSAGES: Array<[RegExp, string]> = [
  [/took too long to (load|capture)/i, 'render_timeout'],
  [/could not be resolved|^The page could not be loaded \(|redirected to a private or loopback/i, 'unreachable_url'],
  [/^The `[^`]+` step on `/, 'action_failed'],
  [/^The page could not be redacted/, 'redaction_failed'],
  [/browser sessions are in use|rendering browser could not be reached/i, 'browser_unavailable'],
  [/^Scroll series requires the Browser Rendering binding/, 'unsupported_mode'],
  [/only the Browser Rendering binding can honour/, 'unsupported_option'],
  [/needs the Browser Rendering binding|No rendering backend is configured/, 'renderer_unavailable'],
];

/** Status codes for the failure types a capture can end with; anything else is 502. */
const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unreachable_url: 400,
  action_failed: 400,
  unsupported_mode: 501,
  unsupported_option: 501,
  browser_unavailable: 503,
  renderer_unavailable: 503,
  render_timeout: 504,
};

export function captureErrorType(row: Pick<CaptureRow, 'error' | 'failure'>): string {
  if (row.failure) return row.failure.type;
  const message = row.error ?? '';
  return ERROR_MESSAGES.find(([pattern]) => pattern.test(message))?.[1] ?? 'render_failed';
}

/** The HTTP status a failed capture answers a synchronous request with. */
export function captureErrorStatus(row: Pick<CaptureRow, 'error' | 'failure'>): number {
  return row.failure?.status ?? ERROR_STATUS[captureErrorType(row)] ?? 502;
}

/* -------------------------------------------------------------------------- */
/* Quota                                                                       */
/* -------------------------------------------------------------------------- */

export interface UsageSnapshot {
  used: number;
  viaApp: number;
  viaApi: number;
  viaWatch: number;
  quota: number;
  remaining: number;
  period: string;
  daysLeft: number;
  renewsOn: string;
}

export async function getUsage(user: SessionUser): Promise<UsageSnapshot> {
  const period = currentPeriod();
  const row = await env.DB.prepare(
    `SELECT used, via_app, via_api, via_watch FROM usage_counters WHERE user_id = ? AND period = ?`,
  )
    .bind(user.id, period)
    .first<{ used: number; via_app: number; via_api: number; via_watch: number }>();

  const quota = user.plan === 'free' ? (user.freeQuota ?? getPlan('free').quota) : getPlan(user.plan).quota;
  const used = row?.used ?? 0;
  const now = new Date();
  const renews = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.max(0, Math.ceil((renews.getTime() - now.getTime()) / 86_400_000));

  return {
    used,
    viaApp: row?.via_app ?? 0,
    viaApi: row?.via_api ?? 0,
    viaWatch: row?.via_watch ?? 0,
    quota,
    remaining: Math.max(0, quota - used),
    period,
    daysLeft,
    renewsOn: renews.toISOString().slice(0, 10),
  };
}

function sourceCounts(count: number, source: CaptureSource): [number, number, number] {
  return [source === 'app' ? count : 0, source === 'api' ? count : 0, source === 'watch' ? count : 0];
}

async function consumeQuota(userId: string, period: string, count: number, source: CaptureSource): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_counters (user_id, period, used, via_app, via_api, via_watch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, period) DO UPDATE SET
       used = used + ?3,
       via_app = via_app + ?4,
       via_api = via_api + ?5,
       via_watch = via_watch + ?6`,
  )
    .bind(userId, period, count, ...sourceCounts(count, source))
    .run();
}

/**
 * Takes `count` screenshots from the period's allowance, or none at all.
 *
 * Checking the counter and charging it later let parallel requests each see
 * the same screenshots left and all spend them. This is one conditional UPDATE:
 * of two requests racing for the last screenshot, the second finds its WHERE no
 * longer true and changes nothing — which is how it knows it lost.
 */
export async function reserveQuota(
  userId: string,
  period: string,
  count: number,
  quota: number,
  source: CaptureSource,
): Promise<boolean> {
  if (count <= 0) return true;
  const [, update] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO usage_counters (user_id, period) VALUES (?, ?)`).bind(userId, period),
    env.DB.prepare(
      `UPDATE usage_counters SET
         used = used + ?3,
         via_app = via_app + ?4,
         via_api = via_api + ?5,
         via_watch = via_watch + ?6
       WHERE user_id = ?1 AND period = ?2 AND used + ?3 <= ?7`,
    ).bind(userId, period, count, ...sourceCounts(count, source), quota),
  ]);
  return (update?.meta?.changes ?? 0) > 0;
}

/** Gives back screenshots that were reserved and not taken. */
export async function refundQuota(userId: string, period: string, count: number, source: CaptureSource): Promise<void> {
  if (count <= 0) return;
  await env.DB.prepare(
    `UPDATE usage_counters SET
       used = MAX(0, used - ?3),
       via_app = MAX(0, via_app - ?4),
       via_api = MAX(0, via_api - ?5),
       via_watch = MAX(0, via_watch - ?6)
     WHERE user_id = ?1 AND period = ?2`,
  )
    .bind(userId, period, count, ...sourceCounts(count, source))
    .run();
}

function rowPeriod(row: Pick<CaptureRow, 'created_at'>): string {
  return currentPeriod(new Date(row.created_at));
}

/**
 * Squares a capture's reservation with the files it produced: a scroll series
 * that came up short gets the difference back. Best-effort — the capture has
 * already happened, and a counter that could not be adjusted is not a reason
 * to report it as failed.
 */
async function settleQuota(row: CaptureRow, produced: number): Promise<void> {
  const source = row.source as CaptureSource;
  try {
    if (row.reserved === undefined) {
      // A row that was never reserved against is charged afterwards, as before.
      await consumeQuota(row.user_id, rowPeriod(row), produced, source);
    } else if (produced < row.reserved) {
      await refundQuota(row.user_id, rowPeriod(row), row.reserved - produced, source);
    } else if (produced > row.reserved) {
      await consumeQuota(row.user_id, rowPeriod(row), produced - row.reserved, source);
    }
  } catch (error) {
    console.error('[captures] could not settle the quota reservation', error);
  }
}

function quotaExceeded(user: SessionUser, usage: UsageSnapshot, wanted: number): HttpError {
  const plan = getPlan(user.plan).name;
  return usage.remaining <= 0
    ? new HttpError(402, 'quota_exceeded', `You have used all ${usage.quota} screenshots on the ${plan} plan this month.`)
    : new HttpError(
        402,
        'quota_exceeded',
        `That capture takes ${wanted} screenshots and you have ${usage.remaining} left on the ${plan} plan this month.`,
      );
}

/** Refuses what the account's plan does not include. Checked before anything is spent. */
export function assertPlanAllows(user: SessionUser, options: CaptureOptions): void {
  const plan = getPlan(user.plan);
  if (options.format === 'pdf' && !plan.formats.includes('pdf')) {
    throw new HttpError(403, 'plan_required', 'PDF export is available on the paid plans.');
  }
  if (options.device === 'custom' && !plan.customViewport) {
    throw new HttpError(403, 'plan_required', 'Custom viewports are available on the paid plans.');
  }
}

/* -------------------------------------------------------------------------- */
/* Running a capture                                                           */
/* -------------------------------------------------------------------------- */

/** How many times a series re-reads what is left after losing a race for it. */
const RESERVE_ATTEMPTS = 3;

export async function createCaptureRow(
  user: SessionUser,
  options: CaptureOptions,
  source: CaptureSource,
): Promise<CaptureRow> {
  let usage = await getUsage(user);
  if (usage.remaining <= 0) throw quotaExceeded(user, usage, 1);

  /*
   * Quota is charged per file, so a capture asking for several has to be able
   * to afford all of them. Checking only for "more than zero left" let one
   * request overrun the quota it was billed against.
   */
  const wanted = plannedShots(options);
  if (wanted > usage.remaining) throw quotaExceeded(user, usage, wanted);

  /*
   * A series does not know its frame count until the page is measured, so it
   * cannot be checked up front — it is capped at what is left instead. Better a
   * short series than a bill for frames nobody agreed to.
   */
  if (options.mode === 'series') {
    options.maxFrames = Math.min(options.maxFrames, usage.remaining);
  }

  assertPlanAllows(user, options);

  // The mark is a property of the plan, not of the request — decided here so no
  // caller can ask for an unmarked capture it has not paid for.
  options.watermark = getPlan(user.plan).watermark;

  const row: CaptureRow = {
    id: prefixedId('cap', 12),
    user_id: user.id,
    url: options.url,
    host: options.host,
    device: options.device,
    width: options.width,
    height: options.height,
    scale: options.scale,
    mode: options.mode,
    format: options.format,
    status: 'pending',
    error: null,
    source,
    share_token: randomToken(16),
    files: '[]',
    bytes: 0,
    duration_ms: 0,
    created_at: new Date().toISOString(),
    completed_at: null,
    facts: null,
  };

  /*
   * The checks above read the counter; this takes from it. The screenshots are
   * spent now, before rendering, so a burst of parallel requests cannot all pass
   * the check and overshoot the quota together. A series reserves its whole
   * frame cap and gets back what it did not use; one that loses a race re-reads
   * what is left and asks for that instead.
   */
  for (let attempt = 1; ; attempt++) {
    const count = options.mode === 'series' ? options.maxFrames : wanted;
    if (await reserveQuota(user.id, rowPeriod(row), count, usage.quota, source)) {
      row.reserved = count;
      break;
    }
    usage = await getUsage(user);
    if (options.mode !== 'series' || usage.remaining <= 0 || attempt >= RESERVE_ATTEMPTS) {
      throw quotaExceeded(user, usage, wanted);
    }
    options.maxFrames = Math.min(options.maxFrames, usage.remaining);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO captures (id, user_id, url, host, device, width, height, scale, mode, format, status,
                             source, share_token, files, bytes, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '[]', 0, 0, ?)`,
    )
      .bind(
        row.id,
        row.user_id,
        row.url,
        row.host,
        row.device,
        row.width,
        row.height,
        row.scale,
        row.mode,
        row.format,
        row.source,
        row.share_token,
        row.created_at,
      )
      .run();
  } catch (error) {
    await refundQuota(user.id, rowPeriod(row), row.reserved ?? 0, source).catch(() => undefined);
    throw error;
  }

  return row;
}

/** Takes back a row that will not be rendered after all, and the quota it reserved. */
export async function discardCaptureRow(row: CaptureRow): Promise<void> {
  await refundQuota(row.user_id, rowPeriod(row), row.reserved ?? 0, row.source as CaptureSource).catch((error) =>
    console.error('[captures] could not refund a discarded capture', error),
  );
  row.reserved = 0;
  await env.DB.prepare(`DELETE FROM captures WHERE id = ? AND status = 'pending'`).bind(row.id).run();
}

async function removeFiles(keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => env.SHOTS.delete(key).catch(() => undefined)));
}

/** Renders, stores to R2 and finalises the capture row. Never throws. */
export async function runCapture(row: CaptureRow, options: CaptureOptions): Promise<CaptureRow> {
  const files: CaptureFile[] = [];
  // Every key written, so a capture that fails partway leaves nothing behind.
  const uploaded: string[] = [];
  let abandoned = false;

  const store = async (file: RenderedFile, name: string): Promise<void> => {
    const key = `captures/${row.user_id}/${row.id}/${name}`;
    await env.SHOTS.put(key, file.data as unknown as ArrayBuffer, {
      httpMetadata: {
        contentType: file.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: { captureId: row.id, userId: row.user_id },
    });
    uploaded.push(key);
    // A put still in flight when the capture failed lands after the clean-up.
    if (abandoned) {
      await removeFiles([key]);
      return;
    }
    files.push({
      key,
      name,
      bytes: file.data.byteLength,
      width: file.width,
      height: file.height,
      contentType: file.contentType,
    });
  };

  try {
    // `sizes` files arrive here one at a time, as they are shot.
    const result = await render(options, (file) =>
      store(file, file.name ?? `${String(file.index).padStart(2, '0')}.${file.ext}`),
    );

    for (const file of result.files) {
      const name =
        file.name ??
        (result.files.length > 1
          ? `${String(file.index).padStart(2, '0')}.${file.ext}`
          : `capture.${file.ext}`);
      await store(file, name);
    }

    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    const completedAt = new Date().toISOString();
    const facts = result.facts ? JSON.stringify(result.facts) : null;
    const update = await env.DB.prepare(
      `UPDATE captures SET status = 'done', files = ?, bytes = ?, duration_ms = ?, completed_at = ?, error = NULL,
              facts = ?
       WHERE id = ?`,
    )
      .bind(JSON.stringify(files), totalBytes, result.durationMs, completedAt, facts, row.id)
      .run();

    // The rendering happened either way, so it is paid for either way.
    await settleQuota(row, files.length);

    if (update.meta?.changes === 0) {
      // Deleted while it rendered — with its account, or by its owner. Nothing
      // points at these files any more, so nothing would ever remove them.
      await removeFiles(uploaded);
      const message = 'The capture was deleted before it finished.';
      return { ...row, reserved: 0, status: 'error', error: message, failure: { type: 'not_found', status: 404 } };
    }

    return {
      ...row,
      reserved: 0,
      status: 'done',
      facts,
      files: JSON.stringify(files),
      bytes: totalBytes,
      duration_ms: result.durationMs,
      completed_at: completedAt,
    };
  } catch (error) {
    abandoned = true;
    await removeFiles(uploaded);
    // A capture that produced nothing costs nothing.
    if (row.reserved) {
      await refundQuota(row.user_id, rowPeriod(row), row.reserved, row.source as CaptureSource).catch((refundError) =>
        console.error('[captures] could not refund a failed capture', refundError),
      );
    }
    const failure =
      error instanceof HttpError
        ? { type: error.type, status: error.status }
        : { type: 'render_failed', status: 502 };
    const message =
      error instanceof HttpError ? error.message : error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE captures SET status = 'error', error = ?, completed_at = ? WHERE id = ?`)
      .bind(message.slice(0, 500), new Date().toISOString(), row.id)
      .run();
    return { ...row, reserved: 0, status: 'error', error: message, failure };
  }
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export async function listCaptures(
  userId: string,
  options: CaptureListOptions = {},
): Promise<CaptureRow[]> {
  const { sql, binds } = captureListQuery(userId, options);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<CaptureRow>();
  return results ?? [];
}

export async function getCapture(id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT * FROM captures WHERE id = ?`).bind(id).first<CaptureRow>();
}

export async function deleteCapture(row: CaptureRow): Promise<void> {
  // A monitor compares each check with its baseline. Deleting it would make the
  // next check a silent "first check" and miss whatever changed in between.
  // `*` because baseline_pinned_at arrives with a migration that may not be applied yet.
  const monitor = await env.DB.prepare(`SELECT * FROM watches WHERE baseline_capture_id = ? LIMIT 1`)
    .bind(row.id)
    .first<{ label: string; url: string; baseline_pinned_at?: string | null }>();
  if (monitor) {
    const name = monitor.label || displayUrl(monitor.url);
    throw new HttpError(
      409,
      'baseline_in_use',
      monitor.baseline_pinned_at
        ? `This capture is the pinned baseline for the monitor “${name}”. Unpin it on the monitor first, or delete the monitor.`
        : `This capture is the comparison baseline for the monitor “${name}”. ` +
            'It is replaced after the next check, or delete the monitor first.',
    );
  }
  // A monitor check may have a highlighted copy beside its files (see change-highlights).
  const files = [...safeParseFiles(row.files), ...(row.source === 'watch' ? [highlightFile(row)] : [])];
  await Promise.all(files.map((file) => env.SHOTS.delete(file.key).catch(() => undefined)));
  await env.DB.prepare(`DELETE FROM captures WHERE id = ?`).bind(row.id).run();
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers shared by the UI                                         */
/* -------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(then).toISOString().slice(0, 10);
}
