import type { APIRoute } from 'astro';
import { afterResponse } from '../../../lib/background';
import { checkNewPassword, createSession, createUser, isSecureRequest, sessionCookie } from '../../../lib/auth';
import { AUTH_LIMITS, clientIp, emailBucket, enforceThrottles } from '../../../lib/auth-throttle';
import { assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { redirectWithFlash } from '../../../lib/flash';
import { safeNext } from '../../../lib/safe-next';
import { confirmationEmailsEnabled, issueVerificationToken, sendVerificationEmail } from '../../../lib/verification';
import { ATTRIBUTION_COOKIE, clearedAttributionCookie } from '../../../lib/attribution';
import { recordSignup } from '../../../lib/growth';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, cookies }) => {
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

    // Where the account came from (lib/growth.ts), once migration 0017 exists.
    // Like the email, never a reason for the signup itself to fail.
    const attribution = cookies.get(ATTRIBUTION_COOKIE)?.value;
    const recorded = await recordSignup(user, request, attribution).catch((error) => {
      console.error('[signup] signup source not recorded', error);
      return false;
    });

    const { token, expiresAt } = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(token, expiresAt, isSecureRequest(request));

    const response = wantsJson
      ? json({ user: { id: user.id, email: user.email, name: user.name }, redirect: next }, {
          status: 201,
          headers: { 'set-cookie': cookie },
        })
      : new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
    // Saved with the account, so it is done with; another signup in this browser starts afresh.
    if (recorded && attribution !== undefined) {
      response.headers.append('set-cookie', clearedAttributionCookie(isSecureRequest(request)));
    }
    return response;
  } catch (error) {
    const httpError = toHttpError(error, 'signup', 'Could not create the account.');
    if (wantsJson) return httpError.toResponse();
    const back = next === '/app' ? '/signup' : `/signup?${new URLSearchParams({ next })}`;
    return redirectWithFlash(request, back, httpError.message);
  }
};
