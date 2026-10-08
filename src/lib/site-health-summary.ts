import { env } from 'cloudflare:workers';

/**
 * Site health as other features read it: whether migration 0020 is there, and
 * a summary for the sites behind a set of monitors over a window, which the
 * monthly care report prints.
 *
 * The checks themselves live in site-health.ts. This file reads only what they
 * stored, so a report, the account deletion and anything else that only needs
 * the results can import it without the sockets and fetches that make them.
 */

export interface SiteHealthSummary {
  origin: string;
  uptime: { checks: number; down: number; pct: number | null; incidents: Array<{ startedAt: string; endedAt: string | null; minutes: number; detail: string }> } | null;
  ssl: { status: 'ok' | 'expiring' | 'expired' | 'invalid' | 'no_https' | 'unknown'; validTo: string | null; issuer: string | null; checkedAt: string; detail: string } | null;
  domain: { status: 'ok' | 'expiring' | 'expired' | 'unknown'; domain: string; expiresAt: string | null; registrar: string | null; checkedAt: string; detail: string } | null;
  links: { checkedAt: string; pages: number; checked: number; broken: Array<{ page: string; url: string; status: number | null; reason: string }>; fixed: number } | null;
}

const TABLES = ['site_health_sites', 'site_uptime_hourly', 'site_uptime_incidents', 'site_link_checks', 'site_broken_links'];

/** Cached per isolate like trialsReady: a yes for good, a no for a minute. */
let healthTables: { ready: boolean; at: number } | undefined;

