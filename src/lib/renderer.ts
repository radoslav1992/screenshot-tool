import { env } from 'cloudflare:workers';
import { HttpError } from './http';
import { LIMITS, type CaptureOptions } from './capture-options';
import { acquireBrowser, releaseBrowser } from './browser-pool';

export interface RenderedFile {
  data: Uint8Array;
  contentType: string;
  ext: string;
  /** 1-based index within a scroll series; 1 for single-file captures. */
  index: number;
  width: number;
  height: number;
}

export interface RenderResult {
  files: RenderedFile[];
  engine: 'binding' | 'rest';
  durationMs: number;
}

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 250;

const AD_HOST_FRAGMENTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googletagservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.',
  'facebook.net',
  'hotjar.com',
  'segment.io',
  'scorecardresearch.com',
  'taboola.com',
  'outbrain.com',
  'criteo.',
  'adnxs.com',
];

function contentTypeFor(format: CaptureOptions['format']): { contentType: string; ext: string } {
  if (format === 'pdf') return { contentType: 'application/pdf', ext: 'pdf' };
  if (format === 'jpg') return { contentType: 'image/jpeg', ext: 'jpg' };
  return { contentType: 'image/png', ext: 'png' };
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') {
    // Puppeteer returns base64 when encoding: 'base64'.
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new HttpError(502, 'render_failed', 'The renderer returned an unexpected payload.');
}

function hasBrowserBinding(): boolean {
  return Boolean((env as Env).BROWSER);
}

function hasRestCredentials(): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
}

/**
 * Renders a capture. Prefers the Browser Rendering binding (supports every
 * mode); falls back to the REST Browser Rendering API when only credentials
 * are configured, which covers everything except scroll series.
 */
export async function render(options: CaptureOptions): Promise<RenderResult> {
  const started = Date.now();

  if (hasBrowserBinding()) {
    try {
      const files = await renderWithBinding(options);
      return { files, engine: 'binding', durationMs: Date.now() - started };
    } catch (error) {
      if (!hasRestCredentials()) throw asRenderError(error);
      // Binding unavailable in this environment — try the REST API instead.
    }
  }

  if (hasRestCredentials()) {
    const files = await renderWithRest(options);
    return { files, engine: 'rest', durationMs: Date.now() - started };
  }

  throw new HttpError(
    503,
    'renderer_unavailable',
    'No rendering backend is configured. Bind Cloudflare Browser Rendering as BROWSER, or set CF_ACCOUNT_ID and CF_API_TOKEN.',
  );
}

