import type { APIRoute } from 'astro';
import { parseCaptureOptions } from '../../lib/capture-options';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { APP_RATE_LIMIT, getPlan } from '../../lib/plans';
import { checkRateLimit } from '../../lib/rate-limit';
import { compareCaptures, splitCompareInput } from '../../lib/compare';

export const prerender = false;

/**
 * POST /api/compare — capture two pages and measure the difference.
 *
 * Both sides take the same capture parameters, prefixed `a_` and `b_`, so a
 * comparison can be made at a phone viewport or a desktop one without a second
 * vocabulary to learn. Anything not prefixed applies to both, except the
 * credentials (`headers`, `cookies`, `basic_auth`), which must name their side.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    const limit = APP_RATE_LIMIT[user.plan] ?? APP_RATE_LIMIT.free;
    // Two captures, so it costs two against the burst limit.
    const rate = await checkRateLimit(`app:${user.id}`, limit, 3600, 2);
    if (!rate.ok) {
      const minutes = Math.max(1, Math.ceil(rate.resetSeconds / 60));
      throw new HttpError(
        429,
        'rate_limited',
        `You can start ${limit} captures per hour on the ${getPlan(user.plan).name} plan. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    const body = await readBody(request);
    const { before: beforeInput, after: afterInput } = splitCompareInput(body);

    const before = parseCaptureOptions(beforeInput);
    const after = parseCaptureOptions(afterInput);

    if (before.mode === 'series' || after.mode === 'series') {
      throw badRequest('A scroll series has no single frame to compare.', 'mode');
    }
    if (before.format === 'pdf' || after.format === 'pdf') {
      throw badRequest('Comparison works on images. Choose PNG or JPG.', 'format');
    }

    const result = await compareCaptures(user, before, after, new URL(request.url).origin);
    return json(result, { status: 201 });
  } catch (error) {
    return toHttpError(error, 'compare.create', 'The comparison could not be run.').toResponse();
  }
};
