import type { APIRoute } from 'astro';
import { requireProjects } from '../../../../lib/projects';
import { reportAccess } from '../../../../lib/collaboration';
import { reportImage } from '../../../../lib/report-files';
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, url }) => {
  try {
    if (!locals.user) return new Response('Sign in first', { status: 401 });
    await requireProjects();
    const { report, project } = await reportAccess(locals.user.id, params.id!);
    return await reportImage(report, project.user_id, url.searchParams.get('position') ?? '');
  } catch {
    return new Response('Image unavailable', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
};
