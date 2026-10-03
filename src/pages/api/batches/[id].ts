import type { APIRoute } from 'astro';
import { batchDetail, batchDTO, ownBatch } from '../../../lib/capture-batches';
import { batchCounts, cancelBatch, requireCaptureJobs } from '../../../lib/capture-jobs';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

/**
 * GET /api/batches/:id — progress, every item, and the finished captures.
 * `changed_since` (an earlier answer's `as_of`) returns only the items that
 * moved since; the counts are always whole.
 */
export const GET: APIRoute = async ({ request, locals, params, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    await requireCaptureJobs();
    const detail = await batchDetail(
      user.id,
      params.id ?? '',
      new URL(request.url).origin,
      url.searchParams.get('changed_since'),
    );
    return json(detail, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'batches.get', 'The batch could not be read.').toResponse();
  }
};

/** POST /api/batches/:id with `action=cancel` — stop what has not started, and refund it. */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await requireCaptureJobs();
    const body = await readBody(request);
    if (body.action !== 'cancel') throw badRequest('Unknown batch action. Send `action=cancel`.', 'action');

    const batch = await ownBatch(user.id, params.id ?? '');
    await cancelBatch(user.id, batch.id, new URL(request.url).origin);
    return json(batchDTO(await ownBatch(user.id, batch.id), await batchCounts(batch.id)));
  } catch (error) {
    return toHttpError(error, 'batches.cancel', 'The batch could not be cancelled.').toResponse();
  }
};
