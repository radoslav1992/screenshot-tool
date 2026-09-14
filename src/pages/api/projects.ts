import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, readBody, json } from '../../lib/http';
import { toHttpError } from '../../lib/errors';
import { assertVerified } from '../../lib/verification';
import { projectAction, requireProjects } from '../../lib/projects';
import { checkRateLimit } from '../../lib/rate-limit';
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    await requireProjects();
    const rate = await checkRateLimit(`projects:${locals.user.id}`, 120, 3600);
    if (!rate.ok) throw new HttpError(429, 'rate_limited', 'Too many updates. Try again later.');
    return json(await projectAction(locals.user.id, await readBody(request), new URL(request.url).origin), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return toHttpError(error, 'projects.update', 'Could not update the project.').toResponse();
  }
};
