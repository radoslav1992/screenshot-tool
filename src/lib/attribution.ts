/**
 * First-touch signup attribution.
 *
 * A visitor who arrives with `?ref=`, a `utm_source`/`utm_medium`/
 * `utm_campaign`, or from another site is noted, and signup saves the note
 * with the new account (lib/growth.ts). Nothing here touches a binding, so the
 * middleware, the routes and the check script share it as plain functions.
 *
 * By default the note travels in the links, not in a cookie: the page the
 * visitor lands on carries it in a `src` parameter on its links towards
 * signing up (withTouch), the signup form posts it, and nothing is stored in
 * the browser. A cookie that is not strictly necessary needs consent under
 * the EU's ePrivacy rules, and the site asks for none. The 30-day cookie
 * below, which also survives a visitor leaving and coming back, is switched
 * on with ATTRIBUTION_COOKIE=1, for a deployment that does ask for consent.
 *
 * Only what is listed below is kept, sanitised and capped: never a full
 * referrer URL, never a query string, never anything from a path that carries
 * a token. The cookie is set only when there is none, so the first touch is
 * the one that counts — except that a referral link names its referrer over a
 * first touch that came from somewhere else (see referralCookie).
 */

export const ATTRIBUTION_COOKIE = 'sf_src';
export const ATTRIBUTION_DAYS = 30;

export interface Attribution {
  ref: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  /** The path the visitor landed on, without its query. */
  landing: string | null;
  /** The referring site's host name only. */
  referrerHost: string | null;
  /** When the first touch happened, ISO-8601. */
  at: string;
}

const VALUE_MAX = 64;
const LANDING_MAX = 120;
const HOST_MAX = 100;

/** `?ref=report`, `tool-og-preview`, `referral:abc123`: lower case, a few separators, nothing else. */
export function cleanRef(value: string | null | undefined): string | null {
  const ref = (value ?? '').toLowerCase().replace(/[^a-z0-9._:-]/g, '').slice(0, VALUE_MAX);
  return ref || null;
}

/** A UTM value: words, digits and a few separators, lower case, whitespace collapsed. */
export function cleanUtm(value: string | null | undefined): string | null {
  const text = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ._+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VALUE_MAX)
    .trim();
  return text || null;
}

/** A path, never its query or fragment, in the characters a path needs. */
export function cleanLanding(value: string | null | undefined): string | null {
  const path = (value ?? '').split(/[?#]/)[0]!.replace(/[^A-Za-z0-9/._~-]/g, '').slice(0, LANDING_MAX);
  return path.startsWith('/') ? path : null;
}

/** The host name of a referrer, or null for anything that is not an http(s) URL with a plain host. */
export function referrerHostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return cleanHost(url.hostname);
  } catch {
    return null;
  }
}

function cleanHost(value: string | null | undefined): string | null {
  const host = (value ?? '').toLowerCase();
  return host && host.length <= HOST_MAX && /^[a-z0-9.-]+$/.test(host) ? host : null;
}

/** Another site, treating `www.` and the bare domain as the same site. */
function isExternal(host: string, own: string): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return bare(host) !== bare(own);
}

/**
 * Pages that are never a landing: the app, the APIs, files, share links and
 * one-time links carry tokens or belong to someone signed in; /join keeps its
 * own cookie.
 */
const NOT_LANDINGS = /^\/(?:app|api|v1|f|r|care|brand|join|verify|reset-password|_astro|_image)(?:\/|$)/;

export function isLandingPath(path: string): boolean {
  // A dot in the last segment is a file (sw.js, manifest.webmanifest, icons).
  return !NOT_LANDINGS.test(path) && !/\.[a-z0-9]+$/i.test(path);
}

/** What one request says about where the visitor came from, or null when it says nothing. */
export function touchFrom(url: URL, referer: string | null, now = new Date()): Attribution | null {
  const params = url.searchParams;
  const host = referrerHostOf(referer);
  const touch: Attribution = {
    ref: cleanRef(params.get('ref')),
    source: cleanUtm(params.get('utm_source')),
    medium: cleanUtm(params.get('utm_medium')),
    campaign: cleanUtm(params.get('utm_campaign')),
    landing: cleanLanding(url.pathname),
    referrerHost: host && isExternal(host, url.hostname) ? host : null,
    at: now.toISOString(),
  };
  return touch.ref || touch.source || touch.medium || touch.campaign || touch.referrerHost ? touch : null;
}

/* -------------------------------------------------------------------------- */
/* In the links (the default)                                                  */
/* -------------------------------------------------------------------------- */

/** The query parameter that carries a first touch from page to page. */
export const ATTRIBUTION_PARAM = 'src';

/** The first touch as a plain query string, the value of a `src` parameter or hidden field. */
export function touchParam(touch: Attribution): string {
  return decodeURIComponent(encodeAttribution(touch));
}

/**
 * Where this visitor came from, as far as this request can tell: a `src`
 * carried from the page they landed on, or what this request itself says.
 * A carried touch keeps its own ref; one without takes this page's, so a
 * tool's call to action still names the tool.
 */
export function carriedTouch(url: URL, referer: string | null, now = new Date()): Attribution | null {
  const carried = parseAttribution(url.searchParams.get(ATTRIBUTION_PARAM));
  const ref = cleanRef(url.searchParams.get('ref'));
  if (carried) return carried.ref || !ref ? carried : { ...carried, ref };
  return touchFrom(url, referer, now);
}

