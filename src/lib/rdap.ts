import { env } from 'cloudflare:workers';
import { formatDate } from './dates';
import { FetchFailure, fetchPublic, readCapped } from './safe-fetch';
import { isIpLiteral } from './tls-probe';

/**
 * When a site's domain registration runs out, read from RDAP, the JSON
 * successor to WHOIS that every gTLD registry and most country registries run.
 *
 * Which server to ask comes from IANA's bootstrap file, a list of TLDs and
 * the RDAP base URL for each, kept in KV for a day (and per isolate) so one
 * sweep does not fetch it per domain. If it cannot be had, rdap.org, which
 * redirects to the right registry, stands in.
 *
 * The registrable domain is the part someone actually registers: example.com
 * for www.example.com, but example.co.uk for shop.example.co.uk. The proper
 * answer is the Public Suffix List, which this repository does not carry and
 * would have to keep current. RDAP itself tells most of it: the last two
 * labels are asked for first, and a registry that has no such domain (404)
 * means those two labels are a suffix, so the last three are asked for next.
 * The common two-label suffixes are known up front (MULTI_LABEL_SUFFIXES), so
 * shop.example.co.uk costs one request, not two. A private suffix (github.io,
 * say) reads as the domain its operator registered, which is the registration
 * the site depends on anyway.
 */

export type DomainStatus = 'ok' | 'expiring' | 'expired' | 'unknown';

export interface DomainReading {
  status: DomainStatus;
  /** The registrable domain asked about, or the host when there is none. */
  domain: string;
  expiresAt: string | null;
  registrar: string | null;
  /** Plain words for the monitor page and the care report. */
  detail: string;
  /** The registry could not be asked this time: ask again tomorrow rather than next week. */
  retry?: boolean;
}

/** A registration this close to its end is worth a warning. */
export const DOMAIN_EXPIRING_DAYS = 30;
export const RDAP_TIMEOUT_MS = 10_000;
export const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
export const FALLBACK_RDAP = 'https://rdap.org/';
export const BOOTSTRAP_KEY = 'site-health:rdap-bootstrap';
const BOOTSTRAP_TTL_SECONDS = 86_400;

/** Second-level suffixes registries sell domains under, so the registrable domain is three labels. */
export const MULTI_LABEL_SUFFIXES = new Set(
  (
    'co.uk org.uk me.uk ltd.uk plc.uk net.uk ac.uk gov.uk sch.uk nhs.uk ' +
    'com.au net.au org.au edu.au gov.au id.au asn.au co.nz net.nz org.nz govt.nz ac.nz ' +
    'co.jp ne.jp or.jp ac.jp go.jp co.kr or.kr ne.kr com.cn net.cn org.cn gov.cn ' +
    'com.hk org.hk com.tw org.tw com.sg org.sg com.my com.ph co.id co.th in.th com.vn ' +
    'co.in net.in org.in firm.in gen.in ind.in com.pk com.bd com.np com.lk ' +
    'com.br net.br org.br gov.br com.mx org.mx gob.mx com.ar com.co com.pe com.ve com.ec com.uy ' +
    'co.za org.za web.za co.ke or.ke co.tz co.ug com.ng com.gh com.eg co.ma ' +
    'co.il org.il ac.il com.tr org.tr net.tr gen.tr com.sa com.qa com.kw com.bh com.om co.ae ' +
    'com.ua org.ua com.pl net.pl org.pl co.at or.at com.es org.es com.pt com.gr com.cy com.mt'
  ).split(' '),
);

/** The domains to ask RDAP about for a host, in order. Empty for an address or a bare name. */
export function registrableCandidates(host: string): string[] {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIpLiteral(name)) return [];
  const labels = name.split('.').filter(Boolean);
  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) return [];
  const last = (count: number) => labels.slice(-count).join('.');
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(last(2))) return [last(3)];
  return labels.length >= 3 ? [last(2), last(3)] : [last(2)];
}

/* -------------------------------------------------------------------------- */
/* The bootstrap                                                               */
/* -------------------------------------------------------------------------- */

