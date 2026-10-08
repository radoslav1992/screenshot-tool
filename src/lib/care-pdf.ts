import { logoDataUri, projectBranding } from './branding';
import { escapeHtml, printPdf } from './report-pdf';
import { displayUrl } from './capture-options';
import { formatDay, formatDayTime, formatShortDay } from './care-period';
import {
  DOMAIN_WORDS,
  KIND_LABELS,
  NOTHING_NEEDED,
  SSL_WORDS,
  headlineFigures,
  uptimeText,
  type CareHealth,
  type CareSnapshot,
} from './care-rules';
import type { ReportBranding } from './branding-rules';
import type { Project } from './projects';

/**
 * A care report as a PDF: the same sections as the web page, laid out for A4
 * and printed through the review report's browser path (printPdf), which runs
 * no script and loads nothing but data: URIs. The logo is inlined; there are
 * no screenshots, so a report prints in one short render whatever its size.
 */

const e = (value: string | number | null | undefined) => escapeHtml(String(value ?? ''));
const n = (value: number) => value.toLocaleString('en-US');

export function careReportHtml(s: CareSnapshot, branding: ReportBranding | null, logo: string | null): string {
  const tz = s.period.timezone;
  const accent = branding?.accent || '#fb7515';
  const brand = s.project.brand || s.project.name;
  const section = (title: string, body: string) => `<section><h2>${e(title)}</h2>${body}</section>`;
  const figures = headlineFigures(s)
    .map(
      (f) =>
        `<div class="figure${f.attention ? ' attention' : ''}"><span>[ ${e(f.label)} ]</span><strong>${e(f.value)}</strong>${f.note ? `<em>${e(f.note)}</em>` : ''}</div>`,
    )
    .join('');
  const monitors = s.monitors
    .map((m) => {
      const changes =
        m.kind === 'visual' && m.changed.length
          ? `<ol>${m.changed
              .map(
                (c) =>
                  `<li><time>${e(formatDayTime(c.at, tz))}</time> ${c.pct !== null ? `<b>${e(c.pct < 0.01 ? '<0.01' : c.pct)}% changed</b>` : ''}${c.areas ? ` · ${c.areas} changed ${c.areas === 1 ? 'area' : 'areas'}` : ''}${c.summary && !/^[\d.<]+% changed$/.test(c.summary) ? `<br>${e(c.summary.replace(/^[\d.<]+% changed\s*·?\s*/, ''))}` : ''}</li>`,
              )
              .join('')}</ol>`
          : '';
      const more = m.more ? `<p class="muted">and ${n(m.more)} more</p>` : '';
      const approved = m.baselineApprovedAt ? `<p>Baseline updated after approval on ${e(formatShortDay(m.baselineApprovedAt, tz))}.</p>` : '';
      return `<div class="item"><h3>${e(m.label)}</h3><p class="muted">${e(displayUrl(m.url))} · ${e(KIND_LABELS[m.kind] ?? m.kind)} · ${n(m.checks)} checks · ${n(m.changes)} changes${m.failed ? ` · ${n(m.failed)} failed` : ''}</p>${approved}${changes}${more}</div>`;
    })
    .join('');
  const signoffs = s.signoffs
    ? section(
        'Client sign-offs',
        (s.signoffs.decided.length
          ? `<ul>${s.signoffs.decided.map((d) => `<li><b>[ ${d.state === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED'} ]</b> ${e(d.title)} <span class="muted">${d.name ? `by ${e(d.name)} · ` : ''}${e(formatShortDay(d.at, tz))}</span></li>`).join('')}</ul>`
          : '') +
          (s.signoffs.awaiting.length
            ? `<h3>Waiting for sign-off</h3><ul>${s.signoffs.awaiting.map((a) => `<li>${e(a.title)} <span class="muted">shared ${e(formatShortDay(a.createdAt, tz))}</span></li>`).join('')}</ul>${s.signoffs.awaitingMore ? `<p class="muted">and ${n(s.signoffs.awaitingMore)} more</p>` : ''}`
            : '') +
          (!s.signoffs.decided.length && !s.signoffs.awaiting.length ? '<p class="muted">No review reports were decided or waiting in this period.</p>' : ''),
      )
    : '';
  const seo = s.seo.length
    ? section(
        'SEO and content checks',
        s.seo
          .map(
            (m) =>
              `<div class="item"><h3>${e(m.label)}</h3><p class="muted">${e(displayUrl(m.url))} · ${e(KIND_LABELS[m.kind] ?? m.kind)} · ${n(m.checks)} checks · ${n(m.flagged)} flagged</p>${
                m.findings.length
                  ? `<ol>${m.findings.map((f) => `<li><time>${e(formatDayTime(f.at, tz))}</time><br>${f.lines.map(e).join('<br>')}</li>`).join('')}</ol>`
                  : '<p class="muted">Nothing was flagged.</p>'
              }${m.more ? `<p class="muted">and ${n(m.more)} more</p>` : ''}</div>`,
          )
          .join(''),
      )
    : '';
  const health = s.health.length
    ? section(
        'Site health',
        (s.health as CareHealth[])
          .map((site) => {
            const rows = [
              ['Uptime', site.uptime ? `${uptimeText(site.uptime.pct)} · ${n(site.uptime.checks)} checks · ${site.uptime.incidents.length + (site.incidentsMore ?? 0)} incidents` : 'Not checked'],
              ['SSL', site.ssl ? `${SSL_WORDS[site.ssl.status] ?? site.ssl.status}${site.ssl.validTo ? ` · valid to ${formatDay(site.ssl.validTo, tz)}` : ''}${site.ssl.issuer ? ` · ${site.ssl.issuer}` : ''}` : 'Not checked'],
              ['Domain', site.domain ? `${DOMAIN_WORDS[site.domain.status] ?? site.domain.status} · ${site.domain.domain}${site.domain.expiresAt ? ` · renews by ${formatDay(site.domain.expiresAt, tz)}` : ''}` : 'Not checked'],
              ['Links', site.links ? `${n(site.links.broken.length + (site.brokenMore ?? 0))} broken · ${n(site.links.fixed)} fixed · ${n(site.links.checked)} checked on ${n(site.links.pages)} pages` : 'Not checked'],
            ];
            const incidents = site.uptime?.incidents.length
              ? `<h3>Incidents</h3><ul>${site.uptime.incidents.map((i) => `<li>${e(formatDayTime(i.startedAt, tz))} · ${i.endedAt ? `down ${n(i.minutes)} min` : 'still down'}${i.detail ? ` · ${e(i.detail)}` : ''}</li>`).join('')}</ul>`
              : '';
            const broken = site.links?.broken.length
              ? `<h3>Broken links</h3><ul>${site.links.broken.map((l) => `<li>[ ${e(l.status ?? 'ERROR')} ] ${e(l.url)} <span class="muted">on ${e(l.page)}${l.reason ? ` · ${e(l.reason)}` : ''}</span></li>`).join('')}</ul>${site.brokenMore ? `<p class="muted">and ${n(site.brokenMore)} more</p>` : ''}`
              : '';
            return `<div class="item"><h3>${e(displayUrl(site.origin))}</h3><table>${rows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('')}</table>${incidents}${broken}</div>`;
          })
          .join(''),
      )
    : '';
  const steps = s.nextSteps.length ? `<ol class="steps">${s.nextSteps.map((step) => `<li>${e(step)}</li>`).join('')}</ol>` : `<p>${e(NOTHING_NEEDED)}</p>`;
  const footer = `${branding?.footer ? `<p>${e(branding.footer)}</p>` : ''}<p>Figures cover ${e(s.period.partial ? 'the month so far' : s.period.label)} in ${e(tz)}, as recorded when this report was generated on ${e(formatDayTime(s.generatedAt, tz))}.</p>${branding?.attribution !== false ? '<p>Shared with Easy Screen Capture</p>' : ''}`;
  return `<!doctype html><meta charset="utf-8"><title>${e(brand)} · ${e(s.period.label)}</title><style>
@page{size:A4;margin:16mm}body{font:12px/1.5 Arial,sans-serif;color:#20251e;margin:0}
header{border-bottom:3px solid ${accent};padding-bottom:14px;margin-bottom:14px}
img.logo{display:block;max-width:60mm;max-height:16mm;margin-bottom:6mm}
.eyebrow{font:10px monospace;letter-spacing:.06em;text-transform:uppercase;color:#555}
h1{font-size:28px;margin:6px 0 2px}h2{font-size:17px;margin:18px 0 8px;padding-top:8px;border-top:1px solid #ccc}h3{font-size:13px;margin:8px 0 2px}
p{margin:4px 0;overflow-wrap:anywhere}.muted{color:#555}
.figures{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #ccc;border-left:1px solid #ccc}
.figure{border-right:1px solid #ccc;border-bottom:1px solid #ccc;padding:8px 10px}.figure span{display:block;font:9px monospace}
.figure strong{display:block;font-size:20px;margin-top:4px}.figure em{display:block;font-style:normal;color:#555;font-size:11px}
.figure.attention{box-shadow:inset 3px 0 0 ${accent}}
.summary{font-size:13px;line-height:1.6;margin-top:10px}
.item{break-inside:avoid;border:1px solid #ddd;padding:8px 10px;margin:6px 0}
ol,ul{margin:4px 0;padding-left:18px}li{margin:3px 0;overflow-wrap:anywhere}time{font:10px monospace;color:#555}
table{border-collapse:collapse;width:100%;margin-top:4px}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #eee;vertical-align:top}th{width:22mm;font-weight:600}
.steps li{font-size:13px;margin:6px 0}section{break-inside:auto}
footer{margin-top:12mm;font-size:10px;color:#555}
</style><header>${logo ? `<img class="logo" src="${logo}" alt="">` : ''}<p class="eyebrow">${e(brand)} · Website care report</p><h1>${e(s.project.name)}</h1><p>${e(s.period.partial ? `${s.period.label} so far` : s.period.label)} · generated ${e(formatDay(s.generatedAt, tz))} · ${e(tz)}</p></header>
${section('At a glance', `<div class="figures">${figures}</div><p class="summary">${e(s.summary.text)}</p>`)}
${section('Changes this month', (monitors || '<p class="muted">No pages of this website were monitored in this period.</p>') + (s.monitorsMore ? `<p class="muted">and ${n(s.monitorsMore)} more monitored pages</p>` : ''))}
${signoffs}${seo}${health}${section('Next steps', steps)}<footer>${footer}</footer>`;
}

export async function carePdf(project: Project, snapshot: CareSnapshot): Promise<Uint8Array> {
  const branding = await projectBranding(project).catch(() => null);
  const logo = await logoDataUri(branding).catch(() => null);
  return printPdf(careReportHtml(snapshot, branding, logo));
}
