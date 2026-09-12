import { nextDigest } from './digest-schedule';
import { env } from 'cloudflare:workers';
import { HttpError, badRequest } from './http';
import { prefixedId, randomToken, sha256Hex } from './ids';
import { ownProject, requiredText, type Project, type Report } from './projects';
import type { SessionUser } from './auth';
export async function collaborationReady() {
  return !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='digest_deliveries'").first());
}
export async function requireCollaboration() {
  if (!(await collaborationReady()))
    throw new HttpError(503, 'setup_required', 'Collaboration is being prepared. Please try again later.');
}
export async function projectAccess(
  userId: string,
  id: string,
): Promise<{ project: Project; role: 'owner' | 'viewer' | 'editor' }> {
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first<Project>();
  if (!project) throw new HttpError(404, 'not_found', 'Project not found.');
  if (project.user_id === userId) return { project, role: 'owner' };
  await requireCollaboration();
  const member = await env.DB.prepare(
    `SELECT m.role FROM project_members m JOIN users u ON u.id=? WHERE m.project_id=? AND m.user_id=? AND u.plan='business'`,
  )
    .bind(project.user_id, id, userId)
    .first<{ role: 'viewer' | 'editor' }>();
  if (!member) throw new HttpError(404, 'not_found', 'Project not found.');
  return { project, role: member.role };
}
export async function reportAccess(userId: string, id: string) {
  const report = await env.DB.prepare('SELECT * FROM review_reports WHERE id=?').bind(id).first<Report>();
  if (!report) throw new HttpError(404, 'not_found', 'Report not found.');
  return { report, ...(await projectAccess(userId, report.project_id)) };
}
export async function collaborationAction(user: SessionUser, b: Record<string, string>, origin: string) {
  await requireCollaboration();
  const now = new Date().toISOString();
  if (b.action === 'accept') {
    // Invitation identity must be verified even when the deployment disables the general capture verification gate.
    const verified = await env.DB.prepare('SELECT email_lower FROM users WHERE id=? AND email_verified_at IS NOT NULL')
      .bind(user.id)
      .first<{ email_lower: string }>();
    if (!verified)
      throw new HttpError(403, 'email_unverified', 'Verify your email address before accepting a team invitation.');
    if (!/^[a-f0-9]{64}$/.test(b.token ?? '')) throw badRequest('Invalid invitation.');
    const result = await env.DB.prepare(
      `UPDATE project_members SET user_id=?,token_hash=NULL WHERE token_hash=? AND user_id IS NULL AND email_lower=? AND expires_at>? AND project_id IN(SELECT p.id FROM projects p JOIN users u ON u.id=p.user_id WHERE u.plan='business') RETURNING project_id`,
    )
      .bind(user.id, await sha256Hex(b.token), verified.email_lower, now)
      .first<{ project_id: string }>();
    if (!result)
      throw badRequest(
        'This invitation is expired, revoked, already accepted, or belongs to a different email address.',
      );
    return { redirect: `/app/team/${result.project_id}` };
  }
  const { project, role } = await projectAccess(user.id, b.project_id ?? '');
  if (b.action === 'digest') {
    const timezone = (b.timezone ?? 'UTC').trim();
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      throw badRequest('Choose a valid IANA timezone, such as Europe/Sofia.');
    }
    await env.DB.prepare(
      `INSERT INTO project_digests VALUES(?,?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET timezone=excluded.timezone,enabled=excluded.enabled,next_run_at=excluded.next_run_at`,
    )
      .bind(project.id, user.id, timezone, b.enabled === '1' ? 1 : 0, nextDigest(timezone, new Date()))
      .run();
  } else if (b.action === 'comment') {
    if (role === 'viewer') throw new HttpError(403, 'forbidden', 'Editors and project owners can add team comments.');
    const { report } = await reportAccess(user.id, b.report_id ?? '');
    if (report.project_id !== project.id) throw new HttpError(404, 'not_found', 'Report not found.');
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM team_comments WHERE report_id=?')
      .bind(report.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 200) throw badRequest('This report has reached 200 team comments.');
    await env.DB.prepare('INSERT INTO team_comments VALUES(?,?,?,?,?)')
      .bind(prefixedId('tc'), report.id, user.id, requiredText(b.body, 'Comment', 2000), now)
      .run();
  } else {
    await ownProject(user.id, project.id);
    if (b.action === 'revoke_member') {
      await env.DB.prepare('DELETE FROM project_members WHERE id=? AND project_id=?')
        .bind(b.member_id ?? '', project.id)
        .run();
    } else if (b.action === 'invite') {
      const owner = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(user.id).first<{ plan: string }>();
      if (owner?.plan !== 'business') throw new HttpError(403, 'plan_required', 'Team access is included on Business.');
      const email = (b.email ?? '').trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === user.email.toLowerCase())
        throw badRequest('Enter your collaborator’s email address.');
      if (!['viewer', 'editor'].includes(b.role)) throw badRequest('Choose viewer or editor.');
      await env.DB.prepare('DELETE FROM project_members WHERE project_id=? AND user_id IS NULL AND expires_at<=?')
        .bind(project.id, now)
        .run();
      if (
        await env.DB.prepare('SELECT id FROM project_members WHERE project_id=? AND email_lower=?')
          .bind(project.id, email)
          .first()
      )
        throw badRequest('That email already has access or a pending invitation. Revoke it before reinviting.');
      const token = randomToken();
      const result = await env.DB.prepare(
        `INSERT INTO project_members(id,project_id,email_lower,role,token_hash,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM project_members WHERE project_id=?)<3 RETURNING id`,
      )
        .bind(
          prefixedId('mem'),
          project.id,
          email,
          b.role,
          await sha256Hex(token),
          new Date(Date.now() + 7 * 86400000).toISOString(),
          now,
          project.id,
        )
        .first();
      if (!result)
        throw badRequest(
          'Business includes three collaborators per project, including pending invitations. Revoke an invitation or member first.',
        );
      return { share_url: `${origin}/app/invite?token=${token}` };
    } else throw badRequest('Unknown collaboration action.');
  }
  return { ok: true };
}
