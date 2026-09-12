import type { APIRoute } from 'astro';
import { sharedReport } from '../../../lib/projects';
import { reportImage } from '../../../lib/report-files';
export const prerender = false;
export const GET: APIRoute = async ({ params }) => {
  try {
    const { report, project } = await sharedReport(params.token!);
    return await reportImage(report, project.user_id, params.position!);
  } catch {
    return new Response('Image unavailable', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
};
