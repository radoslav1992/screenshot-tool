import { env } from 'cloudflare:workers';
import { DEVICES, assertPublicCaptureUrl, type CaptureOptions, type DeviceId } from './capture-options';
import { HttpError, assertSameOrigin, badRequest } from './http';
import { checkRateLimit, refundRateLimit } from './rate-limit';
import { clientIp, waitPhrase } from './auth-throttle';
import { sha256Hex } from './ids';
import { render, type RenderedFile } from './renderer';
import { spareSessions } from './browser-pool';
import { compareImages, type ChangeRegion } from './visual-diff';
import { checkSeo, type SeoReport } from './seo-check';
import { PLANS } from './plans';

/**
 * The free tools under /tools: a full-page screenshot, a responsive preview, a
 * page comparison and an SEO tag checker, for anyone, with no account.
 *
 * Three of them hold a browser, which costs real money per second, and none of
 * them knows who is asking. So everything here is about making that uneconomic
 * to abuse while staying useful to a person:
 *
 * - **Few renders per visitor.** RENDER_COST draws from a visitor's daily
 *   allowance, keyed by a hash of their address (an IPv6 one by its /64, which
 *   one household holds). A preview is three shots and a comparison two.
 * - **Few renders in all.** A daily cap across every visitor
 *   (FREE_TOOLS_DAILY_RENDERS) bounds the bill whatever the addresses.
 * - **Customers first.** A render starts only while the browser pool has more
 *   than `reservedSessions` to spare, and never waits for one (acquireBrowser
 *   with `wait: false`): a full pool is answered "busy", not queued.
 * - **Small, bounded renders.** Preset devices only, at scale 1, as JPEG, a
 *   full page cut at 8,000 px, the free-plan mark on every image, the normal
 *   capture deadline, and the normal private-address and denylist checks — no
 *   credentials, headers, cookies, scripts or other options exist here at all.
 * - **Nothing kept.** Images go back in the response and nowhere else; no row,
 *   no file, and no log line names the visitor or the page.
 *
 * Counters live in KV through checkRateLimit, which lets requests through when
 * KV cannot be read: fairness is not worth an outage, and the daily cap and the
 * pool check still stand when it does.
 */

export type BrowserTool = 'full-page-screenshot' | 'responsive-preview' | 'compare-pages';
export type ToolId = BrowserTool | 'seo-tag-checker';

/** Renders each browser tool draws from a visitor's allowance and the day's: one per page shot. */
export const RENDER_COST: Record<BrowserTool, number> = {
  'full-page-screenshot': 1,
  'responsive-preview': 3,
  'compare-pages': 2,
};

export const FREE_TOOL_LIMITS = {
  /** Renders per visitor per UTC day, across the browser tools. */
  rendersPerVisitor: 5,
  /** SEO checks per visitor per hour: a plain request and some parsing, no browser. */
  seoChecksPerVisitor: 30,
  /** Renders per UTC day across every visitor, unless FREE_TOOLS_DAILY_RENDERS says otherwise. */
  dailyRenders: 300,
  /** Browser sessions kept for customers: a free render starts only with more than this many spare. */
  reservedSessions: 2,
} as const;

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

/** What every free render is held to (see toolOptions). */
export const TOOL_RENDER = { scale: 1, maxHeight: 8_000, quality: 70 } as const;

/* -------------------------------------------------------------------------- */
/* Who is asking                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Same origin, and from a browser on this site. assertSameOrigin lets a request
 * without an Origin through, for API clients; a free tool has no API, and every
 * browser sends Origin on a POST, so a request with neither Origin nor a
 * same-origin Sec-Fetch-Site did not come from the tool's page.
 */
export function assertToolRequest(request: Request): void {
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use the form on this page.');
  assertSameOrigin(request);
  if (!request.headers.get('origin') && request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new HttpError(403, 'forbidden', 'Use the form on this page.');
  }
}

/**
 * The part of an address that names one visitor: an IPv4 address whole, an
 * IPv6 one by its first four groups, since one connection is handed a whole
 * /64 and could otherwise take a fresh address for every request.
 */
export function addressPrefix(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(':')) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * The visitor as a counter key: their address prefix hashed together with the
 * UTC day, so a key names nobody, and two days' keys cannot be matched up. The
 * address itself is never written anywhere.
 */
export async function visitorKey(request: Request, now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10);
  return (await sha256Hex(`free-tools:${day}:${addressPrefix(clientIp(request))}`)).slice(0, 32);
}

