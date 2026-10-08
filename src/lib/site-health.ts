import { env } from 'cloudflare:workers';
import { toSessionUser, type UserRow } from './auth';
import { assertPublicCaptureUrl } from './capture-options';
import { formatDate, formatDateTime } from './dates';
import { isChallenge } from './fast-extract';
import { prefixedId } from './ids';
import { checkLink, extractLinks, type LinkVerdict, type PageLink } from './link-check';
import { canSendEmail, sendMail } from './mailer';
import { DOMAIN_CHECK_HOURS, LINK_CHECK_HOURS, LINKS_PER_PAGE, SSL_CHECK_HOURS, uptimeMinutes } from './plans';
import { checkDomain, type DomainReading } from './rdap';
import { FetchFailure, charsetOf, fetchPublic, readCapped } from './safe-fetch';
import { originOf, siteHealthAvailable, uptimePct } from './site-health-summary';
import { certificateCovers, issuerName, probeCertificate, type Certificate, type ProbeResult } from './tls-probe';
import { trialColumns } from './trial-plan';

/**
 * Site health: for the sites behind each account's monitors, whether they are
 * up, when their certificate and domain registration run out, and which links
 * on the monitored pages are broken (migration 0020).
 *
 * A site is an origin, scheme://host, of at least one active monitor. Uptime,
 * SSL and domain are checked per account and site; links per monitored page.
 * The hourly sweep keeps the list of sites in step with the monitors, in SQL,
 * so it costs a few statements however many there are.
 *
 * Every check is due by its own next_*_at and taken a bounded number per
 * tick, the rest waiting for the next one, as the monitor sweep does. Within
 * a tick, identical requests are made once: fifty accounts watching the same
 * site cost one uptime request, one certificate read, one registry lookup and
 * one request per link, and each account still gets its own results.
 *
 * Every request to a customer's site goes through fetchPublic (safe-fetch.ts):
 * no private addresses, every redirect hop checked, a timeout, a byte cap, no
 * cookies or credentials, and a user agent that says what is asking.
 *
 * Emails follow the monitors' own setting: if any active monitor on a site has
 * email alerts on, its owner hears about that site. Each is claimed in the
 * database before it is sent, so it goes at most once per change of state.
 * Broken links are never emailed; the monitor page and the care report show
 * them. Before migration 0020 nothing here runs or shows.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Two down checks in a row open an incident, so a single dropped request never alerts anyone. */
export const INCIDENT_AFTER = 2;
export const UPTIME_TIMEOUT_MS = 10_000;
/** Sites one uptime tick takes, and how many it asks at once. */
export const UPTIME_PER_TICK = 300;
const UPTIME_CONCURRENCY = 8;
/** A tick stops taking sites after this long; the rest are handed back for the next tick. */
const UPTIME_BUDGET_MS = 4 * 60_000;
/** How long a tick holds the sites it took. Shorter than a quarter hour, so a tick that died is retried at the next. */
const UPTIME_LEASE_MS = 10 * 60_000;

export const SSL_PER_TICK = 120;
const SSL_CONCURRENCY = 4;
export const DOMAIN_PER_TICK = 100;
const DOMAIN_CONCURRENCY = 3;
/** Pages whose links one hourly sweep checks, and the requests it may make for them, redirects included. */
export const LINK_PAGES_PER_TICK = 30;
export const LINK_REQUESTS_PER_TICK = 2_000;
const LINK_CONCURRENCY = 6;
/** Each of the hourly checks stops taking work after this long. */
const SWEEP_BUDGET_MS = 4 * 60_000;
const SWEEP_LEASE_MS = 30 * 60_000;
/** A page or registry that could not be read is tried again after a day rather than a week. */
const RETRY_HOURS = 24;
const PAGE_MAX_BYTES = 2_000_000;

export const SSL_EXPIRING_DAYS = 14;
export const SSL_URGENT_DAYS = 3;
export const DOMAIN_URGENT_DAYS = 7;

/** Rollups, incidents and fixed links are kept 13 months, so a year-on-year care report still has last year's month. */
export const RETENTION_DAYS = 395;
const PRUNE_BATCH = 1_000;
/** Rollup batches per hour: up to 5,000 rows, enough for 5,000 sites' worth of new hours each hour. */
const PRUNE_ROUNDS = 5;

const AGENT = 'Mozilla/5.0 (compatible; EasyScreenCapture-SiteHealth/1; +https://easyscreencapture.com/privacy)';

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The next multiple of `minutes` after `now`: 15-minute checks land on the quarter ticks, hourly ones on the hour. */
export function nextUptimeAt(now: Date, minutes: number): string {
  const step = minutes * 60_000;
  return new Date(Math.floor((now.getTime() + step) / step) * step).toISOString();
}

