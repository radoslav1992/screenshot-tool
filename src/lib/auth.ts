import { env } from 'cloudflare:workers';
import type { PlanId } from './plans';
import { prefixedId, randomId, randomToken, sha256Hex, timingSafeEqual, toHex } from './ids';
import { HttpError } from './http';

export const SESSION_COOKIE = 'sf_session';
export const SESSION_TTL_DAYS = 30;

const PBKDF2_ITERATIONS = 210_000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  periodStart: string;
  createdAt: string;
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
}

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: (row.plan as PlanId) ?? 'free',
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
  const derived = await pbkdf2(password, fromBase64(saltRaw), iterations);
  return timingSafeEqual(toHex(derived), toHex(fromBase64(hashRaw)));
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
