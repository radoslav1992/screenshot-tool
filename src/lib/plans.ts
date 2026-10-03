export type PlanId = 'free' | 'lite' | 'plus' | 'pro' | 'business';

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
    tagline: 'Your first client capture and web report',
    description:
      '20 screenshots a month and 3 website monitors checked weekly. Every device, capture mode and ready-made size. Files carry a small easyscreencapture.com mark.',
    quota: 20,
    api: false,
    formats: ['png', 'jpg'],
    customViewport: false,
    historyDays: 7,
    watermark: true,
    features: [
      { text: '20 screenshots / month', included: true },
      { text: 'Private projects & batch captures', included: true },
      { text: 'PNG/JPG & shareable web reports', included: true },
      { text: '3 monitors, checked weekly', included: true },
      { text: 'Without the watermark', included: false },
    ],
    cta: 'Start free',
  },

  lite: {
    id: 'lite', name: 'Lite', priceMonthly: 2.99, priceYearly: 24.99,
    tagline: 'Everyday screenshots, saved and shared',
    description: '500 screenshots per calendar month, no watermark, 30 days of cloud history and 10 website monitors checked daily or weekly. Save and share full-page screenshots across your devices.',
    quota: 500, api: false, formats: ['png', 'jpg'], customViewport: false,
    historyDays: 30, watermark: false,
    priceEnv: { monthly: 'STRIPE_PRICE_LITE_MONTHLY', yearly: 'STRIPE_PRICE_LITE_YEARLY' },
    features: [
      { text: '500 screenshots / month', included: true },
      { text: 'No watermark', included: true },
      { text: 'Full-page PNG/JPG screenshots', included: true },
      { text: '30-day cloud history', included: true },
      { text: '10 monitors, daily or weekly', included: true },
    ], cta: 'Get Lite',
  },

  plus: {
    id: 'plus',
    name: 'Plus',
    priceMonthly: 7,
    priceYearly: 67,
    tagline: 'Clean reports and daily website checks',
    description:
      '500 screenshots a month with no watermark. Every device, capture mode and ready-made size, plus PDF export, custom viewports, 30 days of capture history and 25 website monitors checked daily or weekly.',
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
      { text: 'Branded PDF reports & custom sizes', included: true },
      { text: '30-day history', included: true },
      { text: '25 monitors, daily or weekly', included: true },
    ],
    cta: 'Go Plus',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    priceYearly: 182,
    tagline: 'For freelancers automating client work',
    description:
      '2,000 screenshots a month with no watermark, plus full API access at 60 requests a minute. Every device, mode and size, PDF export, custom viewports, 30 days of capture history and 100 website monitors checked as often as hourly, or every 15 minutes for text, price and SEO rules.',
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
      { text: 'Branded PDF reports & custom sizes', included: true },
      { text: '30-day capture history', included: true },
      { text: '100 monitors; hourly, or 15-minute rule checks', included: true },
    ],
    cta: 'Go Pro',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 79,
    priceYearly: 758,
    tagline: 'For agencies reviewing work together',
    description:
      '15,000 screenshots a month with no watermark, API access at 300 requests a minute, and three collaborators per project. Every device, mode and size, PDF export, custom viewports, a year of capture history and 300 website monitors checked as often as hourly, or every 15 minutes for text, price and SEO rules.',
    quota: 15000,
    api: true,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 365,
    watermark: false,
    priceEnv: { monthly: 'STRIPE_PRICE_BUSINESS_MONTHLY', yearly: 'STRIPE_PRICE_BUSINESS_YEARLY' },
    features: [
      { text: '15,000 screenshots / month', included: true },
      { text: '3 collaborators per project', included: true },
      { text: '365-day capture history', included: true },
      { text: 'API: 300 requests / minute', included: true },
      { text: '300 monitors; hourly, or 15-minute rule checks', included: true },
    ],
    cta: 'Choose Business',
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'lite', 'plus', 'pro', 'business'];

/** Plans that can be bought. Free is the default, not a purchase. */
export const PAID_PLANS: PlanId[] = ['lite', 'plus', 'pro', 'business'];

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
  lite: 0,
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
  lite: 30,
  plus: 60,
  pro: 120,
  business: 600,
};

