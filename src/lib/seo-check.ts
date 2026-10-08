import { FetchFailure, charsetOf, fetchPublic, readCapped } from './safe-fetch';
import { readSeoTags, type RawPage, type Rewriter, type SeoTags } from './fast-extract';
import { canonicalKey, robotsState } from './seo-signals';
import { HttpError } from './http';

/**
 * The free SEO tag checker (/tools/seo-tag-checker).
 *
 * No browser: the page's HTML is fetched the way a smart monitor check fetches
 * it (safe-fetch.ts — every redirect hop checked for a public address and
 * against the denylist, ten seconds in all, nothing read past 3 MB) and read
 * with the same HTMLRewriter code (fast-extract.ts, readSeoTags). What a
 * search engine's first, script-free pass sees is what this reports, which is
 * also why a tag only JavaScript adds is not here.
 *
 * The findings are plain functions of the reading, so
 * scripts/free-tools-check.mjs checks them against HTML fixtures in workerd.
 */

export const SEO_FETCH = { maxRedirects: 5, maxBytes: 3_000_000, timeoutMs: 10_000 };

/** The plain request says what it is, as a smart check's does (fast-checks.ts), and gets the desktop page. */
const AGENT = 'Mozilla/5.0 (compatible; EasyScreenCapture/1; +https://easyscreencapture.com)';

/** Where Google's results page usually cuts a title and a description, in characters. */
export const TITLE_MAX = 60;
export const TITLE_MIN = 20;
export const DESCRIPTION_MAX = 160;
export const DESCRIPTION_MIN = 50;

export type FindingLevel = 'error' | 'warning' | 'notice';

export interface SeoFinding {
  level: FindingLevel;
  /** Stable, for tests and for styling: `title_missing`, `noindex`, … */
  code: string;
  message: string;
}

export interface SeoReport {
  /** The address as asked, normalised. */
  url: string;
  /** Where the redirects ended. */
  finalUrl: string;
  status: number;
  /** Each redirect followed, in order: the address that answered and its status. */
  redirects: Array<{ url: string; status: number }>;
  contentType: string;
  /** The body was cut at SEO_FETCH.maxBytes. */
  truncated: boolean;
  /** Null when the address answered with something other than a web page. */
  tags: SeoTags | null;
  findings: SeoFinding[];
}

export interface SeoPage extends RawPage {
  redirects: Array<{ url: string; status: number }>;
  contentType: string;
}

