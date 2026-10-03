import type { APIRoute } from 'astro';
import { ATTRIBUTION_COOKIE, parseAttribution, referralCookie } from '../../lib/attribution';
import { clientIp } from '../../lib/auth-throttle';
import { referrerOf } from '../../lib/growth';
import { checkRateLimit } from '../../lib/rate-limit';

export const prerender = false;

/** Referral links a single address may open in an hour: plenty for a person, little for a script walking codes. */
export const JOIN_LIMIT = { limit: 30, windowSeconds: 3600 };

/**
 * GET /join/<code> — a referral link. Notes who invited the visitor in the
 * attribution cookie (lib/attribution.ts) and sends them to sign up, where
 * the offer is explained. An unknown code, or a deployment without migration
 * 0017, goes to the same signup page with nothing noted.
 */
export const GET: APIRoute = async ({ params, request, locals, cookies, url }) => {
  const headers = new Headers({ 'cache-control': 'no-store', location: '/signup' });
  if (locals.user) {
    headers.set('location', '/app/account#invite');
    return new Response(null, { status: 302, headers });
  }

  const rate = await checkRateLimit(`join-ip:${clientIp(request)}`, JOIN_LIMIT.limit, JOIN_LIMIT.windowSeconds);
  if (!rate.ok) {
    return new Response('Too many referral links opened from this address. Try again later.', {
      status: 429,
      headers: { 'retry-after': String(rate.resetSeconds), 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const code = (params.code ?? '').toLowerCase();
  const referrer = await referrerOf(code).catch((error) => {
    console.error('[join] referral code lookup failed', error);
    return null;
  });
  if (referrer) {
    const cookie = referralCookie(parseAttribution(cookies.get(ATTRIBUTION_COOKIE)?.value), code, url.protocol === 'https:');
    if (cookie) headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};
