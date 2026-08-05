import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCapture, safeParseFiles } from '../../../lib/captures';
import { timingSafeEqual } from '../../../lib/ids';

export const prerender = false;

/**
 * Serves a rendered file from R2.
 *
 * Access is granted to the owner's session, or to anyone holding the
 * capture's share token (`?t=…`). Add `?download=1` for a save-to-disk
 * Content-Disposition.
 */
export const GET: APIRoute = async ({ params, locals, url, request }) => {
  const row = await getCapture(params.id ?? '');
  if (!row) return new Response('Not found', { status: 404 });

  const token = url.searchParams.get('t') ?? '';
  const isOwner = locals.user?.id === row.user_id;
  const hasToken = token.length === row.share_token.length && timingSafeEqual(token, row.share_token);
  if (!isOwner && !hasToken) return new Response('Not found', { status: 404 });

  const file = safeParseFiles(row.files).find((entry) => entry.name === params.name);
  if (!file) return new Response('Not found', { status: 404 });

  const rangeRequested = request.headers.has('range');
  const object = await env.SHOTS.get(file.key, {
    ...(rangeRequested ? { range: request.headers } : {}),
    onlyIf: request.headers,
  });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-type', file.contentType || 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  if (url.searchParams.get('download')) {
    const filename = `${row.host.replace(/[^a-z0-9.-]/gi, '_')}-${row.id}-${file.name}`;
    headers.set('content-disposition', `attachment; filename="${filename}"`);
  }

  // An R2Object without a body means the conditional request already matched.
  if (!('body' in object)) {
    return new Response(null, { status: 304, headers });
  }

  const range = object.range;
  let status = 200;
  if (rangeRequested && range && 'offset' in range && object.size) {
    const offset = range.offset ?? 0;
    const length = ('length' in range ? range.length : undefined) ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('accept-ranges', 'bytes');
    status = 206;
  }

  return new Response(object.body as unknown as ReadableStream, { status, headers });
};