function asRenderError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) {
    return new HttpError(504, 'render_timeout', 'The page took too long to load and the capture timed out.');
  }
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) {
    return new HttpError(400, 'unreachable_url', 'That URL could not be resolved.');
  }
  if (/net::ERR_/i.test(message)) {
    return new HttpError(400, 'unreachable_url', `The page could not be loaded (${message.trim()}).`);
  }
  return new HttpError(502, 'render_failed', `The capture failed: ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Browser Rendering binding (@cloudflare/puppeteer)                           */
/* -------------------------------------------------------------------------- */

async function renderWithBinding(options: CaptureOptions): Promise<RenderedFile[]> {
  const puppeteer = (await import('@cloudflare/puppeteer')).default;
  const lease = await acquireBrowser(puppeteer);
  let succeeded = false;
  let page: any;

  try {
    page = await lease.browser.newPage();
    const files = await capturePage(page, options);
    succeeded = true;
    return files;
  } finally {
    // Always close the page. A reused session outlives the request, so a page
    // left open would leak into the next capture.
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

async function capturePage(page: any, options: CaptureOptions): Promise<RenderedFile[]> {
  {
    await page.setViewport({
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      isMobile: options.device === 'mobile' || options.device === 'tablet',
      hasTouch: options.device === 'mobile' || options.device === 'tablet',
    });

    if (options.blockAds) {
      try {
        await page.setRequestInterception(true);
        page.on('request', (request: any) => {
          const url = String(request.url());
          if (AD_HOST_FRAGMENTS.some((fragment) => url.includes(fragment))) request.abort();
          else request.continue();
        });
      } catch {
        // Interception is best-effort; carry on without it.
      }
    }

    if (options.darkMode) {
      try {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      } catch {
        /* older builds may not expose this */
      }
    }

    await page.goto(options.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });

    if (options.mode !== 'visible') await autoScroll(page, options.height);
    if (options.delayMs > 0) await sleep(options.delayMs);

    const { contentType, ext } = contentTypeFor(options.format);

    if (options.format === 'pdf') {
      const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: false });
      return [
        { data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: options.height },
      ];
    }

    const shotOptions: Record<string, unknown> = { type: options.format === 'jpg' ? 'jpeg' : 'png' };
    if (options.format === 'jpg') shotOptions.quality = options.quality;

    if (options.mode === 'fullpage') {
      const pageHeight = Math.min(await documentHeight(page), LIMITS.maxFullPageHeight);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(SETTLE_MS);
      const buffer = await page.screenshot({ ...shotOptions, fullPage: true });
      return [{ data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: pageHeight }];
    }

    if (options.mode === 'visible') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(SETTLE_MS);
      const buffer = await page.screenshot({ ...shotOptions, fullPage: false, captureBeyondViewport: false });
      return [
        { data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: options.height },
      ];
    }

    // Scroll series: viewport-sized frames from the top of the page down.
    const pageHeight = Math.min(await documentHeight(page), LIMITS.maxFullPageHeight);
    const frames = Math.max(1, Math.min(Math.ceil(pageHeight / options.height), options.maxFrames));
    const files: RenderedFile[] = [];

    for (let i = 0; i < frames; i++) {
      const offset = i * options.height;
      await page.evaluate((y: number) => window.scrollTo(0, y), offset);
      await sleep(SETTLE_MS);
      const buffer = await page.screenshot({ ...shotOptions, fullPage: false, captureBeyondViewport: false });
      files.push({
        data: toUint8(buffer),
        contentType,
        ext,
        index: i + 1,
        width: options.width,
        height: options.height,
      });
    }

    return files;
  }
}

async function documentHeight(page: any): Promise<number> {
  const height = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return Math.max(
      doc?.scrollHeight ?? 0,
      doc?.offsetHeight ?? 0,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
    );
  });
  return Number.isFinite(height) && height > 0 ? Number(height) : 0;
}

/** Scrolls to the bottom in viewport steps so lazy-loaded content renders. */
async function autoScroll(page: any, step: number): Promise<void> {
  try {
    await page.evaluate(
      async (stepSize: number, cap: number) =>
        await new Promise<void>((resolve) => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, stepSize);
            total += stepSize;
            if (total >= document.documentElement.scrollHeight || total > cap) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 80);
        }),
      step,
      LIMITS.maxFullPageHeight,
    );
    await sleep(SETTLE_MS);
  } catch {
    /* best-effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* REST Browser Rendering fallback                                             */
/* -------------------------------------------------------------------------- */

async function renderWithRest(options: CaptureOptions): Promise<RenderedFile[]> {
  if (options.mode === 'series') {
    throw new HttpError(
      501,
      'unsupported_mode',
      'Scroll series requires the Browser Rendering binding. Add a `browser` binding to wrangler.jsonc.',
    );
  }

  const endpoint = options.format === 'pdf' ? 'pdf' : 'screenshot';
  const body: Record<string, unknown> = {
    url: options.url,
    viewport: {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      isMobile: options.device === 'mobile' || options.device === 'tablet',
    },
    gotoOptions: { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS },
  };
  if (options.delayMs > 0) body.waitForTimeout = options.delayMs;
  if (options.format !== 'pdf') {
    body.screenshotOptions = {
      fullPage: options.mode === 'fullpage',
      type: options.format === 'jpg' ? 'jpeg' : 'png',
      ...(options.format === 'jpg' ? { quality: options.quality } : {}),
    };
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/${endpoint}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new HttpError(502, 'render_failed', `Browser Rendering API responded ${response.status}: ${detail}`);
  }

  const { contentType, ext } = contentTypeFor(options.format);
  const data = new Uint8Array(await response.arrayBuffer());
  return [{ data, contentType, ext, index: 1, width: options.width, height: options.height }];
}
