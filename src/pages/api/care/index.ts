import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { checkRateLimit } from '../../../lib/rate-limit';
import { careAction, requireCare } from '../../../lib/care-reports';
import { CARE_LIMITS } from '../../../lib/care-rules';
export const prerender = false;
/**
 * POST /api/care — a project's care reports: `settings` and `generate`, and
 * for one report `link`, `extend`, `revoke`, `send` and `delete`. Same-origin
 * and signed in, the owner only (lib/care-reports.ts); a 404 before 0021.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await requireCare();
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    const { limit, windowSeconds } = CARE_LIMITS.actions;
    if (!(await checkRateLimit(`care:${locals.user.id}`, limit, windowSeconds)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many updates. Try again later.');
    return json(await careAction(locals.user, await readBody(request), new URL(request.url).origin), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return toHttpError(error, 'care.update', 'Could not update the care report.').toResponse();
  }
};
