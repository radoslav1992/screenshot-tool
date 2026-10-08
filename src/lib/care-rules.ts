import { HttpError, badRequest } from './http';
import { oneLine } from './branding-rules';
import { formatDay, formatShortDay, periodLabel, type CarePeriod } from './care-period';
import type { SiteHealthSummary } from './site-health-summary';

/**
 * Care report rules that need no binding: what a snapshot holds, the
 * recipients an owner may enter, the headline figures, the next steps, the
 * plain summary, how a snapshot is kept under its size cap and the email a
 * client gets. Kept apart from lib/care-reports.ts so pages, the PDF and the
 * check script read the same rules without a database.
 */

/** Client addresses per project. */
export const CARE_MAX_RECIPIENTS = 5;
/** Changed checks listed per monitor; the rest are counted as "and N more". */
export const CARE_CHANGES_PER_MONITOR = 10;
/** Findings listed per SEO or rule monitor. */
export const CARE_FINDINGS_PER_MONITOR = 5;
/** Monitors listed in one report. A project can hold more; they are counted. */
export const CARE_MAX_MONITORS = 60;
/** Review reports listed as awaiting sign-off. */
export const CARE_MAX_AWAITING = 10;
/** Sites, open broken links and incidents shown under site health. */
export const CARE_MAX_SITES = 10;
export const CARE_MAX_BROKEN = 20;
export const CARE_MAX_INCIDENTS = 10;
/** The stored snapshot, in characters, as the table's CHECK enforces. */
export const CARE_SNAPSHOT_MAX = 256 * 1024;
/** How long a share link works unless extended or revoked. */
export const CARE_LINK_DAYS = 90;

/** Limits in one place, so the check script and the routes agree. */
export const CARE_LIMITS = {
  /** "Send now" for one project, and across one account, per UTC day. */
  sendProject: { limit: 3, windowSeconds: 86_400 },
  sendAccount: { limit: 10, windowSeconds: 86_400 },
  /** Generating by hand: each one reads a month of history. */
  generate: { limit: 20, windowSeconds: 3_600 },
  /** Settings, links and the rest. */
  actions: { limit: 120, windowSeconds: 3_600 },
  /** The owner's PDF, as for review reports. */
  pdf: { limit: 6, windowSeconds: 3_600 },
  /** The client's PDF, per link and per address. */
  publicPdfLink: { limit: 5, windowSeconds: 3_600 },
  publicPdfIp: { limit: 10, windowSeconds: 3_600 },
} as const;

export type MonitorKind = 'visual' | 'text' | 'appeared' | 'disappeared' | 'price' | 'element' | 'seo';

export const KIND_LABELS: Record<string, string> = {
  visual: 'Visual',
  text: 'Page text',
  appeared: 'Phrase appears',
  disappeared: 'Phrase disappears',
  price: 'Price',
  element: 'Element',
  seo: 'SEO signals',
};

/** Certificate and domain states as the report words them. */
export const SSL_WORDS: Record<string, string> = {
  ok: 'Valid',
  expiring: 'Expiring soon',
  expired: 'Expired',
  invalid: 'Invalid',
  no_https: 'No HTTPS',
  unknown: 'Not checked',
};
export const DOMAIN_WORDS: Record<string, string> = {
  ok: 'Registered',
  expiring: 'Expiring soon',
  expired: 'Expired',
  unknown: 'Not checked',
};

export interface CareChange {
  runId: string;
  at: string;
  pct: number | null;
  summary: string;
  areas: number;
  /** A highlighted image was stored with the run; only the owner's view links to it. */
  highlight: boolean;
}

export interface CareMonitor {
  id: string;
  label: string;
  url: string;
  kind: string;
  checks: number;
  changes: number;
  failed: number;
  /** Its last three checks, up to the end of the period, all failed. */
  failing: boolean;
  /** Changed checks, newest first; only for visual monitors, rule findings are under `seo`. */
  changed: CareChange[];
  more: number;
  /** When the client's approval last moved the baseline in the period (migration 0022), if it did. */
  baselineApprovedAt?: string | null;
}

