import type { APIRoute } from 'astro';
import { assertPublicCaptureUrl } from '../../lib/capture-options';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { APP_RATE_LIMIT, getPlan } from '../../lib/plans';
import { checkRateLimit } from '../../lib/rate-limit';
import { MAX_BATCH, runBatch, urlsFromSitemap } from '../../lib/batch';

export const prerender = false;

/** POST /api/batch — capture a list of URLs, or everything in a sitemap. */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    const body = await readBody(request);
    let urls: string[];

    if (body.sitemap) {
      const sitemap = assertPublicCaptureUrl(body.sitemap.trim());
      urls = await urlsFromSitemap(sitemap.toString(), MAX_BATCH);
      if (!urls.length) throw badRequest('That sitemap listed no pages.', 'sitemap');
    } else {
      urls = (body.urls ?? '')
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!urls.length) throw badRequest('Send `urls` or a `sitemap`.', 'urls');
    }

    // The burst limit is charged for the whole batch, not per page — otherwise
    // a batch is the way around it.
    const limit = APP_RATE_LIMIT[user.plan] ?? APP_RATE_LIMIT.free;
    const rate = await checkRateLimit(`app:${user.id}`, limit, 3600, urls.length);
    if (!rate.ok) {
      throw new HttpError(
        429,
        'rate_limited',
        `That batch needs ${urls.length} of the ${limit} captures an hour on the ${getPlan(user.plan).name} plan, and ${rate.remaining} are left.`,
      );
    }

    const shared: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== 'urls' && key !== 'sitemap' && key !== 'url') shared[key] = value;
    }

    const result = await runBatch(user, urls, shared, new URL(request.url).origin, 'app');
    return json(result, { status: 201 });
  } catch (error) {
    return toHttpError(error, 'batch.create', 'The batch could not be run.').toResponse();
  }
};
