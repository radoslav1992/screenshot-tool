import { drainPush } from './lib/push';
import astro from '@astrojs/cloudflare/entrypoints/server';
import { env } from 'cloudflare:workers';
import { failStrandedCaptures, sweepExpiredCaptures } from './lib/retention';
import { runDueWatches, retryAlerts } from './lib/watches';
import { runProjectDigests } from './lib/digests';

/**
 * Worker entrypoint.
 *
 * The Astro adapter's own entrypoint only exports `fetch`, so this wraps it to
 * add the `scheduled` handler that Cron Triggers invoke. `wrangler.jsonc` points
 * `main` here instead of at the adapter.
 */


export default {
  fetch: astro.fetch,

  /** Watches and bounded retention batches share the hourly trigger. */
  async scheduled(event: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(event.scheduledTime);

    ctx.waitUntil(
      failStrandedCaptures(now.getTime())
        .then((failed) => {
          if (failed) console.log(`[capture] marked ${failed} stranded capture(s) failed`);
        })
        .catch((error) => console.error('[capture] stranded sweep failed', error)),
    );

    ctx.waitUntil(
      runDueWatches(siteOrigin(), now)
        .then((result) => {
          if (!result.due) return;
          console.log(
            `[watch] due=${result.due} ran=${result.ran} changed=${result.changed} ` +
              `errors=${result.errors} skipped=${result.skipped}`,
          );
        })
        .catch((error) => {
          console.error('[watch] sweep failed', error);
        }),
    );

    ctx.waitUntil(drainPush().catch(() => console.error('[push] retry sweep failed')));

    ctx.waitUntil(retryAlerts(siteOrigin()).catch(error => console.error('[alerts] retry sweep failed', error)));

    ctx.waitUntil(runProjectDigests(siteOrigin(), now).catch((error) => console.error('[digest] sweep failed', error)));

    ctx.waitUntil(
      sweepExpiredCaptures(now.getTime())
        .then((result) => {
          console.log(
            `[retention] scanned=${result.scanned} deleted=${result.deleted} files=${result.filesDeleted} ` +
              `bytes=${result.bytesFreed} tokens=${result.tokensPurged} failed=${result.failed} truncated=${result.truncated}`,
          );
        })
        .catch((error) => {
          console.error('[retention] sweep failed', error);
        }),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * A cron invocation has no request to take an origin from, and alert emails
 * carry links to the app. PUBLIC_SITE_URL is the only thing that knows where
 * this deployment actually lives.
 */
function siteOrigin(): string {
  return (env.PUBLIC_SITE_URL || 'https://easyscreencapture.com').replace(/\/+$/, '');
}
