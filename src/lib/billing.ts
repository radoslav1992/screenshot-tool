import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { HttpError } from './http';
import { toHex, timingSafeEqual } from './ids';
import { getPlan, PAID_PLANS, PLANS, type PlanId } from './plans';

/**
 * Stripe Checkout, done with `fetch`.
 *
 * The Stripe SDK pulls in Node built-ins and its own HTTP client, which is a lot
 * of weight for four calls. The REST API is form-encoded and stable, so we talk
 * to it directly.
 *
 * Everything here is dormant until STRIPE_SECRET_KEY is set: `billingEnabled()`
 * is false, the routes answer 503, and the UI hides the buy buttons. A
 * deployment without Stripe behaves exactly as it did before billing existed.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's own tolerance for webhook timestamp skew. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Statuses that still grant the paid plan. `past_due` keeps access while Stripe
 * retries the card — dropping someone the moment a renewal blips is worse for
 * both sides than carrying them for a few days.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Statuses Stripe never bills from again. Everything else — `unpaid`,
 * `incomplete` and `paused` included — can still turn into a charge.
 */
const FINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

/**
 * How long one Stripe call may take. Stripe gives a webhook about 20 seconds
 * before calling it failed, and a handler makes at most a couple of calls.
 */
const STRIPE_TIMEOUT_MS = 8_000;

export type BillingInterval = 'monthly' | 'yearly';