/** Whether migration 0020 is applied (probed in sqlite_master, cached per isolate like other optional features). */
export async function siteHealthReady(): Promise<boolean> {
  if (healthTables && (healthTables.ready || Date.now() - healthTables.at < 60_000)) return healthTables.ready;
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`,
  )
    .bind(...TABLES)
    .first<{ n: number }>();
  healthTables = { ready: row?.n === TABLES.length, at: Date.now() };
  return healthTables.ready;
}

/** For pages and sweeps that must not fail on a probe: an unreachable database reads as "not yet". */
export async function siteHealthAvailable(): Promise<boolean> {
  return siteHealthReady().catch(() => false);
}

/** A page's origin, or null for an address that is not one. */
export function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Downtime inside the window, in whole minutes; an incident still open runs to the end of the window or now. */
export function overlapMinutes(startedAt: string, endedAt: string | null, from: string, to: string, now = Date.now()): number {
  const start = Math.max(Date.parse(startedAt), Date.parse(from));
  const end = Math.min(endedAt ? Date.parse(endedAt) : now, Date.parse(to));
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** The share of checks that were not down, to two decimals; null with nothing checked. */
export function uptimePct(checks: number, down: number): number | null {
  return checks > 0 ? Math.round(((checks - down) / checks) * 10_000) / 100 : null;
}

interface SiteRow {
  origin: string;
  ssl_status: NonNullable<SiteHealthSummary['ssl']>['status'] | null;
  ssl_valid_to: string | null;
  ssl_issuer: string | null;
  ssl_detail: string | null;
  ssl_checked_at: string | null;
  domain_name: string | null;
  domain_status: NonNullable<SiteHealthSummary['domain']>['status'] | null;
  domain_expires_at: string | null;
  domain_registrar: string | null;
  domain_detail: string | null;
  domain_checked_at: string | null;
}

/** IN lists go as one JSON array: a report over 300 monitors is still one statement each, inside D1's 100 binds. */
const IN_JSON = 'IN (SELECT value FROM json_each(?2))';

/**
 * Site health for the sites behind these monitors, over [from, to) (ISO strings): one entry per distinct origin,
 * uptime/incidents within the window, the latest SSL/domain state, and broken links from the latest check of each page
 * (with `fixed` = broken links that were resolved inside the window). Only rows owned by `userId`. [] before 0020.
 */
export async function siteHealthForWatches(userId: string, watchIds: string[], from: string, to: string): Promise<SiteHealthSummary[]> {
  const start = new Date(from);
  const end = new Date(to);
  if (!watchIds.length || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !(await siteHealthAvailable())) return [];
  // Normalised, so '2026-10-01T00:00:00Z' compares with stored '2026-10-01T00:00:00.000Z' as the same moment.
  const [fromIso, toIso] = [start.toISOString(), end.toISOString()];
  const ids = JSON.stringify([...new Set(watchIds)]);

  // Ownership first: every later query is over these monitors and their origins, and each filters by user again.
  const { results: watches } = await env.DB.prepare(`SELECT id, url FROM watches WHERE user_id = ?1 AND id ${IN_JSON}`)
    .bind(userId, ids)
    .all<{ id: string; url: string }>();
  const order = new Map(watchIds.map((id, index) => [id, index]));
  const owned = (watches ?? []).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const pageOf = new Map(owned.map((watch) => [watch.id, watch.url]));
  const watchesByOrigin = new Map<string, string[]>();
  for (const watch of owned) {
    const origin = originOf(watch.url);
    if (!origin) continue;
    watchesByOrigin.set(origin, [...(watchesByOrigin.get(origin) ?? []), watch.id]);
  }
  if (!watchesByOrigin.size) return [];
  const origins = JSON.stringify([...watchesByOrigin.keys()]);
  const ownedIds = JSON.stringify(owned.map((watch) => watch.id));

  const [sites, uptime, incidents, checks, broken, fixed] = await Promise.all([
    env.DB.prepare(`SELECT * FROM site_health_sites WHERE user_id = ?1 AND origin ${IN_JSON}`).bind(userId, origins).all<SiteRow>(),
    env.DB.prepare(
      `SELECT origin, SUM(checks) AS checks, SUM(down) AS down FROM site_uptime_hourly
       WHERE user_id = ?1 AND origin ${IN_JSON} AND hour >= ?3 AND hour < ?4 GROUP BY origin`,
    )
      .bind(userId, origins, fromIso, toIso)
      .all<{ origin: string; checks: number; down: number }>(),
    env.DB.prepare(
      `SELECT origin, started_at, ended_at, detail FROM site_uptime_incidents
       WHERE user_id = ?1 AND origin ${IN_JSON} AND started_at < ?4 AND (ended_at IS NULL OR ended_at >= ?3)
       ORDER BY started_at LIMIT 500`,
    )
      .bind(userId, origins, fromIso, toIso)
      .all<{ origin: string; started_at: string; ended_at: string | null; detail: string }>(),
    env.DB.prepare(`SELECT watch_id, checked_at, checked FROM site_link_checks WHERE user_id = ?1 AND watch_id ${IN_JSON} AND checked_at IS NOT NULL`)
      .bind(userId, ownedIds)
      .all<{ watch_id: string; checked_at: string; checked: number }>(),
    env.DB.prepare(
      `SELECT watch_id, url, status, reason FROM site_broken_links
       WHERE user_id = ?1 AND watch_id ${IN_JSON} AND fixed_at IS NULL ORDER BY first_seen_at, url LIMIT 1000`,
    )
      .bind(userId, ownedIds)
      .all<{ watch_id: string; url: string; status: number | null; reason: string }>(),
    env.DB.prepare(
      `SELECT watch_id, COUNT(*) AS n FROM site_broken_links
       WHERE user_id = ?1 AND watch_id ${IN_JSON} AND fixed_at >= ?3 AND fixed_at < ?4 GROUP BY watch_id`,
    )
      .bind(userId, ownedIds, fromIso, toIso)
      .all<{ watch_id: string; n: number }>(),
  ]);

  const siteBy = new Map((sites.results ?? []).map((row) => [row.origin, row]));
  const uptimeBy = new Map((uptime.results ?? []).map((row) => [row.origin, row]));
  const checkBy = new Map((checks.results ?? []).map((row) => [row.watch_id, row]));
  const fixedBy = new Map((fixed.results ?? []).map((row) => [row.watch_id, Number(row.n)]));
  const now = Date.now();

  return [...watchesByOrigin].map(([origin, ids]): SiteHealthSummary => {
    const site = siteBy.get(origin);
    const rollup = uptimeBy.get(origin);
    const within = (incidents.results ?? [])
      .filter((row) => row.origin === origin)
      .map((row) => ({
        startedAt: row.started_at,
        endedAt: row.ended_at,
        minutes: overlapMinutes(row.started_at, row.ended_at, fromIso, toIso, now),
        detail: row.detail,
      }));
    const checksIn = Number(rollup?.checks ?? 0);
    const downIn = Number(rollup?.down ?? 0);

    const pages = ids.filter((id) => checkBy.has(id));
    const links: SiteHealthSummary['links'] = pages.length
      ? {
          checkedAt: pages.map((id) => checkBy.get(id)!.checked_at).sort().at(-1)!,
          pages: pages.length,
          checked: pages.reduce((sum, id) => sum + Number(checkBy.get(id)!.checked), 0),
          broken: (broken.results ?? [])
            .filter((row) => ids.includes(row.watch_id))
            .map((row) => ({ page: pageOf.get(row.watch_id)!, url: row.url, status: row.status, reason: row.reason })),
          fixed: ids.reduce((sum, id) => sum + (fixedBy.get(id) ?? 0), 0),
        }
      : null;

    return {
      origin,
      uptime: checksIn || within.length ? { checks: checksIn, down: downIn, pct: uptimePct(checksIn, downIn), incidents: within } : null,
      ssl:
        site?.ssl_status && site.ssl_checked_at
          ? { status: site.ssl_status, validTo: site.ssl_valid_to, issuer: site.ssl_issuer, checkedAt: site.ssl_checked_at, detail: site.ssl_detail ?? '' }
          : null,
      domain:
        site?.domain_status && site.domain_checked_at
          ? {
              status: site.domain_status,
              domain: site.domain_name ?? new URL(origin).hostname,
              expiresAt: site.domain_expires_at,
              registrar: site.domain_registrar,
              checkedAt: site.domain_checked_at,
              detail: site.domain_detail ?? '',
            }
          : null,
      links,
    };
  });
}

/**
 * What deleting an account removes here, once migration 0020 exists. Child
 * rows of monitors first: the monitors themselves go later in the same batch.
 */
export async function siteHealthCleanup(userId: string): Promise<D1PreparedStatement[]> {
  if (!(await siteHealthAvailable())) return [];
  return [
    env.DB.prepare('DELETE FROM site_broken_links WHERE watch_id IN (SELECT id FROM watches WHERE user_id = ?)').bind(userId),
    env.DB.prepare('DELETE FROM site_link_checks WHERE watch_id IN (SELECT id FROM watches WHERE user_id = ?)').bind(userId),
    env.DB.prepare('DELETE FROM site_uptime_incidents WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM site_uptime_hourly WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM site_health_sites WHERE user_id = ?').bind(userId),
  ];
}
