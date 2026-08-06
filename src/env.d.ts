/// <reference types="astro/client" />

import type { Runtime } from '@astrojs/cloudflare';
import type { SessionUser } from './lib/auth';

declare global {
  namespace App {
    interface Locals extends Runtime {
      /** Signed-in user for this request, or null. Set by src/middleware.ts. */
      user: SessionUser | null;
    }
  }
}

export {};
