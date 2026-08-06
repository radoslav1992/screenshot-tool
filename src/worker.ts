import astro from '@astrojs/cloudflare/entrypoints/server';
import { sweepExpiredCaptures } from './lib/retention';

/**
 * Worker entrypoint.
 *
 * The Astro adapter's own entrypoint only exports `fetch`, so this wraps it to
 * add the `scheduled` handler that Cron Triggers invoke. `wrangler.jsonc` points
 * `main` here instead of at the adapter.
 */
export default {
  fetch: astro.fetch,

  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepExpiredCaptures()
        .then((result) => {
          console.log(
            `[retention] scanned=${result.scanned} deleted=${result.deleted} files=${result.filesDeleted} ` +
              `bytes=${result.bytesFreed} tokens=${result.tokensPurged} truncated=${result.truncated}`,
          );
        })
        .catch((error) => {
          console.error('[retention] sweep failed', error);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
