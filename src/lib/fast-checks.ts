import { env } from 'cloudflare:workers';
import { browserIdentity, type ViewportId } from './capture-options';
import { FetchFailure, charsetOf, fetchPublic, readCapped } from './safe-fetch';
import { extractFast, normaliseText, priceNumbers, seoValues, type FastRead, type FastReading, type FastUnavailable, type RawPage } from './fast-extract';
import { evaluateRule, type MonitorRule } from './monitor-rules';
import { compareSeo, decodeSeoSignals, robotsState } from './seo-signals';
import type { PageFacts } from './page-facts';

/**
 * Smart checks: each rule-based monitor checked the cheapest way that still
 * gives the right answer.
 *
 * A text, phrase, price, element or SEO rule watches a few values, and most
 * checks find them unchanged. So such a monitor reads its page's HTML with a
 * plain request first (fast-extract.ts) and renders it in the browser — one
 * screenshot from the quota — only when that reading changed. The reading is a
 * gate, not a judge: the browser check that follows is the one there has always
 * been, and it alone decides whether to alert.
 *
 * Whether the gate can be trusted is learned per monitor, in a row of
 * watch_fast_checks (migration 0016):
 *
 * - learning — every check reads the HTML and renders. A check agrees when the
 *   reading changed exactly when the browser's facts did, and the reading says
 *   what the browser saw. Three agreements and the monitor goes fast. A change
 *   the reading missed sends it to the browser at once; two readings that
 *   disagree with the page, two unavailable readings, or three that changed
 *   when the browser saw nothing, do too.
 * - fast — a check reads the HTML; unchanged, it records a run and spends
 *   nothing; changed, it renders as before. A full check also runs once a
 *   week as a safety net, judged as a learning check is. Three unavailable
 *   readings in a row send the monitor to the browser.
 * - browser — every check renders, as before. The owner can try fast checks
 *   again, which starts learning afresh.
 *
 * The owner can also choose "Always use a full browser" (`forced`). Visual
 * monitors compare screenshots, so they always render and never get a row.
 *
 * The signature kept is the reading taken with the last full check, so the
 * gate always asks "has anything changed since the browser last looked?". A
 * reading the browser did not confirm is not kept: the page may simply not
 * have reached the browser yet (a cache, a deploy in progress), and keeping it
 * would hide the change from every check after.
 *
 * Without the table every monitor runs exactly as it did before.
 */

/** Agreements a learning monitor needs before it goes fast. */
export const AGREEMENTS_NEEDED = 3;
/** Learning checks whose reading disagreed with the rendered page, before the browser takes over. */
const MISMATCH_LIMIT = 2;
/** Learning checks whose reading changed while the browser saw nothing. */
const NOISE_LIMIT = 3;
/** Fast checks in a row whose reading changed while the browser saw nothing, before learning again. */
const FAST_NOISE_LIMIT = 2;
/** Unavailable readings while learning (in all), and once fast (in a row). */
const LEARNING_UNAVAILABLE_LIMIT = 2;
const FAST_UNAVAILABLE_LIMIT = 3;
/** A fast monitor's safety net: a full check at least this often. */
export const SAFETY_NET_MS = 7 * 24 * 3_600_000;

/** The plain request a fast check makes. */
export const FAST_FETCH = { maxRedirects: 5, maxBytes: 3_000_000, timeoutMs: 10_000 };

/** The run detail of a fast check that found nothing changed. */
export const FAST_UNCHANGED = 'No change · read the page, no screenshot needed';

export type FastMode = 'learning' | 'fast' | 'browser';

