import type { APIRoute } from 'astro';
import { parseCaptureOptions } from '../../../lib/capture-options';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { FREQUENCIES } from '../../../lib/plans';
import { createWatch, listWatches, toWatchDTO } from '../../../lib/watches';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const rows = await listWatches(user.id);
  return json({ data: rows.map(toWatchDTO) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    const body = await readBody(request);

    /*
     * The capture side is parsed by the same function the app and API use, so a
     * watch cannot be pointed anywhere a one-off capture could not go — the SSRF
     * and denylist checks come along with it.
     */
    const options = parseCaptureOptions({ ...body, mode: body.mode ?? 'fullpage' });

    if (options.mode === 'series') {
      throw badRequest('A scroll series has no single frame to compare, so it cannot be watched.', 'mode');
    }
    if (options.format === 'pdf') {
      throw badRequest('Watches compare images. Choose PNG or JPG.', 'format');
    }

    const frequency = (body.frequency ?? 'daily').toLowerCase();
    if (!FREQUENCIES.some((entry) => entry.id === frequency)) {
      throw badRequest('`frequency` must be one of: hourly, daily, weekly.', 'frequency');
    }

    const threshold = body.threshold === undefined || body.threshold === '' ? 1 : Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 100) {
      throw badRequest('`threshold` is a percentage between 0.1 and 100.', 'threshold');
    }

    const webhookUrl = (body.webhook_url ?? '').trim();
    if (webhookUrl && !/^https:\/\/\S+$/i.test(webhookUrl)) {
      throw badRequest('A webhook URL must start with https://.', 'webhook_url');
    }

    const watch = await createWatch(user, {
      options,
      label: (body.label ?? '').trim(),
      frequency,
      threshold,
      notifyEmail: body.notify_email !== '0' && body.notify_email !== 'false',
      webhookUrl: webhookUrl || null,
    });

    return json(toWatchDTO(watch), { status: 201 });
  } catch (error) {
    return toHttpError(error, 'watches.create', 'The watch could not be created.').toResponse();
  }
};
