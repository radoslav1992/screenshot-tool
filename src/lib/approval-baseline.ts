import { env } from 'cloudflare:workers';
import { pinReady, pinRefusal } from './baseline-pin';
import { displayUrl } from './capture-options';
import { oneLine } from './branding-rules';
import { prefixedId } from './ids';
import type { CaptureRow } from './captures';
import type { Project, Report } from './projects';
import type { SignoffRow } from './signoff';
import type { WatchRow } from './watches';

/**
 * A client's approval updates the monitor baseline.
 *
 * When a client approves a shared review report, each capture in it that one
 * of the report owner's monitors took becomes that monitor's pinned baseline
 * (baseline-pin.ts), so later checks compare against exactly what was
 * approved. Requesting changes, and the owner's reset, change nothing: a pin
 * stays until the owner unpins it or a later approval pins something else.
 *
 * A capture is a monitor's when that monitor's check took it, or it is or was
 * that monitor's baseline — the same test pinBaseline applies — and only the
 * report owner's own monitors and captures are ever read or written. When one
 * monitor has several captures in the report, as a before/after pair does,
 * the newest is pinned: approving accepts the "after".
 *
 * Nothing here may fail a sign-off. The decision is recorded before any of
 * this runs, and a capture that cannot be pinned is skipped with a reason the
 * owner's email gives.
 *
 * Which approval pinned what is kept in `baseline_approvals` (migration 0022)
 * so the monitor page can say so while that pin stands. Before the migration
 * an approval still pins; the monitor page just does not name it.
 */

export type ApprovalSkipReason = 'files_gone' | 'outdated' | 'not_after' | 'monitor_deleted' | 'not_ready' | 'failed';

/** Why a monitor was not pinned, as the owner reads it: "Pricing: …". */
export const APPROVAL_SKIP_REASONS: Record<ApprovalSkipReason, string> = {
  files_gone: 'its screenshot is no longer available',
  outdated:
    'its screenshot was taken before a capture engine update, so later checks could not be compared with it fairly',
  not_after: 'the report shows its screenshot as the “before” of a newer one, so it is not the version that was approved',
  monitor_deleted: 'the monitor that took the screenshot has been deleted',
  not_ready: 'pinning a baseline is still being set up',
  failed: 'it could not be pinned just now',
};

export interface ApprovalPinned {
  watchId: string;
  /** The monitor's label, or its address. */
  name: string;
  captureId: string;
  /** It already was this monitor's pinned baseline, so nothing changed. */
  already: boolean;
}
export interface ApprovalSkipped {
  /** Null when the monitor no longer exists. */
  watchId: string | null;
  name: string;
  captureId: string;
  reason: ApprovalSkipReason;
  why: string;
}
/** What an approval did to the owner's monitors. */
export interface ApprovalPins {
  pinned: ApprovalPinned[];
  skipped: ApprovalSkipped[];
  /** The report's monitors could not be read at all, so nothing is known to be pinned. */
  failed?: boolean;
}

/** Cached per isolate like signoffsReady: a yes for good, a no for a minute. */
let approvalTable: { ready: boolean; at: number } | undefined;
export async function approvalsReady(): Promise<boolean> {
  if (approvalTable && (approvalTable.ready || Date.now() - approvalTable.at < 60_000)) return approvalTable.ready;
  const ready = !!(await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_approvals'",
  ).first());
  approvalTable = { ready, at: Date.now() };
  return ready;
}

export function monitorName(watch: Pick<WatchRow, 'label' | 'url'>): string {
  return oneLine(watch.label).slice(0, 80) || displayUrl(watch.url);
}

/** One monitor and the capture an approval of the report would pin on it. */
interface PlannedPin {
  watch: WatchRow;
  capture: CaptureRow;
  /** Already its pinned baseline. */
  already: boolean;
}
interface Plan {
  pins: PlannedPin[];
  skipped: ApprovalSkipped[];
}

const skip = (
  watchId: string | null,
  name: string,
  captureId: string,
  reason: ApprovalSkipReason,
): ApprovalSkipped => ({ watchId, name, captureId, reason, why: APPROVAL_SKIP_REASONS[reason] });

