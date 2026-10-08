import type { APIRoute } from 'astro';
import { TOOL_ORDER, TOOL_PAGES, siteUrl } from '../lib/tool-pages';

export const prerender = false;

/**
 * GET /sitemap.xml — the public pages a search engine should know about. The
 * app, the API and share links are left out: they are behind a sign-in or a
 * token, and robots.txt asks crawlers to stay out of the first two.
 */
const PAGES = [
  '/',
  '/features',
  '/pricing',
  '/sample-report',
  '/docs',
  '/tools',
  ...TOOL_ORDER.map((id) => TOOL_PAGES[id].path),
  '/support',
  '/privacy',
  '/terms',
];

export const GET: APIRoute = () => {
  const urls = PAGES.map((path) => `  <url><loc>${siteUrl(path)}</loc></url>`).join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } },
  );
};
