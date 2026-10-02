import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, readBody, json } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { collaborationAction, sendInvitationEmail } from '../../lib/collaboration';
import { checkRateLimit } from '../../lib/rate-limit';
export const prerender = false;
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    if (!(await checkRateLimit(`collaboration:${locals.user.id}`, 60, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many updates. Try again later.');
    const result = await collaborationAction(locals.user, await readBody(request), new URL(request.url).origin);
    // A new invitation is emailed when mail works; `emailed` tells the page
    // whether to say so or to ask the owner to pass the link on themselves.
    if ('invitation' in result && result.invitation && result.share_url) {
      const { invitation, ...rest } = result;
      const emailed = await sendInvitationEmail({
        to: invitation.email,
        inviter: locals.user,
        project: invitation.project,
        role: invitation.role,
        link: result.share_url,
      }).catch((error) => {
        console.error('[collaboration] invitation email failed', error);
        return false;
      });
      return json({ ...rest, emailed, email: invitation.email }, { headers: { 'cache-control': 'no-store' } });
    }
    return json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return toHttpError(e, 'collaboration.update', 'Could not update collaboration.').toResponse();
  }
};
