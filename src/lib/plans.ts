export type PlanId = 'free' | 'pro' | 'business';

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  tagline: string;
  /** Screenshots per billing month. A `series` capture counts once per frame. */
  quota: number;
  api: boolean;
  formats: Array<'png' | 'jpg' | 'pdf'>;
  customViewport: boolean;
  historyDays: number;
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
    quota: 200,
    api: false,
    formats: ['png', 'jpg'],
    customViewport: false,
    historyDays: 7,
    features: [
      { text: '200 screenshots / month', included: true },
      { text: 'All devices & capture modes', included: true },
      { text: 'PNG & JPG', included: true },
      { text: 'API access', included: false },
    ],
    cta: 'Start free',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    priceYearly: 182,
    tagline: 'For freelancers & small teams',
    quota: 2000,
    api: true,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 30,
    features: [
      { text: '2,000 screenshots / month', included: true },
      { text: 'Full API access', included: true },
      { text: 'PDF export & custom viewports', included: true },
      { text: '30-day capture history', included: true },
    ],
    cta: 'Go Pro',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 79,
    priceYearly: 758,
    tagline: 'For products built on screenshots',
    quota: 15000,
    api: true,
    formats: ['png', 'jpg', 'pdf'],
    customViewport: true,
    historyDays: 365,
    features: [
      { text: '15,000 screenshots / month', included: true },
      { text: 'Priority rendering queue', included: true },
      { text: 'Team seats & shared library', included: true },
      { text: '99.9% uptime SLA', included: true },
    ],
    cta: 'Choose Business',
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'pro', 'business'];

export function getPlan(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) ?? 'free'] ?? PLANS.free;
}

/** Requests per minute allowed on the public API, by plan. */
export const API_RATE_LIMIT: Record<PlanId, number> = {
  free: 0,
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
  pro: 120,
  business: 600,
};

/** How long a capture's files are kept, by plan. */
export function retentionDays(id: string | null | undefined): number {
  return getPlan(id).historyDays;
}
