import { env } from 'cloudflare:workers';
import { getPlan, type PlanId } from './plans';
import { prefixedId, randomId, randomToken, sha256Hex, timingSafeEqual, toHex } from './ids';
import { HttpError, badRequest } from './http';

export const SESSION_COOKIE = 'sf_session';
export const SESSION_TTL_DAYS = 30;

/**
 * The Workers runtime refuses PBKDF2 above 100,000 iterations — it throws
 * `DOMNotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 * supported`. This is the platform ceiling, so it is also our cost factor.
 *
 * Note that the local runtime does not enforce this, so a higher value passes
 * every local test and only fails once deployed. Do not raise it without
 * confirming Cloudflare has lifted the cap.
 *
 * The count is stored in each hash, so raising it later re-stretches passwords
 * on next login without invalidating existing ones.
 */
const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  periodStart: string;
  createdAt: string;
  freeQuota?: number;
}

export interface UserRow {
  id: string;
  email: string;
  email_lower: string;
  name: string;
  password_hash: string | null;
  plan: string;
  period_start: string;
  created_at: string;
  updated_at: string;
  free_quota?: number;
  apple_expires_at?: string | null;
}

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: getPlan(row.plan).id === 'free' && (row.apple_expires_at ?? '') > new Date().toISOString() ? 'lite' : getPlan(row.plan).id,
    freeQuota: row.free_quota ?? 20,
    periodStart: row.period_start,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterationsRaw || !saltRaw || !hashRaw) return false;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    // Written by a build that used a cost factor this runtime cannot replay.
    // Fail closed rather than throwing a 500 out of the login route.
    console.error(
      `[auth] stored hash uses ${iterations} PBKDF2 iterations, above the runtime maximum of ${PBKDF2_MAX_ITERATIONS}; the password cannot be verified and must be reset`,
    );
    return false;
  }
  const derived = await pbkdf2(password, fromBase64(saltRaw), iterations);
  return timingSafeEqual(toHex(derived), toHex(fromBase64(hashRaw)));
}

/**
 * A genuine hash of a password nobody knows. Checking against it when there is
 * no account to check against costs the same PBKDF2 run as a real login, so the
 * response time does not say which addresses are registered.
 */
const DUMMY_HASH = 'pbkdf2$100000$FiBaxWQNfkwQlpPTAf0OMw==$ReeZN+9w6C6HDOzhLXTiZ62PSnKo5CH0NUx3pt/9wZY=';

/** `verifyPassword`, but it does the work even when there is nothing stored. */
export async function verifyPasswordEvenly(password: string, stored: string | null | undefined): Promise<boolean> {
  if (stored) return verifyPassword(password, stored);
  await verifyPassword(password, DUMMY_HASH);
  return false;
}

export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;

/** The rules signup applies, shared by password changes and resets. */
export function checkNewPassword(password: string, param = 'password'): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw badRequest(`Passwords must be at least ${PASSWORD_MIN_LENGTH} characters.`, param);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw badRequest('That password is too long.', param);
  }
}

/**
 * Sets a new password and signs out every session except, optionally, the one
 * making the change. One batch, so a password never changes while the sessions
 * opened under the old one survive.
 *
 * `expectedHash` makes it a compare-and-swap: the write only lands while the
 * password is still the one the caller checked, so two submissions of the same
 * reset link (or two password changes racing) cannot both win. The session
 * delete is tied to the same outcome, so a losing request ends nobody's session.
 *
 * `confirmEmail` is for resets: following a link sent to the address proves
 * the person controls it, which is everything verification asks for.
 */
