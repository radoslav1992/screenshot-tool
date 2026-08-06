import type { APIRoute } from 'astro';
import {
  createSession,
  findUserByEmail,
  isSecureRequest,
  sessionCookie,
  toSessionUser,
  verifyPassword,
} from '../../../lib/auth';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';

export const prerender = false;

function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/app';
  return value;
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    const next = safeNext(body.next);

    const row = await findUserByEmail(body.email ?? '');
    const ok = row ? await verifyPassword(body.password ?? '', row.password_hash) : false;

    if (!row || !ok) {
      // Same message either way so the form can't be used to enumerate accounts.
      throw new HttpError(401, 'invalid_credentials', 'That email and password combination is not right.');
    }

    const user = toSessionUser(row);
    const { token, expiresAt } = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(token, expiresAt, isSecureRequest(request));

    if (wantsJson) {
      return json({ user: { id: user.id, email: user.email, name: user.name }, redirect: next }, {
        headers: { 'set-cookie': cookie },
      });
    }
    return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
  } catch (error) {
    const httpError = toHttpError(error, 'login', 'Could not sign you in.');
    if (wantsJson) return httpError.toResponse();
    return new Response(null, {
      status: 303,
      headers: { location: `/login?error=${encodeURIComponent(httpError.message)}` },
    });
  }
};
