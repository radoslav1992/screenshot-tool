import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../lib/http';
import { hashPassword } from '../../lib/auth';
import { automaticTaxEnabled, billingEnabled, priceIdFor, webhookConfigured } from '../../lib/billing';
import { PAID_PLANS } from '../../lib/plans';

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
 * Billing is optional, so this never fails the overall check — it reports which
 * pieces are configured. It only names which price ids are present, never their
 * values, and never touches the Stripe key.
 */
function checkBilling(): CheckResult & {
  enabled: boolean;
  webhook: boolean;
  automaticTax: boolean;
  purchasable: string[];
} {
  const enabled = billingEnabled();
  const purchasable = PAID_PLANS.filter(
    (plan) => priceIdFor(plan, 'monthly') || priceIdFor(plan, 'yearly'),
  );

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      webhook: false,
      automaticTax: false,
      purchasable: [],
      detail: 'Payments are off. Set STRIPE_SECRET_KEY to turn checkout on.',
    };
  }

  const missing: string[] = [];
  if (!webhookConfigured()) missing.push('STRIPE_WEBHOOK_SECRET is not set, so plan changes will never apply');
  if (purchasable.length === 0) missing.push('no STRIPE_PRICE_* ids are set, so nothing can be bought');
  if (!automaticTaxEnabled()) missing.push('Stripe Tax is off; prices are charged with no VAT/GST added');

  return {
    ok: true,
    enabled: true,
    webhook: webhookConfigured(),
    automaticTax: automaticTaxEnabled(),
    purchasable,
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
  const ok = database.ok && storage.ok && kv.ok && cryptoCheck.ok && renderer.ok;

  return json(
    { ok, checks: { database, storage, kv, crypto: cryptoCheck, renderer, billing } },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
};
