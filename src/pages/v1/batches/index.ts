import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight, touchApiKey } from '../../../lib/api-guard';
import { createBatch, listBatches, readBatchRequest } from '../../../lib/capture-batches';
import { requireCaptureJobs } from '../../../lib/capture-jobs';
import { json, readBody } from '../../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/** GET /v1/batches?limit= — recent background batches, newest first. */
export const GET: APIRoute = async ({ request, url }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;
    await requireCaptureJobs();

    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    return json({ object: 'list', data: await listBatches(guard.auth.user.id, limit) }, { headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};

/**
 * POST /v1/batches
 *
 * `urls` (newline- or comma-separated, or a JSON array) or `sitemap`, plus
 * `devices`, `label` and `notify`. Every other parameter is the same as
 * `/v1/capture` and applies to each page. Answers 202 at once; the pages are
 * captured in the background — poll GET /v1/batches/:id.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;
    await requireCaptureJobs();

    const body = await readBody(request);
    locals.cfContext?.waitUntil(touchApiKey(guard.auth.keyId));

    const batch = await createBatch(guard.auth.user, await readBatchRequest(body, guard.auth.user), 'api');
    return json(batch, { status: 202, headers: { ...headers, location: `/v1/batches/${batch.id}` } });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
