import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight, touchApiKey } from '../../lib/api-guard';
import { parseCaptureOptions } from '../../lib/capture-options';
import { captureErrorStatus, createCaptureRow, runCapture, toDTO } from '../../lib/captures';
import { asksForAsync, captureJobsReady, enqueueCapture } from '../../lib/capture-jobs';
import { HttpError, json, readBody } from '../../lib/http';
import { hasRequestAuth } from '../../lib/request-auth';

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
    const origin = new URL(request.url).origin;

    const runInBackground = asksForAsync(request, body);
    const context = locals.cfContext;

    context?.waitUntil(touchApiKey(guard.auth.keyId));

    /*
     * Queued, so a slow page is not cut off with the request: work left to run
     * after the response gets about 30 seconds, and a full-page capture can take
     * longer. Credentials are never stored, so a capture carrying them keeps to
     * the old way — rendered after the response, while the runtime allows.
     */
    if (runInBackground && !hasRequestAuth(options.auth) && (await captureJobsReady())) {
      const queued = await enqueueCapture(guard.auth.user, options, body, 'api');
      return json(toDTO(queued, origin), {
        status: 202,
        headers: { ...headers, 'preference-applied': 'respond-async', location: `/v1/captures/${queued.id}` },
      });
    }

    const row = await createCaptureRow(guard.auth.user, options, 'api');

    if (runInBackground && context) {
      context.waitUntil(runCapture(row, options));
      return json(toDTO(row, origin), { status: 202, headers });
    }

    const finished = await runCapture(row, options);
    if (finished.status === 'error') {
      // Still the capture as the body, now with `error_type`; the status says
      // which kind of failure it was — 400 for a page that would not load, 504
      // for one that took too long — instead of 502 for all of them.
      return json(toDTO(finished, origin), { status: captureErrorStatus(finished), headers });
    }
    return json(toDTO(finished, origin), { status: 201, headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};

export const GET: APIRoute = () =>
  apiErrorResponse(new HttpError(405, 'method_not_allowed', 'Use POST /v1/capture to create a capture.'));
