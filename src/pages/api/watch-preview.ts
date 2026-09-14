import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError, assertSameOrigin, readBody, json } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { createCaptureRow, runCapture, toDTO } from '../../lib/captures';
import { APP_RATE_LIMIT } from '../../lib/plans';
import { checkRateLimit } from '../../lib/rate-limit';
import { randomToken } from '../../lib/ids';
import { previewOptions, previewFingerprint, watchSettingsReady } from '../../lib/watch-settings';
export const prerender = false;
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    if (!(await watchSettingsReady()))
      throw new HttpError(503, 'setup_required', 'Monitor setup is being prepared. Try again later.');
    const options = previewOptions(await readBody(request));
    if (
      !(await checkRateLimit(`app:${locals.user.id}`, APP_RATE_LIMIT[locals.user.plan] ?? APP_RATE_LIMIT.free, 3600)).ok
    )
      throw new HttpError(429, 'rate_limited', 'Capture rate limit reached. Try again later.');
    const row = await runCapture(await createCaptureRow(locals.user, options, 'app'), options);
    if (row.status !== 'done') throw new HttpError(502, 'capture_failed', row.error ?? 'Preview failed.');
    const token = randomToken();
    await env.RATE.put(
      `watch-preview:${token}`,
      JSON.stringify({ user_id: locals.user.id, capture_id: row.id, fingerprint: await previewFingerprint(options) }),
      { expirationTtl: 900 },
    );
    return json(
      { capture: toDTO(row, new URL(request.url).origin), preview_token: token },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return toHttpError(
      e,
      'watch.preview',
      'Preview failed. Check the library before recapturing an interrupted request.',
    ).toResponse();
  }
};
