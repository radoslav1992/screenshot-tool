import type { APIRoute } from 'astro';
import { assertSameOrigin, readBody, json, HttpError, badRequest } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { importUrls, readSitemap } from '../../../lib/monitor-import';
import { previewOptions } from '../../../lib/watch-settings';
import { createWatch, listWatches } from '../../../lib/watches';
import { watchLimit, allowedFrequencies } from '../../../lib/plans';
import { getUsage } from '../../../lib/captures';
import { forecast } from '../../../lib/monitor-health';
import { checkRateLimit } from '../../../lib/rate-limit';
export const POST: APIRoute = async ({ locals, request }) => {
 try {
  const user = locals.user;
  if (!user) throw new HttpError(401,'unauthorized','Sign in first.');
  assertSameOrigin(request); await assertVerified(user);
  if (!await checkRateLimit(`monitor-import:${user.id}`,10,3600).then(r=>r.ok)) throw new HttpError(429,'rate_limited','Try again later.');
  const body = await readBody(request);
  if (body.action === 'sitemap') return json({ urls: await readSitemap(body.sitemap || '') });
  const frequency = body.frequency || 'daily';
  if (!allowedFrequencies(user.plan).includes(frequency as never)) throw badRequest('Choose an included schedule.');
  const urls = importUrls(body.urls || '');
  const existing = await listWatches(user.id);
  const candidates = urls.map(url=>previewOptions({url,device:body.device || 'desktop'})).filter(o=>!existing.some(w=>w.url===o.url && w.device===o.device));
  if (existing.length+candidates.length > watchLimit(user.plan)) throw badRequest('This import exceeds your monitor limit. Reduce the list or upgrade.');
  const budget = await getUsage(user);
  const projection = forecast([...existing,...candidates.map((_o,i)=>({id:String(i),status:'active',frequency,next_run_at:new Date().toISOString()}))],budget);
  if (projection.monthlyOver || projection.shortfall) throw badRequest('This schedule exceeds your screenshot allowance. Choose a slower schedule or fewer pages.');
  const created: string[] = []; const failed: string[] = [];
  for (const options of candidates) {
   try { const watch = await createWatch(user,{options,label:options.host+new URL(options.url).pathname,frequency,threshold:1,notifyEmail:true,webhookUrl:null}); created.push(watch.id); }
   catch { failed.push(options.url); }
  }
  return json({created,failed,skipped:urls.length-candidates.length});
 } catch(e) { return toHttpError(e,'watch.import','Could not import monitors.').toResponse(); }
};
