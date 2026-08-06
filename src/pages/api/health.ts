import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../lib/http';

export const prerender = false;

interface CheckResult {
  ok: boolean;
  detail?: string;
}

const TABLES = ['users', 'sessions', 'api_keys', 'captures', 'usage_counters'];

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
          detail: 'Schema not applied. Run `npm run db:migrate`, or paste db/apply-manually.sql into the D1 console.',
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
 * GET /api/health — reports whether each Cloudflare binding is wired up and
 * whether the D1 schema has been applied. Returns only booleans and setup
 * hints: no data, no credentials.
 */
export const GET: APIRoute = async () => {
  const [database, storage, kv] = await Promise.all([checkDatabase(), checkStorage(), checkKv()]);
  const renderer = checkRenderer();
  const ok = database.ok && storage.ok && kv.ok && renderer.ok;

  return json(
    { ok, checks: { database, storage, kv, renderer } },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
};