/**
 * What approving this report would pin, read but not written: for each of the
 * owner's monitors with a capture in it, the capture and whether it can be
 * pinned. The shared page, the owner's report page and the approval itself all
 * decide from this, so they cannot disagree.
 */
export async function approvalPlan(report: Pick<Report, 'id'>, project: Pick<Project, 'user_id'>): Promise<Plan> {
  const owner = project.user_id;
  const plan: Plan = { pins: [], skipped: [] };
  const { results: shown = [] } = await env.DB.prepare(
    'SELECT capture_id, position FROM report_captures WHERE report_id = ? ORDER BY position',
  )
    .bind(report.id)
    .all<{ capture_id: string; position: number }>();
  const ids = [...new Set(shown.map((row) => row.capture_id))];
  if (!ids.length) return plan;
  const marks = ids.map(() => '?').join(',');

  // Retention may have deleted a capture its monitor's runs still name, so the
  // links come from the runs and the watches, not from the capture rows. Every
  // part is the owner's: their captures, their runs, their monitors.
  const [captureRows, links] = await Promise.all([
    env.DB.prepare(`SELECT * FROM captures WHERE user_id = ? AND id IN (${marks})`)
      .bind(owner, ...ids)
      .all<CaptureRow>(),
    env.DB.prepare(
      `SELECT w.*, x.capture_id AS linked_capture, x.seen_at AS linked_at FROM (
         SELECT watch_id, capture_id, MIN(created_at) AS seen_at FROM (
           SELECT watch_id, capture_id, created_at FROM watch_runs WHERE user_id = ? AND capture_id IN (${marks})
           UNION ALL
           SELECT watch_id, baseline_capture_id, created_at FROM watch_runs WHERE user_id = ? AND baseline_capture_id IN (${marks})
           UNION ALL
           SELECT id, baseline_capture_id, NULL FROM watches WHERE user_id = ? AND baseline_capture_id IN (${marks})
         ) GROUP BY watch_id, capture_id
       ) x JOIN watches w ON w.id = x.watch_id AND w.user_id = ?`,
    )
      .bind(owner, ...ids, owner, ...ids, owner, ...ids, owner)
      .all<WatchRow & { linked_capture: string; linked_at: string | null }>(),
  ]);
  const captures = new Map((captureRows.results ?? []).map((row) => [row.id, row]));

  /** A report capture as one candidate: when it was taken, and where the report shows it. */
  interface Option {
    id: string;
    capture: CaptureRow | null;
    position: number;
    at: string;
  }
  // Newest first; the later position breaks a tie, since the "after" follows its "before".
  const newest = (a: Option, b: Option) => (a.at === b.at ? b.position - a.position : a.at < b.at ? 1 : -1);

  const monitors = new Map<string, { watch: WatchRow; options: Option[] }>();
  const linked = new Set<string>();
  for (const { linked_capture: id, linked_at, ...watch } of links.results ?? []) {
    linked.add(id);
    const entry = monitors.get(watch.id) ?? { watch, options: [] };
    monitors.set(watch.id, entry);
    const capture = captures.get(id) ?? null;
    // A deleted capture's time is its first run's: the check that took it.
    for (const row of shown.filter((r) => r.capture_id === id))
      entry.options.push({ id, capture, position: row.position, at: capture?.created_at ?? linked_at ?? '' });
  }

  const pins = monitors.size > 0 && (await pinReady());
  for (const { watch, options } of monitors.values()) {
    const chosen = options.sort(newest)[0]!;
    const name = monitorName(watch);
    // A "before" with a newer "after" beside it that is not this monitor's:
    // the client approved the after, and pinning the before would compare
    // every later check against the version they moved away from.
    const after = chosen.position % 2 === 0 ? shown.find((row) => row.position === chosen.position + 1) : undefined;
    const afterRow = after ? captures.get(after.capture_id) : undefined;
    const reason: ApprovalSkipReason | null = !pins
      ? 'not_ready'
      : (pinRefusal(chosen.capture) ??
        (afterRow && chosen.capture && afterRow.created_at > chosen.capture.created_at ? 'not_after' : null));
    if (reason) plan.skipped.push(skip(watch.id, name, chosen.id, reason));
    else
      plan.pins.push({
        watch,
        capture: chosen.capture!,
        already: watch.baseline_capture_id === chosen.id && Boolean(watch.baseline_pinned_at),
      });
  }

  // A monitor's capture that no monitor claims any more: its monitor was
  // deleted, and its runs with it. One line per page and device it showed.
  const orphans = new Map<string, Option>();
  for (const row of shown) {
    const capture = captures.get(row.capture_id);
    if (!capture || capture.source !== 'watch' || linked.has(capture.id)) continue;
    const key = `${capture.device}\n${capture.url}`;
    const option = { id: capture.id, capture, position: row.position, at: capture.created_at };
    const known = orphans.get(key);
    if (!known || newest(option, known) < 0) orphans.set(key, option);
  }
  for (const { id, capture } of orphans.values())
    plan.skipped.push(skip(null, displayUrl(capture!.url), id, 'monitor_deleted'));
  return plan;
}

