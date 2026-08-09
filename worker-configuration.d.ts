// Bindings declared in wrangler.jsonc.
// Regenerate a fuller version any time with: npx wrangler types
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    SHOTS: R2Bucket;
    RATE: KVNamespace;
    BROWSER: Fetcher;

    PUBLIC_SITE_URL: string;
    CAPTURE_HOST_DENYLIST?: string;

    /**
     * Milliseconds to keep an idle browser session alive for reuse. 0 (default)
     * closes it immediately. Idle sessions are billed, so raise this only under
     * sustained load — see the README.
     */
    BROWSER_KEEP_ALIVE_MS?: string;

    /** "1" gates capturing on a confirmed email — only when a mailer is configured. */
    REQUIRE_EMAIL_VERIFICATION?: string;
    /** Sender address for confirmation emails. */
    EMAIL_FROM?: string;

    /** Optional: enables the REST Browser Rendering fallback. */
    CF_ACCOUNT_ID?: string;
    CF_API_TOKEN?: string;
    /** Optional: enables sending confirmation emails via Resend. */
    RESEND_API_KEY?: string;

    /**
     * Stripe. Billing stays completely dormant until STRIPE_SECRET_KEY is set:
     * the buy buttons do not render and the billing routes answer 503.
     *
     * Set all of these as secrets (encrypted variables), not plain-text vars —
     * a plain var declared in wrangler.jsonc is overwritten on every deploy,
     * while secrets set in the dashboard survive.
     */
    STRIPE_SECRET_KEY?: string;
    /** From the webhook endpoint in the Stripe dashboard (whsec_…). */
    STRIPE_WEBHOOK_SECRET?: string;

    /** Recurring price ids (price_…) per plan and interval. */
    STRIPE_PRICE_PLUS_MONTHLY?: string;
    STRIPE_PRICE_PLUS_YEARLY?: string;
    STRIPE_PRICE_PRO_MONTHLY?: string;
    STRIPE_PRICE_PRO_YEARLY?: string;
    STRIPE_PRICE_BUSINESS_MONTHLY?: string;
    STRIPE_PRICE_BUSINESS_YEARLY?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  export const env: Env;
}
