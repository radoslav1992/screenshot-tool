import { refreshAppleUser } from '../../../lib/apple-billing';
import { toSessionUser, type UserRow } from '../../../lib/auth';
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getUsage } from '../../../lib/captures';
import { getPlan, visualFrequencies } from '../../../lib/plans';
import { verificationEnabled } from '../../../lib/verification';
import { HttpError, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { referralCodeFor, referralUrl } from '../../../lib/growth';

export const prerender = false;

/** Shared account state for native clients. Never expose billing identifiers. */
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();
  try {
    try { await refreshAppleUser(locals.user.id); }
    catch { console.error('[apple] profile refresh failed; using recorded expiry'); }
    const current = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(locals.user.id).first<UserRow>();
    if (!current) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    const user = toSessionUser(current);
    const row = await env.DB.prepare('SELECT email_verified_at FROM users WHERE id = ?')
      .bind(user.id).first<{ email_verified_at: string | null }>();
    // Additive and optional: absent until migration 0017, or if the code cannot be read.
    const code = await referralCodeFor(user.id).catch(() => null);
    return json({
      user: { id: user.id, email: user.email, name: user.name },
      plan: getPlan(user.plan).name,
      retentionDays: getPlan(user.plan).historyDays,
      verified: !verificationEnabled() || Boolean(row?.email_verified_at),
      // `remaining` includes `bonus`, the referral screenshots spent after the monthly `quota`.
      usage: await getUsage(user),
      // The app creates only visual monitors, so it is never offered the 15-minute schedule.
      frequencies: visualFrequencies(user.plan),
      ...(code ? { referral_url: referralUrl(url.origin, code) } : {}),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'mobile.profile', 'Could not load your account.').toResponse();
  }
};