export interface CareFinding {
  at: string;
  lines: string[];
}

export interface CareRuleMonitor {
  id: string;
  label: string;
  url: string;
  kind: string;
  checks: number;
  flagged: number;
  findings: CareFinding[];
  more: number;
}

export interface CareSignoff {
  title: string;
  state: 'approved' | 'changes';
  name: string;
  at: string;
}

export interface CareAwaiting {
  title: string;
  createdAt: string;
}

export interface CareHealth extends SiteHealthSummary {
  /** Open broken links and incidents beyond what is listed. */
  brokenMore?: number;
  incidentsMore?: number;
}

export interface CareTotals {
  monitors: number;
  checks: number;
  changes: number;
  failed: number;
  skipped: number;
  approved: number;
  changesRequested: number;
  awaiting: number;
}

/** The whole report as frozen at generation. Version 1. */
export interface CareSnapshot {
  v: 1;
  project: { name: string; brand: string };
  period: CarePeriod;
  generatedAt: string;
  totals: CareTotals;
  summary: { text: string; source: 'model' | 'plain' };
  monitors: CareMonitor[];
  monitorsMore: number;
  /** Null while sign-off is not available (migration 0015). */
  signoffs: { decided: CareSignoff[]; awaiting: CareAwaiting[]; awaitingMore: number } | null;
  /** SEO and rule monitors; empty when the project has none, and the section is left out. */
  seo: CareRuleMonitor[];
  /** One entry per site; empty when there is no site health, and the section is hidden. */
  health: CareHealth[];
  nextSteps: string[];
}

/* -------------------------------------------------------------------------- */
/* Recipients                                                                  */
/* -------------------------------------------------------------------------- */

const EMAIL = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]{2,}$/;

/**
 * The client addresses an owner typed: one per line or comma-separated,
 * lower-cased, de-duplicated, five at most. The owner's own address is
 * refused — "Email me a copy" is for that — so a copy never goes twice.
 */
export function parseRecipients(raw: string | undefined, ownerEmail: string): string[] {
  const entries = (raw ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(entries)];
  for (const email of unique) {
    if (email.length > 254 || !EMAIL.test(email)) throw badRequest(`“${email.slice(0, 60)}” is not an email address.`, 'recipients');
    if (email === ownerEmail.trim().toLowerCase())
      throw badRequest('Your own address gets a copy when “Email me a copy” is ticked; list your client’s addresses here.', 'recipients');
  }
  if (unique.length > CARE_MAX_RECIPIENTS)
    throw badRequest(`A project can send its care report to up to ${CARE_MAX_RECIPIENTS} addresses.`, 'recipients');
  return unique;
}

/** Recipients as stored: a JSON array, read defensively. */
export function storedRecipients(json: string | null | undefined): string[] {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list)
      ? list.filter((entry): entry is string => typeof entry === 'string' && EMAIL.test(entry)).slice(0, CARE_MAX_RECIPIENTS)
      : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                     */
/* -------------------------------------------------------------------------- */

const number = (n: number) => n.toLocaleString('en-US');

/** "99.95%": two decimals below 100, none at it. */
export function uptimeText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  if (pct >= 100) return '100%';
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

/** Uptime over every site with checks: the checks that were up, of all checks. */
export function overallUptime(health: SiteHealthSummary[]): { pct: number | null; incidents: number; checks: number } {
  let checks = 0;
  let down = 0;
  let incidents = 0;
  for (const site of health) {
    if (!site.uptime || site.uptime.checks <= 0) continue;
    checks += site.uptime.checks;
    down += Math.min(site.uptime.down, site.uptime.checks);
    incidents += site.uptime.incidents.length;
  }
  return { pct: checks ? ((checks - down) / checks) * 100 : null, incidents, checks };
}

