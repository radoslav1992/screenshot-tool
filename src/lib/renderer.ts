import { env } from 'cloudflare:workers';
import { HttpError } from './http';
import { buildFacts, type PageFacts } from './page-facts';
import { readFactsInPage } from './page-facts-fn';
import { LIMITS, type CaptureOptions } from './capture-options';
import { acquireBrowser, releaseBrowser } from './browser-pool';
import { applyWatermark, watermarkScript } from './watermark';
import { PII_PATTERNS, redactInPage } from './redact-fn';
import { CONSENT_SELECTORS, CONSENT_TEXTS, dismissConsentInPage } from './actions';
import { hasRequestAuth } from './request-auth';
import { DEVICES } from './capture-options';

export interface RenderedFile {
  data: Uint8Array;
  contentType: string;
  ext: string;
  /** 1-based index within a scroll series; 1 for single-file captures. */
  index: number;
  /** Overrides the derived filename — used to name each viewport in `sizes`. */
  name?: string;
  width: number;
  height: number;
}

export interface RenderResult {
  /** Present only when facts were asked for and the binding path was used. */
  facts?: PageFacts;
  /** Where navigation ended up, and how it got there. */
  finalUrl?: string;
  status?: number | null;
  redirects?: string[];
  files: RenderedFile[];
  engine: 'binding' | 'rest';
  durationMs: number;
}

