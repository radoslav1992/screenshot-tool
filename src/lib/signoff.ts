import { env } from 'cloudflare:workers';
import { HttpError } from './http';
import { prefixedId, sha256Hex } from './ids';
import { canSendEmail, sendMail, type Mail } from './mailer';
import { enforceThrottles } from './auth-throttle';
import { checkRateLimit } from './rate-limit';
import { oneLine } from './branding-rules';
import { formatDateTime } from './dates';
import { ownReport, sharedReport, type Project, type Report } from './projects';

/**
 * Client sign-off on a shared review report.
 *
 * Whoever holds the review link can approve the report or ask for changes,
 * with their name and a note. Every decision is a new row and the latest one
 * is the current state, so a later decision supersedes an earlier one and the
 * history stays; the owner's reset is a row of its own for the same reason.
 *
 * The link is the only credential, exactly as for viewing: the token is
 * checked by `sharedReport`, so expiry and revocation apply the same way.
 */

export type SignoffDecision = 'approved' | 'changes';
export type SignoffState = SignoffDecision | 'awaiting';
export interface SignoffRow {
  id: string;
  report_id: string;
  decision: SignoffDecision | 'reset';
  name: string;
  note: string;
  created_at: string;
}
/** The current state as a report shows it. `awaiting` has no name or date. */
export interface SignoffView {
  state: SignoffState;
  name: string;
  note: string;
  at: string;
}

export const SIGNOFF_NAME_MAX = 80;
export const SIGNOFF_NOTE_MAX = 2000;
/** Limits in one place, so the check script and the route agree. */
export const SIGNOFF_LIMITS = {
  ip: { limit: 10, windowSeconds: 3600 },
  link: { limit: 20, windowSeconds: 3600 },
  /** Owner notifications per report. */
  mail: { limit: 6, windowSeconds: 3600 },
  /** Client decisions kept per report; resets do not count. */
  perReport: 100,
} as const;

export const SIGNOFF_LABELS: Record<SignoffState, string> = {
  approved: 'APPROVED',
  changes: 'CHANGES REQUESTED',
  awaiting: 'AWAITING SIGN-OFF',
};

/**
 * What the share page says after a decision is posted, by the `?signoff=`
 * code the route redirects with. Fixed text only: an unknown code shows
 * nothing, so a crafted link cannot put words on the page.
 */
export const SIGNOFF_STATUS: Record<string, { ok: boolean; text: string }> = {
  saved: { ok: true, text: 'Thank you. Your decision is recorded and shown to everyone with this link.' },
  decision: { ok: false, text: 'Choose Approve or Request changes.' },
  name: { ok: false, text: `Enter your name, up to ${SIGNOFF_NAME_MAX} characters.` },
  note_required: { ok: false, text: 'Say what should change: a note is needed to request changes.' },
  note_long: { ok: false, text: `Notes can be up to ${SIGNOFF_NOTE_MAX.toLocaleString('en')} characters.` },
  limited: { ok: false, text: 'Too many sign-off attempts from here. Try again in an hour.' },
  closed: {
    ok: false,
    text: `This report has reached its limit of ${SIGNOFF_LIMITS.perReport} decisions. Contact the report owner.`,
  },
  error: { ok: false, text: 'Your decision could not be saved. Please try again.' },
};

/** Own keys only, so `?signoff=constructor` finds nothing. */
export function signoffStatus(code: string | null | undefined): { ok: boolean; text: string } | null {
  return code && Object.hasOwn(SIGNOFF_STATUS, code) ? SIGNOFF_STATUS[code]! : null;
}

/** Cached per isolate like watchSettingsReady: a yes for good, a no for a minute. */
let signoffTable: { ready: boolean; at: number } | undefined;
export async function signoffsReady(): Promise<boolean> {
  if (signoffTable && (signoffTable.ready || Date.now() - signoffTable.at < 60_000)) return signoffTable.ready;
  const ready = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='report_signoffs'").first());
  signoffTable = { ready, at: Date.now() };
  return ready;
}