/**
 * Pins one planned capture as its monitor's baseline, unless it already is.
 * The update is conditional, so two approvals arriving together pin once, and
 * the provenance row is written in the same batch only if this update is the
 * one that landed (it carries this call's own timestamp).
 */
async function pinPlanned(
  entry: PlannedPin,
  owner: string,
  report: Pick<Report, 'id'>,
  signoff: Pick<SignoffRow, 'id'>,
  provenance: boolean,
): Promise<'pinned' | 'already' | 'monitor_deleted'> {
  const { watch, capture } = entry;
  const at = new Date().toISOString();
  // updated_at is left alone, as pinBaseline leaves it: it is half of a running check's claim.
  const statements = [
    env.DB.prepare(
      `UPDATE watches SET baseline_capture_id = ?, baseline_pinned_at = ?
       WHERE id = ? AND user_id = ? AND NOT (baseline_pinned_at IS NOT NULL AND baseline_capture_id IS ?)`,
    ).bind(capture.id, at, watch.id, owner, capture.id),
  ];
  if (provenance)
    statements.push(
      env.DB.prepare(
        `INSERT INTO baseline_approvals (id, watch_id, capture_id, report_id, signoff_id, pinned_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM watches WHERE id = ? AND user_id = ? AND baseline_capture_id = ? AND baseline_pinned_at = ?)`,
      ).bind(prefixedId('bap'), watch.id, capture.id, report.id, signoff.id, at, watch.id, owner, capture.id, at),
    );
  const [update] = await env.DB.batch(statements);
  if (update?.meta?.changes) return 'pinned';
  // Nothing changed: it was pinned to this capture meanwhile, or the monitor is gone.
  const still = await env.DB.prepare('SELECT id FROM watches WHERE id = ? AND user_id = ?').bind(watch.id, owner).first();
  return still ? 'already' : 'monitor_deleted';
}

/**
 * Makes an approved report's monitor captures their monitors' pinned
 * baselines. Never throws: whatever goes wrong is a skipped monitor, or
 * `failed` when the report's monitors could not be read at all, and the
 * client's decision, already recorded, stands either way. Any decision but
 * `approved` pins nothing.
 */
