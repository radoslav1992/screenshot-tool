import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, resolveSession } from './lib/auth';
import { ATTRIBUTION_COOKIE, carriedTouch, firstTouchCookie, isLandingPath, withTouch } from './lib/attribution';
import { attributionCookieEnabled } from './lib/growth';
import { safeNext } from './lib/safe-next';

/** Routes that require a signed-in user (prefix match). */
const PROTECTED_PREFIXES = ['/app'];

/** Routes a signed-in user should not linger on. */
const GUEST_ONLY = ['/login', '/signup'];

/**
 * Kept deliberately small. The site relies on inline scripts and styles, and on
 * forms that post here and are redirected on to Stripe, so `script-src`,
 * `style-src` and `form-action` are left alone; this only closes framing,
 * `<base>` hijacking and plugin content, none of which the site uses.
 */
const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // The public API authenticates with bearer keys, not cookies.
  const isPublicApi = path.startsWith('/v1/');
  try {
    context.locals.user = isPublicApi ? null : await resolveSession(context.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    // A database that is unreachable or missing its schema should not turn every
    // page into a 500 — treat the visitor as signed out and let the route decide.
    console.error('[middleware] session lookup failed', error);
    context.locals.user = null;
  }

  if (!context.locals.user && PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    const target = `${path}${context.url.search}`;
    return withSecurityHeaders(context.redirect(`/login?next=${encodeURIComponent(target)}`, 302), context.url);
  }

  if (context.locals.user && GUEST_ONLY.includes(path)) {
    // Someone already signed in who follows an invitation link through the
    // login page should still end up at the invitation.
    const target = safeNext(context.url.searchParams.get('next'), context.url.origin);
    const landing = GUEST_ONLY.includes(new URL(target, context.url.origin).pathname) ? '/app' : target;
    return withSecurityHeaders(context.redirect(landing, 302), context.url);
  }

  const response = withSecurityHeaders(await next(), context.url);
  if (context.locals.user || response.status >= 400) return response;
  // Where a signed-out visitor first came from, for signup (lib/attribution.ts).
  if (attributionCookieEnabled()) {
    // Appended after the page has set its own headers, so it adds a cookie and
    // changes nothing else about the response.
    const touch = firstTouchCookie(context.request, context.url, context.cookies.get(ATTRIBUTION_COOKIE)?.value);
    if (touch) response.headers.append('set-cookie', touch);
    return response;
  }
  return carryTouch(context.request, context.url, response);
});

/**
 * Without the cookie, a landing page carries the first touch in its links
 * towards signing up, so the signup form can post it. Only signed-out GETs of
 * HTML pages that say where the visitor came from are rewritten; everything
 * else passes through untouched. A page rewritten from the Referer differs by
 * visitor, so it is not cached for anyone else.
 */
function carryTouch(request: Request, url: URL, response: Response): Response {
  if (request.method !== 'GET' || !isLandingPath(url.pathname)) return response;
  if (!(response.headers.get('content-type') ?? '').includes('text/html') || typeof HTMLRewriter === 'undefined') {
    return response;
  }
  const touch = carriedTouch(url, request.headers.get('referer'));
  if (!touch) return response;
  const rewritten = new HTMLRewriter()
    .on('a[href]', {
      element(link) {
        // HTMLRewriter hands attributes over as written, entities and all
        // (Astro writes `&` as `&amp;`), and writes them back as given.
        const written = (link.getAttribute('href') ?? '').replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
        const href = withTouch(written, touch, url.origin);
        if (href) link.setAttribute('href', href.replace(/&/g, '&amp;'));
      },
    })
    .transform(response);
  rewritten.headers.set('cache-control', 'private, no-cache');
  return rewritten;
}

/**
 * Baseline security headers. `nosniff` and HSTS go on every response; the
 * framing and referrer rules only mean anything on documents.
 */
function withSecurityHeaders(response: Response, url: URL): Response {
  const apply = (headers: Headers) => {
    headers.set('x-content-type-options', 'nosniff');
    // Only over HTTPS: browsers ignore it on plain HTTP, and local dev runs there.
    if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000');

    if (headers.get('content-type')?.includes('text/html')) {
      if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'strict-origin-when-cross-origin');
      headers.set('x-frame-options', 'DENY');
      headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=()');
      if (!headers.has('content-security-policy')) headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
    }
  };

  try {
    apply(response.headers);
    return response;
  } catch {
    // Some responses (a proxied `fetch`, `Response.redirect`) have immutable
    // headers. Copy rather than drop the headers or fail the request.
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}
