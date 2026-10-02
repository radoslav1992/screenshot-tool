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
  /** Length and hash of the whole visible text, so a change past the cap still registers. */
  textLength: number;
  textHash: string;
  /** For each phrase asked about, whether the whole visible text contains it. */
  phrases?: Record<string, boolean>;
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

/**
 * What the caller knows that the page does not. Both are optional, and a call
 * without them reads the same facts as before.
 */
export interface FactsRequest {
  /**
   * Phrases a monitor rule looks for. The stored text stops at MAX_TEXT_CHARS,
   * so a phrase further down a long page has to be looked for here, against
   * all of it, or it reads as missing.
   */
  phrases?: string[];
  /**
   * The redaction patterns (redact-fn's PII_PATTERNS) when the capture asked
   * for PII to be covered. Redaction rewrites the body before this runs; the
   * title and meta tags live in the head and need covering here.
   */
  redact?: Array<{ source: string; flags: string }>;
}

export function readFactsInPage(request?: FactsRequest): RawPageFacts {
  const patterns = (request?.redact ?? []).map(
    (pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
  );
  const scrub = (value: string): string =>
    patterns.reduce(
      (out, pattern) => out.replace(pattern, (match) => '█'.repeat(Math.max(4, Math.min(24, match.length)))),
      value,
    );
  const scrubAll = (record: Record<string, string>): Record<string, string> => {
    for (const key of Object.keys(record)) record[key] = scrub(record[key]!);
    return record;
  };

  /*
   * Hidden by the capture's `hide` selectors (display: none) or by the page
   * itself: either way not something a visitor read, and a heading the
   * customer asked to hide must not come back in the facts.
   */
  const shown = (node: Element): boolean => {
    const element = node as HTMLElement & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    }
    return element.getClientRects().length > 0;
  };

  // cyrb53: fast, synchronous and stable. It tells two texts apart; it does
  // not need to resist anyone.
  const hash = (value: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  };

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
  const text = scrub((document.body?.innerText ?? '').replace(/\s+/g, ' ').trim());
  const lower = text.toLowerCase();
  const phrases = request?.phrases?.length
    ? Object.fromEntries(
        request.phrases
          .filter(Boolean)
          .slice(0, 5)
          .map((phrase) => [phrase, lower.includes(phrase.replace(/\s+/g, ' ').trim().toLowerCase())]),
      )
    : undefined;

  return {
    title: scrub(document.title?.trim() ?? ''),
    description: scrub(meta('meta[name="description" i]')),
    canonical: absolute(document.querySelector('link[rel="canonical" i]')?.getAttribute('href')),
    lang: document.documentElement.getAttribute('lang')?.trim() ?? '',
    charset: document.characterSet ?? '',
    favicon: absolute(
      document.querySelector('link[rel~="icon" i]')?.getAttribute('href') ?? '/favicon.ico',
    ),
    og: scrubAll(prefixed('property', 'og:')),
    twitter: scrubAll(prefixed('name', 'twitter:')),
    headings: [...document.querySelectorAll('h1')]
      .filter(shown)
      .map((node) => scrub(((node as HTMLElement).innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .filter(Boolean)
      .slice(0, 10),
    imageCount: document.querySelectorAll('img').length,
    linksInternal: internal,
    linksExternal: external,
    documentHeight: Math.round(document.documentElement.scrollHeight),
    text: text.slice(0, MAX_TEXT_CHARS),
    textLength: text.length,
    textHash: hash(text),
    ...(phrases ? { phrases } : {}),
    html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html,
    htmlTruncated: html.length > MAX_HTML_BYTES,
    timings: {
      ttfbMs: ms(nav?.responseStart),
      domContentLoadedMs: ms(nav?.domContentLoadedEventEnd),
      loadMs: ms(nav?.loadEventEnd),
    },
  };
}
