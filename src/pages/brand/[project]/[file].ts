import type { APIRoute } from 'astro';
import { logoResponse } from '../../../lib/branding';
export const prerender = false;
/** A project's report logo. Public by unguessable URL; lib/branding.ts says why. */
export const GET: APIRoute = async ({ params }) => {
  try {
    return await logoResponse(params.project ?? '', params.file ?? '');
  } catch (error) {
    console.error('[branding] logo unavailable', error);
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
};
