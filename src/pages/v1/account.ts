import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight } from '../../lib/api-guard';
import { getUsage } from '../../lib/captures';
import { json } from '../../lib/http';
import { getPlan } from '../../lib/plans';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/** GET /v1/account — plan and quota for the key's owner. */
export const GET: APIRoute = async ({ request }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const usage = await getUsage(guard.auth.user);
    const plan = getPlan(guard.auth.user.plan);

    return json(
      {
        id: guard.auth.user.id,
        email: guard.auth.user.email,
        plan: plan.id,
        environment: guard.auth.environment,
        usage: {
          period: usage.period,
          used: usage.used,
          quota: usage.quota,
          remaining: usage.remaining,
          via_app: usage.viaApp,
          via_api: usage.viaApi,
          renews_on: usage.renewsOn,
        },
      },
      { headers },
    );
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