export interface CertificateState {
  /** "Valid", "1 expiring", "1 needs attention", or "—" with nothing checked. */
  text: string;
  ok: boolean;
}

/** SSL and domain together, for one headline figure. */
export function certificateState(health: SiteHealthSummary[]): CertificateState {
  let checked = 0;
  let expiring = 0;
  let bad = 0;
  for (const site of health) {
    for (const status of [site.ssl?.status, site.domain?.status]) {
      if (!status || status === 'unknown') continue;
      checked++;
      if (status === 'expiring') expiring++;
      else if (status !== 'ok') bad++;
    }
  }
  if (!checked) return { text: '—', ok: true };
  if (bad) return { text: `${bad} need${bad === 1 ? 's' : ''} attention`, ok: false };
  if (expiring) return { text: `${expiring} expiring`, ok: false };
  return { text: 'All valid', ok: true };
}

export function brokenLinks(health: SiteHealthSummary[]): { open: number; fixed: number; checked: boolean } {
  let open = 0;
  let fixed = 0;
  let checked = false;
  for (const site of health) {
    if (!site.links) continue;
    checked = true;
    open += site.links.broken.length + ((site as CareHealth).brokenMore ?? 0);
    fixed += site.links.fixed;
  }
  return { open, fixed, checked };
}

export interface Figure {
  /** The bracketed mono label. */
  label: string;
  /** The same in a sentence, for email. */
  name: string;
  value: string;
  note?: string;
  /** Something for the reader to look at; drawn with the accent. */
  attention?: boolean;
}

/**
 * The 4–6 numbers at the top. Checks, changes and approvals always; with site
 * health, uptime, certificates and broken links; without it, the monitors and
 * what waits for sign-off.
 */
export function headlineFigures(s: CareSnapshot): Figure[] {
  const figures: Figure[] = [
    {
      label: 'CHECKS RUN',
      name: 'Checks run',
      value: number(s.totals.checks),
      note: `${number(s.totals.monitors)} monitored page${s.totals.monitors === 1 ? '' : 's'}`,
    },
    { label: 'CHANGES FOUND', name: 'Changes found', value: number(s.totals.changes) },
  ];
  if (s.signoffs)
    figures.push({ label: 'APPROVED BY CLIENT', name: 'Approved by the client', value: number(s.totals.approved), note: 'review reports' });
  if (s.health.length) {
    const uptime = overallUptime(s.health);
    const certs = certificateState(s.health);
    const links = brokenLinks(s.health);
    figures.push({
      label: 'UPTIME',
      name: 'Uptime',
      value: uptimeText(uptime.pct),
      note: uptime.checks ? `${uptime.incidents} incident${uptime.incidents === 1 ? '' : 's'}` : 'not checked',
      attention: uptime.pct !== null && uptime.pct < 99.5,
    });
    figures.push({ label: 'SSL & DOMAIN', name: 'SSL and domain', value: certs.text, attention: !certs.ok });
    if (links.checked)
      figures.push({
        label: 'BROKEN LINKS',
        name: 'Broken links',
        value: `${number(links.open)} open`,
        note: `${number(links.fixed)} fixed`,
        attention: links.open > 0,
      });
  } else {
    if (!s.signoffs) figures.push({ label: 'FAILED CHECKS', name: 'Failed checks', value: number(s.totals.failed) });
    figures.push({
      label: s.signoffs ? 'AWAITING SIGN-OFF' : 'MONITORS',
      name: s.signoffs ? 'Waiting for sign-off' : 'Monitored pages',
      value: number(s.signoffs ? s.totals.awaiting : s.totals.monitors),
      attention: Boolean(s.signoffs && s.totals.awaiting),
    });
  }
  return figures.slice(0, 6);
}

