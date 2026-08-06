import { env } from 'cloudflare:workers';
import { safeParseFiles, type CaptureRow } from './captures';
import { PLAN_ORDER, getPlan } from './plans';

export interface SweepResult {
  scanned: number;
  deleted: number;
  filesDeleted: number;
  bytesFreed: number;
  tokensPurged: number;
  truncated: boolean;
}

/**
 * A single sweep deletes at most this many captures. Cron invocations have a
 * CPU budget, and R2 deletes are one subrequest each — better to trim a bounded
 * slice every run than to risk being cut off halfway through.
 */
const MAX_PER_SWEEP = 500;

function cutoffFor(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
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
  };

  let budget = MAX_PER_SWEEP;

  for (const planId of PLAN_ORDER) {
    if (budget <= 0) {
      result.truncated = true;
      break;
    }

    const plan = getPlan(planId);
    const cutoff = cutoffFor(plan.historyDays, now);

    const { results } = await env.DB.prepare(
      `SELECT c.* FROM captures c
       JOIN users u ON u.id = c.user_id
       WHERE u.plan = ? AND c.created_at < ?
       ORDER BY c.created_at ASC
       LIMIT ?`,
    )
      .bind(planId, cutoff, budget)
      .all<CaptureRow>();

    const expired = results ?? [];
    result.scanned += expired.length;
    if (!expired.length) continue;
    if (expired.length === budget) result.truncated = true;
    budget -= expired.length;

    for (const row of expired) {
      const files = safeParseFiles(row.files);
      await Promise.all(
        files.map((file) =>
          env.SHOTS.delete(file.key).catch((error) => {
            // A missing object is fine; anything else should not stop the sweep.
            console.error(`[retention] failed to delete ${file.key}`, error);
          }),
        ),
      );
      result.filesDeleted += files.length;
      result.bytesFreed += row.bytes;
    }

    // Delete the rows in one statement per plan rather than one per capture.
    const ids = expired.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const deleted = await env.DB.prepare(`DELETE FROM captures WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    result.deleted += deleted.meta.changes ?? ids.length;
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
