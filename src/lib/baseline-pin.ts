import { env } from 'cloudflare:workers';
import { HttpError, badRequest } from './http';
import { safeParseFiles, type CaptureRow } from './captures';
import { shouldRefreshBaseline } from './capture-engine';
import { decodeRunChanges } from './monitor-health';
import type { WatchRow } from './watches';

/**
 * Pinning a baseline.
 *
 * Unpinned, a monitor compares each check with the one before and the new
 * capture becomes the next baseline, so it reports "changed since last check".
 * Pinned, the owner has approved one version and every check compares against
 * that until it is unpinned; no check replaces it.
 *
 * The pin is `watches.baseline_pinned_at` (migration 0014): when it was pinned,
 * or NULL while the baseline follows the latest check. Production runs this code
 * before the migration is applied, so the column is probed and the feature stays
 * hidden until it exists — checks then run exactly as they always did.
 *
 * Retention and deleteCapture already keep whatever a watch's
 * baseline_capture_id names, and a pinned baseline is still that.
 */

/**
 * Which checks against a pinned baseline alert. Every check after the page
 * moves away from the pinned version differs from it, and alerting on each
 * would turn one change into an email every hour. So a check alerts when it
 * differs from the pinned version and either the previous check against it did
 * not (the page has just moved away), or it also differs from the version last
 * alerted about (it has moved again since). A check showing the same difference
 * is recorded, with its changed areas, but sends nothing. Pinning again starts
 * afresh.
 */
export const PINNED_ALERTS =
  'A check alerts when the page first differs from this version, and again only when it changes from the version you were last alerted about. Checks that still show the same difference are recorded without a new alert.';

/** Added to the refresh line when a capture engine change released a pin. */
export const PIN_RELEASED = 'The pinned baseline was released; pin one again once you have checked the page';

/** Appended to the run detail of a check that differed but sent nothing. */
export const PINNED_REPEAT = 'Unchanged since the last alert against the pinned baseline, so no new alert was sent.';

/** Cached per isolate like watchSettingsReady: a yes for good, a no for a minute. */
let pinColumn: { ready: boolean; at: number } | undefined;
export async function pinReady(): Promise<boolean> {
  if (pinColumn && (pinColumn.ready || Date.now() - pinColumn.at < 60_000)) return pinColumn.ready;
  // ALTER TABLE ADD COLUMN rewrites the table's CREATE statement, so the column shows there.
  const table = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='watches'").first<{ sql: string }>();
  const ready = /\bbaseline_pinned_at\b/.test(table?.sql ?? '');
  pinColumn = { ready, at: Date.now() };
  return ready;
}

/** A row read with `*` carries the column once it exists; otherwise the probe decides. */
async function assertPinsReady(watch: Pick<WatchRow, 'baseline_pinned_at'>): Promise<void> {
  if (watch.baseline_pinned_at !== undefined || (await pinReady())) return;
  throw new HttpError(503, 'setup_required', 'Pinning a baseline is being set up. Please try again later.');
}

/**
 * The capture a pinned monitor last alerted about, when the check before this
 * one already differed from the pinned baseline — the case where a new check
 * alerts only if it differs from that too. Null when the next difference is
 * news either way: nothing checked against this pin yet, or the last check
 * matched it.
 */
