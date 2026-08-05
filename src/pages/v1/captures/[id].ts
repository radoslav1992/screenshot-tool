import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight } from '../../../lib/api-guard';
import { deleteCapture, getCapture, toDTO } from '../../../lib/captures';
import { HttpError, json } from '../../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async ({ request, params }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const row = await getCapture(params.id ?? '');
    if (!row || row.user_id !== guard.auth.user.id) {
      throw new HttpError(404, 'not_found', 'No capture with that id.');
    }
    return json(toDTO(row, new URL(request.url).origin), { headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const row = await getCapture(params.id ?? '');
    if (!row || row.user_id !== guard.auth.user.id) {
      throw new HttpError(404, 'not_found', 'No capture with that id.');
    }
    await deleteCapture(row);
    return json({ deleted: true, id: row.id }, { headers });
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
