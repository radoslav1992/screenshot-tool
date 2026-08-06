import type { APIRoute } from 'astro';
import { createSession, createUser, isSecureRequest, sessionCookie } from '../../../lib/auth';
import { assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { issueVerificationToken, sendVerificationEmail, verificationEnabled } from '../../../lib/verification';

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

    const email = (body.email ?? '').trim();
    const password = body.password ?? '';
    const next = safeNext(body.next);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('Enter a valid email address.', 'email');
    }
    if (password.length < 8) {
      throw badRequest('Passwords must be at least 8 characters.', 'password');
    }
    if (password.length > 200) {
      throw badRequest('That password is too long.', 'password');
    }

    const user = await createUser({ email, password, name: body.name });

    if (verificationEnabled()) {
      const issued = await issueVerificationToken(user, new URL(request.url).origin);
      await sendVerificationEmail(user.email, issued.link);
    }

    const { token, expiresAt } = await createSession(user.id, request.headers.get('user-agent') ?? '');
    const cookie = sessionCookie(token, expiresAt, isSecureRequest(request));

    if (wantsJson) {
      return json({ user: { id: user.id, email: user.email, name: user.name }, redirect: next }, {
        status: 201,
        headers: { 'set-cookie': cookie },
      });
    }
    return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
  } catch (error) {
    const httpError = toHttpError(error, 'signup', 'Could not create the account.');
    if (wantsJson) return httpError.toResponse();
    return new Response(null, {
      status: 303,
      headers: { location: `/signup?error=${encodeURIComponent(httpError.message)}` },
    });
  }
};
