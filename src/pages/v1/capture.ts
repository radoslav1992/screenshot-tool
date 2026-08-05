import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight, touchApiKey } from '../../lib/api-guard';
import { parseCaptureOptions } from '../../lib/capture-options';
import { createCaptureRow, runCapture, toDTO } from '../../lib/captures';
import { HttpError, json, readBody } from '../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/**
 * POST /v1/capture
 *
 * Body (JSON or form-encoded): url, device, mode, format, width, height,
 * scale, delay, quality, block_ads, dark_mode, max_frames, async.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const body = await readBody(request);
    const options = parseCaptureOptions(body);
    const row = await createCaptureRow(guard.auth.user, options, 'api');
    const origin = new URL(request.url).origin;

    const runInBackground = body.async === '1' || body.async === 'true';
    const context = locals.cfContext;

    context?.waitUntil(touchApiKey(guard.auth.keyId));

    if (runInBackground && context) {
      context.waitUntil(runCapture(row, options));
      return json(toDTO(row, origin), { status: 202, headers });
    }

    const finished = await runCapture(row, options);
    if (finished.status === 'error') {
      return json(toDTO(finished, origin), { status: 502, headers });
    }
    return json(toDTO(finished, origin), { status: 201, headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};

export const GET: APIRoute = () =>
  apiErrorResponse(new HttpError(405, 'method_not_allowed', 'Use POST /v1/capture to create a capture.'));
