import type { APIRoute } from 'astro';
import { HttpError } from '../../../lib/http';
import { clientIp, enforceThrottles } from '../../../lib/auth-throttle';
import { sha256Hex } from '../../../lib/ids';
import { loadSessionUser } from '../../../lib/auth';
import { careReportsIncluded } from '../../../lib/plans';
import { sharedCareReport } from '../../../lib/care-reports';
import { CARE_LIMITS } from '../../../lib/care-rules';
import { carePdf } from '../../../lib/care-pdf';
export const prerender = false;
/**
 * GET /care/:token/pdf — the client's PDF of the report their link opens. The
 * link is the credential, checked exactly as the page checks it, and every
 * refusal is the page's neutral 404. A few an hour per link and per address,
 * since each one starts a browser, and only while the owner's plan includes
 * care reports, as for the owner's own PDF.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const token = params.token ?? '';
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };
  const unavailable = () => new Response('This report link is unavailable.', { status: 404, headers });
  if (!/^[a-f0-9]{64}$/.test(token)) return unavailable();
  try {
    const { report, project, snapshot } = await sharedCareReport(token);
    const owner = await loadSessionUser(project.user_id);
    if (!owner || !careReportsIncluded(owner.plan)) return unavailable();
    try {
      await enforceThrottles(
        [
          { bucket: `care-pdf-link:${(await sha256Hex(token)).slice(0, 32)}`, ...CARE_LIMITS.publicPdfLink },
          { bucket: `care-pdf-ip:${clientIp(request)}`, ...CARE_LIMITS.publicPdfIp },
        ],
        (wait) => `Too many downloads. Try again in ${wait}.`,
      );
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Too many downloads.', { status: 429, headers });
    }
    return new Response((await carePdf(project, snapshot)) as unknown as BodyInit, {
      headers: {
        ...headers,
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="website-care-${report.period}.pdf"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return unavailable();
    console.error('[care] public pdf failed', error);
    return new Response('The PDF could not be made just now. Try again later.', { status: 503, headers });
  }
};
