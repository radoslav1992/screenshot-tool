import { env } from 'cloudflare:workers';
import { decodeRunDetail } from './monitor-health';
import type { WatchRunRow } from './watches';

export async function monitorDashboard(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const [captures, latest, successes, alerts] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      AVG(CASE WHEN status = 'done' THEN duration_ms END) AS average_ms
      FROM captures WHERE user_id = ? AND created_at >= ?`,
    )
      .bind(userId, since)
      .first<{ total: number; succeeded: number; failed: number; pending: number; average_ms: number | null }>(),
    env.DB.prepare(
      `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY watch_id ORDER BY created_at DESC, id DESC) AS position
      FROM watch_runs WHERE user_id = ?) WHERE position = 1`,
    )
      .bind(userId)
      .all<WatchRunRow>(),
    env.DB.prepare(
      `SELECT watch_id, MAX(created_at) AS last_success FROM watch_runs
      WHERE user_id = ? AND status = 'done' AND (baseline_capture_id IS NULL OR change_pct IS NOT NULL)
      GROUP BY watch_id`,
    )
      .bind(userId)
      .all<{ watch_id: string; last_success: string }>(),
    env.DB.prepare(
      `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY watch_id ORDER BY created_at DESC, id DESC) AS position
      FROM watch_runs WHERE user_id = ? AND changed = 1) WHERE position = 1`,
    )
      .bind(userId)
      .all<WatchRunRow>(),
  ]);
  const stats = captures ?? { total: 0, succeeded: 0, failed: 0, pending: 0, average_ms: null };
  const finished = (stats.succeeded ?? 0) + (stats.failed ?? 0);
  return {
    stats,
    successRate: finished ? Math.round((100 * stats.succeeded) / finished) : null,
    latest: new Map((latest.results ?? []).map((run) => [run.watch_id, { ...run, ...decodeRunDetail(run.detail) }])),
    alerts: new Map((alerts.results ?? []).map((run) => [run.watch_id, { ...run, ...decodeRunDetail(run.detail) }])),
    successes: new Map((successes.results ?? []).map((row) => [row.watch_id, row.last_success])),
  };
}
