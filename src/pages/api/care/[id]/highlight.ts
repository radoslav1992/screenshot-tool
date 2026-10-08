import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { ownCareReport, requireCare } from '../../../../lib/care-reports';
import { highlightFile } from '../../../../lib/change-highlights';
export const prerender = false;
/**
 * GET /api/care/:id/highlight?run=… — the highlighted image of a change the
 * report lists, for its owner. The client's page never links to a capture; the
 * owner's view links here, behind sign-in, and only for runs in the snapshot.
 * Gone once retention has removed the capture.
 */
export const GET: APIRoute = async ({ params, locals, url }) => {
  try {
    await requireCare();
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    const { snapshot } = await ownCareReport(locals.user.id, params.id ?? '');
    const runId = url.searchParams.get('run') ?? '';
    const missing = () => new HttpError(404, 'not_found', 'This highlighted image has expired or was deleted.');
    if (!snapshot.monitors.some((m) => m.changed.some((c) => c.runId === runId && c.highlight))) throw missing();
    const run = await env.DB.prepare('SELECT capture_id FROM watch_runs WHERE id=? AND user_id=? AND capture_id IS NOT NULL')
      .bind(runId, locals.user.id)
      .first<{ capture_id: string }>();
    const object = run ? await env.SHOTS.get(highlightFile({ id: run.capture_id, user_id: locals.user.id }).key) : null;
    if (!object) throw missing();
    return new Response(object.body as unknown as ReadableStream, {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      },
    });
  } catch (error) {
    return toHttpError(error, 'care.highlight', 'Could not load the image.').toResponse();
  }
};
