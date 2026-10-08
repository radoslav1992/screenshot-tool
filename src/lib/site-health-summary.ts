/**
 * Site health for a set of monitors over a period: uptime, the SSL
 * certificate, domain expiry and broken links, one summary per site.
 *
 * A stub. The real one lands with migration 0020 and replaces this file; until
 * then there is no site health to report, so care reports hide the section.
 */
export interface SiteHealthSummary {
  origin: string;
  uptime: {
    checks: number;
    down: number;
    pct: number | null;
    incidents: Array<{ startedAt: string; endedAt: string | null; minutes: number; detail: string }>;
  } | null;
  ssl: {
    status: 'ok' | 'expiring' | 'expired' | 'invalid' | 'no_https' | 'unknown';
    validTo: string | null;
    issuer: string | null;
    checkedAt: string;
    detail: string;
  } | null;
  domain: {
    status: 'ok' | 'expiring' | 'expired' | 'unknown';
    domain: string;
    expiresAt: string | null;
    registrar: string | null;
    checkedAt: string;
    detail: string;
  } | null;
  links: {
    checkedAt: string;
    pages: number;
    checked: number;
    broken: Array<{ page: string; url: string; status: number | null; reason: string }>;
    fixed: number;
  } | null;
}

export async function siteHealthReady(): Promise<boolean> {
  return false;
}

export async function siteHealthForWatches(
  _userId: string,
  _watchIds: string[],
  _from: string,
  _to: string,
): Promise<SiteHealthSummary[]> {
  return [];
}
