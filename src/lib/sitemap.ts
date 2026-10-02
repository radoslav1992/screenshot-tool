/**
 * Reading a sitemap.
 *
 * Kept apart from the batch runner so it stays a pure string-in/value-out
 * function: no fetch, no bindings, and therefore testable without either.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XML escapes in a `<loc>`. A sitemap is XML, so a query string's `&` arrives
 * as `&amp;` — and a URL taken literally would point at a different page.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Pulls page URLs out of a sitemap.
 *
 * Regex rather than an XML parser: Workers have no DOMParser, sitemaps are a
 * fixed shape, and the only thing wanted from them is the contents of `<loc>` —
 * escaped, or wrapped in CDATA, which some generators do for every entry.
 * Sitemap indexes are followed one level, since large sites almost always have
 * one, but no further — that way lies a crawler.
 */
export function parseSitemap(xml: string): { pages: string[]; indexes: string[] } {
  const locations = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/loc>/gi)]
    .map((match) => (match[1] !== undefined ? match[1] : decodeEntities(match[2] ?? '')).trim())
    .filter((location) => location && !/\s/.test(location));
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return isIndex ? { pages: [], indexes: locations } : { pages: locations, indexes: [] };
}
