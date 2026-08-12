import astro from '@astrojs/cloudflare/entrypoints/server';
import { env } from 'cloudflare:workers';
import { sweepExpiredCaptures } from './lib/retention';
import { runDueWatches } from './lib/watches';

/**
 * Worker entrypoint.
 *
 * The Astro adapter's own entrypoint only exports `fetch`, so this wraps it to
 * add the `scheduled` handler that Cron Triggers invoke. `wrangler.jsonc` points
 * `main` here instead of at the adapter.
 */

/** The hour (UTC) the nightly retention sweep runs on. */
const RETENTION_HOUR = 3;

export default {
  fetch: astro.fetch,

  /*
   * The trigger fires hourly because watches can be checked hourly. Retention is
   * still a once-a-day job, so it is gated on the hour rather than given a
   * second cron expression — one schedule is easier to reason about than two,
   * and `scheduled` has no way to tell which expression woke it.
   */
  async scheduled(event: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(event.scheduledTime);

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

    if (now.getUTCHours() !== RETENTION_HOUR) return;

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

/**
 * A cron invocation has no request to take an origin from, and alert emails
 * carry links to the app. PUBLIC_SITE_URL is the only thing that knows where
 * this deployment actually lives.
 */
function siteOrigin(): string {
  return (env.PUBLIC_SITE_URL || 'https://easyscreencapture.com').replace(/\/+$/, '');
}