/** Links on the way to signing up, which carry the first touch onward. */
const CARRIED_TO = /^\/(?:signup|pricing|client-sign-off|sample-report|features|tools)(?:[/?#]|$)/;

/**
 * A link on a landing page with the first touch added, or null to leave it as
 * it is: only same-site links towards signing up, and never one that already
 * carries a touch. The link's own ref names the hop when the touch has none.
 */
export function withTouch(href: string, touch: Attribution, origin: string): string | null {
  if (!CARRIED_TO.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.searchParams.has(ATTRIBUTION_PARAM)) return null;
  const ref = cleanRef(url.searchParams.get('ref'));
  url.searchParams.set(ATTRIBUTION_PARAM, touchParam(touch.ref || !ref ? touch : { ...touch, ref }));
  return url.pathname + url.search + url.hash;
}

/** The touch a referral link starts, for its redirect to signup. */
export function referralTouch(code: string, url: URL, referer: string | null, now = new Date()): Attribution {
  const host = referrerHostOf(referer);
  return {
    ref: `${REFERRAL_PREFIX}${code}`,
    source: cleanUtm(url.searchParams.get('utm_source')),
    medium: cleanUtm(url.searchParams.get('utm_medium')),
    campaign: cleanUtm(url.searchParams.get('utm_campaign')),
    landing: '/join',
    referrerHost: host && isExternal(host, url.hostname) ? host : null,
    at: now.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* The cookie (ATTRIBUTION_COOKIE=1 only)                                      */
/* -------------------------------------------------------------------------- */

const KEYS = { ref: 'ref', source: 'src', medium: 'med', campaign: 'cmp', landing: 'land', referrerHost: 'host', at: 'at' } as const;

/** A query string inside the cookie, percent-encoded so it is a valid cookie value. */
export function encodeAttribution(touch: Attribution): string {
  const params = new URLSearchParams();
  for (const [field, key] of Object.entries(KEYS)) {
    const value = touch[field as keyof Attribution];
    if (value) params.set(key, value);
  }
  return encodeURIComponent(params.toString());
}

/** Reads a cookie back, sanitising every field again: it came from the browser. */
export function parseAttribution(raw: string | null | undefined): Attribution | null {
  if (!raw || raw.length > 2048) return null;
  let params: URLSearchParams;
  try {
    // Astro's cookies.get() has decoded it once already; the raw header has not.
    // Encoded, it holds no `=`.
    params = new URLSearchParams(raw.includes('=') ? raw : decodeURIComponent(raw));
  } catch {
    return null;
  }
  const at = params.get(KEYS.at) ?? '';
  const time = Date.parse(at);
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at) || !Number.isFinite(time)) return null;
  const touch: Attribution = {
    ref: cleanRef(params.get(KEYS.ref)),
    source: cleanUtm(params.get(KEYS.source)),
    medium: cleanUtm(params.get(KEYS.medium)),
    campaign: cleanUtm(params.get(KEYS.campaign)),
    landing: cleanLanding(params.get(KEYS.landing)),
    referrerHost: cleanHost(params.get(KEYS.referrerHost)),
    at: new Date(time).toISOString(),
  };
  return touch;
}

export function attributionCookie(touch: Attribution, secure: boolean): string {
  const parts = [
    `${ATTRIBUTION_COOKIE}=${encodeAttribution(touch)}`,
    'Path=/',
    `Max-Age=${ATTRIBUTION_DAYS * 86_400}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedAttributionCookie(secure: boolean): string {
  const parts = [`${ATTRIBUTION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** The cookie header in a request, read without a framework. */
export function cookieFrom(request: Request, name = ATTRIBUTION_COOKIE): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * The Set-Cookie a public page answers with, or null. Only for a signed-out
 * visitor's GET of a page that can be a landing, only when the request said
 * where it came from, and only when there is no cookie yet.
 */
export function firstTouchCookie(
  request: Request,
  url: URL,
  existing: string | undefined,
  now = new Date(),
): string | null {
  if (existing !== undefined) return null;
  if (request.method !== 'GET' || !isLandingPath(url.pathname)) return null;
  const touch = touchFrom(url, request.headers.get('referer'), now);
  return touch ? attributionCookie(touch, url.protocol === 'https:') : null;
}

export const REFERRAL_PREFIX = 'referral:';

export function referralCode(touch: Attribution | null): string | null {
  const code = touch?.ref?.startsWith(REFERRAL_PREFIX) ? touch.ref.slice(REFERRAL_PREFIX.length) : '';
  return /^[a-z0-9]{6,16}$/.test(code) ? code : null;
}

/**
 * The cookie a referral link sets. A referral is an invitation someone acted
 * on, so it names its referrer even over an earlier first touch from
 * somewhere else, keeping that touch's campaign, landing and time; the first
 * referral link followed still wins over a later one.
 */
export function referralCookie(existing: Attribution | null, code: string, secure: boolean, now = new Date()): string | null {
  if (referralCode(existing)) return null;
  const touch: Attribution = existing
    ? { ...existing, ref: `${REFERRAL_PREFIX}${code}` }
    : {
        ref: `${REFERRAL_PREFIX}${code}`,
        source: null,
        medium: null,
        campaign: null,
        landing: '/join',
        referrerHost: null,
        at: now.toISOString(),
      };
  return attributionCookie(touch, secure);
}

/**
 * The iOS app signs up with JSON, no Origin header and no attribution;
 * a browser always sends Origin with a POST. URLSession's own user agent
 * (`<App>/<build> CFNetwork/… Darwin/…`) says so too when it is there.
 */
export function looksLikeAppSignup(request: Request): boolean {
  const agent = request.headers.get('user-agent') ?? '';
  if (/\bCFNetwork\/|\bDarwin\//.test(agent) && !/Mozilla\//.test(agent)) return true;
  return (request.headers.get('accept') ?? '').includes('application/json') && !request.headers.get('origin');
}
