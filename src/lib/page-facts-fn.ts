/**
 * What the page tells us about itself, read from the live DOM.
 *
 * Its own module with no imports because the function is serialised and
 * evaluated inside the page — see visual-diff-fn.ts for the same arrangement.
 *
 * Read from the DOM rather than from fetched source on purpose: by the time a
 * capture is taken the page has run its JavaScript, so this is the title and
 * markup a visitor actually got, not the one the server shipped.
 */

export interface RawPageFacts {
  title: string;
  description: string;
  canonical: string;
  lang: string;
  charset: string;
  favicon: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  headings: string[];
  imageCount: number;
  linksInternal: number;
  linksExternal: number;
  documentHeight: number;
  /** Visible text, capped. What lets a change alert say what changed. */
  text: string;
  /** Rendered markup, for the derived signals the Worker computes. */
  html: string;
  htmlTruncated: boolean;
  timings: { ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null };
}

/**
 * Rendered HTML is sent back to the Worker to derive the rest. A page can be
 * enormous, and nothing downstream reads past the first couple of megabytes, so
 * it is capped rather than risking the round trip on a pathological document.
 */
const MAX_HTML_BYTES = 2_000_000;

/** Enough text to diff meaningfully without doubling the size of every row. */
const MAX_TEXT_CHARS = 8_000;

export function readFactsInPage(): RawPageFacts {
  const meta = (selector: string): string =>
    (document.querySelector(selector) as HTMLMetaElement | null)?.content?.trim() ?? '';

  const prefixed = (attribute: string, prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    document.querySelectorAll(`meta[${attribute}^="${prefix}"]`).forEach((node) => {
      const key = node.getAttribute(attribute)?.slice(prefix.length) ?? '';
      const value = (node as HTMLMetaElement).content?.trim() ?? '';
      if (key && value && !out[key]) out[key] = value;
    });
    return out;
  };

  const absolute = (href: string | null | undefined): string => {
    if (!href) return '';
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return '';
    }
  };

  let internal = 0;
  let external = 0;
  document.querySelectorAll('a[href]').forEach((node) => {
    const href = absolute(node.getAttribute('href'));
    if (!href.startsWith('http')) return;
    try {
      if (new URL(href).origin === location.origin) internal++;
      else external++;
    } catch {
      /* not a link worth counting */
    }
  });

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const ms = (value: number | undefined): number | null =>
    typeof value === 'number' && value > 0 ? Math.round(value) : null;

  const html = document.documentElement.outerHTML;

  return {
    title: document.title?.trim() ?? '',
    description: meta('meta[name="description" i]'),
    canonical: absolute(document.querySelector('link[rel="canonical" i]')?.getAttribute('href')),
    lang: document.documentElement.getAttribute('lang')?.trim() ?? '',
    charset: document.characterSet ?? '',
    favicon: absolute(
      document.querySelector('link[rel~="icon" i]')?.getAttribute('href') ?? '/favicon.ico',
    ),
    og: prefixed('property', 'og:'),
    twitter: prefixed('name', 'twitter:'),
    headings: [...document.querySelectorAll('h1')].map((node) => (node.textContent ?? '').trim()).filter(Boolean).slice(0, 10),
    imageCount: document.querySelectorAll('img').length,
    linksInternal: internal,
    linksExternal: external,
    documentHeight: Math.round(document.documentElement.scrollHeight),
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS),
    html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html,
    htmlTruncated: html.length > MAX_HTML_BYTES,
    timings: {
      ttfbMs: ms(nav?.responseStart),
      domContentLoadedMs: ms(nav?.domContentLoadedEventEnd),
      loadMs: ms(nav?.loadEventEnd),
    },
  };
}