function isHtml(contentType: string): boolean {
  return !contentType || /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

/** Wording for what stopped the fetch, as this page says it. */
const FETCH_PROBLEMS: Record<FetchFailure['problem'], [number, string]> = {
  timeout: [504, 'The page did not answer within 10 seconds.'],
  unreachable: [400, 'The page could not be reached. Check the address and try again.'],
  too_many_redirects: [400, 'The page redirects more than 5 times, so it was not followed to the end.'],
  bad_redirect: [400, 'The page redirects to something that is not a web address.'],
  blocked_redirect: [400, 'The page redirects to an address that cannot be checked.'],
  too_large: [400, 'The page is larger than 3 MB.'],
  interrupted: [504, 'The page stopped answering partway through.'],
};

/** Fetches the page as a crawler's first pass would: no scripts, no cookies, no credentials. */
export async function fetchSeoPage(raw: string, limits = SEO_FETCH): Promise<SeoPage> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const redirects: SeoPage['redirects'] = [];
  try {
    const { response, url } = await fetchPublic(raw, {
      maxRedirects: limits.maxRedirects,
      signal: () => deadline,
      headers: { 'user-agent': AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      onRedirect: (hop) => redirects.push(hop),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = isHtml(contentType)
      ? await readCapped(response, limits.maxBytes, 'truncate', charsetOf(contentType))
      : null;
    if (!body) await response.body?.cancel().catch(() => undefined);
    return {
      html: body?.text ?? '',
      status: response.status,
      headers: response.headers,
      url: url.toString(),
      truncated: body?.truncated ?? false,
      redirects,
      contentType,
    };
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    const [status, message] = FETCH_PROBLEMS[error.problem];
    throw new HttpError(status, 'unreachable_url', message, 'url');
  }
}

/** Reads the tags and judges them. HTMLRewriter is Workers' own unless a test passes another. */
export async function analyseSeoPage(asked: string, page: SeoPage, options: { Rewriter?: Rewriter } = {}): Promise<SeoReport> {
  const tags = isHtml(page.contentType) ? await readSeoTags(page, options) : null;
  const report: SeoReport = {
    url: asked,
    finalUrl: page.url,
    status: page.status,
    redirects: page.redirects,
    contentType: page.contentType,
    truncated: Boolean(page.truncated),
    tags,
    findings: [],
  };
  report.findings = seoFindings(report);
  return report;
}

export async function checkSeo(url: string): Promise<SeoReport> {
  return analyseSeoPage(url, await fetchSeoPage(url));
}

/** An http(s) address to show the image from, or null: never `javascript:` or `data:` from someone's page. */
function absolute(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const isAbsolute = (value: string) => /^(?:https?:)?\/\//i.test(value.trim());

const LEVEL_ORDER: Record<FindingLevel, number> = { error: 0, warning: 1, notice: 2 };

/**
 * What a site owner would want to fix, in plain words, worst first. Each is a
 * rule of thumb a search engine documents or a social network enforces, not a
 * score: a page can rank with a long title, but the end of it will not show.
 */
export function seoFindings(report: Omit<SeoReport, 'findings'>): SeoFinding[] {
  const out: SeoFinding[] = [];
  const add = (level: FindingLevel, code: string, message: string) => out.push({ level, code, message });
  const { tags } = report;

  if (report.status >= 400) {
    add('error', 'http_error', `The page answers with HTTP ${report.status}. Search engines drop pages that return errors.`);
  }
  if (report.redirects.length > 1) {
    add(
      'warning',
      'redirect_chain',
      `The address redirects ${report.redirects.length} times before the page loads. Link to the final address, or redirect once.`,
    );
  } else if (report.redirects.length === 1) {
    add('notice', 'redirected', `The address redirects (HTTP ${report.redirects[0]!.status}) to ${report.finalUrl}.`);
  }
  if (!tags) {
    add(
      'error',
      'not_html',
      `The address answers with ${report.contentType || 'something'} rather than a web page, so there are no tags to read.`,
    );
    return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  }
  if (tags.challenge) {
    add(
      'warning',
      'bot_check',
      'The site answered with a bot check instead of the page, so these may not be the page’s own tags. Search engines may be let through.',
    );
  }
  if (report.truncated) add('notice', 'truncated', 'The page is larger than 3 MB; only the first 3 MB were read.');

  // Title
  if (tags.title === null || !tags.title) {
    add('error', tags.title === null ? 'title_missing' : 'title_empty', 'The page has no title. Search results will make one up from the page.');
  } else if (tags.title.length > TITLE_MAX) {
    add(
      'warning',
      'title_long',
      `The title is ${tags.title.length} characters. Google usually shows about ${TITLE_MAX}, so the end will be cut off.`,
    );
  } else if (tags.title.length < TITLE_MIN) {
    add('notice', 'title_short', `The title is only ${tags.title.length} characters. A few more words can say what the page offers.`);
  }

  // Description
  if (!tags.description) {
    add(
      'warning',
      tags.description === null ? 'description_missing' : 'description_empty',
      'The page has no meta description. Search engines will pick a snippet from the page text instead.',
    );
  } else if (tags.description.length > DESCRIPTION_MAX) {
    add(
      'warning',
      'description_long',
      `The meta description is ${tags.description.length} characters. Google usually shows about ${DESCRIPTION_MAX}, so the end will be cut off.`,
    );
  } else if (tags.description.length < DESCRIPTION_MIN) {
    add('notice', 'description_short', `The meta description is only ${tags.description.length} characters. Aim for about 120 to ${DESCRIPTION_MAX}.`);
  }

  // Robots
  const meta = robotsState(tags.robots);
  const header = robotsState(tags.robotsHeader);
  if (meta.noindex) add('error', 'noindex', 'A robots meta tag says noindex: search engines are asked to leave this page out of their results.');
  if (header.noindex) {
    add('error', 'noindex_header', 'The X-Robots-Tag header says noindex: search engines are asked to leave this page out of their results.');
  }
  if ((meta.nofollow || header.nofollow) && !(meta.noindex || header.noindex)) {
    add('warning', 'nofollow', 'Robots says nofollow: search engines are asked not to follow the links on this page.');
  }

  // Canonical
  if (tags.canonicalRaw === null) {
    add('notice', 'canonical_missing', 'There is no canonical tag. Search engines will choose which address of this page to show.');
  } else if (!tags.canonical) {
    add('warning', 'canonical_invalid', `The canonical tag (“${tags.canonicalRaw}”) is not a valid address.`);
  } else {
    if (canonicalKey(tags.canonical) !== canonicalKey(report.finalUrl)) {
      add(
        'warning',
        'canonical_elsewhere',
        `The canonical tag points to ${tags.canonical}, so search engines are asked to show that address instead of this one.`,
      );
    }
    if (!isAbsolute(tags.canonicalRaw)) {
      add('notice', 'canonical_relative', 'The canonical tag uses a relative address. A full address, with https://, is safer.');
    }
  }

  // Headings
  if (tags.h1Count === 0) {
    add('warning', 'h1_missing', 'The page has no h1 heading in its HTML. One clear h1 tells readers and search engines what it is about.');
  } else if (tags.h1Count > 1) {
    add('warning', 'h1_several', `The page has ${tags.h1Count} h1 headings. One main heading makes the topic clearer.`);
  } else if (!tags.h1[0]) {
    add('warning', 'h1_empty', 'The h1 heading has no text in the HTML.');
  }

  // Hreflang
  if (tags.hreflang.length) {
    const self = canonicalKey(tags.canonical || report.finalUrl);
    if (!tags.hreflang.some((entry) => canonicalKey(entry.href) === self || canonicalKey(entry.href) === canonicalKey(report.finalUrl))) {
      add('warning', 'hreflang_no_self', 'The hreflang alternates do not include this page itself. Each language version should list itself too.');
    }
  }

  // Sharing
  if (!tags.og.image) {
    add('warning', 'og_image_missing', 'There is no og:image. Links to this page on social media and in chat apps will show no picture.');
  } else if (!isAbsolute(tags.og.image)) {
    add('warning', 'og_image_relative', 'The og:image is a relative address. Social networks need the full address, with https://.');
  }
  if (!tags.og.title) add('notice', 'og_title_missing', 'There is no og:title. Shared links fall back to the page title.');
  if (!tags.og.description) add('notice', 'og_description_missing', 'There is no og:description. Shared links fall back to the meta description, or to none.');
  if (!tags.twitter.card) {
    add('notice', 'twitter_card_missing', 'There is no twitter:card. X shows a small summary card; summary_large_image shows the picture large.');
  }

  // Mobile and language
  if (!tags.viewport) {
    add('warning', 'viewport_missing', 'There is no viewport meta tag, so phones show the page zoomed out as on a desktop.');
  }
  if (!tags.lang) add('notice', 'lang_missing', 'The html element has no lang attribute naming the page’s language.');

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** How a result might look on Google: title, breadcrumb and snippet, each cut where Google tends to cut. */
export function googlePreview(report: SeoReport): { title: string; site: string; crumbs: string; description: string } {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  let site = report.finalUrl;
  let crumbs = '';
  try {
    const url = new URL(report.finalUrl);
    site = url.hostname.replace(/^www\./, '');
    crumbs = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join(' › ');
  } catch {
    /* the final address is always a URL; the preview just shows it raw if not */
  }
  const tags = report.tags;
  return {
    title: cut(tags?.title || tags?.og.title || site, TITLE_MAX),
    site,
    crumbs: cut(crumbs, 60),
    description: tags?.description ? cut(tags.description, DESCRIPTION_MAX) : '',
  };
}

/** How a link to the page might look when shared: Open Graph first, then the plain tags. */
export function socialPreview(report: SeoReport): { image: string | null; title: string; description: string; site: string } {
  const tags = report.tags;
  let site = '';
  try {
    site = new URL(report.finalUrl).hostname.replace(/^www\./, '');
  } catch {
    site = report.finalUrl;
  }
  const image = tags?.og.image || tags?.twitter.image || '';
  return {
    image: image ? absolute(image, report.finalUrl) : null,
    title: tags?.og.title || tags?.twitter.title || tags?.title || site,
    description: tags?.og.description || tags?.twitter.description || tags?.description || '',
    site,
  };
}
