import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, readBody, json } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { collaborationAction } from '../../lib/collaboration';
import { checkRateLimit } from '../../lib/rate-limit';
export const prerender = false;
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    if (!(await checkRateLimit(`collaboration:${locals.user.id}`, 60, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many updates. Try again later.');
    return json(await collaborationAction(locals.user, await readBody(request), new URL(request.url).origin), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (e) {
    return toHttpError(e, 'collaboration.update', 'Could not update collaboration.').toResponse();
  }
};
