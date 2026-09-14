import { env } from 'cloudflare:workers';
import { acquireBrowser, releaseBrowser } from './browser-pool';
import { reportCaptures, type Project, type Report } from './projects';
import { safeParseFiles } from './captures';
import { HttpError } from './http';
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export async function reportPdf(project: Project, report: Report): Promise<Uint8Array> {
  const captures = await reportCaptures(report, project.user_id);
  const parts: string[] = [];
  let total = 0;
  for (const c of captures) {
    const file = c.id ? safeParseFiles(c.files)[0] : null;
    if (!file || !['image/png', 'image/jpeg'].includes(file.contentType))
      throw new HttpError(
        409,
        'image_missing',
        'A report image expired or was deleted. Replace the report with current captures.',
      );
    const object = await env.SHOTS.get(file.key);
    if (!object) throw new HttpError(409, 'image_missing', 'A report image is no longer available.');
    total += object.size;
    if (total > 16 * 1024 * 1024)
      throw new HttpError(
        413,
        'report_too_large',
        'PDF export supports up to 16 MB of source images. Use smaller PNG/JPG captures.',
      );
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    parts.push(
      `<section class="capture"><h2>${['Before · baseline', 'After · current', 'Mobile · before', 'Mobile · after'][c.position]}</h2><p>${escapeHtml(c.url)}<br>${c.width} × ${c.height} CSS px · ${c.scale}× scale · ${escapeHtml(c.mode)}<br>${escapeHtml(c.created_at)}</p><img src="data:${file.contentType};base64,${btoa(binary)}"></section>`,
    );
  }
  const html = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font:14px Arial,sans-serif;color:#20251e}header{border-bottom:3px solid #b5d652;padding-bottom:20px}h1{font-size:34px}p{overflow-wrap:anywhere;white-space:pre-wrap}section.capture{break-before:page}section.capture p{font-size:11px}img{width:100%;height:220mm;object-fit:contain;object-position:top left}</style><header><p>${escapeHtml(project.brand || project.name)} · WEBSITE REVIEW</p><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(project.name)} · ${escapeHtml(report.created_at)}</p></header><h2>Review notes</h2><p>${escapeHtml(report.notes)}</p>${parts.join('')}`;
  const puppeteer = (await import('@cloudflare/puppeteer')).default;
  const lease = await acquireBrowser(puppeteer);
  let success = false;
  try {
    const page = await lease.browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (request: any) => (request.url().startsWith('data:') ? request.continue() : request.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 30000 });
      success = true;
      return new Uint8Array(pdf);
    } finally {
      await page.close();
    }
  } finally {
    await releaseBrowser(lease, success);
  }
}