export function billingEnabled(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function webhookConfigured(): boolean {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

/**
 * Whether Stripe Tax works out VAT/GST on each subscription.
 *
 * Opt-in rather than always-on: Stripe rejects `automatic_tax` outright unless
 * Tax has been activated and an origin address set in the dashboard, so turning
 * it on by default would break checkout for anyone who has not done that.
 * Selling digital subscriptions across borders usually means you need it —
 * whether you must *register* somewhere is a question for an accountant.
 */
export function automaticTaxEnabled(): boolean {
  return env.STRIPE_AUTOMATIC_TAX === '1';
}

/**
 * Whether checkout asks the customer to accept the terms and waive the EU
 * withdrawal right before paying.
 *
 * An EU consumer buying a digital service has fourteen days to withdraw. That
 * right can be waived, but only if they expressly ask for the service to start
 * immediately and acknowledge losing it — and the acknowledgement has to be
 * given at the point of sale, not written into the terms and assumed. Without
 * it, someone can buy the top plan, spend the month's quota and withdraw.
 *
 * Opt-in because Stripe rejects the session unless a terms-of-service URL is set
 * on the account's public details, the same way it rejects automatic tax on an
 * unconfigured account.
 */
export function tosConsentRequired(): boolean {
  return env.STRIPE_TOS_CONSENT === '1';
}

/** The Stripe price id configured for a plan and interval, if any. */
export function priceIdFor(planId: PlanId, interval: BillingInterval): string | null {
  const priceEnv = PLANS[planId]?.priceEnv;
  if (!priceEnv) return null;
  const value = (env as unknown as Record<string, unknown>)[priceEnv[interval]];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** True when this plan can actually be bought right now. */
export function planPurchasable(planId: PlanId): boolean {
  if (!billingEnabled()) return false;
  return Boolean(priceIdFor(planId, 'monthly') || priceIdFor(planId, 'yearly'));
}

/** Reverse lookup: which plan does a Stripe price belong to? */
export function planForPrice(priceId: string): { plan: PlanId; interval: BillingInterval } | null {
  for (const planId of PAID_PLANS) {
    for (const interval of ['monthly', 'yearly'] as const) {
      if (priceIdFor(planId, interval) === priceId) return { plan: planId, interval };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Stripe REST                                                                 */
/* -------------------------------------------------------------------------- */

/** Flattens a nested object into Stripe's `a[b][0][c]=v` form encoding. */
function encodeForm(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => encodeForm(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      encodeForm(item, prefix ? `${prefix}[${key}]` : key, out);
    }
    return out;
  }
  out.set(prefix, String(value));
  return out;
}

async function stripe<T = any>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; body?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new HttpError(503, 'billing_unavailable', 'Payments are not configured on this deployment.');
  }

  const method = init.method ?? 'POST';
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  let url = `${STRIPE_API}${path}`;
  let body: string | undefined;
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(init.body ?? {}).toString();
  } else if (init.body) {
    url += `?${encodeForm(init.body).toString()}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
  } catch (error) {
    // A timeout or a dropped connection: nothing was answered, so say so the
    // same way a Stripe 5xx would rather than surfacing a bare 500.
    console.error(`[billing] stripe ${method} ${path} → no answer:`, error instanceof Error ? error.message : error);
    throw new HttpError(502, 'billing_error', 'Payments are temporarily unavailable. Try again in a moment.');
  }
  const payload = (await response.json().catch(() => null)) as any;

  if (!response.ok) {
    const detail = payload?.error?.message ?? `Stripe responded ${response.status}.`;
    const code = payload?.error?.code ?? payload?.error?.type ?? String(response.status);
    console.error(`[billing] stripe ${method} ${path} → ${response.status} ${code}: ${detail}`);

    /*
     * A 4xx from Stripe is nearly always a setting that has not been made in the
     * dashboard yet — an unconfigured portal, a price missing from it. Those
     * read as "temporarily unavailable" to a customer and as nothing at all to
     * the operator, who then needs log access to find out. Carrying Stripe's own
     * message through means the person who hit it can see the cause. Stripe
     * writes these for developers and they carry no credentials.
     */
    const error = new HttpError(
      502,
      'billing_error',
      response.status >= 500
        ? 'Payments are temporarily unavailable. Try again in a moment.'
        : `Stripe rejected the request: ${detail}`,
    );
    (error as StripeCallError).stripeStatus = response.status;
    throw error;
  }

  return payload as T;
}

/** An HttpError that came from Stripe, carrying the status it answered with. */
interface StripeCallError extends HttpError {
  stripeStatus?: number;
}

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

export interface BillingRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_status: string;
  plan_period_end: string | null;
  plan_interval: string;
}

/**
 * True when Stripe is already billing this account. Such an account must change
 * plan through the customer portal — a second Checkout would create a second
 * subscription and charge for both.
 */
export function hasActiveSubscription(row: BillingRow | null | undefined): boolean {
  return Boolean(row?.stripe_subscription_id && ENTITLED_STATUSES.has(row.plan_status));
}

export async function getBillingRow(userId: string): Promise<BillingRow | null> {
  return env.DB.prepare(
    `SELECT stripe_customer_id, stripe_subscription_id, plan_status, plan_period_end, plan_interval
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<BillingRow>();
}

/**
 * Returns the account's Stripe customer, creating one on first use. The id is
 * written back so a second checkout reuses the same customer — otherwise the
 * billing portal would only ever show the most recent purchase.
 */
async function ensureCustomer(user: SessionUser): Promise<string> {
  const existing = await getBillingRow(user.id);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe<{ id: string }>('/customers', {
    body: {
      email: user.email,
      name: user.name || undefined,
      metadata: { user_id: user.id },
    },
    idempotencyKey: `customer:${user.id}`,
  });

  await env.DB.prepare(`UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
    .bind(customer.id, new Date().toISOString(), user.id)
    .run();

  return customer.id;
}

/* -------------------------------------------------------------------------- */
/* Checkout & portal                                                           */
/* -------------------------------------------------------------------------- */

export async function createCheckoutSession(input: {
  user: SessionUser;
  plan: PlanId;
  interval: BillingInterval;
  origin: string;
}): Promise<string> {
  const apple = await env.DB.prepare('SELECT apple_expires_at FROM users WHERE id=?').bind(input.user.id).first<{apple_expires_at: string | null}>();
  if ((apple?.apple_expires_at ?? '') > new Date().toISOString()) throw new HttpError(409, 'already_subscribed', 'Manage your Apple subscription before starting a different subscription.');
  const price = priceIdFor(input.plan, input.interval);
  if (!price) {
    throw new HttpError(
      503,
      'billing_unavailable',
      `The ${getPlan(input.plan).name} plan is not available for purchase yet.`,
    );
  }

  // Checkout only ever *starts* a subscription. Someone who already has one has
  // to switch through the portal, or Stripe would happily bill them twice.
  if (hasActiveSubscription(await getBillingRow(input.user.id))) {
    throw new HttpError(
      409,
      'already_subscribed',
      'This account already has a subscription. Change plan from Billing on your account screen.',
    );
  }

  const customer = await ensureCustomer(input.user);

  // A checkout left open in another tab would otherwise still be payable, and
  // paying both makes two subscriptions billed side by side.
  await expireOpenCheckouts(customer);

  /*
   * Stripe Tax needs somewhere to tax: it works the rate out from the
   * customer's address, so collecting one is not optional once it is on.
   * `customer_update` is what lets Checkout write that address back onto the
   * customer we created — without it the address lives only on the session and
   * every renewal after the first is untaxed.
   *
   * `tax_id_collection` gives a business the chance to enter a VAT number, which
   * is what makes EU reverse charge work instead of charging them VAT they then
   * have to reclaim.
   */
  const tax = automaticTaxEnabled()
    ? {
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' },
        tax_id_collection: { enabled: true },
      }
    : {};

  /*
   * `consent_collection` puts a required checkbox on the checkout page, and
   * Stripe records the acceptance against the session — which is the part that
   * matters if it is ever disputed. The wording asks for immediate performance
   * and states what is given up, because a bare "I agree to the terms" does not
   * carry the waiver.
   */
  const consent = tosConsentRequired()
    ? {
        consent_collection: { terms_of_service: 'required' },
        custom_text: {
          terms_of_service_acceptance: {
            message:
              'I ask for my plan to start immediately and I understand that I lose my right to withdraw once it does.',
          },
        },
      }
    : {};

  const session = await stripe<{ id: string; url: string | null }>('/checkout/sessions', {
    body: {
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.user.id,
      allow_promotion_codes: true,
      ...tax,
      ...consent,
      // Repeated on the subscription so webhooks can identify the account even
      // if the checkout session has aged out of Stripe's retention.
      subscription_data: { metadata: { user_id: input.user.id, plan: input.plan } },
      metadata: { user_id: input.user.id, plan: input.plan },
      success_url: `${input.origin}/app/account?checkout=success`,
      cancel_url: `${input.origin}/pricing?checkout=cancelled`,
    },
  });

  if (!session.url) {
    throw new HttpError(502, 'billing_error', 'Stripe did not return a checkout URL.');
  }
  return session.url;
}

/**
 * Ends a subscription there and then, with no proration and no refund.
 *
 * Used when an account is being deleted. Cancelling at period end would be the
 * kinder default for someone who is staying, but there will be no account left
 * to serve the rest of the period to — and a subscription that outlives its
 * account keeps its renewal date, which is how people get charged for something
 * they thought they had closed.
 */
export async function cancelSubscriptionImmediately(subscriptionId: string): Promise<void> {
  await stripe(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
}

/**
 * Expires every open Checkout session for a customer. Returns how many went.
 *
 * Listing failures are thrown — a checkout that cannot tell whether another is
 * open should not start a second. A session that cannot be expired has usually
 * just completed or lapsed on its own, which the webhook handles, so those are
 * logged and passed over.
 */
export async function expireOpenCheckouts(customer: string): Promise<number> {
  const open = await stripe<{ data?: Array<{ id: string }> }>('/checkout/sessions', {
    method: 'GET',
    body: { customer, status: 'open', limit: 100 },
  });
  let expired = 0;
  for (const session of open.data ?? []) {
    try {
      await stripe(`/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
      expired++;
    } catch (error) {
      console.error(
        `[billing] could not expire checkout session ${session.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (expired) console.log(`[billing] expired ${expired} open checkout session(s) for ${customer}`);
  return expired;
}

/**
 * Stops everything Stripe could still bill an account for, ahead of deleting
 * it: every subscription not in a final state — not only the one recorded
 * here, and not only the entitled statuses, since `unpaid` and `incomplete`
 * subscriptions can still charge — and any checkout left open, which could
 * otherwise be paid for an account that no longer exists.
 *
 * Throws if Stripe cannot be asked, so the deletion stops with the account
 * intact and can be retried.
 */
export async function cancelBillingForDeletion(userId: string): Promise<{ cancelled: string[] }> {
  // Without migration 0003's columns there was never anything to bill. Any
  // other failure stops the deletion: going ahead blind is how a subscription
  // ends up outliving its account.
  const row = await getBillingRow(userId).catch((error) => {
    if (/no such (column|table)/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  });
  const cancelled: string[] = [];
  if (!row) return { cancelled };

  const live: string[] = [];
  if (row.stripe_customer_id) {
    await expireOpenCheckouts(row.stripe_customer_id);
    const list = await stripe<{ data?: StripeSubscription[] }>('/subscriptions', {
      method: 'GET',
      body: { customer: row.stripe_customer_id, status: 'all', limit: 100 },
    });
    for (const subscription of list.data ?? []) if (!FINAL_STATUSES.has(subscription.status)) live.push(subscription.id);
  } else if (row.stripe_subscription_id && !FINAL_STATUSES.has(row.plan_status)) {
    live.push(row.stripe_subscription_id);
  }

  for (const id of live) {
    try {
      await cancelSubscriptionImmediately(id);
      cancelled.push(id);
    } catch (error) {
      // Already gone is as good as cancelled; anything else stops the deletion.
      if ((error as StripeCallError).stripeStatus !== 404) throw error;
    }
  }
  return { cancelled };
}

/**
 * Opens the Stripe customer portal.
 *
 * With a `target`, it opens on the confirmation screen for that exact plan
 * rather than the portal's front door — one click from "Switch to Pro" to
 * confirming the change, with the proration Stripe worked out shown before
 * anything is charged.
 *
 * Why not change the subscription directly from here? An upgrade takes an
 * immediate payment, and that payment can need 3-D Secure. Doing it in-app
 * would mean embedding Stripe.js and building an authentication flow for a
 * card that asks for it. Stripe's own flow already handles that, so this keeps
 * the money side there and spends the effort on getting the customer to the
 * right screen.
 */
export async function createPortalSession(
  user: SessionUser,
  origin: string,
  target?: { plan: PlanId; interval: BillingInterval },
): Promise<string> {
  const row = await getBillingRow(user.id);
  if (!row?.stripe_customer_id) {
    throw new HttpError(404, 'no_customer', 'This account has no billing history yet.');
  }

  const body: Record<string, unknown> = {
    customer: row.stripe_customer_id,
    return_url: `${origin}/app/account`,
  };

  const attempt = target ? await planChangeFlow(row, target, origin) : null;

  if (attempt?.flow) {
    try {
      const session = await stripe<{ url: string }>('/billing_portal/sessions', {
        body: { ...body, flow_data: attempt.flow },
      });
      return session.url;
    } catch (error) {
      /*
       * Landing on the right screen is a convenience; reaching billing at all is
       * not. The confirm flow needs the portal configured to allow plan changes
       * with these products listed, and Stripe rejects the whole session if it
       * is not — which would otherwise lock someone out of their own card and
       * invoices over a setting. Fall through to the plain portal instead.
       */
      console.error(
        `[billing] plan-change flow rejected for ${row.stripe_subscription_id}; opening the portal without it`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const session = await stripe<{ url: string }>('/billing_portal/sessions', { body });
  return session.url;
}

/**
 * Builds the portal's `subscription_update_confirm` flow for a plan change.
 * Returns null when anything needed is missing, so the caller falls back to the
 * plain portal rather than failing — the customer can still get there by hand.
 */
/** What the flow builder decided, so callers can act on it or report it. */
export interface PlanChangeAttempt {
  flow: Record<string, unknown> | null;
  reason?: string;
}

async function planChangeFlow(
  row: BillingRow,
  target: { plan: PlanId; interval: BillingInterval },
  origin: string,
): Promise<PlanChangeAttempt> {
  /*
   * Every give-up here ends with the plain portal opening, which looks exactly
   * like the deep link "not working" — so each one says which it was, both to
   * the log and to whoever asks /api/billing/diagnose.
   */
  const give = (reason: string): PlanChangeAttempt => {
    console.error(`[billing] no plan-change flow for ${target.plan}/${target.interval}: ${reason}`);
    return { flow: null, reason };
  };

  if (!row.stripe_subscription_id) return give('the account has no subscription id recorded');

  const price = priceIdFor(target.plan, target.interval);
  if (!price) {
    return give(
      `STRIPE_PRICE_${target.plan.toUpperCase()}_${target.interval.toUpperCase()} is not set, so there is no ${target.interval} ${target.plan} price to move to`,
    );
  }

  // The flow replaces a subscription *item*, so it needs that item's id — which
  // only the subscription itself knows.
  let item: string | undefined;
  try {
    const subscription = await stripe<StripeSubscription>(`/subscriptions/${row.stripe_subscription_id}`, {
      method: 'GET',
    });
    item = subscription.items?.data?.[0]?.id;
    if (subscription.items?.data?.[0]?.price?.id === price) {
      return give('the subscription is already on that exact price');
    }
  } catch (error) {
    return give(`the subscription could not be read: ${error instanceof Error ? error.message : error}`);
  }
  if (!item) return give('the subscription has no items');

  return {
    flow: {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: row.stripe_subscription_id,
        items: [{ id: item, price, quantity: 1 }],
      },
      after_completion: {
        type: 'redirect',
        redirect: { return_url: `${origin}/app/account?checkout=success` },
      },
    },
  };
}

/**
 * Walks the whole plan-change path and reports what happened at each step,
 * without changing anything. Every failure mode here is a dashboard setting or
 * a missing price, and all of them look identical from the outside — the portal
 * simply opens on the wrong screen. This is the difference between knowing and
 * guessing.
 */
export async function diagnosePlanChange(
  user: SessionUser,
  target: { plan: PlanId; interval: BillingInterval },
  origin: string,
): Promise<Record<string, unknown>> {
  const row = await getBillingRow(user.id);

  const report: Record<string, unknown> = {
    plan: user.plan,
    target: `${target.plan}/${target.interval}`,
    subscription: row?.stripe_subscription_id ? 'recorded' : 'missing',
    customer: row?.stripe_customer_id ? 'recorded' : 'missing',
    recordedInterval: row?.plan_interval || '(none)',
    targetPriceConfigured: Boolean(priceIdFor(target.plan, target.interval)),
  };

  if (!row?.stripe_customer_id) {
    report.result = 'no Stripe customer on this account; nothing to diagnose';
    return report;
  }

  const attempt = await planChangeFlow(row, target, origin).catch((error) => ({
    flow: null,
    reason: error instanceof Error ? error.message : String(error),
  }));

  if (!attempt.flow) {
    report.result = 'the deep link cannot be built, so the plain portal opens';
    report.reason = attempt.reason;
    return report;
  }

  // The flow is well-formed. The only thing left that can reject it is the
  // portal configuration, so ask Stripe and report exactly what it says.
  try {
    await stripe('/billing_portal/sessions', {
      body: { customer: row.stripe_customer_id, return_url: `${origin}/app/account`, flow_data: attempt.flow },
    });
    report.result = 'the deep link works — upgrading should open the confirmation screen';
  } catch (error) {
    report.result = 'Stripe refused the plan-change flow, so the plain portal opens instead';
    report.reason = error instanceof Error ? error.message : String(error);
    report.likelyFix =
      'Settings → Billing → Customer portal: enable "Customers can switch plans" and list Plus, Pro and Business (with the prices) underneath it. Test and live keep separate configurations.';
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The body must be the exact bytes Stripe sent — re-serialising the parsed JSON
 * changes the payload and every signature fails.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = toHex(mac);

  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

/**
 * Whether an event has already been applied.
 *
 * An event is recorded only once its handler has finished, so a Worker that
 * dies halfway leaves nothing behind and Stripe's retry runs it again. The
 * handlers make that safe: each reads the subscription's current state from
 * Stripe and writes it, so running one again changes nothing.
 */
async function eventProcessed(id: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM billing_events WHERE id = ?`).bind(id).first());
}

/**
 * The user id is looked up in the same statement, so an event that finishes
 * just after its account was deleted — the cancellation that deletion itself
 * set off — is recorded against nobody instead of the id that is gone.
 */
async function recordEvent(id: string, type: string, userId: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO billing_events (id, type, user_id, received_at)
     VALUES (?, ?, (SELECT id FROM users WHERE id = ?), ?)`,
  )
    .bind(id, type, userId, new Date().toISOString())
    .run();
}

interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: {
    data?: Array<{
      id?: string;
      price?: { id?: string; recurring?: { interval?: string } };
      current_period_end?: number;
    }>;
  };
}

/** What the account had on record before an event was applied. */
interface RecordedPlan {
  plan: string;
  plan_status: string;
  stripe_subscription_id: string | null;
}

/**
 * Which plan a subscription pays for.
 *
 * The price is the authority. When it is not one this deployment knows —
 * usually a price rotated out in the dashboard that existing subscribers stay
 * on — the plan already recorded for this same subscription comes next: it was
 * resolved from a known price when it was written. The checkout metadata comes
 * last, because it only says what was bought at checkout; a later switch in
 * the portal does not change it, so trusting it first would quietly downgrade
 * someone who upgraded and whose new price was then rotated.
 *
 * The period comes off the price itself either way — guessing "monthly" would
 * record a yearly subscriber as monthly, and every later plan change would then
 * look for the wrong price.
 */
export function subscriptionPlan(
  subscription: StripeSubscription,
  recorded?: Pick<RecordedPlan, 'plan' | 'stripe_subscription_id'> | null,
): { plan: PlanId; interval: BillingInterval } | null {
  const price = subscription.items?.data?.[0]?.price;
  if (price?.id) {
    const match = planForPrice(price.id);
    if (match) return match;
  }
  const interval: BillingInterval = price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';

  const kept = recorded?.plan as PlanId | undefined;
  if (recorded?.stripe_subscription_id === subscription.id && kept && PAID_PLANS.includes(kept)) {
    return { plan: kept, interval };
  }

  const fromMetadata = subscription.metadata?.plan as PlanId | undefined;
  if (fromMetadata && PAID_PLANS.includes(fromMetadata)) return { plan: fromMetadata, interval };
  return null;
}

function periodEnd(subscription: StripeSubscription): string | null {
  // Stripe moved `current_period_end` onto the subscription item in 2025 API
  // versions; accept it in either place.
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * The account a subscription belongs to — only if it still exists. The
 * metadata keeps naming an account after it is deleted, and the cancellation
 * that deletion triggers must not be filed against an id that is gone.
 */
async function findUserId(subscription: StripeSubscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.user_id;
  if (fromMetadata) {
    const row = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(fromMetadata).first<{ id: string }>();
    if (row) return row.id;
  }
  const row = await env.DB.prepare(`SELECT id FROM users WHERE stripe_customer_id = ?`)
    .bind(subscription.customer)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Reads a subscription as Stripe has it now. Null if Stripe no longer has it. */
async function fetchSubscription(id: string): Promise<StripeSubscription | null> {
  try {
    return await stripe<StripeSubscription>(`/subscriptions/${encodeURIComponent(id)}`, { method: 'GET' });
  } catch (error) {
    if ((error as StripeCallError).stripeStatus === 404) return null;
    throw error;
  }
}

export interface ApplyResult {
  userId: string | null;
  applied: boolean;
  reason?: string;
}

/**
 * Pure decision for one subscription against what the account has on record:
 * apply it, or leave the record alone. Separate from the I/O so the ordering
 * rules can be checked without Stripe.
 *
 * - The recorded subscription, or none recorded: apply.
 * - A different subscription while the recorded one still grants the plan:
 *   if the newcomer does not grant anything (an old subscription's late
 *   cancellation, an expired attempt), it must not take the plan away; if it
 *   does, there are two live subscriptions — `needsCheck` asks the caller to
 *   confirm with Stripe that the recorded one really is still live.
 */
export function subscriptionDecision(
  subscription: Pick<StripeSubscription, 'id' | 'status'>,
  recorded: Pick<RecordedPlan, 'plan_status' | 'stripe_subscription_id'> | null,
): 'apply' | 'ignore' | 'needsCheck' {
  if (!recorded?.stripe_subscription_id || recorded.stripe_subscription_id === subscription.id) return 'apply';
  if (!ENTITLED_STATUSES.has(recorded.plan_status)) return 'apply';
  return ENTITLED_STATUSES.has(subscription.status) ? 'needsCheck' : 'ignore';
}

/** Writes a subscription's current state onto the account, unless it should not win. */
async function applySubscription(subscription: StripeSubscription): Promise<ApplyResult> {
  const userId = await findUserId(subscription);
  if (!userId) {
    console.error(`[billing] no account matches customer ${subscription.customer}`);
    return { userId: null, applied: false, reason: 'no_account' };
  }

  const recorded = await env.DB.prepare(
    `SELECT plan, plan_status, stripe_subscription_id FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<RecordedPlan>();

  const decision = subscriptionDecision(subscription, recorded);
  if (decision === 'ignore') {
    console.log(
      `[billing] ${userId}: ignored ${subscription.id} (${subscription.status}); ${recorded?.stripe_subscription_id} is the live subscription`,
    );
    return { userId, applied: false, reason: 'not_current_subscription' };
  }
  if (decision === 'needsCheck') {
    // Our record may simply be behind — its cancellation could still be in
    // flight — so ask Stripe before treating this as a duplicate.
    const current = await fetchSubscription(recorded!.stripe_subscription_id!);
    if (current && ENTITLED_STATUSES.has(current.status)) {
      console.error(
        `[billing] WARNING ${userId} has two live subscriptions: kept ${current.id} (${current.status}), ` +
          `did not apply ${subscription.id} (${subscription.status}) for customer ${subscription.customer}. ` +
          'Nothing was cancelled or refunded — resolve it in the Stripe dashboard.',
      );
      return { userId, applied: false, reason: 'duplicate_subscription' };
    }
  }

  const entitled = ENTITLED_STATUSES.has(subscription.status);
  const match = subscriptionPlan(subscription, recorded);
  const plan: PlanId = entitled && match ? match.plan : 'free';
  const interval = entitled && match ? match.interval : '';

  const result = await env.DB.prepare(
    `UPDATE users SET plan = ?, plan_status = ?, plan_interval = ?, plan_period_end = ?,
                      stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      plan,
      subscription.status,
      interval,
      periodEnd(subscription),
      subscription.id,
      subscription.customer,
      new Date().toISOString(),
      userId,
    )
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    // Deleted between the lookup and the write.
    return { userId: null, applied: false, reason: 'no_account' };
  }

  console.log(`[billing] ${userId} → ${plan} (${subscription.status})`);

  // Keep the checkout metadata in step with the price, so the fallback above
  // never has a stale plan to fall back to. Best effort: the account is right
  // either way, and the update's own webhook finds nothing left to change.
  const priced = subscription.items?.data?.[0]?.price?.id ? planForPrice(subscription.items.data[0].price.id) : null;
  if (entitled && priced && subscription.metadata?.plan !== priced.plan) {
    await stripe(`/subscriptions/${encodeURIComponent(subscription.id)}`, {
      body: { metadata: { plan: priced.plan } },
    }).catch((error) =>
      console.error(`[billing] could not update plan metadata on ${subscription.id}:`, error instanceof Error ? error.message : error),
    );
  }

  return { userId, applied: true };
}

export interface WebhookOutcome {
  handled: boolean;
  type: string;
  reason?: string;
}

/**
 * Applies a verified Stripe event. Idempotent: Stripe retries until it gets a
 * 2xx, and delivers events in no particular order.
 *
 * So no event's own copy of a subscription is trusted — it may be older than
 * one already applied. Each handler reads the subscription's current state
 * from Stripe and applies that: an `updated` arriving after the `deleted`
 * cannot bring a cancelled plan back, and a replay changes nothing.
 */
export async function handleWebhookEvent(event: {
  id: string;
  type: string;
  data: { object: any };
}): Promise<WebhookOutcome> {
  if (await eventProcessed(event.id)) {
    return { handled: false, type: event.type, reason: 'duplicate' };
  }

  const outcome = await processEvent(event);
  // Only now, after it worked: a throw above leaves the event unrecorded and
  // Stripe's retry runs it again.
  await recordEvent(event.id, event.type, outcome.userId);
  return { handled: outcome.applied, type: event.type, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}

async function processEvent(event: { id: string; type: string; data: { object: any } }): Promise<ApplyResult> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as { subscription?: string | null };
      if (!session.subscription) return { userId: null, applied: false, reason: 'no_subscription' };
      // The session carries only the subscription id, so read the subscription
      // itself for the price and period.
      const subscription = await fetchSubscription(session.subscription);
      if (!subscription) return { userId: null, applied: false, reason: 'subscription_missing' };
      return applySubscription(subscription);
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sent = event.data.object as StripeSubscription;
      if (!sent?.id) return { userId: null, applied: false, reason: 'no_subscription' };
      let subscription = await fetchSubscription(sent.id);
      if (!subscription) {
        // Stripe keeps cancelled subscriptions readable, so this is rare (test
        // data cleared, say). A deletion still has to drop the plan; anything
        // else has no current state to apply.
        if (event.type !== 'customer.subscription.deleted') {
          return { userId: null, applied: false, reason: 'subscription_missing' };
        }
        subscription = { ...sent, status: 'canceled' };
      }
      return applySubscription(subscription);
    }

    default:
      return { userId: null, applied: false, reason: 'ignored' };
  }
}
