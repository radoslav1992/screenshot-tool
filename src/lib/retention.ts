import { env } from 'cloudflare:workers';
import { safeParseFiles, type CaptureRow } from './captures';
import { highlightFile } from './change-highlights';
import { PLAN_ORDER, getPlan } from './plans';
import { planSql, trialsAvailable } from './trial-plan';

export interface SweepResult {
  scanned: number;
  deleted: number;
  filesDeleted: number;
  bytesFreed: number;
  tokensPurged: number;
  truncated: boolean;
  failed: number;
}


/**
 * Each plan gets a bounded batch every hour so one busy plan cannot consume
 * the entire sweep. Keep DELETE statements below D1’s parameter limit.
 */
const MAX_PER_PLAN = 50;

function cutoffFor(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** alert_retries arrived with migration 0009. Cached per isolate: a yes for good, a no for a minute. */
let retriesTable: { ready: boolean; at: number } | undefined;
async function alertRetriesReady(): Promise<boolean> {
  if (retriesTable && (retriesTable.ready || Date.now() - retriesTable.at < 60_000)) return retriesTable.ready;
  const ready = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_retries'").first());
  retriesTable = { ready, at: Date.now() };
  return ready;
}

/**
 * Captures an alert still points at. An alert links its before and after, and
 * one waiting to be retried — or the latest change of a watch paused for a
 * month and then resumed — should not open onto a missing image.
 *
 * The latest change is found per watch by seeking from last_changed_at, which
 * is set in the same write as that change's run, so it costs one index lookup
 * per watch rather than a scan of the run history.
 */
async function alertCaptures(): Promise<string> {
  const latest = `SELECT (SELECT r.id FROM watch_runs r WHERE r.watch_id = w.id AND r.changed = 1 AND r.created_at >= w.last_changed_at
                            ORDER BY r.created_at LIMIT 1)
                  FROM watches w WHERE w.last_changed_at IS NOT NULL`;
  const runs = (await alertRetriesReady())
    ? `${latest} UNION SELECT run_id FROM alert_retries WHERE status IN ('pending', 'sending')`
    : latest;
  // NOT IN against a list holding NULL matches nothing, so both columns are filtered.
  return `AND c.id NOT IN (
            SELECT capture_id FROM watch_runs WHERE id IN (${runs}) AND capture_id IS NOT NULL
            UNION SELECT baseline_capture_id FROM watch_runs WHERE id IN (${runs}) AND baseline_capture_id IS NOT NULL)`;
}

/**
 * Deletes captures past their plan's retention window, along with their R2
 * objects, and purges spent verification tokens.
 *
 * Retention is a per-plan property, so this runs one bounded query per plan
 * rather than joining across the whole capture table.
 */
export async function sweepExpiredCaptures(now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    deleted: 0,
    filesDeleted: 0,
    bytesFreed: 0,
    tokensPurged: 0,
    truncated: false,
    failed: 0,
  };

  const alerted = await alertCaptures();
  // The plan each account acts on: a Pro trial keeps Pro's history while it runs, and no longer.
  const plan = planSql('u', '?1', await trialsAvailable());
  for (const planId of PLAN_ORDER) {
    const cutoff = cutoffFor(getPlan(planId).historyDays, now);

    /*
     * A watch's baseline is exempt. It is the only thing the next run has to
     * compare against, so sweeping it would silently turn a weekly watch into
     * one that can never report a change. So are the captures alerts link to.
     */
    const { results } = await env.DB.prepare(
      `SELECT c.* FROM captures c
       JOIN users u ON u.id = c.user_id
       WHERE ${plan} = ?2 AND c.created_at < ?3
         AND c.id NOT IN (SELECT baseline_capture_id FROM watches WHERE baseline_capture_id IS NOT NULL)
         ${alerted}
       ORDER BY c.created_at ASC
       LIMIT ?4`,
    )
      .bind(new Date(now).toISOString(), planId, cutoff, MAX_PER_PLAN)
      .all<CaptureRow>();

    const expired = results ?? [];
    result.scanned += expired.length;
    if (!expired.length) continue;
    if (expired.length === MAX_PER_PLAN) result.truncated = true;
    const ids: string[] = [];
    for (const row of expired) {
      try {
        // Preserve the manifest for retries if any object deletion fails.
        const manifest = JSON.parse(row.files);
        if (!Array.isArray(manifest) || manifest.some(file => !file || typeof file.key !== 'string' || !file.key)) {
          throw new Error('Invalid capture file manifest');
        }
        const files = safeParseFiles(row.files);
        if (!files.length && row.bytes > 0) throw new Error('Missing capture file manifest');
        // A monitor check's highlighted copy is not in its manifest, but goes with it.
        const keys = [...files.map(file => file.key), ...(row.source === 'watch' ? [highlightFile(row).key] : [])];
        if (keys.length) await env.SHOTS.delete(keys);
        ids.push(row.id);
        result.filesDeleted += files.length;
        result.bytesFreed += row.bytes;
      } catch (error) {
        result.failed++;
        console.error(`[retention] capture ${row.id} retained for retry`, error);
      }
    }
    // At most 50 binds, within D1's statement parameter limit.
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const deleted = await env.DB.prepare(`DELETE FROM captures WHERE id IN (${placeholders})`)
        .bind(...ids).run();
      result.deleted += deleted.meta.changes ?? 0;
    }
  }

  // Expired or spent verification tokens are worthless; keep the table small.
  const tokens = await env.DB.prepare(
    `DELETE FROM email_verifications WHERE expires_at < ? OR used_at IS NOT NULL`,
  )
    .bind(new Date(now).toISOString())
    .run();
  result.tokensPurged = tokens.meta.changes ?? 0;

  // Expired sessions accumulate the same way.
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(new Date(now).toISOString())
    .run();

  return result;
}

