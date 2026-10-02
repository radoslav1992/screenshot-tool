import { env } from 'cloudflare:workers';
import { HttpError } from './http';

/**
 * Browser session management for Cloudflare Browser Rendering.
 *
 * Launching a browser costs a few seconds of wall time on every capture, and
 * Browser Rendering bills by session duration. Two levers follow from that:
 *
 * 1. **Reuse** — connecting to a session that is already running and idle skips
 *    the launch entirely. This is free: the session exists either way. Always
 *    worth trying.
 *
 * 2. **Keeping sessions warm** (`disconnect()` instead of `close()`, with
 *    `keep_alive`) — this is NOT free. An idle session keeps billing, so it only
 *    pays off when the next capture arrives sooner than a launch takes. At
 *    $0.09/browser-hour a 60s idle session costs $0.0015, roughly five times a
 *    whole full-page capture. It is therefore off by default and enabled with
 *    BROWSER_KEEP_ALIVE_MS once sustained volume justifies it — see the README.
 *
 * Reuse depends on `disconnect()` releasing the session so it is listed without
 * a `connectionId`. The local dev runtime does not do this — disconnected
 * sessions keep a stale connection id and are never reusable — so the reuse
 * branch here can only be exercised against the real service. If keep-alive is
 * enabled and reuse is not in fact happening, sessions accumulate against the
 * concurrency cap; that shows up as the `browser_unavailable` error below.
 */

export interface BrowserLease {
  browser: any;
  reused: boolean;
  sessionId?: string;
}

/** Cloudflare caps keep_alive at 10 minutes. */
const MAX_KEEP_ALIVE_MS = 600_000;

/** Free sessions can be claimed by another isolate between listing and connecting. */
const MAX_CONNECT_ATTEMPTS = 3;

/**
 * A full pool usually frees up within seconds — another capture finishing — so
 * a launch refused for that reason is tried again before the caller is told:
 * three tries over roughly five seconds, jittered so isolates that were turned
 * away together do not all come back together.
 */
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_RETRY_MS = 1_500;
const LAUNCH_RETRY_JITTER_MS = 1_000;