export async function replacePassword(
  userId: string,
  password: string,
  options: { expectedHash?: string | null; keepSessionToken?: string; confirmEmail?: boolean } = {},
): Promise<{ replaced: boolean; sessionsEnded: number }> {
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  const guarded = options.expectedHash !== undefined;
  const guard = guarded ? ' AND password_hash IS ?' : '';
  const guardArgs = guarded ? [options.expectedHash ?? null] : [];

  const update = options.confirmEmail
    ? env.DB.prepare(
        `UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
         WHERE id = ?${guard}`,
      ).bind(hash, now, now, userId, ...guardArgs)
    : env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?${guard}`).bind(
        hash,
        now,
        userId,
        ...guardArgs,
      );

  const keep = options.keepSessionToken ? await sha256Hex(options.keepSessionToken) : null;
  const sessions = env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ?${keep ? ' AND id <> ?' : ''}
       AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
  ).bind(userId, ...(keep ? [keep] : []), userId, hash);

  const [updated, ended] = await env.DB.batch([update, sessions]);
  return { replaced: (updated?.meta?.changes ?? 0) > 0, sessionsEnded: ended?.meta?.changes ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export async function createSession(userId: string, userAgent: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, now.toISOString(), expiresAt.toISOString(), userAgent.slice(0, 255))
    .run();
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(id, new Date().toISOString())
    .first<UserRow>();
  return row ? toSessionUser(row) : null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await sha256Hex(token)).run();
}

/**
 * Signs a user out everywhere, or everywhere but the session in `keepToken`.
 * Push registrations hang off sessions, so those devices stop getting alerts.
 */
export async function endSessions(userId: string, keepToken?: string): Promise<number> {
  const result = keepToken
    ? await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND id <> ?`)
        .bind(userId, await sha256Hex(keepToken))
        .run()
    : await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  return result.meta?.changes ?? 0;
}

export async function countSessions(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?`)
    .bind(userId, new Date().toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${SESSION_TTL_DAYS * 86_400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function createUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<SessionUser> {
  const emailLower = input.email.trim().toLowerCase();
  const now = new Date().toISOString();
  const id = prefixedId('usr', 14);
  const passwordHash = await hashPassword(input.password);
  const name = (input.name ?? '').trim() || emailLower.split('@')[0]!;

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_lower, name, password_hash, plan, period_start, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?)`,
    )
      .bind(id, input.email.trim(), emailLower, name, passwordHash, now, now, now)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE')) {
      throw new HttpError(409, 'email_taken', 'An account with that email already exists.', 'email');
    }
    throw error;
  }

  return {
    id,
    email: input.email.trim(),
    name,
    plan: 'free',
    periodStart: now,
    createdAt: now,
  };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT * FROM users WHERE email_lower = ?`)
    .bind(email.trim().toLowerCase())
    .first<UserRow>();
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                    */
/* -------------------------------------------------------------------------- */

export interface ApiKeyRow {
  id: string;
  user_id: string;
  hash: string;
  prefix: string;
  last4: string;
  label: string;
  environment: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function issueApiKey(
  userId: string,
  label: string,
  environment: 'live' | 'test',
): Promise<{ id: string; secret: string; row: ApiKeyRow }> {
  const secret = `sk_${environment}_${randomId(32)}`;
  const hash = await sha256Hex(secret);
  const id = prefixedId('key', 12);
  const now = new Date().toISOString();
  const row: ApiKeyRow = {
    id,
    user_id: userId,
    hash,
    prefix: secret.slice(0, 12),
    last4: secret.slice(-4),
    label: label.slice(0, 60) || (environment === 'live' ? 'Production' : 'Test'),
    environment,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, hash, prefix, last4, label, environment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.user_id, row.hash, row.prefix, row.last4, row.label, row.environment, row.created_at)
    .run();
  return { id, secret, row };
}

export interface ApiKeyAuth {
  user: SessionUser;
  keyId: string;
  environment: string;
}

/** Resolves `Authorization: Bearer sk_…` (or `?api_key=`) to a user. */
export async function authenticateApiKey(request: Request): Promise<ApiKeyAuth> {
  const header = request.headers.get('authorization') ?? '';
  let secret = '';
  if (header.toLowerCase().startsWith('bearer ')) secret = header.slice(7).trim();
  if (!secret) secret = new URL(request.url).searchParams.get('api_key') ?? '';
  if (!secret) {
    throw new HttpError(401, 'missing_api_key', 'Provide your API key as `Authorization: Bearer sk_…`.');
  }

  const hash = await sha256Hex(secret);
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.environment, k.revoked_at, u.*
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.hash = ?`,
  )
    .bind(hash)
    .first<UserRow & { key_id: string; environment: string; revoked_at: string | null }>();

  if (!row || row.revoked_at) {
    throw new HttpError(401, 'invalid_api_key', 'That API key is not valid or has been revoked.');
  }

  return { user: toSessionUser(row), keyId: row.key_id, environment: row.environment };
}

export async function touchApiKey(keyId: string): Promise<void> {
  await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), keyId)
    .run();
}
