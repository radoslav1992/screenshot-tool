import type { APIRoute } from 'astro';
import { assertSameOrigin, readBody, json, HttpError, badRequest } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { importUrls, readSitemap } from '../../../lib/monitor-import';
import { previewOptions } from '../../../lib/watch-settings';
import { assertFrequencyFits, budgetSchedules, createWatch, listWatches } from '../../../lib/watches';
import { fastChecksReady } from '../../../lib/fast-checks';
import { watchLimit, allowedFrequencies } from '../../../lib/plans';
import { getUsage } from '../../../lib/captures';
import { forecast } from '../../../lib/monitor-health';
import { checkRateLimit } from '../../../lib/rate-limit';
import { parseMonitorRule } from '../../../lib/monitor-rules';
import { workflowsReady } from '../../../lib/monitor-rule-store';
import { env } from 'cloudflare:workers';
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
  // One rule for every page: visual, or every SEO signal. Finer rules are set per monitor.
  const kind = body.rule_kind || 'visual';
  if (!['visual','seo'].includes(kind)) throw badRequest('Import monitors for visual changes or SEO signals.');
  const rule = kind === 'seo' ? parseMonitorRule({ rule_kind: 'seo' }) : undefined;
  if (rule && !env.BROWSER) throw new HttpError(503,'setup_required','Text, element and SEO rules require Browser Rendering.');
  if (rule && !await workflowsReady()) throw new HttpError(503,'setup_required','Monitor rules are being prepared.');
  await assertFrequencyFits(frequency, kind);
  const urls = importUrls(body.urls || '');
  const existing = await listWatches(user.id);
  const candidates = urls.map(url=>previewOptions({url,device:body.device || 'desktop'})).filter(o=>!existing.some(w=>w.url===o.url && w.device===o.device));
  if (existing.length+candidates.length > watchLimit(user.plan)) throw badRequest('This import exceeds your monitor limit. Reduce the list or upgrade.');
  const budget = await getUsage(user);
  // SEO monitors read their pages first once smart checks exist, and render only on a change.
  const cost = rule && await fastChecksReady() ? 'change' as const : 'check' as const;
  const projection = forecast([...await budgetSchedules(existing),...candidates.map((_o,i)=>({id:String(i),status:'active',frequency,next_run_at:new Date().toISOString(),cost}))],budget);
  if (projection.monthlyOver || projection.shortfall) throw badRequest('This schedule exceeds your screenshot allowance. Choose a slower schedule or fewer pages.');
  const created: string[] = []; const failed: string[] = [];
  for (const options of candidates) {
   try { const watch = await createWatch(user,{options,rule,label:options.host+new URL(options.url).pathname,frequency,threshold:1,notifyEmail:true,webhookUrl:null}); created.push(watch.id); }
   catch { failed.push(options.url); }
  }
  return json({created,failed,skipped:urls.length-candidates.length});
 } catch(e) { return toHttpError(e,'watch.import','Could not import monitors.').toResponse(); }
};
