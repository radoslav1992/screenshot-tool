import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SESSION_COOKIE, checkNewPassword, replacePassword, verifyPassword } from '../../../lib/auth';
import { AUTH_LIMITS, enforceThrottles } from '../../../lib/auth-throttle';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { redirectWithFlash } from '../../../lib/flash';

export const prerender = false;

/**
 * POST /api/auth/change-password — `{ current_password, password }`.
 *
 * Asks for the current password, so a session cookie on its own cannot lock
 * the owner out. Every other session ends; this one carries on.
 */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const user = locals.user;
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    const current = body.current_password ?? '';
    const password = body.password ?? '';

    await enforceThrottles(
      [{ bucket: `password-change:${user.id}`, ...AUTH_LIMITS.passwordChangeUser }],
      (wait) => `Too many attempts. Wait ${wait} and try again, or reset your password from the sign-in page.`,
    );

    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .bind(user.id)
      .first<{ password_hash: string | null }>();
    if (!row?.password_hash) {
      throw badRequest('This account has no password yet. Use “Forgot password?” on the sign-in page to set one.');
    }
    if (!current) throw badRequest('Enter your current password.', 'current_password');
    if (!(await verifyPassword(current, row.password_hash))) {
      throw new HttpError(403, 'invalid_credentials', 'Your current password is not right.', 'current_password');
    }
    checkNewPassword(password);
    if (password === current) throw badRequest('Choose a password different from the current one.', 'password');

    const outcome = await replacePassword(user.id, password, {
      expectedHash: row.password_hash,
      keepSessionToken: cookies.get(SESSION_COOKIE)?.value,
    });
    if (!outcome.replaced) {
      throw new HttpError(409, 'conflict', 'Your password was changed somewhere else just now. Reload and try again.');
    }

    if (wantsJson) {
      return json({ changed: true, signed_out: outcome.sessionsEnded }, { headers: { 'cache-control': 'no-store' } });
    }
    return new Response(null, { status: 303, headers: { location: '/app/account?password=changed' } });
  } catch (error) {
    const failure = toHttpError(error, 'auth.change-password', 'Could not change your password.');
    if (wantsJson) return failure.toResponse();
    return redirectWithFlash(request, '/app/account', failure.message);
  }
};
