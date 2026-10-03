import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { assertVerified } from '../../../../lib/verification';
import { checkRateLimit } from '../../../../lib/rate-limit';
import { requireProjects } from '../../../../lib/projects';
import { resetSignoff } from '../../../../lib/signoff';
export const prerender = false;
/** POST /api/reports/:id/signoff with action=reset — the owner puts a report back to awaiting sign-off. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    await requireProjects();
    if (!(await checkRateLimit(`projects:${locals.user.id}`, 120, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many updates. Try again later.');
    if ((await readBody(request)).action !== 'reset') throw badRequest('Unknown sign-off action.');
    return json(await resetSignoff(locals.user.id, params.id ?? ''), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'report.signoff-reset', 'Could not reset the sign-off.').toResponse();
  }
};
