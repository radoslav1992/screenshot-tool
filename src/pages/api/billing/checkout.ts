import type { APIRoute } from 'astro';
import { billingEnabled, createCheckoutSession, type BillingInterval } from '../../../lib/billing';
import { billingFailureResponse } from '../../../lib/billing-errors';
import { PAID_PLANS, type PlanId } from '../../../lib/plans';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/billing/checkout — starts a Stripe Checkout session for a plan.
 *
 * Answers with the hosted checkout URL. Browsers posting a plain form get a 303
 * to it instead, so the flow works without JavaScript.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);

    if (!billingEnabled()) {
      throw new HttpError(503, 'billing_unavailable', 'Payments are not configured on this deployment.');
    }

    const body = await readBody(request);
    const plan = body.plan as PlanId;
    if (!plan || !PAID_PLANS.includes(plan)) {
      throw badRequest('Choose a plan to subscribe to.', 'plan');
    }

    const interval: BillingInterval = body.interval === 'yearly' ? 'yearly' : 'monthly';
    const url = await createCheckoutSession({ user, plan, interval, origin: new URL(request.url).origin });

    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    if (!wantsJson) return new Response(null, { status: 303, headers: { location: url } });
    return json({ url });
  } catch (error) {
    // Same as the portal: a form post ends up back on the pricing page with a
    // message, rather than at a JSON dead end. Only a code travels in the URL.
    return billingFailureResponse(error, { flow: 'checkout', request, locals });
  }
};
