import { badRequest } from './http';
import type { PageFacts, SeoFacts } from './page-facts';

/**
 * SEO checks as a monitor rule: alert when a signal a search engine reads
 * changes against the baseline — a page that starts saying noindex, a 404, a
 * canonical pointing somewhere else, a rewritten title.
 *
 * The signals are read in the page with the rest of the facts (page-facts-fn.ts)
 * and stored on the capture as `facts.seo`, so each check compares with what its
 * baseline recorded. Everything here is string-in/value-out, which is what lets
 * scripts/seo-rules-check.mjs test it without a browser.
 */

export type SeoSignalId = 'title' | 'description' | 'canonical' | 'robots' | 'h1' | 'hreflang' | 'og' | 'status';

/** In the order the rule form lists them. */
export const SEO_SIGNALS: ReadonlyArray<{ id: SeoSignalId; label: string }> = [
  { id: 'title', label: 'Title' },
  { id: 'description', label: 'Meta description' },
  { id: 'canonical', label: 'Canonical URL' },
  { id: 'robots', label: 'Robots: noindex and nofollow' },
  { id: 'h1', label: 'First h1 and h1 count' },
  { id: 'hreflang', label: 'Hreflang alternates' },
  { id: 'og', label: 'Open Graph title, description and image' },
  { id: 'status', label: 'HTTP status' },
];

const IDS = SEO_SIGNALS.map((signal) => signal.id);

/** The run history line for a check whose baseline had no SEO signals to compare with. */
export const SEO_RECORDED = 'SEO signals recorded; the next check compares them.';

/* -------------------------------------------------------------------------- */
/* Which signals a rule watches                                                */
/* -------------------------------------------------------------------------- */

/*
 * Kept in monitor_rules.selector, so the rule needs no column of its own: a
 * comma list of signal ids ("title,robots,status"), or empty for every signal.
 * Empty means every signal there is, including any added later, so choosing
 * them all is stored as empty rather than as today's list. Unknown ids are
 * skipped when read: a list written by a later version still works here.
 */
export function encodeSeoSignals(ids: readonly string[]): string {
  const chosen = IDS.filter((id) => ids.includes(id));
  return chosen.length === IDS.length ? '' : chosen.join(',');
}

export function decodeSeoSignals(selector: string): SeoSignalId[] {
  const listed = selector.split(',').map((entry) => entry.trim().toLowerCase());
  const chosen = IDS.filter((id) => listed.includes(id));
  return chosen.length ? chosen : [...IDS];
}

/**
 * The signals a request chose, encoded. An API body sends `rule_seo_signals`
 * as a comma list (or JSON array); the rule form sends one `rule_seo_<id>`
 * checkbox each, plus `rule_seo_form` so that ticking none reads as none
 * rather than as a body that never mentioned them. Neither means all.
 */
export function seoSelectorFromBody(body: Record<string, string>): string {
  let chosen: string[];
  if (body.rule_seo_signals !== undefined) {
    chosen = body.rule_seo_signals.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    const unknown = chosen.filter((id) => !IDS.includes(id as SeoSignalId));
    if (unknown.length) throw badRequest(`Unknown SEO signal: ${unknown[0]}. Choose from ${IDS.join(', ')}.`, 'rule_seo_signals');
  } else if (body.rule_seo_form) {
    chosen = IDS.filter((id) => ['1', 'on', 'true'].includes((body[`rule_seo_${id}`] ?? '').toLowerCase()));
  } else {
    return '';
  }
  if (!chosen.length) throw badRequest('Choose at least one SEO signal to watch.', 'rule_seo_signals');
  return encodeSeoSignals(chosen);
}

/* -------------------------------------------------------------------------- */
/* Normalising                                                                 */
/* -------------------------------------------------------------------------- */

/** Runs of whitespace as one space, trimmed — how every text signal is compared. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * A canonical URL as it is compared. The page has already resolved it against
 * its own address, as a crawler does, so a protocol-relative `//example.com/a`
 * on an https page is stored as `https://example.com/a` and the two forms are
 * the same URL; one that arrives still protocol-relative is read as https.
 * Then: scheme and host in lower case and the default port dropped (the URL
 * parser does both), the fragment dropped, and a trailing slash on the path
 * dropped, so `/pricing/` is `/pricing` and `https://example.com/` is
 * `https://example.com`. The query stays: `?page=2` is another page.
 */
export function canonicalKey(raw: string): string {
  const value = text(raw);
  if (!value) return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return value;
  }
}

