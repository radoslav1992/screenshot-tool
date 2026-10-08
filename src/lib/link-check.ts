import { assertPublicCaptureUrl } from './capture-options';
import { isChallenge } from './fast-extract';
import { FetchFailure, fetchPublic } from './safe-fetch';

/**
 * Broken links on a monitored page: the links read from its HTML, each asked
 * for once with a HEAD request (GET when a server refuses HEAD), and sorted
 * into the ones a visitor would find broken and the ones that could not be
 * verified from here.
 *
 * The HTML is read with patterns rather than HTMLRewriter so the same code
 * runs in the Worker and in the Node tests. That is enough for the one thing
 * asked of it, `<a href>`: comments, scripts, styles and templates are removed
 * first so links in them are not counted, and quoted attributes are read whole
 * so a `>` inside one does not end the tag. A page that builds its links with
 * JavaScript has fewer links here than on screen, never more.
 *
 * Every request goes through fetchPublic: no private addresses, each redirect
 * hop checked, nothing sent but the headers below. No cookies or credentials
 * are ever sent; Workers' fetch keeps none.
 */

export const LINK_TIMEOUT_MS = 8_000;
/** Links read from one page before any are checked; LINKS_PER_PAGE (plans.ts) of them are. */
export const MAX_EXTRACTED = 2_000;
export const LINK_TEXT_MAX = 80;
export const LINK_AGENT = 'Mozilla/5.0 (compatible; EasyScreenCapture-LinkCheck/1; +https://easyscreencapture.com/privacy)';

export interface PageLink {
  url: string;
  text: string;
}

export type LinkVerdict =
  | { kind: 'ok'; status: number | null; reason: string }
  | { kind: 'broken'; status: number | null; reason: string }
  | { kind: 'unverified'; status: number | null; reason: string };

