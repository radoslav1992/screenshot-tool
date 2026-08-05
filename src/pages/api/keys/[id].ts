import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError, assertSameOrigin, json } from '../../../lib/http';

export const prerender = false;

/** Revokes a key. Revoked rows are kept so past usage stays attributable. */
export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof HttpError) return error.toResponse();
  }

  const result = await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), params.id ?? '', user.id)
    .run();

  if (!result.meta.changes) {
    return new HttpError(404, 'not_found', 'No active key with that id.').toResponse();
  }
  return json({ revoked: true, id: params.id });
};
