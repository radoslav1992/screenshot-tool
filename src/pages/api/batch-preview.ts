import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, readBody, json, badRequest } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { assertPublicCaptureUrl } from '../../lib/capture-options';
import { urlsFromSitemap, MAX_BATCH } from '../../lib/batch';
import { checkRateLimit } from '../../lib/rate-limit';
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    if (!(await checkRateLimit(`batch-preview:${locals.user.id}`, 20, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many previews. Try again later.');
    const b = await readBody(request);
    const raw = b.sitemap
      ? await urlsFromSitemap(b.sitemap, MAX_BATCH)
      : (b.urls ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    const urls = [...new Set(raw.map((url) => assertPublicCaptureUrl(url).toString()))];
    if (!urls.length || urls.length > MAX_BATCH) throw badRequest(`Choose 1–${MAX_BATCH} unique URLs, one per line.`);
    return json({ urls }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'batch.preview', 'Could not preview these pages.').toResponse();
  }
};
