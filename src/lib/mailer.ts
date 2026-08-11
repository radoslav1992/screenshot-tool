import { env } from 'cloudflare:workers';

/**
 * Outbound mail.
 *
 * Two transports, tried in that order:
 *
 *  1. The Cloudflare Email Sending binding (`EMAIL`). No API key, no secret to
 *     rotate — the Worker is authorised by the binding itself. The sending
 *     domain has to be onboarded in the Cloudflare dashboard first; until it is,
 *     `send()` throws, which is why the fallback below still exists.
 *  2. Resend over REST, for a deployment that has no binding.
 *
 * With neither configured nothing is sent and the caller is told so, rather than
 * pretending a message went out.
 */

export type MailTransport = 'cloudflare' | 'resend' | 'none';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Sender {
  name?: string;
  email: string;
}

/**
 * EMAIL_FROM may be a bare address or `Name <address>`. Resend takes the raw
 * string; the Cloudflare binding wants the two parts separately, so it is parsed
 * once here rather than at each call site.
 */
export function parseSender(raw: string | undefined): Sender | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  const withName = value.match(/^(.*?)\s*<([^>]+)>$/);
  const email = (withName ? withName[2] : value).trim();
  if (!email.includes('@') || /\s/.test(email)) return null;

  const name = withName ? withName[1]!.trim().replace(/^"|"$/g, '') : '';
  return name ? { name, email } : { email };
}

export function sender(): Sender | null {
  return parseSender(env.EMAIL_FROM);
}

/** Which transport a message would go out on right now. */
export function mailTransport(): MailTransport {
  if (!sender()) return 'none';
  if (env.EMAIL) return 'cloudflare';
  if (env.RESEND_API_KEY) return 'resend';
  return 'none';
}

export function canSendEmail(): boolean {
  return mailTransport() !== 'none';
}

async function sendViaBinding(mail: Mail, from: Sender): Promise<void> {
  await env.EMAIL!.send({
    from: from.name ? { name: from.name, email: from.email } : from.email,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
}

async function sendViaResend(mail: Mail, from: Sender): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: from.name ? `${from.name} <${from.email}>` : from.email,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

/**
 * Sends one message. Returns false instead of throwing: every caller so far is
 * in the middle of something more important than the email — a signup should not
 * fail because a mailbox provider is having a bad minute — and each logs what to
 * do about it.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const from = sender();
  if (!from) return false;

  // The binding is the preferred transport, but a domain that has not finished
  // onboarding rejects the send. Falling through to Resend keeps a deployment
  // that has both configured working during that window.
  if (env.EMAIL) {
    try {
      await sendViaBinding(mail, from);
      return true;
    } catch (error) {
      console.error('[mail] Cloudflare Email Sending failed', error);
      if (!env.RESEND_API_KEY) return false;
    }
  }

  if (!env.RESEND_API_KEY) return false;

  try {
    await sendViaResend(mail, from);
    return true;
  } catch (error) {
    console.error('[mail] Resend failed', error);
    return false;
  }
}
