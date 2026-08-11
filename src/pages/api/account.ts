import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { clearedSessionCookie, isSecureRequest, verifyPassword } from '../../lib/auth';
import { billingEnabled, cancelSubscriptionImmediately, getBillingRow, hasActiveSubscription } from '../../lib/billing';
import { deleteAccount } from '../../lib/account-deletion';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const body = await readBody(request);
    const name = (body.name ?? '').trim();

    if (!name) throw badRequest('Enter a display name.', 'name');
    if (name.length > 60) throw badRequest('That name is too long.', 'name');

    await env.DB.prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, new Date().toISOString(), user.id)
      .run();

    return json({ id: user.id, name, email: user.email });
  } catch (error) {
    return toHttpError(error, 'account.update', 'Could not update your profile.').toResponse();
  }
};

/**
 * DELETE /api/account — closes the account for good.
 *
 * The privacy policy promises erasure on request; doing it from the app rather
 * than by email means nobody has to wait on a human to honour it.
 *
 * Confirmation is the account password, or — for an account that has none, which
 * a future sign-in provider would create — the email address typed out. Either
 * way it takes more than a stray click on a phone, and a stolen session cookie
 * alone is not enough.
 */
export const DELETE: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const body = await readBody(request);

    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .bind(user.id)
      .first<{ password_hash: string | null }>();

    if (row?.password_hash) {
      const password = body.password ?? '';
      if (!password) throw badRequest('Enter your password to confirm.', 'password');
      if (!(await verifyPassword(password, row.password_hash))) {
        throw new HttpError(403, 'invalid_credentials', 'That password is not right.', 'password');
      }
    } else if ((body.confirm ?? '').trim().toLowerCase() !== user.email.toLowerCase()) {
      throw badRequest('Type your email address to confirm.', 'confirm');
    }

    /*
     * Cancel first. If Stripe is unreachable the account stays exactly as it is
     * and the person can try again — whereas deleting the rows first would leave
     * a live subscription billing a customer with no account to show for it, and
     * nothing left here to reconcile it against.
     */
    if (billingEnabled()) {
      const billing = await getBillingRow(user.id).catch(() => null);
      if (hasActiveSubscription(billing) && billing?.stripe_subscription_id) {
        await cancelSubscriptionImmediately(billing.stripe_subscription_id);
      }
    }

    const result = await deleteAccount(user.id);
    console.log(`[account] deleted ${user.id}: ${result.captures} captures, ${result.files} files`);

    return json(
      { deleted: true, captures: result.captures, files: result.files },
      { headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(request)) } },
    );
  } catch (error) {
    return toHttpError(error, 'account.delete', 'Could not delete your account.').toResponse();
  }
};
