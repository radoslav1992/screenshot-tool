// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
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
