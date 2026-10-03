import type { APIRoute } from 'astro';
import { checkNewPassword, createSession, isSecureRequest, replacePassword, sessionCookie, toSessionUser } from '../../../lib/auth';
import { AUTH_LIMITS, clientIp, enforceThrottles } from '../../../lib/auth-throttle';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { redirectWithFlash } from '../../../lib/flash';
import { discardResetToken, findResetUser } from '../../../lib/password-reset';

export const prerender = false;

/**
 * POST /api/auth/reset-password — sets a new password from an emailed link.
 *
 * Every existing session ends, on every device, and the person is signed in
 * afresh here: whoever had the old password, or a session made with it, is out.
 */
export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  let token = '';

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    token = (body.token ?? '').trim();
    const password = body.password ?? '';

    await enforceThrottles(
      [{ bucket: `reset-complete-ip:${clientIp(request)}`, ...AUTH_LIMITS.resetCompleteIp }],
      (wait) => `Too many attempts. Wait ${wait} and try again.`,
    );

    const expired = () =>
      new HttpError(400, 'invalid_token', 'This reset link has expired or has already been used. Request a new one.', 'token');

    const row = await findResetUser(token);
    if (!row) throw expired();
    checkNewPassword(password);

    // Only lands if the password is still the one the link was issued against,
    // so a link submitted twice at once still works exactly once.
    const outcome = await replacePassword(row.id, password, { expectedHash: row.password_hash, confirmEmail: true });
    if (!outcome.replaced) throw expired();
    // Already dead — the password it was issued against is gone — but there is
    // no reason to keep it around until it expires.
    await discardResetToken(token).catch(() => undefined);

    const user = toSessionUser(row);
    const session = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(session.token, session.expiresAt, isSecureRequest(request));
    console.log(`[password-reset] ${user.id} reset their password; all sessions ended`);

    if (wantsJson) {
      return json(
        { user: { id: user.id, email: user.email, name: user.name }, redirect: '/app/account?password=reset' },
        { headers: { 'set-cookie': cookie, 'cache-control': 'no-store' } },
      );
    }
    return new Response(null, {
      status: 303,
      headers: { location: '/app/account?password=reset', 'set-cookie': cookie },
    });
  } catch (error) {
    const failure = toHttpError(error, 'auth.reset-password', 'Could not reset your password.');
    if (wantsJson) return failure.toResponse();
    const back = token && failure.type !== 'invalid_token' ? `/reset-password?${new URLSearchParams({ token })}` : '/reset-password';
    return redirectWithFlash(request, back, failure.message);
  }
};
