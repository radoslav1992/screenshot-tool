import { env } from 'cloudflare:workers';
import { pushConfigured, sendPush } from './apns';
import { sha256Hex } from './ids';
import { sendWebPush, webPushConfigured, webPushPayload, webPushTestPayload, type WebPushSubscription, type WebPushState } from './web-push';
export { pushConfigured } from './apns';
/** The tables are cached per isolate: a yes for good, a no for a minute. Configuration is read every time. */
const probes = new Map<string, { ready: boolean; at: number }>();
async function tablesReady(devices: string, deliveries: string) {
  const cached = probes.get(devices);
  if (cached && (cached.ready || Date.now() - cached.at < 60_000)) return cached.ready;
  const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (?,?)").bind(devices, deliveries).first<{ n: number }>();
  probes.set(devices, { ready: row?.n === 2, at: Date.now() });
  return row?.n === 2;
}
export async function pushReady() {
  return pushConfigured(env) && await tablesReady('push_devices', 'push_deliveries');
}
/** Migration 0018 and all three VAPID secrets; without either, web push is hidden and nothing is queued for it. */
export async function webPushReady() {
  return webPushConfigured(env) && await webPushTablesReady();
}
/** The tables alone, for clean-up that should happen whether or not the secrets are still set. */
export function webPushTablesReady() {
  return tablesReady('web_push_subscriptions', 'web_push_deliveries');
}

type Due = { run_id: string; device_id: string; session_id: string; watch_id: string; attempts: number; expires_at: string } & Record<string, string>;
/**
 * APNs devices and Web Push subscriptions queue alike. web_push_deliveries has
 * push_deliveries' columns (see migration 0018 for why it is a sibling table),
 * so the queue, claims, retries and expiry below are one path for both, and
 * only the tables and the sender differ.
 */
interface Channel {
  devices: string;
  deliveries: string;
  /** The device columns its sender reads. */
  columns: string;
  ready(): Promise<boolean>;
  send(row: Due): Promise<{ state: WebPushState; reason: string }>;
}
const APNS: Channel = {
  devices: 'push_devices', deliveries: 'push_deliveries', columns: 'd.token,d.environment,d.registered_at', ready: pushReady,
  async send(row) {
    const result = await sendPush(env,row.token,row.environment,row.watch_id,row.run_id,row.expires_at);
    if (result.state === 'invalid') {
      const cutoff = typeof result.timestamp === 'number' ? new Date(result.timestamp).toISOString() : row.registered_at;
      await env.DB.prepare('DELETE FROM push_devices WHERE id=? AND session_id=? AND registered_at<=?').bind(row.device_id,row.session_id,cutoff).run();
    }
    return result;
  },
};
const WEB: Channel = {
  devices: 'web_push_subscriptions', deliveries: 'web_push_deliveries', columns: 'd.endpoint,d.p256dh,d.auth', ready: webPushReady,
  send: (row) => deliverWeb(row.device_id, row as unknown as WebPushSubscription, webPushPayload(row.watch_id, row.run_id), row.expires_at),
};
const CHANNELS = [APNS, WEB];
/** A push service that says the subscription is gone (404/410) has it removed; one that took the alert notes when. */
async function deliverWeb(id: string, subscription: WebPushSubscription, payload: object, expiresAt: string) {
  const result = await sendWebPush(env, subscription, payload, expiresAt);
  if (result.state === 'invalid') await env.DB.prepare('DELETE FROM web_push_subscriptions WHERE id=? AND endpoint=?').bind(id,subscription.endpoint).run();
  if (result.state === 'accepted') await env.DB.prepare('UPDATE web_push_subscriptions SET last_success_at=? WHERE id=?').bind(new Date().toISOString(),id).run();
  return result;
}

/**
 * The queue inserts on their own, one per kind of device, so a monitor run can
 * commit them in the same batch as the run it alerts for: a crash before
 * delivery then leaves a queued push for the next sweep rather than none at all.
 */
