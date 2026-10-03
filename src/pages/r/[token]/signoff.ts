import type { APIRoute } from 'astro';
import { assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { clientIp } from '../../../lib/auth-throttle';
import { afterResponse } from '../../../lib/background';
import { notifySignoff, signoffStatus, signoffView, submitSignoff } from '../../../lib/signoff';
export const prerender = false;
/**
 * POST /r/:token/signoff — a client's decision on a shared report. No account:
 * the review link is the credential, checked exactly as the page checks it.
 *
 * A plain form post, so it works without JavaScript. It redirects back to the
 * report with a fixed status code that the page turns into a fixed message;
 * nothing from the request is echoed. `Accept: application/json` gets JSON.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const token = params.token ?? '';
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const unavailable = (status: number) =>
    new Response(
      status === 403 ? 'Cross-origin request rejected.' : 'This review link is unavailable, expired or revoked.',
      { status, headers: { 'cache-control': 'no-store' } },
    );
  // Checked first: the token is about to go into a Location header.
  if (!/^[a-f0-9]{64}$/.test(token)) return unavailable(404);
  const back = (code: string) =>
    new Response(null, {
      status: 303,
      headers: { location: `/r/${token}?signoff=${code}#signoff`, 'cache-control': 'no-store' },
    });
  try {
    assertSameOrigin(request);
    const { report, project, signoff } = await submitSignoff(token, await readBody(request), clientIp(request));
    await afterResponse(
      locals,
      notifySignoff(report, project, signoff, new URL(request.url).origin).catch((error) =>
        console.error('[signoff] owner notification failed', error),
      ),
    );
    if (wantsJson) return json({ signoff: signoffView(signoff) }, { headers: { 'cache-control': 'no-store' } });
    return back('saved');
  } catch (error) {
    const failure = toHttpError(error, 'report.signoff', 'Your decision could not be saved. Please try again.');
    if (wantsJson) return failure.toResponse();
    if (failure.status === 403 || failure.status === 404) return unavailable(failure.status);
    const code = failure.type === 'rate_limited' ? 'limited' : failure.type;
    return back(signoffStatus(code) ? code : 'error');
  }
};