/** The most captures one background batch may queue, on any plan. */
export const MAX_BACKGROUND_BATCH = 500;

/**
 * Captures one background batch may queue, by plan.
 *
 * A batch is charged against the hourly limit above in full when it is
 * created — otherwise a batch is the way around it — so it can never be larger
 * than that limit: Free 10, Lite 30, Plus 60, Pro 120, Business 500. The
 * monthly quota caps it again at what is left.
 */
export function batchLimit(id: string | null | undefined): number {
  return Math.min(MAX_BACKGROUND_BATCH, APP_RATE_LIMIT[getPlan(id).id]);
}

/** How long a capture's files are kept, by plan. */
export function retentionDays(id: string | null | undefined): number {
  return getPlan(id).historyDays;
}

/* -------------------------------------------------------------------------- */
/* Watches                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The 15-minute schedule's id reads acceptably through Swift's `.capitalized`
 * ("Quarter-Hourly"), which is how iOS builds show a schedule id, though
 * /api/mobile/profile never offers this one (see visualFrequencies).
 */
export type WatchFrequency = 'quarter-hourly' | 'hourly' | 'daily' | 'weekly';

/** The schedule only rule-based monitors may use: every check of a visual one takes a screenshot. */
export const RULE_ONLY_FREQUENCY = 'quarter-hourly';

export const FREQUENCIES: Array<{ id: WatchFrequency; label: string; hours: number }> = [
  { id: 'quarter-hourly', label: 'Every 15 minutes', hours: 0.25 },
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
 * Free gets three, checked weekly. A watch spends quota whenever it renders
 * with nobody present, but weekly checks on three monitors cost at most about
 * 12 screenshots a month, inside Free's 20 — and a rule-based monitor renders
 * only when its page changed, or on its weekly full check (fast-checks.ts).
 * Enough to see monitoring work, and to want it more often.
 */
export const WATCH_LIMIT: Record<PlanId, number> = {
  free: 3,
  lite: 10,
  plus: 25,
  pro: 100,
  business: 300,
};

/**
 * The shortest interval a plan may pick. Hourly is 24× the monthly spend of
 * daily for a visual monitor, so it belongs where the quota can absorb it.
 * Every 15 minutes is for rule-based monitors only: they read the page and
 * render it only when something changed, where a visual one would take 96
 * screenshots a day.
 */
export const WATCH_FREQUENCIES: Record<PlanId, WatchFrequency[]> = {
  free: ['weekly'],
  lite: ['daily', 'weekly'],
  plus: ['daily', 'weekly'],
  pro: ['quarter-hourly', 'hourly', 'daily', 'weekly'],
  business: ['quarter-hourly', 'hourly', 'daily', 'weekly'],
};

export function watchLimit(id: string | null | undefined): number {
  return WATCH_LIMIT[getPlan(id).id];
}

export function allowedFrequencies(id: string | null | undefined): WatchFrequency[] {
  return WATCH_FREQUENCIES[getPlan(id).id];
}

/**
 * The schedules a visual monitor may use on a plan. The iOS app only creates
 * visual monitors, so this is the list /api/mobile/profile offers it.
 */
export function visualFrequencies(id: string | null | undefined): WatchFrequency[] {
  return allowedFrequencies(id).filter((frequency) => frequency !== RULE_ONLY_FREQUENCY);
}

/**
 * Checks a watch runs in 30 days at each cadence. Each is a screenshot for a
 * visual monitor; a rule-based one spends a screenshot only when its page
 * changed, or on its weekly full check.
 */
export function runsPerMonth(frequency: string): number {
  return Math.round((30 * 24) / frequencyHours(frequency));
}

/* -------------------------------------------------------------------------- */
/* Report branding                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether a project's review links may drop the "Shared with Easy Screen
 * Capture" line. A logo, accent colour and footer line are on every plan; the
 * pricing copy promises no white-label, so removing our name is kept for the
 * top two plans and the branding form says so.
 */
export const REPORT_WHITE_LABEL: Record<PlanId, boolean> = {
  free: false,
  lite: false,
  plus: false,
  pro: true,
  business: true,
};
