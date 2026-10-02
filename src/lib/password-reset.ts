import { env } from 'cloudflare:workers';
import type { UserRow } from './auth';
import { randomToken, sha256Hex } from './ids';
import { canSendEmail, sendMail } from './mailer';

/**
 * Password reset links.
 *
 * Tokens live in KV rather than D1 so this needs no migration: only a hash of
 * the token is the key, the entry expires on its own after an hour, and it is
 * deleted the moment it is used.
 *
 * KV deletes take a while to reach every location, so deletion alone would
 * leave a used link working elsewhere for up to a minute. Each entry therefore
 * also carries a fingerprint of the password hash it was issued against, and
 * D1 — which is consistent — has the final say: once the password changes, by
 * this link or any other way, every outstanding link stops working.
 */

export const RESET_TTL_SECONDS = 3600;
const PREFIX = 'pwreset:';

interface ResetEntry {
  userId: string;
  stamp: string;
}

export function resetAvailable(): boolean {
  return canSendEmail();
}

/** Tokens are 32 random bytes in hex; anything else is not worth a lookup. */
export function wellFormedResetToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token);
}

async function keyFor(token: string): Promise<string> {
  return `${PREFIX}${await sha256Hex(token)}`;
}

async function passwordStamp(hash: string | null | undefined): Promise<string> {
  return (await sha256Hex(`password-reset:${hash ?? ''}`)).slice(0, 32);
}

export async function issueResetToken(user: Pick<UserRow, 'id' | 'password_hash'>): Promise<string> {
  const token = randomToken(32);
  const entry: ResetEntry = { userId: user.id, stamp: await passwordStamp(user.password_hash) };
  await env.RATE.put(await keyFor(token), JSON.stringify(entry), { expirationTtl: RESET_TTL_SECONDS });
  return token;
}

/**
 * The account a link resets, or null when the link is unknown, expired, used,
 * or issued before the password last changed. Reading does not use it up, so
 * a mail scanner that opens the link does not break it.
 */
export async function findResetUser(token: string): Promise<UserRow | null> {
  if (!wellFormedResetToken(token)) return null;
  const raw = await env.RATE.get(await keyFor(token));
  if (!raw) return null;

  let entry: ResetEntry;
  try {
    entry = JSON.parse(raw) as ResetEntry;
  } catch {
    return null;
  }
  if (!entry?.userId || !entry.stamp) return null;

  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(entry.userId).first<UserRow>();
  if (!user) return null;
  if ((await passwordStamp(user.password_hash)) !== entry.stamp) return null;
  return user;
}

export async function discardResetToken(token: string): Promise<void> {
  if (!wellFormedResetToken(token)) return;
  await env.RATE.delete(await keyFor(token));
}

export async function sendResetEmail(email: string, link: string): Promise<boolean> {
  const sent = await sendMail({
    to: email,
    subject: 'Reset your Easy Screen Capture password',
    text:
      `Someone asked to reset the password for this Easy Screen Capture account. To choose a new password, open:\n\n${link}\n\n` +
      `The link works once and expires in ${RESET_TTL_SECONDS / 3600} hour. Resetting signs out every device that is signed in to the account.\n\n` +
      'If you did not ask for this, ignore this message — your password stays as it is.',
  });
  // Unlike verification, the link is not logged on failure: it grants the account.
  if (!sent) console.error('[password-reset] could not send the reset email');
  return sent;
}