/* -------------------------------------------------------------------------- */
/* Reading the links                                                           */
/* -------------------------------------------------------------------------- */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** An attribute's value from a tag's attribute text, or null. */
function attribute(attributes: string, name: string): string | null {
  // An unquoted value runs to whitespace, as browsers read it, `=` and all.
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** A tag longer than this is malformed; it is skipped rather than read to the end of the page. */
const TAG_MAX = 4_096;

/**
 * The attribute text of the tag whose name ends at `from`, up to its `>`.
 * Quoted values are taken whole, so a `>` inside one does not end the tag.
 * Hand-scanned rather than matched with one pattern: an unclosed quote then
 * costs at most TAG_MAX characters, and the caller carries on after them, so
 * reading a page stays linear in its size whatever it contains.
 */
function scanTag(html: string, from: number): { attributes: string | null; end: number } {
  const limit = Math.min(html.length, from + TAG_MAX);
  let quote = '';
  for (let i = from; i < limit; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return { attributes: html.slice(from, i), end: i + 1 };
  }
  return { attributes: null, end: limit };
}

/**
 * The page's http(s) links: resolved against `<base href>` or the page's
 * final URL, without fragments, without the page itself, each once (with the
 * first text it had), in the order they appear, at most `limit`.
 */
export function extractLinks(html: string, pageUrl: string, limit = MAX_EXTRACTED): PageLink[] {
  const page = new URL(pageUrl);
  page.hash = '';
  const body = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|template|textarea)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');

  const anchors: Array<{ attributes: string; end: number }> = [];
  let base = page;
  let baseSeen = false;
  const tags = /<(a|base)(?=[\s>\/])/gi;
  for (let match = tags.exec(body); match; match = tags.exec(body)) {
    const tag = scanTag(body, match.index + match[0].length);
    tags.lastIndex = tag.end;
    if (tag.attributes === null) continue;
    if (match[1]!.toLowerCase() === 'a') {
      anchors.push({ attributes: tag.attributes, end: tag.end });
      if (anchors.length >= limit * 4) break;
    } else if (!baseSeen) {
      // The first <base href> counts, as in a browser; a broken one is ignored.
      baseSeen = true;
      const href = attribute(tag.attributes, 'href');
      try {
        if (href) base = new URL(href.trim(), page);
      } catch {
        base = page;
      }
    }
  }

  const seen = new Set<string>([page.toString()]);
  const links: PageLink[] = [];
  for (const anchor of anchors) {
    const href = attribute(anchor.attributes, 'href')?.trim();
    if (!href || href.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    url.username = '';
    url.password = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    // The text runs to the next </a> or <a, whichever comes first, as a browser closes an unclosed one.
    const after = body.slice(anchor.end, anchor.end + 2_000);
    const close = after.search(/<\/a\s*>|<a[\s>\/]/i);
    const label =
      clean(close === -1 ? after.slice(0, 300) : after.slice(0, close)) ||
      attribute(anchor.attributes, 'aria-label') ||
      attribute(anchor.attributes, 'title') ||
      '';
    links.push({ url: key, text: truncate(label.replace(/\s+/g, ' ').trim(), LINK_TEXT_MAX) });
    if (links.length >= limit) break;
  }
  return links;
}

/* -------------------------------------------------------------------------- */
/* Checking one                                                                */
/* -------------------------------------------------------------------------- */

const REFUSALS: Record<number, string> = {
  401: 'Needs a login (HTTP 401)',
  403: 'Refuses automated checks (HTTP 403)',
  429: 'Limits automated checks (HTTP 429)',
};

/** How an answer reads for a visitor following the link. */
export function classifyLink(status: number, headers: Headers): LinkVerdict {
  if (isChallenge(status, headers, '')) return { kind: 'unverified', status, reason: 'Shows a bot check to automated visitors' };
  if (status === 404) return { kind: 'broken', status, reason: 'Not found (HTTP 404)' };
  if (status === 410) return { kind: 'broken', status, reason: 'Gone (HTTP 410)' };
  if (status >= 500) return { kind: 'broken', status, reason: `Server error (HTTP ${status})` };
  if (REFUSALS[status]) return { kind: 'unverified', status, reason: REFUSALS[status]! };
  return { kind: 'ok', status, reason: `HTTP ${status}` };
}

/** Why a request got no answer, in a visitor's terms. */
export function classifyFailure(error: unknown): LinkVerdict {
  if (error instanceof FetchFailure) {
    if (error.problem === 'unreachable') return { kind: 'broken', status: null, reason: "The site can't be reached (DNS or connection failure)" };
    if (error.problem === 'too_many_redirects') return { kind: 'broken', status: null, reason: 'Redirects too many times' };
    if (error.problem === 'bad_redirect') return { kind: 'broken', status: null, reason: 'Redirects to an address that does not exist' };
    if (error.problem === 'timeout') return { kind: 'unverified', status: null, reason: `No answer within ${LINK_TIMEOUT_MS / 1000} seconds` };
    if (error.problem === 'blocked_redirect') return { kind: 'unverified', status: null, reason: 'Redirects to an address that is not checked' };
  }
  return { kind: 'unverified', status: null, reason: 'Could not be checked' };
}

/**
 * Asks for one link: HEAD, then GET (cancelled as soon as its headers arrive)
 * when HEAD is refused with 405 or 501. `requests` counts every request made,
 * redirect hops included, for the sweep's budget. Never throws. A private or
 * denied address is never asked for; `skipped` says so.
 */
export async function checkLink(url: string): Promise<LinkVerdict & { requests: number; skipped?: boolean }> {
  try {
    assertPublicCaptureUrl(url);
  } catch {
    return { kind: 'unverified', status: null, reason: 'A private or local address, not checked', requests: 0, skipped: true };
  }
  let requests = 0;
  const ask = async (method: 'HEAD' | 'GET') => {
    const deadline = AbortSignal.timeout(LINK_TIMEOUT_MS);
    requests++;
    const { response } = await fetchPublic(url, {
      method,
      maxRedirects: 5,
      signal: () => deadline,
      headers: { 'user-agent': LINK_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      onRedirect: () => requests++,
    });
    // Only the status and headers are wanted: a GET is cut off as soon as they arrive.
    await response.body?.cancel().catch(() => undefined);
    return response;
  };
  try {
    let response = await ask('HEAD');
    if (response.status === 405 || response.status === 501) response = await ask('GET');
    return { ...classifyLink(response.status, response.headers), requests };
  } catch (error) {
    return { ...classifyFailure(error), requests };
  }
}
