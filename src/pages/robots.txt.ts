import type { APIRoute } from 'astro';
import { siteUrl } from '../lib/tool-pages';

export const prerender = false;

/**
 * GET /robots.txt — everything public may be crawled, the free tools included;
 * the signed-in app and the JSON API may not, as there is nothing there to index.
 */
export const GET: APIRoute = () =>
  new Response(
    ['User-agent: *', 'Allow: /', 'Disallow: /app/', 'Disallow: /api/', '', `Sitemap: ${siteUrl('/sitemap.xml')}`, ''].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } },
  );
