import type { APIRoute } from 'astro';
import { createBatch, listBatches, readBatchRequest } from '../../../lib/capture-batches';
import { requireCaptureJobs } from '../../../lib/capture-jobs';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';

export const prerender = false;

/** GET /api/batches — recent background batches with their progress. */
export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    await requireCaptureJobs();
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
    return json({ data: await listBatches(user.id, limit) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'batches.list', 'The batches could not be listed.').toResponse();
  }
};

/**
 * POST /api/batches — queue a list of URLs, or everything in a sitemap, to be
 * captured in the background. Answers 202 at once; poll GET /api/batches/:id.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);
    await requireCaptureJobs();

    const batch = await createBatch(user, await readBatchRequest(await readBody(request), user), 'app');
    return json(batch, { status: 202, headers: { location: `/api/batches/${batch.id}` } });
  } catch (error) {
    return toHttpError(error, 'batches.create', 'The batch could not be queued.').toResponse();
  }
};
