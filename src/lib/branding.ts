import { env } from 'cloudflare:workers';
import { HttpError, badRequest } from './http';
import { randomToken } from './ids';
import {
  canHideAttribution,
  checkLogo,
  checkLogoSize,
  parseAccent,
  parseFooter,
  resolveBranding,
  whiteLabelPlans,
  type BrandingRow,
  type ReportBranding,
} from './branding-rules';
import type { Project } from './projects';

/**
 * Per-project report branding: a logo in R2, an accent colour, a footer line
 * and, on the top plans, no "Shared with Easy Screen Capture".
 *
 * Logos are served publicly at /brand/<project>/<random>.<ext>. Review links
 * are opened by people without an account, and a logo is meant to be shown
 * to them, so the URL itself is the secret: 128 random bits, new on every
 * upload. That makes it safe to cache for a year, and the route still answers
 * only for a project's current logo, so a replaced or removed one stops
 * resolving even if its object outlived the delete.
 */

/** Cached per isolate like watchSettingsReady: a yes for good, a no for a minute. */
let brandingTable: { ready: boolean; at: number } | undefined;
export async function brandingReady(): Promise<boolean> {
  if (brandingTable && (brandingTable.ready || Date.now() - brandingTable.at < 60_000)) return brandingTable.ready;
  const ready = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_branding'").first());
  brandingTable = { ready, at: Date.now() };
  return ready;
}

const LOGO_FILE = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
const PROJECT_ID = /^[a-z0-9_]{1,40}$/;

/** The stored row, for the settings form. Null before the migration or the first save. */
export async function brandingRow(projectId: string): Promise<BrandingRow | null> {
  if (!(await brandingReady())) return null;
  return env.DB.prepare(
    'SELECT logo_key,logo_type,logo_width,logo_height,accent,footer,hide_attribution FROM project_branding WHERE project_id=?',
  )
    .bind(projectId)
    .first<BrandingRow>();
}

/**
 * What a project's reports render with, under the owner's current plan. Null
 * while the migration is missing, so every report renders exactly as it did.
 */
export async function projectBranding(project: Pick<Project, 'id' | 'user_id'>): Promise<ReportBranding | null> {
  if (!(await brandingReady())) return null;
  const row = await env.DB.prepare(
    `SELECT u.plan,b.logo_key,b.logo_type,b.logo_width,b.logo_height,b.accent,b.footer,b.hide_attribution
     FROM users u LEFT JOIN project_branding b ON b.project_id=? WHERE u.id=?`,
  )
    .bind(project.id, project.user_id)
    .first<BrandingRow & { plan: string }>();
  // No branding row yet reads as all-null columns from the LEFT JOIN.
  return resolveBranding(row && row.accent !== null ? row : null, row?.plan);
}

/** Deletes R2 objects, logging rather than failing: an orphaned logo is only storage. */
async function deleteObjects(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await env.SHOTS.delete(keys);
  } catch (error) {
    console.error('[branding] could not delete logo objects', keys, error);
  }
}

/**
 * Removes every logo object a project has, current or orphaned. Called before
 * a project or an account is deleted; the row itself goes with the project.
 */
export async function deleteProjectLogos(projectId: string): Promise<void> {
  if (!PROJECT_ID.test(projectId) || !(await brandingReady())) return;
  try {
    const listed = await env.SHOTS.list({ prefix: `brand/${projectId}/`, limit: 100 });
    await deleteObjects(listed.objects.map((object) => object.key));
  } catch (error) {
    console.error('[branding] could not list logo objects', projectId, error);
  }
}

/**
 * An account's logo files and branding rows. The files are deleted here, first;
 * the row deletes are returned for the caller's batch, ahead of the projects.
 */
export async function accountBrandingCleanup(userId: string): Promise<D1PreparedStatement[]> {
  if (!(await brandingReady())) return [];
  const { results } = await env.DB.prepare(
    `SELECT b.logo_key FROM project_branding b JOIN projects p ON p.id=b.project_id WHERE p.user_id=? AND b.logo_key!=''`,
  )
    .bind(userId)
    .all<{ logo_key: string }>();
  for (let i = 0; i < results.length; i += 1000) await env.SHOTS.delete(results.slice(i, i + 1000).map((r) => r.logo_key));
  return [
    env.DB.prepare('DELETE FROM project_branding WHERE project_id IN (SELECT id FROM projects WHERE user_id=?)').bind(userId),
  ];
}

function first<T>(result: D1Result<unknown> | undefined): T | null {
  return ((result?.results ?? [])[0] as T | undefined) ?? null;
}

/**
 * Saves a project's branding, or removes its logo. Owners and editors may;
 * viewers may not — the caller resolves the role with `projectAccess`. The
 * previous logo key is read in the same batch as the write, so two saves
 * racing each other each delete what they replaced.
 */
