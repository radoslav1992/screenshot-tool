import { env } from 'cloudflare:workers';
import { HttpError, badRequest } from './http';
import { prefixedId, randomToken, sha256Hex } from './ids';
import { loadSessionUser, type SessionUser } from './auth';
import { enforceThrottles } from './auth-throttle';
import { canSendEmail, sendMail } from './mailer';
import { hasConfirmedEmail } from './verification';
import { careEmailsIncluded, careReportsIncluded, CARE_REPORTS, CARE_REPORT_EMAILS, PLANS, PLAN_ORDER } from './plans';
import { oneLine } from './branding-rules';
import { projectBranding } from './branding';
import { ownProject, type Project } from './projects';
import { signoffsReady } from './signoff';
import { ruleKinds } from './monitor-rule-store';
import { decodeRunChanges, decodeRunDetail } from './monitor-health';
import { displayUrl } from './capture-options';
import { siteHealthForWatches, siteHealthReady } from './site-health-summary';
import { careReportsReady } from './care-store';
import { careSummary } from './care-summary';
import {
  manualPeriod,
  monthPeriod,
  nextCareRun,
  previousMonth,
  validTimezone,
  type CarePeriod,
} from './care-period';
import {
  CARE_CHANGES_PER_MONITOR,
  CARE_FINDINGS_PER_MONITOR,
  CARE_LIMITS,
  CARE_LINK_DAYS,
  CARE_MAX_AWAITING,
  CARE_MAX_BROKEN,
  CARE_MAX_INCIDENTS,
  CARE_MAX_MONITORS,
  CARE_MAX_SITES,
  careEmail,
  fitSnapshot,
  nextSteps,
  ownerCopyEmail,
  parseRecipients,
  readSnapshot,
  storedRecipients,
  type CareAwaiting,
  type CareChange,
  type CareHealth,
  type CareMonitor,
  type CareRuleMonitor,
  type CareSignoff,
  type CareSnapshot,
} from './care-rules';

export { careReportsReady } from './care-store';

/**
 * Monthly website care reports: for each client project, a summary of the
 * month — checks, changes, client sign-offs, SEO findings, site health and
 * what to do next — that the agency shares by link and, on the plans that
 * include it, has emailed to the client on the 1st.
 *
 * A report is frozen when it is made. Everything it says is read then and
 * stored as one JSON snapshot, so monitor history pruned by retention, a
 * monitor removed from the project or a sign-off reset later never changes a
 * report a client already has. Only its presentation follows the project as
 * review links do: the logo, accent and footer, and the white label under the
 * owner's current plan.
 *
 * Links are hashed like review links. The owner's own link is shown when it is
 * made and can be replaced; each client gets a link of their own in their
 * email, so replacing the owner's never breaks one already sent, and revoking
 * the report stops them all. Before migration 0021 nothing here does anything:
 * pages hide the panels and every route answers 404.
 */

