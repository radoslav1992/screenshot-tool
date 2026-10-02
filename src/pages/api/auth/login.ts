import type { APIRoute } from 'astro';
import {
  createSession,
  findUserByEmail,
  isSecureRequest,
  sessionCookie,
  toSessionUser,
  verifyPasswordEvenly,
} from '../../../lib/auth';
import { AUTH_LIMITS, clientIp, emailBucket, enforceThrottles } from '../../../lib/auth-throttle';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { safeNext } from '../../../lib/safe-next';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const origin = new URL(request.url).origin;
  let next = '/app';

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    next = safeNext(body.next, origin);
    const email = (body.email ?? '').trim();

    // Before the lookup, so a throttled guess learns nothing — not even timing.
    await enforceThrottles(
      [
        { bucket: `login-ip:${clientIp(request)}`, ...AUTH_LIMITS.loginIp },
        { bucket: await emailBucket('login-email', email), ...AUTH_LIMITS.loginEmail },
      ],
      (wait) => `Too many sign-in attempts. Wait ${wait} and try again, or reset your password.`,
    );

    const row = email ? await findUserByEmail(email) : null;
    // An unknown email still pays for a full PBKDF2 run, so the response time
    // does not give away which addresses have accounts.
    const ok = await verifyPasswordEvenly(body.password ?? '', row?.password_hash);

    if (!row || !ok) {
      // Same message either way so the form can't be used to enumerate accounts.
      throw new HttpError(401, 'invalid_credentials', 'That email and password combination is not right.');
    }

    const user = toSessionUser(row);
    const { token, expiresAt } = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(token, expiresAt, isSecureRequest(request));

    if (wantsJson) {
      return json({ user: { id: user.id, email: user.email, name: user.name }, redirect: next }, {
        headers: { 'set-cookie': cookie },
      });
    }
    return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
  } catch (error) {
    const httpError = toHttpError(error, 'login', 'Could not sign you in.');
    if (wantsJson) return httpError.toResponse();
    // Keep `next` so a second attempt still lands where the first was going.
    const back = new URLSearchParams({ error: httpError.message });
    if (next !== '/app') back.set('next', next);
    return new Response(null, { status: 303, headers: { location: `/login?${back}` } });
  }
};
