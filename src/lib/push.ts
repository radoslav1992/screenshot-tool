import { env } from 'cloudflare:workers';
import { pushConfigured, sendPush } from './apns';
export { pushConfigured } from './apns';
export async function pushReady() {
  if (!pushConfigured(env)) return false;
  const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('push_devices','push_deliveries')").first<{ n: number }>();
  return row?.n === 2;
}
export async function queuePush(runId: string, userId: string) {
  if (!await pushReady()) return;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO push_deliveries(run_id,device_id,session_id,next_attempt_at,expires_at,updated_at)
    SELECT ?,d.id,d.session_id,?,?,? FROM push_devices d JOIN sessions s ON s.id=d.session_id AND s.user_id=d.user_id
    WHERE d.user_id=? AND s.expires_at>?`).bind(runId, now, new Date(Date.now()+86400000).toISOString(), now, userId, now).run();
  await drainPush(runId);
}
/** Per-device claims prevent overlapping cron/manual checks from resending accepted alerts. */
export async function drainPush(onlyRun?: string) {
  if (!await pushReady()) return;
  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM push_devices WHERE session_id NOT IN (SELECT id FROM sessions WHERE expires_at>?)').bind(now).run();
  await env.DB.prepare("DELETE FROM push_deliveries WHERE expires_at<?").bind(new Date(Date.now()-7*86400000).toISOString()).run();
  await env.DB.prepare("UPDATE push_deliveries SET status='unknown' WHERE status='sending' AND updated_at<?").bind(new Date(Date.now()-300000).toISOString()).run();
  const { results } = await env.DB.prepare(`SELECT q.*, d.token,d.environment,d.registered_at,r.watch_id FROM push_deliveries q
    JOIN push_devices d ON d.id=q.device_id AND d.session_id=q.session_id
    JOIN sessions s ON s.id=d.session_id AND s.user_id=d.user_id AND s.expires_at>?
    JOIN watch_runs r ON r.id=q.run_id AND r.user_id=d.user_id AND r.changed=1
    JOIN watches w ON w.id=r.watch_id AND w.user_id=d.user_id AND w.status='active'
    WHERE q.status='pending' AND q.attempts<3 AND q.next_attempt_at<=? AND q.expires_at>? ${onlyRun ? 'AND q.run_id=?' : ''}
    ORDER BY q.next_attempt_at LIMIT 20`).bind(now,now,now,...(onlyRun ? [onlyRun] : [])).all<{
      run_id: string; device_id: string; session_id: string; token: string; environment: string; watch_id: string; attempts: number; expires_at: string; registered_at: string;
    }>();
  for (const row of results ?? []) {
    const claimed = await env.DB.prepare("UPDATE push_deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE run_id=? AND device_id=? AND status='pending' AND session_id=?")
      .bind(now,row.run_id,row.device_id,row.session_id).run();
    if (!claimed.meta.changes) continue;
    let status = 'unknown', reason = 'TransportUnconfirmed';
    try {
      const result = await sendPush(env,row.token,row.environment,row.watch_id,row.run_id,row.expires_at);
      status = result.state === 'retry' && row.attempts+1<3 ? 'pending' : result.state === 'accepted' ? 'accepted' : 'failed';
      reason = result.reason;
      if (result.state === 'invalid') {
        const cutoff = typeof result.timestamp === 'number' ? new Date(result.timestamp).toISOString() : row.registered_at;
        await env.DB.prepare('DELETE FROM push_devices WHERE id=? AND session_id=? AND registered_at<=?').bind(row.device_id,row.session_id,cutoff).run();
      }
    } catch { /* Unknown transport outcome is not retried, to avoid duplicate notifications. */ }
    await env.DB.prepare('UPDATE push_deliveries SET status=?,reason=?,next_attempt_at=?,updated_at=? WHERE run_id=? AND device_id=? AND session_id=?')
      .bind(status,reason,new Date(Date.now()+3600000).toISOString(),new Date().toISOString(),row.run_id,row.device_id,row.session_id).run();
  }
}
