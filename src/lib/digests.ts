import { env } from 'cloudflare:workers';
import { collaborationReady, projectAccess } from './collaboration';
import { digestWeek, nextDigest } from './digest-schedule';
import { canSendEmail, sendMail } from './mailer';
/** At-most-once attempts: a unique claim precedes delivery. Ambiguous outcomes are never automatically resent. */
export async function runProjectDigests(origin: string, now = new Date()) {
  if (!(await collaborationReady()) || !canSendEmail()) return { attempted: 0 };
  let attempted = 0;
  // Oldest due first: following hourly invocations drain a backlog without starving later subscribers.
  const subscriptions = (
    await env.DB.prepare(
      `SELECT d.*,u.email FROM project_digests d JOIN users u ON u.id=d.user_id WHERE d.enabled=1 AND d.next_run_at<=? AND u.email_verified_at IS NOT NULL ORDER BY d.next_run_at,d.project_id,d.user_id LIMIT 50`,
    )
      .bind(now.toISOString())
      .all<{ project_id: string; user_id: string; timezone: string; email: string; next_run_at: string }>()
  ).results;
  for (const d of subscriptions) {
    const week = digestWeek(d.timezone, new Date(d.next_run_at));
    await env.DB.prepare('UPDATE project_digests SET next_run_at=? WHERE project_id=? AND user_id=?')
      .bind(nextDigest(d.timezone, new Date(now.getTime() + 86400000)), d.project_id, d.user_id)
      .run();
    if (!week) continue;
    let project;
    try {
      project = (await projectAccess(d.user_id, d.project_id)).project;
    } catch {
      continue;
    }
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const stats = await env.DB.prepare(
      `SELECT COUNT(*) checks,SUM(CASE WHEN r.status='done' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN r.changed=1 THEN 1 ELSE 0 END) changed,SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) failed,SUM(CASE WHEN r.status='skipped' THEN 1 ELSE 0 END) skipped FROM watch_runs r JOIN project_watches pw ON pw.watch_id=r.watch_id WHERE pw.project_id=? AND r.user_id=? AND r.created_at>=? AND r.created_at<=?`,
    )
      .bind(project.id, project.user_id, since, now.toISOString())
      .first<{ checks: number; completed: number; changed: number; failed: number; skipped: number }>();
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO digest_deliveries VALUES(?,?,?,'unknown',?) RETURNING week`,
    )
      .bind(project.id, d.user_id, week, now.toISOString())
      .first();
    if (!claim) continue;
    attempted++;
    const timeout = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status = 'unknown';
    try {
      const sent = await Promise.race([
        sendMail({
          to: d.email,
          subject: `Weekly review · ${project.name}`,
          text: `${project.name} — weekly monitor summary
Period: ${since} to ${now.toISOString()}

Completed checks: ${stats?.completed ?? 0}
Changed checks: ${stats?.changed ?? 0}
Failed checks: ${stats?.failed ?? 0}
Skipped checks: ${stats?.skipped ?? 0}

Review project reports and manage this subscription:
${origin}/app/team/${project.id}

Changes are a subset of completed checks. A missing check is not evidence that a page is unchanged. This digest uses retained monitor history and current project membership.`,
        }),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), 15000);
        }),
      ]);
      status = sent === timeout ? 'unknown' : sent ? 'accepted' : 'failed';
    } catch {
      status = 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
    await env.DB.prepare('UPDATE digest_deliveries SET status=? WHERE project_id=? AND user_id=? AND week=?')
      .bind(status, project.id, d.user_id, week)
      .run();
  }
  await env.DB.prepare('DELETE FROM digest_deliveries WHERE created_at<?')
    .bind(new Date(now.getTime() - 90 * 86400000).toISOString())
    .run();
  return { attempted };
}
