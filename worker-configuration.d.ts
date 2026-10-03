// Bindings declared in wrangler.jsonc.
// Regenerate a fuller version any time with: npx wrangler types
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    SHOTS: R2Bucket;
    RATE: KVNamespace;
    BROWSER: Fetcher;

    APPLE_IAP_KEY_ID?: string;
    APPLE_IAP_ISSUER_ID?: string;
    APPLE_IAP_PRIVATE_KEY?: string;
    APPLE_IAP_WEBHOOK_SECRET?: string;
    APPLE_SANDBOX_USER_IDS?: string;
    STRIPE_PRICE_LITE_MONTHLY?: string;
    STRIPE_PRICE_LITE_YEARLY?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    APNS_PRIVATE_KEY?: string;
    APNS_BUNDLE_ID?: string;
    PUBLIC_SITE_URL: string;
    CAPTURE_HOST_DENYLIST?: string;

    /**
     * Milliseconds to keep an idle browser session alive for reuse. 0 (default)
     * closes it immediately. Idle sessions are billed, so raise this only under
     * sustained load — see the README.
     */
    BROWSER_KEEP_ALIVE_MS?: string;

    /**
     * Renders a day across every visitor of the free tools (/tools): screenshots,
     * previews and comparisons together. Optional; 300 when unset, and "0" turns
     * the browser tools off while the SEO checker stays up. See the README.
     */
    FREE_TOOLS_DAILY_RENDERS?: string;

    /** "1" gates capturing on a confirmed email — only when a mailer is configured. */
    REQUIRE_EMAIL_VERIFICATION?: string;
    /** Sender address for confirmation emails: an address, or `Name <address>`. */
    EMAIL_FROM?: string;

    /**
     * Cloudflare Email Sending. Optional, and preferred over Resend when both
     * are present — the binding needs no API key. Declared in wrangler.jsonc as
     * `send_email`, and only after the sending domain has been onboarded in the
     * dashboard; see the comment there.
     */
    EMAIL?: SendEmail;

    /**
     * Workers AI. Used only to summarise what changed on a watched page; the
     * alert degrades to a plain diff without it.
     */
    AI?: { run(model: string, input: unknown): Promise<unknown> };

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

    /**
     * "1" makes Stripe Tax work out VAT/GST at checkout, collect a billing
     * address, and offer a VAT-number field. Set it only after activating Tax
     * and setting an origin address in the dashboard — Stripe rejects the
     * checkout session otherwise.
     */
    STRIPE_AUTOMATIC_TAX?: string;

    /**
     * "1" makes checkout require the customer to accept the terms and waive the
     * EU 14-day withdrawal right before paying. Needs a terms-of-service URL on
     * the Stripe account's public details, or the session is rejected.
     */
    STRIPE_TOS_CONSENT?: string;

    /**
     * Who is emailed when Stripe rejects a checkout or portal request — at most
     * once per Stripe error code per hour. Optional: falls back to the contact
     * address in src/lib/company.ts. Set it as a secret: a deploy replaces the
     * plain-text variables with the ones in wrangler.jsonc.
     */
    BILLING_ALERT_EMAIL?: string;

    /**
     * Who may open the growth dashboard (/app/growth): a comma-separated list of
     * account emails, compared without regard to case. Optional; unset, the page
     * is a 404 for everyone. Set it as a secret for the same reason as above.
     */
    OWNER_EMAILS?: string;

    /**
     * "1" keeps where a visitor first came from in a 30-day cookie, sf_src, as
     * well as in the links (lib/attribution.ts). Off by default: the cookie is
     * not strictly necessary, so turning it on means asking for consent first.
     */
    ATTRIBUTION_COOKIE?: string;

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
