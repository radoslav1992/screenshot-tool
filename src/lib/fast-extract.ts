import type { MonitorRule } from './monitor-rules';
import { canonicalKey, decodeSeoSignals, robotsState, type SeoSignalId } from './seo-signals';

/**
 * What a rule-based monitor watches, read straight from the page's HTML.
 *
 * This is the fast check's half of smart checks (fast-checks.ts decides what to
 * do with it). Its values are only ever compared with the values the previous
 * fast check read, never with what a browser saw: raw HTML and a rendered page
 * differ — scripts add text, set titles, fill prices — and comparing across the
 * two would announce changes that never happened. A different signature only
 * sends the check to the browser, whose own comparison decides any alert.
 *
 * Parsing is HTMLRewriter's, the streaming parser built into Workers, and three
 * of its habits shape what is read here. It knows a subset of CSS (no `+`, `~`,
 * `:has()` or pseudo-elements) and refuses the rest when a handler is added. It
 * hands text over in chunks, entities undecoded, and attribute values the same.
 * And it builds no tree: an element whose end tag is implied (`<p>`, `<li>`,
 * `<head>`) closes only when an ancestor does, if at all. So a selector it
 * cannot use, or one the HTML does not contain, makes the check unavailable —
 * never a change — entities are decoded here, and nothing is skipped by
 * waiting for an end tag that may not come, except inside elements whose end
 * the tokenizer itself finds (scripts, styles, titles) or that require one.
 *
 * Everything is a function of the response — body, status, headers, final URL
 * — and the rule, with the parser passed in. That is what lets
 * scripts/fast-checks-check.mjs run this module in workerd against the real
 * HTMLRewriter rather than a stand-in that would share these guesses.
 */

export interface RawPage {
  html: string;
  status: number;
  headers: Headers | Record<string, string>;
  /** Where the request ended up, after redirects: relative links resolve against it. */
  url: string;
  /** The body stopped at the byte cap, so the end of the page was not read. */
  truncated?: boolean;
}

export type UnavailableCode =
  | 'challenge'
  | 'refused'
  | 'server_error'
  | 'not_html'
  | 'too_large'
  | 'selector_unsupported'
  | 'selector_missing'
  | 'hide_unsupported'
  | 'unreadable'
  | 'timeout'
  | 'unreachable'
  | 'redirects'
  | 'interrupted'
  | 'blocked';

/** A fast check that could not answer this time. It is never a change. */
export interface FastUnavailable {
  ok: false;
  code: UnavailableCode;
  /** Why, in plain words, as the monitor page shows it after "Full browser on every check · ". */
  reason: string;
}

export type FastValues = Record<string, string | number | boolean | string[]>;

export interface FastReading {
  ok: true;
  /** A hash of the rule and the normalised values below; equal signatures mean nothing the rule watches changed. */
  signature: string;
  values: FastValues;
  /** Length of the visible text read, for rules that read it; 0 otherwise. */
  textLength: number;
  /** For an SEO rule: what the HTML says before any script runs, for the notes on a browser check. */
  html: { canonical: string; noindex: boolean } | null;
}

export type FastRead = FastReading | FastUnavailable;

/** The HTMLRewriter this module parses with; Workers' own unless a caller passes another. */
export type Rewriter = new () => HTMLRewriter;

const unavailable = (code: UnavailableCode, reason: string): FastUnavailable => ({ ok: false, code, reason });

/* -------------------------------------------------------------------------- */
/* Responses that say nothing about the page                                   */
/* -------------------------------------------------------------------------- */

function headerOf(headers: RawPage['headers'], name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  return key ? headers[key] ?? '' : '';
}

/** Headers bot defences set on the challenge they serve instead of the page. */
const CHALLENGE_HEADERS: Array<[string, RegExp]> = [
  ['cf-mitigated', /challenge/i],
  ['x-vercel-mitigated', /challenge/i],
  ['x-amzn-waf-action', /challenge|captcha/i],
];

/** The statuses a challenge page is served with; on a 200 these words are often just a vendor's script tag. */
const CHALLENGE_STATUSES = new Set([403, 429, 503]);

/**
 * What challenge and block pages say: Cloudflare's "Just a moment…" and its
 * challenge platform, Imperva, DataDome, PerimeterX/HUMAN, Akamai, Sucuri,
 * AWS WAF and DDoS-Guard, and the generic human check.
 */
