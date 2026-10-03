import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin, badRequest, json } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { projectAccess } from '../../../lib/collaboration';
import { brandingAction } from '../../../lib/branding';
import { LOGO_MAX_BYTES } from '../../../lib/branding-rules';
import { checkRateLimit } from '../../../lib/rate-limit';
export const prerender = false;
/**
 * POST /api/projects/branding — a project's report logo, accent and footer.
 * Multipart, because the logo arrives as a file and readBody would flatten it
 * to text. Owners and editors only; see lib/branding.ts.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    // The multipart envelope adds a little; anything far past the logo limit is refused unread.
    if (Number(request.headers.get('content-length') ?? 0) > LOGO_MAX_BYTES + 64 * 1024)
      throw new HttpError(413, 'logo_too_large', 'Logos can be up to 512 KB. Export a smaller PNG, JPEG or WebP.', 'logo');
    if (!(await checkRateLimit(`branding:${locals.user.id}`, 30, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'Too many branding updates. Try again later.');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest('Could not parse the request body.');
    }
    const projectId = form.get('project_id');
    const access = await projectAccess(locals.user.id, typeof projectId === 'string' ? projectId : '');
    return json(await brandingAction(access, form), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return toHttpError(error, 'branding.update', 'Could not save the report branding.').toResponse();
  }
};
