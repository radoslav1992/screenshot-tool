import { parseMonitorRule } from '../../../lib/monitor-rules';
import { workflowsReady } from '../../../lib/monitor-rule-store';
import { env } from 'cloudflare:workers';
import { previewFingerprint } from '../../../lib/watch-settings';
import { frequencyHours } from '../../../lib/plans';
import type { APIRoute } from 'astro';
import { assertPublicCaptureUrl, parseCaptureOptions } from '../../../lib/capture-options';
import { HttpError, assertSameOrigin, badRequest, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { assertVerified } from '../../../lib/verification';
import { FREQUENCIES } from '../../../lib/plans';
import { createWatch, listWatches, toWatchDTO } from '../../../lib/watches';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  const rows = await listWatches(user.id);
  return json({ data: rows.map(toWatchDTO) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new HttpError(401, 'unauthorized', 'Sign in first.').toResponse();

  try {
    assertSameOrigin(request);
    await assertVerified(user);

    const body = await readBody(request);

    /*
     * The capture side is parsed by the same function the app and API use, so a
     * watch cannot be pointed anywhere a one-off capture could not go — the SSRF
     * and denylist checks come along with it.
     */
    const rule = parseMonitorRule(body);
    if (rule.kind !== 'visual' && !env.BROWSER) throw new HttpError(503,'setup_required','Text and element rules require Browser Rendering.');
    if ((rule.kind !== 'visual' || rule.region) && !await workflowsReady()) throw new HttpError(503,'setup_required','Monitor rules are being prepared.');
    const options = parseCaptureOptions({ ...body, mode: body.mode ?? 'fullpage' });

    if (options.mode === 'series') {
      throw badRequest('A scroll series has no single frame to compare, so it cannot be watched.', 'mode');
    }
    if (options.format === 'pdf') {
      throw badRequest('Watches compare images. Choose PNG or JPG.', 'format');
    }

    const frequency = (body.frequency ?? 'daily').toLowerCase();
    if (!FREQUENCIES.some((entry) => entry.id === frequency)) {
      throw badRequest('`frequency` must be one of: hourly, daily, weekly.', 'frequency');
    }

    const threshold = body.threshold === undefined || body.threshold === '' ? 1 : Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 100) {
      throw badRequest('`threshold` is a percentage between 0.1 and 100.', 'threshold');
    }

    let webhookUrl = (body.webhook_url ?? '').trim();
    if (webhookUrl && !/^https:\/\/\S+$/i.test(webhookUrl)) {
      throw badRequest('A webhook URL must start with https://.', 'webhook_url');
    }

    if (webhookUrl) webhookUrl = assertPublicCaptureUrl(webhookUrl).toString();

    let baseline: string | null = null;
    if (body.preview_token) {
      const raw = await env.RATE.get(`watch-preview:${body.preview_token}`);
      const receipt = raw ? JSON.parse(raw) : null;
      if (!receipt || receipt.user_id !== user.id || receipt.fingerprint !== (await previewFingerprint(options)))
        throw badRequest('The preview expired or capture settings changed. Preview again.');
      const capture = await env.DB.prepare("SELECT id FROM captures WHERE id=? AND user_id=? AND status='done'")
        .bind(receipt.capture_id, user.id)
        .first<{ id: string }>();
      if (!capture) throw badRequest('The preview image is no longer available. Preview again.');
      baseline = capture.id;
    }
    const watch = await createWatch(user, {
      options,
      rule,
      label: (body.label ?? '').trim(),
      frequency,
      threshold,
      notifyEmail: body.notify_email !== '0' && body.notify_email !== 'false',
      webhookUrl: webhookUrl || null,
    });

    if (baseline) {
      watch.next_run_at = new Date(Date.now() + frequencyHours(frequency) * 3600000).toISOString();
      await env.DB.prepare('UPDATE watches SET baseline_capture_id=?,next_run_at=? WHERE id=?')
        .bind(baseline, watch.next_run_at, watch.id)
        .run();
      watch.baseline_capture_id = baseline;
    }
    return json(toWatchDTO(watch), { status: 201 });
  } catch (error) {
    return toHttpError(error, 'watches.create', 'The watch could not be created.').toResponse();
  }
};