/* -------------------------------------------------------------------------- */
/* Next steps                                                                  */
/* -------------------------------------------------------------------------- */

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
};
const pathOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    return url;
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An SEO finding that should not wait: the page left the index or stopped loading. */
function urgentSeo(line: string): string | null {
  if (/^Robots: .*→ .*\bnoindex\b/.test(line) && !/→ index\b/.test(line)) return 'it now asks search engines not to index it';
  const status = /^HTTP status: \d+ → ([45]\d\d)\b/.exec(line);
  return status ? `it now answers HTTP ${status[1]}` : null;
}

/**
 * Short, factual actions from the snapshot alone, most pressing first:
 * certificates and domains that lapse, outages still open, broken links by
 * page, SEO findings that lose traffic, monitors that keep failing, and what
 * waits on the client. "Nothing needs attention" when none apply.
 */
export function nextSteps(s: CareSnapshot): string[] {
  const tz = s.period.timezone;
  const steps: string[] = [];
  for (const site of s.health) {
    const host = site.domain?.domain || hostOf(site.origin);
    const ssl = site.ssl;
    if (ssl?.status === 'expired') steps.push(`Renew the SSL certificate for ${host}: it expired on ${formatDay(ssl.validTo, tz)}.`);
    else if (ssl?.status === 'expiring') steps.push(`Renew the SSL certificate for ${host} before ${formatShortDay(ssl.validTo, tz)}.`);
    else if (ssl?.status === 'invalid') steps.push(`Fix the SSL certificate for ${host}${ssl.detail ? `: ${oneLine(ssl.detail).slice(0, 120)}` : '.'}`);
    else if (ssl?.status === 'no_https') steps.push(`Serve ${host} over HTTPS.`);
    const domain = site.domain;
    if (domain?.status === 'expired') steps.push(`Renew the domain ${domain.domain}: it expired on ${formatDay(domain.expiresAt, tz)}.`);
    else if (domain?.status === 'expiring') steps.push(`Renew the domain ${domain.domain} before ${formatShortDay(domain.expiresAt, tz)}.`);
    const open = site.uptime?.incidents.find((incident) => !incident.endedAt);
    if (open) steps.push(`${hostOf(site.origin)} has been down since ${formatShortDay(open.startedAt, tz)}; restore it.`);
  }
  for (const site of s.health) {
    if (!site.links?.broken.length) continue;
    const byPage = new Map<string, number>();
    for (const link of site.links.broken) byPage.set(pathOf(link.page), (byPage.get(pathOf(link.page)) ?? 0) + 1);
    const pages = [...byPage.entries()].sort((a, b) => b[1] - a[1]);
    const total = site.links.broken.length + ((site as CareHealth).brokenMore ?? 0);
    if (pages.length === 1) steps.push(`Fix ${plural(total, 'broken link')} on ${pages[0]![0]}.`);
    else steps.push(`Fix ${plural(total, 'broken link')} on ${hostOf(site.origin)}, ${pages[0]![1]} of them on ${pages[0]![0]}.`);
  }
  for (const monitor of s.seo) {
    const latest = monitor.findings[0];
    const reason = latest?.lines.map(urgentSeo).find(Boolean);
    if (reason) steps.push(`Check ${pathOf(monitor.url)} on ${hostOf(monitor.url)}: ${reason}.`);
  }
  const failing = s.monitors.filter((monitor) => monitor.failing).length;
  if (failing) steps.push(`${plural(failing, 'monitor')} failed ${failing === 1 ? 'its' : 'their'} last 3 checks.`);
  if (s.signoffs) {
    if (s.totals.changesRequested)
      steps.push(`Make the changes requested on ${plural(s.totals.changesRequested, 'review report')}.`);
    if (s.totals.awaiting)
      steps.push(`${plural(s.totals.awaiting, 'review report')} ${s.totals.awaiting === 1 ? 'is' : 'are'} waiting for sign-off.`);
  }
  return steps.slice(0, 8);
}

