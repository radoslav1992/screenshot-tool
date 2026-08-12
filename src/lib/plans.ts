export type PlanId = 'free' | 'plus' | 'pro' | 'business';

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  tagline: string;
  /**
   * What the customer is buying, in their words, for Stripe.
   *
   * Separate from `tagline` because they are read in different places. A
   * tagline sits under a price on the pricing page, where the feature list is
   * right there; this appears on the checkout page and on every invoice, where
   * it is the only description of what was charged for — so it says the
   * quantities rather than who it is for. Only what actually ships goes in it.
   */
  description: string;
  /** Screenshots per billing month. A `series` capture counts once per frame. */
  quota: number;
  api: boolean;
  formats: Array<'png' | 'jpg' | 'pdf'>;
  customViewport: boolean;
  historyDays: number;
  /** Free captures carry a small mark; paying removes it. */
  watermark: boolean;
  /** Stripe price ids, resolved from config at runtime. */
  priceEnv?: { monthly: string; yearly: string };
  features: Array<{ text: string; included: boolean }>;
  cta: string;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceYearly: 0,
    tagline: 'For trying things out',
    description:
      '200 screenshots a month. Every device, capture mode and ready-made size. Files carry a small easyscreencapture.com mark.',
    quota: 200,
    api: false,
    formats: ['png', 'jpg'],
    customViewport: false,
    historyDays: 7,
    watermark: true,
    features: [
      { text: '200 screenshots / month', included: true },
      { text: 'All devices, modes & sizes', included: true },
      { text: 'PNG & JPG', included: true },
      { text: 'Without the watermark', included: false },
      { text: 'Watched pages', included: false },
    ],
    cta: 'Start free',
  },

  plus: {
    id: 'plus',
    name: 'Plus',
    priceMonthly: 7,
    priceYearly: 67,
    tagline: 'For anyone publishing what they capture',
    description:
      '500 screenshots a month with no watermark. Every device, capture mode and ready-made size, plus PDF export, custom viewports, 30 days of capture history and 5 watched pages checked daily for visual changes.',
    quota: 500,
    api: false,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 30,
    watermark: false,
    priceEnv: { monthly: 'STRIPE_PRICE_PLUS_MONTHLY', yearly: 'STRIPE_PRICE_PLUS_YEARLY' },
    features: [
      { text: 'No watermark', included: true },
      { text: '500 screenshots / month', included: true },
      { text: 'PDF export & custom sizes', included: true },
      { text: '30-day history', included: true },
      { text: '5 watched pages, daily', included: true },
    ],
    cta: 'Go Plus',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    priceYearly: 182,
    tagline: 'For freelancers & small teams',
    description:
      '2,000 screenshots a month with no watermark, plus full API access at 60 requests a minute. Every device, mode and size, PDF export, custom viewports, 30 days of capture history and 25 watched pages checked as often as hourly.',
    quota: 2000,
    api: true,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 30,
    watermark: false,
    priceEnv: { monthly: 'STRIPE_PRICE_PRO_MONTHLY', yearly: 'STRIPE_PRICE_PRO_YEARLY' },
    features: [
      { text: '2,000 screenshots / month', included: true },
      { text: 'Full API access', included: true },
      { text: 'PDF export & custom viewports', included: true },
      { text: '30-day capture history', included: true },
      { text: '25 watched pages, hourly', included: true },
    ],
    cta: 'Go Pro',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 79,
    priceYearly: 758,
    tagline: 'For products built on screenshots',
    description:
      '15,000 screenshots a month with no watermark, API access at 300 requests a minute, and a priority rendering queue. Every device, mode and size, PDF export, custom viewports, a year of capture history and 100 watched pages checked as often as hourly.',
    quota: 15000,
    api: true,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 365,
    watermark: false,
    priceEnv: { monthly: 'STRIPE_PRICE_BUSINESS_MONTHLY', yearly: 'STRIPE_PRICE_BUSINESS_YEARLY' },
    features: [
      { text: '15,000 screenshots / month', included: true },
      { text: 'Priority rendering queue', included: true },
      { text: 'Team seats & shared library', included: true },
      { text: '99.9% uptime SLA', included: true },
      { text: '100 watched pages, hourly', included: true },
    ],
    cta: 'Choose Business',
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'plus', 'pro', 'business'];

/** Plans that can be bought. Free is the default, not a purchase. */
export const PAID_PLANS: PlanId[] = ['plus', 'pro', 'business'];

export function getPlan(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) ?? 'free'] ?? PLANS.free;
}

/**
 * The cheapest plan that includes a feature, so upgrade prompts name the plan
 * someone actually has to buy rather than a hard-coded tier that drifts as the
 * ladder changes.
 */
export function cheapestPlanWith(includes: (plan: Plan) => boolean): Plan {
  return PLAN_ORDER.map((id) => PLANS[id]).find(includes) ?? PLANS.business;
}

/** Requests per minute allowed on the public API, by plan. */
export const API_RATE_LIMIT: Record<PlanId, number> = {
  free: 0,
  plus: 0,
  pro: 60,
  business: 300,
};

/**
 * Captures per hour allowed from the app (session-authenticated), by plan.
 *
 * The monthly quota alone does not protect the render pool: a single account
 * can spend its whole allowance in one burst and starve paying customers of the
 * account's concurrent browsers. This bounds the burst rather than the total.
 */
export const APP_RATE_LIMIT: Record<PlanId, number> = {
  free: 10,
  plus: 60,
  pro: 120,
  business: 600,
};

/** How long a capture's files are kept, by plan. */
export function retentionDays(id: string | null | undefined): number {
  return getPlan(id).historyDays;
}

/* -------------------------------------------------------------------------- */
/* Watches                                                                     */
/* -------------------------------------------------------------------------- */

export type WatchFrequency = 'hourly' | 'daily' | 'weekly';

export const FREQUENCIES: Array<{ id: WatchFrequency; label: string; hours: number }> = [
  { id: 'hourly', label: 'Every hour', hours: 1 },
  { id: 'daily', label: 'Every day', hours: 24 },
  { id: 'weekly', label: 'Every week', hours: 168 },
];

export function frequencyHours(frequency: string): number {
  return FREQUENCIES.find((entry) => entry.id === frequency)?.hours ?? 24;
}

export function frequencyLabel(frequency: string): string {
  return FREQUENCIES.find((entry) => entry.id === frequency)?.label ?? frequency;
}

/**
 * How many pages an account may watch, by plan.
 *
 * Free gets none deliberately. A watch spends quota every time it runs without
 * anyone present, so handing them out free turns an idle account into a
 * standing render bill — and this is the feature worth paying for.
 */
export const WATCH_LIMIT: Record<PlanId, number> = {
  free: 0,
  plus: 5,
  pro: 25,
  business: 100,
};

/**
 * The shortest interval a plan may pick. Hourly is 24× the monthly spend of
 * daily, so it belongs where the quota can absorb it.
 */
export const WATCH_FREQUENCIES: Record<PlanId, WatchFrequency[]> = {
  free: [],
  plus: ['daily', 'weekly'],
  pro: ['hourly', 'daily', 'weekly'],
  business: ['hourly', 'daily', 'weekly'],
};

export function watchLimit(id: string | null | undefined): number {
  return WATCH_LIMIT[getPlan(id).id];
}

export function allowedFrequencies(id: string | null | undefined): WatchFrequency[] {
  return WATCH_FREQUENCIES[getPlan(id).id];
}

/** Monthly captures a watch costs at each cadence — shown before one is created. */
export function runsPerMonth(frequency: string): number {
  return Math.round((30 * 24) / frequencyHours(frequency));
}
