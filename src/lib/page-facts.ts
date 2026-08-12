import type { RawPageFacts } from './page-facts-fn';

/**
 * Everything a capture can say about the page besides how it looked.
 *
 * Two halves. The DOM values — title, meta, OG, link counts — are read inside
 * the page (page-facts-fn.ts). The derived signals below work on the rendered
 * markup that comes back with them, and are string-in/value-out with no runtime
 * of their own, which is what makes them testable without a browser.
 *
 * The derived half is adapted from `packages/shared-audit/index.ts` in
 * radoslav1992/agency (c1f5d68), where the same functions back the site
 * analyzer and the research crawler. Kept close to the originals so fixes can
 * travel in either direction; the market-specific parts of that library — the
 * Bulgarian page-role classifier, MX providers, hiring signals — are not here,
 * because a screenshot service has no use for them.
 */

export interface PageFacts {
  /** Where the capture ended up, after redirects. */
  final_url: string;
  status: number | null;
  redirects: string[];
  title: string;
  description: string;
  canonical: string;
  lang: string;
  charset: string;
  favicon: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  headings: string[];
  word_count: number;
  images: number;
  links: { internal: number; external: number };
  schema_types: string[];
  cms: string;
  framework: string;
  is_spa: boolean;
  img_alt_coverage: number | null;
  form_label_coverage: number | null;
  page_weight_kb: number;
  request_count: number;
  document_height: number;
  timings: { ttfb_ms: number | null; dom_content_loaded_ms: number | null; load_ms: number | null };
  /** True when the page was too large to derive signals from in full. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Derived signals                                                             */
/* -------------------------------------------------------------------------- */

/** Rough but stable visible text: drops script/style and the tags. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(html: string): number {
  const text = visibleText(html);
  return text ? text.split(/\s+/).length : 0;
}

function collectTypes(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') into.add(type);
  else if (Array.isArray(type)) for (const entry of type) if (typeof entry === 'string') into.add(entry);
  const graph = record['@graph'];
  if (Array.isArray(graph)) for (const entry of graph) collectTypes(entry, into);
}

/** The schema.org types declared in JSON-LD blocks. */
export function schemaTypes(html: string): string[] {
  const blocks =
    html.match(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const types = new Set<string>();
  for (const block of blocks) {
    const json = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    try {
      const parsed = JSON.parse(json);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) collectTypes(node, types);
    } catch {
      // A malformed block tells us nothing; the others may still be fine.
    }
  }
  return [...types];
}

export interface StackSignals {
  cms: string;
  framework: string;
  is_spa: boolean;
}

/**
 * What the page was built with.
 *
 * The whole document is searched, not just the head: framework markers often
 * live in the body (`data-astro-cid-…`), and a fixed head-sized window gives
 * different answers for sites that are the same in substance.
 */
export function detectStack(html: string, headers: Record<string, string> = {}): StackSignals {
  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? '';
  const powered = headers['x-powered-by'] ?? '';
  const hay = `${html} ${generator} ${powered}`.toLowerCase();

  // Framework (how the site is built) is kept apart from CMS (what manages the
  // content). Astro, Next and Nuxt are not content management systems.
  let framework = 'none';
  if (/_next\//.test(hay)) framework = 'Next.js';
  else if (/data-reactroot|__react|react-dom/.test(hay)) framework = 'React';
  else if (/__nuxt|nuxt/.test(hay)) framework = 'Nuxt';
  else if (/ng-version|angular/.test(hay)) framework = 'Angular';
  else if (/data-astro|astro-island/.test(hay)) framework = 'Astro';
  else if (/data-v-|vue\.js|__vue__/.test(hay)) framework = 'Vue';
  else if (/svelte/.test(hay)) framework = 'Svelte';

  /** Values in <meta generator> that name a framework or builder, not a CMS. */
  const GENERATOR_FRAMEWORKS = /^(astro|next|nuxt|gatsby|hugo|jekyll|eleventy|vite|svelte)/i;

  let cms = 'none';
  if (/wp-content|wordpress/.test(hay)) cms = 'WordPress';
  else if (/joomla/.test(hay)) cms = 'Joomla';
  else if (/drupal/.test(hay)) cms = 'Drupal';
  else if (/shopify/.test(hay)) cms = 'Shopify';
  else if (/wix\.com|wixstatic/.test(hay)) cms = 'Wix';
  else if (/squarespace/.test(hay)) cms = 'Squarespace';
  else if (/webflow/.test(hay)) cms = 'Webflow';
  else if (generator && !GENERATOR_FRAMEWORKS.test(generator)) cms = generator.split(' ')[0]!;

  // The generator names the framework only where no marker already did.
  if (framework === 'none' && generator && GENERATOR_FRAMEWORKS.test(generator)) {
    framework = generator.split(' ')[0]!;
  }

  // Single-page-app heuristic: near-empty body, a JS bundle, a mount node.
  // JSON-LD does not count as a script — otherwise `application/ld+json` fools
  // both the count and the search for "app".
  const bodyText = visibleText(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html).length;
  const jsBundle = /<script[^>]+src\s*=/i.test(html);
  const mountNode = /id\s*=\s*["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|window\.__NUXT__/i.test(html);

  return { cms, framework, is_spa: bodyText < 400 && jsBundle && mountNode };
}

export interface A11ySignals {
  img_alt_coverage: number | null;
  form_label_coverage: number | null;
}

/** How much of the page is reachable without sight. Coarse, but honest. */
export function deriveA11y(html: string): A11ySignals {
  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const withAlt = images.filter((tag) => /\balt\s*=\s*["'][^"']/.test(tag)).length;
  const inputs = (html.match(/<input\b[^>]*>/gi) ?? []).filter(
    (tag) => !/type\s*=\s*["'](hidden|submit|button|image)["']/i.test(tag),
  );
  // Rough: an id means a <label for> can exist, aria-label needs no label.
  const labelled = inputs.filter((tag) => /\baria-label\s*=|\bid\s*=/.test(tag)).length;

  return {
    img_alt_coverage: images.length ? Math.round((withAlt / images.length) * 100) / 100 : null,
    form_label_coverage: inputs.length ? Math.round((labelled / inputs.length) * 100) / 100 : null,
  };
}

export interface WeightSignals {
  page_weight_kb: number;
  request_count: number;
}

/**
 * The document's own weight and how many subrequests it asks the browser for.
 * A lower bound — the resources are counted, not fetched — but it needs no
 * third-party API and is therefore available for every capture.
 */
export function deriveWeight(html: string): WeightSignals {
  const bytes = new TextEncoder().encode(html).length;
  const references = [
    ...(html.match(/<script[^>]+src\s*=/gi) ?? []),
    ...(html.match(/<link[^>]+rel\s*=\s*["'](stylesheet|preload)["']/gi) ?? []),
    ...(html.match(/<img[^>]+src\s*=/gi) ?? []),
    ...(html.match(/<source[^>]+srcset\s*=/gi) ?? []),
    ...(html.match(/<iframe[^>]+src\s*=/gi) ?? []),
  ];
  return { page_weight_kb: Math.round(bytes / 1024), request_count: references.length + 1 };
}

/* -------------------------------------------------------------------------- */
/* Assembling                                                                  */
/* -------------------------------------------------------------------------- */

export interface FactsInput {
  raw: RawPageFacts;
  finalUrl: string;
  status: number | null;
  redirects: string[];
  headers?: Record<string, string>;
}

export function buildFacts(input: FactsInput): PageFacts {
  const { raw } = input;
  const stack = detectStack(raw.html, input.headers ?? {});
  const a11y = deriveA11y(raw.html);
  const weight = deriveWeight(raw.html);

  return {
    final_url: input.finalUrl,
    status: input.status,
    redirects: input.redirects,
    title: raw.title,
    description: raw.description || raw.og.description || '',
    canonical: raw.canonical,
    lang: raw.lang,
    charset: raw.charset,
    favicon: raw.favicon,
    og: raw.og,
    twitter: raw.twitter,
    headings: raw.headings,
    word_count: wordCount(raw.html),
    images: raw.imageCount,
    links: { internal: raw.linksInternal, external: raw.linksExternal },
    schema_types: schemaTypes(raw.html),
    cms: stack.cms,
    framework: stack.framework,
    is_spa: stack.is_spa,
    img_alt_coverage: a11y.img_alt_coverage,
    form_label_coverage: a11y.form_label_coverage,
    page_weight_kb: weight.page_weight_kb,
    request_count: weight.request_count,
    document_height: raw.documentHeight,
    timings: {
      ttfb_ms: raw.timings.ttfbMs,
      dom_content_loaded_ms: raw.timings.domContentLoadedMs,
      load_ms: raw.timings.loadMs,
    },
    truncated: raw.htmlTruncated,
  };
}

export function safeParseFacts(raw: string | null): PageFacts | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PageFacts) : null;
  } catch {
    return null;
  }
}
