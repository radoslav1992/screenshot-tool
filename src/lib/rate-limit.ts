import { env } from 'cloudflare:workers';

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window counter in KV. Windows are short (60s) so the read-modify-write
 * race only ever leaks a few extra requests, which is fine for API fairness.
 */
/**
 * `cost` lets one request draw more than one unit — a comparison runs two
 * captures, and charging it as one would let the burst limit be doubled by
 * asking for pairs.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds = 60,
  cost = 1,
): Promise<RateLimitResult> {
  if (limit <= 0) return { ok: false, limit, remaining: 0, resetSeconds: windowSeconds };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const key = `rl:${bucket}:${window}`;
  const resetSeconds = (window + 1) * windowSeconds - now;

  let current = 0;
  try {
    current = Number.parseInt((await env.RATE.get(key)) ?? '0', 10) || 0;
  } catch (error) {
    // Fairness is not worth an outage: an unreadable counter lets the request
    // through rather than turning every request into a 500.
    kvFailed(error);
    return { ok: true, limit, remaining: Math.max(0, limit - cost), resetSeconds };
  }
  if (current + cost > limit) {
    return { ok: false, limit, remaining: Math.max(0, limit - current), resetSeconds };
  }

  try {
    await env.RATE.put(key, String(current + cost), { expirationTtl: Math.max(60, windowSeconds * 2) });
  } catch (error) {
    // KV takes about one write a second per key, so a busy key can refuse one.
    // The request was within its limit when read; it goes through uncounted.
    kvFailed(error);
  }
  return { ok: true, limit, remaining: Math.max(0, limit - current - cost), resetSeconds };
}

let kvFailureLogged = false;

/** Logged once per isolate: a struggling KV would otherwise log on every request. */
function kvFailed(error: unknown): void {
  if (kvFailureLogged) return;
  kvFailureLogged = true;
  console.error('[rate-limit] KV unavailable; allowing requests through', error);
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(result.resetSeconds),
    ...(result.ok ? {} : { 'retry-after': String(result.resetSeconds) }),
  };
}
