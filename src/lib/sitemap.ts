/**
 * Reading a sitemap.
 *
 * Kept apart from the batch runner so it stays a pure string-in/value-out
 * function: no fetch, no bindings, and therefore testable without either.
 */

/**
 * Pulls page URLs out of a sitemap.
 *
 * Regex rather than an XML parser: Workers have no DOMParser, sitemaps are a
 * fixed shape, and the only thing wanted from them is the contents of `<loc>`.
 * Sitemap indexes are followed one level, since large sites almost always have
 * one, but no further — that way lies a crawler.
 */
export function parseSitemap(xml: string): { pages: string[]; indexes: string[] } {
  const locations = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!);
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return isIndex ? { pages: [], indexes: locations } : { pages: locations, indexes: [] };
}
