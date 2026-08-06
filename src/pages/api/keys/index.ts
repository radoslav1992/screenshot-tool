import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { issueApiKey } from '../../../lib/auth';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';

export const prerender = false;

const MAX_ACTIVE_KEYS = 10;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const { results } = await env.DB.prepare(
    `SELECT id, prefix, last4, label, environment, created_at, last_used_at
     FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all();

  return json({ data: results ?? [] });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    const environment = body.environment === 'test' ? 'test' : 'live';
    const label = (body.label ?? '').trim() || (environment === 'live' ? 'Production' : 'Test');

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL`,
    )
      .bind(user.id)
      .first<{ n: number }>();

    if ((count?.n ?? 0) >= MAX_ACTIVE_KEYS) {
      throw badRequest(`You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }

    const { id, secret, row } = await issueApiKey(user.id, label, environment);
    return json(
      {
        id,
        secret,
        prefix: row.prefix,
        last4: row.last4,
        label: row.label,
        environment: row.environment,
        created_at: row.created_at,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof HttpError) return error.toResponse();
    console.error('key creation failed', error);
    return new HttpError(500, 'server_error', 'Could not create the key.').toResponse();
  }
};