/** Robots directives whose name is followed by a value, so a colon after them does not name a bot. */
const VALUED = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/**
 * Whether a set of robots directives keeps a page out of the index, or its
 * links unfollowed. `none` is both. In an X-Robots-Tag a `name:` prefix scopes
 * what follows to one crawler; only unscoped directives and Googlebot's count,
 * as with the meta tags read in the page.
 */
export function robotsState(directives: string): { noindex: boolean; nofollow: boolean } {
  const found = new Set<string>();
  for (const line of directives.toLowerCase().split('\n')) {
    let scope = '*';
    for (const part of line.split(',')) {
      let directive = part.trim();
      const scoped = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(directive);
      if (scoped && !VALUED.has(scoped[1]!)) {
        scope = scoped[1]!;
        directive = scoped[2]!.trim();
      }
      if (scope === '*' || scope === 'googlebot') found.add(directive);
    }
  }
  return {
    noindex: found.has('noindex') || found.has('none'),
    nofollow: found.has('nofollow') || found.has('none'),
  };
}

/**
 * The robots state two captures are compared on. The header only counts when
 * both saw the response: a baseline that could not read headers would otherwise
 * make an unchanged X-Robots-Tag look new.
 */
function robots(seo: SeoFacts, withHeader: boolean) {
  const meta = robotsState(seo.robots ?? '');
  const header = withHeader ? robotsState(seo.robots_header ?? '') : { noindex: false, nofollow: false };
  return {
    noindex: meta.noindex || header.noindex,
    nofollow: meta.nofollow || header.nofollow,
    headerOnly: header.noindex && !meta.noindex,
  };
}

/* -------------------------------------------------------------------------- */
/* Comparing                                                                   */
/* -------------------------------------------------------------------------- */

const clip = (value: string, max = 80) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const quoted = (value: string) => (value ? `"${clip(value)}"` : 'none');
const bare = (value: string) => (value ? clip(value, 120) : 'none');

interface Change {
  line: string;
  /** Called out first: the page dropping out of the index, or failing to load. */
  urgent?: boolean;
}

/**
 * What changed between two captures' SEO signals, for the signals a rule
 * watches. Each change is one line — `Title: "Old" → "New"`,
 * `Robots: index → noindex` — joined with "; " so the detail stays one line in
 * an email subject. Noindex appearing and a 4xx/5xx status come first; the
 * rest follow in a fixed order, so the same change always reads the same.
 *
 * A baseline taken before the rule has no signals: this check records them
 * and says so, and the next one compares.
 */
export function compareSeo(
  before: Pick<PageFacts, 'seo'>,
  after: Pick<PageFacts, 'seo'>,
  selector: string,
): { changed: boolean; detail: string } {
  if (!after.seo) throw new Error('SEO signals could not be read from the page. The previous baseline has been kept.');
  if (!before.seo) return { changed: false, detail: SEO_RECORDED };
  const a = before.seo;
  const b = after.seo;
  const watched = new Set(decodeSeoSignals(selector));
  const changes: Change[] = [];

  if (watched.has('status') && typeof a.status === 'number' && typeof b.status === 'number' && a.status !== b.status) {
    changes.push({ line: `HTTP status: ${a.status} → ${b.status}`, urgent: b.status >= 400 && a.status < 400 });
  }

  if (watched.has('robots')) {
    const headers = typeof a.robots_header === 'string' && typeof b.robots_header === 'string';
    const was = robots(a, headers);
    const is = robots(b, headers);
    // Only the half that changed is named: "index → noindex", not the follow that stayed.
    const halves = [
      { changed: was.noindex !== is.noindex, word: (state: typeof was) => (state.noindex ? 'noindex' : 'index') },
      { changed: was.nofollow !== is.nofollow, word: (state: typeof was) => (state.nofollow ? 'nofollow' : 'follow') },
    ].filter((half) => half.changed);
    if (halves.length) {
      const say = (state: typeof was) => halves.map((half) => half.word(state)).join(', ');
      const appeared = is.noindex && !was.noindex;
      // A noindex no meta tag shows is the one most likely to puzzle whoever reads the alert.
      const source = appeared && is.headerOnly ? ' (X-Robots-Tag header)' : '';
      changes.push({ line: `Robots: ${say(was)} → ${say(is)}${source}`, urgent: appeared });
    }
  }

  if (watched.has('canonical') && canonicalKey(a.canonical) !== canonicalKey(b.canonical)) {
    changes.push({ line: `Canonical: ${bare(text(a.canonical))} → ${bare(text(b.canonical))}` });
  }

  const textual = (id: SeoSignalId, label: string, from: string, to: string) => {
    if (watched.has(id) && text(from) !== text(to)) changes.push({ line: `${label}: ${quoted(text(from))} → ${quoted(text(to))}` });
  };
  textual('title', 'Title', a.title, b.title);
  textual('description', 'Meta description', a.description, b.description);
  textual('h1', 'H1', a.h1, b.h1);
  if (watched.has('h1') && a.h1_count !== b.h1_count) changes.push({ line: `H1 count: ${a.h1_count} → ${b.h1_count}` });

  if (watched.has('hreflang')) {
    const line = hreflangChange(a.hreflang, b.hreflang);
    if (line) changes.push({ line });
  }

  textual('og', 'OG title', a.og?.title ?? '', b.og?.title ?? '');
  textual('og', 'OG description', a.og?.description ?? '', b.og?.description ?? '');
  if (watched.has('og') && canonicalKey(a.og?.image ?? '') !== canonicalKey(b.og?.image ?? '')) {
    changes.push({ line: `OG image: ${bare(text(a.og?.image))} → ${bare(text(b.og?.image))}` });
  }

  if (!changes.length) return { changed: false, detail: 'No watched SEO signal changed.' };
  const ordered = [...changes.filter((change) => change.urgent), ...changes.filter((change) => !change.urgent)];
  return { changed: true, detail: clip(ordered.map((change) => change.line).join('; '), 1000) };
}

