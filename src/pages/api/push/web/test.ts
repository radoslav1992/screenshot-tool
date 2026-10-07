import type { APIRoute } from 'astro';
import { SESSION_COOKIE } from '../../../../lib/auth';
import { sha256Hex } from '../../../../lib/ids';
import { sendWebPushTest, webPushReady } from '../../../../lib/push';
import { HttpError, assertSameOrigin, json } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { checkRateLimit } from '../../../../lib/rate-limit';
export const prerender = false;
/** A test alert to this browser's own subscription. Five an hour: each is a request to someone else's push service. */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
    assertSameOrigin(request);
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new HttpError(401,'unauthorized','Sign in first.');
    if (!await webPushReady()) throw new HttpError(503,'setup_required','Push alerts are not configured yet.');
    const rate = await checkRateLimit(`webpush-test:${locals.user.id}`,5,3600);
    if (!rate.ok) throw new HttpError(429,'rate_limited','That is enough test alerts for now. Try again within the hour.');
    const result = await sendWebPushTest(locals.user.id,await sha256Hex(token));
    if (!result.subscriptions) throw new HttpError(409,'not_subscribed','Turn on alerts on this device first.');
    return json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return toHttpError(error,'webpush.test','Could not send a test alert.').toResponse(); }
};
