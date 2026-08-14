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

/**
 * How long a page gets to go quiet after the document is ready, before the
 * shutter fires anyway. Generous enough for fonts, hero images and lazy content;
 * short enough that a page which never stops talking still returns quickly.
 */
const NETWORK_IDLE_BUDGET_MS = 6_000;

/** Best effort: a page that will not go quiet is still worth photographing. */
async function settleNetwork(page: any): Promise<void> {
  if (typeof page.waitForNetworkIdle !== 'function') {
    // Without the helper, a fixed pause is far better than shooting the instant
    // the document parses — that is how blank and unstyled captures happen.
    await sleep(2_000);
    return;
  }
  try {
    await page.waitForNetworkIdle({ idleTime: 500, concurrency: 2, timeout: NETWORK_IDLE_BUDGET_MS });
  } catch {
    // Chatty analytics, a websocket, a poller. Not a reason to fail.
  }
}

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
      await page.setContent(options.html, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await settleNetwork(page);
    } else {
      page.on('response', (response: any) => {
        try {
          const code = Number(response.status());
          if (code >= 300 && code < 400) redirects.push(String(response.url()));
        } catch {
          /* a response we cannot read is not a redirect we can report */
        }
      });
      /*
       * Two stages, and the second one is allowed to fail.
       *
       * `networkidle0` means zero connections for half a second, which a page
       * with analytics, a chat widget or a video poller may never reach — and
       * when it does not, `goto` throws at the timeout and the whole capture is
       * lost after thirty seconds of waiting. Almost every page is photographable
       * long before then. So: wait for the document, then give the network a
       * bounded chance to settle, and shoot regardless.
       */
      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      status = response ? Number(response.status()) : null;
      finalUrl = page.url() ?? options.url;
      await settleNetwork(page);
    }

    /*
     * Consent first, then the caller's own steps. A dialog usually blocks the
     * very selectors an action wants to click, and dismissing it afterwards
     * would mean the actions ran against a page nobody could use.
     */
    await freezeAnimations(page);

    if (options.dismissConsent) await dismissConsent(page);

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
      /*
       * The chosen device comes first and always: the control reads "Also
       * capture at", so ticking Mobile next to a Desktop capture must produce
       * both. Sizes that repeat the chosen device are dropped rather than shot
       * twice and charged twice.
       */
      const shots = [
        {
          id: options.device,
          width: options.width,
          height: options.height,
          scale: options.scale,
          mobile: options.device === 'mobile' || options.device === 'tablet',
        },
        ...options.sizes
          .filter((size) => size !== options.device)
          .map((size) => ({
            id: size,
            width: DEVICES[size].width,
            height: DEVICES[size].height,
            scale: DEVICES[size].scale,
            mobile: size !== 'desktop',
          })),
      ];

      const files: RenderedFile[] = [];
      for (const [i, preset] of shots.entries()) {
        const size = preset.id;
        await page.setViewport({
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.scale,
          isMobile: preset.mobile,
          hasTouch: preset.mobile,
        });
        // A reflow after a viewport change is not instant, and a shot taken
        // mid-reflow shows the previous layout at the new width.
        await sleep(SETTLE_MS);
        if (options.mode === 'fullpage') await autoScroll(page, preset.height);
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(SETTLE_MS);

        // The mark was anchored to the previous viewport and page height, so it
        // is re-applied against this layout. The script removes any existing
        // one first, so marks do not stack.
        if (options.watermark) await applyWatermark(page, options.mode);

        const shot =
          options.mode === 'fullpage'
            ? await captureTallViewport(page, preset, shotOptions)
            : {
                data: toUint8(
                  await page.screenshot({ ...shotOptions, fullPage: false, captureBeyondViewport: false }),
                ),
                height: preset.height,
              };
        files.push({
          data: shot.data,
          contentType,
          ext,
          index: i + 1,
          name: `${size}.${ext}`,
          width: preset.width,
          height: shot.height,
        });
      }
      return { files, ...extras };
    }

    if (options.mode === 'fullpage') {
      const shot = await captureTallViewport(
        page,
        {
          width: options.width,
          height: options.height,
          scale: options.scale,
          mobile: options.device === 'mobile' || options.device === 'tablet',
        },
        shotOptions,
      );
      return {
        files: [
          { data: shot.data, contentType, ext, index: 1, width: options.width, height: shot.height },
        ],
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

/** How many times to look for a consent dialog, and how long between looks. */
const CONSENT_ATTEMPTS = 3;
const CONSENT_RETRY_MS = 700;

/**
 * Clicks a cookie dialog away, more than once if it takes that.
 *
 * Consent banners are rarely in the first paint — the vendor's script loads,
 * decides the visitor's region, and only then injects the dialog. Looking once,
 * the moment the network goes quiet, is how a banner ends up in a screenshot
 * despite the box being ticked. So: look, wait, look again, and stop early the
 * moment something is clicked.
 */
async function dismissConsent(page: any): Promise<void> {
  for (let attempt = 0; attempt < CONSENT_ATTEMPTS; attempt++) {
    if (attempt) await sleep(CONSENT_RETRY_MS);
    try {
      const clicked = await page.evaluate(dismissConsentInPage, CONSENT_SELECTORS, CONSENT_TEXTS);
      if (clicked) {
        console.log(`[render] dismissed consent via ${clicked}`);
        await sleep(SETTLE_MS);
        return;
      }
    } catch {
      // Best effort: a page that will not be clicked is still worth shooting.
      return;
    }
  }
}

/**
 * Makes reveal animations land instantly instead of being caught mid-fade.
 *
 * Zeroing the durations rather than pausing them: a paused animation holds
 * whatever frame it was on, which for a fade-in is usually invisible.
 */
async function freezeAnimations(page: any): Promise<void> {
  try {
    await page.addStyleTag({
      content: `*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;` +
        `transition-duration:0s !important;transition-delay:0s !important}` +
        `html{scroll-behavior:auto !important}`,
    });
  } catch {
    /* best-effort */
  }
}

interface ViewportPreset {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

/**
 * Captures the whole document by making the viewport as tall as the page.
 *
 * Chrome's own full-page screenshot stitches from a short viewport, which fails
 * on any site that reveals content as you scroll: the scroll pass triggers the
 * reveals, scrolling back to the top puts them away again, and what is captured
 * is a page of empty sections — black, on a dark site. Making the viewport the
 * height of the document means everything is genuinely on screen at once, so
 * every observer fires and nothing is scrolled out of view to be hidden again.
 *
 * Returns the height actually captured, because it is not always the height
 * that was asked for: the page is measured again after the resize, and a very
 * long page is clamped rather than refused.
 *
 * Exported so `scripts/fullpage-check.mjs` can run this exact function against
 * a scroll-reveal page in local Chromium.
 */
export async function captureTallViewport(
  page: any,
  preset: ViewportPreset,
  shotOptions: Record<string, unknown>,
): Promise<{ data: Uint8Array; height: number }> {
  const tallest = LIMITS.maxFullPageHeight;
  let height = Math.min(await documentHeight(page), tallest) || preset.height;

  const resize = async (to: number): Promise<void> => {
    await page.setViewport({
      width: preset.width,
      height: to,
      deviceScaleFactor: preset.scale,
      isMobile: preset.mobile,
      hasTouch: preset.mobile,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    // Long enough for reveal observers to fire against the new viewport.
    await sleep(SETTLE_MS * 3);
  };

  try {
    await resize(height);

    /*
     * A viewport that tall is a different layout, and some pages get taller in
     * it — sections sized in viewport units are the usual reason. One correction
     * pass, so the shot is not short of the content; a second would risk a page
     * that grows every time it is measured.
     */
    const settled = Math.min(await documentHeight(page), tallest);
    if (settled > height + 8) {
      height = settled;
      await resize(height);
    }

    const buffer = await page.screenshot({
      ...shotOptions,
      fullPage: false,
      captureBeyondViewport: false,
    });
    return { data: toUint8(buffer), height };
  } catch (error) {
    // Chrome refuses a surface beyond its texture limit, which a long page at
    // a 2x scale factor can reach. Stitching is worse on animated sites and
    // better than no screenshot at all.
    console.error('[render] tall-viewport capture failed, stitching instead', error);
    await page.setViewport({
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.scale,
      isMobile: preset.mobile,
      hasTouch: preset.mobile,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(SETTLE_MS);
    const buffer = await page.screenshot({ ...shotOptions, fullPage: true });
    return { data: toUint8(buffer), height: Math.min(await documentHeight(page), tallest) };
  }
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
