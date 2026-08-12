import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight, touchApiKey } from '../../lib/api-guard';
import { assertPublicCaptureUrl } from '../../lib/capture-options';
import { badRequest, json, readBody } from '../../lib/http';
import { MAX_BATCH, runBatch, urlsFromSitemap } from '../../lib/batch';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/**
 * POST /v1/batch
 *
 * `urls` (comma- or newline-separated, or a JSON array) or `sitemap` (a URL to
 * a sitemap.xml). Every other parameter is the same as `/v1/capture` and
 * applies to each page.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const body = await readBody(request);
    const origin = new URL(request.url).origin;

    let urls: string[] = [];

    if (body.sitemap) {
      // Validated like any capture target, so a sitemap cannot be the way in to
      // a private address.
      const sitemap = assertPublicCaptureUrl(body.sitemap.trim());
      urls = await urlsFromSitemap(sitemap.toString(), MAX_BATCH);
      if (!urls.length) throw badRequest('That sitemap listed no pages.', 'sitemap');
    } else {
      const raw = (body.urls ?? '').trim();
      if (!raw) throw badRequest('Send `urls` or a `sitemap`.', 'urls');
      urls = (raw.startsWith('[') ? (JSON.parse(raw) as string[]) : raw.split(/[\n,]/))
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }

    const shared: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== 'urls' && key !== 'sitemap' && key !== 'url') shared[key] = value;
    }

    locals.cfContext?.waitUntil(touchApiKey(guard.auth.keyId));

    const result = await runBatch(guard.auth.user, urls, shared, origin, 'api');
    return json(result, { status: 201, headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