export interface CareSettings {
  project_id: string;
  enabled: number;
  timezone: string;
  recipients: string[];
  owner_copy: number;
  next_run_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CareReportRow {
  id: string;
  project_id: string;
  user_id: string;
  period: string;
  kind: 'scheduled' | 'manual';
  generated_at: string;
  snapshot: string;
  token_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  last_access_at: string | null;
}

export interface CareDelivery {
  email: string;
  role: 'client' | 'owner';
  status: string;
  created_at: string;
  opened_at: string | null;
  live: number;
}

const TOKEN = /^[a-f0-9]{64}$/;
const DAY_MS = 86_400_000;
/** Due projects one hourly sweep takes on, oldest first; the rest wait for the next hour. */
const SWEEP_BATCH = 20;
/** Past this, a sweep starts no more reports, so it finishes well inside the invocation's time. */
const SWEEP_BUDGET_MS = 5 * 60_000;
/** An email that has not answered in this long is recorded as unknown, and never resent. */
const SEND_TIMEOUT_MS = 15_000;

/** "Pro and Business", from the plan table. */
function planNames(table: Record<string, boolean>): string {
  const names = PLAN_ORDER.filter((id) => table[id]).map((id) => PLANS[id].name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'Business');
}
export const CARE_REPORT_PLANS = planNames(CARE_REPORTS);
export const CARE_EMAIL_PLANS = planNames(CARE_REPORT_EMAILS);

/** 404 before the migration, like every route that depends on it. */
export async function requireCare(): Promise<void> {
  if (!(await careReportsReady())) throw new HttpError(404, 'not_found', 'Not found.');
}

function needsPlan(user: Pick<SessionUser, 'plan'>, emails = false): void {
  if (emails ? !careEmailsIncluded(user.plan) : !careReportsIncluded(user.plan))
    throw new HttpError(
      403,
      'plan_required',
      emails
        ? `Emailing care reports to clients is included on ${CARE_EMAIL_PLANS}.`
        : `Care reports are included on ${CARE_REPORT_PLANS}.`,
    );
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export function defaultSettings(projectId: string): CareSettings {
  return {
    project_id: projectId,
    enabled: 0,
    timezone: 'UTC',
    recipients: [],
    owner_copy: 1,
    next_run_at: null,
    created_at: null,
    updated_at: null,
  };
}

export async function careSettings(projectId: string): Promise<CareSettings> {
  const row = await env.DB.prepare('SELECT * FROM care_report_settings WHERE project_id=?')
    .bind(projectId)
    .first<Omit<CareSettings, 'recipients'> & { recipients: string }>();
  if (!row) return defaultSettings(projectId);
  return { ...row, timezone: validTimezone(row.timezone) ?? 'UTC', recipients: storedRecipients(row.recipients) };
}

async function saveSettings(user: SessionUser, project: Project, b: Record<string, string>, now: Date) {
  const timezone = validTimezone(b.timezone);
  if (!timezone) throw badRequest('Choose a valid IANA timezone, such as Europe/Sofia.', 'timezone');
  const current = await careSettings(project.id);
  const enabled = b.enabled === '1';
  // Without client emails the form cannot change the copy setting; it is kept for an upgrade.
  const ownerCopy = careEmailsIncluded(user.plan) ? b.owner_copy === '1' : !!current.owner_copy;
  let recipients = current.recipients;
  if (careEmailsIncluded(user.plan)) recipients = parseRecipients(b.recipients, user.email);
  else if (enabled || (b.recipients ?? '').trim()) needsPlan(user, true);
  if (enabled) {
    if (!recipients.length && !ownerCopy)
      throw badRequest('Add a client’s address, or tick “Email me a copy”, before turning the schedule on.', 'recipients');
    if (!(await hasConfirmedEmail(user.id)))
      throw new HttpError(
        403,
        'email_unverified',
        'Confirm your email address before emailing reports to clients. Send yourself a confirmation email from your account page.',
      );
  }
  const at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO care_report_settings(project_id,enabled,timezone,recipients,owner_copy,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,timezone=excluded.timezone,recipients=excluded.recipients,
       owner_copy=excluded.owner_copy,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`,
  )
    .bind(project.id, enabled ? 1 : 0, timezone, JSON.stringify(recipients), ownerCopy ? 1 : 0, enabled ? nextCareRun(timezone, now) : null, at, at)
    .run();
  return { ok: true as const };
}

/* -------------------------------------------------------------------------- */
/* Reading reports                                                             */
/* -------------------------------------------------------------------------- */

export interface CareReportListItem {
  id: string;
  period: string;
  kind: 'scheduled' | 'manual';
  generated_at: string;
  expires_at: string;
  revoked_at: string | null;
  access_count: number;
  last_access_at: string | null;
  has_link: number;
  partial: number;
  sent: number;
}

/** A project's reports, newest month first. The snapshot is not read, only two of its fields. */
export async function listCareReports(projectId: string, limit = 24): Promise<CareReportListItem[]> {
  return (
    await env.DB.prepare(
      `SELECT r.id,r.period,r.kind,r.generated_at,r.expires_at,r.revoked_at,r.access_count,r.last_access_at,
         (r.token_hash IS NOT NULL) AS has_link, COALESCE(json_extract(r.snapshot,'$.period.partial'),0) AS partial,
         (SELECT COUNT(*) FROM care_report_deliveries d WHERE d.report_id=r.id AND d.role='client') AS sent
       FROM care_reports r WHERE r.project_id=? ORDER BY r.period DESC, r.kind DESC LIMIT ?`,
    )
      .bind(projectId, limit)
      .all<CareReportListItem>()
  ).results;
}

/** The owner's report, or a 404 that does not say whether it exists for someone else. */
export async function ownCareReport(userId: string, id: string) {
  await requireCare();
  const report = await env.DB.prepare('SELECT * FROM care_reports WHERE id=? AND user_id=?').bind(id, userId).first<CareReportRow>();
  if (!report) throw new HttpError(404, 'not_found', 'Care report not found.');
  const project = await ownProject(userId, report.project_id);
  return { report, project, snapshot: readSnapshot(report.snapshot) };
}

export async function careDeliveries(reportId: string): Promise<CareDelivery[]> {
  return (
    await env.DB.prepare(
      `SELECT email,role,status,created_at,opened_at,(token_hash IS NOT NULL) AS live FROM care_report_deliveries WHERE report_id=? ORDER BY created_at, email`,
    )
      .bind(reportId)
      .all<CareDelivery>()
  ).results;
}

/** Live: not revoked and not past its expiry. */
export function linkLive(report: Pick<CareReportRow, 'revoked_at' | 'expires_at'>, now = new Date()): boolean {
  return !report.revoked_at && report.expires_at > now.toISOString();
}

/**
 * A report by a share link: the owner's or one emailed to a client. Bad,
 * unknown, expired and revoked links are the same 404, so a link says nothing
 * about the report it no longer opens. With `audit`, the view is counted on
 * the report, and a client's link records when it was first opened.
 */
export async function sharedCareReport(token: string, audit = false, now = new Date()) {
  const unavailable = () => new HttpError(404, 'not_found', 'This report link is unavailable.');
  if (!TOKEN.test(token) || !(await careReportsReady())) throw unavailable();
  const hash = await sha256Hex(token);
  let report = await env.DB.prepare('SELECT * FROM care_reports WHERE token_hash=?').bind(hash).first<CareReportRow>();
  let client = false;
  if (!report) {
    report = await env.DB.prepare(
      'SELECT r.* FROM care_report_deliveries d JOIN care_reports r ON r.id=d.report_id WHERE d.token_hash=?',
    )
      .bind(hash)
      .first<CareReportRow>();
    client = !!report;
  }
  if (!report || !linkLive(report, now)) throw unavailable();
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(report.project_id).first<Project>();
  if (!project) throw unavailable();
  let snapshot: CareSnapshot;
  try {
    snapshot = readSnapshot(report.snapshot);
  } catch {
    throw unavailable();
  }
  if (audit) {
    const at = now.toISOString();
    await env.DB.batch([
      env.DB.prepare('UPDATE care_reports SET access_count=access_count+1,last_access_at=? WHERE id=?').bind(at, report.id),
      ...(client
        ? [env.DB.prepare('UPDATE care_report_deliveries SET opened_at=COALESCE(opened_at,?) WHERE token_hash=?').bind(at, hash)]
        : []),
    ]);
  }
  return { report, project, snapshot };
}

/* -------------------------------------------------------------------------- */
/* Building a snapshot                                                         */
/* -------------------------------------------------------------------------- */

/** The run's message for a client: the comparison's verdict on our threshold is ours, not theirs. */
function runSummary(detail: string | null): string {
  const message = decodeRunDetail(detail).detail ?? '';
  return oneLine(
    message
      .replace(/\s*(Met|Below) the [\d.]+% threshold used for this check\./g, '')
      .replace(/\s*Any detected change was enabled for this check\./g, '')
      .replace(/\s*·\s*$/, ''),
  ).slice(0, 300);
}

/** SEO details join their signals with "; ": one line each reads better in a list. */
function findingLines(kind: string, detail: string | null): string[] {
  const message = oneLine(decodeRunDetail(detail).detail ?? '');
  if (!message) return [];
  return (kind === 'seo' ? message.split('; ') : [message]).map((line) => line.slice(0, 240)).slice(0, 8);
}

interface WatchRow {
  id: string;
  label: string;
  url: string;
}

/**
 * The approvals that moved a baseline, once migration 0022 has made the table
 * for them: the latest in the period for each monitor. Its columns are read
 * rather than assumed, and any surprise leaves the line out.
 */
async function baselineApprovals(watchIds: string[], from: string, to: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!watchIds.length) return found;
  try {
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_approvals'").first();
    if (!table) return found;
    const columns = new Set(
      ((await env.DB.prepare("SELECT name FROM pragma_table_info('baseline_approvals')").all<{ name: string }>()).results ?? []).map(
        (c) => c.name,
      ),
    );
    const at = ['approved_at', 'created_at'].find((name) => columns.has(name));
    if (!columns.has('watch_id') || !at) return found;
    for (let i = 0; i < watchIds.length; i += 90) {
      const chunk = watchIds.slice(i, i + 90);
      const { results } = await env.DB.prepare(
        `SELECT watch_id, MAX(${at}) AS at FROM baseline_approvals WHERE watch_id IN (${chunk.map(() => '?').join(',')}) AND ${at}>=? AND ${at}<? GROUP BY watch_id`,
      )
        .bind(...chunk, from, to)
        .all<{ watch_id: string; at: string }>();
      for (const row of results ?? []) if (row.at) found.set(row.watch_id, row.at);
    }
  } catch (error) {
    console.error('[care] baseline approvals unavailable', error);
  }
  return found;
}

/** Site health, capped. Another team's module: whatever it throws leaves the section out. */
async function siteHealth(userId: string, watchIds: string[], period: CarePeriod): Promise<CareHealth[]> {
  if (!watchIds.length) return [];
  try {
    if (!(await siteHealthReady())) return [];
    const summaries = await siteHealthForWatches(userId, watchIds, period.from, period.to);
    return (Array.isArray(summaries) ? summaries : []).slice(0, CARE_MAX_SITES).map((site) => {
      const out: CareHealth = { ...site };
      if (site.links && site.links.broken.length > CARE_MAX_BROKEN) {
        out.links = { ...site.links, broken: site.links.broken.slice(0, CARE_MAX_BROKEN) };
        out.brokenMore = site.links.broken.length - CARE_MAX_BROKEN;
      }
      if (site.uptime && site.uptime.incidents.length > CARE_MAX_INCIDENTS) {
        out.uptime = { ...site.uptime, incidents: site.uptime.incidents.slice(0, CARE_MAX_INCIDENTS) };
        out.incidentsMore = site.uptime.incidents.length - CARE_MAX_INCIDENTS;
      }
      return out;
    });
  } catch (error) {
    console.error('[care] site health unavailable', error);
    return [];
  }
}

/** Review reports and their sign-off as it stood at the end of the period. Null before migration 0015. */
async function signoffSection(projectId: string, period: CarePeriod) {
  if (!(await signoffsReady())) return null;
  const { results } = await env.DB.prepare(
    `SELECT r.title, r.created_at, s.decision, s.name, s.created_at AS decided_at
     FROM review_reports r
     LEFT JOIN report_signoffs s ON s.rowid = (
       SELECT s2.rowid FROM report_signoffs s2 WHERE s2.report_id = r.id AND s2.created_at < ?
       ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)
     WHERE r.project_id = ? AND r.created_at < ?
     ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(period.to, projectId, period.to)
    .all<{ title: string; created_at: string; decision: string | null; name: string | null; decided_at: string | null }>();
  const decided: CareSignoff[] = [];
  const awaiting: CareAwaiting[] = [];
  for (const row of results ?? []) {
    if (row.decision === 'approved' || row.decision === 'changes') {
      if (row.decided_at && row.decided_at >= period.from)
        decided.push({ title: oneLine(row.title).slice(0, 160), state: row.decision, name: oneLine(row.name ?? '').slice(0, 80), at: row.decided_at });
    } else awaiting.push({ title: oneLine(row.title).slice(0, 160), createdAt: row.created_at });
  }
  decided.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    decided,
    awaiting: awaiting.slice(0, CARE_MAX_AWAITING),
    awaitingMore: Math.max(0, awaiting.length - CARE_MAX_AWAITING),
    approved: decided.filter((d) => d.state === 'approved').length,
    changesRequested: decided.filter((d) => d.state === 'changes').length,
    awaitingTotal: awaiting.length,
  };
}

/**
 * Reads everything a report says about a project's period. Every read is by
 * index: the project's monitors through project_watches, their runs through
 * (user_id, watch_id, created_at), sign-offs through review_reports_project.
 * CROSS JOIN keeps SQLite's join order as written, so the project's monitors
 * lead and each one's runs are a range of that index, never every run the
 * account has.
 */
export async function buildSnapshot(project: Project, period: CarePeriod, now = new Date()): Promise<CareSnapshot> {
  const userId = project.user_id;
  const watches = (
    await env.DB.prepare(
      `SELECT w.id,w.label,w.url FROM project_watches pw CROSS JOIN watches w ON w.id=pw.watch_id WHERE pw.project_id=? AND w.user_id=? ORDER BY w.created_at,w.id`,
    )
      .bind(project.id, userId)
      .all<WatchRow>()
  ).results;
  const ids = watches.map((w) => w.id);
  const [kinds, counts, changed, approvals, health, signoffs] = await Promise.all([
    ruleKinds(ids),
    env.DB.prepare(
      `SELECT r.watch_id,
         SUM(CASE WHEN r.status IN ('done','error') THEN 1 ELSE 0 END) AS checks,
         SUM(CASE WHEN r.changed=1 THEN 1 ELSE 0 END) AS changes,
         SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN r.status='skipped' THEN 1 ELSE 0 END) AS skipped
       FROM project_watches pw CROSS JOIN watch_runs r ON r.watch_id=pw.watch_id
       WHERE pw.project_id=? AND r.user_id=? AND r.created_at>=? AND r.created_at<? GROUP BY r.watch_id`,
    )
      .bind(project.id, userId, period.from, period.to)
      .all<{ watch_id: string; checks: number; changes: number; failed: number; skipped: number }>(),
    // The newest few changes per monitor; the count above says how many there were.
    env.DB.prepare(
      `SELECT id,watch_id,change_pct,detail,created_at FROM (
         SELECT r.id,r.watch_id,r.change_pct,r.detail,r.created_at,
           ROW_NUMBER() OVER (PARTITION BY r.watch_id ORDER BY r.created_at DESC, r.id DESC) AS n
         FROM project_watches pw CROSS JOIN watch_runs r ON r.watch_id=pw.watch_id
         WHERE pw.project_id=? AND r.user_id=? AND r.changed=1 AND r.created_at>=? AND r.created_at<?
       ) WHERE n<=? ORDER BY watch_id, created_at DESC`,
    )
      .bind(project.id, userId, period.from, period.to, CARE_CHANGES_PER_MONITOR)
      .all<{ id: string; watch_id: string; change_pct: number | null; detail: string | null; created_at: string }>(),
    baselineApprovals(ids, period.from, period.to),
    siteHealth(userId, ids, period),
    signoffSection(project.id, period),
  ]);
  // Each monitor's last three checks before the period ends, one indexed read apiece in one round trip.
  const recent = ids.length
    ? await env.DB.batch(
        ids.map((id) =>
          env.DB.prepare(
            `SELECT status FROM watch_runs WHERE watch_id=? AND created_at<? AND status!='skipped' ORDER BY created_at DESC LIMIT 3`,
          ).bind(id, period.to),
        ),
      )
    : [];
  const failing = new Set(
    ids.filter((_, i) => {
      const rows = ((recent[i]?.results ?? []) as Array<{ status: string }>);
      return rows.length === 3 && rows.every((row) => row.status === 'error');
    }),
  );
  const countOf = new Map(counts.results.map((row) => [row.watch_id, row]));
  const changesOf = new Map<string, typeof changed.results>();
  for (const row of changed.results) changesOf.set(row.watch_id, [...(changesOf.get(row.watch_id) ?? []), row]);

  const monitors: CareMonitor[] = [];
  const seo: CareRuleMonitor[] = [];
  const totals = { monitors: watches.length, checks: 0, changes: 0, failed: 0, skipped: 0 };
  for (const watch of watches) {
    const count = countOf.get(watch.id);
    const kind = kinds.get(watch.id) ?? 'visual';
    const label = oneLine(watch.label).slice(0, 100) || displayUrl(watch.url);
    const runs = changesOf.get(watch.id) ?? [];
    const checks = Number(count?.checks ?? 0);
    const changes = Number(count?.changes ?? 0);
    totals.checks += checks;
    totals.changes += changes;
    totals.failed += Number(count?.failed ?? 0);
    totals.skipped += Number(count?.skipped ?? 0);
    const visual = kind === 'visual';
    const list: CareChange[] = visual
      ? runs.map((run) => {
          const found = decodeRunChanges(run.detail);
          return {
            runId: run.id,
            at: run.created_at,
            pct: run.change_pct,
            summary: runSummary(run.detail),
            areas: found.regions.length,
            highlight: found.highlight,
          };
        })
      : [];
    monitors.push({
      id: watch.id,
      label,
      url: watch.url,
      kind,
      checks,
      changes,
      failed: Number(count?.failed ?? 0),
      failing: failing.has(watch.id),
      changed: list,
      more: visual ? Math.max(0, changes - list.length) : 0,
      ...(approvals.has(watch.id) ? { baselineApprovedAt: approvals.get(watch.id)! } : {}),
    });
    if (!visual) {
      const findings = runs.slice(0, CARE_FINDINGS_PER_MONITOR).map((run) => ({ at: run.created_at, lines: findingLines(kind, run.detail) }));
      seo.push({ id: watch.id, label, url: watch.url, kind, checks, flagged: changes, findings, more: Math.max(0, changes - findings.length) });
    }
  }
  // Busiest first: the monitors with something to say lead, the quiet ones follow in the order they were added.
  const ordered = [...monitors].sort((a, b) => Number(b.changes > 0) - Number(a.changes > 0) || b.changes - a.changes);

  const snapshot: CareSnapshot = {
    v: 1,
    project: { name: oneLine(project.name).slice(0, 100), brand: oneLine(project.brand).slice(0, 100) },
    period,
    generatedAt: now.toISOString(),
    totals: {
      ...totals,
      approved: signoffs?.approved ?? 0,
      changesRequested: signoffs?.changesRequested ?? 0,
      awaiting: signoffs?.awaitingTotal ?? 0,
    },
    summary: { text: '', source: 'plain' },
    monitors: ordered.slice(0, CARE_MAX_MONITORS),
    monitorsMore: Math.max(0, ordered.length - CARE_MAX_MONITORS),
    signoffs: signoffs ? { decided: signoffs.decided, awaiting: signoffs.awaiting, awaitingMore: signoffs.awaitingMore } : null,
    seo,
    health,
    nextSteps: [],
  };
  snapshot.nextSteps = nextSteps(snapshot);
  snapshot.summary = await careSummary(snapshot);
  return fitSnapshot(snapshot);
}

/* -------------------------------------------------------------------------- */
/* Generating                                                                  */
/* -------------------------------------------------------------------------- */

const linkFor = (origin: string, token: string) => `${origin}/care/${token}`;

/**
 * A manual report for a month: made, or its snapshot replaced if this month
 * was generated by hand before. A replaced report keeps its link; one without
 * a live link gets a new one, returned once as `share_url`.
 */
export async function generateManual(user: SessionUser, project: Project, key: string, origin: string, now = new Date()) {
  const settings = await careSettings(project.id);
  const period = manualPeriod(settings.timezone, key, now);
  if (!period) throw badRequest('Choose this month or one of the twelve before it.', 'period');
  const snapshot = await buildSnapshot(project, period, now);
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const at = now.toISOString();
  const expires = new Date(now.getTime() + CARE_LINK_DAYS * DAY_MS).toISOString();
  const saved = await env.DB.prepare(
    `INSERT INTO care_reports(id,project_id,user_id,period,kind,generated_at,snapshot,token_hash,expires_at) VALUES(?1,?2,?3,?4,'manual',?5,?6,?7,?8)
     ON CONFLICT(project_id,period,kind) DO UPDATE SET generated_at=excluded.generated_at, snapshot=excluded.snapshot,
       token_hash=CASE WHEN care_reports.token_hash IS NULL OR care_reports.expires_at<=?5 THEN excluded.token_hash ELSE care_reports.token_hash END,
       expires_at=CASE WHEN care_reports.token_hash IS NULL OR care_reports.expires_at<=?5 THEN excluded.expires_at ELSE care_reports.expires_at END,
       revoked_at=CASE WHEN care_reports.token_hash IS NULL OR care_reports.expires_at<=?5 THEN NULL ELSE care_reports.revoked_at END
     RETURNING id, token_hash`,
  )
    .bind(prefixedId('care'), project.id, user.id, period.key, at, JSON.stringify(snapshot), hash, expires)
    .first<{ id: string; token_hash: string | null }>();
  if (!saved) throw new HttpError(500, 'server_error', 'The report could not be saved.');
  return {
    id: saved.id,
    redirect: `/app/care/${saved.id}`,
    ...(saved.token_hash === hash ? { share_url: linkFor(origin, token) } : {}),
  };
}

/**
 * The scheduled report for a month, made once: a second attempt for the same
 * month finds the first and changes nothing. Null when it already existed.
 */
async function generateScheduled(project: Project, period: CarePeriod, now: Date): Promise<CareReportRow | null> {
  const snapshot = await buildSnapshot(project, period, now);
  return env.DB.prepare(
    `INSERT INTO care_reports(id,project_id,user_id,period,kind,generated_at,snapshot,token_hash,expires_at) VALUES(?,?,?,?,'scheduled',?,?,NULL,?)
     ON CONFLICT(project_id,period,kind) DO NOTHING RETURNING *`,
  )
    .bind(
      prefixedId('care'),
      project.id,
      project.user_id,
      period.key,
      now.toISOString(),
      JSON.stringify(snapshot),
      new Date(now.getTime() + CARE_LINK_DAYS * DAY_MS).toISOString(),
    )
    .first<CareReportRow>();
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                     */
/* -------------------------------------------------------------------------- */

async function sendWithTimeout(send: () => Promise<boolean>): Promise<'accepted' | 'failed' | 'unknown'> {
  const timeout = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = await Promise.race([
      send(),
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), SEND_TIMEOUT_MS);
      }),
    ]);
    return sent === timeout ? 'unknown' : sent ? 'accepted' : 'failed';
  } catch {
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DeliveryResult {
  /** Emails claimed and attempted. */
  attempted: number;
  accepted: number;
  /** Addresses this report had already gone to, or been tried for. */
  already: number;
}

/**
 * Emails a report to the project's recipients, and the owner's copy. Each
 * address is claimed in care_report_deliveries before its email goes, so a
 * report reaches an address at most once, whoever sends it and however often;
 * an outcome nobody saw is recorded as unknown and never retried. Each client
 * gets their own link; the owner's copy points at the report in the app.
 */
async function deliver(
  report: Pick<CareReportRow, 'id' | 'expires_at'>,
  project: Project,
  snapshot: CareSnapshot,
  owner: SessionUser,
  settings: CareSettings,
  origin: string,
  now: Date,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { attempted: 0, accepted: 0, already: 0 };
  if (!canSendEmail()) return result;
  const branding = await projectBranding(project).catch(() => null);
  const whiteLabel = !!branding && !branding.attribution;
  const claim = (email: string, role: 'client' | 'owner', hash: string | null) =>
    env.DB.prepare(
      `INSERT INTO care_report_deliveries(report_id,email,role,token_hash,status,created_at) VALUES(?,?,?,?,'unknown',?)
       ON CONFLICT(report_id,email) DO NOTHING RETURNING email`,
    )
      .bind(report.id, email, role, hash, now.toISOString())
      .first();
  const record = (email: string, status: string) =>
    env.DB.prepare('UPDATE care_report_deliveries SET status=? WHERE report_id=? AND email=?').bind(status, report.id, email).run();

  for (const email of settings.recipients) {
    const token = randomToken(32);
    if (!(await claim(email, 'client', await sha256Hex(token)))) {
      result.already++;
      continue;
    }
    result.attempted++;
    const mail = careEmail({
      snapshot,
      link: linkFor(origin, token),
      expiresAt: report.expires_at,
      sender: { name: owner.name, email: owner.email },
      whiteLabel,
    });
    const status = await sendWithTimeout(() => sendMail({ to: email, ...mail, replyTo: owner.email }));
    if (status === 'accepted') result.accepted++;
    await record(email, status);
  }
  // The owner's copy goes with a send that reached someone, or alone when there is nobody else to send to.
  if (settings.owner_copy && (result.attempted || !settings.recipients.length)) {
    const email = owner.email.trim().toLowerCase();
    if (await claim(email, 'owner', null)) {
      const mail = ownerCopyEmail({ snapshot, link: `${origin}/app/care/${report.id}`, expiresAt: report.expires_at, recipients: settings.recipients });
      await record(email, await sendWithTimeout(() => sendMail({ to: owner.email, ...mail })));
    }
  }
  return result;
}

/** "Send now": the report to every recipient it has not gone to yet. */
async function sendNow(user: SessionUser, project: Project, report: CareReportRow, origin: string, now: Date) {
  needsPlan(user, true);
  if (!linkLive(report, now))
    throw new HttpError(409, 'link_closed', 'This report’s link is revoked or expired. Make a new link, or generate the month again, first.');
  if (!canSendEmail()) throw new HttpError(503, 'mail_unavailable', 'Email is not configured on this deployment.');
  if (!(await hasConfirmedEmail(user.id)))
    throw new HttpError(
      403,
      'email_unverified',
      'Confirm your email address before emailing reports to clients. Send yourself a confirmation email from your account page.',
    );
  const settings = await careSettings(project.id);
  if (!settings.recipients.length) throw badRequest('Add your client’s address under the schedule settings first.', 'recipients');
  const sent = await careDeliveries(report.id);
  const pending = settings.recipients.filter((email) => !sent.some((row) => row.email === email));
  if (!pending.length) throw new HttpError(409, 'already_sent', 'This report has already gone to every recipient. Each address gets a report once.');
  await enforceThrottles(
    [
      { bucket: `care-send:${project.id}`, ...CARE_LIMITS.sendProject },
      { bucket: `care-send-user:${user.id}`, ...CARE_LIMITS.sendAccount },
    ],
    (wait) =>
      `“Send now” is limited to ${CARE_LIMITS.sendProject.limit} a day per project and ${CARE_LIMITS.sendAccount.limit} a day per account. Try again in ${wait}.`,
  );
  return { ok: true as const, ...(await deliver(report, project, readSnapshot(report.snapshot), user, settings, origin, now)) };
}

/* -------------------------------------------------------------------------- */
/* Owner actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/care: the owner's settings, generating, links and sending. The
 * caller has signed in, checked the origin and the general rate limit.
 */
export async function careAction(user: SessionUser, b: Record<string, string>, origin: string, now = new Date()) {
  await requireCare();
  if (b.action === 'settings' || b.action === 'generate') {
    const project = await ownProject(user.id, b.project_id ?? '');
    needsPlan(user);
    if (b.action === 'settings') return saveSettings(user, project, b, now);
    await enforceThrottles(
      [{ bucket: `care-generate:${user.id}`, ...CARE_LIMITS.generate }],
      (wait) => `You can generate up to ${CARE_LIMITS.generate.limit} care reports an hour. Try again in ${wait}.`,
    );
    return generateManual(user, project, b.period ?? '', origin, now);
  }
  const { report, project } = await ownCareReport(user.id, b.report_id ?? '');
  const at = now.toISOString();
  if (b.action === 'revoke') {
    // Always allowed, whatever the plan: stopping a link is a safety action.
    await env.DB.batch([
      env.DB.prepare('UPDATE care_reports SET token_hash=NULL,revoked_at=? WHERE id=?').bind(at, report.id),
      env.DB.prepare('UPDATE care_report_deliveries SET token_hash=NULL WHERE report_id=?').bind(report.id),
    ]);
    return { ok: true as const };
  }
  if (b.action === 'delete') {
    await env.DB.prepare('DELETE FROM care_reports WHERE id=?').bind(report.id).run();
    return { redirect: `/app/projects/${project.id}/care` };
  }
  if (b.action === 'link') {
    needsPlan(user);
    // A new link lasts the full term, or as long as the report's links already would.
    const token = randomToken(32);
    const expires = new Date(Math.max(Date.parse(report.expires_at) || 0, now.getTime() + CARE_LINK_DAYS * DAY_MS)).toISOString();
    await env.DB.prepare('UPDATE care_reports SET token_hash=?,revoked_at=NULL,expires_at=? WHERE id=?')
      .bind(await sha256Hex(token), expires, report.id)
      .run();
    return { share_url: linkFor(origin, token) };
  }
  if (b.action === 'extend') {
    needsPlan(user);
    if (report.revoked_at) throw new HttpError(409, 'link_closed', 'This report’s links were revoked. Make a new link instead.');
    await env.DB.prepare('UPDATE care_reports SET expires_at=? WHERE id=?')
      .bind(new Date(now.getTime() + CARE_LINK_DAYS * DAY_MS).toISOString(), report.id)
      .run();
    return { ok: true as const };
  }
  if (b.action === 'send') return sendNow(user, project, report, origin, now);
  throw badRequest('Unknown care report action.');
}

/* -------------------------------------------------------------------------- */
/* The schedule                                                                */
/* -------------------------------------------------------------------------- */

export interface CareSweepResult {
  due: number;
  generated: number;
  attempted: number;
  skipped: number;
}

/**
 * The hourly cron. Each enabled project whose slot has come — the 1st at
 * 09:00 in its timezone — gets last month's report, made once, and its
 * recipients get it by email. The slot is moved to next month first, by a
 * write only one sweep can win, so a crash never repeats a send and two
 * sweeps never both make one. Oldest due first, bounded per invocation;
 * a backlog drains over the following hours.
 *
 * Only accounts on a plan that includes client emails (a Pro trial counts),
 * with a confirmed address, are sent for; the others' slots still move on.
 */
export async function runCareReports(origin: string, now = new Date()): Promise<CareSweepResult> {
  const result: CareSweepResult = { due: 0, generated: 0, attempted: 0, skipped: 0 };
  if (!(await careReportsReady())) return result;
  const started = Date.now();
  const due = (
    await env.DB.prepare(
      `SELECT s.* FROM care_report_settings s WHERE s.enabled=1 AND s.next_run_at<=? ORDER BY s.next_run_at, s.project_id LIMIT ?`,
    )
      .bind(now.toISOString(), SWEEP_BATCH)
      .all<Omit<CareSettings, 'recipients'> & { recipients: string }>()
  ).results;
  result.due = due.length;
  for (const row of due) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break;
    const timezone = validTimezone(row.timezone) ?? 'UTC';
    const slot = new Date(row.next_run_at!);
    const moved = await env.DB.prepare('UPDATE care_report_settings SET next_run_at=? WHERE project_id=? AND enabled=1 AND next_run_at=?')
      .bind(nextCareRun(timezone, now), row.project_id, row.next_run_at)
      .run();
    if (!moved.meta?.changes) continue;
    try {
      const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(row.project_id).first<Project>();
      const owner = project ? await loadSessionUser(project.user_id) : null;
      if (!project || !owner || !careEmailsIncluded(owner.plan) || !(await hasConfirmedEmail(owner.id))) {
        result.skipped++;
        continue;
      }
      const report = await generateScheduled(project, monthPeriod(timezone, previousMonth(timezone, slot)), now);
      if (!report) {
        result.skipped++;
        continue;
      }
      result.generated++;
      const settings = { ...row, timezone, recipients: storedRecipients(row.recipients) };
      result.attempted += (await deliver(report, project, readSnapshot(report.snapshot), owner, settings, origin, now)).attempted;
    } catch (error) {
      // One project's failure is logged and the sweep goes on; its slot has already moved, so it is not retried.
      console.error('[care] scheduled report failed', row.project_id, error);
      result.skipped++;
    }
  }
  return result;
}