export interface FastCheckRow {
  watch_id: string;
  mode: FastMode;
  forced: number;
  signature: string | null;
  agreements: number;
  mismatches: number;
  noise: number;
  unavailable: number;
  last_full_at: string | null;
  reason: string | null;
  updated_at: string;
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/** Cached per isolate like watchSettingsReady: a yes for good, a no for a minute. */
let fastTable: { ready: boolean; at: number } | undefined;
export async function fastChecksReady(): Promise<boolean> {
  if (fastTable && (fastTable.ready || Date.now() - fastTable.at < 60_000)) return fastTable.ready;
  const ready = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='watch_fast_checks'").first());
  fastTable = { ready, at: Date.now() };
  return ready;
}

export async function getFastCheck(watchId: string): Promise<FastCheckRow | null> {
  return env.DB.prepare('SELECT * FROM watch_fast_checks WHERE watch_id = ?').bind(watchId).first<FastCheckRow>();
}

export function newFastCheck(watchId: string, now = new Date()): FastCheckRow {
  return {
    watch_id: watchId,
    mode: 'learning',
    forced: 0,
    signature: null,
    agreements: 0,
    mismatches: 0,
    noise: 0,
    unavailable: 0,
    last_full_at: null,
    reason: null,
    updated_at: now.toISOString(),
  };
}

/** The row for a monitor, created as learning the first time it is asked for. */
export async function fastCheckFor(watchId: string, now = new Date()): Promise<FastCheckRow> {
  const fresh = newFastCheck(watchId, now);
  const inserted = await env.DB.prepare(
    `INSERT INTO watch_fast_checks (watch_id, mode, updated_at) SELECT ?, 'learning', ?
     WHERE EXISTS (SELECT 1 FROM watches WHERE id = ?) ON CONFLICT(watch_id) DO NOTHING RETURNING *`,
  )
    .bind(watchId, fresh.updated_at, watchId)
    .first<FastCheckRow>();
  return inserted ?? (await getFastCheck(watchId)) ?? fresh;
}

/**
 * Writes a row a check decided on, unless the owner changed it while the check
 * ran: their "Always use a full browser" or "Try fast checks again" wins.
 * True when it was written.
 */
export async function saveFastCheck(row: FastCheckRow, readAt: string): Promise<boolean> {
  const result = await fastCheckStatement(row, readAt).run();
  return Boolean(result.meta.changes);
}

/** saveFastCheck's write, for a caller that batches it with its own. */
export function fastCheckStatement(row: FastCheckRow, readAt: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE watch_fast_checks SET mode = ?, signature = ?, agreements = ?, mismatches = ?, noise = ?, unavailable = ?,
       last_full_at = ?, reason = ?, updated_at = ?
     WHERE watch_id = ? AND updated_at = ?`,
  ).bind(
    row.mode,
    row.signature,
    row.agreements,
    row.mismatches,
    row.noise,
    row.unavailable,
    row.last_full_at,
    row.reason,
    row.updated_at,
    row.watch_id,
    readAt,
  );
}

/** Learning again from nothing, keeping the owner's choice. A changed rule needs this: the old trust was for another rule. */
export async function resetFastCheck(watchId: string, now = new Date()): Promise<void> {
  await env.DB.prepare(
    `UPDATE watch_fast_checks SET mode = 'learning', signature = NULL, agreements = 0, mismatches = 0, noise = 0,
       unavailable = 0, last_full_at = NULL, reason = NULL, updated_at = ? WHERE watch_id = ?`,
  )
    .bind(now.toISOString(), watchId)
    .run();
}

/** The owner's "Always use a full browser". */
export async function setForced(watchId: string, forced: boolean, now = new Date()): Promise<void> {
  await fastCheckFor(watchId, now);
  await env.DB.prepare('UPDATE watch_fast_checks SET forced = ?, updated_at = ? WHERE watch_id = ?')
    .bind(forced ? 1 : 0, now.toISOString(), watchId)
    .run();
}

/* -------------------------------------------------------------------------- */
/* How a monitor is checked                                                    */
/* -------------------------------------------------------------------------- */

/** What the API and the monitor page say about how a monitor is checked. */
export type CheckMode = 'fast' | 'learning' | 'browser' | 'forced' | 'visual';

export interface CheckStatus {
  mode: CheckMode;
  reason: string | null;
  /** Learning agreements so far, of AGREEMENTS_NEEDED. */
  agreements: number;
}

export function checkStatus(ruleKind: string, row: FastCheckRow | null, ready: boolean): CheckStatus {
  if (ruleKind === 'visual') return { mode: 'visual', reason: null, agreements: 0 };
  if (!ready) return { mode: 'browser', reason: null, agreements: 0 };
  if (row?.forced) return { mode: 'forced', reason: null, agreements: 0 };
  const mode = row?.mode ?? 'learning';
  return { mode, reason: mode === 'browser' ? row?.reason ?? null : null, agreements: mode === 'learning' ? row?.agreements ?? 0 : 0 };
}

/** Each monitor's check status, for a list of them: two queries, whatever the count. */
export async function checkStatuses(watchIds: string[], ruleKinds: Map<string, string>): Promise<Map<string, CheckStatus>> {
  const ready = await fastChecksReady();
  const rows = new Map<string, FastCheckRow>();
  if (ready && watchIds.length) {
    // D1 binds at most 100 values a statement.
    for (let at = 0; at < watchIds.length; at += 90) {
      const ids = watchIds.slice(at, at + 90);
      const { results } = await env.DB.prepare(
        `SELECT * FROM watch_fast_checks WHERE watch_id IN (${ids.map(() => '?').join(',')})`,
      )
        .bind(...ids)
        .all<FastCheckRow>();
      for (const row of results ?? []) rows.set(row.watch_id, row);
    }
  }
  return new Map(watchIds.map((id) => [id, checkStatus(ruleKinds.get(id) ?? 'visual', rows.get(id) ?? null, ready)]));
}

/**
 * Whether a fast monitor's next check is its weekly full one. Measured in
 * whole hours, so a weekly monitor checked at 10:00:05 one week and 10:00:03
 * the next is still a week apart.
 */
export function safetyNetDue(row: Pick<FastCheckRow, 'last_full_at'>, now = new Date()): boolean {
  if (!row.last_full_at) return true;
  const hour = (ms: number) => Math.floor(ms / 3_600_000);
  return hour(now.getTime()) - hour(Date.parse(row.last_full_at)) >= SAFETY_NET_MS / 3_600_000;
}

/**
 * How this check runs. `gate` reads first and renders only on a change;
 * `learning` and `safety` read and render and judge the reading; `browser`
 * is a check as it always was.
 */
export type CheckMethod = 'browser' | 'learning' | 'safety' | 'gate';

export function checkMethod(row: FastCheckRow, hasBaseline: boolean, now = new Date()): CheckMethod {
  if (row.forced || row.mode === 'browser') return 'browser';
  if (row.mode === 'learning') return 'learning';
  // Without a signature or a baseline there is nothing to gate against: the full check takes both again.
  if (!row.signature || !hasBaseline || safetyNetDue(row, now)) return 'safety';
  return 'gate';
}

/* -------------------------------------------------------------------------- */
/* Reading the page                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Handhelds send the user agent the browser sends for them (browserIdentity),
 * so a server that picks its HTML by device sends the phone page to both.
 * Desktop keeps the browser's own string in a capture; a plain request has none
 * to keep, so it says what it is, the way crawlers do, and gets the desktop page.
 */
const DESKTOP_AGENT = 'Mozilla/5.0 (compatible; EasyScreenCapture/1; +https://easyscreencapture.com)';

const FETCH_REASONS: Record<FetchFailure['problem'], FastUnavailable> = {
  timeout: { ok: false, code: 'timeout', reason: 'The page did not answer a plain request within 10 seconds' },
  interrupted: { ok: false, code: 'interrupted', reason: 'The page stopped answering partway through' },
  unreachable: { ok: false, code: 'unreachable', reason: 'The page could not be reached with a plain request' },
  too_many_redirects: { ok: false, code: 'redirects', reason: 'The page redirects more times than a plain request follows' },
  bad_redirect: { ok: false, code: 'redirects', reason: 'The page redirects somewhere a plain request cannot follow' },
  blocked_redirect: { ok: false, code: 'redirects', reason: 'The page redirects somewhere a plain request cannot follow' },
  too_large: { ok: false, code: 'too_large', reason: 'The page is larger than the 3 MB a fast check reads' },
};

/**
 * The page's HTML, fetched as safely as a sitemap is (safe-fetch.ts): every
 * redirect hop checked for a public address and against the denylist, ten
 * seconds for the whole of it, and nothing read past the byte cap.
 *
 * Monitors carry no credentials (watches.ts, optionsFor), so none are sent. If
 * they ever do, a monitor with them belongs on the browser path, which scopes
 * them to the page's own origin.
 */
export async function fetchPage(
  url: string,
  device: string,
  limits: { maxRedirects: number; maxBytes: number; timeoutMs: number } = FAST_FETCH,
): Promise<(RawPage & { ok: true }) | FastUnavailable> {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  try {
    const { response, url: final } = await fetchPublic(url, {
      maxRedirects: limits.maxRedirects,
      signal: () => deadline,
      headers: {
        'user-agent': browserIdentity(device as ViewportId).userAgent ?? DESKTOP_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    const type = response.headers.get('content-type');
    // Only a page is worth reading; anything else is judged on its headers alone.
    const html = !type || /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type);
    const body = html ? await readCapped(response, limits.maxBytes, 'truncate', charsetOf(type)) : null;
    if (!html) await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      html: body?.text ?? '',
      status: response.status,
      headers: response.headers,
      url: final.toString(),
      truncated: body?.truncated ?? false,
    };
  } catch (error) {
    if (error instanceof FetchFailure) return FETCH_REASONS[error.problem];
    // The address itself no longer passes the capture checks: the denylist changed since the monitor was saved.
    return { ok: false, code: 'blocked', reason: 'The page’s address cannot be fetched with a plain request' };
  }
}

/** Fetches and reads what the rule watches. Never throws: anything that goes wrong is "unavailable". */
export async function readPage(watch: { url: string; device: string }, rule: MonitorRule, hide: string[]): Promise<FastRead> {
  try {
    const page = await fetchPage(watch.url, watch.device);
    if (!page.ok) return page;
    return await extractFast(rule, page, { hide });
  } catch {
    return { ok: false, code: 'unreadable', reason: 'The page’s HTML could not be read' };
  }
}

/* -------------------------------------------------------------------------- */
/* The browser's side                                                          */
/* -------------------------------------------------------------------------- */

/** Whether a capture's text holds a phrase; null when only a partial excerpt was kept and it was not found there. */
function presence(facts: PageFacts, phrase: string): boolean | null {
  const key = normaliseText(phrase).toLowerCase();
  const recorded = Object.entries(facts.phrases ?? {}).find(([name]) => normaliseText(name).toLowerCase() === key);
  if (recorded) return recorded[1] === true;
  if (typeof facts.text !== 'string') return null;
  if (normaliseText(facts.text).toLowerCase().includes(key)) return true;
  return (facts.text_length ?? 0) > facts.text.length ? null : false;
}

/** The watched element's text, when the capture found it for this selector. */
function elementText(facts: PageFacts, selector: string): string | null {
  const element = facts.monitored_element;
  return element && element.selector === selector && element.found ? normaliseText(element.text) : null;
}

/**
 * Whether what the rule watches changed between two of the browser's own
 * captures — in either direction, which is what keeps a gate and its baseline
 * in step: a phrase rule's baseline has to follow the phrase going as well as
 * coming. Null when the captures cannot say.
 */
export function browserChanged(rule: MonitorRule, before: PageFacts | null, after: PageFacts | null): boolean | null {
  if (!before || !after) return null;
  if (rule.kind === 'seo') {
    if (!before.seo || !after.seo) return null;
    return compareSeo(before, after, rule.selector).changed;
  }
  if (rule.kind === 'appeared' || rule.kind === 'disappeared') {
    const was = presence(before, rule.phrase);
    const is = presence(after, rule.phrase);
    return was === null || is === null ? null : was !== is;
  }
  if (rule.kind === 'price' || rule.kind === 'element') {
    const was = elementText(before, rule.selector);
    const is = elementText(after, rule.selector);
    if (was === null || is === null) return null;
    return rule.kind === 'price' ? priceNumbers(was) !== priceNumbers(is) : was !== is;
  }
  if (rule.kind === 'text') {
    if (typeof before.text !== 'string' || typeof after.text !== 'string') return null;
    try {
      return evaluateRule(rule, before, after).changed;
    } catch {
      return null;
    }
  }
  return null;
}

/** Under half the text the browser shows means scripts write most of the page. */
const TEXT_COVERAGE = 0.5;

/**
 * Whether a reading says what the browser saw at the same moment. Not a
 * comparison for alerting — raw HTML and a rendered page are never compared
 * for that — but for trust: a phrase present on screen and absent from the
 * HTML, a price the HTML leaves blank, a title a script sets, all mean the
 * gate could be blind to the change that matters. Null when the capture
 * cannot say.
 */
export function readingMatches(rule: MonitorRule, read: FastReading, facts: PageFacts | null): boolean | null {
  if (!facts) return null;
  if (rule.kind === 'appeared' || rule.kind === 'disappeared') {
    const shown = presence(facts, rule.phrase);
    return shown === null ? null : shown === read.values.found;
  }
  if (rule.kind === 'price' || rule.kind === 'element') {
    const shown = elementText(facts, rule.selector);
    if (shown === null) return null;
    return rule.kind === 'price' ? priceNumbers(shown) === read.values.numbers : shown === read.values.text;
  }
  if (rule.kind === 'text') {
    const shown = facts.text_length ?? (typeof facts.text === 'string' ? facts.text.length : null);
    return shown === null ? null : read.textLength >= shown * TEXT_COVERAGE;
  }
  if (rule.kind === 'seo') {
    if (!facts.seo) return null;
    const shown = seoValues(facts.seo, decodeSeoSignals(rule.selector));
    // A heading hidden by a stylesheet is in the HTML and not on screen, so counts can differ honestly.
    const same = (key: string) => JSON.stringify(shown[key]) === JSON.stringify(read.values[key]);
    return Object.keys(shown).every((key) => {
      if (key === 'h1_count') return true;
      if (key === 'h1') return shown.h1_count !== read.values.h1_count || same(key);
      return same(key);
    });
  }
  return null;
}

/**
 * The note an SEO monitor's browser check adds when the page's HTML and the
 * rendered page disagree about the canonical or noindex — the signals crawlers
 * that run no JavaScript read straight from the HTML. Never an alert.
 */
export function seoNote(rule: MonitorRule, read: FastRead | null, facts: PageFacts | null): string | null {
  if (rule.kind !== 'seo' || !read?.ok || !read.html || !facts?.seo) return null;
  const watched = decodeSeoSignals(rule.selector);
  const notes: string[] = [];
  const rendered = Boolean(normaliseText(facts.seo.canonical ?? ''));
  const raw = Boolean(read.html.canonical);
  if (watched.includes('canonical') && rendered !== raw) {
    notes.push(
      rendered
        ? 'Note: the canonical link is only added by JavaScript; crawlers that don’t run JavaScript won’t see it.'
        : 'Note: the canonical link is in the page’s HTML but JavaScript removes it; crawlers that don’t run JavaScript still use it.',
    );
  }
  const shownNoindex = robotsState(facts.seo.robots ?? '').noindex;
  if (watched.includes('robots') && shownNoindex !== read.html.noindex) {
    notes.push(
      shownNoindex
        ? 'Note: noindex is only added by JavaScript; crawlers that don’t run JavaScript won’t see it.'
        : 'Note: the page’s HTML says noindex and JavaScript removes it; crawlers that don’t run JavaScript still see noindex.',
    );
  }
  return notes.length ? notes.join(' ') : null;
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                    */
/* -------------------------------------------------------------------------- */

/** What one check found, for nextFastCheck to learn from. */
export type CheckStep =
  /** The gate read nothing new: a run with no screenshot. */
  | { kind: 'unchanged' }
  /** The gate read a change but no screenshots were left to confirm it; it is read again next time. */
  | { kind: 'spotted' }
  /** A full check finished alongside a reading. */
  | {
      kind: 'rendered';
      method: Exclude<CheckMethod, 'browser'>;
      read: FastRead;
      /** Whether the browser's facts for the rule changed since its last capture (browserChanged). */
      changed: boolean | null;
      /** Whether the reading said what the browser saw (readingMatches). */
      matches: boolean | null;
    };

export interface FastDecision {
  row: FastCheckRow;
  /** Set when this check moved the monitor to a full browser on every check: why, for the owner. */
  toBrowser?: string;
}

const JS_REASON = (rule: MonitorRule) =>
  rule.kind === 'seo'
    ? 'This page sets its SEO tags with JavaScript, so it needs a full browser'
    : 'This page builds its content with JavaScript, so it needs a full browser';
const NOISE_REASON = 'This page’s HTML changes on every visit when nothing on screen does, so reading it first saves no screenshots';

/**
 * The row after one check. Pure: everything it needs is passed in, which is
 * what lets the learning rules be tested without a database or a browser.
 */
export function nextFastCheck(row: FastCheckRow, step: CheckStep, rule: MonitorRule, now = new Date()): FastDecision {
  const at = now.toISOString();
  const next: FastCheckRow = { ...row, updated_at: at };
  const browser = (reason: string): FastDecision => ({
    row: { ...next, mode: 'browser', reason, signature: null, agreements: 0, mismatches: 0, noise: 0, unavailable: 0 },
    toBrowser: reason,
  });
  const learnAgain = (signature: string | null, mismatches = 0): FastDecision => ({
    row: { ...next, mode: 'learning', signature, agreements: 0, mismatches, noise: 0, unavailable: 0, reason: null },
  });

  if (step.kind === 'unchanged') return { row: { ...next, noise: 0, unavailable: 0 } };
  if (step.kind === 'spotted') return { row: { ...next, unavailable: 0 } };

  const { method, read, changed, matches } = step;
  next.last_full_at = at;

  if (!read.ok) {
    next.unavailable = row.unavailable + 1;
    if (method === 'learning') {
      next.signature = null;
      return next.unavailable >= LEARNING_UNAVAILABLE_LIMIT ? browser(read.reason) : { row: next };
    }
    // The kept signature still describes the page if the browser saw nothing change; otherwise the next check takes it again.
    if (changed !== false) next.signature = null;
    return next.unavailable >= FAST_UNAVAILABLE_LIMIT ? browser(read.reason) : { row: next };
  }

  const previous = row.signature;
  const readChanged = previous === null ? null : read.signature !== previous;

  if (method === 'learning') {
    next.signature = read.signature;
    // A change the reading missed is the one failure a gate cannot have.
    if (changed === true && readChanged === false) return browser(JS_REASON(rule));
    if (matches === false) {
      next.mismatches = row.mismatches + 1;
      return next.mismatches >= MISMATCH_LIMIT ? browser(JS_REASON(rule)) : { row: next };
    }
    if (changed === null || readChanged === null) return { row: next };
    if (readChanged && !changed) {
      next.noise = row.noise + 1;
      return next.noise >= NOISE_LIMIT ? browser(NOISE_REASON) : { row: next };
    }
    next.agreements = row.agreements + 1;
    if (next.agreements >= AGREEMENTS_NEEDED) {
      return { row: { ...next, mode: 'fast', mismatches: 0, noise: 0, unavailable: 0, reason: null } };
    }
    return { row: next };
  }

  // Fast: a safety-net check, or the render a changed reading asked for.
  next.unavailable = 0;
  if (changed === true && readChanged === false) return browser(JS_REASON(rule));
  // The page's HTML has stopped saying what the browser shows: learn again rather than trust it.
  if (matches === false) return learnAgain(read.signature, 1);
  if (readChanged === true && changed === false) {
    // Not confirmed: keep the signature the browser agrees with, so the change is looked for again.
    next.noise = row.noise + 1;
    return next.noise >= FAST_NOISE_LIMIT ? learnAgain(read.signature) : { row: next };
  }
  next.signature = read.signature;
  next.noise = 0;
  return { row: next };
}