export const NOTHING_NEEDED = 'Nothing needs attention.';

/* -------------------------------------------------------------------------- */
/* The summary paragraph                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The facts the summary may use, and nothing else: counts, the month and the
 * names the owner gave the monitors. No page text, no URLs beyond host names.
 */
export function summaryFacts(s: CareSnapshot): string[] {
  const facts = [
    `Period: ${s.period.label}${s.period.partial ? ' (month so far)' : ''}`,
    `Monitored pages: ${s.totals.monitors}`,
    `Checks run: ${s.totals.checks}`,
    `Changes found: ${s.totals.changes}`,
    `Failed checks: ${s.totals.failed}`,
  ];
  const busiest = [...s.monitors].filter((m) => m.changes > 0).sort((a, b) => b.changes - a.changes).slice(0, 3);
  for (const monitor of busiest) facts.push(`Changes on "${oneLine(monitor.label).slice(0, 60)}": ${monitor.changes}`);
  if (s.signoffs) {
    facts.push(`Review reports approved by the client: ${s.totals.approved}`);
    facts.push(`Review reports with changes requested: ${s.totals.changesRequested}`);
    facts.push(`Review reports waiting for sign-off: ${s.totals.awaiting}`);
  }
  const flagged = s.seo.reduce((sum, m) => sum + m.flagged, 0);
  if (s.seo.length) facts.push(`SEO and content rule findings: ${flagged}`);
  if (s.health.length) {
    const uptime = overallUptime(s.health);
    if (uptime.pct !== null) facts.push(`Uptime: ${uptimeText(uptime.pct)} with ${uptime.incidents} incidents`);
    facts.push(`SSL and domain: ${certificateState(s.health).text}`);
    const links = brokenLinks(s.health);
    if (links.checked) facts.push(`Broken links: ${links.open} open, ${links.fixed} fixed`);
  }
  facts.push(`Next steps: ${s.nextSteps.length ? s.nextSteps.length : 'none'}`);
  return facts;
}

/**
 * The paragraph when no model is available, or its answer is refused: the
 * same facts in plain sentences, the same way every time.
 */
export function plainSummary(s: CareSnapshot): string {
  const month = s.period.partial ? `So far in ${s.period.label}` : `In ${s.period.label}`;
  const sentences: string[] = [];
  if (!s.totals.monitors) sentences.push(`${month} no pages of this website were monitored.`);
  else {
    const changes = s.totals.changes
      ? `found ${plural(s.totals.changes, 'change')}`
      : 'found no changes';
    sentences.push(
      `${month} we ran ${plural(s.totals.checks, 'check')} on ${plural(s.totals.monitors, 'monitored page')} and ${changes}.`,
    );
    const busiest = [...s.monitors].filter((m) => m.changes > 0).sort((a, b) => b.changes - a.changes)[0];
    if (busiest && s.totals.changes > 1 && busiest.changes < s.totals.changes)
      sentences.push(`${oneLine(busiest.label).slice(0, 60)} changed most often, ${plural(busiest.changes, 'time')}.`);
  }
  if (s.signoffs && (s.totals.approved || s.totals.changesRequested || s.totals.awaiting)) {
    const parts = [];
    if (s.totals.approved) parts.push(`you approved ${plural(s.totals.approved, 'review report')}`);
    if (s.totals.changesRequested) parts.push(`asked for changes on ${s.totals.changesRequested}`);
    const lead = parts.length ? `${parts.join(' and ')}` : '';
    const waiting = s.totals.awaiting ? `${plural(s.totals.awaiting, 'report')} ${s.totals.awaiting === 1 ? 'is' : 'are'} waiting for your sign-off` : '';
    const sentence = [lead, waiting].filter(Boolean).join('; ');
    sentences.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.');
  }
  if (s.health.length) {
    const uptime = overallUptime(s.health);
    if (uptime.pct !== null)
      sentences.push(`The site was up ${uptimeText(uptime.pct)} of the time, with ${plural(uptime.incidents, 'incident')}.`);
    const links = brokenLinks(s.health);
    if (links.checked && (links.open || links.fixed))
      sentences.push(`${plural(links.open, 'broken link')} ${links.open === 1 ? 'is' : 'are'} open and ${number(links.fixed)} ${links.fixed === 1 ? 'was' : 'were'} fixed.`);
  }
  sentences.push(s.nextSteps.length ? `There ${s.nextSteps.length === 1 ? 'is one next step' : `are ${s.nextSteps.length} next steps`} below.` : 'Nothing needs your attention.');
  return sentences.join(' ');
}