export async function pinApprovedCaptures(
  report: Pick<Report, 'id'>,
  project: Pick<Project, 'user_id'>,
  signoff: Pick<SignoffRow, 'id' | 'report_id' | 'decision'>,
): Promise<ApprovalPins> {
  const result: ApprovalPins = { pinned: [], skipped: [] };
  if (signoff.decision !== 'approved' || signoff.report_id !== report.id) return result;
  let plan: Plan;
  let provenance = false;
  try {
    plan = await approvalPlan(report, project);
    provenance = plan.pins.length > 0 && (await approvalsReady());
  } catch (error) {
    console.error('[approval] could not read the report’s monitors', error);
    return { ...result, failed: true };
  }
  result.skipped.push(...plan.skipped);
  for (const entry of plan.pins) {
    const name = monitorName(entry.watch);
    const base = { watchId: entry.watch.id, name, captureId: entry.capture.id };
    if (entry.already) {
      result.pinned.push({ ...base, already: true });
      continue;
    }
    try {
      const outcome = await pinPlanned(entry, project.user_id, report, signoff, provenance);
      if (outcome === 'monitor_deleted') result.skipped.push(skip(null, name, entry.capture.id, 'monitor_deleted'));
      else result.pinned.push({ ...base, already: outcome === 'already' });
    } catch (error) {
      console.error('[approval] could not pin a baseline', error);
      result.skipped.push(skip(entry.watch.id, name, entry.capture.id, 'failed'));
    }
  }
  return result;
}

/** Whether approving this report would make at least one monitor compare against its screenshots. */
export async function approvalPinsMonitors(report: Pick<Report, 'id'>, project: Pick<Project, 'user_id'>): Promise<boolean> {
  return (await approvalPlan(report, project)).pins.length > 0;
}

/** The owner's report page: what an approval pins, and which monitors now compare against it. */
export interface ReportBaselines {
  /** Approving would pin at least one monitor. */
  pinnable: boolean;
  /** Monitors whose pinned baseline is now the capture this report's approval pins. */
  pinned: Array<{ watchId: string; name: string }>;
  /** Monitors with a capture here that an approval does not pin, and why. */
  skipped: ApprovalSkipped[];
}
export async function reportBaselines(report: Pick<Report, 'id'>, project: Pick<Project, 'user_id'>): Promise<ReportBaselines> {
  const plan = await approvalPlan(report, project);
  return {
    pinnable: plan.pins.length > 0,
    pinned: plan.pins.filter((pin) => pin.already).map((pin) => ({ watchId: pin.watch.id, name: monitorName(pin.watch) })),
    skipped: plan.skipped,
  };
}

/** The approval behind a monitor's pinned baseline, for the monitor page and its API. */
export interface ApprovalProvenance {
  name: string;
  reportId: string;
  reportTitle: string;
  approvedAt: string;
}

/**
 * The approval that pinned this monitor's current baseline, while that pin
 * stands: same capture, same pin time. A pin or unpin since then, by anyone,
 * means it no longer speaks for the baseline. Null before migration 0022, and
 * on any failure: it is a line of explanation, never worth breaking a page.
 */
export async function approvalProvenance(
  watch: Pick<WatchRow, 'id' | 'user_id' | 'baseline_capture_id' | 'baseline_pinned_at'>,
): Promise<ApprovalProvenance | null> {
  if (!watch.baseline_pinned_at || !watch.baseline_capture_id) return null;
  try {
    if (!(await approvalsReady())) return null;
    const row = await env.DB.prepare(
      `SELECT s.name, s.created_at, r.id AS report_id, r.title FROM baseline_approvals a
         JOIN report_signoffs s ON s.id = a.signoff_id AND s.report_id = a.report_id AND s.decision = 'approved'
         JOIN review_reports r ON r.id = a.report_id
         JOIN projects p ON p.id = r.project_id AND p.user_id = ?
       WHERE a.watch_id = ? AND a.capture_id = ? AND a.pinned_at = ?
       ORDER BY a.rowid DESC LIMIT 1`,
    )
      .bind(watch.user_id, watch.id, watch.baseline_capture_id, watch.baseline_pinned_at)
      .first<{ name: string; created_at: string; report_id: string; title: string }>();
    return row ? { name: row.name, reportId: row.report_id, reportTitle: row.title, approvedAt: row.created_at } : null;
  } catch (error) {
    console.error('[approval] could not read who approved the baseline', error);
    return null;
  }
}

/** `pinned_by_approval` on GET /api/watches/:id. Additive, and only while the approval's pin stands. */
export function provenanceDTO(provenance: ApprovalProvenance) {
  return {
    name: provenance.name,
    report_id: provenance.reportId,
    report_title: provenance.reportTitle,
    approved_at: provenance.approvedAt,
  };
}