export function keepAliveMs(): number {
  const raw = Number.parseInt(env.BROWSER_KEEP_ALIVE_MS ?? '0', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_KEEP_ALIVE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Connects to an idle session if there is one to have. */
async function reuseIdleSession(puppeteer: any): Promise<BrowserLease | null> {
  const binding = env.BROWSER;

  try {
    const sessions = (await puppeteer.sessions(binding)) as Array<{
      sessionId: string;
      connectionId?: string;
    }>;

    // A session with a connectionId is busy serving someone else.
    const free = sessions.filter((session) => !session.connectionId);

    // Start at a random offset so concurrent isolates do not all race for the
    // same session and fall back to launching in lockstep.
    const offset = free.length > 1 ? Math.floor(Math.random() * free.length) : 0;

    for (let i = 0; i < Math.min(free.length, MAX_CONNECT_ATTEMPTS); i++) {
      const session = free[(offset + i) % free.length]!;
      try {
        const browser = await puppeteer.connect(binding, session.sessionId);
        console.log(`[browser] reused session ${session.sessionId} (${free.length} idle)`);
        return { browser, reused: true, sessionId: session.sessionId };
      } catch {
        // Claimed or torn down in the meantime — try the next one.
      }
    }
  } catch (error) {
    // Session listing is an optimisation; never let it block a capture. The
    // local dev runtime, for one, does not implement it.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[browser] session reuse unavailable (${message}); launching`);
  }
  return null;
}

async function launchBrowser(puppeteer: any): Promise<BrowserLease> {
  const keepAlive = keepAliveMs();
  const browser = await puppeteer.launch(env.BROWSER, keepAlive > 0 ? { keep_alive: keepAlive } : undefined);
  return { browser, reused: false };
}

/**
 * Returns a browser to render with, reusing an idle session when one exists and
 * launching a fresh one otherwise.
 */
export async function acquireBrowser(puppeteer: any): Promise<BrowserLease> {
  for (let attempt = 1; ; attempt++) {
    const reused = await reuseIdleSession(puppeteer);
    if (reused) return reused;

    try {
      return await launchBrowser(puppeteer);
    } catch (error) {
      // Running out of concurrent sessions is the one launch failure worth
      // waiting out, and worth naming: the raw error is opaque, and with
      // keep-alive enabled it is self-inflicted.
      const limits =
        typeof puppeteer.limits === 'function' ? await puppeteer.limits(env.BROWSER).catch(() => null) : null;
      if (!limits || limits.allowedBrowserAcquisitions !== 0) throw error;

      if (attempt < LAUNCH_ATTEMPTS) {
        await sleep(LAUNCH_RETRY_MS + Math.random() * LAUNCH_RETRY_JITTER_MS);
        continue;
      }

      const active = limits.activeSessions?.length ?? 0;
      throw new HttpError(
        503,
        'browser_unavailable',
        `All ${limits.maxConcurrentSessions} browser sessions are in use (${active} active). ` +
          (keepAliveMs() > 0
            ? 'Idle sessions are being held open by BROWSER_KEEP_ALIVE_MS; lower or disable it if this persists.'
            : 'Retry shortly, or raise the concurrency limit on your Cloudflare account.'),
      );
    }
  }
}

/**
 * Hands the session back.
 *
 * A successful capture may leave the session warm when keep-alive is enabled.
 * A failed one always closes: a browser that just errored is not worth paying
 * to keep, and may be in a bad state.
 */
export async function releaseBrowser(lease: BrowserLease, succeeded: boolean): Promise<void> {
  const keepWarm = succeeded && keepAliveMs() > 0;
  try {
    if (keepWarm) await lease.browser.disconnect();
    else await lease.browser.close();
  } catch (error) {
    console.error('[browser] failed to release session', error);
  }
}

export interface PageLease {
  lease: BrowserLease;
  /** The capture's own browser context; null when the browser would not make one. */
  context: any | null;
  page: any;
}

/**
 * A page in a browser context of its own.
 *
 * The default context is shared by everything a session ever opens, and a
 * session kept warm with BROWSER_KEEP_ALIVE_MS outlives the request: cookies,
 * localStorage and HTTP auth set during one customer's capture would still be
 * there for the next customer's. A fresh context starts empty and is thrown
 * away with the page.
 */
async function openIsolatedPage(browser: any): Promise<{ context: any | null; page: any }> {
  const create =
    typeof browser.createBrowserContext === 'function'
      ? browser.createBrowserContext
      : typeof browser.createIncognitoBrowserContext === 'function'
        ? browser.createIncognitoBrowserContext
        : null;

  let context: any = null;
  if (create) {
    try {
      context = await create.call(browser);
    } catch (error) {
      console.error('[browser] could not create a browser context; using the default one', error);
    }
  }
  if (!context) return { context: null, page: await browser.newPage() };

  try {
    return { context, page: await context.newPage() };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Acquires a browser and opens an isolated page in it.
 *
 * A session can be listed as idle and still be on its way out, torn down by the
 * platform between listing and use. A page that will not open on a reused
 * session is therefore worth one fresh launch; one that will not open on a
 * fresh launch is a real failure.
 */
export async function openPage(puppeteer: any): Promise<PageLease> {
  const lease = await acquireBrowser(puppeteer);
  try {
    return { lease, ...(await openIsolatedPage(lease.browser)) };
  } catch (error) {
    await releaseBrowser(lease, false);
    if (!lease.reused) throw error;
    console.log('[browser] reused session could not open a page; launching a fresh one');
  }

  const fresh = await launchBrowser(puppeteer);
  try {
    return { lease: fresh, ...(await openIsolatedPage(fresh.browser)) };
  } catch (error) {
    await releaseBrowser(fresh, false);
    throw error;
  }
}

/**
 * Closes the page and its context, then hands the session back.
 *
 * A session whose page ran in the default context is never kept warm, however
 * the capture went: whatever that page stored is still in there.
 */
export async function closePage(session: PageLease, succeeded: boolean): Promise<void> {
  try {
    await session.page.close();
  } catch {
    /* the session may already be gone */
  }
  if (session.context) {
    try {
      await session.context.close();
    } catch {
      /* closing the browser below takes it along */
    }
  }
  await releaseBrowser(session.lease, succeeded && session.context !== null);
}
