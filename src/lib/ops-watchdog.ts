import { env } from 'cloudflare:workers';
import { captureJobsReady } from './capture-jobs';
import { ownerEmails } from './growth-report';
import { canSendEmail, sendMail } from './mailer';
import { migrationStatus, type MigrationStatus } from './schema-manifest';

/**
 * The service watching itself.
 *
 * The uptime workflow (.github/workflows/uptime.yml) sees what a visitor sees:
 * the site answers and /api/health is green. This sees what nobody visits:
 * the background work. Once an hour it asks whether monitors run on time,
 * whether the capture queue moves and whether the renderer serves them, and
 * emails OWNER_EMAILS when that answer changes: when something breaks, again
 * once a day while it stays broken, and once when it is all clear.
 *
 * Every question is a read through an index the app already has, so an hour's
 * check costs a handful of rows. What it last saw is one KV value, which
 * /api/health also reads: a sweep that stopped writing it is a cron that
 * stopped firing, and that is the one failure this cannot email about itself.
 */

export const WATCHDOG_KEY = 'ops:watchdog';
/** An hourly monitor that has missed two sweeps. Claims move next_run_at forward, so a check in progress is never late. */
export const MONITORS_LATE_MS = 2 * 60 * 60_000;
/** How far back "ran recently" reaches. */
export const RECENT_MS = 2 * 60 * 60_000;
/** Renderer trouble: at least this many monitors that ran recently could not be served... */
export const RENDERER_MIN_FAILING = 3;
/** ...and they are at least this share of the ones that ran. */
export const RENDERER_FAILING_SHARE = 0.5;
/** Work waiting this long while nothing finishes means the minute cron stopped taking it. */
export const QUEUE_WAITING_MS = 30 * 60_000;
export const QUEUE_IDLE_MS = 15 * 60_000;
/** While something stays broken, say so again once a day. */
export const REMIND_MS = 24 * 60 * 60_000;
/** The sweep is hourly; older than this, it has missed at least one. */
export const HEARTBEAT_STALE_MS = 2 * 60 * 60_000 + 15 * 60_000;

/** Written by watches.ts on a failure of the service rather than of the page. */
const TEMPORARY = 'Temporarily unavailable: ';

export type CheckKey = 'database' | 'schema' | 'storage' | 'kv' | 'renderer' | 'monitors' | 'queue';

export interface ServiceCheck {
  key: CheckKey;
  ok: boolean;
  title: string;
  detail?: string;
}

export interface WatchdogState {
  checkedAt: string;
  failing: CheckKey[];
  /** When the current set of failures began; null while everything passes. */
  since: string | null;
  notifiedAt: string | null;
}