const CHALLENGE_MARKERS =
  /just a moment(?:\.\.\.|…)|challenge-platform|__cf_chl|cf-browser-verification|attention required! \| cloudflare|_incapsula_resource|incapsula incident|captcha-delivery\.com|datadome|px-captcha|perimeterx|_pxhd|errors\.edgesuite\.net|sucuri website firewall|awswaf|ddos-guard|verify you are human|checking your browser before accessing/i;

/** Whether the response is a bot check standing in for the page. */
export function isChallenge(status: number, headers: RawPage['headers'], html: string): boolean {
  if (CHALLENGE_HEADERS.some(([name, pattern]) => pattern.test(headerOf(headers, name)))) return true;
  return CHALLENGE_STATUSES.has(status) && CHALLENGE_MARKERS.test(html.slice(0, 200_000));
}

/**
 * Statuses that describe the request more often than the page: a login wall,
 * a refusal, a proxy, throttling. A browser fallback still sees a real one.
 */
const REFUSED = new Set([401, 403, 407, 429]);

function responseProblem(rule: MonitorRule, page: RawPage): FastUnavailable | null {
  if (isChallenge(page.status, page.headers, page.html)) {
    return unavailable('challenge', 'The site shows a bot check to anything but a full browser');
  }
  if (REFUSED.has(page.status)) return unavailable('refused', `The site refuses plain requests (HTTP ${page.status})`);
  // An SEO rule watching the status is the one rule a server error is news to.
  const watchesStatus = rule.kind === 'seo' && decodeSeoSignals(rule.selector).includes('status');
  if (page.status >= 500 && !watchesStatus) {
    return unavailable('server_error', `The site answers plain requests with an error (HTTP ${page.status})`);
  }
  const type = headerOf(page.headers, 'content-type');
  if (type && !/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) {
    return unavailable('not_html', 'The address does not answer a plain request with a web page');
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** Named references worth knowing; any other is left as written, which is the same every time. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', middot: '·', bull: '•', deg: '°', plusmn: '±', times: '×',
  divide: '÷', micro: 'µ', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  dollar: '$', percnt: '%', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', iexcl: '¡',
  iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯', acute: '´', uml: '¨', cedil: '¸', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f', dagger: '†',
  Dagger: '‡', permil: '‰', prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  check: '✓', star: '☆', hearts: '♥', minus: '−', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', eacute: 'é', egrave: 'è',
  ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  ccedil: 'ç', Eacute: 'É', Aring: 'Å', aring: 'å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ',
};

/**
 * Character references: numeric ones, the named ones above, and the few a
 * browser decodes even without their semicolon. One pass, so `&amp;lt;` is
 * `&lt;`, as on screen, and not `<`.
 */
const REFERENCE = /&(?:#x([0-9a-f]{1,6});?|#(\d{1,7});?|([a-z][a-z0-9]{1,31});|(amp|lt|gt|quot|nbsp|copy|reg)(?![a-z0-9;]))/gi;

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(REFERENCE, (match, hex?: string, dec?: string, name?: string, legacy?: string) => {
    if (hex !== undefined || dec !== undefined) {
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    }
    if (name !== undefined) return ENTITIES[name] ?? match;
    return ENTITIES[legacy!.toLowerCase()] ?? match;
  });
}

/** Runs of whitespace as one space, trimmed: how page-facts-fn and monitor-rules compare text. */
export function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The numbers in a price, as monitor-rules compares them. */
export function priceNumbers(text: string): string {
  return text.match(/\d+(?:[.,\s\u00a0]\d+)*/g)?.map((n) => n.trim()).join('|') ?? '';
}

/**
 * Elements a browser lays out on a line of their own, so `innerText` breaks
 * between them and two paragraphs never run together into one word. Inline
 * elements (`<b>`, `<span>`) join, as they do on screen.
 */
const BLOCKS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
];

