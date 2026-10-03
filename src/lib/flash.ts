import type { AstroCookies } from 'astro';
import { isSecureRequest } from './auth';

/**
 * A one-time message for the page a form post redirects back to.
 *
 * Without JavaScript, a failed sign-in or password form answers with a
 * redirect, and the reason used to ride along as `?error=<text>`. Anything in
 * a URL can be typed by someone else, so a link to the real login page could
 * show "Your account is locked, call …". The message now travels in a cookie
 * scoped to the page it is for and lasting a minute: only this site can set
 * it, and the page clears it as soon as it has been shown.
 */
const FLASH_COOKIE = 'sf_flash';
const FLASH_SECONDS = 60;
const FLASH_MAX = 300;

/** A 303 to `location` that carries `message` for that page alone. */
export function redirectWithFlash(request: Request, location: string, message: string, headers: HeadersInit = {}): Response {
  const path = new URL(location, request.url).pathname;
  const parts = [
    `${FLASH_COOKIE}=${encodeURIComponent(message.slice(0, FLASH_MAX))}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${FLASH_SECONDS}`,
  ];
  if (isSecureRequest(request)) parts.push('Secure');
  const response = new Response(null, { status: 303, headers: { ...headers, location } });
  response.headers.append('set-cookie', parts.join('; '));
  return response;
}

/** The message left for this page, if any. Reading it clears it. */
export function takeFlash(cookies: AstroCookies, pathname: string): string {
  // Raw, decoded once here: a message containing "%" must not be decoded twice.
  const raw = cookies.get(FLASH_COOKIE, { decode: (value) => value })?.value;
  if (raw === undefined) return '';
  cookies.delete(FLASH_COOKIE, { path: pathname });
  try {
    return decodeURIComponent(raw).slice(0, FLASH_MAX);
  } catch {
    return '';
  }
}
