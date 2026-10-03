import type { APIRoute } from 'astro';
import { apiErrorResponse, guardApiRequest, preflight } from '../../../lib/api-guard';
import { listCaptures, toPublicDTO } from '../../../lib/captures';
import { captureCursor, listLimit } from '../../../lib/capture-list';
import { json } from '../../../lib/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => preflight();

/**
 * GET /v1/captures?mode=&limit=&cursor= — most recent first. `next_cursor` is
 * null on the last page; a bare timestamp is still accepted as a cursor.
 * Background captures still queued or running appear only with
 * `include_pending=1`.
 */
export const GET: APIRoute = async ({ request, url }) => {
  let headers: Record<string, string> = {};

  try {
    const guard = await guardApiRequest(request);
    headers = guard.headers;

    const limit = listLimit(Number.parseInt(url.searchParams.get('limit') ?? '30', 10));
    const rows = await listCaptures(guard.auth.user.id, {
      mode: url.searchParams.get('mode') ?? undefined,
      limit,
      cursor: url.searchParams.get('cursor') ?? undefined,
      lookahead: true,
      includePending: url.searchParams.get('include_pending') === '1',
    });

    const origin = new URL(request.url).origin;
    // The extra row only says that another page exists; it belongs to that page.
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return json(
      {
        object: 'list',
        data: page.map((row) => toPublicDTO(row, origin)),
        next_cursor: rows.length > limit && last ? captureCursor(last) : null,
      },
      { headers },
    );
  } catch (error) {
    return apiErrorResponse(error, headers);
  }
};