/** Renders a day across everyone: FREE_TOOLS_DAILY_RENDERS when it is a whole number, 0 turning them off. */
export function dailyRenderCap(): number {
  const raw = (env.FREE_TOOLS_DAILY_RENDERS ?? '').trim();
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : FREE_TOOL_LIMITS.dailyRenders;
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

const SIGN_UP_PITCH = `Sign up free to keep going: ${PLANS.free.quota} screenshots a month and 3 monitors, no card needed.`;

/** The browser pool has nothing to spare for anonymous work right now. */
export function poolBusy(): HttpError {
  return new HttpError(503, 'browser_busy', 'Our browsers are busy right now. Try again in a minute.');
}

/** Today's renders across every visitor are spent, or the tools are switched off. */
export function dayFull(): HttpError {
  return new HttpError(503, 'tools_busy', `The free tools are busy today. ${SIGN_UP_PITCH}`);
}

function visitorSpent(cost: number, remaining: number, resetSeconds: number): HttpError {
  const message =
    remaining > 0
      ? `That takes ${cost} of your free renders and you have ${remaining} left today.`
      : `You have used today’s ${FREE_TOOL_LIMITS.rendersPerVisitor} free renders. They come back in ${waitPhrase(resetSeconds)}.`;
  return new HttpError(429, 'rate_limited', `${message} ${SIGN_UP_PITCH}`);
}

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Takes `cost` renders from the visitor's day and from everyone's, or throws.
 * The answer gives renders back, for those a full pool turned away.
 *
 * The visitor's counter is charged first; when the day's is then full, that
 * charge is not given back — the day's renders are spent until midnight UTC,
 * which is exactly when the visitor's key and window turn over too.
 */
export async function drawRenders(visitor: string, cost: number): Promise<{ refund: (count: number) => Promise<void> }> {
  const cap = dailyRenderCap();
  if (cap <= 0) throw dayFull();
  const mine = `tools:render:${visitor}`;
  const drawn = await checkRateLimit(mine, FREE_TOOL_LIMITS.rendersPerVisitor, DAY_SECONDS, cost);
  if (!drawn.ok) throw visitorSpent(cost, drawn.remaining, drawn.resetSeconds);
  const everyone = await checkRateLimit('tools:render:all', cap, DAY_SECONDS, cost);
  if (!everyone.ok) throw dayFull();
  return {
    refund: async (count) => {
      if (count <= 0) return;
      await Promise.all([refundRateLimit(mine, DAY_SECONDS, count), refundRateLimit('tools:render:all', DAY_SECONDS, count)]);
    },
  };
}

/**
 * Runs a browser tool's `work` with `cost` renders drawn, once the pool has
 * room. `work` reports each render as it lands; a render the pool turned away
 * gives back what was not rendered, since the visitor is only told to retry.
 */
async function withRenders<T>(request: Request, cost: number, work: (rendered: (count: number) => void) => Promise<T>): Promise<T> {
  await assertBrowserFree();
  const draw = await drawRenders(await visitorKey(request), cost);
  let used = 0;
  try {
    return await work((count) => (used += count));
  } catch (error) {
    if (error instanceof HttpError && error.type === 'browser_busy') await draw.refund(cost - used);
    throw error;
  }
}

/** One SEO check from the visitor's hour. */
export async function drawSeoCheck(visitor: string): Promise<void> {
  const limit = FREE_TOOL_LIMITS.seoChecksPerVisitor;
  const result = await checkRateLimit(`tools:seo:${visitor}`, limit, HOUR_SECONDS);
  if (!result.ok) {
    throw new HttpError(
      429,
      'rate_limited',
      `You have run ${limit} SEO checks this hour. Try again in ${waitPhrase(result.resetSeconds)}, or sign up free to monitor your pages’ SEO tags.`,
    );
  }
}

/** Refuses when the pool has no more than `reservedSessions` to spare. A pool that cannot say is let through. */
export async function assertBrowserFree(): Promise<void> {
  if (!env.BROWSER) {
    throw new HttpError(503, 'renderer_unavailable', 'Screenshots are not available here right now. Try again later.');
  }
  const puppeteer = (await import('@cloudflare/puppeteer')).default;
  const spare = await spareSessions(puppeteer);
  if (spare !== null && spare <= FREE_TOOL_LIMITS.reservedSessions) throw poolBusy();
}

/* -------------------------------------------------------------------------- */
/* Renders                                                                     */
/* -------------------------------------------------------------------------- */

/** The devices a visitor can choose between; the preview takes all three. */
export const TOOL_DEVICES: DeviceId[] = ['desktop', 'mobile'];

export interface ToolImage {
  device: DeviceId;
  width: number;
  height: number;
  contentType: string;
  data: Uint8Array;
}

/**
 * A free render's options, built here from nothing the visitor sends but the
 * address and a preset device. Nothing else exists to be set: no credentials,
 * headers, cookies, actions, selectors or delays; scale 1, JPEG, the free-plan
 * mark, a full page cut at TOOL_RENDER.maxHeight.
 */
export function toolOptions(url: URL, device: DeviceId, mode: 'visible' | 'fullpage', sizes: DeviceId[] = []): CaptureOptions {
  const preset = DEVICES[device];
  return {
    url: url.toString(),
    host: url.hostname,
    device,
    width: preset.width,
    height: preset.height,
    scale: TOOL_RENDER.scale,
    mode,
    format: 'jpg',
    fullPage: mode === 'fullpage',
    delayMs: 0,
    blockAds: true,
    darkMode: false,
    quality: TOOL_RENDER.quality,
    maxFrames: 1,
    facts: false,
    sizes,
    hide: [],
    blur: [],
    redactPii: false,
    actions: [],
    dismissConsent: true,
    auth: { headers: {}, cookies: [] },
    watermark: true,
    bounded: { scale: TOOL_RENDER.scale, maxHeight: TOOL_RENDER.maxHeight },
  };
}

/**
 * The address a visitor typed, checked as a capture's is: public, not
 * denylisted, http(s). `side` names which page of a comparison it is.
 */
export function toolUrl(raw: string | undefined, param = 'url', side = ''): URL {
  const prefix = side ? `${side}: ` : '';
  const value = (raw ?? '').trim();
  if (!value) throw badRequest(`${prefix}Enter the address of a page.`, param);
  if (value.length > 2048) throw badRequest(`${prefix}That address is too long.`, param);
  try {
    return assertPublicCaptureUrl(value);
  } catch (error) {
    if (error instanceof HttpError) throw badRequest(`${prefix}${error.message}`, param);
    throw error;
  }
}

function toolDevice(raw: string | undefined): DeviceId {
  const value = (raw ?? 'desktop').trim().toLowerCase() || 'desktop';
  if (!TOOL_DEVICES.includes(value as DeviceId)) throw badRequest('Choose desktop or mobile.', 'device');
  return value as DeviceId;
}

function imageOf(file: RenderedFile, device: DeviceId): ToolImage {
  return { device, width: file.width, height: file.height, contentType: file.contentType, data: file.data };
}

/**
 * A failed render, in words for a visitor; a full pool is "busy", whatever the
 * renderer called it. `side` names the page of a comparison that failed.
 */
function renderFailure(error: unknown, side = ''): HttpError {
  const prefix = side ? `${side}: ` : '';
  if (error instanceof HttpError) {
    if (error.type === 'browser_unavailable') return poolBusy();
    if (error.type === 'render_timeout') {
      return new HttpError(504, error.type, `${prefix}The page took too long to load, so it was stopped.`);
    }
    if (error.type === 'unreachable_url') return new HttpError(400, error.type, `${prefix}${error.message}`);
  }
  return new HttpError(502, 'render_failed', `${prefix}The page could not be captured. Try again, or try another page.`);
}

async function renderImages(options: CaptureOptions, side = ''): Promise<RenderedFile[]> {
  try {
    return (await render(options)).files;
  } catch (error) {
    throw renderFailure(error, side);
  }
}

export interface FullPageResult {
  tool: 'full-page-screenshot';
  url: string;
  image: ToolImage;
  /** The page went on past TOOL_RENDER.maxHeight and the image stops there. */
  cut: boolean;
}

export interface ResponsiveResult {
  tool: 'responsive-preview';
  url: string;
  /** Phone, tablet, desktop: smallest first, as they are shown. */
  images: ToolImage[];
}

export interface CompareResult {
  tool: 'compare-pages';
  a: { url: string; image: ToolImage };
  b: { url: string; image: ToolImage };
  /** Null when the two images could not be compared; `detail` says why. */
  diff: { changedPct: number; resized: boolean; identical: boolean; regions: ChangeRegion[]; highlight?: string } | null;
  detail?: string;
}

export interface SeoResult {
  tool: 'seo-tag-checker';
  url: string;
  report: SeoReport;
}

export type ToolResult = FullPageResult | ResponsiveResult | CompareResult | SeoResult;

/** The order a preview shows its devices in, and which sizes the one page load is shot at. */
const PREVIEW_ORDER: DeviceId[] = ['mobile', 'tablet', 'desktop'];

/** Base64 in pieces: one String.fromCharCode over megabytes would overflow the argument list. */
export function imageDataUrl(image: Pick<ToolImage, 'contentType' | 'data'>): string {
  let binary = '';
  for (let at = 0; at < image.data.length; at += 0x8000) {
    binary += String.fromCharCode(...image.data.subarray(at, at + 0x8000));
  }
  return `data:${image.contentType};base64,${btoa(binary)}`;
}

/**
 * Runs one tool for one request: the origin check, the input, the counters,
 * then the work. Everything the visitor did wrong is checked before anything
 * is spent, and the pool before the counters, so neither a typo nor a busy
 * moment costs a render.
 */
export async function runTool(request: Request, tool: ToolId, input: Record<string, string>): Promise<ToolResult> {
  assertToolRequest(request);

  if (tool === 'seo-tag-checker') {
    const url = toolUrl(input.url);
    await drawSeoCheck(await visitorKey(request));
    return { tool, url: url.toString(), report: await checkSeo(url.toString()) };
  }

  if (tool === 'full-page-screenshot') {
    const url = toolUrl(input.url);
    const device = toolDevice(input.device);
    const [file] = await withRenders(request, RENDER_COST[tool], () => renderImages(toolOptions(url, device, 'fullpage')));
    if (!file) throw renderFailure(null);
    return { tool, url: url.toString(), image: imageOf(file, device), cut: file.height >= TOOL_RENDER.maxHeight };
  }

  if (tool === 'responsive-preview') {
    const url = toolUrl(input.url);
    // One page load, shot at three sizes. Loaded as the desktop browser, which is what a
    // responsive layout is written against; each size still gets its own viewport and touch.
    const files = await withRenders(request, RENDER_COST[tool], () =>
      renderImages(toolOptions(url, 'desktop', 'visible', ['tablet', 'mobile'])),
    );
    const images = PREVIEW_ORDER.flatMap((device) => {
      const file = files.find((entry) => entry.name?.startsWith(`${device}.`));
      return file ? [imageOf(file, device)] : [];
    });
    if (images.length !== PREVIEW_ORDER.length) throw renderFailure(null);
    return { tool, url: url.toString(), images };
  }

  if (tool === 'compare-pages') {
    const a = toolUrl(input.a_url, 'a_url', 'Page A');
    const b = toolUrl(input.b_url, 'b_url', 'Page B');
    const device = toolDevice(input.device);
    // One after the other, as a customer's comparison is: two browsers at once is twice the draw on the pool.
    const [first, second] = await withRenders(request, RENDER_COST[tool], async (rendered) => {
      const [one] = await renderImages(toolOptions(a, device, 'fullpage'), 'Page A');
      rendered(1);
      const [two] = await renderImages(toolOptions(b, device, 'fullpage'), 'Page B');
      return [one, two];
    });
    if (!first || !second) throw renderFailure(null);
    const result: CompareResult = {
      tool,
      a: { url: a.toString(), image: imageOf(first, device) },
      b: { url: b.toString(), image: imageOf(second, device) },
      diff: null,
    };
    try {
      // The images go in as data URLs: nothing is stored, so there is nothing to fetch them from.
      const diff = await compareImages(imageDataUrl(result.a.image), imageDataUrl(result.b.image), undefined, {
        highlight: 0,
        wait: false,
      });
      result.diff = {
        changedPct: diff.changedPct,
        resized: diff.resized,
        identical: !diff.resized && diff.changedPct === 0,
        regions: diff.regions,
        ...(diff.highlight ? { highlight: diff.highlight } : {}),
      };
    } catch (error) {
      result.detail =
        error instanceof HttpError && error.type === 'browser_unavailable'
          ? 'Both pages were captured, but no browser was free to compare them. Try again in a minute.'
          : 'Both pages were captured, but they could not be compared.';
    }
    return result;
  }

  throw new HttpError(404, 'not_found', 'There is no such tool.');
}

/* -------------------------------------------------------------------------- */
/* Calls to action                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a result's call to action goes: sign up, then straight on to a monitor
 * for that page. `ref` names the tool (`index` for /tools), for the first-touch
 * attribution signup reads; `next` goes through safeNext at signup like any
 * other. Someone already signed in goes straight to the monitor.
 */
export function monitorHref(tool: ToolId | 'index', url = '', signedIn = false): string {
  const setup = url ? `/app/watches/setup?url=${encodeURIComponent(url)}` : '/app/watches/setup';
  if (signedIn) return setup;
  return `/signup?next=${encodeURIComponent(setup)}&ref=tool-${tool}`;
}