/**
 * Whether a model's paragraph can stand in for the plain one: one paragraph of
 * reasonable length, no links or markup, and every number in it one the facts
 * contain. A model that invents a figure is caught here rather than mailed.
 */
export function acceptSummary(text: string, facts: string[]): string | null {
  const paragraph = oneLine(text.replace(/^["'“]+|["'”]+$/g, ''));
  if (paragraph.length < 40 || paragraph.length > 700) return null;
  if (/https?:|www\.|[<>{}\[\]*#`|]/i.test(paragraph)) return null;
  const allowed = new Set<string>();
  for (const fact of facts) for (const n of fact.match(/\d+(?:[.,]\d+)*/g) ?? []) allowed.add(n.replace(/,/g, ''));
  for (const n of paragraph.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const plain = n.replace(/,(?=\d{3}\b)/g, '').replace(/[.,]$/, '');
    if (!allowed.has(plain) && !allowed.has(plain.replace(/\.0+$/, ''))) return null;
  }
  return paragraph;
}

/* -------------------------------------------------------------------------- */
/* Size                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Keeps a snapshot under the stored cap by listing less: fewer changes per
 * monitor, fewer findings, fewer broken links, then fewer monitors, shorter
 * summaries last. Counts stay whole, so "and N more" still adds up. Never
 * throws; the smallest form is a few kilobytes.
 */
export function fitSnapshot(snapshot: CareSnapshot, max = CARE_SNAPSHOT_MAX): CareSnapshot {
  const size = (s: CareSnapshot) => JSON.stringify(s).length;
  let s = snapshot;
  const steps: Array<(s: CareSnapshot) => CareSnapshot> = [
    (s) => ({ ...s, monitors: s.monitors.map((m) => trimChanges(m, 3)) }),
    (s) => ({ ...s, seo: s.seo.map((m) => trimFindings(m, 2)) }),
    (s) => ({ ...s, health: s.health.map((h) => trimHealth(h, 5)) }),
    (s) => ({ ...s, monitors: s.monitors.map((m) => ({ ...m, changed: m.changed.map((c) => ({ ...c, summary: c.summary.slice(0, 140) })) })) }),
    (s) => ({ ...s, monitors: s.monitors.map((m) => trimChanges(m, 0)), seo: s.seo.map((m) => trimFindings(m, 0)) }),
    (s) => ({ ...s, monitors: s.monitors.slice(0, 20), monitorsMore: s.monitorsMore + Math.max(0, s.monitors.length - 20), seo: s.seo.slice(0, 20) }),
    (s) => ({ ...s, health: s.health.slice(0, 3).map((h) => trimHealth(h, 0)) }),
  ];
  for (const step of steps) {
    if (size(s) <= max) return s;
    s = step(s);
  }
  return s;
}

function trimChanges(m: CareMonitor, keep: number): CareMonitor {
  return m.changed.length <= keep ? m : { ...m, changed: m.changed.slice(0, keep), more: m.more + m.changed.length - keep };
}
function trimFindings(m: CareRuleMonitor, keep: number): CareRuleMonitor {
  return m.findings.length <= keep ? m : { ...m, findings: m.findings.slice(0, keep), more: m.more + m.findings.length - keep };
}
function trimHealth(h: CareHealth, keep: number): CareHealth {
  if (!h.links || h.links.broken.length <= keep) return h;
  return { ...h, links: { ...h.links, broken: h.links.broken.slice(0, keep) }, brokenMore: (h.brokenMore ?? 0) + h.links.broken.length - keep };
}

/** A stored snapshot, or a 404: one that cannot be read is treated like one that is not there. */
export function readSnapshot(json: string): CareSnapshot {
  try {
    const parsed = JSON.parse(json) as CareSnapshot;
    if (parsed?.v === 1 && parsed.period && parsed.totals) return parsed;
  } catch {
    /* fall through */
  }
  throw new HttpError(404, 'not_found', 'Care report unavailable.');
}

/* -------------------------------------------------------------------------- */
/* The client's email                                                          */
/* -------------------------------------------------------------------------- */

export interface CareEmailInput {
  snapshot: CareSnapshot;
  link: string;
  expiresAt: string;
  sender: { name: string; email: string };
  /** The project's reports carry no "Easy Screen Capture" (REPORT_WHITE_LABEL). */
  whiteLabel: boolean;
}

/**
 * The plain-text email a client gets: the project and month in the subject,
 * the headline figures, the link and who sent it. Everything the owner typed
 * is one short line; the product is named only when the report is.
 */
export function careEmail(input: CareEmailInput): { subject: string; text: string } {
  const s = input.snapshot;
  const project = oneLine(s.project.brand || s.project.name).slice(0, 80) || 'Your website';
  const name = oneLine(s.project.name).slice(0, 80);
  const month = periodLabel(s.period.key) + (s.period.partial ? ' so far' : '');
  const figures = headlineFigures(s)
    .map((figure) => `${figure.name}: ${figure.value}${figure.note ? ` (${figure.note})` : ''}`)
    .join('\n');
  const who = oneLine(input.sender.name).slice(0, 80);
  const sender = who && who.toLowerCase() !== input.sender.email.toLowerCase() ? `${who} (${input.sender.email})` : input.sender.email;
  const steps = s.nextSteps.length ? s.nextSteps.slice(0, 5).map((step) => `- ${step}`).join('\n') : NOTHING_NEEDED;
  return {
    subject: `${name || project} · Website care report · ${month}`,
    text:
      `${project} — website care report for ${month}\n\n` +
      `${figures}\n\n` +
      `Next steps:\n${steps}\n\n` +
      `Read the full report:\n${input.link}\n\n` +
      `The link works until ${formatDay(input.expiresAt, s.period.timezone)}. Anyone with it can read the report, so forward it only to people who should.\n\n` +
      (input.whiteLabel ? `Sent by ${sender}.` : `Sent by ${sender} using Easy Screen Capture.`) +
      ' Reply to this email to reach them.',
  };
}

/** The owner's copy: the same figures, and the report in the app rather than a client link. */
export function ownerCopyEmail(input: Omit<CareEmailInput, 'sender' | 'whiteLabel'> & { recipients: string[] }): {
  subject: string;
  text: string;
} {
  const s = input.snapshot;
  const name = oneLine(s.project.name).slice(0, 80) || 'Your project';
  const month = periodLabel(s.period.key) + (s.period.partial ? ' so far' : '');
  const figures = headlineFigures(s)
    .map((figure) => `${figure.name}: ${figure.value}`)
    .join('\n');
  return {
    subject: `Your copy: ${name} · Website care report · ${month}`,
    text:
      (input.recipients.length
        ? `The ${month} care report for ${name} went to ${input.recipients.join(', ')}.\n\n`
        : `The ${month} care report for ${name} is ready. No client addresses are set, so this copy is the only email.\n\n`) +
      `${figures}\n\n` +
      `Open the report, its PDF and its links:\n${input.link}\n\n` +
      'Each recipient has their own link, so revoking the report stops all of them.',
  };
}
