import { refreshAppleSubscriptions } from './lib/apple-billing';
import { drainPush } from './lib/push';
import astro from '@astrojs/cloudflare/entrypoints/server';
import { env } from 'cloudflare:workers';
import { failStrandedCaptures, sweepExpiredCaptures } from './lib/retention';
import { runDueWatches, retryAlerts, type WatchSweepResult } from './lib/watches';
import { runProjectDigests } from './lib/digests';
import { pruneCaptureJobs, runCaptureJobs } from './lib/capture-jobs';
import { RULE_ONLY_FREQUENCY } from './lib/plans';

/**
 * Worker entrypoint.
 *
 * The Astro adapter's own entrypoint only exports `fetch`, so this wraps it to
 * add the `scheduled` handler that Cron Triggers invoke. `wrangler.jsonc` points
 * `main` here instead of at the adapter.
 */

/** The minute trigger in wrangler.jsonc: background capture jobs, and at :15, :30 and :45 the 15-minute monitors. */
const JOBS_CRON = '* * * * *';

export default {
  fetch: astro.fetch,

  /**
   * Two triggers. On the hour both fire, as separate invocations with their own
   * time limits: the minute one works the capture queue, and anything else —
   * the hourly `0 * * * *`, or a manual run with no cron at all — is the sweep
   * it always was, 15-minute monitors included. At a quarter past, half past
   * and a quarter to, the minute one also runs the 15-minute monitors that are
   * due, and nothing else; the hourly sweep has them on the hour.
   */
  async scheduled(event: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === JOBS_CRON) {
      const now = new Date(event.scheduledTime);
      ctx.waitUntil(runJobs(now));
      if (now.getUTCMinutes() % 15 === 0 && now.getUTCMinutes() !== 0) ctx.waitUntil(quarterHourly(now));
      return;
    }
    hourly(event, ctx);
  },
} satisfies ExportedHandler<Env>;

/** The 15-minute monitors due at a quarter hour. Claimed like every sweep's, so the hourly one never runs them too. */
async function quarterHourly(now: Date): Promise<void> {
  try {
    logSweep(await runDueWatches(siteOrigin(), now, { frequency: RULE_ONLY_FREQUENCY }), '[watch:15m]');
  } catch (error) {
    console.error('[watch:15m] sweep failed', error);
  }
}

function logSweep(result: WatchSweepResult, tag = '[watch]'): void {
  if (!result.due) return;
  // backlog: due but left for a later tick; late_max: the most overdue start, in minutes.
  console.log(
    `${tag} due=${result.due} ran=${result.ran} changed=${result.changed} ` +
      `errors=${result.errors} skipped=${result.skipped} backlog=${result.backlog} ` +
      `late_max=${Math.round(result.maxLateMs / 60_000)}m`,
  );
}

async function runJobs(now: Date): Promise<void> {
  try {
    const result = await runCaptureJobs(siteOrigin(), now);
    if (!result.due && !result.recovered && !result.expired) return;
    // backlog: still waiting when this tick stopped taking work; late_max: the most overdue start.
    console.log(
      `[jobs] due=${result.due} claimed=${result.claimed} done=${result.done} failed=${result.failed} ` +
        `retried=${result.retried} cancelled=${result.cancelled} recovered=${result.recovered} ` +
        `expired=${result.expired} backlog=${result.backlog} late_max=${Math.round(result.maxLateMs / 1000)}s`,
    );
  } catch (error) {
    console.error('[jobs] tick failed', error);
  }
}

/** Watches and bounded retention batches share the hourly trigger. */
function hourly(event: ScheduledController, ctx: ExecutionContext): void {
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
      .then((result) => logSweep(result))
      .catch((error) => {
        console.error('[watch] sweep failed', error);
      }),
  );

  ctx.waitUntil(refreshAppleSubscriptions().catch(() => console.error('[apple] refresh failed')));

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

  ctx.waitUntil(
    pruneCaptureJobs(now.getTime())
      .then((result) => {
        if (result.jobs || result.batches) console.log(`[jobs] pruned jobs=${result.jobs} batches=${result.batches}`);
      })
      .catch((error) => console.error('[jobs] prune failed', error)),
  );
}

/**
 * A cron invocation has no request to take an origin from, and alert emails
 * carry links to the app. PUBLIC_SITE_URL is the only thing that knows where
 * this deployment actually lives.
 */
function siteOrigin(): string {
  return (env.PUBLIC_SITE_URL || 'https://easyscreencapture.com').replace(/\/+$/, '');
}
