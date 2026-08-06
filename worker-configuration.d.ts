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

    /** "1" gates capturing on a confirmed email — only when a mailer is configured. */
    REQUIRE_EMAIL_VERIFICATION?: string;
    /** Sender address for confirmation emails. */
    EMAIL_FROM?: string;

    /** Optional: enables the REST Browser Rendering fallback. */
    CF_ACCOUNT_ID?: string;
    CF_API_TOKEN?: string;
    /** Optional: enables sending confirmation emails via Resend. */
    RESEND_API_KEY?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  export const env: Env;
}
