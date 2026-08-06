import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../lib/http';
import { toHttpError } from '../../lib/errors';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    const name = (body.name ?? '').trim();

    if (!name) throw badRequest('Enter a display name.', 'name');
    if (name.length > 60) throw badRequest('That name is too long.', 'name');

    await env.DB.prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, new Date().toISOString(), user.id)
      .run();

    return json({ id: user.id, name, email: user.email });
  } catch (error) {
    return toHttpError(error, 'account.update', 'Could not update your profile.').toResponse();
  }
};
