import type { APIRoute } from 'astro';
import { afterResponse } from '../../../lib/background';
import { checkNewPassword, createSession, createUser, isSecureRequest, sessionCookie } from '../../../lib/auth';
import { AUTH_LIMITS, clientIp, emailBucket, enforceThrottles } from '../../../lib/auth-throttle';
import { assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { safeNext } from '../../../lib/safe-next';
import { confirmationEmailsEnabled, issueVerificationToken, sendVerificationEmail } from '../../../lib/verification';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const origin = new URL(request.url).origin;
  let next = '/app';

  try {
    assertSameOrigin(request);
    const body = await readBody(request);

    const email = (body.email ?? '').trim();
    const password = body.password ?? '';
    next = safeNext(body.next, origin);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('Enter a valid email address.', 'email');
    }
    checkNewPassword(password);

    // "Already registered" is a deliberate answer, so the throttle is what
    // keeps it from being a fast way to test a list of addresses.
    await enforceThrottles(
      [
        { bucket: `signup-ip:${clientIp(request)}`, ...AUTH_LIMITS.signupIp },
        { bucket: await emailBucket('signup-email', email), ...AUTH_LIMITS.signupEmail },
      ],
      (wait) => `Too many sign-up attempts. Wait ${wait} and try again.`,
    );

    const user = await createUser({ email, password, name: body.name });

    // Sent whenever mail works, not only when captures wait on it: team
    // invitations and digests need a confirmed address either way. The account
    // exists by now, so a hiccup here must not turn into a failed signup — the
    // email can be sent again from the app.
    if (confirmationEmailsEnabled()) {
      await afterResponse(
        locals,
        issueVerificationToken(user, origin)
          .then((issued) => sendVerificationEmail(user.email, issued.link))
          .catch((error) => console.error('[signup] confirmation email failed', error)),
      );
    }

    const { token, expiresAt } = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(token, expiresAt, isSecureRequest(request));

    if (wantsJson) {
      return json({ user: { id: user.id, email: user.email, name: user.name }, redirect: next }, {
        status: 201,
        headers: { 'set-cookie': cookie },
      });
    }
    return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
  } catch (error) {
    const httpError = toHttpError(error, 'signup', 'Could not create the account.');
    if (wantsJson) return httpError.toResponse();
    const back = new URLSearchParams({ error: httpError.message });
    if (next !== '/app') back.set('next', next);
    return new Response(null, { status: 303, headers: { location: `/signup?${back}` } });
  }
};
