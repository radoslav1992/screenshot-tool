import type { APIRoute } from 'astro';
import { SESSION_COOKIE, endSessions } from '../../../lib/auth';
import { HttpError, assertSameOrigin, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { redirectWithFlash } from '../../../lib/flash';

export const prerender = false;

/**
 * POST /api/auth/sign-out-others — ends every session but this one: the phone
 * that was lost, the shared computer, the iOS app on an old device.
 */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const user = locals.user;
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const current = cookies.get(SESSION_COOKIE)?.value;
    // Without the current cookie there is nothing to keep, and ending every
    // session would sign this one out too — which is not what was asked.
    if (!current) throw new HttpError(401, 'unauthorized', 'Sign in first.');

    const ended = await endSessions(user.id, current);
    if (wantsJson) return json({ signed_out: ended }, { headers: { 'cache-control': 'no-store' } });
    return new Response(null, { status: 303, headers: { location: `/app/account?signed_out=${ended}` } });
  } catch (error) {
    const failure = toHttpError(error, 'auth.sign-out-others', 'Could not sign out your other devices.');
    if (wantsJson) return failure.toResponse();
    return redirectWithFlash(request, '/app/account', failure.message);
  }
};
