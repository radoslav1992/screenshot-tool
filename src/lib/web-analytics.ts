/**
 * Cloudflare Web Analytics: page views, referrers, countries, browsers and
 * Core Web Vitals, counted by Cloudflare's beacon. It uses no cookies and no
 * local storage, and Cloudflare does not fingerprint visitors with it, so it
 * needs no consent banner and the privacy page's "no cookies" promise holds.
 *
 * The snippet is added here rather than by Cloudflare's automatic setup, which
 * would put it on every page of the zone: the pages below must never be
 * measured, and only a snippet we render can leave them out.
 *
 * The site token is public by design (the beacon puts it in every page it
 * runs on), so it lives in the code, not in a secret. Empty turns the beacon
 * off everywhere, and the privacy page then says no analytics run.
 */
export const WEB_ANALYTICS_TOKEN = '';

export const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/**
 * Never measured. The beacon reports the address it runs on, and these
 * addresses carry a secret (a review, care report or file link, an invitation,
 * an email confirmation or a password reset) or are a page an agency shows its
 * own client under its own brand. None of them may leave the site.
 */
const PRIVATE_PREFIXES = ['/r/', '/care/', '/f/', '/join/', '/app/invite', '/reset-password', '/verify'];

/** Query parameters that carry a credential anywhere on the site. */
const SECRET_PARAMS = ['token', 't', 'code', 'key'];

export function measuredPage(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (PRIVATE_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) return false;
  return !SECRET_PARAMS.some((name) => url.searchParams.has(name));
}

/** The token to render on this page, or null: off, malformed, or a page that is never measured. */
export function beaconToken(url: URL, token: string = WEB_ANALYTICS_TOKEN): string | null {
  if (!/^[0-9a-f]{32}$/i.test(token)) return null;
  return measuredPage(url) ? token : null;
}

export function webAnalyticsEnabled(token: string = WEB_ANALYTICS_TOKEN): boolean {
  return /^[0-9a-f]{32}$/i.test(token);
}
