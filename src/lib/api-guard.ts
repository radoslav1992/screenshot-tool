import { authenticateApiKey, touchApiKey, type ApiKeyAuth } from './auth';
import { CORS_HEADERS, HttpError } from './http';
import { toHttpError } from './errors';
import { API_RATE_LIMIT, getPlan } from './plans';
import { checkRateLimit, rateLimitHeaders } from './rate-limit';
import { assertVerified } from './verification';

export interface GuardResult {
  auth: ApiKeyAuth;
  headers: Record<string, string>;
}

/**
 * Authenticates a public API request, enforces the plan's API entitlement and
 * applies per-key rate limiting. Returns headers to merge into the response.
 */
export async function guardApiRequest(request: Request): Promise<GuardResult> {
  const auth = await authenticateApiKey(request);
  const plan = getPlan(auth.user.plan);

  if (!plan.api) {
    throw new HttpError(
      403,
      'plan_required',
      'API access is available on the Pro and Business plans. Upgrade to start using keys.',
    );
  }

  /*
   * The same gate the app applies. Checked here rather than per route so a new
   * endpoint cannot forget it — an unverified account could otherwise be
   * refused in the app and served through a key it made before confirming.
   * Dormant unless REQUIRE_EMAIL_VERIFICATION is on and a mailer is configured.
   */
  await assertVerified(auth.user);

  const limit = API_RATE_LIMIT[plan.id];
  const rate = await checkRateLimit(`key:${auth.keyId}`, limit);
  const headers = { ...CORS_HEADERS, ...rateLimitHeaders(rate) };

  if (!rate.ok) {
    throw new HttpError(429, 'rate_limited', `Rate limit of ${limit} requests/minute exceeded.`);
  }

  return { auth, headers };
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Turns any thrown value into a JSON API error response with CORS headers. */
export function apiErrorResponse(error: unknown, headers: Record<string, string> = CORS_HEADERS): Response {
  const httpError = toHttpError(error, 'api', 'Something went wrong on our side.');
  const response = httpError.toResponse();
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

export { touchApiKey };
