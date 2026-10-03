import type { APIRoute } from 'astro';
import { findUserByEmail } from '../../../lib/auth';
import { AUTH_LIMITS, clientIp, emailBucket, enforceThrottles } from '../../../lib/auth-throttle';
import { afterResponse } from '../../../lib/background';
import { COMPANY } from '../../../lib/company';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { redirectWithFlash } from '../../../lib/flash';
import { issueResetToken, resetAvailable, sendResetEmail } from '../../../lib/password-reset';

export const prerender = false;

/**
 * POST /api/auth/forgot-password — emails a one-hour, single-use reset link.
 *
 * The answer is the same whether or not the address has an account, and the
 * lookup and the email both happen after the response, so neither the body nor
 * the timing says which it was.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');

  try {
    assertSameOrigin(request);

    if (!resetAvailable()) {
      throw new HttpError(
        503,
        'email_unavailable',
        `Password reset emails are not available right now. Email ${COMPANY.email} from the address on your account and we will help you sign in.`,
      );
    }

    const body = await readBody(request);
    const email = (body.email ?? '').trim();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('Enter the email address you signed up with.', 'email');
    }

    await enforceThrottles(
      [
        { bucket: `reset-ip:${clientIp(request)}`, ...AUTH_LIMITS.resetRequestIp },
        { bucket: await emailBucket('reset-email', email), ...AUTH_LIMITS.resetRequestEmail },
      ],
      (wait) => `Several reset emails have been requested already. Check your inbox and spam folder, or try again in ${wait}.`,
    );

    const origin = new URL(request.url).origin;
    await afterResponse(
      locals,
      (async () => {
        const user = await findUserByEmail(email);
        if (!user) return;
        const token = await issueResetToken(user);
        await sendResetEmail(user.email, `${origin}/reset-password?token=${token}`);
      })().catch((error) => console.error('[password-reset] request failed', error)),
    );

    if (wantsJson) return json({ sent: true }, { headers: { 'cache-control': 'no-store' } });
    return new Response(null, { status: 303, headers: { location: '/forgot-password?sent=1' } });
  } catch (error) {
    const failure = toHttpError(error, 'auth.forgot-password', 'Could not send the reset email.');
    if (wantsJson) return failure.toResponse();
    return redirectWithFlash(request, '/forgot-password', failure.message);
  }
};
