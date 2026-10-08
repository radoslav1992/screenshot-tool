import { env } from 'cloudflare:workers';

/**
 * Whether migration 0021 has made the care report tables, and the rows an
 * account deletion removes. Kept apart from lib/care-reports.ts, which builds
 * and sends reports, so account deletion reads the tables without pulling in
 * the mailer and Workers AI.
 */

/** Cached per isolate like signoffsReady: a yes for good, a no for a minute. */
let careTable: { ready: boolean; at: number } | undefined;
export async function careReportsReady(): Promise<boolean> {
  if (careTable && (careTable.ready || Date.now() - careTable.at < 60_000)) return careTable.ready;
  const ready = !!(await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='care_report_deliveries'",
  ).first());
  careTable = { ready, at: Date.now() };
  return ready;
}

/** For pages that must not fail on a probe: an unreachable database reads as "not yet". */
export async function careReportsAvailable(): Promise<boolean> {
  return careReportsReady().catch(() => false);
}

/**
 * An account's care report rows, for the caller's batch ahead of its projects.
 * Removed explicitly, as everything in account deletion is, rather than left
 * to the cascades from projects and users. Nothing before the migration.
 */
export async function careCleanup(userId: string): Promise<D1PreparedStatement[]> {
  if (!(await careReportsReady())) return [];
  return [
    env.DB.prepare('DELETE FROM care_report_deliveries WHERE report_id IN (SELECT id FROM care_reports WHERE user_id=?)').bind(
      userId,
    ),
    env.DB.prepare('DELETE FROM care_reports WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM care_report_settings WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)').bind(userId),
  ];
}
