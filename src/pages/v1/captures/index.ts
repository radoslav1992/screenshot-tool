import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight } from '../../../lib/api-guard';
import { listCaptures, toDTO } from '../../../lib/captures';
import { json } from '../../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/** GET /v1/captures?mode=&limit=&cursor= — most recent first. */
export const GET: APIRoute = async ({ request, url }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const rows = await listCaptures(guard.auth.user.id, {
      mode: url.searchParams.get('mode') ?? undefined,
      limit: Number.parseInt(url.searchParams.get('limit') ?? '30', 10),
      cursor: url.searchParams.get('cursor') ?? undefined,
    });

    const origin = new URL(request.url).origin;
    const last = rows.at(-1);

    return json(
      {
        object: 'list',
        data: rows.map((row) => toDTO(row, origin)),
        next_cursor: rows.length ? last?.created_at : null,
      },
      { headers },
    );
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