export async function brandingAction(
  access: { project: Project; role: 'owner' | 'editor' | 'viewer' },
  form: FormData,
): Promise<{ ok: true }> {
  if (!(await brandingReady()))
    throw new HttpError(503, 'setup_required', 'Report branding is being prepared. Please try again after setup is complete.');
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const { project, role } = access;
  if (role === 'viewer') throw new HttpError(403, 'forbidden', 'Editors and project owners can change report branding.');
  const now = new Date().toISOString();
  const previous = env.DB.prepare('SELECT logo_key FROM project_branding WHERE project_id=?').bind(project.id);

  if (field('action') === 'remove_logo') {
    const [before] = await env.DB.batch([
      previous,
      env.DB.prepare(
        `UPDATE project_branding SET logo_key='',logo_type='',logo_width=0,logo_height=0,updated_at=? WHERE project_id=?`,
      ).bind(now, project.id),
    ]);
    const old = first<{ logo_key: string }>(before)?.logo_key;
    await deleteObjects(old ? [old] : []);
    return { ok: true };
  }
  if (field('action') !== 'save') throw badRequest('Unknown branding action.');

  const accent = parseAccent(field('accent'));
  const footer = parseFooter(field('footer'));
  const hide = field('hide_attribution') === '1';
  if (hide) {
    const owner = await env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(project.user_id).first<{ plan: string }>();
    if (!canHideAttribution(owner?.plan))
      throw new HttpError(403, 'plan_required', `Hiding the attribution is included on ${whiteLabelPlans()}.`);
  }

  const upload = form.get('logo');
  const file = upload && typeof upload !== 'string' && upload.size > 0 ? upload : null;
  let logo: { key: string; type: string; width: number; height: number } | null = null;
  if (file) {
    checkLogoSize(file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = checkLogo(bytes, file.type);
    logo = { key: `brand/${project.id}/${randomToken(16)}.${info.ext}`, type: info.type, width: info.width, height: info.height };
    await env.SHOTS.put(logo.key, bytes, { httpMetadata: { contentType: info.type } });
  }

  const columns = logo ? 'logo_key=excluded.logo_key,logo_type=excluded.logo_type,logo_width=excluded.logo_width,logo_height=excluded.logo_height,' : '';
  let before: D1Result<unknown> | undefined;
  try {
    [before] = await env.DB.batch([
      previous,
      env.DB.prepare(
        `INSERT INTO project_branding(project_id,logo_key,logo_type,logo_width,logo_height,accent,footer,hide_attribution,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET ${columns}accent=excluded.accent,footer=excluded.footer,hide_attribution=excluded.hide_attribution,updated_at=excluded.updated_at`,
      ).bind(project.id, logo?.key ?? '', logo?.type ?? '', logo?.width ?? 0, logo?.height ?? 0, accent, footer, hide ? 1 : 0, now),
    ]);
  } catch (error) {
    // Nothing points at the new object yet.
    if (logo) await deleteObjects([logo.key]);
    throw error;
  }
  const old = first<{ logo_key: string }>(before)?.logo_key;
  if (logo && old && old !== logo.key) await deleteObjects([old]);
  return { ok: true };
}

/**
 * Serves a project's current logo. The content type is the one sniffed at
 * upload, `nosniff` and a sandboxing CSP keep a browser from treating it as
 * anything else, and the year-long cache is safe because every upload gets a
 * new URL.
 */
export async function logoResponse(projectId: string, file: string): Promise<Response> {
  const missing = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!PROJECT_ID.test(projectId) || !LOGO_FILE.test(file) || !(await brandingReady())) return missing();
  const key = `brand/${projectId}/${file}`;
  const row = await env.DB.prepare('SELECT logo_type FROM project_branding WHERE project_id=? AND logo_key=?')
    .bind(projectId, key)
    .first<{ logo_type: string }>();
  if (!row || !['image/png', 'image/jpeg', 'image/webp'].includes(row.logo_type)) return missing();
  const object = await env.SHOTS.get(key);
  if (!object) return missing();
  return new Response(object.body as unknown as ReadableStream, {
    headers: {
      'content-type': row.logo_type,
      'content-disposition': 'inline',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}

/** The logo as a data: URI for the PDF, whose renderer may load nothing else. */
export async function logoDataUri(branding: ReportBranding | null): Promise<string | null> {
  if (!branding?.logoUrl) return null;
  const key = branding.logoUrl.slice(1);
  const object = await env.SHOTS.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  let info;
  try {
    info = checkLogo(bytes);
  } catch {
    return null;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${info.type};base64,${btoa(binary)}`;
}