/** A render that has not reported back in this long is never going to. */
const STRANDED_AFTER_MS = 15 * 60_000;

/**
 * Marks captures that never finished as failed.
 *
 * A request killed mid-render — the isolate torn down, the client gone — leaves
 * a row saying "pending" for ever, which reads in the library as a blank card
 * nobody can explain. Run hourly rather than with the nightly sweep: a customer
 * staring at a stuck capture should not have to wait until 03:00 to be told.
 */
export async function failStrandedCaptures(now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE captures SET status = 'error', error = 'The capture did not finish. Try again.',
       completed_at = ?
     WHERE status = 'pending' AND created_at < ?`,
  )
    .bind(new Date(now).toISOString(), new Date(now - STRANDED_AFTER_MS).toISOString())
    .run();
  return result.meta.changes ?? 0;
}

/**
 * How long a quiet monitor run is kept: a check that read the page, found
 * nothing new and took no screenshot. A 15-minute monitor writes 96 of them a
 * day, and after a month they say nothing the monitor's status does not.
 *
 * A little over a month, because the monthly care report (lib/care-reports.ts)
 * counts last month's checks on the 1st at 09:00 in the project's timezone:
 * 31 days, the widest timezone offset and the morning still fit inside 35.
 */
const QUIET_RUN_DAYS = 35;
const QUIET_RUN_BATCH = 1000;

/**
 * Deletes quiet runs older than QUIET_RUN_DAYS, a bounded batch per call.
 * Every run that changed something, failed, was skipped or has a screenshot
 * stays, so alerts, history and health keep everything they read.
 *
 * watch_runs has no index on created_at alone, so the scan is bounded by rowid
 * instead: rows are only ever appended, so everything before the first run
 * newer than the cutoff is older than it, and the query never walks the
 * recent part of the table.
 */
export async function pruneQuietRuns(now = Date.now()): Promise<number> {
  const cutoff = cutoffFor(QUIET_RUN_DAYS, now);
  const result = await env.DB.prepare(
    `DELETE FROM watch_runs WHERE rowid IN (
       SELECT rowid FROM watch_runs
        WHERE rowid < COALESCE((SELECT rowid FROM watch_runs WHERE created_at >= ?1 ORDER BY rowid LIMIT 1),
                               (SELECT MAX(rowid) + 1 FROM watch_runs))
          AND created_at < ?1 AND status = 'done' AND changed = 0 AND capture_id IS NULL
        LIMIT ${QUIET_RUN_BATCH})`,
  )
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
