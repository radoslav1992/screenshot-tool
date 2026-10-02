import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { HttpError } from './http';
import { randomToken, sha256Hex } from './ids';
import { canSendEmail, sendMail } from './mailer';

const TOKEN_TTL_HOURS = 24;

export { canSendEmail };

/**
 * Verification is only enforced when this deployment can actually deliver mail.
 *
 * Gating captures on a link nobody can receive would lock every new account out
 * of the product, so the gate turns itself on with the mailer: set
 * REQUIRE_EMAIL_VERIFICATION=1 and configure a transport (see lib/mailer.ts).
 */
export function verificationEnabled(): boolean {
  return env.REQUIRE_EMAIL_VERIFICATION === '1' && canSendEmail();
}

/**
 * Whether confirmation emails go out at all — at signup and on request.
 *
 * Deliberately separate from the capture gate above. A confirmed address is
 * also what accepting a team invitation and receiving project digests need, so
 * it is worth asking for whenever mail can be delivered, even on a deployment
 * that lets unconfirmed accounts capture.
 */
export function confirmationEmailsEnabled(): boolean {
  return canSendEmail();
}

export interface VerificationIssue {
  token: string;
  link: string;
  expiresAt: string;
}

/**
 * `next` is where the confirmation page offers to continue — the invitation
 * that asked for a confirmed address, say. It must already be a safe local
 * path (see lib/safe-next.ts); the page checks it again.
 */
export async function issueVerificationToken(
  user: Pick<SessionUser, 'id' | 'email'>,
  origin: string,
  next?: string,
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
    link: `${origin}/verify?token=${token}${next && next !== '/app' ? `&next=${encodeURIComponent(next)}` : ''}`,
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

/** Whether the capture gate lets this account through. True whenever the gate is off. */
export async function isVerified(userId: string): Promise<boolean> {
  if (!verificationEnabled()) return true;
  return hasConfirmedEmail(userId);
}

/** Whether the address really has been confirmed, whatever the gate says. */
export async function hasConfirmedEmail(userId: string): Promise<boolean> {
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

  // Only say capturing waits on it when it does.
  const why = verificationEnabled()
    ? 'Confirm your email address to start capturing:'
    : 'Confirm your email address so you can accept team invitations and receive project digests:';
  const sent = await sendMail({
    to: email,
    subject: 'Confirm your Easy Screen Capture account',
    text: `${why}\n\n${link}\n\nThis link expires in ${TOKEN_TTL_HOURS} hours. If you did not create an Easy Screen Capture account, ignore this message.`,
  });

  // Log the link on failure too, so a broken mailer does not strand the account
  // with no way to finish signing up.
  if (!sent) console.error(`[verification] send failed; verification link for ${email}: ${link}`);

  return sent;
}
