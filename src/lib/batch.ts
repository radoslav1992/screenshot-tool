import type { SessionUser } from './auth';
import { createCaptureRow, getUsage, runCapture, toDTO, type CaptureDTO } from './captures';
import { assertPublicCaptureUrl, parseCaptureOptions, plannedShots, type CaptureOptions } from './capture-options';
import { HttpError, badRequest } from './http';
import { MAX_BACKGROUND_BATCH, getPlan } from './plans';
import { parseSitemap } from './sitemap';

/**
 * Many pages in one request.
 *
 * "Archive the site before the redesign" is a real, recurring job, and doing it
 * one capture at a time is the reason people write scripts around screenshot
 * APIs instead of using them.
 */

/** Bounded per request. Beyond this it is a crawl, and a crawl needs a queue. */
export const MAX_BATCH = 25;

export interface BatchResult {
  requested: number;
  captures: CaptureDTO[];
  failed: Array<{ url: string; error: string }>;
}

/** http→https, then apex→www, then a CDN's own hop: past that it is a loop. */
const MAX_SITEMAP_REDIRECTS = 3;

/**
 * Fetches a sitemap, following redirects one hop at a time.
 *
 * Sites routinely send `/sitemap.xml` from http to https or from the apex to
 * www, so refusing every redirect refused most real sitemaps. Letting fetch
 * follow them would not do either: each destination has to pass the same
 * public-address check the first URL did, or a redirect becomes the way to a
 * private one.
 */
async function fetchSitemap(raw: string): Promise<string> {
  let url = assertPublicCaptureUrl(raw);
  let response: Response;
  for (let hop = 0; ; hop++) {
    try {
      response = await fetch(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'EasyScreenCapture/1 (+https://easyscreencapture.com)' },
      });
    } catch (error) {
      // DNS failures, refused connections and the timeout all land here, and
      // all of them are about the address given, not about this service.
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new HttpError(
        400,
        'sitemap_unreachable',
        timedOut ? 'The sitemap took too long to answer.' : 'The sitemap could not be reached.',
      );
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_SITEMAP_REDIRECTS) {
      throw new HttpError(400, 'sitemap_unreachable', 'The sitemap redirected too many times.');
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new HttpError(400, 'sitemap_unreachable', 'The sitemap redirected to an address that is not a URL.');
    }
    try {
      url = assertPublicCaptureUrl(next.toString());
    } catch {
      throw new HttpError(400, 'sitemap_unreachable', 'The sitemap redirected to an address that cannot be fetched.');
    }
  }
  if (!response.ok) throw new HttpError(400, 'sitemap_unreachable', `The sitemap answered ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw badRequest('The sitemap was empty.');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000)
        throw badRequest('Sitemaps must be smaller than 2 MB. Use a smaller sitemap or paste page URLs.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // The timeout covers the body too; a stalled or dropped download ends here.
    throw new HttpError(400, 'sitemap_unreachable', 'The sitemap stopped answering partway through.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Resolves a sitemap URL to a bounded list of page URLs: at most `limit`, which
 * a synchronous batch passes as MAX_BATCH and a background one as its plan's
 * batch size.
 *
 * The sitemap address itself goes through the same validation a capture does,
 * so this cannot be used to make the Worker fetch a private address — and every
 * URL it yields is validated again before it is captured.
 */
export async function urlsFromSitemap(sitemapUrl: string, limit: number): Promise<string[]> {
  const first = parseSitemap(await fetchSitemap(sitemapUrl));
  if (first.pages.length) return [...new Set(first.pages)].slice(0, Math.min(MAX_BACKGROUND_BATCH, limit));

  const pages: string[] = [];
  for (const index of first.indexes.slice(0, 5)) {
    if (pages.length >= limit) break;
    try {
      pages.push(...parseSitemap(await fetchSitemap(index)).pages);
    } catch {
      // One unreadable child sitemap should not lose the others.
    }
  }
  return [...new Set(pages)].slice(0, Math.min(MAX_BACKGROUND_BATCH, limit));
}

export async function runBatch(
  user: SessionUser,
  urls: string[],
  shared: Record<string, string>,
  origin: string,
  source: 'app' | 'api',
): Promise<BatchResult> {
  if (!urls.length) throw badRequest('No URLs to capture.', 'urls');
  if (urls.length > MAX_BATCH) {
    throw badRequest(`A batch takes at most ${MAX_BATCH} URLs.`, 'urls');
  }

  const result: BatchResult = { requested: urls.length, captures: [], failed: [] };

  /*
   * Everything is parsed before anything is captured. Two reasons: a batch with
   * one malformed URL should say so immediately rather than after spending
   * quota on the others, and the real cost cannot be known until it is — with
   * `sizes` set, each URL is several screenshots, so counting URLs would let a
   * batch overrun the quota it was checked against.
   */
  const jobs: Array<{ url: string; options: CaptureOptions }> = [];
  for (const url of urls) {
    try {
      jobs.push({ url, options: parseCaptureOptions({ ...shared, url }) });
    } catch (error) {
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const shots = jobs.reduce((total, job) => total + plannedShots(job.options), 0);
  const usage = await getUsage(user);
  if (shots > usage.remaining) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `That batch needs ${shots} screenshot${shots === 1 ? '' : 's'} and you have ${usage.remaining} left on the ${getPlan(user.plan).name} plan this month.`,
    );
  }

  // Sequential. Each capture holds a browser session, and the session pool is
  // the scarce resource — a parallel batch would starve everyone else's
  // captures to finish this one sooner.
  for (const { url, options } of jobs) {
    try {
      const row = await runCapture(await createCaptureRow(user, options, source), options);
      if (row.status === 'done') result.captures.push(toDTO(row, origin));
      else result.failed.push({ url, error: row.error ?? 'the capture failed' });
    } catch (error) {
      // A quota that runs out mid-batch, or a page that will not load, stops
      // that URL rather than the batch.
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
