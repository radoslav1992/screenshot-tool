import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight, touchApiKey } from '../../lib/api-guard';
import { parseCaptureOptions } from '../../lib/capture-options';
import { badRequest, json, readBody } from '../../lib/http';
import { compareCaptures, splitCompareInput } from '../../lib/compare';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/**
 * POST /v1/compare
 *
 * Two pages captured and measured against each other. Each side takes the same
 * parameters as `/v1/capture`, prefixed `a_` and `b_`; anything unprefixed
 * applies to both, so `device=mobile` need only be said once. Credentials are
 * the exception: `headers`, `cookies` and `basic_auth` must name their side.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let headers: Record<string, string> = {};

  try {
    // Two captures, so it costs two against the rate limit.
    const guard = await guardApiRequest(request, 2);
    headers = guard.headers;

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

    locals.cfContext?.waitUntil(touchApiKey(guard.auth.keyId));

    const result = await compareCaptures(
      guard.auth.user,
      before,
      after,
      new URL(request.url).origin,
      'api',
    );
    return json(result, { status: 201, headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
