import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { HttpError } from './http';
import { randomToken, sha256Hex } from './ids';

const TOKEN_TTL_HOURS = 24;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Verification is only enforced when this deployment can actually deliver mail.
 *
 * Gating captures on a link nobody can receive would lock every new account out
 * of the product, so the gate turns itself on with the mailer: set
 * REQUIRE_EMAIL_VERIFICATION=1 and configure RESEND_API_KEY.
 */
export function verificationEnabled(): boolean {
  return env.REQUIRE_EMAIL_VERIFICATION === '1' && canSendEmail();
}

export function canSendEmail(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export interface VerificationIssue {
  token: string;
  link: string;
  expiresAt: string;
}

export async function issueVerificationToken(
  user: Pick<SessionUser, 'id' | 'email'>,
  origin: string,
): Promise<VerificationIssue> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_HOURS * 3_600_000);

  await env.DB.prepare(
    `INSERT INTO email_verifications (id, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, user.email, now.toISOString(), expiresAt.toISOString())
    .run();

  return {
    token,
    link: `${origin}/verify?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Marks the account verified. Returns the user id, or null if the token is not usable. */
export async function consumeVerificationToken(token: string): Promise<string | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const now = new Date().toISOString();

  const row = await env.DB.prepare(
    `SELECT user_id FROM email_verifications WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(id, now)
    .first<{ user_id: string }>();

  if (!row) return null;

  await env.DB.batch([
    env.DB.prepare(`UPDATE email_verifications SET used_at = ? WHERE id = ?`).bind(now, id),
    env.DB.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?`).bind(
      now,
      now,
      row.user_id,
    ),
  ]);

  return row.user_id;
}

export async function isVerified(userId: string): Promise<boolean> {
  if (!verificationEnabled()) return true;
  const row = await env.DB.prepare(`SELECT email_verified_at FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ email_verified_at: string | null }>();
  return Boolean(row?.email_verified_at);
}

/** Throws a 403 when the account still needs to confirm its email address. */
export async function assertVerified(user: SessionUser): Promise<void> {
  if (await isVerified(user.id)) return;
  throw new HttpError(
    403,
    'email_unverified',
    'Confirm your email address before capturing. Check your inbox for the link, or request a new one from your account page.',
  );
}

/**
 * Sends the verification email. Returns false when no mailer is configured, in
 * which case the link is logged so a self-hosted deployment can still complete
 * a signup by hand.
 */
export async function sendVerificationEmail(email: string, link: string): Promise<boolean> {
  if (!canSendEmail()) {
    console.log(`[verification] no mailer configured; verification link for ${email}: ${link}`);
    return false;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Confirm your Easy Screen Capture account',
      text: `Confirm your email address to start capturing:\n\n${link}\n\nThis link expires in ${TOKEN_TTL_HOURS} hours. If you did not create an Easy Screen Capture account, ignore this message.`,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    // Log the link on failure too, so a broken mailer does not strand the
    // account with no way to finish signing up.
    console.error(
      `[verification] mailer responded ${response.status}: ${detail}; verification link for ${email}: ${link}`,
    );
    return false;
  }

  return true;
}
