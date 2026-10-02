import type { APIRoute } from 'astro';
import { RateLimitedError } from '../../../lib/auth-throttle';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { safeNext } from '../../../lib/safe-next';
import { toHttpError } from '../../../lib/errors';
import { checkRateLimit } from '../../../lib/rate-limit';
import {
  confirmationEmailsEnabled,
  hasConfirmedEmail,
  issueVerificationToken,
  sendVerificationEmail,
} from '../../../lib/verification';

export const prerender = false;

/**
 * POST /api/auth/resend-verification — emails a fresh confirmation link.
 *
 * Works whenever mail can be sent, whether or not captures require a confirmed
 * address: accepting a team invitation and receiving digests always do.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);

    // Nothing can be delivered, so there is nothing to ask for.
    if (!confirmationEmailsEnabled()) {
      return json({ sent: false, reason: 'not_required' });
    }
    if (await hasConfirmedEmail(user.id)) {
      return json({ sent: false, reason: 'already_verified' });
    }

    // Sending mail costs money and annoys the recipient; cap the retries.
    const rate = await checkRateLimit(`verify:${user.id}`, 3, 3600);
    if (!rate.ok) {
      throw new RateLimitedError(
        'You have requested several confirmation emails already. Check your spam folder, then try again later.',
        rate.resetSeconds,
      );
    }

    // Optional `next`: the page to return to once confirmed. Clients that send
    // no body at all (the web banner, the iOS app) are fine.
    const origin = new URL(request.url).origin;
    const body = await readBody(request).catch(() => ({}) as Record<string, string>);
    const next = body.next ? safeNext(body.next, origin) : undefined;

    const issued = await issueVerificationToken(user, origin, next);
    const sent = await sendVerificationEmail(user.email, issued.link);

    return json({ sent, email: user.email });
  } catch (error) {
    return toHttpError(error, 'auth.resend-verification', 'Could not send the confirmation email.').toResponse();
  }
};
