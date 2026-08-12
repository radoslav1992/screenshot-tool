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

  const current = Number.parseInt((await env.RATE.get(key)) ?? '0', 10) || 0;
  if (current + cost > limit) {
    return { ok: false, limit, remaining: Math.max(0, limit - current), resetSeconds };
  }

  await env.RATE.put(key, String(current + cost), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return { ok: true, limit, remaining: Math.max(0, limit - current - cost), resetSeconds };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(result.resetSeconds),
    ...(result.ok ? {} : { 'retry-after': String(result.resetSeconds) }),
  };
}
