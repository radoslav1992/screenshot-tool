import type { APIRoute } from 'astro';
import { SESSION_COOKIE, clearedSessionCookie, destroySession, isSecureRequest } from '../../../lib/auth';
import { assertSameOrigin } from '../../../lib/http';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  assertSameOrigin(request);
  await destroySession(cookies.get(SESSION_COOKIE)?.value);
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': clearedSessionCookie(isSecureRequest(request)) },
  });
};
