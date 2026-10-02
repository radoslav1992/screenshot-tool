import type { APIRoute } from 'astro';
import { SESSION_COOKIE, clearedSessionCookie, destroySession, isSecureRequest } from '../../../lib/auth';
import { assertSameOrigin, json } from '../../../lib/http';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  assertSameOrigin(request);
  await destroySession(cookies.get(SESSION_COOKIE)?.value);
  if ((request.headers.get('accept') ?? '').includes('application/json')) {
    return json({ signed_out: true }, { headers: {
      'set-cookie': clearedSessionCookie(isSecureRequest(request)), 'cache-control': 'no-store',
    } });
  }
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': clearedSessionCookie(isSecureRequest(request)) },
  });
};