export async function pushQueueStatements(runId: string, userId: string): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  for (const channel of CHANNELS) {
    // One kind that cannot be checked must not cost the other its alert.
    if (!await channel.ready().catch(() => false)) continue;
    const now = new Date().toISOString();
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ${channel.deliveries}(run_id,device_id,session_id,next_attempt_at,expires_at,updated_at)
      SELECT ?,d.id,d.session_id,?,?,? FROM ${channel.devices} d JOIN sessions s ON s.id=d.session_id AND s.user_id=d.user_id
      WHERE d.user_id=? AND s.expires_at>? AND EXISTS (SELECT 1 FROM watch_runs WHERE id=?)`).bind(runId, now, new Date(Date.now()+86400000).toISOString(), now, userId, now, runId));
  }
  return statements;
}
export async function queuePush(runId: string, userId: string) {
  const statements = await pushQueueStatements(runId, userId);
  if (!statements.length) return;
  for (const statement of statements) await statement.run();
  await drainPush(runId);
}
/** Per-device claims prevent overlapping cron/manual checks from resending accepted alerts. */
export async function drainPush(onlyRun?: string) {
  const outcomes = await Promise.allSettled(CHANNELS.map(async (channel) => { if (await channel.ready()) await drain(channel, onlyRun); }));
  const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}
async function drain(c: Channel, onlyRun?: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`DELETE FROM ${c.devices} WHERE session_id NOT IN (SELECT id FROM sessions WHERE expires_at>?)`).bind(now).run();
  await env.DB.prepare(`DELETE FROM ${c.deliveries} WHERE expires_at<?`).bind(new Date(Date.now()-7*86400000).toISOString()).run();
  await env.DB.prepare(`UPDATE ${c.deliveries} SET status='unknown' WHERE status='sending' AND updated_at<?`).bind(new Date(Date.now()-300000).toISOString()).run();
  const { results } = await env.DB.prepare(`SELECT q.*, ${c.columns},r.watch_id FROM ${c.deliveries} q
    JOIN ${c.devices} d ON d.id=q.device_id AND d.session_id=q.session_id
    JOIN sessions s ON s.id=d.session_id AND s.user_id=d.user_id AND s.expires_at>?
    JOIN watch_runs r ON r.id=q.run_id AND r.user_id=d.user_id AND r.changed=1
    JOIN watches w ON w.id=r.watch_id AND w.user_id=d.user_id AND w.status='active'
    WHERE q.status='pending' AND q.attempts<3 AND q.next_attempt_at<=? AND q.expires_at>? ${onlyRun ? 'AND q.run_id=?' : ''}
    ORDER BY q.next_attempt_at LIMIT 20`).bind(now,now,now,...(onlyRun ? [onlyRun] : [])).all<Due>();
  for (const row of results ?? []) {
    const claimed = await env.DB.prepare(`UPDATE ${c.deliveries} SET status='sending',attempts=attempts+1,updated_at=? WHERE run_id=? AND device_id=? AND status='pending' AND session_id=?`)
      .bind(now,row.run_id,row.device_id,row.session_id).run();
    if (!claimed.meta.changes) continue;
    let status = 'unknown', reason = 'TransportUnconfirmed';
    try {
      const result = await c.send(row);
      status = result.state === 'retry' && row.attempts+1<3 ? 'pending' : result.state === 'accepted' ? 'accepted' : 'failed';
      reason = result.reason;
    } catch { /* Unknown transport outcome is not retried, to avoid duplicate notifications. */ }
    await env.DB.prepare(`UPDATE ${c.deliveries} SET status=?,reason=?,next_attempt_at=?,updated_at=? WHERE run_id=? AND device_id=? AND session_id=?`)
      .bind(status,reason,nextHour(),new Date().toISOString(),row.run_id,row.device_id,row.session_id).run();
  }
}
/** The start of the next hour: the sweep runs at hh:00 and reads the clock just after it, so "now + 1h" would wait two ticks. */
function nextHour(now = Date.now()) {
  return new Date(Math.floor((now + 3600000) / 3600000) * 3600000).toISOString();
}

export const WEB_PUSH_LIMIT = 10;
/** What /api/push/web reports to one signed-in browser. */
export async function webPushStatus(userId: string, sessionId: string) {
  if (!await webPushReady()) return { available: false, publicKey: null, subscribed: false };
  const row = await env.DB.prepare('SELECT 1 AS found FROM web_push_subscriptions WHERE user_id=? AND session_id=? LIMIT 1').bind(userId,sessionId).first();
  return { available: true, publicKey: env.VAPID_PUBLIC_KEY!.trim(), subscribed: Boolean(row) };
}
/**
 * Subscribing is idempotent per endpoint and binds it to whoever is signed in
 * now. A browser keeps one subscription per site, so a new endpoint from the
 * same session replaces its old one; past ten per account, the oldest goes.
 * Rows that move or go take their queued alerts with them.
 */
export async function subscribeWebPush(userId: string, sessionId: string, subscription: WebPushSubscription, userAgent: string) {
  const id = await sha256Hex(`web:${subscription.endpoint}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM web_push_subscriptions WHERE (session_id=? AND id<>?) OR (id=? AND session_id<>?)').bind(sessionId,id,id,sessionId),
    env.DB.prepare(`INSERT INTO web_push_subscriptions(id,user_id,session_id,endpoint,p256dh,auth,user_agent,created_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent`)
      .bind(id,userId,sessionId,subscription.endpoint,subscription.p256dh,subscription.auth,userAgent.replace(/\s+/g, ' ').trim().slice(0, 120),new Date().toISOString()),
    env.DB.prepare(`DELETE FROM web_push_subscriptions WHERE user_id=? AND id NOT IN
      (SELECT id FROM web_push_subscriptions WHERE user_id=? ORDER BY id=? DESC, created_at DESC LIMIT ?)`).bind(userId,userId,id,WEB_PUSH_LIMIT),
  ]);
}
export async function unsubscribeWebPush(userId: string, endpoint: string) {
  if (!await webPushTablesReady()) return;
  await env.DB.prepare('DELETE FROM web_push_subscriptions WHERE user_id=? AND endpoint=?').bind(userId,endpoint).run();
}
/** A test alert to this browser's own subscription, straight away rather than through the queue. */
export async function sendWebPushTest(userId: string, sessionId: string) {
  const { results } = await env.DB.prepare('SELECT id,endpoint,p256dh,auth FROM web_push_subscriptions WHERE user_id=? AND session_id=?')
    .bind(userId,sessionId).all<WebPushSubscription & { id: string }>();
  let sent = 0, removed = 0, failed = 0;
  for (const row of results ?? []) {
    const result = await deliverWeb(row.id, row, webPushTestPayload(), new Date(Date.now()+600000).toISOString()).catch(() => null);
    if (result?.state === 'accepted') sent++;
    else if (result?.state === 'invalid') removed++;
    else failed++;
  }
  return { subscriptions: results?.length ?? 0, sent, removed, failed };
}
