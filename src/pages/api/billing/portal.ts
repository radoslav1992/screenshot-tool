import type { APIRoute } from 'astro';
import { billingEnabled, createPortalSession } from '../../../lib/billing';
import { HttpError, assertSameOrigin, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

/**
 * POST /api/billing/portal — opens the Stripe customer portal, where people
 * change card, switch plan, download invoices and cancel. Everything Stripe
 * does there comes back to us as a subscription webhook.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);

    if (!billingEnabled()) {
      throw new HttpError(503, 'billing_unavailable', 'Payments are not configured on this deployment.');
    }

    const url = await createPortalSession(user, new URL(request.url).origin);

    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    if (!wantsJson) return new Response(null, { status: 303, headers: { location: url } });
    return json({ url });
  } catch (error) {
    return toHttpError(error, 'billing.portal', 'Could not open the billing portal.').toResponse();
  }
};
