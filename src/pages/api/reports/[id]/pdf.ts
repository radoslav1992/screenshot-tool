import type { APIRoute } from 'astro';
import { ownReport, requireProjects } from '../../../../lib/projects';
import { reportPdf } from '../../../../lib/report-pdf';
import { HttpError, assertSameOrigin } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { assertVerified } from '../../../../lib/verification';
import { getPlan } from '../../../../lib/plans';
import { checkRateLimit } from '../../../../lib/rate-limit';
export const prerender = false;
export const POST: APIRoute = async ({ params, locals, request }) => {
  try {
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    await requireProjects();
    const { project, report } = await ownReport(locals.user.id, params.id!);
    if (!getPlan(locals.user.plan).formats.includes('pdf'))
      throw new HttpError(403, 'plan_required', 'PDF export is available on paid plans.');
    if (!(await checkRateLimit(`report-pdf:${locals.user.id}`, 6, 3600)).ok)
      throw new HttpError(429, 'rate_limited', 'You can export up to six PDFs per hour. Try again later.');
    return new Response((await reportPdf(project, report)) as unknown as BodyInit, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="review-${report.id}.pdf"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return toHttpError(error, 'report.pdf', 'Could not export this report.').toResponse();
  }
};
