import { env } from 'cloudflare:workers';
import { acquireBrowser, releaseBrowser } from './browser-pool';
import { CHANNEL_TOLERANCE, MAX_COMPARE_PIXELS, compareInPage, type DiffResult } from './visual-diff-fn';

/**
 * Comparing two screenshots.
 *
 * Workers have no image decoder, and pulling one in as WASM to compare two PNGs
 * would be a lot of bytes for a job the platform can already do — we are holding
 * a browser. So the comparison happens in a page: draw both images onto canvases
 * and count the pixels that differ. The page-side half lives in visual-diff-fn.
 *
 * The images are fetched by the browser over their share URLs rather than being
 * passed in as base64. A full-page capture is routinely several megabytes, and
 * pushing that through an `evaluate` argument costs far more than letting the
 * browser make two ordinary HTTP requests.
 */

export type { DiffResult };

export async function compareImages(beforeUrl: string, afterUrl: string): Promise<DiffResult> {
  const puppeteer = (await import('@cloudflare/puppeteer')).default;
  const lease = await acquireBrowser(puppeteer);
  let succeeded = false;
  let page: any;

  try {
    page = await lease.browser.newPage();
    await page.setViewport({ width: 400, height: 400, deviceScaleFactor: 1 });

    const result = (await page.evaluate(
      compareInPage,
      beforeUrl,
      afterUrl,
      CHANNEL_TOLERANCE,
      MAX_COMPARE_PIXELS,
    )) as DiffResult;

    succeeded = true;
    return { ...result, changedPct: Math.round(result.changedPct * 100) / 100 };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* the session may already be gone */
      }
    }
    await releaseBrowser(lease, succeeded);
  }
}

/** True when this deployment can diff at all — the REST fallback cannot. */
export function diffAvailable(): boolean {
  return Boolean((env as Env).BROWSER);
}