/** A tag, its attributes quoted or not: `>` inside a quoted value does not end it. */
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*>`;
const BLOCK_TAG = new RegExp(`<\\/?(?:${BLOCKS.join('|')})(?=[\\s/>])${TAG_BODY}`, 'gi');
const ANY_TAG = new RegExp(`<\\/?[a-z][a-z0-9-]*${TAG_BODY}|<![^>]*>`, 'gi');

/**
 * Never visible text. Each of these ends where the tokenizer finds its end
 * tag (or, for a template, where the required one is), so a missing end tag
 * cannot hide the rest of the page.
 */
const UNSEEN = 'script, style, template, noscript, title';

/** Elements whose end tag may be left out, so HTMLRewriter cannot say where they end. */
const OPTIONAL_END = new Set([
  'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption',
  'rb', 'rt', 'rtc', 'rp', 'html', 'head', 'body',
]);

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** The text left in markup once HTMLRewriter has removed what is never seen: tags gone, blocks apart. */
function flatten(html: string): string {
  return normaliseText(
    decodeEntities(html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(BLOCK_TAG, ' ').replace(ANY_TAG, '')),
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExtractOptions {
  /** The monitor's hidden-element selectors: the browser removes them before it reads the page, so this does too. */
  hide?: string[];
  Rewriter?: Rewriter;
}

/** Calls `close` when the element ends, if HTMLRewriter can tell; false when it cannot (a void element). */
function onEnd(element: Element, close: () => void): boolean {
  try {
    element.onEndTag(close);
    return true;
  } catch {
    return false;
  }
}

function resolve(href: string, base: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).href;
  } catch {
    return '';
  }
}

/*
 * Every handler HTMLRewriter calls crosses into JavaScript, and on a large
 * page a handler on every element or every text chunk costs far more than the
 * parse itself. So each rule asks for as little as it can: text rules let
 * HTMLRewriter remove what is never seen and flatten what is left; element and
 * SEO rules handle only the elements they read. And since an element takes
 * one end-tag handler — a second onEndTag replaces the first — no two of the
 * handlers below ever register one on the same element.
 */

/** The visible text: what is never seen removed by HTMLRewriter, the rest flattened. */
async function visibleText(Parser: Rewriter, html: string, hide: string[]): Promise<string | FastUnavailable> {
  let rewriter = new Parser().on(UNSEEN, { element: (node) => void node.remove() });
  for (const selector of hide) {
    try {
      rewriter = rewriter.on(selector, {
        element(node) {
          // Where the end cannot be found, removing would swallow the rest of the page; the browser comparison decides instead.
          if (!OPTIONAL_END.has(node.tagName.toLowerCase())) node.remove();
        },
      });
    } catch {
      return unavailable('hide_unsupported', `The hidden-element selector “${selector}” needs a full browser`);
    }
  }
  return flatten(await rewriter.transform(page(html)).text());
}

/** The first element a selector matches outside templates, as querySelector finds it, and its text. */
async function elementText(
  Parser: Rewriter,
  html: string,
  selector: string,
): Promise<{ found: boolean; closed: boolean; text: string } | FastUnavailable> {
  let template = 0;
  const watched = { found: false, open: false, closed: false, text: [] as string[] };
  // Once the first match has ended, the rest of the page has nothing to add: parsing stops there.
  const stop = new Error('read');
  let rewriter = new Parser().on('template', {
    element(node) {
      if (onEnd(node, () => template--)) template++;
    },
  });
  try {
    rewriter = rewriter.on(selector, {
      element(node) {
        // A template's own end tag is the template handler's.
        if (watched.found || template || node.tagName.toLowerCase() === 'template') return;
        watched.found = true;
        const ended = onEnd(node, () => {
          watched.open = false;
          watched.closed = true;
          throw stop;
        });
        if (ended) watched.open = true;
        else watched.closed = true;
      },
      text(chunk) {
        if (watched.open) watched.text.push(chunk.text);
      },
    });
  } catch {
    return unavailable('selector_unsupported', `The selector “${selector}” needs a full browser`);
  }
  try {
    await rewriter.transform(page(html)).arrayBuffer();
  } catch (error) {
    if (!watched.closed) throw error;
  }
  // The first 2,000 characters, as the browser reads the element's textContent.
  return { ...watched, text: normaliseText(decodeEntities(watched.text.join('')).slice(0, 2000)) };
}

/** The tags an SEO rule reads, where page-facts-fn reads them in the browser. */
async function seoTags(Parser: Rewriter, html: string, hide: string[]) {
  const tags = {
    title: null as string[] | null,
    inTitle: false,
    description: null as string | null,
    robots: [] as string[],
    canonical: null as string | null,
    base: null as string | null,
    hreflang: [] as Array<{ lang: string; href: string }>,
    og: {} as Record<string, string>,
    h1: [] as string[],
    h1Count: 0,
    inH1: false,
  };
  // Inside a template, elements are not in the page; inside a hidden element, an h1 is not shown.
  let template = 0;
  let unseen = 0;
  const attr = (node: Element, name: string) => decodeEntities(node.getAttribute(name) ?? '').trim();
  let rewriter = new Parser().on('template', {
    element(node) {
      if (onEnd(node, () => template--)) template++;
    },
  });
  for (const selector of hide) {
    try {
      rewriter = rewriter.on(selector, {
        element(node) {
          const tag = node.tagName.toLowerCase();
          // Templates and titles keep their own end-tag handlers; an implied end cannot be found.
          if (template || tag === 'template' || tag === 'title' || OPTIONAL_END.has(tag)) return;
          if (onEnd(node, () => unseen--)) unseen++;
        },
      });
    } catch {
      return unavailable('hide_unsupported', `The hidden-element selector “${selector}” needs a full browser`);
    }
  }
  rewriter = rewriter
    .on('title', {
      element(node) {
        // The document's title is the first HTML one; an SVG's <title> names a drawing.
        if (tags.title || template || node.namespaceURI !== HTML_NS) return;
        tags.title = [];
        tags.inTitle = onEnd(node, () => (tags.inTitle = false));
      },
      text(chunk) {
        if (tags.inTitle) tags.title!.push(chunk.text);
      },
    })
    .on('meta', {
      element(node) {
        if (template) return;
        const name = (node.getAttribute('name') ?? '').toLowerCase();
        const property = node.getAttribute('property') ?? '';
        const content = attr(node, 'content');
        if (name === 'description' && tags.description === null) tags.description = content;
        if ((name === 'robots' || name === 'googlebot') && content) tags.robots.push(content);
        if (property.startsWith('og:') && property.length > 3 && content && !(property.slice(3) in tags.og)) {
          tags.og[property.slice(3)] = content;
        }
      },
    })
    .on('link', {
      element(node) {
        if (template) return;
        const rel = (node.getAttribute('rel') ?? '').toLowerCase();
        if (rel === 'canonical' && tags.canonical === null) tags.canonical = attr(node, 'href');
        if (rel.split(/\s+/).includes('alternate') && node.hasAttribute('hreflang') && tags.hreflang.length < 50) {
          const lang = attr(node, 'hreflang').toLowerCase();
          const href = attr(node, 'href');
          if (lang && href) tags.hreflang.push({ lang, href });
        }
      },
    })
    .on('base[href]', {
      element(node) {
        if (tags.base === null && !template) tags.base = attr(node, 'href');
      },
    })
    .on('h1', {
      element(node) {
        // A hidden h1 was marked by the hide handlers above, which run first.
        if (template || unseen) return;
        tags.h1Count++;
        if (tags.h1Count === 1) tags.inH1 = onEnd(node, () => (tags.inH1 = false));
      },
      text(chunk) {
        if (tags.inH1 && !unseen) tags.h1.push(chunk.text);
      },
    });
  await rewriter.transform(page(html)).arrayBuffer();
  return tags;
}

/** The body as HTMLRewriter takes it. */
function page(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * Reads what `rule` watches from one response. Unavailable whenever the
 * answer would not be about the page, or could not be read from its HTML.
 */
export async function extractFast(rule: MonitorRule, page: RawPage, options: ExtractOptions = {}): Promise<FastRead> {
  const problem = responseProblem(rule, page);
  if (problem) return problem;
  if (rule.kind === 'visual') return unavailable('unreadable', 'A visual monitor compares screenshots');
  const Parser = options.Rewriter ?? HTMLRewriter;
  const element = rule.kind === 'price' || rule.kind === 'element';
  // A page cut short has an unread end: its text, its phrases and its h1s are not all here.
  if (page.truncated && !element) return unavailable('too_large', 'The page is larger than the 3 MB a fast check reads');

  let values: FastValues;
  let textLength = 0;
  let html: FastReading['html'] = null;
  try {
    if (element) {
      const watched = await elementText(Parser, page.html, rule.selector);
      if ('ok' in watched) return watched;
      if (!watched.found) {
        return unavailable('selector_missing', `“${rule.selector}” is not in the page’s HTML until JavaScript adds it`);
      }
      if (page.truncated && !watched.closed) return unavailable('too_large', 'The page is larger than the 3 MB a fast check reads');
      values = rule.kind === 'price' ? { numbers: priceNumbers(watched.text) } : { text: watched.text };
    } else if (rule.kind === 'seo') {
      const tags = await seoTags(Parser, page.html, options.hide ?? []);
      if ('ok' in tags) return tags;
      const base = resolve(tags.base ?? '', page.url) || page.url;
      const canonical = resolve(tags.canonical ?? '', base);
      const metaRobots = tags.robots.join(', ').slice(0, 500);
      values = seoValues(
        {
          title: normaliseText(decodeEntities((tags.title ?? []).join(''))),
          description: tags.description ?? '',
          canonical,
          robots: metaRobots,
          robots_header: headerOf(page.headers, 'x-robots-tag').slice(0, 500),
          h1: normaliseText(decodeEntities(tags.h1.join(''))).slice(0, 500),
          h1_count: tags.h1Count,
          hreflang: tags.hreflang.map((entry) => ({ lang: entry.lang, href: resolve(entry.href, base) })).filter((entry) => entry.href),
          og: { title: tags.og.title ?? '', description: tags.og.description ?? '', image: tags.og.image ?? '' },
          status: page.status,
        },
        decodeSeoSignals(rule.selector),
      );
      html = { canonical, noindex: robotsState(metaRobots).noindex };
    } else {
      const text = await visibleText(Parser, page.html, options.hide ?? []);
      if (typeof text !== 'string') return text;
      textLength = text.length;
      values =
        rule.kind === 'text' ? { text } : { found: text.toLowerCase().includes(normaliseText(rule.phrase).toLowerCase()) };
    }
  } catch {
    return unavailable('unreadable', 'The page’s HTML could not be read');
  }

  return { ok: true, signature: await signatureOf(rule, values), values, textLength, html };
}

/** The SEO signals as seo-signals compares them, for one page's tags or one capture's facts. */
export interface SeoInput {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  robots_header: string | null;
  h1: string;
  h1_count: number;
  hreflang: Array<{ lang: string; href: string }> | undefined;
  og: { title?: string; description?: string; image?: string } | undefined;
  status: number | null;
}

/**
 * The watched signals, normalised the way compareSeo compares them: text with
 * its whitespace collapsed, URLs as canonicalKey keys, robots as the two
 * states that matter, alternates as a sorted set.
 */
export function seoValues(seo: SeoInput, watched: SeoSignalId[]): FastValues {
  const text = (value: unknown) => (typeof value === 'string' ? normaliseText(value) : '');
  const out: FastValues = {};
  for (const signal of watched) {
    if (signal === 'title') out.title = text(seo.title);
    if (signal === 'description') out.description = text(seo.description);
    if (signal === 'canonical') out.canonical = canonicalKey(seo.canonical);
    if (signal === 'robots') {
      const meta = robotsState(seo.robots ?? '');
      const header = robotsState(seo.robots_header ?? '');
      out.robots = `${meta.noindex || header.noindex ? 'noindex' : 'index'},${meta.nofollow || header.nofollow ? 'nofollow' : 'follow'}`;
    }
    if (signal === 'h1') {
      out.h1 = text(seo.h1);
      out.h1_count = seo.h1_count;
    }
    if (signal === 'hreflang') {
      out.hreflang = (seo.hreflang ?? [])
        .map((entry) => `${text(entry.lang).toLowerCase()} ${canonicalKey(entry.href)}`)
        .filter((entry) => !entry.startsWith(' '))
        .sort();
    }
    if (signal === 'og') {
      out.og_title = text(seo.og?.title);
      out.og_description = text(seo.og?.description);
      out.og_image = canonicalKey(seo.og?.image ?? '');
    }
    if (signal === 'status') out.status = seo.status ?? 0;
  }
  return out;
}

/**
 * A deterministic hash of the rule and what it read. The rule is part of it,
 * so a reading taken for another phrase or selector never matches.
 */
export async function signatureOf(rule: MonitorRule, values: FastValues): Promise<string> {
  const keyed = Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
  const payload = JSON.stringify({
    v: 1,
    kind: rule.kind,
    phrase: normaliseText(rule.phrase).toLowerCase(),
    selector: rule.selector,
    values: keyed,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