let isolateBootstrap: { map: Record<string, string>; at: number } | undefined;

/** Turns IANA's `services: [[tlds], [urls]]` into one base URL per TLD, preferring https. */
export function bootstrapMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) return map;
  for (const service of services) {
    if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
    const urls = (service[1] as unknown[]).filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
    const base = urls.find((url) => url.startsWith('https://')) ?? urls[0];
    if (!base) continue;
    for (const tld of service[0] as unknown[]) {
      if (typeof tld === 'string' && /^[a-z0-9-]{1,63}$/i.test(tld)) map[tld.toLowerCase()] = base.endsWith('/') ? base : `${base}/`;
    }
  }
  return map;
}

/** The TLD → RDAP server map: per isolate, then KV, then IANA. Null when none of them answers. */
export async function rdapBootstrap(now = Date.now()): Promise<Record<string, string> | null> {
  if (isolateBootstrap && now - isolateBootstrap.at < BOOTSTRAP_TTL_SECONDS * 1000) return isolateBootstrap.map;
  try {
    const cached = await env.RATE?.get<{ map: Record<string, string>; at: number }>(BOOTSTRAP_KEY, 'json');
    if (cached?.map && now - cached.at < BOOTSTRAP_TTL_SECONDS * 1000) {
      isolateBootstrap = cached;
      return cached.map;
    }
  } catch {
    // KV is a cache here; without it IANA is asked.
  }
  try {
    const json = await rdapJson(BOOTSTRAP_URL);
    if (!json.ok) return null;
    const map = bootstrapMap(json.body);
    if (!Object.keys(map).length) return null;
    isolateBootstrap = { map, at: now };
    await env.RATE?.put(BOOTSTRAP_KEY, JSON.stringify(isolateBootstrap), { expirationTtl: BOOTSTRAP_TTL_SECONDS }).catch(() => undefined);
    return map;
  } catch {
    return null;
  }
}

/** For tests: forget the per-isolate copy. */
export function forgetBootstrap(): void {
  isolateBootstrap = undefined;
}

/* -------------------------------------------------------------------------- */
/* Asking                                                                      */
/* -------------------------------------------------------------------------- */

type JsonAnswer = { ok: true; body: unknown } | { ok: false; status: number | null; problem: string };

const AGENT = 'Mozilla/5.0 (compatible; EasyScreenCapture-SiteHealth/1; +https://easyscreencapture.com/privacy)';

