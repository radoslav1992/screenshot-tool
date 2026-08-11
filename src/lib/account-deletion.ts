import { env } from 'cloudflare:workers';

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

  const captures = await env.DB.prepare(`SELECT COUNT(*) AS n FROM captures WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();

  await env.DB.batch([
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