/**
 * Alternates compared as a set of language → URL, so the order the page lists
 * them in does not matter. URLs are compared as canonicals are.
 */
function hreflangChange(before: SeoFacts['hreflang'], after: SeoFacts['hreflang']): string {
  const index = (entries: SeoFacts['hreflang']) => {
    const out = new Map<string, string[]>();
    for (const entry of entries ?? []) {
      const lang = text(entry.lang).toLowerCase();
      if (lang) out.set(lang, [...(out.get(lang) ?? []), text(entry.href)]);
    }
    return out;
  };
  const key = (hrefs: string[] | undefined) => (hrefs ?? []).map(canonicalKey).sort().join(' ');
  const was = index(before);
  const is = index(after);
  const parts: string[] = [];
  for (const lang of [...new Set([...was.keys(), ...is.keys()])].sort()) {
    if (!was.has(lang)) parts.push(`${lang} added`);
    else if (!is.has(lang)) parts.push(`${lang} removed`);
    else if (key(was.get(lang)) !== key(is.get(lang))) {
      parts.push(`${lang} ${bare(was.get(lang)!.join(' '))} → ${bare(is.get(lang)!.join(' '))}`);
    }
  }
  if (!parts.length) return '';
  const shown = parts.slice(0, 6).join(', ');
  return `Hreflang: ${shown}${parts.length > 6 ? `, and ${parts.length - 6} more` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* Showing                                                                     */
/* -------------------------------------------------------------------------- */

/** A capture's signals as label/value pairs, for the signals a rule watches. */
export function describeSeo(seo: SeoFacts, selector = ''): Array<{ label: string; value: string }> {
  const watched = new Set(decodeSeoSignals(selector));
  const rows: Array<{ id: SeoSignalId; label: string; value: string }> = [];
  const state = robots(seo, typeof seo.robots_header === 'string');
  const header = text(seo.robots_header ?? '');
  rows.push(
    { id: 'status', label: 'HTTP status', value: seo.status === null ? 'not available' : String(seo.status) },
    {
      id: 'robots',
      label: 'Robots',
      value: `${state.noindex ? 'noindex' : 'index'}, ${state.nofollow ? 'nofollow' : 'follow'}${header ? ` · X-Robots-Tag: ${clip(header, 60)}` : ''}`,
    },
    { id: 'canonical', label: 'Canonical', value: bare(text(seo.canonical)) },
    { id: 'title', label: 'Title', value: text(seo.title) || 'none' },
    { id: 'description', label: 'Meta description', value: text(seo.description) || 'none' },
    { id: 'h1', label: 'H1', value: `${text(seo.h1) || 'none'} · ${seo.h1_count} on the page` },
    {
      id: 'hreflang',
      label: 'Hreflang',
      value: seo.hreflang?.length
        ? clip(seo.hreflang.map((entry) => entry.lang).join(', '), 120)
        : 'none',
    },
    { id: 'og', label: 'OG title', value: text(seo.og?.title) || 'none' },
    { id: 'og', label: 'OG description', value: text(seo.og?.description) || 'none' },
    { id: 'og', label: 'OG image', value: bare(text(seo.og?.image)) },
  );
  return rows.filter((row) => watched.has(row.id)).map(({ label, value }) => ({ label, value }));
}
