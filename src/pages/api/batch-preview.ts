import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, readBody, json, badRequest } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { assertPublicCaptureUrl } from '../../lib/capture-options';
import { urlsFromSitemap, MAX_BATCH } from '../../lib/batch';
import { captureJobsReady } from '../../lib/capture-jobs';
import { batchLimit } from '../../lib/plans';
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
    // A background batch previews up to its plan's size, and reads a sitemap only
    // as far as a launch check's two shots per page leave room for; the
    // synchronous queue keeps to MAX_BATCH.
    const background = b.background === '1' && (await captureJobsReady());
    const cap = background ? batchLimit(locals.user.plan) : MAX_BATCH;
    const raw = b.sitemap
      ? await urlsFromSitemap(b.sitemap, background && b.launch ? Math.max(1, Math.floor(cap / 2)) : cap)
      : (b.urls ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    const urls = [...new Set(raw.map((url) => assertPublicCaptureUrl(url).toString()))];
    if (!urls.length || urls.length > cap) throw badRequest(`Choose 1–${cap} unique URLs, one per line.`);
    return json({ urls }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'batch.preview', 'Could not preview these pages.').toResponse();
  }
};