/** `hours` from now, on the hour: the sweep runs at hh:00 and must find it due. */
function hoursFrom(now: Date, hours: number): string {
  return new Date(Math.floor((now.getTime() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS).toISOString();
}

const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS).toISOString();
const daysUntil = (iso: string, now: Date) => Math.floor((Date.parse(iso) - now.getTime()) / DAY_MS);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A stored monitor URL's origin, in SQL. Monitor URLs are stored as
 * `URL.toString()`, which always puts a path after the host, so the origin is
 * everything before the first `/` after `://`, and equals `new URL(url).origin`.
 */
export function originSql(column: string): string {
  const rest = `substr(${column}, instr(${column}, '://') + 3)`;
  return `(CASE WHEN instr(${rest}, '/') > 0 THEN substr(${column}, 1, instr(${column}, '://') + instr(${rest}, '/') + 1) ELSE ${column} END)`;
}

/** At most `width` at once over `items`, stopping when `stop()` says so; returns how many were not started. */
async function lanes<T>(items: T[], width: number, work: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<number> {
  let next = 0;
  let left = 0;
  const lane = async () => {
    for (let item = items[next++]; item !== undefined; item = items[next++]) {
      if (stop()) {
        left += 1 + Math.max(0, items.length - next);
        next = items.length;
        return;
      }
      await work(item).catch((error) => console.error('[site-health] check failed', error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return left;
}

/** One request per key in a tick, shared by every account that needs it. */
function once<T>(make: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const made = new Map<string, Promise<T>>();
  return (key) => {
    let promise = made.get(key);
    if (!promise) {
      promise = make(key);
      made.set(key, promise);
    }
    return promise;
  };
}

/** The plan each account acts on, a Pro trial included, as toSessionUser decides it: one query per 90 accounts. */
async function uptimeIntervals(userIds: string[]): Promise<Map<string, 15 | 60>> {
  const trial = await trialColumns();
  const intervals = new Map<string, 15 | 60>();
  const ids = [...new Set(userIds)];
  for (let at = 0; at < ids.length; at += 90) {
    const chunk = ids.slice(at, at + 90);
    const { results } = await env.DB.prepare(`SELECT u.*${trial.select} FROM users u${trial.join} WHERE u.id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<UserRow>();
    for (const row of results ?? []) intervals.set(row.id, uptimeMinutes(toSessionUser(row).plan));
  }
  return intervals;
}

/* -------------------------------------------------------------------------- */
/* Which sites                                                                 */
/* -------------------------------------------------------------------------- */

export interface SyncResult {
  /** Site rows added, brought back or given a new first page. */
  sites: number;
  /** Sites no active monitor uses any more. */
  stopped: number;
  /** Monitored pages given a link check. */
  pages: number;
}

/**
 * Brings the site list in step with the active monitors: every origin gets a
 * row (its first checks due now) with its oldest monitor's page as the uptime
 * URL; a site no monitor uses any more stops being checked, and an incident it
 * had open is closed without an email; every monitored page gets a link check.
 * Four statements in one batch, all on the server.
 */
export async function syncSites(now = new Date()): Promise<SyncResult> {
  if (!(await siteHealthAvailable())) return { sites: 0, stopped: 0, pages: 0 };
  const at = now.toISOString();
  const unused = (site: string) =>
    `${site}.active = 1 AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.user_id = ${site}.user_id AND w.status = 'active' AND ${originSql('w.url')} = ${site}.origin)`;
  const [sites, , stopped, pages] = await env.DB.batch([
    // SQLite returns `url` from the row MIN() picked: the oldest active monitor on the origin.
    env.DB.prepare(
      `INSERT INTO site_health_sites (user_id, origin, url, created_at, uptime_next_at, ssl_next_at, domain_next_at)
       SELECT user_id, site, url, ?1, ?1, ?1, ?1 FROM (
         SELECT user_id, ${originSql('url')} AS site, url, MIN(created_at) FROM watches WHERE status = 'active' GROUP BY user_id, site
       ) WHERE true
       ON CONFLICT(user_id, origin) DO UPDATE SET url = excluded.url, active = 1,
         uptime_next_at = CASE WHEN site_health_sites.active = 0 THEN excluded.uptime_next_at ELSE site_health_sites.uptime_next_at END
       WHERE site_health_sites.active = 0 OR site_health_sites.url <> excluded.url`,
    ).bind(at),
    env.DB.prepare(
      `UPDATE site_uptime_incidents SET ended_at = ?1 WHERE ended_at IS NULL AND id IN (
         SELECT s.uptime_incident_id FROM site_health_sites s WHERE ${unused('s')} AND s.uptime_incident_id IS NOT NULL)`,
    ).bind(at),
    env.DB.prepare(
      `UPDATE site_health_sites SET active = 0, uptime_fails = 0, uptime_down_since = NULL, uptime_incident_id = NULL
       WHERE ${unused('site_health_sites')}`,
    ),
    env.DB.prepare(
      `INSERT INTO site_link_checks (watch_id, user_id, next_at) SELECT id, user_id, ?1 FROM watches WHERE status = 'active'
       ON CONFLICT(watch_id) DO NOTHING`,
    ).bind(at),
  ]);
  return { sites: sites?.meta?.changes ?? 0, stopped: stopped?.meta?.changes ?? 0, pages: pages?.meta?.changes ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* Uptime                                                                      */
/* -------------------------------------------------------------------------- */

export type UptimeState = 'up' | 'down' | 'error';

export interface UptimeReading {
  /** down: no answer, a timeout, a TLS failure or a 5xx. error: it answers, with a 4xx; shown, but not downtime. */
  state: UptimeState;
  code: number | null;
  ms: number;
  detail: string;
}

const TLS_ERROR = /certificate|ssl|tls|handshake/i;

/** Whether a fetch failed on the secure connection rather than on the way to it: runtimes nest the TLS error as a cause. */
export function tlsFailure(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; cause && depth < 4; depth++) {
    if (cause instanceof Error && !(cause instanceof FetchFailure) && TLS_ERROR.test(cause.message)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** The statuses a bot check is served with, whose body is read to tell one apart (isChallenge). */
const CHALLENGE_STATUSES = new Set([403, 429, 503]);

/** One request to a site's first monitored page. Never throws. */
export async function checkUptime(url: string): Promise<UptimeReading> {
  const started = Date.now();
  const deadline = AbortSignal.timeout(UPTIME_TIMEOUT_MS);
  try {
    const { response } = await fetchPublic(url, {
      maxRedirects: 5,
      signal: () => deadline,
      headers: { 'user-agent': AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    const ms = Date.now() - started;
    const code = response.status;
    const html = CHALLENGE_STATUSES.has(code)
      ? ((await readCapped(response, 64_000, 'truncate', charsetOf(response.headers.get('content-type'))).catch(() => null))?.text ?? '')
      : '';
    await response.body?.cancel().catch(() => undefined);
    if (isChallenge(code, response.headers, html)) {
      return { state: 'up', code, ms, detail: `Up · the site shows automated visitors a bot check (HTTP ${code})` };
    }
    if (code === 525) return { state: 'down', code, ms, detail: 'The secure connection to the site failed (HTTP 525)' };
    if (code === 526) return { state: 'down', code, ms, detail: "The site's certificate isn't valid (HTTP 526)" };
    if (code >= 500) return { state: 'down', code, ms, detail: `The site answers with a server error (HTTP ${code})` };
    if (code >= 400) return { state: 'error', code, ms, detail: `The site answers, but with HTTP ${code}${code === 404 ? ' (not found)' : ''}` };
    return { state: 'up', code, ms, detail: `Up · HTTP ${code} in ${ms} ms` };
  } catch (error) {
    const ms = Date.now() - started;
    if (!(error instanceof FetchFailure)) return { state: 'error', code: null, ms, detail: "This address can't be checked from here" };
    if (error.problem === 'timeout') return { state: 'down', code: null, ms, detail: `No answer within ${UPTIME_TIMEOUT_MS / 1000} seconds` };
    if (error.problem === 'unreachable') {
      return tlsFailure(error)
        ? { state: 'down', code: null, ms, detail: 'The secure connection failed (a certificate or TLS error)' }
        : { state: 'down', code: null, ms, detail: "The site can't be reached (DNS or connection failure)" };
    }
    if (error.problem === 'too_many_redirects') return { state: 'error', code: null, ms, detail: 'The page redirects too many times' };
    return { state: 'error', code: null, ms, detail: "The page redirects somewhere that can't be checked" };
  }
}

export interface UptimeSite {
  user_id: string;
  origin: string;
  url: string;
  uptime_fails: number;
  uptime_down_since: string | null;
  uptime_incident_id: string | null;
}

export interface UptimeStep {
  fails: number;
  downSince: string | null;
  /** The incident this check opened, from the first of the down checks. */
  open?: { startedAt: string };
  /** The check closed the open incident. */
  close?: boolean;
}

/**
 * What one check changes. Down adds to the run of down checks, and the
 * INCIDENT_AFTER-th opens an incident dated from the first; anything else
 * (up, or a 4xx) ends the run and closes an open incident. Pure, for tests.
 */
export function uptimeStep(site: Pick<UptimeSite, 'uptime_fails' | 'uptime_down_since' | 'uptime_incident_id'>, reading: UptimeReading, now: Date): UptimeStep {
  if (reading.state !== 'down') return { fails: 0, downSince: null, ...(site.uptime_incident_id ? { close: true } : {}) };
  const fails = site.uptime_fails + 1;
  const downSince = site.uptime_down_since ?? now.toISOString();
  return { fails, downSince, ...(!site.uptime_incident_id && fails >= INCIDENT_AFTER ? { open: { startedAt: downSince } } : {}) };
}

export interface UptimeSweepResult {
  due: number;
  checked: number;
  /** Requests made: fewer than checked when accounts share a site. */
  fetched: number;
  down: number;
  opened: number;
  closed: number;
  /** Due but left for the next tick. */
  backlog: number;
}

/**
 * The uptime checks that are due: at the quarter ticks for 15-minute plans,
 * and on the hour for everyone. Sites are taken in one statement under a
 * short lease, so two ticks never check one twice; any a tick did not reach
 * are handed straight back.
 */
export async function runUptimeChecks(origin: string, now = new Date()): Promise<UptimeSweepResult> {
  const result: UptimeSweepResult = { due: 0, checked: 0, fetched: 0, down: 0, opened: 0, closed: 0, backlog: 0 };
  if (!(await siteHealthAvailable())) return result;
  const at = now.toISOString();
  const lease = new Date(now.getTime() + UPTIME_LEASE_MS).toISOString();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_health_sites WHERE active = 1 AND uptime_next_at <= ?`)
    .bind(at)
    .first<{ n: number }>();
  result.due = Number(total?.n ?? 0);
  if (!result.due) return result;
  const { results } = await env.DB.prepare(
    `UPDATE site_health_sites SET uptime_next_at = ?1 WHERE rowid IN (
       SELECT rowid FROM site_health_sites WHERE active = 1 AND uptime_next_at <= ?2 ORDER BY uptime_next_at LIMIT ?3)
     RETURNING user_id, origin, url, uptime_fails, uptime_down_since, uptime_incident_id`,
  )
    .bind(lease, at, UPTIME_PER_TICK)
    .all<UptimeSite>();
  const sites = results ?? [];
  result.backlog = Math.max(0, result.due - sites.length);
  const intervals = await uptimeIntervals(sites.map((site) => site.user_id));
  const read = once((url) => {
    result.fetched++;
    return checkUptime(url);
  });

  const started = Date.now();
  const left = await lanes(
    sites,
    UPTIME_CONCURRENCY,
    async (site) => {
      const reading = await read(site.url);
      const recorded = await recordUptime(site, reading, intervals.get(site.user_id) ?? 60, now);
      result.checked++;
      if (reading.state === 'down') result.down++;
      if (recorded.opened) {
        result.opened++;
        await incidentOpened(site, recorded.opened, recorded.step, reading, origin);
      }
      if (recorded.closed) {
        result.closed++;
        await incidentClosed(site, recorded.closed, origin);
      }
    },
    () => Date.now() - started >= UPTIME_BUDGET_MS,
  );
  if (left) {
    // Lanes take sites in order, so the ones never started are the last `left`.
    const handedBack = sites.slice(sites.length - left);
    result.backlog += left;
    await env.DB.batch(
      handedBack.map((site) =>
        env.DB.prepare(`UPDATE site_health_sites SET uptime_next_at = ? WHERE user_id = ? AND origin = ? AND uptime_next_at = ?`).bind(at, site.user_id, site.origin, lease),
      ),
    );
  }
  return result;
}

/**
 * One check's writes, in one batch: the site's state, its hour's rollup, and
 * the incident it opened or closed, with the ids of those for their emails.
 */
async function recordUptime(
  site: UptimeSite,
  reading: UptimeReading,
  minutes: number,
  now: Date,
): Promise<{ step: UptimeStep; opened: string | null; closed: string | null }> {
  const at = now.toISOString();
  const step = uptimeStep(site, reading, now);
  const opened = step.open ? prefixedId('inc', 12) : null;
  const closed = step.close ? site.uptime_incident_id : null;
  const incidentId = opened ?? (closed ? null : site.uptime_incident_id);
  const statements = [
    env.DB.prepare(
      `UPDATE site_health_sites SET uptime_next_at = ?, uptime_state = ?, uptime_code = ?, uptime_ms = ?, uptime_detail = ?,
         uptime_checked_at = ?, uptime_fails = ?, uptime_down_since = ?, uptime_incident_id = ?
       WHERE user_id = ? AND origin = ?`,
    ).bind(nextUptimeAt(now, minutes), reading.state, reading.code, reading.ms, reading.detail, at, step.fails, step.downSince, incidentId, site.user_id, site.origin),
    env.DB.prepare(
      `INSERT INTO site_uptime_hourly (user_id, origin, hour, checks, down, total_ms) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, origin, hour) DO UPDATE SET checks = checks + 1, down = down + excluded.down, total_ms = total_ms + excluded.total_ms`,
    ).bind(site.user_id, site.origin, hourOf(now), reading.state === 'down' ? 1 : 0, reading.ms),
  ];
  if (step.open) {
    statements.push(
      env.DB.prepare(`INSERT INTO site_uptime_incidents (id, user_id, origin, started_at, detail) VALUES (?, ?, ?, ?, ?)`).bind(
        opened,
        site.user_id,
        site.origin,
        step.open.startedAt,
        reading.detail,
      ),
    );
  }
  if (closed) {
    statements.push(env.DB.prepare(`UPDATE site_uptime_incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).bind(at, closed));
  }
  await env.DB.batch(statements);
  return { step, opened, closed };
}

/* -------------------------------------------------------------------------- */
/* SSL                                                                         */
/* -------------------------------------------------------------------------- */

export type SslStatus = 'ok' | 'expiring' | 'expired' | 'invalid' | 'no_https' | 'unknown';

export interface SslReading {
  status: SslStatus;
  validTo: string | null;
  issuer: string | null;
  names: string[];
  detail: string;
}

/** What a fetch over HTTPS says about the certificate: browsers would trust it, would not, or no answer to judge by. */
export type Trust = 'trusted' | 'untrusted' | 'unreachable';

/**
 * An HTTPS request to the site, answered or not. Workers' fetch validates the
 * certificate chain and the name, and answers 525/526 or fails with a TLS
 * error when it does not hold, so any other answer means a browser would
 * trust it. No redirect is followed: an answer of any kind is enough.
 */
export async function httpsTrust(url: string): Promise<Trust> {
  try {
    assertPublicCaptureUrl(url);
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
      headers: { 'user-agent': AGENT },
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 525 || response.status === 526 ? 'untrusted' : 'trusted';
  } catch (error) {
    return tlsFailure(error) ? 'untrusted' : 'unreachable';
  }
}

/**
 * The certificate judged on its own: dates and names. Trust in its issuer is
 * httpsTrust's answer. `names: false` skips the name check, for when that
 * answer already says the name is right.
 */
export function assessCertificate(certificate: Certificate, host: string, now: Date, options: { names?: boolean } = {}): SslReading {
  const validTo = certificate.notAfter.toISOString();
  const issuer = issuerName(certificate);
  const names = certificate.dnsNames.slice(0, 20);
  const base = { validTo, issuer, names };
  const days = daysUntil(validTo, now);
  if (certificate.notAfter.getTime() <= now.getTime()) {
    return { ...base, status: 'expired', detail: `The certificate expired on ${formatDate(validTo)}. Visitors see a security warning instead of the site.` };
  }
  if (certificate.notBefore.getTime() > now.getTime()) {
    return { ...base, status: 'invalid', detail: `The certificate isn't valid until ${formatDate(certificate.notBefore)}.` };
  }
  if (options.names !== false && !certificateCovers(certificate, host)) {
    const covers = (names.length ? names : [certificate.subject.commonName ?? 'another name']).slice(0, 3).join(', ');
    return { ...base, status: 'invalid', detail: `The certificate is for ${covers}, not ${host}, so browsers show a warning.` };
  }
  const by = issuer ? `, issued by ${issuer}` : '';
  if (days <= SSL_EXPIRING_DAYS) {
    return {
      ...base,
      status: 'expiring',
      detail: `The certificate expires in ${plural(days, 'day')}, on ${formatDate(validTo)}${by}. Renew it, or check that automatic renewal is working.`,
    };
  }
  return { ...base, status: 'ok', detail: `Valid until ${formatDate(validTo)}, ${plural(days, 'day')} from now${by}.` };
}

/** The certificate read off the wire, with what a fetch says about trusting it. Pure, for tests. */
export function judgeSsl(host: string, probe: ProbeResult, trust: Trust, now: Date): SslReading {
  if (probe.ok) {
    // A fetch that went through has checked the name already; it outranks this parser's reading of the names.
    const reading = assessCertificate(probe.certificate, host, now, { names: trust !== 'trusted' });
    if ((reading.status === 'ok' || reading.status === 'expiring') && trust === 'untrusted') {
      const why = probe.certificate.selfSigned ? 'it is self-signed' : `it was issued by ${reading.issuer ?? 'an unknown authority'}`;
      return { ...reading, status: 'invalid', detail: `Browsers don't trust this certificate: ${why}.` };
    }
    return reading;
  }
  if (trust === 'untrusted') {
    return { status: 'invalid', validTo: null, issuer: null, names: [], detail: 'HTTPS requests to the site fail with a certificate error, so browsers show a warning.' };
  }
  if (trust === 'trusted') {
    return {
      status: 'ok',
      validTo: null,
      issuer: null,
      names: [],
      detail: `HTTPS works and the certificate is trusted. Its expiry date couldn't be read: ${probe.detail}.`,
    };
  }
  return { status: 'unknown', validTo: null, issuer: null, names: [], detail: "The site couldn't be reached over HTTPS to check its certificate." };
}

/**
 * The certificate of a site origin. A site monitored over plain HTTP is
 * asked over HTTPS on the same host too: if that works, it is reported like
 * any other; if not, the state is "no HTTPS", never an error.
 */
export async function checkSsl(origin: string, now = new Date()): Promise<SslReading> {
  let url: URL;
  try {
    url = assertPublicCaptureUrl(origin);
  } catch {
    return { status: 'unknown', validTo: null, issuer: null, names: [], detail: "This address can't be checked from here." };
  }
  const host = url.hostname;
  const plain = url.protocol === 'http:';
  const port = plain ? 443 : Number(url.port || 443);
  const httpsOrigin = `https://${url.hostname}${plain || port === 443 ? '' : `:${port}`}/`;
  const [probe, trust] = await Promise.all([probeCertificate(host, port), httpsTrust(httpsOrigin)]);
  const reading = judgeSsl(host, probe, trust, now);
  if (!plain) return reading;
  if (reading.status === 'ok' || reading.status === 'expiring') {
    return { ...reading, detail: `Monitored over HTTP, but HTTPS works too. ${reading.detail}` };
  }
  return {
    status: 'no_https',
    validTo: null,
    issuer: null,
    names: [],
    detail:
      reading.status === 'unknown'
        ? "This site is monitored over plain HTTP and doesn't answer over HTTPS, so there's no certificate to check."
        : `This site is monitored over plain HTTP. HTTPS on this host isn't set up properly: ${reading.detail.charAt(0).toLowerCase()}${reading.detail.slice(1)}`,
  };
}

/** The warning a reading calls for, as the claim stored in ssl_alert: once at 14 days, again at 3, and when expired or invalid. */
export function sslAlertKey(reading: Pick<SslReading, 'status' | 'validTo'>, now: Date): string | null {
  if (reading.status === 'expired') return `expired:${reading.validTo ?? ''}`;
  if (reading.status === 'invalid') return 'invalid';
  if (reading.status === 'expiring' && reading.validTo) {
    return `${daysUntil(reading.validTo, now) <= SSL_URGENT_DAYS ? 'expiring3' : 'expiring14'}:${reading.validTo}`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Domain                                                                      */
/* -------------------------------------------------------------------------- */

/** The warning a registration calls for: once at 30 days, again at 7 (an expired one counts as the second). */
export function domainAlertKey(reading: Pick<DomainReading, 'status' | 'expiresAt'>, now: Date): string | null {
  if (reading.status !== 'expiring' && reading.status !== 'expired') return null;
  const days = reading.expiresAt ? daysUntil(reading.expiresAt, now) : -1;
  return `${days <= DOMAIN_URGENT_DAYS ? 'expiring7' : 'expiring30'}:${reading.expiresAt ?? 'lapsed'}`;
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

export type PageRead = { ok: true; url: string; links: PageLink[] } | { ok: false; detail: string };

/** A monitored page's HTML, read as a fast check reads it (fast-checks.ts), and the links in it. */
export async function readPageLinks(url: string): Promise<PageRead> {
  const deadline = AbortSignal.timeout(UPTIME_TIMEOUT_MS);
  try {
    const { response, url: final } = await fetchPublic(url, {
      maxRedirects: 5,
      signal: () => deadline,
      headers: { 'user-agent': AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    const type = response.headers.get('content-type');
    if (response.status >= 400 || (type && !/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type))) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, detail: response.status >= 400 ? `The page answered HTTP ${response.status}, so its links weren't read` : "The page isn't HTML, so it has no links to check" };
    }
    const body = await readCapped(response, PAGE_MAX_BYTES, 'truncate', charsetOf(type));
    return { ok: true, url: final.toString(), links: extractLinks(body?.text ?? '', final.toString()) };
  } catch (error) {
    if (error instanceof FetchFailure && error.problem === 'timeout') return { ok: false, detail: `The page didn't answer within ${UPTIME_TIMEOUT_MS / 1000} seconds` };
    return { ok: false, detail: "The page couldn't be read" };
  }
}

/* -------------------------------------------------------------------------- */
/* The hourly sweep                                                            */
/* -------------------------------------------------------------------------- */

export interface SiteHealthSweepResult {
  sync: SyncResult | null;
  ssl: { due: number; checked: number; alerts: number };
  domain: { due: number; checked: number; lookups: number; alerts: number };
  links: { due: number; pages: number; requests: number; broken: number; fixed: number };
  pruned: PruneResult | null;
}

/**
 * The hourly part: the site list, then certificates, registrations and links
 * side by side, then pruning. Each step catches its own failure, so one that
 * breaks costs only itself.
 */
export async function runSiteHealthSweep(origin: string, now = new Date()): Promise<SiteHealthSweepResult> {
  const result: SiteHealthSweepResult = {
    sync: null,
    ssl: { due: 0, checked: 0, alerts: 0 },
    domain: { due: 0, checked: 0, lookups: 0, alerts: 0 },
    links: { due: 0, pages: 0, requests: 0, broken: 0, fixed: 0 },
    pruned: null,
  };
  if (!(await siteHealthAvailable())) return result;
  result.sync = await syncSites(now).catch((error) => {
    console.error('[site-health] sync failed', error);
    return null;
  });
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  await Promise.all([
    sslSweep(origin, now, deadline, result.ssl).catch((error) => console.error('[site-health] ssl sweep failed', error)),
    domainSweep(origin, now, deadline, result.domain).catch((error) => console.error('[site-health] domain sweep failed', error)),
    linkSweep(now, deadline, result.links).catch((error) => console.error('[site-health] link sweep failed', error)),
  ]);
  result.pruned = await pruneSiteHealth(now.getTime()).catch((error) => {
    console.error('[site-health] prune failed', error);
    return null;
  });
  return result;
}

interface DueSite {
  user_id: string;
  origin: string;
  next_at: string;
  alert: string | null;
}

/** Due sites for one check, oldest first. */
async function dueSites(column: 'ssl' | 'domain', now: Date, limit: number): Promise<{ total: number; sites: DueSite[] }> {
  const at = now.toISOString();
  const [count, listed] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM site_health_sites WHERE active = 1 AND ${column}_next_at <= ?`).bind(at).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT user_id, origin, ${column}_next_at AS next_at, ${column}_alert AS alert FROM site_health_sites
       WHERE active = 1 AND ${column}_next_at <= ? ORDER BY ${column}_next_at LIMIT ?`,
    )
      .bind(at, limit)
      .all<DueSite>(),
  ]);
  return { total: Number(count?.n ?? 0), sites: listed.results ?? [] };
}

/** Takes one listed site for this sweep: false when another sweep, or a change since the list, got there first. */
async function claimSite(column: 'ssl' | 'domain', site: DueSite, now: Date): Promise<boolean> {
  const lease = new Date(now.getTime() + SWEEP_LEASE_MS).toISOString();
  const claim = await env.DB.prepare(`UPDATE site_health_sites SET ${column}_next_at = ? WHERE user_id = ? AND origin = ? AND ${column}_next_at = ?`)
    .bind(lease, site.user_id, site.origin, site.next_at)
    .run();
  return Boolean(claim.meta?.changes);
}

/** A certificate warning's claim: stored only if the last one is still what this check saw, so two sweeps never both send it. */
async function claimAlert(column: 'ssl_alert', site: DueSite, key: string): Promise<boolean> {
  const claim = await env.DB.prepare(`UPDATE site_health_sites SET ${column} = ? WHERE user_id = ? AND origin = ? AND ${column} IS ?`)
    .bind(key, site.user_id, site.origin, site.alert)
    .run();
  return Boolean(claim.meta?.changes);
}

/**
 * A domain warning's claim, for the account rather than the site: www. and
 * shop. on one registration are one email. One statement marks every site of
 * the account on that domain, unless one of them already carries the warning.
 */
async function claimDomainAlert(site: DueSite, domain: string, key: string): Promise<boolean> {
  const claim = await env.DB.prepare(
    `UPDATE site_health_sites SET domain_alert = ?1 WHERE user_id = ?2 AND domain_name = ?3
       AND NOT EXISTS (SELECT 1 FROM site_health_sites WHERE user_id = ?2 AND domain_name = ?3 AND domain_alert = ?1)`,
  )
    .bind(key, site.user_id, domain)
    .run();
  return Boolean(claim.meta?.changes);
}

async function sslSweep(origin: string, now: Date, deadline: number, out: SiteHealthSweepResult['ssl']): Promise<void> {
  const { total, sites } = await dueSites('ssl', now, SSL_PER_TICK);
  out.due = total;
  const read = once((site) => checkSsl(site, now));
  await lanes(
    sites,
    SSL_CONCURRENCY,
    async (site) => {
      if (!(await claimSite('ssl', site, now))) return;
      const reading = await read(site.origin);
      // A renewed certificate starts the warnings afresh; a reading that could not see one changes nothing about them.
      const reset = reading.status === 'ok' && reading.validTo !== null;
      await env.DB.prepare(
        `UPDATE site_health_sites SET ssl_next_at = ?, ssl_status = ?, ssl_valid_to = ?, ssl_issuer = ?, ssl_names = ?, ssl_detail = ?,
           ssl_checked_at = ?, ssl_alert = CASE WHEN ? THEN NULL ELSE ssl_alert END
         WHERE user_id = ? AND origin = ?`,
      )
        .bind(
          hoursFrom(now, SSL_CHECK_HOURS),
          reading.status,
          reading.validTo,
          reading.issuer,
          JSON.stringify(reading.names),
          reading.detail,
          now.toISOString(),
          reset ? 1 : 0,
          site.user_id,
          site.origin,
        )
        .run();
      out.checked++;
      const key = sslAlertKey(reading, now);
      if (!key || key === site.alert || reset) return;
      if (!(await claimAlert('ssl_alert', site, key))) return;
      if (await sendSiteAlert(site.user_id, site.origin, origin, sslEmail(site.origin, reading, now))) out.alerts++;
    },
    () => Date.now() >= deadline,
  );
}

async function domainSweep(origin: string, now: Date, deadline: number, out: SiteHealthSweepResult['domain']): Promise<void> {
  const { total, sites } = await dueSites('domain', now, DOMAIN_PER_TICK);
  out.due = total;
  // One registry lookup per registrable domain: www.example.com and shop.example.com share one.
  const lookups = new Map<string, Promise<unknown>>();
  const read = once((host) => checkDomain(host, now, lookups));
  await lanes(
    sites,
    DOMAIN_CONCURRENCY,
    async (site) => {
      if (!(await claimSite('domain', site, now))) return;
      const reading = await read(new URL(site.origin).hostname);
      out.lookups = lookups.size;
      const reset = reading.status === 'ok';
      await env.DB.prepare(
        `UPDATE site_health_sites SET domain_next_at = ?, domain_name = ?, domain_status = ?, domain_expires_at = ?, domain_registrar = ?,
           domain_detail = ?, domain_checked_at = ?, domain_alert = CASE WHEN ? THEN NULL ELSE domain_alert END
         WHERE user_id = ? AND origin = ?`,
      )
        .bind(
          hoursFrom(now, reading.retry ? RETRY_HOURS : DOMAIN_CHECK_HOURS),
          reading.domain,
          reading.status,
          reading.expiresAt,
          reading.registrar,
          reading.detail,
          now.toISOString(),
          reset ? 1 : 0,
          site.user_id,
          site.origin,
        )
        .run();
      out.checked++;
      const key = domainAlertKey(reading, now);
      if (!key || key === site.alert) return;
      if (!(await claimDomainAlert(site, reading.domain, key))) return;
      if (await sendSiteAlert(site.user_id, site.origin, origin, domainEmail(site.origin, reading, now))) out.alerts++;
    },
    () => Date.now() >= deadline,
  );
}

interface DuePage {
  watch_id: string;
  user_id: string;
  next_at: string;
  url: string;
}

/**
 * Up to LINK_PAGES_PER_TICK monitored pages, one after another, each with
 * LINK_CONCURRENCY requests at once, until LINK_REQUESTS_PER_TICK or the time
 * budget is spent. A link on several pages, or several accounts' pages, is
 * asked for once per sweep.
 */
async function linkSweep(now: Date, deadline: number, out: SiteHealthSweepResult['links']): Promise<void> {
  const at = now.toISOString();
  const due = `FROM site_link_checks l JOIN watches w ON w.id = l.watch_id WHERE l.next_at <= ? AND w.status = 'active'`;
  const [count, listed] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n ${due}`).bind(at).first<{ n: number }>(),
    env.DB.prepare(`SELECT l.watch_id, l.user_id, l.next_at, w.url ${due} ORDER BY l.next_at LIMIT ?`).bind(at, LINK_PAGES_PER_TICK).all<DuePage>(),
  ]);
  const pages = listed.results ?? [];
  out.due = Number(count?.n ?? 0);
  const verdicts = once(async (url) => {
    const verdict = await checkLink(url);
    out.requests += verdict.requests;
    return verdict;
  });
  for (const page of pages) {
    if (Date.now() >= deadline || out.requests + LINKS_PER_PAGE > LINK_REQUESTS_PER_TICK) break;
    const claim = await env.DB.prepare(`UPDATE site_link_checks SET next_at = ? WHERE watch_id = ? AND next_at = ?`)
      .bind(new Date(now.getTime() + SWEEP_LEASE_MS).toISOString(), page.watch_id, page.next_at)
      .run();
    if (!claim.meta?.changes) continue;
    const found = await checkPage(page, verdicts, now);
    out.pages++;
    out.broken += found.broken;
    out.fixed += found.fixed;
  }
}

/** One page: read it, check its first LINKS_PER_PAGE links, and record what is broken, still broken and fixed. */
export async function checkPage(
  page: Pick<DuePage, 'watch_id' | 'user_id' | 'url'>,
  verdicts: (url: string) => Promise<LinkVerdict & { skipped?: boolean }>,
  now: Date,
): Promise<{ checked: number; broken: number; fixed: number }> {
  const at = now.toISOString();
  const read = await readPageLinks(page.url);
  if (!read.ok) {
    // The last results stand; the reason is shown beside them and the page is tried again tomorrow.
    await env.DB.prepare(`UPDATE site_link_checks SET next_at = ?, detail = ? WHERE watch_id = ?`)
      .bind(hoursFrom(now, RETRY_HOURS), read.detail, page.watch_id)
      .run();
    return { checked: 0, broken: 0, fixed: 0 };
  }
  const chosen = read.links.slice(0, LINKS_PER_PAGE);
  const results = new Map<string, LinkVerdict & { skipped?: boolean }>();
  await lanes(chosen, LINK_CONCURRENCY, async (link) => {
    results.set(link.url, await verdicts(link.url));
  });
  const checked = chosen.filter((link) => results.get(link.url) && !results.get(link.url)!.skipped);
  const broken = checked.filter((link) => results.get(link.url)!.kind === 'broken');
  const unverified = checked.filter((link) => results.get(link.url)!.kind === 'unverified');

  // Fixed: broken before, and now either working or no longer on the page. One that could not be verified stays as it was.
  const { results: open } = await env.DB.prepare(`SELECT url FROM site_broken_links WHERE watch_id = ? AND fixed_at IS NULL`)
    .bind(page.watch_id)
    .all<{ url: string }>();
  const onPage = new Set(read.links.map((link) => link.url));
  const brokenNow = new Set(broken.map((link) => link.url));
  const fixed = (open ?? []).filter(({ url }) => !brokenNow.has(url) && (results.get(url)?.kind === 'ok' || !onPage.has(url)));

  const statements = [
    env.DB.prepare(
      `UPDATE site_link_checks SET next_at = ?, checked_at = ?, page_url = ?, checked = ?, broken = ?, unverified = ?, detail = NULL WHERE watch_id = ?`,
    ).bind(hoursFrom(now, LINK_CHECK_HOURS), at, read.url, checked.length, broken.length, unverified.length, page.watch_id),
    // Still broken: the open row is brought up to date. Newly broken, or broken again after a fix: a new row, so the fix stays counted.
    ...broken.flatMap((link) => {
      const verdict = results.get(link.url)!;
      return [
        env.DB.prepare(
          `UPDATE site_broken_links SET status = ?, reason = ?, link_text = ?, last_seen_at = ? WHERE watch_id = ? AND url = ? AND fixed_at IS NULL`,
        ).bind(verdict.status, verdict.reason, link.text, at, page.watch_id, link.url),
        env.DB.prepare(
          `INSERT INTO site_broken_links (watch_id, url, user_id, status, reason, link_text, first_seen_at, last_seen_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
           WHERE NOT EXISTS (SELECT 1 FROM site_broken_links WHERE watch_id = ?1 AND url = ?2 AND fixed_at IS NULL)`,
        ).bind(page.watch_id, link.url, page.user_id, verdict.status, verdict.reason, link.text, at),
      ];
    }),
    ...fixed.map(({ url }) =>
      env.DB.prepare(`UPDATE site_broken_links SET fixed_at = ? WHERE watch_id = ? AND url = ? AND fixed_at IS NULL`).bind(at, page.watch_id, url),
    ),
  ];
  for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start, start + 50));
  return { checked: checked.length, broken: broken.length, fixed: fixed.length };
}

/* -------------------------------------------------------------------------- */
/* Pruning                                                                     */
/* -------------------------------------------------------------------------- */

export interface PruneResult {
  hours: number;
  incidents: number;
  links: number;
  sites: number;
}

/**
 * Deletes what is older than RETENTION_DAYS, a bounded batch per table per
 * hour. Rollups and incidents are only ever appended in time order, so, as
 * for quiet monitor runs (retention.ts), the scan is bounded by rowid: every
 * row before the first one newer than the cutoff is older than it. Fixed links
 * have an index on fixed_at. A site no monitor has used for as long goes too.
 */
export async function pruneSiteHealth(now = Date.now()): Promise<PruneResult> {
  const result: PruneResult = { hours: 0, incidents: 0, links: 0, sites: 0 };
  if (!(await siteHealthAvailable())) return result;
  const cutoff = new Date(now - RETENTION_DAYS * DAY_MS).toISOString();
  const before = (table: string, column: string) =>
    `rowid < COALESCE((SELECT rowid FROM ${table} WHERE ${column} >= ?1 ORDER BY rowid LIMIT 1), (SELECT MAX(rowid) + 1 FROM ${table}))`;
  for (let round = 0; round < PRUNE_ROUNDS; round++) {
    const deleted = await env.DB.prepare(
      `DELETE FROM site_uptime_hourly WHERE rowid IN (
         SELECT rowid FROM site_uptime_hourly WHERE ${before('site_uptime_hourly', 'hour')} AND hour < ?1 LIMIT ${PRUNE_BATCH})`,
    )
      .bind(cutoff)
      .run();
    const changes = deleted.meta?.changes ?? 0;
    result.hours += changes;
    if (changes < PRUNE_BATCH) break;
  }
  const [incidents, links, sites] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM site_uptime_incidents WHERE rowid IN (
         SELECT rowid FROM site_uptime_incidents WHERE ${before('site_uptime_incidents', 'started_at')}
           AND ended_at IS NOT NULL AND ended_at < ?1 LIMIT ${PRUNE_BATCH})`,
    ).bind(cutoff),
    env.DB.prepare(`DELETE FROM site_broken_links WHERE rowid IN (SELECT rowid FROM site_broken_links WHERE fixed_at < ?1 LIMIT ${PRUNE_BATCH})`).bind(cutoff),
    env.DB.prepare(`DELETE FROM site_health_sites WHERE rowid IN (SELECT rowid FROM site_health_sites WHERE active = 0 AND uptime_next_at < ?1 LIMIT 100)`).bind(cutoff),
  ]);
  result.incidents = incidents?.meta?.changes ?? 0;
  result.links = links?.meta?.changes ?? 0;
  result.sites = sites?.meta?.changes ?? 0;
  return result;
}

/* -------------------------------------------------------------------------- */
/* Emails                                                                      */
/* -------------------------------------------------------------------------- */

interface SiteMail {
  subject: string;
  /** The body before the link and the footer. */
  text: string;
}

/**
 * Who hears about a site: the owner, if any active monitor on it has email
 * alerts on, with the oldest such monitor's page to link to. idx_watches_user
 * bounds it to the account's own monitors.
 */
export async function alertRecipient(userId: string, origin: string): Promise<{ email: string; watchId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT w.id AS watch_id, u.email FROM watches w JOIN users u ON u.id = w.user_id
     WHERE w.user_id = ? AND w.status = 'active' AND w.notify_email = 1 AND ${originSql('w.url')} = ?
     ORDER BY w.created_at LIMIT 1`,
  )
    .bind(userId, origin)
    .first<{ watch_id: string; email: string }>();
  return row ? { email: row.email, watchId: row.watch_id } : null;
}

/** Sends a claimed warning. True when it went; best effort, as account notices are: one that fails is logged, not retried. */
async function sendSiteAlert(userId: string, site: string, appOrigin: string, mail: SiteMail): Promise<boolean> {
  const recipient = await alertRecipient(userId, site);
  if (!recipient || !canSendEmail()) return false;
  const host = new URL(site).hostname;
  const sent = await sendMail({
    to: recipient.email,
    subject: mail.subject.slice(0, 120),
    text:
      `${mail.text}\n\nSite health for ${host}: ${appOrigin}/app/watches/${recipient.watchId}#site-health\n\n` +
      `You get these emails because email alerts are on for a monitor on ${host}. Turn them off on that monitor's page.`,
  });
  if (!sent) console.error(`[site-health] alert for ${site} to ${userId} was not sent`);
  return sent;
}

async function incidentOpened(site: UptimeSite, id: string, step: UptimeStep, reading: UptimeReading, appOrigin: string): Promise<void> {
  const claim = await env.DB.prepare(`UPDATE site_uptime_incidents SET opened_alert_at = ? WHERE id = ? AND opened_alert_at IS NULL`)
    .bind(new Date().toISOString(), id)
    .run();
  if (!claim.meta?.changes) return;
  const host = new URL(site.origin).hostname;
  await sendSiteAlert(site.user_id, site.origin, appOrigin, {
    subject: `${host} is down`,
    text:
      `${host} is not answering.\n\n` +
      `${site.url} failed ${INCIDENT_AFTER} checks in a row: ${reading.detail.charAt(0).toLowerCase()}${reading.detail.slice(1)}.\n` +
      `First failed check: ${formatDateTime(step.open!.startedAt)}.\n\n` +
      `We'll email you again when it's back up.`,
  });
}

/** The "back up" email, claimed like the "down" one, and only for an incident whose opening was handled. */
async function incidentClosed(site: UptimeSite, id: string, appOrigin: string): Promise<void> {
  const incident = await env.DB.prepare(
    `UPDATE site_uptime_incidents SET closed_alert_at = ? WHERE id = ? AND ended_at IS NOT NULL
       AND closed_alert_at IS NULL AND opened_alert_at IS NOT NULL
     RETURNING started_at, ended_at, detail`,
  )
    .bind(new Date().toISOString(), id)
    .first<{ started_at: string; ended_at: string; detail: string }>();
  if (!incident) return;
  const host = new URL(site.origin).hostname;
  const minutes = Math.max(1, Math.round((Date.parse(incident.ended_at) - Date.parse(incident.started_at)) / 60_000));
  const duration = minutes < 120 ? plural(minutes, 'minute') : `${plural(Math.floor(minutes / 60), 'hour')} ${plural(minutes % 60, 'minute')}`;
  await sendSiteAlert(site.user_id, site.origin, appOrigin, {
    subject: `${host} is back up`,
    text:
      `${host} is answering again. It was down for about ${duration}, from ${formatDateTime(incident.started_at)} ` +
      `to ${formatDateTime(incident.ended_at)}.\n\nWhat the checks saw: ${incident.detail}.`,
  });
}

function sslEmail(site: string, reading: SslReading, now: Date): SiteMail {
  const host = new URL(site).hostname;
  if (reading.status === 'expiring' && reading.validTo) {
    const days = Math.max(0, daysUntil(reading.validTo, now));
    return {
      subject: `SSL certificate for ${host} expires in ${plural(days, 'day')}`,
      text:
        `The certificate ${host} serves expires on ${formatDateTime(reading.validTo)}, in ${plural(days, 'day')}` +
        `${reading.issuer ? ` (issued by ${reading.issuer})` : ''}.\n\n` +
        'Renew it, or check that automatic renewal is working, before then: once it expires, browsers show visitors a security warning instead of the site.',
    };
  }
  if (reading.status === 'expired') {
    return {
      subject: `SSL certificate for ${host} has expired`,
      text: `${reading.detail}\n\nRenew the certificate now. Until then visitors are warned that the site is not secure, and most will leave.`,
    };
  }
  return {
    subject: `SSL certificate problem on ${host}`,
    text: `${reading.detail}\n\nUntil it is fixed, visitors are warned that the site is not secure.`,
  };
}

function domainEmail(site: string, reading: DomainReading, now: Date): SiteMail {
  const host = new URL(site).hostname;
  const expired = reading.status === 'expired';
  const days = reading.expiresAt ? Math.max(0, daysUntil(reading.expiresAt, now)) : 0;
  return {
    subject: expired ? `${reading.domain} has expired` : `${reading.domain} expires in ${plural(days, 'day')}`,
    text:
      `${reading.detail}\n\n` +
      `If the registration lapses, ${host} stops working and the name can be registered by someone else. ` +
      `${reading.registrar ? `It is registered with ${reading.registrar}. ` : ''}Renew it, or check that auto-renewal is on and the card on file is current.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading results for the app                                                 */
/* -------------------------------------------------------------------------- */

export type Tone = 'pending' | 'healthy' | 'neutral' | 'warning' | 'problem';

const TONE_RANK: Record<Tone, number> = { pending: 0, neutral: 1, healthy: 1, warning: 2, problem: 3 };

/** The tone of a whole site: the worst of its parts; pending only while nothing has been checked. */
export function overallTone(tones: Tone[]): Exclude<Tone, 'neutral'> {
  const worst = tones.reduce<Tone>((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a), 'pending');
  return worst === 'neutral' ? 'healthy' : worst;
}

export const uptimeTone = (state: UptimeState | null): Tone => (!state ? 'pending' : state === 'down' ? 'problem' : state === 'error' ? 'warning' : 'healthy');
export const sslTone = (status: SslStatus | null): Tone =>
  !status ? 'pending' : status === 'expired' || status === 'invalid' ? 'problem' : status === 'expiring' ? 'warning' : status === 'ok' ? 'healthy' : 'neutral';
export const domainTone = (status: DomainReading['status'] | null): Tone =>
  !status ? 'pending' : status === 'expired' ? 'problem' : status === 'expiring' ? 'warning' : status === 'ok' ? 'healthy' : 'neutral';
export const linksTone = (checkedAt: string | null, broken: number): Tone => (!checkedAt ? 'pending' : broken > 0 ? 'warning' : 'healthy');

interface SiteRow {
  origin: string;
  url: string;
  uptime_state: UptimeState | null;
  uptime_code: number | null;
  uptime_ms: number | null;
  uptime_detail: string | null;
  uptime_checked_at: string | null;
  uptime_incident_id: string | null;
  ssl_status: SslStatus | null;
  ssl_valid_to: string | null;
  ssl_issuer: string | null;
  ssl_detail: string | null;
  ssl_checked_at: string | null;
  domain_name: string | null;
  domain_status: DomainReading['status'] | null;
  domain_expires_at: string | null;
  domain_registrar: string | null;
  domain_detail: string | null;
  domain_checked_at: string | null;
}

export interface SiteHealthPanel {
  origin: string;
  host: string;
  tone: Exclude<Tone, 'neutral'>;
  uptimeMinutes: 15 | 60;
  uptime: {
    tone: Tone;
    state: UptimeState;
    code: number | null;
    ms: number | null;
    detail: string;
    checkedAt: string;
    pct: { day: number | null; week: number | null; month: number | null };
    lastIncident: { startedAt: string; endedAt: string | null; minutes: number; detail: string } | null;
  } | null;
  ssl: { tone: Tone; status: SslStatus; validTo: string | null; daysLeft: number | null; issuer: string | null; detail: string; checkedAt: string } | null;
  domain: {
    tone: Tone;
    status: DomainReading['status'];
    domain: string;
    expiresAt: string | null;
    daysLeft: number | null;
    registrar: string | null;
    detail: string;
    checkedAt: string;
  } | null;
  links: {
    tone: Tone;
    checkedAt: string | null;
    checked: number;
    brokenCount: number;
    unverified: number;
    broken: Array<{ url: string; status: number | null; reason: string; text: string; since: string }>;
    fixedRecently: number;
    /** Why the last attempt could not read the page, when it could not. */
    detail: string | null;
  } | null;
}

/**
 * Everything the monitor page's Site health panel shows, in five indexed
 * reads. Null before migration 0020, so the panel is not rendered at all.
 */
export async function siteHealthPanel(
  user: { id: string; plan: string },
  watch: { id: string; url: string },
  now = new Date(),
): Promise<SiteHealthPanel | null> {
  if (!(await siteHealthAvailable())) return null;
  const origin = originOf(watch.url);
  if (!origin) return null;
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const [site, rollup, incident, links, broken, fixed] = await Promise.all([
    env.DB.prepare(`SELECT * FROM site_health_sites WHERE user_id = ? AND origin = ?`).bind(user.id, origin).first<SiteRow>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(checks), 0) AS month_checks, COALESCE(SUM(down), 0) AS month_down,
              COALESCE(SUM(CASE WHEN hour >= ?3 THEN checks END), 0) AS week_checks, COALESCE(SUM(CASE WHEN hour >= ?3 THEN down END), 0) AS week_down,
              COALESCE(SUM(CASE WHEN hour >= ?4 THEN checks END), 0) AS day_checks, COALESCE(SUM(CASE WHEN hour >= ?4 THEN down END), 0) AS day_down
       FROM site_uptime_hourly WHERE user_id = ?1 AND origin = ?2 AND hour >= ?5`,
    )
      .bind(user.id, origin, since(7), since(1), since(30))
      .first<Record<'month_checks' | 'month_down' | 'week_checks' | 'week_down' | 'day_checks' | 'day_down', number>>(),
    env.DB.prepare(`SELECT started_at, ended_at, detail FROM site_uptime_incidents WHERE user_id = ? AND origin = ? ORDER BY started_at DESC LIMIT 1`)
      .bind(user.id, origin)
      .first<{ started_at: string; ended_at: string | null; detail: string }>(),
    env.DB.prepare(`SELECT checked_at, checked, broken, unverified, detail FROM site_link_checks WHERE watch_id = ? AND user_id = ?`)
      .bind(watch.id, user.id)
      .first<{ checked_at: string | null; checked: number; broken: number; unverified: number; detail: string | null }>(),
    env.DB.prepare(
      `SELECT url, status, reason, link_text, first_seen_at FROM site_broken_links WHERE watch_id = ? AND user_id = ? AND fixed_at IS NULL
       ORDER BY first_seen_at, url LIMIT 6`,
    )
      .bind(watch.id, user.id)
      .all<{ url: string; status: number | null; reason: string; link_text: string; first_seen_at: string }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM site_broken_links WHERE watch_id = ? AND user_id = ? AND fixed_at >= ?`)
      .bind(watch.id, user.id, since(30))
      .first<{ n: number }>(),
  ]);

  const n = (value: unknown) => Number(value ?? 0);
  const uptime: SiteHealthPanel['uptime'] =
    site?.uptime_state && site.uptime_checked_at
      ? {
          tone: uptimeTone(site.uptime_state),
          state: site.uptime_state,
          code: site.uptime_code,
          ms: site.uptime_ms,
          detail: site.uptime_detail ?? '',
          checkedAt: site.uptime_checked_at,
          pct: {
            day: uptimePct(n(rollup?.day_checks), n(rollup?.day_down)),
            week: uptimePct(n(rollup?.week_checks), n(rollup?.week_down)),
            month: uptimePct(n(rollup?.month_checks), n(rollup?.month_down)),
          },
          lastIncident: incident
            ? {
                startedAt: incident.started_at,
                endedAt: incident.ended_at,
                minutes: Math.max(1, Math.round(((incident.ended_at ? Date.parse(incident.ended_at) : now.getTime()) - Date.parse(incident.started_at)) / 60_000)),
                detail: incident.detail,
              }
            : null,
        }
      : null;
  const ssl: SiteHealthPanel['ssl'] =
    site?.ssl_status && site.ssl_checked_at
      ? {
          tone: sslTone(site.ssl_status),
          status: site.ssl_status,
          validTo: site.ssl_valid_to,
          daysLeft: site.ssl_valid_to ? daysUntil(site.ssl_valid_to, now) : null,
          issuer: site.ssl_issuer,
          detail: site.ssl_detail ?? '',
          checkedAt: site.ssl_checked_at,
        }
      : null;
  const domain: SiteHealthPanel['domain'] =
    site?.domain_status && site.domain_checked_at
      ? {
          tone: domainTone(site.domain_status),
          status: site.domain_status,
          domain: site.domain_name ?? new URL(origin).hostname,
          expiresAt: site.domain_expires_at,
          daysLeft: site.domain_expires_at ? daysUntil(site.domain_expires_at, now) : null,
          registrar: site.domain_registrar,
          detail: site.domain_detail ?? '',
          checkedAt: site.domain_checked_at,
        }
      : null;
  const linkPart: SiteHealthPanel['links'] =
    links && (links.checked_at || links.detail)
      ? {
          tone: linksTone(links.checked_at, n(links.broken)),
          checkedAt: links.checked_at,
          checked: n(links.checked),
          brokenCount: n(links.broken),
          unverified: n(links.unverified),
          broken: (broken.results ?? []).map((row) => ({ url: row.url, status: row.status, reason: row.reason, text: row.link_text, since: row.first_seen_at })),
          fixedRecently: n(fixed?.n),
          detail: links.detail,
        }
      : null;

  return {
    origin,
    host: new URL(origin).hostname,
    tone: overallTone([uptime?.tone ?? 'pending', ssl?.tone ?? 'pending', domain?.tone ?? 'pending', linkPart?.tone ?? 'pending']),
    uptimeMinutes: uptimeMinutes(user.plan),
    uptime,
    ssl,
    domain,
    links: linkPart,
  };
}

/**
 * The site-health tone of each of an account's monitors, for the monitors
 * list: its site's uptime, certificate and registration, and its own page's
 * links. Two queries for the whole list; an empty map before 0020.
 */
export async function siteHealthTones(userId: string, watches: Array<{ id: string; url: string }>): Promise<Map<string, Exclude<Tone, 'neutral'>>> {
  const tones = new Map<string, Exclude<Tone, 'neutral'>>();
  if (!watches.length || !(await siteHealthAvailable())) return tones;
  const [sites, links] = await Promise.all([
    env.DB.prepare(`SELECT origin, uptime_state, ssl_status, domain_status FROM site_health_sites WHERE user_id = ?`)
      .bind(userId)
      .all<Pick<SiteRow, 'origin' | 'uptime_state' | 'ssl_status' | 'domain_status'>>(),
    env.DB.prepare(`SELECT l.watch_id, l.checked_at, l.broken FROM site_link_checks l JOIN watches w ON w.id = l.watch_id WHERE w.user_id = ?`)
      .bind(userId)
      .all<{ watch_id: string; checked_at: string | null; broken: number }>(),
  ]);
  const siteBy = new Map((sites.results ?? []).map((row) => [row.origin, row]));
  const linkBy = new Map((links.results ?? []).map((row) => [row.watch_id, row]));
  for (const watch of watches) {
    const site = siteBy.get(originOf(watch.url) ?? '');
    const link = linkBy.get(watch.id);
    tones.set(
      watch.id,
      overallTone([
        uptimeTone(site?.uptime_state ?? null),
        sslTone(site?.ssl_status ?? null),
        domainTone(site?.domain_status ?? null),
        linksTone(link?.checked_at ?? null, Number(link?.broken ?? 0)),
      ]),
    );
  }
  return tones;
}