export function signoffView(row: Pick<SignoffRow, 'decision' | 'name' | 'note' | 'created_at'> | null): SignoffView {
  if (!row || row.decision === 'reset') return { state: 'awaiting', name: '', note: '', at: '' };
  return { state: row.decision, name: row.name, note: row.note, at: row.created_at };
}

/** "[ APPROVED ] by Dana Smith · 2 Oct 2026, 16:00 UTC", or "[ AWAITING SIGN-OFF ]". */
export function signoffLine(view: SignoffView): string {
  const label = `[ ${SIGNOFF_LABELS[view.state]} ]`;
  return view.state === 'awaiting' ? label : `${label} by ${view.name} · ${formatDateTime(view.at)}`;
}

/** Rows newest first; rowid breaks ties between decisions made in the same millisecond. */
const LATEST = 'ORDER BY created_at DESC, rowid DESC';

export async function currentSignoff(reportId: string): Promise<SignoffView> {
  return signoffView(
    await env.DB.prepare(`SELECT decision,name,note,created_at FROM report_signoffs WHERE report_id=? ${LATEST} LIMIT 1`)
      .bind(reportId)
      .first<SignoffRow>(),
  );
}

export async function signoffHistory(reportId: string, limit = 50): Promise<SignoffRow[]> {
  return (
    await env.DB.prepare(`SELECT * FROM report_signoffs WHERE report_id=? ${LATEST} LIMIT ?`)
      .bind(reportId, limit)
      .all<SignoffRow>()
  ).results;
}

/** Each report's current state, for a project's report list. Reports without a decision are absent. */
export async function projectSignoffStates(projectId: string): Promise<Map<string, SignoffState>> {
  const { results } = await env.DB.prepare(
    `SELECT s.report_id,s.decision FROM report_signoffs s JOIN review_reports r ON r.id=s.report_id
     WHERE r.project_id=? AND s.rowid=(SELECT s2.rowid FROM report_signoffs s2 WHERE s2.report_id=s.report_id ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)`,
  )
    .bind(projectId)
    .all<{ report_id: string; decision: SignoffRow['decision'] }>();
  return new Map(results.map((r) => [r.report_id, signoffView({ ...r, name: '', note: '', created_at: '' }).state]));
}

/** Notes keep their line breaks; every other control character, and bidi overrides, go. */
function cleanNote(value: string | undefined): string {
  return (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim();
}

/**
 * Validates a decision. Errors carry a short `type` the share page turns into
 * a fixed message, so nothing from the request is ever echoed back.
 */
export function parseSignoff(body: Record<string, string>): { decision: SignoffDecision; name: string; note: string } {
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'changes')
    throw new HttpError(400, 'decision', 'Choose Approve or Request changes.', 'decision');
  const name = oneLine(body.name);
  if (!name || name.length > SIGNOFF_NAME_MAX)
    throw new HttpError(400, 'name', `Enter your name, up to ${SIGNOFF_NAME_MAX} characters.`, 'name');
  const note = cleanNote(body.note);
  if (note.length > SIGNOFF_NOTE_MAX)
    throw new HttpError(400, 'note_long', `Notes can be up to ${SIGNOFF_NOTE_MAX.toLocaleString('en')} characters.`, 'note');
  if (decision === 'changes' && !note)
    throw new HttpError(400, 'note_required', 'Say what should change: a note is needed to request changes.', 'note');
  return { decision, name, note };
}

/**
 * Records a client's decision through a review link. Throttled per address and
 * per link before the token is even looked up, then capped per report inside
 * the insert, so a link left in a public place cannot grow without bound.
 */
