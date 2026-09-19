import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getUsage } from '../../../lib/captures';
import { getPlan, allowedFrequencies } from '../../../lib/plans';
import { verificationEnabled } from '../../../lib/verification';
import { HttpError, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

/** Shared account state for native clients. Never expose billing identifiers. */
export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();
  try {
    const user = locals.user;
    const row = await env.DB.prepare('SELECT email_verified_at FROM users WHERE id = ?')
      .bind(user.id).first<{ email_verified_at: string | null }>();
    return json({
      user: { id: user.id, email: user.email, name: user.name },
      plan: getPlan(user.plan).name,
      retentionDays: getPlan(user.plan).historyDays,
      verified: !verificationEnabled() || Boolean(row?.email_verified_at),
      usage: await getUsage(user),
      frequencies: allowedFrequencies(user.plan),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'mobile.profile', 'Could not load your account.').toResponse();
  }
};
