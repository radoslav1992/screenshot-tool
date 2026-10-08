import { env } from 'cloudflare:workers';
import { projectsReady } from './projects';
import { collaborationReady } from './collaboration';
import { watchSettingsReady } from './watch-settings';
import { accountBrandingCleanup } from './branding';
import { signoffsReady } from './signoff';
import { captureJobsReady } from './capture-jobs';
import { growthCleanup } from './growth';
import { webPushTablesReady } from './push';
import { trialCleanup } from './trials';
import { siteHealthCleanup } from './site-health-summary';

export interface DeletionResult {
  /** R2 objects removed. */
  files: number;
  /** Capture rows removed. */
  captures: number;
}

/**
 * R2 lists and deletes in batches of up to 1000 keys, and each call is one
 * subrequest. Deleting a heavy account one object at a time would run into the
 * per-request subrequest limit long before it finished.
 */
const R2_BATCH = 1000;

/**
 * Removes every stored file belonging to a user.
 *
 * Keys are laid out as `captures/<user>/<capture>/<name>`, so the whole account
 * is one prefix. Listing the prefix rather than walking the capture rows also
 * catches objects orphaned by an interrupted delete.
 */
async function purgeFiles(userId: string): Promise<number> {
  const prefix = `captures/${userId}/`;
  let cursor: string | undefined;
  let deleted = 0;

  for (;;) {
    const listed = await env.SHOTS.list({ prefix, limit: R2_BATCH, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) {
      await env.SHOTS.delete(keys);
      deleted += keys.length;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  return deleted;
}

/**
 * Erases an account: every stored file, then every row that refers to the user.
 *
 * Files go first on purpose. If the run dies halfway, an account with orphaned
 * rows can be deleted again; rows deleted first would leave files in R2 with
 * nothing left pointing at them.
 *
 * The rows are removed explicitly rather than leaning on `ON DELETE CASCADE`, so
 * the set of tables cleared is visible here and does not depend on whether
 * foreign keys are being enforced.
 */
export async function deleteAccount(userId: string): Promise<DeletionResult> {
  const files = await purgeFiles(userId);
  // Logos are keyed by project, not user, so they are found through the rows.
  const brandingCleanup = await accountBrandingCleanup(userId);

  const captures = await env.DB.prepare(`SELECT COUNT(*) AS n FROM captures WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();

  const projectCleanup = (await projectsReady())
    ? [
        ...['report_captures', 'report_links', 'report_comments'].map((table) =>
          env.DB.prepare(
            `DELETE FROM ${table} WHERE report_id IN (SELECT r.id FROM review_reports r JOIN projects p ON p.id=r.project_id WHERE p.user_id=?)`,
          ).bind(userId),
        ),
        ...['review_reports', 'capture_presets', 'project_captures', 'project_watches'].map((table) =>
          env.DB.prepare(`DELETE FROM ${table} WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)`).bind(
            userId,
          ),
        ),
        env.DB.prepare('DELETE FROM projects WHERE user_id=?').bind(userId),
      ]
    : [];

  const collaborationCleanup = (await collaborationReady())
    ? [
        env.DB.prepare(
          'DELETE FROM team_comments WHERE user_id=? OR report_id IN(SELECT r.id FROM review_reports r JOIN projects p ON p.id=r.project_id WHERE p.user_id=?)',
        ).bind(userId, userId),
        ...['project_members', 'project_digests', 'digest_deliveries'].map((table) =>
          env.DB.prepare(
            `DELETE FROM ${table} WHERE user_id=? OR project_id IN(SELECT id FROM projects WHERE user_id=?)`,
          ).bind(userId, userId),
        ),
      ]
    : [];
  const signoffCleanup = (await signoffsReady())
    ? [
        env.DB.prepare(
          'DELETE FROM report_signoffs WHERE report_id IN(SELECT r.id FROM review_reports r JOIN projects p ON p.id=r.project_id WHERE p.user_id=?)',
        ).bind(userId),
      ]
    : [];
  // Jobs before batches: a job points at its batch.
  const jobCleanup = (await captureJobsReady())
    ? [
        env.DB.prepare('DELETE FROM capture_jobs WHERE user_id=?').bind(userId),
        env.DB.prepare('DELETE FROM capture_batches WHERE user_id=?').bind(userId),
      ]
    : [];
  const noiseCleanup = (await watchSettingsReady())
    ? [
        env.DB.prepare('DELETE FROM watch_settings WHERE watch_id IN(SELECT id FROM watches WHERE user_id=?)').bind(
          userId,
        ),
      ]
    : [];
  // Browser push subscriptions go with their sessions anyway; named here like everything else.
  const webPushCleanup = (await webPushTablesReady())
    ? [
        env.DB.prepare('DELETE FROM web_push_deliveries WHERE device_id IN(SELECT id FROM web_push_subscriptions WHERE user_id=?)').bind(
          userId,
        ),
        env.DB.prepare('DELETE FROM web_push_subscriptions WHERE user_id=?').bind(userId),
      ]
    : [];
  // Signup source, referral code, bonus and referrals (lib/growth.ts).
  const growthRows = await growthCleanup(userId);
  // The Pro trial record, once migration 0019 exists.
  const trialRows = await trialCleanup(userId);
  // Site health results (migration 0020): before the monitors their link checks belong to.
  const siteHealthRows = await siteHealthCleanup(userId);
  await env.DB.batch([
    ...growthRows,
    ...trialRows,
    ...siteHealthRows,
    ...collaborationCleanup,
    ...signoffCleanup,
    ...brandingCleanup,
    ...noiseCleanup,
    ...projectCleanup,
    ...jobCleanup,
    ...webPushCleanup,
    env.DB.prepare('DELETE FROM watch_runs WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM watches WHERE user_id=?').bind(userId),
    env.DB.prepare(`DELETE FROM captures WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM api_keys WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM usage_counters WHERE user_id = ?`).bind(userId),
    // Webhook idempotency records are kept — replaying a Stripe retry against a
    // deleted account would be worse — but they stop naming the person.
    env.DB.prepare(`UPDATE billing_events SET user_id = NULL WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId),
  ]);

  return { files, captures: captures?.n ?? 0 };
}
