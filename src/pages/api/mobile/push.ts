import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SESSION_COOKIE } from '../../../lib/auth';
import { sha256Hex } from '../../../lib/ids';
import { pushReady } from '../../../lib/push';
import { HttpError, assertSameOrigin, readBody, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { checkRateLimit } from '../../../lib/rate-limit';
export const prerender = false;
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return new HttpError(401,'unauthorized','Sign in first.').toResponse();
  return json({ available: await pushReady() }, { headers: { 'cache-control': 'no-store' } });
};
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    if (!await pushReady()) throw new HttpError(503,'setup_required','Push notifications are not configured yet.');
    const rate = await checkRateLimit(`push:${locals.user.id}`,60,3600);
    if (!rate.ok) throw new HttpError(429,'rate_limited','Please wait before updating notifications again.');
    const body = await readBody(request);
    const token = (body.token ?? '').toLowerCase();
    if (!/^[a-f0-9]{32,512}$/.test(token) || token.length % 2) throw new HttpError(400,'invalid_request','Invalid device token.');
    if (!['sandbox','production'].includes(body.environment)) throw new HttpError(400,'invalid_request','Invalid APNs environment.');
    const sessionId = await sha256Hex(cookies.get(SESSION_COOKIE)!.value);
    const id = await sha256Hex(`${body.environment}:${token}`);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE user_id=? AND session_id<>? AND id<>?').bind(locals.user.id,sessionId,id).first<{n:number}>();
    if ((count?.n ?? 0) >= 10) throw new HttpError(409,'device_limit','Sign out on another device before enabling more devices.');
    // Replace old token/session registrations and their queued deliveries atomically.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM push_devices WHERE (session_id=? AND id<>?) OR (id=? AND session_id<>?)').bind(sessionId,id,id,sessionId),
      env.DB.prepare('INSERT INTO push_devices(id,user_id,session_id,token,environment,registered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET registered_at=excluded.registered_at').bind(id,locals.user.id,sessionId,token,body.environment,new Date().toISOString()),
    ]);
    return json({ registered: true });
  } catch (error) { return toHttpError(error,'push.register','Could not enable push notifications.').toResponse(); }
};
export const DELETE: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    const exists = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_devices'").first();
    if (exists) await env.DB.prepare('DELETE FROM push_devices WHERE user_id=? AND session_id=?').bind(locals.user.id,await sha256Hex(cookies.get(SESSION_COOKIE)!.value)).run();
    return json({ registered: false });
  } catch (error) { return toHttpError(error,'push.disable','Could not disable push notifications.').toResponse(); }
};
