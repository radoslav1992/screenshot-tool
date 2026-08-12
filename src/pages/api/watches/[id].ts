import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { deleteWatch, getWatch, listRuns, runWatch, setWatchStatus, toWatchDTO } from '../../../lib/watches';

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

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    const watch = await owned(params.id, user.id);
    return json({ ...toWatchDTO(watch), runs: await listRuns(watch.id) });
  } catch (error) {
    return toHttpError(error, 'watches.get', 'Could not load that watch.').toResponse();
  }
};

/** Pause, resume, or run one now. */
export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    const watch = await owned(params.id, user.id);
    const action = (await readBody(request)).action ?? '';

    if (action === 'pause' || action === 'resume') {
      await setWatchStatus(watch.id, action === 'pause' ? 'paused' : 'active');
      const updated = await getWatch(watch.id);
      return json(toWatchDTO(updated!));
    }

    if (action === 'run') {
      // Checking now spends a capture from the quota exactly as a scheduled run
      // does, and is the only way to see the feature work without waiting.
      const outcome = await runWatch(watch, new URL(request.url).origin);
      const updated = await getWatch(watch.id);
      return json({ ...toWatchDTO(updated!), outcome });
    }

    throw badRequest('`action` must be one of: pause, resume, run.', 'action');
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
