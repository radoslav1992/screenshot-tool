import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { checkRateLimit } from '../../../lib/rate-limit';
import { isVerified, issueVerificationToken, sendVerificationEmail, verificationEnabled } from '../../../lib/verification';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);

    if (!verificationEnabled()) {
      return json({ sent: false, reason: 'not_required' });
    }
    if (await isVerified(user.id)) {
      return json({ sent: false, reason: 'already_verified' });
    }

    // Sending mail costs money and annoys the recipient; cap the retries.
    const rate = await checkRateLimit(`verify:${user.id}`, 3, 3600);
    if (!rate.ok) {
      throw new HttpError(
        429,
        'rate_limited',
        'You have requested several confirmation emails already. Check your spam folder, then try again later.',
      );
    }

    const issued = await issueVerificationToken(user, new URL(request.url).origin);
    const sent = await sendVerificationEmail(user.email, issued.link);

    return json({ sent, email: user.email });
  } catch (error) {
    return toHttpError(error, 'auth.resend-verification', 'Could not send the confirmation email.').toResponse();
  }
};