const NAV_TIMEOUT_MS = 30_000;
/** How long a single action may take before it counts as failed. */
const ACTION_TIMEOUT_MS = 10_000;

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
      const outcome = await renderWithBinding(options);
      return { ...outcome, engine: 'binding', durationMs: Date.now() - started };
    } catch (error) {
      if (!hasRestCredentials()) throw asRenderError(error);
      // Binding unavailable in this environment — try the REST API instead.
    }
  }

  if (hasRestCredentials()) {
    // The REST endpoint takes a URL and returns an image: no page to read facts
    // from, and nothing to set content on.
    if (options.html) {
      throw new HttpError(
        503,
        'renderer_unavailable',
        'Rendering your own HTML needs the Browser Rendering binding, which this deployment does not have.',
      );
    }
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

/**
 * Whether a subrequest may leave for this address.
 *
 * Deliberately a denylist of shapes rather than a DNS resolution: the same
 * bargain `assertPublicUrl` makes for capture URLs, and the same limits — a
 * public hostname pointing at a private address is not caught here either.
 */
function isPublicResource(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  // data: and blob: carry their own bytes and reach no network.
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return !PRIVATE_RESOURCE_PATTERNS.some((pattern) => pattern.test(host));
}

const PRIVATE_RESOURCE_PATTERNS: RegExp[] = [
  /^localhost$/,
  /\.localhost$/,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/,
  /^fe80:/,
  /\.local$/,
  /\.internal$/,
];

async function renderWithBinding(options: CaptureOptions): Promise<PageOutcome> {
  const puppeteer = (await import('@cloudflare/puppeteer')).default;
  const lease = await acquireBrowser(puppeteer);
  let succeeded = false;
  let page: any;

  try {
    page = await lease.browser.newPage();
    const outcome = await capturePage(page, options);
    succeeded = true;
    return outcome;
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

interface PageOutcome {
  files: RenderedFile[];
  facts?: PageFacts;
  finalUrl?: string;
  status?: number | null;
  redirects?: string[];
}

async function capturePage(page: any, options: CaptureOptions): Promise<PageOutcome> {
  {
    await page.setViewport({
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      isMobile: options.device === 'mobile' || options.device === 'tablet',
      hasTouch: options.device === 'mobile' || options.device === 'tablet',
    });

    /*
     * Interception does two jobs. Blocking ad hosts is a quality choice the
     * caller makes. Blocking private destinations is not optional for inline
     * markup: `html` never passes through assertPublicUrl, because there is no
     * address to check, so `<img src="http://192.168.0.1/">` would otherwise
     * make the renderer fetch something on a private network on request. Here
     * every subrequest is judged on its own.
     */
    const guardPrivate = Boolean(options.html);
    if (options.blockAds || guardPrivate) {
      try {
        await page.setRequestInterception(true);
        page.on('request', (request: any) => {
          const url = String(request.url());
          if (options.blockAds && AD_HOST_FRAGMENTS.some((fragment) => url.includes(fragment))) {
            request.abort();
          } else if (guardPrivate && !isPublicResource(url)) {
            request.abort();
          } else {
            request.continue();
          }
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

    if (hasRequestAuth(options.auth)) {
      const headers = { ...options.auth.headers };
      if (options.auth.basic) {
        // Puppeteer's authenticate() answers a 401 challenge; sending the
        // header outright also covers servers that never issue one.
        const { username, password } = options.auth.basic;
        await page.authenticate({ username, password }).catch(() => undefined);
        headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
      }
      if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);

      if (options.auth.cookies.length && !options.html) {
        // Scoped to the page being captured. A cookie without a domain would
        // otherwise be offered to every host the page happens to talk to.
        const { hostname } = new URL(options.url);
        await page.setCookie(
          ...options.auth.cookies.map((cookie) => ({ ...cookie, domain: hostname, path: '/' })),
        );
      }
    }

    const redirects: string[] = [];
    let status: number | null = null;
    let finalUrl = options.url;

    if (options.html) {
      await page.setContent(options.html, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
    } else {
      page.on('response', (response: any) => {
        try {
          const code = Number(response.status());
          if (code >= 300 && code < 400) redirects.push(String(response.url()));
        } catch {
          /* a response we cannot read is not a redirect we can report */
        }
      });
      const response = await page.goto(options.url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT_MS });
      status = response ? Number(response.status()) : null;
      finalUrl = page.url() ?? options.url;
    }

    /*
     * Consent first, then the caller's own steps. A dialog usually blocks the
     * very selectors an action wants to click, and dismissing it afterwards
     * would mean the actions ran against a page nobody could use.
     */
    if (options.dismissConsent) {
      try {
        const clicked = await page.evaluate(dismissConsentInPage, CONSENT_SELECTORS, CONSENT_TEXTS);
        if (clicked) {
          console.log(`[render] dismissed consent via ${clicked}`);
          await sleep(SETTLE_MS);
        }
      } catch {
        // Best effort: a page that will not be clicked is still worth shooting.
      }
    }

    for (const action of options.actions) {
      try {
        if (action.kind === 'wait') {
          await sleep(Number.parseInt(action.value, 10));
        } else if (action.kind === 'wait_for') {
          await page.waitForSelector(action.value, { timeout: ACTION_TIMEOUT_MS });
        } else if (action.kind === 'click') {
          await page.click(action.value, { timeout: ACTION_TIMEOUT_MS });
          await sleep(SETTLE_MS);
        } else if (action.kind === 'type') {
          await page.type(action.value, action.text ?? '', { delay: 10 });
        } else if (action.kind === 'scroll_to') {
          await page.evaluate((selector: string) => {
            document.querySelector(selector)?.scrollIntoView({ block: 'start' });
          }, action.value);
          await sleep(SETTLE_MS);
        }
      } catch (error) {
        // A step that cannot run is the caller's mistake to see, not a reason
        // to lose the capture — the picture may still be the one they wanted.
        throw new HttpError(
          400,
          'action_failed',
          `The \`${action.kind}\` step on \`${action.value}\` did not work: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (options.mode !== 'visible') await autoScroll(page, options.height);
    if (options.delayMs > 0) await sleep(options.delayMs);

    /*
     * Redaction comes before facts and before the shutter. Removing the node or
     * replacing its text means the information was never in the file; a blur
     * applied to finished pixels can be undone by anyone patient.
     */
    if (options.hide.length || options.blur.length || options.redactPii) {
      try {
        const applied = await page.evaluate(
          redactInPage,
          { hide: options.hide, blur: options.blur, redactPii: options.redactPii },
          PII_PATTERNS,
        );
        if (applied?.unmatched?.length) {
          console.log(`[render] selectors matched nothing: ${applied.unmatched.join(', ')}`);
        }
      } catch (error) {
        // A capture that quietly skipped its redaction would be worse than no
        // capture: the caller asked for something to be covered.
        throw new HttpError(
          502,
          'redaction_failed',
          `The page could not be redacted, so nothing was captured: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Before the watermark, so the mark is not part of what the page appears to
    // say about itself.
    let facts: PageFacts | undefined;
    if (options.facts) {
      try {
        const raw = await page.evaluate(readFactsInPage);
        facts = buildFacts({ raw, finalUrl, status, redirects });
      } catch (error) {
        // Facts are an extra. A page that will not be read is still a page that
        // can be photographed.
        console.error('[render] could not read page facts', error);
      }
    }

    // After the page has settled, so nothing the site renders on load can paint
    // over the mark, and after auto-scroll, so the document height it anchors to
    // is the final one.
    if (options.watermark && options.format !== 'pdf') await applyWatermark(page, options.mode);

    const extras = { facts, finalUrl, status, redirects };

    const { contentType, ext } = contentTypeFor(options.format);

    if (options.format === 'pdf') {
      const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: false });
      return {
        files: [
          { data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: options.height },
        ],
        ...extras,
      };
    }

    const shotOptions: Record<string, unknown> = { type: options.format === 'jpg' ? 'jpeg' : 'png' };
    if (options.format === 'jpg') shotOptions.quality = options.quality;

    if (options.sizes.length) {
      const files: RenderedFile[] = [];
      for (const [i, size] of options.sizes.entries()) {
        const preset = DEVICES[size];
        await page.setViewport({
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.scale,
          isMobile: size !== 'desktop',
          hasTouch: size !== 'desktop',
        });
        // A reflow after a viewport change is not instant, and a shot taken
        // mid-reflow shows the previous layout at the new width.
        await sleep(SETTLE_MS);
        if (options.mode === 'fullpage') await autoScroll(page, preset.height);
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(SETTLE_MS);

        const fullPage = options.mode === 'fullpage';
        const buffer = await page.screenshot({ ...shotOptions, fullPage, captureBeyondViewport: false });
        files.push({
          data: toUint8(buffer),
          contentType,
          ext,
          index: i + 1,
          name: `${size}.${ext}`,
          width: preset.width,
          height: fullPage ? Math.min(await documentHeight(page), LIMITS.maxFullPageHeight) : preset.height,
        });
      }
      return { files, ...extras };
    }

    if (options.mode === 'fullpage') {
      const pageHeight = Math.min(await documentHeight(page), LIMITS.maxFullPageHeight);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(SETTLE_MS);
      const buffer = await page.screenshot({ ...shotOptions, fullPage: true });
      return {
        files: [{ data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: pageHeight }],
        ...extras,
      };
    }

    if (options.mode === 'visible') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(SETTLE_MS);
      const buffer = await page.screenshot({ ...shotOptions, fullPage: false, captureBeyondViewport: false });
      return {
        files: [
          { data: toUint8(buffer), contentType, ext, index: 1, width: options.width, height: options.height },
        ],
        ...extras,
      };
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

    return { files, ...extras };
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
  // The REST endpoint has no page handle, so the mark goes in as an injected
  // script instead. Best-effort — the binding path is the supported one.
  if (options.watermark && options.format !== 'pdf') {
    body.addScriptTag = [{ content: watermarkScript(options.mode) }];
  }
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
