import type { APIRoute } from 'astro';
import { billingEnabled, diagnosePlanChange, type BillingInterval } from '../../../lib/billing';
import { PAID_PLANS, PLAN_ORDER, getPlan, type PlanId } from '../../../lib/plans';
import { HttpError, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

/**
 * GET /api/billing/diagnose — why did upgrading open the plain portal?
 *
 * Every way the plan-change deep link can fail looks the same from outside: the
 * portal opens on its front page. The causes are a missing price, a subscription
 * that cannot be read, or a portal configuration that will not accept the
 * change — and telling them apart otherwise needs `wrangler tail`. This walks
 * the same path the upgrade button does and reports where it stopped.
 *
 * Signed in, and about your own subscription only. It creates a Stripe portal
 * session to prove the flow is accepted, which is free and has no effect until
 * someone opens its URL — which this never returns.
 */
export const GET: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    if (!billingEnabled()) {
      throw new HttpError(503, 'billing_unavailable', 'Payments are not configured on this deployment.');
    }

    // Default to the upgrade the account screen offers: the next plan up.
    const current = getPlan(user.plan);
    const fallback = PLAN_ORDER[PLAN_ORDER.indexOf(current.id) + 1] ?? 'pro';
    const asked = url.searchParams.get('plan') as PlanId | null;
    const plan = asked && PAID_PLANS.includes(asked) ? asked : (fallback as PlanId);

    const interval: BillingInterval = url.searchParams.get('interval') === 'monthly' ? 'monthly' : 'yearly';

    const report = await diagnosePlanChange(user, { plan, interval }, new URL(request.url).origin);
    return json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'billing.diagnose', 'Could not run the diagnosis.').toResponse();
  }
};
