import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, resolveSession } from './lib/auth';

/** Routes that require a signed-in user (prefix match). */
const PROTECTED_PREFIXES = ['/app'];

/** Routes a signed-in user should not linger on. */
const GUEST_ONLY = ['/login', '/signup'];

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;

  // The public API authenticates with bearer keys, not cookies.
  const isPublicApi = path.startsWith('/v1/');
  try {
    context.locals.user = isPublicApi
      ? null
      : await resolveSession(context.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    // A database that is unreachable or missing its schema should not turn every
    // page into a 500 — treat the visitor as signed out and let the route decide.
    console.error('[middleware] session lookup failed', error);
    context.locals.user = null;
  }

  if (!context.locals.user && PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    const target = `${path}${context.url.search}`;
    return context.redirect(`/login?next=${encodeURIComponent(target)}`, 302);
  }

  if (context.locals.user && GUEST_ONLY.includes(path)) {
    return context.redirect('/app', 302);
  }

  const response = await next();

  // Baseline security headers for every HTML document we serve.
  if (response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    response.headers.set('x-frame-options', 'DENY');
    response.headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  }

  return response;
});
