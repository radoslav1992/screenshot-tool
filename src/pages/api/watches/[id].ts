import { assertVerified } from '../../../lib/verification';
import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import {
  assertCanResume,
  deleteWatch,
  getWatch,
  listRuns,
  retryFastChecks,
  runWatchNow,
  setCheckMode,
  setWatchAlerts,
  setWatchStatus,
  setWatchFrequency,
  setWatchThreshold,
  watchDTO,
} from '../../../lib/watches';
import { pinBaseline, unpinBaseline } from '../../../lib/baseline-pin';
import { withHighlightUrls } from '../../../lib/change-highlights';
import { approvalProvenance, provenanceDTO } from '../../../lib/approval-baseline';

export const prerender = false;

/** Loads a watch and refuses it unless it belongs to the caller. */
async function owned(id: string | undefined, userId: string) {
  const watch = id ? await getWatch(id) : null;
  // Same answer for "does not exist" and "is not yours", so the ids of other
  // people's watches cannot be probed.
  if (!watch || watch.user_id !== userId) {
    throw new HttpError(404, 'not_found', 'No such watch.');
  }
  return watch;
}

/** The monitor as it is now, which is what every action answers with. */
async function current(id: string) {
  return watchDTO((await getWatch(id))!);
}

export const GET: APIRoute = async ({ params, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    const watch = await owned(params.id, user.id);
    // Each run also carries `regions` and `highlight_url`, both additive. So is
    // `pinned_by_approval`, present only while a client's approval made the
    // pinned baseline and nobody has pinned or unpinned since.
    const [dto, runs, approval] = await Promise.all([
      watchDTO(watch),
      listRuns(watch.id).then((rows) => withHighlightUrls(rows, user.id, url.origin)),
      approvalProvenance(watch),
    ]);
    return json({ ...dto, ...(approval ? { pinned_by_approval: provenanceDTO(approval) } : {}), runs });
  } catch (error) {
    return toHttpError(error, 'watches.get', 'Could not load that watch.').toResponse();
  }
};

/**
 * Pause, resume, run one now, pin or unpin its baseline, change its schedule,
 * sensitivity or alert channels, or choose how it is checked: `check_mode`
 * with `force_browser` 1 or 0 for "Always use a full browser", and
 * `retry_fast` to try fast checks again.
 */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const watch = await owned(params.id, user.id);
    const body = await readBody(request);
    const action = body.action ?? '';
    if (['schedule', 'threshold', 'alerts', 'resume', 'run', 'pin', 'unpin', 'check_mode', 'retry_fast'].includes(action)) {
      await assertVerified(user);
    }
    if (action === 'threshold') {
      await setWatchThreshold(watch, user, body.threshold ?? '');
      return json(await current(watch.id));
    }
    if (action === 'schedule') {
      await setWatchFrequency(watch, user, body.frequency ?? '');
      return json(await current(watch.id));
    }
    if (action === 'alerts') {
      await setWatchAlerts(watch, user, body);
      return json(await current(watch.id));
    }
    // `capture_id` pins one of this monitor's earlier captures; without it, the current baseline.
    if (action === 'pin' || action === 'unpin') {
      if (action === 'pin') await pinBaseline(watch, user.id, body.capture_id);
      else await unpinBaseline(watch, user.id);
      return json(await current(watch.id));
    }
    if (action === 'check_mode') {
      const value = (body.force_browser ?? '').trim().toLowerCase();
      if (!['1', '0', 'true', 'false', 'on', 'off'].includes(value)) {
        throw badRequest('`force_browser` must be 1 to always use a full browser, or 0 to check smartly.', 'force_browser');
      }
      await setCheckMode(watch, user, ['1', 'true', 'on'].includes(value));
      return json(await current(watch.id));
    }
    if (action === 'retry_fast') {
      await retryFastChecks(watch, user);
      return json(await current(watch.id));
    }

    if (action === 'resume') await assertCanResume(watch, user);
    if (action === 'pause' || action === 'resume') {
      await setWatchStatus(watch.id, action === 'pause' ? 'paused' : 'active');
      return json(await current(watch.id));
    }

    if (action === 'run') {
      // Checking now spends a screenshot when it renders, exactly as a scheduled
      // run does — a fast check that finds nothing changed spends none — and is
      // the only way to see the feature work without waiting.
      const outcome = await runWatchNow(watch, new URL(request.url).origin);
      return json({ ...(await current(watch.id)), outcome });
    }

    throw badRequest(
      '`action` must be one of: pause, resume, run, schedule, threshold, alerts, pin, unpin, check_mode, retry_fast.',
      'action',
    );
  } catch (error) {
    return toHttpError(error, 'watches.update', 'Could not update that watch.').toResponse();
  }
};

export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const watch = await owned(params.id, user.id);
    await deleteWatch(watch.id);
    return json({ deleted: true, id: watch.id });
  } catch (error) {
    return toHttpError(error, 'watches.delete', 'Could not delete that watch.').toResponse();
  }
};
