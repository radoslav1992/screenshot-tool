import type { APIRoute } from 'astro';
import { deleteCapture, getCapture, toDTO } from '../../../lib/captures';
import { HttpError, assertSameOrigin, json } from '../../../lib/http';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const row = await getCapture(params.id ?? '');
  if (!row || row.user_id !== user.id) {
    return new HttpError(404, 'not_found', 'No capture with that id.').toResponse();
  }
  return json(toDTO(row, new URL(request.url).origin));
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof HttpError) return error.toResponse();
  }

  const row = await getCapture(params.id ?? '');
  if (!row || row.user_id !== user.id) {
    return new HttpError(404, 'not_found', 'No capture with that id.').toResponse();
  }

  await deleteCapture(row);
  return json({ deleted: true, id: row.id });
};
