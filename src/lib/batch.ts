import type { SessionUser } from './auth';
import { createCaptureRow, getUsage, runCapture, toDTO, type CaptureDTO } from './captures';
import { parseCaptureOptions, type CaptureOptions } from './capture-options';
import { HttpError, badRequest } from './http';
import { getPlan } from './plans';
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

async function fetchSitemap(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'EasyScreenCapture/1 (+https://easyscreencapture.com)' },
  });
  if (!response.ok) {
    throw new HttpError(400, 'sitemap_unreachable', `The sitemap answered ${response.status}.`);
  }
  const text = await response.text();
  // A sitemap can be enormous; only the first entries are ever used.
  return text.slice(0, 2_000_000);
}

/**
 * Resolves a sitemap URL to a bounded list of page URLs.
 *
 * The sitemap address itself goes through the same validation a capture does,
 * so this cannot be used to make the Worker fetch a private address — and every
 * URL it yields is validated again before it is captured.
 */
export async function urlsFromSitemap(sitemapUrl: string, limit: number): Promise<string[]> {
  const first = parseSitemap(await fetchSitemap(sitemapUrl));
  if (first.pages.length) return first.pages.slice(0, limit);

  const pages: string[] = [];
  for (const index of first.indexes.slice(0, 5)) {
    if (pages.length >= limit) break;
    try {
      pages.push(...parseSitemap(await fetchSitemap(index)).pages);
    } catch {
      // One unreadable child sitemap should not lose the others.
    }
  }
  return pages.slice(0, limit);
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

  const usage = await getUsage(user);
  if (usage.remaining < urls.length) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `That batch needs ${urls.length} screenshots and you have ${usage.remaining} left on the ${getPlan(user.plan).name} plan this month.`,
    );
  }

  const result: BatchResult = { requested: urls.length, captures: [], failed: [] };

  // Sequential. Each capture holds a browser session, and the session pool is
  // the scarce resource — a parallel batch would starve everyone else's
  // captures to finish this one sooner.
  for (const url of urls) {
    let options: CaptureOptions;
    try {
      options = parseCaptureOptions({ ...shared, url });
    } catch (error) {
      result.failed.push({ url, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

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
