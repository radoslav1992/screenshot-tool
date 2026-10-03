import { assertVerified } from '../../../lib/verification';
import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import {
  assertCanResume,
  deleteWatch,
  getWatch,
  listRuns,
  runWatchNow,
  setWatchAlerts,
  setWatchStatus,
  setWatchFrequency,
  setWatchThreshold,
  toWatchDTO,
} from '../../../lib/watches';
import { pinBaseline, unpinBaseline } from '../../../lib/baseline-pin';
import { withHighlightUrls } from '../../../lib/change-highlights';

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

export const GET: APIRoute = async ({ params, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    const watch = await owned(params.id, user.id);
    // Each run also carries `regions` and `highlight_url`, both additive.
    return json({ ...toWatchDTO(watch), runs: await withHighlightUrls(await listRuns(watch.id), user.id, url.origin) });
  } catch (error) {
    return toHttpError(error, 'watches.get', 'Could not load that watch.').toResponse();
  }
};

/** Pause, resume, run one now, pin or unpin its baseline, or change its schedule, sensitivity or alert channels. */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const watch = await owned(params.id, user.id);
    const body = await readBody(request);
    const action = body.action ?? '';
    if (['schedule', 'threshold', 'alerts', 'resume', 'run', 'pin', 'unpin'].includes(action)) await assertVerified(user);
    if (action === 'threshold') {
      await setWatchThreshold(watch, user, body.threshold ?? '');
      return json(toWatchDTO((await getWatch(watch.id))!));
    }
    if (action === 'schedule') {
      await setWatchFrequency(watch, user, body.frequency ?? '');
      return json(toWatchDTO((await getWatch(watch.id))!));
    }
    if (action === 'alerts') {
      await setWatchAlerts(watch, user, body);
      return json(toWatchDTO((await getWatch(watch.id))!));
    }
    // `capture_id` pins one of this monitor's earlier captures; without it, the current baseline.
    if (action === 'pin' || action === 'unpin') {
      if (action === 'pin') await pinBaseline(watch, user.id, body.capture_id);
      else await unpinBaseline(watch, user.id);
      return json(toWatchDTO((await getWatch(watch.id))!));
    }

    if (action === 'resume') await assertCanResume(watch, user);
    if (action === 'pause' || action === 'resume') {
      await setWatchStatus(watch.id, action === 'pause' ? 'paused' : 'active');
      const updated = await getWatch(watch.id);
      return json(toWatchDTO(updated!));
    }

    if (action === 'run') {
      // Checking now spends a capture from the quota exactly as a scheduled run
      // does, and is the only way to see the feature work without waiting.
      const outcome = await runWatchNow(watch, new URL(request.url).origin);
      const updated = await getWatch(watch.id);
      return json({ ...toWatchDTO(updated!), outcome });
    }

    throw badRequest('`action` must be one of: pause, resume, run, schedule, threshold, alerts, pin, unpin.', 'action');
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
