import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, json } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { assertVerified } from '../../../../lib/verification';
import { getWatch } from '../../../../lib/watches';
import { canSendEmail, sendMail } from '../../../../lib/mailer';
import { checkRateLimit } from '../../../../lib/rate-limit';
import { assertPublicCaptureUrl } from '../../../../lib/capture-options';
export const prerender = false;
export const POST: APIRoute = async ({ locals, request, params }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    const watch = await getWatch(params.id ?? '');
    if (!watch || watch.user_id !== locals.user.id) throw new HttpError(404, 'not_found', 'Monitor not found.');
    if (!(await checkRateLimit(`watch-test:${locals.user.id}`, 5, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'You can send five test notifications per hour.');
    let email = 'off',
      webhook = 'off';
    if (watch.notify_email) {
      if (!canSendEmail()) email = 'not configured';
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const sent = await Promise.race([
            sendMail({
              to: locals.user.email,
              subject: 'Test notification · ' + (watch.label || 'Website monitor'),
              text: `This is a test notification, not a detected change.
${new URL(request.url).origin}/app/watches/${watch.id}`,
            }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 15000);
            }),
          ]);
          email = sent === null ? 'unknown' : sent ? 'accepted' : 'failed';
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
    if (watch.webhook_url) {
      try {
        const url = assertPublicCaptureUrl(watch.webhook_url);
        if (url.protocol !== 'https:') throw Error('HTTPS required');
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'Easy Screen Capture: test notification, not a detected change.',
            content: 'Easy Screen Capture: test notification, not a detected change.',
            test: true,
            watch_id: watch.id,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        webhook = response.ok ? 'accepted' : 'failed';
        await response.body?.cancel();
      } catch {
        webhook = 'failed or unknown';
      }
    }
    return json({ message: `Email: ${email}. Webhook: ${webhook}. Provider acceptance does not guarantee delivery.` });
  } catch (e) {
    return toHttpError(e, 'watch.test', 'Could not send a test notification.').toResponse();
  }
};
