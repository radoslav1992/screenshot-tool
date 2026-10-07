import type { APIRoute } from 'astro';
import { SESSION_COOKIE } from '../../../../lib/auth';
import { sha256Hex } from '../../../../lib/ids';
import { subscribeWebPush, unsubscribeWebPush, webPushReady, webPushStatus } from '../../../../lib/push';
import { keyOnCurve, parseSubscription, pushEndpointAllowed } from '../../../../lib/web-push';
import { HttpError, assertSameOrigin, readBody, json } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { checkRateLimit } from '../../../../lib/rate-limit';
export const prerender = false;
/**
 * Web Push for the signed-in browser: whether it is on offer, the key to
 * subscribe with, and whether this session already is. Cookie sessions only:
 * a subscription belongs to the browser that made it, and signing out ends it.
 */
const NO_STORE = { 'cache-control': 'no-store' };
const sessionOf = async (value: string | undefined) => (value ? sha256Hex(value) : null);
export const GET: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    const sessionId = await sessionOf(cookies.get(SESSION_COOKIE)?.value);
    if (!sessionId) throw new HttpError(401,'unauthorized','Sign in first.');
    return json(await webPushStatus(locals.user.id,sessionId), { headers: NO_STORE });
  } catch (error) { return toHttpError(error,'webpush.status','Could not read push alert settings.').toResponse(); }
};
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    const sessionId = await sessionOf(cookies.get(SESSION_COOKIE)?.value);
    if (!sessionId) throw new HttpError(401,'unauthorized','Sign in first.');
    if (!await webPushReady()) throw new HttpError(503,'setup_required','Push alerts are not configured yet.');
    const rate = await checkRateLimit(`webpush:${locals.user.id}`,60,3600);
    if (!rate.ok) throw new HttpError(429,'rate_limited','Please wait before changing push alerts again.');
    const body = await readBody(request);
    if (!pushEndpointAllowed(body.endpoint)) throw new HttpError(400,'invalid_request','This push service is not supported.','endpoint');
    const subscription = parseSubscription(body);
    if (!subscription || !await keyOnCurve(subscription.p256dh)) throw new HttpError(400,'invalid_request','Invalid push subscription keys.','keys');
    await subscribeWebPush(locals.user.id,sessionId,subscription,request.headers.get('user-agent') ?? '');
    return json({ subscribed: true }, { headers: NO_STORE });
  } catch (error) { return toHttpError(error,'webpush.subscribe','Could not turn on push alerts.').toResponse(); }
};
export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    const body = await readBody(request);
    if (typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 2048) throw new HttpError(400,'invalid_request','Which subscription?','endpoint');
    await unsubscribeWebPush(locals.user.id,body.endpoint);
    return json({ subscribed: false }, { headers: NO_STORE });
  } catch (error) { return toHttpError(error,'webpush.unsubscribe','Could not turn off push alerts.').toResponse(); }
};
