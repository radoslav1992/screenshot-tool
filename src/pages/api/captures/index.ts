import type { APIRoute } from 'astro';
import { parseCaptureOptions } from '../../../lib/capture-options';
import { createCaptureRow, listCaptures, runCapture, toDTO } from '../../../lib/captures';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const rows = await listCaptures(user.id, {
    mode: url.searchParams.get('mode') ?? undefined,
    limit: Number.parseInt(url.searchParams.get('limit') ?? '30', 10),
    cursor: url.searchParams.get('cursor') ?? undefined,
  });

  return json({ data: rows.map((row) => toDTO(row, new URL(request.url).origin)) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const options = parseCaptureOptions(await readBody(request));
    const row = await createCaptureRow(user, options, 'app');
    const finished = await runCapture(row, options);
    return json(toDTO(finished, new URL(request.url).origin), { status: finished.status === 'done' ? 201 : 200 });
  } catch (error) {
    if (error instanceof HttpError) return error.toResponse();
    console.error('capture failed', error);
    return new HttpError(500, 'server_error', 'The capture could not be started.').toResponse();
  }
};
