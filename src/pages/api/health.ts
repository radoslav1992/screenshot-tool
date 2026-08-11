import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../lib/http';
import { hashPassword } from '../../lib/auth';
import { automaticTaxEnabled, billingEnabled, priceIdFor, webhookConfigured } from '../../lib/billing';
import { PAID_PLANS } from '../../lib/plans';
import { mailTransport, sender, type MailTransport } from '../../lib/mailer';

export const prerender = false;

interface CheckResult {
  ok: boolean;
  detail?: string;
}

const TABLES = [
  'users',
  'sessions',
  'api_keys',
  'captures',
  'usage_counters',
  'email_verifications',
  'billing_events',
];

async function checkDatabase(): Promise<CheckResult & { tables?: string[]; missing?: string[] }> {
  if (!env.DB) return { ok: false, detail: 'No DB binding on this deployment.' };
  try {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`,
    )
      .bind(...TABLES)
      .all<{ name: string }>();

    const present = (results ?? []).map((row) => row.name);
    const missing = TABLES.filter((table) => !present.includes(table));
    return missing.length
      ? {
          ok: false,
          detail:
            'Schema not applied or out of date. Run `npm run db:migrate`, or paste db/apply-manually.sql (fresh database) or the matching db/000N-upgrade.sql into the D1 console.',
          tables: present,
          missing,
        }
      : { ok: true, tables: present };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkStorage(): Promise<CheckResult> {
  if (!env.SHOTS) return { ok: false, detail: 'No SHOTS binding on this deployment.' };
  try {
    // A HEAD on a key that does not exist proves reachability without writing.
    await env.SHOTS.head('__healthcheck__');
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkKv(): Promise<CheckResult> {
  if (!env.RATE) return { ok: false, detail: 'No RATE binding on this deployment.' };
  try {
    await env.RATE.get('__healthcheck__');
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs the real password hash. The Workers runtime caps PBKDF2 iterations and
 * throws above the limit — and the local runtime does not, so that failure only
 * appears once deployed. Checking it here makes it visible without CLI access.
 */
async function checkCrypto(): Promise<CheckResult> {
  try {
    await hashPassword('health-check-not-a-real-password');
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkRenderer(): CheckResult & { engine: string } {
  if (env.BROWSER) return { ok: true, engine: 'binding' };
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) return { ok: true, engine: 'rest' };
  return {
    ok: false,
    engine: 'none',
    detail: 'Bind Browser Rendering as BROWSER, or set the CF_ACCOUNT_ID and CF_API_TOKEN secrets.',
  };
}

/**
 * Mail is optional too. It reports the transport and the sender address — the
 * address is public by definition, and a typo in it is exactly the kind of thing
 * this check exists to make visible.
 */
function checkMailer(): CheckResult & {
  transport: MailTransport;
  from: string | null;
  verificationRequired: boolean;
} {
  const from = sender();
  const transport = mailTransport();
  const verificationRequired = env.REQUIRE_EMAIL_VERIFICATION === '1';

  const notes: string[] = [];
  if (!from) {
    notes.push('EMAIL_FROM is empty or malformed, so nothing can be sent');
  } else if (transport === 'none') {
    notes.push(
      'no transport: bind Cloudflare Email Sending as EMAIL in wrangler.jsonc, or set the RESEND_API_KEY secret',
    );
  }
  if (verificationRequired && transport === 'none') {
    notes.push('REQUIRE_EMAIL_VERIFICATION is on but stays inactive without a transport');
  }

  return {
    ok: true,
    transport,
    from: from ? (from.name ? `${from.name} <${from.email}>` : from.email) : null,
    verificationRequired,
    ...(notes.length ? { detail: notes.join('; ') } : {}),
  };
}

/**
 * Billing is optional, so this never fails the overall check — it reports which
 * pieces are configured. It only names which price ids are present, never their
 * values, and never touches the Stripe key.
 */
function checkBilling(): CheckResult & {
  enabled: boolean;
  webhook: boolean;
  automaticTax: boolean;
  purchasable: string[];
  prices: Record<string, string[]>;
} {
  const enabled = billingEnabled();

  /*
   * Per interval, not just per plan. A plan counts as purchasable on one price,
   * so a monthly-only ladder looks complete here while a yearly subscriber
   * cannot be moved to another yearly plan at all — the exact gap that is
   * invisible from a list of plan names.
   */
  const prices: Record<string, string[]> = {};
  for (const plan of PAID_PLANS) {
    prices[plan] = (['monthly', 'yearly'] as const).filter((interval) => priceIdFor(plan, interval));
  }
  const purchasable = PAID_PLANS.filter((plan) => prices[plan]!.length > 0);

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      webhook: false,
      automaticTax: false,
      purchasable: [],
      prices: {},
      detail: 'Payments are off. Set STRIPE_SECRET_KEY to turn checkout on.',
    };
  }

  const halfPriced = purchasable.filter((plan) => prices[plan]!.length === 1);

  const missing: string[] = [];
  if (!webhookConfigured()) missing.push('STRIPE_WEBHOOK_SECRET is not set, so plan changes will never apply');
  if (purchasable.length === 0) missing.push('no STRIPE_PRICE_* ids are set, so nothing can be bought');
  if (halfPriced.length) {
    missing.push(
      `only one billing period is priced for ${halfPriced.join(', ')}, so the other period cannot be bought or switched to`,
    );
  }
  if (!automaticTaxEnabled()) missing.push('Stripe Tax is off; prices are charged with no VAT/GST added');

  return {
    ok: true,
    enabled: true,
    webhook: webhookConfigured(),
    automaticTax: automaticTaxEnabled(),
    purchasable,
    prices,
    ...(missing.length ? { detail: missing.join('; ') } : {}),
  };
}

/**
 * GET /api/health — reports whether each Cloudflare binding is wired up and
 * whether the D1 schema has been applied. Returns only booleans and setup
 * hints: no data, no credentials.
 */
export const GET: APIRoute = async () => {
  const [database, storage, kv, cryptoCheck] = await Promise.all([
    checkDatabase(),
    checkStorage(),
    checkKv(),
    checkCrypto(),
  ]);
  const renderer = checkRenderer();
  const billing = checkBilling();
  const mailer = checkMailer();
  const ok = database.ok && storage.ok && kv.ok && cryptoCheck.ok && renderer.ok;

  return json(
    { ok, checks: { database, storage, kv, crypto: cryptoCheck, renderer, billing, mailer } },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
};
