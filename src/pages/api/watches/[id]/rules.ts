import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getWatch } from '../../../../lib/watches';
import { parseMonitorRule } from '../../../../lib/monitor-rules';
import { saveMonitorRule, workflowsReady } from '../../../../lib/monitor-rule-store';
import { assertSameOrigin, readBody, json, HttpError } from '../../../../lib/http';
import { assertVerified } from '../../../../lib/verification';
import { toHttpError } from '../../../../lib/errors';
export const POST: APIRoute = async ({ locals, request, params }) => {
 try {
  if (!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
  assertSameOrigin(request); await assertVerified(locals.user);
  const watch = await getWatch(params.id || '');
  if (!watch || watch.user_id !== locals.user.id) throw new HttpError(404,'not_found','Monitor not found.');
  if (!await workflowsReady()) throw new HttpError(503,'setup_required','Monitor rules are being prepared.');
  const rule = parseMonitorRule(await readBody(request));
  if (rule.kind !== 'visual' && !env.BROWSER) throw new HttpError(503,'setup_required','Text and element rules require Browser Rendering.');
  await saveMonitorRule(watch.id,rule);
  return json({ message:'Rule saved. Element rules establish their baseline on the next check.' });
 } catch(e) { return toHttpError(e,'watch.rules','Could not save rule.').toResponse(); }
};
