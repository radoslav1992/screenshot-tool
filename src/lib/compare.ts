import type { SessionUser } from './auth';
import {
  assertPlanAllows,
  createCaptureRow,
  discardCaptureRow,
  getUsage,
  runCapture,
  safeParseFiles,
  toDTO,
  type CaptureDTO,
  type CaptureRow,
  type CaptureSource,
} from './captures';
import { fileUrl } from './captures';
import { plannedShots, type CaptureOptions } from './capture-options';
import { HttpError, badRequest } from './http';
import { getPlan } from './plans';
import { compareImages, diffAvailable } from './visual-diff';

/**
 * Two pages, side by side, with the difference measured.
 *
 * The engine is the one watches already use; what is new is pointing it at two
 * addresses at the same moment rather than at one address across time. Staging
 * against production, a page before and after a deploy, your pricing against a
 * competitor's — the question is the same shape and nobody else in this market
 * answers it.
 */

export interface CompareResult {
  before: CaptureDTO;
  after: CaptureDTO;
  /** Null when the deployment cannot diff, or when a capture failed. */
  change_pct: number | null;
  resized: boolean | null;
  identical: boolean | null;
  detail?: string;
}

/**
 * Parameters that are never shared between the two sides.
 *
 * Staging and production rarely take the same password, and two different
 * sites never should: a credential written once would otherwise go to both,
 * including the competitor's page being compared against.
 */
const PER_SIDE_ONLY = ['headers', 'cookies', 'basic_auth'];

/**
 * Splits a comparison request into its two captures. Each side takes the same
 * parameters as a capture, prefixed `a_` and `b_`; anything unprefixed applies
 * to both — except credentials, which must name their side.
 */
export function splitCompareInput(body: Record<string, string>): {
  before: Record<string, string>;
  after: Record<string, string>;
} {
  for (const key of PER_SIDE_ONLY) {
    if ((body[key] ?? '').trim()) {
      throw badRequest(
        `\`${key}\` is not shared between the two pages. Send \`a_${key}\` and/or \`b_${key}\` for the page it belongs to.`,
        key,
      );
    }
  }

  const shared: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('a_') && !key.startsWith('b_')) shared[key] = value;
  }
  const side = (prefix: 'a_' | 'b_'): Record<string, string> => {
    const out = { ...shared };
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith(prefix)) out[key.slice(2)] = value;
    }
    return out;
  };

  const before = side('a_');
  const after = side('b_');
  if (!before.url && !before.html) throw badRequest('`a_url` is required.', 'a_url');
  if (!after.url && !after.html) throw badRequest('`b_url` is required.', 'b_url');
  return { before, after };
}

export async function compareCaptures(
  user: SessionUser,
  before: CaptureOptions,
  after: CaptureOptions,
  origin: string,
  source: CaptureSource = 'app',
): Promise<CompareResult> {
  // Only the first file of each side is compared; extra sizes would be paid
  // for and never looked at.
  if (before.sizes.length || after.sizes.length) {
    throw badRequest('`sizes` is not available in a comparison: each side is one image.', 'sizes');
  }

  /*
   * Everything that could refuse the second capture is asked before the first
   * is rendered. Otherwise a plan or quota refusal for one side arrives after
   * the other has been rendered and charged, and the comparison is lost anyway.
   */
  assertPlanAllows(user, before);
  assertPlanAllows(user, after);

  const usage = await getUsage(user);
  const shots = plannedShots(before) + plannedShots(after);
  if (usage.remaining < shots) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `A comparison takes two screenshots and you have ${usage.remaining} left on the ${getPlan(user.plan).name} plan this month.`,
    );
  }

  // Both rows reserve their quota before either renders; if the second cannot,
  // the first is taken back.
  const beforePending = await createCaptureRow(user, before, source);
  let afterPending: CaptureRow;
  try {
    afterPending = await createCaptureRow(user, after, source);
  } catch (error) {
    await discardCaptureRow(beforePending);
    throw error;
  }

  // Sequential, not parallel: two browsers at once doubles this account's draw
  // on the session pool, and the pool is the scarce thing.
  const beforeRow = await runCapture(beforePending, before);
  const afterRow = await runCapture(afterPending, after);

  const result: CompareResult = {
    before: toDTO(beforeRow, origin),
    after: toDTO(afterRow, origin),
    change_pct: null,
    resized: null,
    identical: null,
  };

  if (beforeRow.status !== 'done' || afterRow.status !== 'done') {
    result.detail = 'one of the captures failed, so there was nothing to compare';
    return result;
  }
  if (!diffAvailable()) {
    result.detail = 'this deployment has no rendering binding, so pages cannot be compared';
    return result;
  }

  const beforeFile = safeParseFiles(beforeRow.files)[0];
  const afterFile = safeParseFiles(afterRow.files)[0];
  if (!beforeFile || !afterFile) {
    result.detail = 'a capture produced no comparable file';
    return result;
  }

  try {
    const diff = await compareImages(
      fileUrl(beforeRow, beforeFile, origin),
      fileUrl(afterRow, afterFile, origin),
    );
    result.change_pct = diff.changedPct;
    result.resized = diff.resized;
    result.identical = !diff.resized && diff.changedPct === 0;
  } catch (error) {
    result.detail = `could not compare: ${error instanceof Error ? error.message : String(error)}`;
  }

  return result;
}
