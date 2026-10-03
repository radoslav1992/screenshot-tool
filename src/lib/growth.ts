import { env } from 'cloudflare:workers';
import type { SessionUser } from './auth';
import { clientIp } from './auth-throttle';
import { looksLikeAppSignup, parseAttribution, referralCode } from './attribution';
import { prefixedId, randomId, sha256Hex } from './ids';
import { canSendEmail, sendMail } from './mailer';

/**
 * Signup sources, referrals and bonus screenshots (migration 0017).
 *
 * Everything here waits for the tables: before they exist signup saves
 * nothing, no account has a referral code, nobody has a bonus and the quota
 * works exactly as it always has. The quota side of the bonus lives in
 * lib/captures.ts, next to the allowance it extends.
 */

/** What each side of a referral gets once the referred account is real. */
export const REFERRAL_BONUS = 100;
/** Rewarded referrals one account can earn from. */
export const REFERRAL_CAP = 20;

export const GROWTH_TABLES = ['signup_sources', 'referral_codes', 'referrals', 'bonus_balances', 'bonus_usage'];

/** Cached per isolate like signoffsReady: a yes for good, a no for a minute. */
let growthTables: { ready: boolean; at: number } | undefined;
export async function growthReady(): Promise<boolean> {
  if (growthTables && (growthTables.ready || Date.now() - growthTables.at < 60_000)) return growthTables.ready;
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${GROWTH_TABLES.map(() => '?').join(',')})`,
  )
    .bind(...GROWTH_TABLES)
    .first<{ n: number }>();
  growthTables = { ready: row?.n === GROWTH_TABLES.length, at: Date.now() };
  return growthTables.ready;
}

/** For quota checks and pages that must not fail on a probe: an unreachable database reads as "not yet". */
export async function growthAvailable(): Promise<boolean> {
  return growthReady().catch(() => false);
}

/* -------------------------------------------------------------------------- */
/* Signup                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The signup address, hashed and cut short: enough to tell that two accounts
 * signed up from the same place, not to say where. Unknown (local runs) is no
 * address at all, so it never matches.
 */
export async function signupIpHash(request: Request): Promise<string | null> {
  const ip = clientIp(request);
  return ip === 'unknown' ? null : (await sha256Hex(`signup-ip:${ip}`)).slice(0, 32);
}

const domainOf = (email: string) => email.trim().toLowerCase().split('@').pop() ?? '';

/**
 * Saves where a new account came from: the attribution cookie, or 'ios' for
 * the app, which signs up with no cookie at all. A referral cookie also opens
 * the referral. Returns whether anything was saved, so signup knows to clear
 * the cookie.
 */
export async function recordSignup(
  user: Pick<SessionUser, 'id' | 'email'>,
  request: Request,
  cookie: string | undefined,
): Promise<boolean> {
  if (!(await growthReady())) return false;
  const touch = parseAttribution(cookie);
  const app = cookie === undefined && looksLikeAppSignup(request);
  const ipHash = await signupIpHash(request);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO signup_sources
       (user_id, ref, source, medium, campaign, landing, referrer_host, touched_at, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      user.id,
      touch?.ref ?? null,
      app ? 'ios' : (touch?.source ?? null),
      touch?.medium ?? null,
      touch?.campaign ?? null,
      touch?.landing ?? null,
      touch?.referrerHost ?? null,
      touch?.at ?? null,
      ipHash,
      now,
    )
    .run();
  const code = referralCode(touch);
  if (code) await openReferral(user, code, ipHash, now);
  return true;
}

/**
 * One referral per new account, whoever's link it followed. Refused at once
 * when it is plainly the same person — the same email domain and the same
 * signup address — or the referrer has had every reward there is.
 */
async function openReferral(
  user: Pick<SessionUser, 'id' | 'email'>,
  code: string,
  ipHash: string | null,
  now: string,
): Promise<void> {
  const referrer = await env.DB.prepare(
    `SELECT c.user_id AS id, u.email_lower AS email, s.ip_hash,
            (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = c.user_id AND r.status = 'rewarded') AS rewarded
     FROM referral_codes c JOIN users u ON u.id = c.user_id LEFT JOIN signup_sources s ON s.user_id = c.user_id
     WHERE c.code = ?`,
  )
    .bind(code)
    .first<{ id: string; email: string; ip_hash: string | null; rewarded: number }>();
  if (!referrer) return;
  const reason =
    referrer.id === user.id
      ? 'self'
      : domainOf(referrer.email) === domainOf(user.email) && ipHash && referrer.ip_hash === ipHash
        ? 'same_person'
        : referrer.rewarded >= REFERRAL_CAP
          ? 'limit_reached'
          : null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO referrals (id, referrer_id, referred_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(prefixedId('rfl', 12), referrer.id, user.id, reason ? 'rejected' : 'pending', reason, now)
    .run();
}

/* -------------------------------------------------------------------------- */
/* Codes                                                                       */
/* -------------------------------------------------------------------------- */

export function referralUrl(origin: string, code: string): string {
  return `${origin}/join/${code}`;
}

/**
 * The account's referral code, made the first time it is asked for and the
 * same ever after. A new code that happens to be someone else's is ignored by
 * the unique index and another is tried.
 */
export async function referralCodeFor(userId: string): Promise<string | null> {
  if (!(await growthReady())) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await env.DB.prepare(`SELECT code FROM referral_codes WHERE user_id = ?`)
      .bind(userId)
      .first<{ code: string }>();
    if (row) return row.code;
    await env.DB.prepare(`INSERT OR IGNORE INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?)`)
      .bind(userId, randomId(8), new Date().toISOString())
      .run();
  }
  return null;
}

/** Whose link this is, for /join. */
export async function referrerOf(code: string): Promise<string | null> {
  if (!/^[a-z0-9]{6,16}$/.test(code) || !(await growthReady())) return null;
  const row = await env.DB.prepare(`SELECT user_id FROM referral_codes WHERE code = ?`)
    .bind(code)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export interface ReferralSummary {
  code: string;
  /** Accounts created through the link, whatever became of them. */
  invited: number;
  rewarded: number;
  pending: number;
  bonus: number;
}

/** What the account page shows. Null until the tables exist. */
export async function referralSummary(userId: string): Promise<ReferralSummary | null> {
  const code = await referralCodeFor(userId);
  if (!code) return null;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS invited,
            COALESCE(SUM(status = 'rewarded'), 0) AS rewarded,
            COALESCE(SUM(status = 'pending'), 0) AS pending,
            (SELECT screenshots FROM bonus_balances WHERE user_id = ?1) AS bonus
     FROM referrals WHERE referrer_id = ?1`,
  )
    .bind(userId)
    .first<{ invited: number; rewarded: number; pending: number; bonus: number | null }>();
  return {
    code,
    invited: row?.invited ?? 0,
    rewarded: row?.rewarded ?? 0,
    pending: row?.pending ?? 0,
    bonus: row?.bonus ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Rewards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pays a pending referral once the referred account is real: its email is
 * confirmed — or, where this deployment cannot send the confirmation, that
 * check is left to activity alone — and it has a finished capture or monitor
 * check. Called after each of those; most calls find nothing pending and end
 * at one indexed read.
 *
 * Both balances and the status change are one batch, and every statement in
 * it asks the same question of the referral row, which only the last one
 * changes: so either all of it happens or none, and of two calls racing the
 * second finds the row no longer pending. The referrer is emailed by the call
 * that made the change, which is therefore exactly once.
 *
 * Never throws: it runs at the end of a capture, which has happened either way.
 */
export async function rewardReferral(referredId: string, origin = env.PUBLIC_SITE_URL): Promise<boolean> {
  try {
    if (!(await growthReady())) return false;
    const row = await env.DB.prepare(
      `SELECT r.id, r.referrer_id, ref.email AS referrer_email, u.email_verified_at,
              (EXISTS (SELECT 1 FROM captures c WHERE c.user_id = r.referred_id AND c.status = 'done')
               OR EXISTS (SELECT 1 FROM watch_runs w WHERE w.user_id = r.referred_id AND w.status = 'done')) AS active
       FROM referrals r JOIN users u ON u.id = r.referred_id JOIN users ref ON ref.id = r.referrer_id
       WHERE r.referred_id = ? AND r.status = 'pending'`,
    )
      .bind(referredId)
      .first<{ id: string; referrer_id: string; referrer_email: string; email_verified_at: string | null; active: number }>();
    if (!row || !row.active) return false;
    if (canSendEmail() && !row.email_verified_at) return false;

    const now = new Date().toISOString();
    const eligible = `r.id = ?1 AND r.status = 'pending'
      AND (SELECT COUNT(*) FROM referrals x WHERE x.referrer_id = r.referrer_id AND x.status = 'rewarded') < ?2`;
    const credit = (side: 'referrer_id' | 'referred_id') =>
      env.DB.prepare(
        `INSERT INTO bonus_balances (user_id, screenshots, updated_at)
         SELECT r.${side}, ?3, ?4 FROM referrals r WHERE ${eligible}
         ON CONFLICT(user_id) DO UPDATE SET screenshots = screenshots + excluded.screenshots, updated_at = excluded.updated_at`,
      ).bind(row.id, REFERRAL_CAP, REFERRAL_BONUS, now);
    const [, , rewarded] = await env.DB.batch([
      credit('referrer_id'),
      credit('referred_id'),
      env.DB.prepare(
        `UPDATE referrals SET status = 'rewarded', rewarded_at = ?3
         WHERE id IN (SELECT r.id FROM referrals r WHERE ${eligible})`,
      ).bind(row.id, REFERRAL_CAP, now),
      // Still pending after that only when the referrer has had every reward there is.
      env.DB.prepare(`UPDATE referrals SET status = 'rejected', reason = 'limit_reached' WHERE id = ? AND status = 'pending'`).bind(
        row.id,
      ),
    ]);
    if (!rewarded?.meta?.changes) return false;

    const balance = await env.DB.prepare(`SELECT screenshots FROM bonus_balances WHERE user_id = ?`)
      .bind(row.referrer_id)
      .first<{ screenshots: number }>();
    const sent = await sendMail({
      to: row.referrer_email,
      subject: `You earned ${REFERRAL_BONUS} bonus screenshots`,
      text:
        `Someone you invited to Easy Screen Capture has confirmed their account and taken their first capture, ` +
        `so you both get ${REFERRAL_BONUS} bonus screenshots.\n\n` +
        `Bonus screenshots are used once your monthly allowance runs out, and they never expire. ` +
        `You now have ${(balance?.screenshots ?? REFERRAL_BONUS).toLocaleString('en-US')}.\n\n` +
        `Invite someone else from your account page (up to ${REFERRAL_CAP} rewards in all):\n${origin}/app/account#invite`,
    }).catch(() => false);
    if (!sent) console.error(`[referrals] reward email to ${row.referrer_id} was not sent`);
    return true;
  } catch (error) {
    console.error('[referrals] could not check a referral reward', error);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Account deletion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What deleting an account removes from these tables. Its own code, source,
 * balance and the referrals it sent go. A referral that brought it in stays
 * with whoever sent it — a bonus already paid is theirs, and their history and
 * cap stay as they were — but no longer points at the deleted account; one
 * still pending can never be paid, so it is closed.
 */
export async function growthCleanup(userId: string): Promise<D1PreparedStatement[]> {
  if (!(await growthReady())) return [];
  return [
    env.DB.prepare(`DELETE FROM referrals WHERE referrer_id = ?`).bind(userId),
    env.DB.prepare(
      `UPDATE referrals SET referred_id = NULL,
              reason = CASE status WHEN 'pending' THEN 'account_deleted' ELSE reason END,
              status = CASE status WHEN 'pending' THEN 'rejected' ELSE status END
       WHERE referred_id = ?`,
    ).bind(userId),
    ...['referral_codes', 'signup_sources', 'bonus_balances', 'bonus_usage'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
    ),
  ];
}
