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
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  export const env: Env;
}
