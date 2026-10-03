import { env } from 'cloudflare:workers';
import { afterResponse } from './background';
import type { StripeCallError } from './billing';
import { COMPANY } from './company';
import { toHttpError } from './errors';
import { HttpError, apiError } from './http';
import { canSendEmail, sendMail } from './mailer';

/**
 * What a customer is told when checkout or the billing portal fails.
 *
 * A failed form post lands back on /pricing or /app/account with
 * `?billing_error=<code>`, and the page looks the code up here. Only the code
 * travels in the URL and the text is fixed, so a crafted link to the real
 * pricing page cannot make it say "payments have moved, pay at …", and Stripe's
 * developer messages ("Invalid line_items[0]: the product tax code is missing")
 * never reach a customer. Those go to the log, and by email to whoever runs the
 * site, who is the one person who can fix them.
 */
export const BILLING_ERROR_MESSAGES = {
  checkout_unavailable: "Checkout isn't available right now. The site owner has been told and is fixing it.",
  portal_unavailable: "Billing isn't available right now. The site owner has been told and is fixing it.",
  temporarily_unavailable: 'Payments are temporarily unavailable. Try again in a moment.',
  billing_unavailable: 'Payments are not set up on this site yet.',
  plan_unavailable: 'That plan is not available for purchase yet.',
  plan_required: 'Choose a plan to subscribe to.',
  already_subscribed: 'This account already has a subscription. Change plan from Billing on your account screen.',
  apple_subscription: 'Manage your Apple subscription before starting a different subscription.',
  no_customer: 'This account has no billing history yet.',
} as const;

export type BillingErrorCode = keyof typeof BILLING_ERROR_MESSAGES | 'unexpected';
export type BillingFlow = 'checkout' | 'portal';

/** Shown for any code this list does not know, including ones made up in a link. */
export const GENERIC_BILLING_ERROR = `Something went wrong with billing. Try again in a moment, or email ${COMPANY.email} if it keeps happening.`;

/** Null when there is nothing to show; otherwise always one of the fixed messages. */
export function billingErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  // Own keys only: `?billing_error=constructor` must not find Object's.
  return Object.hasOwn(BILLING_ERROR_MESSAGES, code)
    ? BILLING_ERROR_MESSAGES[code as keyof typeof BILLING_ERROR_MESSAGES]
    : GENERIC_BILLING_ERROR;
}

interface CodedError extends HttpError {
  billingCode?: BillingErrorCode;
}

/** For errors whose type alone is ambiguous, e.g. the two kinds of `already_subscribed`. */
export function withBillingCode<T extends HttpError>(error: T, code: BillingErrorCode): T {
  (error as CodedError).billingCode = code;
  return error;
}

/**
 * Stripe answered with a 4xx. That is nearly always a setting nobody has made
 * yet — a product without a tax code, a price from the other mode, a portal
 * never configured — so it is the site owner's to fix, and retrying will not
 * help the customer.
 */
