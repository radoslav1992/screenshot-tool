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

export function keepAliveMs(): number {
  const raw = Number.parseInt(env.BROWSER_KEEP_ALIVE_MS ?? '0', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_KEEP_ALIVE_MS);
}

/**
 * Returns a browser to render with, reusing an idle session when one exists and
 * launching a fresh one otherwise.
 */
export async function acquireBrowser(puppeteer: any): Promise<BrowserLease> {
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

  const keepAlive = keepAliveMs();
  try {
    const browser = await puppeteer.launch(binding, keepAlive > 0 ? { keep_alive: keepAlive } : undefined);
    return { browser, reused: false };
  } catch (error) {
    // Running out of concurrent sessions is the one launch failure worth naming:
    // the raw error is opaque, and with keep-alive enabled it is self-inflicted.
    const limits = await puppeteer.limits(binding).catch(() => null);
    if (limits && limits.allowedBrowserAcquisitions === 0) {
      const active = limits.activeSessions?.length ?? 0;
      throw new HttpError(
        503,
        'browser_unavailable',
        `All ${limits.maxConcurrentSessions} browser sessions are in use (${active} active). ` +
          (keepAlive > 0
            ? 'Idle sessions are being held open by BROWSER_KEEP_ALIVE_MS; lower or disable it if this persists.'
            : 'Retry shortly, or raise the concurrency limit on your Cloudflare account.'),
      );
    }
    throw error;
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
