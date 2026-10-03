import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight } from '../../../lib/api-guard';
import { batchDetail, batchDTO, ownBatch } from '../../../lib/capture-batches';
import { batchCounts, cancelBatch, requireCaptureJobs } from '../../../lib/capture-jobs';
import { badRequest, json, readBody } from '../../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/** GET /v1/batches/:id?changed_since= — progress, items and finished captures. */
export const GET: APIRoute = async ({ request, params, url }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;
    await requireCaptureJobs();

    const detail = await batchDetail(
      guard.auth.user.id,
      params.id ?? '',
      new URL(request.url).origin,
      url.searchParams.get('changed_since'),
    );
    return json(detail, { headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};

/** POST /v1/batches/:id with `action=cancel` — stop what has not started, and refund it. */
export const POST: APIRoute = async ({ request, params }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;
    await requireCaptureJobs();

    const body = await readBody(request);
    if (body.action !== 'cancel') throw badRequest('Unknown batch action. Send `action=cancel`.', 'action');

    const userId = guard.auth.user.id;
    const batch = await ownBatch(userId, params.id ?? '');
    await cancelBatch(userId, batch.id, new URL(request.url).origin);
    return json(batchDTO(await ownBatch(userId, batch.id), await batchCounts(batch.id)), { headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
