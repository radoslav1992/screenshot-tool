import type { SessionUser } from './auth';
import {
  createCaptureRow,
  getUsage,
  runCapture,
  safeParseFiles,
  toDTO,
  type CaptureDTO,
  type CaptureSource,
} from './captures';
import { fileUrl } from './captures';
import type { CaptureOptions } from './capture-options';
import { HttpError } from './http';
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

export async function compareCaptures(
  user: SessionUser,
  before: CaptureOptions,
  after: CaptureOptions,
  origin: string,
  source: CaptureSource = 'app',
): Promise<CompareResult> {
  const usage = await getUsage(user);
  if (usage.remaining < 2) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `A comparison takes two screenshots and you have ${usage.remaining} left on the ${getPlan(user.plan).name} plan this month.`,
    );
  }

  // Sequential, not parallel: two browsers at once doubles this account's draw
  // on the session pool, and the pool is the scarce thing.
  const beforeRow = await runCapture(await createCaptureRow(user, before, source), before);
  const afterRow = await runCapture(await createCaptureRow(user, after, source), after);

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
