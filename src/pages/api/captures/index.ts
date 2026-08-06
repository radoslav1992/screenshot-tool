import type { APIRoute } from 'astro';
import { parseCaptureOptions } from '../../../lib/capture-options';
import { createCaptureRow, listCaptures, runCapture, toDTO } from '../../../lib/captures';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { APP_RATE_LIMIT, getPlan } from '../../../lib/plans';
import { checkRateLimit } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const rows = await listCaptures(user.id, {
    mode: url.searchParams.get('mode') ?? undefined,
    limit: Number.parseInt(url.searchParams.get('limit') ?? '30', 10),
    cursor: url.searchParams.get('cursor') ?? undefined,
  });

  return json({ data: rows.map((row) => toDTO(row, new URL(request.url).origin)) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    // The monthly quota bounds the total; this bounds the burst, so one account
    // cannot spend its allowance at once and monopolise the render pool.
    const limit = APP_RATE_LIMIT[user.plan] ?? APP_RATE_LIMIT.free;
    const rate = await checkRateLimit(`app:${user.id}`, limit, 3600);
    if (!rate.ok) {
      const minutes = Math.max(1, Math.ceil(rate.resetSeconds / 60));
      throw new HttpError(
        429,
        'rate_limited',
        `You can start ${limit} captures per hour on the ${getPlan(user.plan).name} plan. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    const options = parseCaptureOptions(await readBody(request));
    const row = await createCaptureRow(user, options, 'app');
    const finished = await runCapture(row, options);
    return json(toDTO(finished, new URL(request.url).origin), { status: finished.status === 'done' ? 201 : 200 });
  } catch (error) {
    return toHttpError(error, 'captures.create', 'The capture could not be started.').toResponse();
  }
};
