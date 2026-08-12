import { env } from 'cloudflare:workers';
import { currentPeriod, type SessionUser } from './auth';
import { displayUrl, type CaptureOptions } from './capture-options';
import { HttpError } from './http';
import { prefixedId, randomToken } from './ids';
import { getPlan } from './plans';
import { render } from './renderer';
import { safeParseFacts, type PageFacts } from './page-facts';

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
    ...(row.error ? { error: row.error } : {}),
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

  const quota = getPlan(user.plan).quota;
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
    .bind(
      userId,
      period,
      count,
      source === 'app' ? count : 0,
      source === 'api' ? count : 0,
      source === 'watch' ? count : 0,
    )
    .run();
}

/* -------------------------------------------------------------------------- */
/* Running a capture                                                           */
/* -------------------------------------------------------------------------- */

export async function createCaptureRow(
  user: SessionUser,
  options: CaptureOptions,
  source: CaptureSource,
): Promise<CaptureRow> {
  const usage = await getUsage(user);
  if (usage.remaining <= 0) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `You have used all ${usage.quota} screenshots on the ${getPlan(user.plan).name} plan this month.`,
    );
  }

  const plan = getPlan(user.plan);
  if (options.format === 'pdf' && !plan.formats.includes('pdf')) {
    throw new HttpError(403, 'plan_required', 'PDF export is available on the paid plans.');
  }
  if (options.device === 'custom' && !plan.customViewport) {
    throw new HttpError(403, 'plan_required', 'Custom viewports are available on the paid plans.');
  }

  // The mark is a property of the plan, not of the request — decided here so no
  // caller can ask for an unmarked capture it has not paid for.
  options.watermark = plan.watermark;

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

  return row;
}

/** Renders, stores to R2 and finalises the capture row. Never throws. */
export async function runCapture(row: CaptureRow, options: CaptureOptions): Promise<CaptureRow> {
  try {
    const result = await render(options);
    const files: CaptureFile[] = [];
    let totalBytes = 0;

    for (const file of result.files) {
      const name =
        result.files.length > 1
          ? `${String(file.index).padStart(2, '0')}.${file.ext}`
          : `capture.${file.ext}`;
      const key = `captures/${row.user_id}/${row.id}/${name}`;
      await env.SHOTS.put(key, file.data as unknown as ArrayBuffer, {
        httpMetadata: {
          contentType: file.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
        customMetadata: { captureId: row.id, userId: row.user_id },
      });
      totalBytes += file.data.byteLength;
      files.push({
        key,
        name,
        bytes: file.data.byteLength,
        width: file.width,
        height: file.height,
        contentType: file.contentType,
      });
    }

    const completedAt = new Date().toISOString();
    const facts = result.facts ? JSON.stringify(result.facts) : null;
    await env.DB.prepare(
      `UPDATE captures SET status = 'done', files = ?, bytes = ?, duration_ms = ?, completed_at = ?, error = NULL,
              facts = ?
       WHERE id = ?`,
    )
      .bind(JSON.stringify(files), totalBytes, result.durationMs, completedAt, facts, row.id)
      .run();

    await consumeQuota(row.user_id, currentPeriod(new Date(row.created_at)), files.length, row.source as CaptureSource);

    return {
      ...row,
      status: 'done',
      facts,
      files: JSON.stringify(files),
      bytes: totalBytes,
      duration_ms: result.durationMs,
      completed_at: completedAt,
    };
  } catch (error) {
    const message =
      error instanceof HttpError ? error.message : error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE captures SET status = 'error', error = ?, completed_at = ? WHERE id = ?`)
      .bind(message.slice(0, 500), new Date().toISOString(), row.id)
      .run();
    return { ...row, status: 'error', error: message };
  }
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export async function listCaptures(
  userId: string,
  options: { mode?: string; limit?: number; cursor?: string } = {},
): Promise<CaptureRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const clauses = ['user_id = ?'];
  const binds: Array<string | number> = [userId];

  if (options.mode && options.mode !== 'all') {
    clauses.push('mode = ?');
    binds.push(options.mode);
  }
  if (options.cursor) {
    clauses.push('created_at < ?');
    binds.push(options.cursor);
  }
  binds.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT * FROM captures WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds)
    .all<CaptureRow>();
  return results ?? [];
}

export async function getCapture(id: string): Promise<CaptureRow | null> {
  return env.DB.prepare(`SELECT * FROM captures WHERE id = ?`).bind(id).first<CaptureRow>();
}

export async function deleteCapture(row: CaptureRow): Promise<void> {
  const files = safeParseFiles(row.files);
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