export async function submitSignoff(
  token: string,
  body: Record<string, string>,
  ip: string,
): Promise<{ report: Report; project: Project; signoff: SignoffRow }> {
  if (!/^[a-f0-9]{64}$/.test(token) || !(await signoffsReady()))
    throw new HttpError(404, 'not_found', 'This review link is unavailable.');
  await enforceThrottles(
    [
      { bucket: `signoff-ip:${ip}`, ...SIGNOFF_LIMITS.ip },
      { bucket: `signoff-link:${(await sha256Hex(token)).slice(0, 32)}`, ...SIGNOFF_LIMITS.link },
    ],
    (wait) => `Too many sign-off attempts. Try again in ${wait}.`,
  );
  const { report, project } = await sharedReport(token);
  const input = parseSignoff(body);
  const signoff: SignoffRow = { id: prefixedId('so'), report_id: report.id, ...input, created_at: new Date().toISOString() };
  const saved = await env.DB.prepare(
    `INSERT INTO report_signoffs(id,report_id,decision,name,note,created_at) SELECT ?,?,?,?,?,?
     WHERE (SELECT COUNT(*) FROM report_signoffs WHERE report_id=? AND decision!='reset')<? RETURNING id`,
  )
    .bind(signoff.id, report.id, signoff.decision, signoff.name, signoff.note, signoff.created_at, report.id, SIGNOFF_LIMITS.perReport)
    .first();
  if (!saved)
    throw new HttpError(
      409,
      'closed',
      `This report has reached its limit of ${SIGNOFF_LIMITS.perReport} decisions. Contact the report owner.`,
    );
  return { report, project, signoff };
}

/** The owner puts a report back to awaiting sign-off. A no-op when it already is. */
export async function resetSignoff(userId: string, reportId: string): Promise<{ ok: true }> {
  if (!(await signoffsReady()))
    throw new HttpError(503, 'setup_required', 'Sign-off is being prepared. Please try again after setup is complete.');
  const { report } = await ownReport(userId, reportId);
  if ((await currentSignoff(report.id)).state === 'awaiting') return { ok: true };
  await env.DB.prepare(`INSERT INTO report_signoffs(id,report_id,decision,created_at) VALUES(?,?,'reset',?)`)
    .bind(prefixedId('so'), report.id, new Date().toISOString())
    .run();
  return { ok: true };
}

/** "> " before every line, so a note cannot pass itself off as part of the message around it. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

/**
 * The owner's notification. Plain text only, as all mail here is, so nothing
 * the client typed is ever interpreted as markup. The subject carries only the
 * owner's own report title; the client's name is one line in the body and the
 * note is quoted under it.
 */
export function signoffEmail(input: {
  to: string;
  report: Pick<Report, 'id' | 'title'>;
  project: Pick<Project, 'name'>;
  signoff: Pick<SignoffRow, 'decision' | 'name' | 'note' | 'created_at'>;
  origin: string;
}): Mail {
  const name = oneLine(input.signoff.name).slice(0, SIGNOFF_NAME_MAX) || 'Your client';
  const title = oneLine(input.report.title).slice(0, 100);
  const approved = input.signoff.decision === 'approved';
  const did = approved ? 'approved' : 'requested changes to';
  const note = cleanNote(input.signoff.note).slice(0, SIGNOFF_NOTE_MAX);
  return {
    to: input.to,
    subject: approved ? `Approved: “${title}”` : `Changes requested: “${title}”`,
    text:
      `${name} ${did} the review report “${title}” in the project “${oneLine(input.project.name).slice(0, 100)}”.\n\n` +
      (note ? `Their note:\n${quote(note)}\n\n` : '') +
      `Decided ${formatDateTime(input.signoff.created_at)} through the report’s review link.\n\n` +
      `Open the report, see the sign-off history or reset it:\n${input.origin}/app/reports/${input.report.id}\n\n` +
      'The review link needs no account, so the name is as the person typed it.',
  };
}

/**
 * Emails the report owner. Best effort; meant to run after the response. A
 * link left somewhere public could otherwise fill an inbox, so past a few
 * emails an hour per report the decision is only recorded — the history in
 * the app still has every one.
 */
export async function notifySignoff(
  report: Report,
  project: Project,
  signoff: SignoffRow,
  origin: string,
): Promise<boolean> {
  if (!canSendEmail()) return false;
  const { limit, windowSeconds } = SIGNOFF_LIMITS.mail;
  if (!(await checkRateLimit(`signoff-mail:${report.id}`, limit, windowSeconds)).ok) return false;
  const owner = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(project.user_id).first<{ email: string }>();
  if (!owner?.email) return false;
  return sendMail(signoffEmail({ to: owner.email, report, project, signoff, origin }));
}
