// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
    // Workers AI has no local implementation, so with remote bindings on, every
    // build and dev server proxies it to Cloudflare and fails without a login.
    // Production gets the real binding at deploy time either way; locally and in
    // CI the summaries fall back to plain text. CLOUDFLARE_REMOTE_BINDINGS=1
    // turns the proxy back on for a logged-in machine.
    remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === '1',
  }),
  site: process.env.PUBLIC_SITE_URL || 'https://easyscreencapture.com',
  security: {
    // Astro's blanket origin check rejects form-encoded POSTs without an
    // Origin header, which would break `curl -d url=… /v1/capture`. The public
    // API is bearer-authenticated (no ambient credentials, so no CSRF surface),
    // and every cookie-authenticated mutation calls assertSameOrigin() itself
    // on top of SameSite=Lax session cookies.
    checkOrigin: false,
  },
  vite: {
    build: {
      // Browser Rendering sessions can produce large buffers; keep chunks lean.
      chunkSizeWarningLimit: 1500,
    },
  },
});
