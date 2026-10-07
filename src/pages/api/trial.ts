import type { APIRoute } from 'astro';
import { toHttpError } from '../../lib/errors';
import { redirectWithFlash } from '../../lib/flash';
import { HttpError, assertSameOrigin, json } from '../../lib/http';
import { startTrial } from '../../lib/trials';

export const prerender = false;

/**
 * POST /api/trial — starts the signed-in account's 14-day Pro trial.
 *
 * 201 `{plan: 'pro', ends_at}`. Refusals are the usual `{error:{type,message}}`:
 * 409 `trial_used` or `already_paid`, 403 `verification_required`, 429
 * `rate_limited` or `trial_limit`, and 404 before migration 0019. A form post
 * lands on the account screen either way, with the reason when there is one.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const trial = await startTrial(user, request);
    if (!wantsJson) return new Response(null, { status: 303, headers: { location: '/app/account?trial=started' } });
    return json({ plan: trial.plan, ends_at: trial.endsAt }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = toHttpError(error, 'trial', 'Could not start your trial.');
    if (wantsJson) return failure.toResponse();
    return redirectWithFlash(request, '/app/account', failure.message);
  }
};
