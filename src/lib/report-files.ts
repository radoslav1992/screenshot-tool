import { env } from 'cloudflare:workers';
import { reportCaptures, type Report } from './projects';
import { safeParseFiles } from './captures';
import { HttpError } from './http';
export async function reportImage(report: Report, userId: string, position: string) {
  if (!/^[0-3]$/.test(position)) throw new HttpError(404, 'not_found', 'Image unavailable.');
  const c = (await reportCaptures(report, userId)).find((c) => c.position === Number(position));
  const file = c?.id ? safeParseFiles(c.files)[0] : null;
  if (!file || !['image/png', 'image/jpeg'].includes(file.contentType))
    throw new HttpError(404, 'not_found', 'Original image expired or was deleted.');
  const object = await env.SHOTS.get(file.key);
  if (!object) throw new HttpError(404, 'not_found', 'Original image expired or was deleted.');
  return new Response(object.body as unknown as ReadableStream, {
    headers: {
      'content-type': file.contentType,
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, noarchive',
    },
  });
}
