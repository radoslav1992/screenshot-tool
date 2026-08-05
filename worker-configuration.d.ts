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

    /** Optional: enables the REST Browser Rendering fallback. */
    CF_ACCOUNT_ID?: string;
    CF_API_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  export const env: Env;
}
