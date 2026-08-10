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
  init: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; idempotencyKey?: string } = {},
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

  const response = await fetch(url, { method, headers, body });
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

  const session = await stripe<{ id: string; url: string | null }>('/checkout/sessions', {
    body: {
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: input.user.id,
      allow_promotion_codes: true,
      ...tax,
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

  const flow = target ? await planChangeFlow(row, target, origin) : null;

  if (flow) {
    try {
      const session = await stripe<{ url: string }>('/billing_portal/sessions', {
        body: { ...body, flow_data: flow },
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
async function planChangeFlow(
  row: BillingRow,
  target: { plan: PlanId; interval: BillingInterval },
  origin: string,
): Promise<Record<string, unknown> | null> {
  if (!row.stripe_subscription_id) return null;

  const price = priceIdFor(target.plan, target.interval);
  if (!price) return null;

  // The flow replaces a subscription *item*, so it needs that item's id — which
  // only the subscription itself knows.
  let item: string | undefined;
  try {
    const subscription = await stripe<StripeSubscription>(`/subscriptions/${row.stripe_subscription_id}`, {
      method: 'GET',
    });
    item = subscription.items?.data?.[0]?.id;
    if (subscription.items?.data?.[0]?.price?.id === price) {
      // Already on this exact price; the confirm screen would be a no-op.
      return null;
    }
  } catch {
    return null;
  }
  if (!item) return null;

  return {
    type: 'subscription_update_confirm',
    subscription_update_confirm: {
      subscription: row.stripe_subscription_id,
      items: [{ id: item, price, quantity: 1 }],
    },
    after_completion: {
      type: 'redirect',
      redirect: { return_url: `${origin}/app/account?checkout=success` },
    },
  };
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

/** Records an event id. Returns false when it was already handled. */
async function claimEvent(id: string, type: string, userId: string | null): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO billing_events (id, type, user_id, received_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(id, type, userId, new Date().toISOString())
    .run();
  // D1 reports 0 changes when the OR IGNORE swallowed a duplicate.
  return (result.meta?.changes ?? 0) > 0;
}

interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ id?: string; price?: { id?: string }; current_period_end?: number }> };
}

function subscriptionPlan(subscription: StripeSubscription): { plan: PlanId; interval: BillingInterval } | null {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (priceId) {
    const match = planForPrice(priceId);
    if (match) return match;
  }
  // Fall back to the metadata we stamped at checkout, so a price rotated in the
  // Stripe dashboard downgrades nobody.
  const fromMetadata = subscription.metadata?.plan as PlanId | undefined;
  if (fromMetadata && PAID_PLANS.includes(fromMetadata)) return { plan: fromMetadata, interval: 'monthly' };
  return null;
}

function periodEnd(subscription: StripeSubscription): string | null {
  // Stripe moved `current_period_end` onto the subscription item in 2025 API
  // versions; accept it in either place.
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

async function findUserId(subscription: StripeSubscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.user_id;
  if (fromMetadata) return fromMetadata;
  const row = await env.DB.prepare(`SELECT id FROM users WHERE stripe_customer_id = ?`)
    .bind(subscription.customer)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Writes a subscription's current state onto the account. */
async function applySubscription(subscription: StripeSubscription): Promise<string | null> {
  const userId = await findUserId(subscription);
  if (!userId) {
    console.error(`[billing] no account matches customer ${subscription.customer}`);
    return null;
  }

  const entitled = ENTITLED_STATUSES.has(subscription.status);
  const match = subscriptionPlan(subscription);
  const plan: PlanId = entitled && match ? match.plan : 'free';
  const interval = entitled && match ? match.interval : '';

  await env.DB.prepare(
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

  console.log(`[billing] ${userId} → ${plan} (${subscription.status})`);
  return userId;
}

export interface WebhookOutcome {
  handled: boolean;
  type: string;
  reason?: string;
}

/**
 * Applies a verified Stripe event. Idempotent: Stripe retries until it gets a
 * 2xx, and a retry must not be replayed as a second upgrade.
 */
export async function handleWebhookEvent(event: {
  id: string;
  type: string;
  data: { object: any };
}): Promise<WebhookOutcome> {
  if (!(await claimEvent(event.id, event.type, null))) {
    return { handled: false, type: event.type, reason: 'duplicate' };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as { subscription?: string | null };
      if (!session.subscription) return { handled: false, type: event.type, reason: 'no_subscription' };
      // The session carries only the subscription id, so read the subscription
      // itself for the price and period.
      const subscription = await stripe<StripeSubscription>(`/subscriptions/${session.subscription}`, {
        method: 'GET',
      });
      const userId = await applySubscription(subscription);
      if (userId) await env.DB.prepare(`UPDATE billing_events SET user_id = ? WHERE id = ?`).bind(userId, event.id).run();
      return { handled: Boolean(userId), type: event.type };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as StripeSubscription;
      // A deleted subscription arrives with whatever status it ended on; force
      // the terminal one so entitlements drop.
      if (event.type === 'customer.subscription.deleted') subscription.status = 'canceled';
      const userId = await applySubscription(subscription);
      if (userId) await env.DB.prepare(`UPDATE billing_events SET user_id = ? WHERE id = ?`).bind(userId, event.id).run();
      return { handled: Boolean(userId), type: event.type };
    }

    default:
      return { handled: false, type: event.type, reason: 'ignored' };
  }
}