export interface WatchdogResult {
  checks: ServiceCheck[];
  failing: CheckKey[];
  /** 'problem' and 'reminder' list what is failing; 'recovered' says it is all clear. */
  sent: 'problem' | 'reminder' | 'recovered' | null;
  recipients: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const iso = (ms: number) => new Date(ms).toISOString();

/** Each question on its own: one that cannot be asked is a failure of that check, never of the run. */
export async function serviceChecks(now: number): Promise<ServiceCheck[]> {
  const checks: ServiceCheck[] = [];

  let database = false;
  try {
    const migrations = await migrationStatus(env.DB);
    database = true;
    checks.push({ key: 'database', ok: true, title: 'Database' });
    const missing = migrations.filter(
      (entry): entry is Extract<MigrationStatus, { applied: false }> => !entry.applied && !entry.optional,
    );
    checks.push(
      missing.length
        ? {
            key: 'schema',
            ok: false,
            title: 'Database schema',
            detail: `Required migrations are not applied: ${missing.map((entry) => entry.name).join(', ')}. Paste ${missing.map((entry) => entry.upgrade).join(', then ')} into the D1 console.`,
          }
        : { key: 'schema', ok: true, title: 'Database schema' },
    );
  } catch (error) {
    checks.push({ key: 'database', ok: false, title: 'Database', detail: message(error) });
  }

  try {
    if (!env.SHOTS) throw new Error('No SHOTS binding on this deployment.');
    await env.SHOTS.head('__healthcheck__');
    checks.push({ key: 'storage', ok: true, title: 'File storage (R2)' });
  } catch (error) {
    checks.push({ key: 'storage', ok: false, title: 'File storage (R2)', detail: message(error) });
  }

  try {
    if (!env.RATE) throw new Error('No RATE binding on this deployment.');
    await env.RATE.get('__healthcheck__');
    checks.push({ key: 'kv', ok: true, title: 'KV' });
  } catch (error) {
    checks.push({ key: 'kv', ok: false, title: 'KV', detail: message(error) });
  }

  if (!database) return checks;

  // Late monitors: the sweep is not reaching them. idx_watches_due reads only the late rows.
  try {
    const late = await env.DB.prepare(
      `SELECT count(*) AS n, min(next_run_at) AS oldest FROM watches WHERE status = 'active' AND next_run_at < ?`,
    )
      .bind(iso(now - MONITORS_LATE_MS))
      .first<{ n: number; oldest: string | null }>();
    const n = Number(late?.n ?? 0);
    checks.push(
      n
        ? {
            key: 'monitors',
            ok: false,
            title: 'Monitors running on time',
            detail: `${n} active monitor${n === 1 ? ' is' : 's are'} more than two hours late (the oldest was due ${late?.oldest}). The hourly sweep is not reaching them: check the cron trigger and the [watch] lines in the Worker logs.`,
          }
        : { key: 'monitors', ok: true, title: 'Monitors running on time' },
    );
  } catch (error) {
    checks.push({ key: 'monitors', ok: false, title: 'Monitors running on time', detail: message(error) });
  }

  // The renderer: monitors that ran recently and failed for a reason that was
  // ours, not the page's. A success clears last_error, so this is their latest run.
  try {
    const ran = await env.DB.prepare(
      `SELECT count(*) AS ran, coalesce(sum(substr(coalesce(last_error, ''), 1, ?) = ?), 0) AS unserved
         FROM watches WHERE status = 'active' AND last_run_at >= ?`,
    )
      .bind(TEMPORARY.length, TEMPORARY, iso(now - RECENT_MS))
      .first<{ ran: number; unserved: number }>();
    const total = Number(ran?.ran ?? 0);
    const unserved = Number(ran?.unserved ?? 0);
    const down = unserved >= RENDERER_MIN_FAILING && unserved >= total * RENDERER_FAILING_SHARE;
    checks.push(
      down
        ? {
            key: 'renderer',
            ok: false,
            title: 'Screenshots rendering',
            detail: `${unserved} of the ${total} monitors checked in the last two hours could not be rendered for a reason on our side (browser limit, rate limit or an unreachable renderer). Check Browser Rendering usage and limits in the Cloudflare dashboard.`,
          }
        : { key: 'renderer', ok: true, title: 'Screenshots rendering' },
    );
  } catch (error) {
    checks.push({ key: 'renderer', ok: false, title: 'Screenshots rendering', detail: message(error) });
  }

  // The capture queue (migration 0013): a long queue is fine while it moves; it
  // is stuck when work has waited half an hour and nothing finished in fifteen.
  try {
    if (await captureJobsReady()) {
      const queue = await env.DB.prepare(
        `SELECT (SELECT count(*) FROM capture_jobs WHERE status = 'queued' AND run_after < ?) AS waiting,
                (SELECT max(updated_at) FROM capture_jobs WHERE status IN ('done', 'error')) AS finished`,
      )
        .bind(iso(now - QUEUE_WAITING_MS))
        .first<{ waiting: number; finished: string | null }>();
      const waiting = Number(queue?.waiting ?? 0);
      const idle = !queue?.finished || Date.parse(queue.finished) < now - QUEUE_IDLE_MS;
      checks.push(
        waiting && idle
          ? {
              key: 'queue',
              ok: false,
              title: 'Background captures moving',
              detail: `${waiting} background capture${waiting === 1 ? ' has' : 's have'} waited more than 30 minutes and none finished in the last 15 (last one: ${queue?.finished ?? 'never'}). Check the minute cron and the [jobs] lines in the Worker logs.`,
            }
          : { key: 'queue', ok: true, title: 'Background captures moving' },
      );
    }
  } catch (error) {
    checks.push({ key: 'queue', ok: false, title: 'Background captures moving', detail: message(error) });
  }

  return checks;
}

async function readState(): Promise<WatchdogState | null> {
  try {
    return (await env.RATE?.get<WatchdogState>(WATCHDOG_KEY, 'json')) ?? null;
  } catch {
    return null;
  }
}

/** What /api/health reports about the sweep: when it last ran. Never written means never checked yet. */
export async function lastWatchdogRun(): Promise<string | null> {
  return (await readState())?.checkedAt ?? null;
}

function letter(kind: 'problem' | 'reminder' | 'recovered', checks: ServiceCheck[], since: string | null, origin: string) {
  const failing = checks.filter((check) => !check.ok);
  const health = `${origin}/api/health`;
  if (kind === 'recovered') {
    return {
      subject: 'Easy Screen Capture: all checks pass again',
      text:
        `Every background check passes again${since ? ` (the trouble began ${since})` : ''}.\n\n` +
        checks.map((check) => `  ✓ ${check.title}`).join('\n') +
        `\n\nLive status: ${health}\n`,
    };
  }
  const count = `${failing.length} problem${failing.length === 1 ? '' : 's'}`;
  return {
    subject: `Easy Screen Capture: ${count} ${kind === 'reminder' ? 'still ' : ''}need${failing.length === 1 ? 's' : ''} a look`,
    text:
      `${kind === 'reminder' ? `Still failing since ${since}.` : 'The hourly self-check found a problem.'}\n\n` +
      failing.map((check) => `✗ ${check.title}\n  ${check.detail ?? 'Failed.'}`).join('\n\n') +
      `\n\nPassing: ${checks.filter((check) => check.ok).map((check) => check.title).join(', ') || 'nothing else'}.` +
      `\n\nLive status: ${health}\nWorker logs: Cloudflare dashboard → Workers → screenify → Logs.\n\n` +
      `You will hear again when it is fixed, or in a day if it is not.\n`,
  };
}

/**
 * The hourly run: check, compare with the last run, mail the owners when the
 * set of failing checks changed or a day passed since the last mail about it,
 * and remember what was seen. Never throws; a cron has nobody to throw to.
 */
export async function runWatchdog(origin: string, now = Date.now()): Promise<WatchdogResult> {
  const checks = await serviceChecks(now).catch((error): ServiceCheck[] => [
    { key: 'database', ok: false, title: 'Self-check', detail: message(error) },
  ]);
  const failing = [...new Set(checks.filter((check) => !check.ok).map((check) => check.key))].sort();
  const previous = await readState();
  const before = [...(previous?.failing ?? [])].sort();
  const changed = failing.join(',') !== before.join(',');

  let kind: WatchdogResult['sent'] = null;
  if (failing.length && changed) kind = 'problem';
  else if (failing.length && (!previous?.notifiedAt || now - Date.parse(previous.notifiedAt) >= REMIND_MS)) kind = 'reminder';
  else if (!failing.length && before.length) kind = 'recovered';

  const state: WatchdogState = {
    checkedAt: iso(now),
    failing,
    since: failing.length ? (before.length && previous?.since ? previous.since : iso(now)) : null,
    notifiedAt: failing.length ? previous?.notifiedAt ?? null : null,
  };

  let recipients = 0;
  if (kind) {
    const owners = ownerEmails();
    const mail = letter(kind, checks, kind === 'recovered' ? previous?.since ?? null : state.since, origin);
    if (owners.length && canSendEmail()) {
      for (const to of owners) if (await sendMail({ to, ...mail }).catch(() => false)) recipients++;
    }
    if (recipients) {
      if (failing.length) state.notifiedAt = iso(now);
    } else {
      // Nobody to tell, or no mail went: the log is the record, and with
      // notifiedAt left as it was, the next run tries again.
      console.error(`[watchdog] ${mail.subject} (not emailed: ${owners.length ? 'no mail could be sent' : 'OWNER_EMAILS is not set'})`);
      kind = null;
    }
  }
  if (failing.length) console.error(`[watchdog] failing=${failing.join(',')}`);

  try {
    await env.RATE?.put(WATCHDOG_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('[watchdog] could not save its state', error);
  }
  return { checks, failing, sent: kind, recipients };
}