export async function lastAlertWhilePinned(
  watch: Pick<WatchRow, 'id' | 'baseline_capture_id' | 'baseline_pinned_at'>,
): Promise<string | null> {
  if (!watch.baseline_pinned_at || !watch.baseline_capture_id) return null;
  const binds = [watch.id, watch.baseline_capture_id, watch.baseline_pinned_at];
  // rowid breaks ties in insertion order; run ids are random. A fast check
  // with no capture found the page as the last full check left it, so the
  // check before means the full check before.
  const previous = await env.DB.prepare(
    `SELECT changed, detail FROM watch_runs WHERE watch_id = ? AND status = 'done' AND baseline_capture_id = ? AND created_at >= ?
       AND capture_id IS NOT NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(...binds)
    .first<{ changed: number; detail: string | null }>();
  if (!previous || !(previous.changed === 1 || decodeRunChanges(previous.detail).repeat)) return null;
  const alerted = await env.DB.prepare(
    `SELECT capture_id FROM watch_runs WHERE watch_id = ? AND status = 'done' AND changed = 1 AND baseline_capture_id = ?
       AND created_at >= ? AND capture_id IS NOT NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(...binds)
    .first<{ capture_id: string }>();
  return alerted?.capture_id ?? null;
}

/** Why one of a monitor's own captures cannot be pinned. */
export type PinRefusal = 'files_gone' | 'outdated';

/**
 * pinBaseline's rules on the capture itself, as a reason rather than an error,
 * for callers with nobody to show an error to: a client's approval pins this
 * way (approval-baseline.ts) and must not fail because of it. Null when it can
 * be pinned. Whether the capture is this monitor's is the caller's question.
 */
export function pinRefusal(capture: Pick<CaptureRow, 'status' | 'files' | 'device'> | null): PinRefusal | null {
  // A capture whose files are gone cannot be compared against.
  if (!capture || capture.status !== 'done' || !safeParseFiles(capture.files).length) return 'files_gone';
  // The next check would replace it rather than compare (see capture-engine),
  // so a pin on it would be released straight away.
  if (shouldRefreshBaseline(capture)) return 'outdated';
  return null;
}

/**
 * Pins the current baseline, or one of this monitor's earlier captures: the
 * baseline itself, or one a check took or compared against. A capture whose
 * files are gone cannot be compared against, so it cannot be pinned.
 *
 * updated_at is left alone. It is half of the claim marker (checkInProgress),
 * and pinning must not make a check that is running look finished.
 */
export async function pinBaseline(watch: WatchRow, userId: string, captureId?: string): Promise<void> {
  if (watch.user_id !== userId) throw new HttpError(404, 'not_found', 'No such watch.');
  await assertPinsReady(watch);
  const id = captureId?.trim() || watch.baseline_capture_id;
  if (!id) throw new HttpError(409, 'no_baseline', 'This monitor has no baseline yet. Run a check first.');
  if (id.length > 64) throw badRequest('`capture_id` is not a capture of this monitor.', 'capture_id');

  const capture = await env.DB.prepare(`SELECT * FROM captures WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<CaptureRow>();
  const ours =
    id === watch.baseline_capture_id ||
    Boolean(
      await env.DB.prepare(
        `SELECT 1 FROM watch_runs WHERE watch_id = ? AND user_id = ? AND (capture_id = ? OR baseline_capture_id = ?) LIMIT 1`,
      )
        .bind(watch.id, userId, id, id)
        .first(),
    );
  // The same answer for someone else's capture and another monitor's, so neither can be probed.
  if (!capture || !ours) throw new HttpError(404, 'not_found', 'No such capture on this monitor.');
  const refusal = pinRefusal(capture);
  if (refusal === 'files_gone') {
    throw badRequest('That screenshot is no longer available. Choose a more recent check.', 'capture_id');
  }
  if (refusal === 'outdated') {
    throw new HttpError(
      409,
      'baseline_outdated',
      'That screenshot was taken before a capture engine update, so later checks cannot be compared with it fairly. Pin a check taken since.',
      'capture_id',
    );
  }

  await env.DB.prepare(`UPDATE watches SET baseline_capture_id = ?, baseline_pinned_at = ? WHERE id = ? AND user_id = ?`)
    .bind(id, new Date().toISOString(), watch.id, userId)
    .run();
}

/** Back to comparing each check with the one before. The pinned capture stays the baseline until the next check. */
export async function unpinBaseline(watch: WatchRow, userId: string): Promise<void> {
  if (watch.user_id !== userId) throw new HttpError(404, 'not_found', 'No such watch.');
  await assertPinsReady(watch);
  await env.DB.prepare(`UPDATE watches SET baseline_pinned_at = NULL WHERE id = ? AND user_id = ?`)
    .bind(watch.id, userId)
    .run();
}
