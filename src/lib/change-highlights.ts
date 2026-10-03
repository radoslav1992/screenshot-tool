import { env } from 'cloudflare:workers';
import { decodeRunChanges } from './monitor-health';
import type { ChangeRegion } from './visual-diff-fn';

export type { ChangeRegion };

/**
 * The highlighted copy of a monitor check: the "after" image, downscaled, with
 * the changed areas boxed in orange.
 *
 * It lives in R2 beside the capture's own files and is served by the same token
 * URL, but it is not in the capture's `files`. Those are what the API lists as
 * `images` — what the app downloads, saves and shares as the screenshot — and
 * a picture we drew over is not a screenshot of the page. Its key follows from
 * the capture, so whatever deletes the capture can delete it too: account
 * deletion takes the whole prefix, and deleteCapture and the retention sweep
 * name it for every monitor capture.
 */
export const HIGHLIGHT_NAME = 'changes.jpg';

/** No highlight is drawn larger than this (see HIGHLIGHT_LIMITS), so anything bigger is refused. */
const MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024;

export function highlightFile(row: { id: string; user_id: string }) {
  return {
    key: `captures/${row.user_id}/${row.id}/${HIGHLIGHT_NAME}`,
    name: HIGHLIGHT_NAME,
    contentType: 'image/jpeg',
  };
}

/** The token URL, built exactly as `fileUrl` builds a capture file's. */
export function highlightUrl(row: { id: string; share_token: string }, origin: string): string {
  return `${origin}/f/${row.id}/${HIGHLIGHT_NAME}?t=${row.share_token}`;
}

/**
 * Stores the highlight a comparison drew. Best effort: a check that cannot
 * store it still records and announces its change, just without the picture.
 */
export async function storeHighlight(row: { id: string; user_id: string }, dataUrl: string | undefined): Promise<boolean> {
  const encoded = dataUrl?.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/)?.[1];
  if (!encoded) return false;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_HIGHLIGHT_BYTES) return false;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    await env.SHOTS.put(highlightFile(row).key, bytes, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { captureId: row.id, userId: row.user_id, role: 'highlight' },
    });
    return true;
  } catch (error) {
    console.error('[watch] could not store the change highlight', error);
    return false;
  }
}

/** "3 changed areas", for alerts and screens. */
export function changedAreas(regions: ChangeRegion[]): string {
  return `${regions.length} changed ${regions.length === 1 ? 'area' : 'areas'}`;
}

/**
 * API runs with `highlight_url`, the token URL of the highlight when the run
 * stored one and its capture is still there. One query for the whole page of
 * runs; the internal `highlight` flag is not part of the response.
 */
export async function withHighlightUrls<T extends { capture_id: string | null; highlight: boolean }>(
  runs: T[],
  userId: string,
  origin: string,
): Promise<Array<Omit<T, 'highlight'> & { highlight_url: string | null }>> {
  const ids = [...new Set(runs.filter((run) => run.highlight && run.capture_id).map((run) => run.capture_id!))];
  const tokens = new Map<string, string>();
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, share_token FROM captures WHERE user_id = ? AND status = 'done' AND id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(userId, ...ids)
      .all<{ id: string; share_token: string }>();
    for (const row of results ?? []) tokens.set(row.id, row.share_token);
  }
  return runs.map(({ highlight, ...run }) => {
    const token = highlight && run.capture_id ? tokens.get(run.capture_id) : undefined;
    return { ...run, highlight_url: token ? highlightUrl({ id: run.capture_id!, share_token: token }, origin) : null };
  });
}

/**
 * The changed areas a review report can draw over its "after" images: for each
 * pair, those of the monitor run that compared exactly those two captures.
 */
export async function reportRegions(
  userId: string,
  pairs: Array<{ before: string | null; after: string | null }>,
): Promise<Map<string, ChangeRegion[]>> {
  const found = new Map<string, ChangeRegion[]>();
  const wanted = pairs.filter((pair) => pair.before && pair.after);
  if (!wanted.length) return found;
  const { results } = await env.DB.prepare(
    `SELECT capture_id, baseline_capture_id, detail FROM watch_runs
     WHERE user_id = ? AND status = 'done' AND capture_id IN (${wanted.map(() => '?').join(',')})`,
  )
    .bind(userId, ...wanted.map((pair) => pair.after))
    .all<{ capture_id: string; baseline_capture_id: string | null; detail: string | null }>();
  for (const pair of wanted) {
    const run = (results ?? []).find((row) => row.capture_id === pair.after && row.baseline_capture_id === pair.before);
    const regions = run ? decodeRunChanges(run.detail).regions : [];
    if (regions.length) found.set(`${pair.before}:${pair.after}`, regions);
  }
  return found;
}
