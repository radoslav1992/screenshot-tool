import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleWebhookEvent, verifyWebhookSignature, webhookConfigured } from '../../../lib/billing';
import { apiError, json } from '../../../lib/http';

export const prerender = false;

/**
 * POST /api/billing/webhook — Stripe's callback.
 *
 * Not same-origin and not cookie-authenticated: the signature is the auth. The
 * raw body must be read as text and verified before it is parsed, because the
 * signature covers the exact bytes Stripe sent.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!webhookConfigured()) {
    return apiError(503, 'billing_unavailable', 'No webhook secret is configured on this deployment.');
  }

  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  const valid = await verifyWebhookSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET!);
  if (!valid) {
    console.error('[billing.webhook] rejected an event with an invalid or stale signature');
    return apiError(400, 'invalid_signature', 'Signature verification failed.');
  }

  let event: { id: string; type: string; data: { object: unknown } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return apiError(400, 'invalid_request', 'Body is not valid JSON.');
  }

  if (!event?.id || !event?.type) {
    return apiError(400, 'invalid_request', 'Not a Stripe event.');
  }

  try {
    const outcome = await handleWebhookEvent(event as any);
    return json(outcome);
  } catch (error) {
    // Answer 500 so Stripe retries; the event id was claimed, so log loudly and
    // release it, otherwise the retry would be swallowed as a duplicate.
    console.error(`[billing.webhook] ${event.type} (${event.id}) failed`, error);
    await env.DB.prepare(`DELETE FROM billing_events WHERE id = ?`).bind(event.id).run().catch(() => undefined);
    return apiError(500, 'server_error', 'Could not process the event.');
  }
};
