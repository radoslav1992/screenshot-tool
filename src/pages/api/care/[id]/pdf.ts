import type { APIRoute } from 'astro';
import { HttpError, assertSameOrigin } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { assertVerified } from '../../../../lib/verification';
import { checkRateLimit } from '../../../../lib/rate-limit';
import { CARE_REPORT_PLANS, ownCareReport, requireCare } from '../../../../lib/care-reports';
import { CARE_LIMITS } from '../../../../lib/care-rules';
import { careReportsIncluded } from '../../../../lib/plans';
import { carePdf } from '../../../../lib/care-pdf';
export const prerender = false;
/** POST /api/care/:id/pdf — the owner's PDF of a care report, a form post like the review report's. */
export const POST: APIRoute = async ({ params, locals, request }) => {
  try {
    await requireCare();
    if (!locals.user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
    assertSameOrigin(request);
    await assertVerified(locals.user);
    const { project, report, snapshot } = await ownCareReport(locals.user.id, params.id ?? '');
    if (!careReportsIncluded(locals.user.plan))
      throw new HttpError(403, 'plan_required', `Care report PDFs are included on ${CARE_REPORT_PLANS}.`);
    const { limit, windowSeconds } = CARE_LIMITS.pdf;
    if (!(await checkRateLimit(`care-pdf:${locals.user.id}`, limit, windowSeconds)).ok)
      throw new HttpError(429, 'rate_limited', `You can export up to ${limit} care report PDFs an hour. Try again later.`);
    return new Response((await carePdf(project, snapshot)) as unknown as BodyInit, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="care-report-${report.period}.pdf"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return toHttpError(error, 'care.pdf', 'Could not export this care report.').toResponse();
  }
};