/** A GET of an RDAP or bootstrap URL, its JSON read up to 1 MB. Redirects are followed through the same checks as any fetch. */
async function rdapJson(url: string): Promise<JsonAnswer> {
  const deadline = AbortSignal.timeout(RDAP_TIMEOUT_MS);
  try {
    const { response } = await fetchPublic(url, {
      maxRedirects: 3,
      signal: () => deadline,
      headers: { accept: 'application/rdap+json, application/json;q=0.9', 'user-agent': AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: response.status, problem: `HTTP ${response.status}` };
    }
    const text = await readCapped(response, 1_000_000, 'error');
    return { ok: true, body: JSON.parse(text?.text ?? '') };
  } catch (error) {
    return { ok: false, status: null, problem: error instanceof FetchFailure ? error.problem : 'unreadable' };
  }
}

interface RdapDomain {
  events?: Array<{ eventAction?: unknown; eventDate?: unknown }>;
  entities?: Array<{ roles?: unknown; vcardArray?: unknown; handle?: unknown }>;
  status?: unknown;
}

/** The registrar's name from an RDAP entity's vCard (`fn`), or its handle. */
function registrarOf(domain: RdapDomain): string | null {
  for (const entity of Array.isArray(domain.entities) ? domain.entities : []) {
    if (!Array.isArray(entity?.roles) || !entity.roles.includes('registrar')) continue;
    const card = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : null;
    const fn = Array.isArray(card) ? card.find((field) => Array.isArray(field) && field[0] === 'fn') : null;
    const name = Array.isArray(fn) && typeof fn[3] === 'string' ? fn[3] : typeof entity.handle === 'string' ? entity.handle : null;
    if (name) return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || null;
  }
  return null;
}

/** What an RDAP domain answer says, judged at `now`. */
export function readRdapDomain(json: unknown, domain: string, now = new Date()): DomainReading {
  const record = (json ?? {}) as RdapDomain;
  const registrar = registrarOf(record);
  const events = Array.isArray(record.events) ? record.events : [];
  const raw = events.find((event) => typeof event?.eventAction === 'string' && event.eventAction.toLowerCase() === 'expiration')?.eventDate;
  const expires = typeof raw === 'string' ? new Date(raw) : null;
  const statuses = Array.isArray(record.status) ? record.status.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [];
  const tld = domain.split('.').pop();
  const lapsed = statuses.some((s) => s.includes('redemption period') || s.includes('pending delete'));

  if (!expires || Number.isNaN(expires.getTime())) {
    return {
      status: lapsed ? 'expired' : 'unknown',
      domain,
      expiresAt: null,
      registrar,
      detail: lapsed
        ? `${domain} has lapsed: the registry lists it as ${statuses.find((s) => s.includes('redemption') || s.includes('pending delete'))}. Renew it with the registrar now.`
        : `The .${tld} registry doesn't publish when domains expire, so the expiry date can't be checked.`,
    };
  }
  const expiresAt = expires.toISOString();
  const days = Math.floor((expires.getTime() - now.getTime()) / 86_400_000);
  const with_ = registrar ? ` with ${registrar}` : '';
  if (expires.getTime() <= now.getTime() || lapsed) {
    return { status: 'expired', domain, expiresAt, registrar, detail: `${domain} expired on ${formatDate(expiresAt)}. Renew it${with_} now, before someone else can register it.` };
  }
  if (days <= DOMAIN_EXPIRING_DAYS) {
    return {
      status: 'expiring',
      domain,
      expiresAt,
      registrar,
      detail: `${domain} expires in ${days} ${days === 1 ? 'day' : 'days'}, on ${formatDate(expiresAt)}. Renew it${with_}, or check that auto-renewal is on.`,
    };
  }
  return { status: 'ok', domain, expiresAt, registrar, detail: `${domain} is registered until ${formatDate(expiresAt)}.` };
}

/**
 * The registration behind `host`. Never throws: a registry that cannot be
 * asked, or does not answer, is "unknown" with the reason. `asked` shares
 * lookups between calls in one sweep, keyed by URL, so www.example.com and
 * shop.example.com ask about example.com once.
 */
export async function checkDomain(host: string, now = new Date(), asked = new Map<string, Promise<unknown>>()): Promise<DomainReading> {
  const candidates = registrableCandidates(host);
  if (!candidates.length) {
    return { status: 'unknown', domain: host, expiresAt: null, registrar: null, detail: "This site is reached by an address, not a domain name, so there's no registration to check." };
  }
  const tld = candidates[0]!.split('.').pop()!;
  const bootstrap = await rdapBootstrap(now.getTime());
  const base = bootstrap ? bootstrap[tld] : FALLBACK_RDAP;
  if (!base) {
    return { status: 'unknown', domain: candidates[0]!, expiresAt: null, registrar: null, detail: `The .${tld} registry doesn't offer RDAP lookups, so the expiry date can't be checked.` };
  }
  for (const domain of candidates) {
    const url = `${base}domain/${domain}`;
    if (!asked.has(url)) asked.set(url, rdapJson(url));
    const answer = (await asked.get(url)) as JsonAnswer;
    if (answer.ok) return readRdapDomain(answer.body, domain, now);
    if (answer.status === 404) continue;
    const why =
      answer.status === 429
        ? 'The registry is limiting lookups right now'
        : answer.status
          ? `The registry answered with an error (HTTP ${answer.status})`
          : "The registry couldn't be reached";
    return { status: 'unknown', domain, expiresAt: null, registrar: null, detail: `${why}; it is asked again tomorrow.`, retry: true };
  }
  return { status: 'unknown', domain: candidates[0]!, expiresAt: null, registrar: null, detail: `The .${tld} registry has no record of ${candidates[0]}.` };
}
