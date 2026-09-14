import { env } from 'cloudflare:workers';
import { HttpError, badRequest } from './http';
import { prefixedId, randomToken, sha256Hex } from './ids';
import { parseCaptureOptions } from './capture-options';
import { presetSettings, reportExpired, REVIEW_STATES } from './project-settings';
import type { CaptureRow } from './captures';
export interface Project {
  id: string;
  user_id: string;
  name: string;
  brand: string;
  created_at: string;
}
export interface Report {
  id: string;
  project_id: string;
  title: string;
  notes: string;
  created_at: string;
}
export async function projectsReady(): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='report_comments'",
  ).first());
}
export async function requireProjects() {
  if (!(await projectsReady()))
    throw new HttpError(
      503,
      'setup_required',
      'Projects are being prepared. Please try again after setup is complete.',
    );
}
export function requiredText(value: string | undefined, name: string, max: number): string {
  const text = (value ?? '').trim();
  if (!text || text.length > max) throw badRequest(`${name} must contain 1–${max} characters.`);
  return text;
}
export async function ownProject(userId: string, id: string): Promise<Project> {
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').bind(id, userId).first<Project>();
  if (!p) throw new HttpError(404, 'not_found', 'Project not found.');
  return p;
}
export async function listProjects(userId: string): Promise<Project[]> {
  return (
    await env.DB.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
      .bind(userId)
      .all<Project>()
  ).results;
}
export async function ownReport(userId: string, id: string) {
  const report = await env.DB.prepare(
    'SELECT r.* FROM review_reports r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.user_id=?',
  )
    .bind(id, userId)
    .first<Report>();
  if (!report) throw new HttpError(404, 'not_found', 'Report not found.');
  return { report, project: await ownProject(userId, report.project_id) };
}
export async function reportCaptures(report: Report, userId: string) {
  return (
    await env.DB.prepare(
      `SELECT rc.position, c.* FROM report_captures rc LEFT JOIN captures c ON c.id=rc.capture_id AND c.user_id=? WHERE rc.report_id=? ORDER BY rc.position`,
    )
      .bind(userId, report.id)
      .all<CaptureRow & { position: number }>()
  ).results;
}
export async function sharedReport(token: string, audit = false) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, 'not_found', 'This review link is unavailable.');
  await requireProjects();
  const hash = await sha256Hex(token);
  const link = await env.DB.prepare('SELECT * FROM report_links WHERE token_hash=?')
    .bind(hash)
    .first<{ report_id: string; expires_at: string }>();
  if (!link || reportExpired(link.expires_at))
    throw new HttpError(404, 'not_found', 'This review link has expired or was revoked.');
  const report = await env.DB.prepare('SELECT * FROM review_reports WHERE id=?').bind(link.report_id).first<Report>();
  if (!report) throw new HttpError(404, 'not_found', 'Report unavailable.');
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(report.project_id).first<Project>();
  if (!project) throw new HttpError(404, 'not_found', 'Report unavailable.');
  if (audit)
    await env.DB.prepare('UPDATE report_links SET access_count=access_count+1,last_access_at=? WHERE token_hash=?')
      .bind(new Date().toISOString(), hash)
      .run();
  return { report, project, expiresAt: link.expires_at };
}
export async function projectAction(userId: string, b: Record<string, string>, origin: string) {
  const now = new Date().toISOString();
  if (b.action === 'create') {
    const id = prefixedId('prj');
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=?')
      .bind(userId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw badRequest('The account limit is 100 projects.');
    await env.DB.prepare('INSERT INTO projects(id,user_id,name,brand,created_at) VALUES(?,?,?,?,?)')
      .bind(id, userId, requiredText(b.name, 'Name', 100), (b.brand ?? '').trim().slice(0, 100), now)
      .run();
    return { redirect: `/app/projects/${id}` };
  }
  const project = await ownProject(userId, b.project_id ?? '');
  if (b.action === 'rename') {
    await env.DB.prepare('UPDATE projects SET name=?,brand=? WHERE id=?')
      .bind(requiredText(b.name, 'Name', 100), (b.brand ?? '').trim().slice(0, 100), project.id)
      .run();
  } else if (b.action === 'delete') {
    await env.DB.prepare('DELETE FROM projects WHERE id=?').bind(project.id).run();
    return { redirect: '/app/projects' };
  } else if (b.action === 'attach' || b.action === 'detach' || b.action === 'review') {
    const kind = b.kind === 'watch' ? 'watch' : 'capture';
    const table = kind === 'watch' ? 'watches' : 'captures';
    const mapping = kind === 'watch' ? 'project_watches' : 'project_captures';
    const column = kind === 'watch' ? 'watch_id' : 'capture_id';
    const asset = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND user_id=?`)
      .bind(b.asset_id ?? '', userId)
      .first();
    if (!asset) throw new HttpError(404, 'not_found', 'Item not found.');
    if (b.action === 'detach')
      await env.DB.prepare(`DELETE FROM ${mapping} WHERE project_id=? AND ${column}=?`)
        .bind(project.id, b.asset_id)
        .run();
    else if (b.action === 'review') {
      if (kind !== 'capture' || !REVIEW_STATES.includes(b.review_status as any))
        throw badRequest('Choose a valid review status.');
      await env.DB.prepare('UPDATE project_captures SET review_status=? WHERE project_id=? AND capture_id=?')
        .bind(b.review_status, project.id, b.asset_id)
        .run();
    } else
      await env.DB.prepare(`INSERT OR IGNORE INTO ${mapping}(project_id,${column}) VALUES(?,?)`)
        .bind(project.id, b.asset_id)
        .run();
  } else if (b.action === 'preset') {
    const settings = presetSettings(b);
    const parsed = parseCaptureOptions({ ...settings, url: 'https://example.com' });
    if (!['desktop', 'tablet', 'mobile'].includes(parsed.device) || parsed.mode === 'series' || parsed.format === 'pdf')
      throw badRequest('Saved batch settings support desktop, tablet or mobile; visible or full page; PNG or JPG.');
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM capture_presets WHERE project_id=?')
      .bind(project.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 30) throw badRequest('A project can have 30 saved settings. Delete one to add another.');
    await env.DB.prepare('INSERT INTO capture_presets VALUES(?,?,?,?,?)')
      .bind(prefixedId('pre'), project.id, requiredText(b.name, 'Name', 80), JSON.stringify(settings), now)
      .run();
  } else if (b.action === 'delete_preset') {
    await env.DB.prepare('DELETE FROM capture_presets WHERE id=? AND project_id=?')
      .bind(b.preset_id ?? '', project.id)
      .run();
  } else if (b.action === 'report') {
    const ids = [b.before, b.after, b.mobile_before, b.mobile_after].filter(Boolean);
    if (ids.length !== 2 && ids.length !== 4)
      throw badRequest('Choose a before and after capture, plus an optional mobile pair.');
    if (!b.before || !b.after || !!b.mobile_before !== !!b.mobile_after)
      throw badRequest('Each comparison needs both a before and an after capture.');
    for (const id of ids) {
      const c = await env.DB.prepare(
        `SELECT c.id FROM captures c JOIN project_captures pc ON pc.capture_id=c.id WHERE c.id=? AND c.user_id=? AND pc.project_id=? AND c.status='done' AND c.format IN ('png','jpg') AND c.mode!='series'`,
      )
        .bind(id, userId, project.id)
        .first();
      if (!c)
        throw badRequest('Choose completed PNG/JPG captures from this project. Scroll series cannot be included.');
    }
    if (b.before === b.after || (b.mobile_before && b.mobile_before === b.mobile_after))
      throw badRequest('Before and after must be different captures.');
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM review_reports WHERE project_id=?')
      .bind(project.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) throw badRequest('A project can have 100 reports.');
    const id = prefixedId('rep');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO review_reports VALUES(?,?,?,?,?)').bind(
        id,
        project.id,
        requiredText(b.title, 'Title', 160),
        (b.notes ?? '').slice(0, 4000),
        now,
      ),
      ...ids.map((capture, i) => env.DB.prepare('INSERT INTO report_captures VALUES(?,?,?)').bind(id, capture, i)),
    ]);
    return { redirect: `/app/reports/${id}` };
  } else {
    const { report } = await ownReport(userId, b.report_id ?? '');
    if (report.project_id !== project.id) throw new HttpError(404, 'not_found', 'Report not found.');
    if (b.action === 'share') {
      const days = Number(b.days ?? 7);
      if (![1, 7, 30].includes(days)) throw badRequest('Links may last 1, 7 or 30 days.');
      const token = randomToken(32);
      await env.DB.prepare(
        `INSERT INTO report_links(report_id,token_hash,expires_at,created_at) VALUES(?,?,?,?) ON CONFLICT(report_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at,access_count=0,last_access_at=NULL`,
      )
        .bind(report.id, await sha256Hex(token), new Date(Date.now() + days * 86400000).toISOString(), now)
        .run();
      return { share_url: `${origin}/r/${token}` };
    } else if (b.action === 'revoke')
      await env.DB.prepare('DELETE FROM report_links WHERE report_id=?').bind(report.id).run();
    else if (b.action === 'delete_report') {
      await env.DB.prepare('DELETE FROM review_reports WHERE id=?').bind(report.id).run();
      return { redirect: `/app/projects/${project.id}` };
    } else if (b.action === 'edit_report')
      await env.DB.prepare('UPDATE review_reports SET title=?,notes=? WHERE id=?')
        .bind(requiredText(b.title, 'Title', 160), (b.notes ?? '').slice(0, 4000), report.id)
        .run();
    else if (b.action === 'comment') {
      const count = await env.DB.prepare('SELECT COUNT(*) n FROM report_comments WHERE report_id=?')
        .bind(report.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= 100) throw badRequest('This report has reached 100 notes.');
      await env.DB.prepare('INSERT INTO report_comments VALUES(?,?,?,?)')
        .bind(prefixedId('note'), report.id, requiredText(b.body, 'Note', 2000), now)
        .run();
    } else throw badRequest('Unknown project action.');
  }
  return { ok: true };
}
