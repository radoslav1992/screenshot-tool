import type { APIRoute } from 'astro';
import { parseCaptureOptions } from '../../../lib/capture-options';
import { createCaptureRow, listCaptures, runCapture, toDTO } from '../../../lib/captures';
import { asksForAsync, captureJobsReady, enqueueCapture } from '../../../lib/capture-jobs';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { APP_RATE_LIMIT, getPlan } from '../../../lib/plans';
import { checkRateLimit } from '../../../lib/rate-limit';

export const prerender = false;

/**
 * Background captures still queued or running are left out unless
 * `include_pending=1`: the iOS app reads this list and shows anything that is
 * not done as a failure.
 */
export const GET: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const rows = await listCaptures(user.id, {
    mode: url.searchParams.get('mode') ?? undefined,
    collection: url.searchParams.get('collection') === 'regular' ? 'regular'
      : url.searchParams.get('collection') === 'monitors' ? 'monitors' : undefined,
    watchId: url.searchParams.get('watch_id') ?? undefined,
    changedOnly: url.searchParams.get('changed') === '1',
    offset: Number.parseInt(url.searchParams.get('offset') ?? '0', 10),
    limit: Number.parseInt(url.searchParams.get('limit') ?? '30', 10),
    cursor: url.searchParams.get('cursor') ?? undefined,
    includePending: url.searchParams.get('include_pending') === '1',
  });

  return json({ data: rows.map((row) => toDTO(row, new URL(request.url).origin)) });
};

/**
 * Synchronous unless the caller asks otherwise (see asksForAsync): the iOS app
 * sends neither flag and waits for the finished capture, exactly as before.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    // The monthly quota bounds the total; this bounds the burst, so one account
    // cannot spend its allowance at once and monopolise the render pool.
    const limit = APP_RATE_LIMIT[user.plan] ?? APP_RATE_LIMIT.free;
    const rate = await checkRateLimit(`app:${user.id}`, limit, 3600);
    if (!rate.ok) {
      const minutes = Math.max(1, Math.ceil(rate.resetSeconds / 60));
      throw new HttpError(
        429,
        'rate_limited',
        `You can start ${limit} captures per hour on the ${getPlan(user.plan).name} plan. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    const body = await readBody(request);
    const options = parseCaptureOptions(body);
    const origin = new URL(request.url).origin;

    // Like any preference, it may be declined: until the queue's tables exist
    // the capture runs here, as it always has, and answers finished.
    if (asksForAsync(request, body) && (await captureJobsReady())) {
      const queued = await enqueueCapture(user, options, body, 'app');
      return json(toDTO(queued, origin), {
        status: 202,
        headers: { 'preference-applied': 'respond-async', location: `/api/captures/${queued.id}` },
      });
    }

    const row = await createCaptureRow(user, options, 'app');
    const finished = await runCapture(row, options);
    return json(toDTO(finished, origin), { status: finished.status === 'done' ? 201 : 200 });
  } catch (error) {
    return toHttpError(error, 'captures.create', 'The capture could not be started.').toResponse();
  }
};
