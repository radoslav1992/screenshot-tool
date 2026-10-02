import { HttpError, apiError } from './http';
import { sha256Hex } from './ids';
import { checkRateLimit } from './rate-limit';

/**
 * Throttles for the routes that take a password or send mail on request.
 *
 * Each one is limited per client address and per email address: the address
 * limit slows one machine trying many accounts, the email limit slows many
 * machines trying one. Counters live in KV via `checkRateLimit`, so they are
 * approximate across locations — fine for slowing guessing down, which is all
 * they are for.
 */

export interface Throttle {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/** Limits in one place, so the check script and the routes agree. */
export const AUTH_LIMITS = {
  loginIp: { limit: 30, windowSeconds: 600 },
  loginEmail: { limit: 10, windowSeconds: 900 },
  signupIp: { limit: 20, windowSeconds: 3600 },
  signupEmail: { limit: 5, windowSeconds: 3600 },
  resetRequestIp: { limit: 10, windowSeconds: 3600 },
  resetRequestEmail: { limit: 3, windowSeconds: 3600 },
  resetCompleteIp: { limit: 20, windowSeconds: 3600 },
  passwordChangeUser: { limit: 10, windowSeconds: 3600 },
} as const;

/** 429 that carries `Retry-After` on its JSON response. */
export class RateLimitedError extends HttpError {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(429, 'rate_limited', message);
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }

  override toResponse(): Response {
    return apiError(this.status, this.type, this.message, { headers: { 'retry-after': String(this.retryAfter) } });
  }
}

/** The caller's address as Cloudflare saw it. Local runs share one bucket. */
export function clientIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip') ?? '').trim().slice(0, 64) || 'unknown';
}

/** Email addresses are hashed before they become KV keys. */
export async function emailBucket(prefix: string, email: string): Promise<string> {
  return `${prefix}:${(await sha256Hex(email.trim().toLowerCase())).slice(0, 32)}`;
}

/**
 * Draws one unit from every throttle and throws when any is exhausted. Every
 * counter is charged, so stopping at the first full one cannot be used to
 * probe the others.
 */
export async function enforceThrottles(throttles: Throttle[], message: (wait: string) => string): Promise<void> {
  const results = await Promise.all(
    throttles.map((throttle) => checkRateLimit(throttle.bucket, throttle.limit, throttle.windowSeconds)),
  );
  const blocked = results.filter((result) => !result.ok);
  if (blocked.length) {
    const retryAfter = Math.max(...blocked.map((result) => result.resetSeconds));
    throw new RateLimitedError(message(waitPhrase(retryAfter)), retryAfter);
  }
}

/** Seconds as words for a message: "a minute", "12 minutes", "an hour". */
export function waitPhrase(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes === 1) return 'a minute';
  if (minutes < 60) return `${minutes} minutes`;
  return minutes <= 60 ? 'an hour' : `${Math.ceil(minutes / 60)} hours`;
}
