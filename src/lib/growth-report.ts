import { env } from 'cloudflare:workers';

/**
 * The owner's growth dashboard (/app/growth): where signups come from, what
 * referrals did, how many accounts got going and how many pay.
 *
 * Every query reads the last 90 days of signup_sources or referrals through
 * their created_at index, groups them and keeps the top rows, so the page
 * costs the same however long the service has run. Counts start when
 * migration 0017 was applied; accounts from before it have no source.
 */

/** OWNER_EMAILS: a comma-separated list, compared without regard to case. Unset means nobody. */
export function isOwner(email: string | null | undefined): boolean {
  const mine = (email ?? '').trim().toLowerCase();
  if (!mine) return false;
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .includes(mine);
}

export const WINDOWS = [7, 30, 90] as const;

/** One figure over each window: last 7, 30 and 90 days. */
export type Counts = [number, number, number];

export interface CountRow {
  label: string;
  counts: Counts;
}

export interface PaidRow {
  label: string;
  signups: Counts;
  paid: Counts;
}

export interface GrowthReport {
  overview: {
    signups: Counts;
    report: Counts;
    tools: Counts;
    referral: Counts;
    ios: Counts;
    direct: Counts;
    active: Counts;
    paid: Counts;
  };
  refs: CountRow[];
  campaigns: CountRow[];
  sites: CountRow[];
  paidByChannel: PaidRow[];
  referrals: { invited: Counts; pending: Counts; rewarded: Counts; rejected: Counts };
  rejections: CountRow[];
}

const ROWS = 25;

/** `SUM(created_at >= 7d AND x), SUM(… 30d …), SUM(x)` as `name_7, name_30, name_90`; the WHERE holds the 90 days. */
function windowed(name: string, condition: string, column = 's.created_at'): string {
  return `COALESCE(SUM(${column} >= ?1 AND (${condition})), 0) AS ${name}_7,
          COALESCE(SUM(${column} >= ?2 AND (${condition})), 0) AS ${name}_30,
          COALESCE(SUM(${condition}), 0) AS ${name}_90`;
}

const counts = (row: Record<string, unknown> | null | undefined, name: string): Counts =>
  [7, 30, 90].map((days) => Number(row?.[`${name}_${days}`] ?? 0)) as Counts;

/**
 * The one name a signup is counted under: its ref (every referral link as
 * one), else its UTM source ('ios' for the app), else the site that sent it,
 * else direct.
 */
const CHANNEL = `CASE
  WHEN s.ref LIKE 'referral:%' THEN 'referral'
  WHEN s.ref IS NOT NULL THEN 'ref: ' || s.ref
  WHEN s.source IS NOT NULL THEN s.source
  WHEN s.referrer_host IS NOT NULL THEN 'site: ' || s.referrer_host
  ELSE 'direct' END`;

/**
 * A first capture or a monitor: a finished capture, any screenshot counted in
 * any month (captures past retention are gone, their counts are not), or a
 * saved monitor.
 */
const ACTIVE = `(EXISTS (SELECT 1 FROM captures k WHERE k.user_id = s.user_id AND k.status = 'done')
  OR EXISTS (SELECT 1 FROM usage_counters c WHERE c.user_id = s.user_id AND c.via_app + c.via_api + c.via_watch > 0)
  OR EXISTS (SELECT 1 FROM watches w WHERE w.user_id = s.user_id))`;

/** On a paid plan now, through Stripe or Apple. */
const PAID = `(u.plan <> 'free' OR COALESCE(u.apple_expires_at, '') > ?4)`;

export async function growthReport(now = new Date()): Promise<GrowthReport> {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const windows = [cutoff(7), cutoff(30), cutoff(90)];
  const at = now.toISOString();
  const grouped = (label: string, where: string) =>
    env.DB.prepare(
      `SELECT ${label} AS label, ${windowed('n', '1')}
       FROM signup_sources s WHERE s.created_at >= ?3 AND ${where}
       GROUP BY 1 ORDER BY n_90 DESC, label LIMIT ${ROWS}`,
    )
      .bind(...windows)
      .all<Record<string, unknown>>();

  const [overview, refs, campaigns, sites, paid, referrals, rejections] = await Promise.all([
    env.DB.prepare(
      `SELECT ${windowed('signups', '1')},
              ${windowed('report', `s.ref = 'report'`)},
              ${windowed('tools', `s.ref LIKE 'tool-%'`)},
              ${windowed('referral', `s.ref LIKE 'referral:%'`)},
              ${windowed('ios', `s.source = 'ios'`)},
              ${windowed('direct', `s.ref IS NULL AND s.source IS NULL AND s.referrer_host IS NULL`)},
              ${windowed('active', ACTIVE)},
              ${windowed('paid', PAID)}
       FROM signup_sources s JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= ?3`,
    )
      .bind(...windows, at)
      .first<Record<string, unknown>>(),
    grouped(`CASE WHEN s.ref LIKE 'referral:%' THEN 'referral (all links)' ELSE s.ref END`, 's.ref IS NOT NULL'),
    grouped(
      `COALESCE(s.source, '—') || ' / ' || COALESCE(s.medium, '—') || ' / ' || COALESCE(s.campaign, '—')`,
      '(s.source IS NOT NULL OR s.medium IS NOT NULL OR s.campaign IS NOT NULL)',
    ),
    grouped('s.referrer_host', 's.referrer_host IS NOT NULL'),
    env.DB.prepare(
      `SELECT ${CHANNEL} AS label, ${windowed('signups', '1')}, ${windowed('paid', PAID)}
       FROM signup_sources s JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= ?3
       GROUP BY 1 ORDER BY paid_90 DESC, signups_90 DESC, label LIMIT ${ROWS}`,
    )
      .bind(...windows, at)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT ${windowed('invited', '1', 'r.created_at')},
              ${windowed('pending', `r.status = 'pending'`, 'r.created_at')},
              ${windowed('rewarded', `r.status = 'rewarded'`, 'r.created_at')},
              ${windowed('rejected', `r.status = 'rejected'`, 'r.created_at')}
       FROM referrals r WHERE r.created_at >= ?3`,
    )
      .bind(...windows)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COALESCE(r.reason, 'unspecified') AS label, ${windowed('n', '1', 'r.created_at')}
       FROM referrals r WHERE r.created_at >= ?3 AND r.status = 'rejected'
       GROUP BY 1 ORDER BY n_90 DESC, label LIMIT ${ROWS}`,
    )
      .bind(...windows)
      .all<Record<string, unknown>>(),
  ]);

  const rows = (result: { results?: Record<string, unknown>[] }): CountRow[] =>
    (result.results ?? []).map((row) => ({ label: String(row.label ?? '—'), counts: counts(row, 'n') }));

  return {
    overview: {
      signups: counts(overview, 'signups'),
      report: counts(overview, 'report'),
      tools: counts(overview, 'tools'),
      referral: counts(overview, 'referral'),
      ios: counts(overview, 'ios'),
      direct: counts(overview, 'direct'),
      active: counts(overview, 'active'),
      paid: counts(overview, 'paid'),
    },
    refs: rows(refs),
    campaigns: rows(campaigns),
    sites: rows(sites),
    paidByChannel: (paid.results ?? []).map((row) => ({
      label: String(row.label ?? '—'),
      signups: counts(row, 'signups'),
      paid: counts(row, 'paid'),
    })),
    referrals: {
      invited: counts(referrals, 'invited'),
      pending: counts(referrals, 'pending'),
      rewarded: counts(referrals, 'rewarded'),
      rejected: counts(referrals, 'rejected'),
    },
    rejections: rows(rejections),
  };
}
