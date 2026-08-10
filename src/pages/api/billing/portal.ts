import type { APIRoute } from 'astro';
import { billingEnabled, createPortalSession, type BillingInterval } from '../../../lib/billing';
import { PAID_PLANS, type PlanId } from '../../../lib/plans';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

/**
 * POST /api/billing/portal — opens the Stripe customer portal, where people
 * change card, switch plan, download invoices and cancel. Everything Stripe
 * does there comes back to us as a subscription webhook.
 *
 * An optional `plan` (and `interval`) opens it on the confirmation screen for
 * that plan instead of the front door, so switching plan is one click from the
 * pricing page. An unknown plan is ignored rather than rejected — the plain
 * portal is a perfectly good place to end up.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);

    if (!billingEnabled()) {
      throw new HttpError(503, 'billing_unavailable', 'Payments are not configured on this deployment.');
    }

    const body = await readBody(request).catch(() => ({}) as Record<string, string>);
    const plan = body.plan as PlanId | undefined;
    const target =
      plan && PAID_PLANS.includes(plan)
        ? { plan, interval: (body.interval === 'yearly' ? 'yearly' : 'monthly') as BillingInterval }
        : undefined;

    const url = await createPortalSession(user, new URL(request.url).origin, target);

    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    if (!wantsJson) return new Response(null, { status: 303, headers: { location: url } });
    return json({ url });
  } catch (error) {
    const failure = toHttpError(error, 'billing.portal', 'Could not open the billing portal.');

    // A form post that fails should land back on the page it came from with
    // something readable, not a page of JSON at a URL the customer cannot leave.
    if (!(request.headers.get('accept') ?? '').includes('application/json')) {
      return new Response(null, {
        status: 303,
        headers: { location: `/app/account?billing_error=${encodeURIComponent(failure.message.slice(0, 300))}` },
      });
    }
    return failure.toResponse();
  }
};