export function isStripeRejection(error: unknown): error is StripeCallError {
  const status = (error as StripeCallError | null)?.stripeStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function billingErrorCode(error: HttpError, flow: BillingFlow): BillingErrorCode {
  const coded = (error as CodedError).billingCode;
  if (coded) return coded;
  if (isStripeRejection(error)) return flow === 'checkout' ? 'checkout_unavailable' : 'portal_unavailable';
  switch (error.type) {
    case 'billing_error':
      return 'temporarily_unavailable';
    case 'billing_unavailable':
    case 'already_subscribed':
    case 'no_customer':
      return error.type;
    case 'invalid_request':
      return error.param === 'plan' ? 'plan_required' : 'unexpected';
    default:
      return 'unexpected';
  }
}

/* -------------------------------------------------------------------------- */
/* Telling the operator                                                        */
/* -------------------------------------------------------------------------- */

/** One email per Stripe error code per hour: every customer who tries hits the same wall. */
const ALERT_WINDOW_SECONDS = 60 * 60;

/** Causes worth naming, matched against Stripe's message, with what fixes each. */
const HINTS: Array<[RegExp, string]> = [
  [
    /tax code|managed payments/i,
    'Set a tax code on each plan product in Stripe → Product catalog, e.g. txcd_10103001 (SaaS, business use). ' +
      '`STRIPE_TAX_CODE=txcd_10103001 npm run stripe:setup` sets it on every plan product.',
  ],
  [/no such price/i, 'A STRIPE_PRICE_* secret names a price this key cannot see: check it is from the same account and mode (test or live) as STRIPE_SECRET_KEY.'],
  [/no such customer/i, "The account's saved Stripe customer is from the other mode (test or live), or was deleted in Stripe."],
  [/automatic tax|origin address/i, 'Finish Stripe Tax setup (Settings → Tax, including an origin address), or unset STRIPE_AUTOMATIC_TAX.'],
  [/terms of service/i, 'Add a terms-of-service URL in Stripe → Settings → Public details, or unset STRIPE_TOS_CONSENT.'],
  [/customer portal|portal configuration|default configuration/i, 'Save a customer portal configuration in Stripe → Settings → Billing → Customer portal.'],
];

export function billingFailureHint(detail: string): string | null {
  return HINTS.find(([pattern]) => pattern.test(detail))?.[1] ?? null;
}

/** BILLING_ALERT_EMAIL when it holds an address, the public contact address otherwise. */
function alertRecipient(): string | null {
  const configured = (env.BILLING_ALERT_EMAIL ?? '').trim();
  if (configured.includes('@') && !/\s/.test(configured)) return configured;
  return COMPANY.email.includes('@') ? COMPANY.email : null;
}

/** Fails open: a throttle that cannot be read should not stop the owner hearing about it. */
async function firstInWindow(code: string): Promise<boolean> {
  const key = `billing-alert:${code}`;
  try {
    if (await env.RATE.get(key)) return false;
    await env.RATE.put(key, '1', { expirationTtl: ALERT_WINDOW_SECONDS });
  } catch (error) {
    console.error('[billing] alert throttle unavailable; sending anyway', error instanceof Error ? error.message : error);
  }
  return true;
}

/** `request` is the route that failed, e.g. `POST /api/billing/checkout`. */
export async function alertBillingFailure(error: StripeCallError, flow: BillingFlow, request: string): Promise<void> {
  const to = alertRecipient();
  if (!to || !canSendEmail()) return;

  const code = String(error.stripeCode ?? error.stripeStatus).replace(/[^\w.-]/g, '_').slice(0, 64);
  if (!(await firstInWindow(code))) return;

  const detail = error.stripeDetail ?? error.message;
  const hint = billingFailureHint(detail);
  const sent = await sendMail({
    to,
    subject: `Stripe rejected a ${flow} request (${code})`,
    text: [
      `A customer tried to use ${flow === 'checkout' ? 'checkout' : 'the billing portal'} and Stripe rejected the request, so they were told it isn't available right now.`,
      '',
      `Request: ${request}`,
      `Stripe call: ${error.stripeRequest ?? 'unknown'} → ${error.stripeStatus} ${code}`,
      `Stripe said: ${detail}`,
      '',
      hint ? `Likely fix: ${hint}` : 'No known cause matches this message; the Stripe dashboard logs (Developers → Logs) have the full request.',
      '',
      'Every customer who tries will hit the same until it is fixed. You get at most one email per Stripe error code per hour; `npx wrangler tail` shows each occurrence.',
    ].join('\n'),
  });
  if (!sent) console.error(`[billing] could not email the ${code} alert to the operator`);
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                   */
/* -------------------------------------------------------------------------- */

const RETURN_PAGES: Record<BillingFlow, string> = { checkout: '/pricing', portal: '/app/account' };

/**
 * The catch block of the checkout and portal routes.
 *
 * A form post goes back to the page it came from with a code. A JSON caller —
 * the iOS app among them — keeps its `{error:{type,message}}`, with Stripe's
 * wording replaced by the same fixed text the page would show.
 */
export async function billingFailureResponse(
  error: unknown,
  { flow, request, locals }: { flow: BillingFlow; request: Request; locals: App.Locals },
): Promise<Response> {
  const failure = toHttpError(
    error,
    `billing.${flow}`,
    flow === 'checkout' ? 'Could not start checkout.' : 'Could not open the billing portal.',
  );
  const code = billingErrorCode(failure, flow);
  const rejected = isStripeRejection(failure);

  if (rejected) {
    await afterResponse(
      locals,
      alertBillingFailure(failure, flow, `${request.method} ${new URL(request.url).pathname}`).catch((cause) =>
        console.error('[billing] operator alert failed', cause),
      ),
    );
  }

  if (!(request.headers.get('accept') ?? '').includes('application/json')) {
    return new Response(null, { status: 303, headers: { location: `${RETURN_PAGES[flow]}?billing_error=${code}` } });
  }
  return rejected
    ? apiError(failure.status, failure.type, billingErrorMessage(code) ?? GENERIC_BILLING_ERROR)
    : failure.toResponse();
}
