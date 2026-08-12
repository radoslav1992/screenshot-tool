import { badRequest } from './http';

/**
 * Reaching pages that are not open to the public.
 *
 * The pages people most want captured on a schedule — a dashboard, a staging
 * site, an internal tool — are exactly the ones a public renderer cannot see.
 * This carries a header, a cookie or a basic-auth pair for the length of one
 * capture.
 *
 * Nothing here is stored. Credentials arrive with the request, live in the
 * browser session, and go when it closes. Watches deliberately cannot use them
 * yet: keeping someone's session cookie at rest needs an encryption key and a
 * rotation story, and half of that is worse than none.
 */

export interface RequestAuth {
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string }>;
  basic?: { username: string; password: string };
}

const MAX_HEADERS = 10;
const MAX_COOKIES = 20;
const MAX_VALUE = 4_000;

/**
 * Headers the caller may not set.
 *
 * `host` would let a capture of a public URL be served by a different origin
 * than the one that was checked — the SSRF guard validates the address, and
 * this would quietly change what answers at it. The rest are the browser's to
 * say, and overriding them produces confusing rather than useful captures.
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
]);

function parseObject(raw: string | undefined, param: string): Record<string, string> {
  const value = (raw ?? '').trim();
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw badRequest(`\`${param}\` must be a JSON object.`, param);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest(`\`${param}\` must be a JSON object.`, param);
  }

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    const text = String(entry);
    if (text.length > MAX_VALUE) throw badRequest(`\`${param}.${key}\` is too long.`, param);
    out[key] = text;
  }
  return out;
}

export function parseRequestAuth(input: Record<string, string>): RequestAuth {
  const rawHeaders = parseObject(input.headers, 'headers');
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase().trim();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) {
      throw badRequest(`\`${name}\` is not a valid header name.`, 'headers');
    }
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw badRequest(`\`${name}\` cannot be set on a capture.`, 'headers');
    }
    if (/[\r\n]/.test(value)) throw badRequest(`\`${name}\` may not contain line breaks.`, 'headers');
    headers[lower] = value;
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    throw badRequest(`\`headers\` takes at most ${MAX_HEADERS} entries.`, 'headers');
  }

  const cookies = Object.entries(parseObject(input.cookies, 'cookies')).map(([name, value]) => {
    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(name)) {
      throw badRequest(`\`${name}\` is not a valid cookie name.`, 'cookies');
    }
    if (/[\r\n;]/.test(value)) throw badRequest(`The \`${name}\` cookie has an invalid value.`, 'cookies');
    return { name, value };
  });
  if (cookies.length > MAX_COOKIES) {
    throw badRequest(`\`cookies\` takes at most ${MAX_COOKIES} entries.`, 'cookies');
  }

  const basicRaw = (input.basic_auth ?? '').trim();
  let basic: RequestAuth['basic'];
  if (basicRaw) {
    const at = basicRaw.indexOf(':');
    if (at <= 0) throw badRequest('`basic_auth` must be `username:password`.', 'basic_auth');
    basic = { username: basicRaw.slice(0, at), password: basicRaw.slice(at + 1) };
  }

  return { headers, cookies, ...(basic ? { basic } : {}) };
}

export function hasRequestAuth(auth: RequestAuth): boolean {
  return Object.keys(auth.headers).length > 0 || auth.cookies.length > 0 || Boolean(auth.basic);
}
