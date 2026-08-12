/**
 * Checks the derived half of page facts against markup whose answer is known.
 *
 * These functions are pure string-in/value-out, which is the whole reason they
 * were kept that way: no browser, no network, no fixtures on disk.
 *
 *   node scripts/facts-check.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/lib/page-facts.ts', import.meta.url), 'utf8');
// The module imports a type only, which esbuild erases; what remains is
// self-contained and can be imported directly.
const js = transformSync(source, { loader: 'ts', format: 'esm' }).code;
const dir = mkdtempSync(join(tmpdir(), 'facts-'));
const file = join(dir, 'page-facts.mjs');
writeFileSync(file, js);

const { visibleText, wordCount, schemaTypes, detectStack, deriveA11y, deriveWeight } = await import(file);

const load = async (name) => {
  const out = join(dir, `${name}.mjs`);
  writeFileSync(
    out,
    transformSync(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'esm',
    }).code,
  );
  return import(out);
};

const { diffText, toLines, describeChange } = await load('text-diff');
const { PII_PATTERNS } = await load('redact-fn');
const { parseSitemap } = await load('sitemap');
const { webhookFlavour, webhookBody } = await load('chat-webhook');

const cases = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, ok, actual, expected });
};

check('visibleText drops script and style', visibleText('<style>a{}</style><p>Hello <b>there</b></p><script>x()</script>'), 'Hello there');
check('wordCount counts visible words only', wordCount('<script>one two three</script><p>four five</p>'), 2);
check('wordCount of an empty document', wordCount('<html></html>'), 0);

const ld = `<script type="application/ld+json">{"@type":"Organization","name":"X"}</script>
<script type="application/ld+json">{"@graph":[{"@type":["Article","NewsArticle"]}]}</script>`;
check('schemaTypes reads @type and @graph', schemaTypes(ld).sort(), ['Article', 'NewsArticle', 'Organization']);
check('schemaTypes survives malformed JSON', schemaTypes('<script type="application/ld+json">{oops</script>'), []);

check('detectStack finds WordPress', detectStack('<link href="/wp-content/x.css">').cms, 'WordPress');
check('detectStack finds Next.js', detectStack('<script src="/_next/static/x.js"></script>').framework, 'Next.js');
check(
  'detectStack does not call Astro a CMS',
  (() => {
    const s = detectStack('<meta name="generator" content="Astro v5"><div data-astro-cid-x></div>');
    return [s.cms, s.framework];
  })(),
  ['none', 'Astro'],
);
check(
  'detectStack spots a single-page app',
  detectStack('<html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>').is_spa,
  true,
);
check(
  'a content-heavy page is not a single-page app',
  detectStack(`<html><body><div id="root"><p>${'word '.repeat(200)}</p></div><script src="/b.js"></script></body></html>`).is_spa,
  false,
);

check('a11y alt coverage', deriveA11y('<img alt="a"><img alt="b"><img><img>').img_alt_coverage, 0.5);
check('a11y with no images', deriveA11y('<p>none</p>').img_alt_coverage, null);
check(
  'a11y ignores hidden and submit inputs',
  deriveA11y('<input type="hidden"><input type="submit"><input id="a"><input>').form_label_coverage,
  0.5,
);

check('weight counts the document plus its references', deriveWeight('<script src="a.js"></script><img src="b.png">').request_count, 3);
check('weight in KB', deriveWeight('x'.repeat(2048)).page_weight_kb, 2);

/* ---------------------------------------------------------------- */
/* What changed, in words                                            */
/* ---------------------------------------------------------------- */

check('toLines splits on sentence ends', toLines('One thing. Two things. Three.'), ['One thing.', 'Two things.', 'Three.']);
check(
  'diffText finds the price that moved',
  (() => {
    const d = diffText('Pro costs $19 a month. Free trial for 14 days.', 'Pro costs $29 a month. Free trial for 14 days.');
    return [d.added, d.removed];
  })(),
  [['Pro costs $29 a month.'], ['Pro costs $19 a month.']],
);
check(
  'reordering is not a change',
  (() => {
    const d = diffText('Alpha here. Beta here.', 'Beta here. Alpha here.');
    return [d.added.length, d.removed.length];
  })(),
  [0, 0],
);
check('identical text yields nothing', diffText('Same words here.', 'Same words here.').added.length, 0);
check('an empty side is not comparable', diffText('', 'Something new.').comparable, false);
check(
  'describeChange quotes both directions',
  describeChange(diffText('Old line here.', 'New line here.')).includes('+ New line here.'),
  true,
);

/* ---------------------------------------------------------------- */
/* Redaction patterns                                                */
/* ---------------------------------------------------------------- */

const matches = (name, text) => {
  const p = PII_PATTERNS.find((entry) => entry.name === name);
  return new RegExp(p.source, p.flags).test(text);
};

check('email is caught', matches('email', 'write to ada.lovelace+x@example.co.uk please'), true);
check('card number is caught', matches('card', 'pay with 4111 1111 1111 1111 now'), true);
check('international phone is caught', matches('phone', 'call +359 88 123 4567 today'), true);
check('IBAN is caught', matches('iban', 'BG80BNBG96611020345678 is the account'), true);
check('a price is not a card number', matches('card', 'it costs 1999 dollars'), false);
check('a year is not a phone number', matches('phone', 'founded in 2019 by two people'), false);
check('a plain word is not an email', matches('email', 'the at sign is missing here'), false);

/* ---------------------------------------------------------------- */
/* Sitemaps                                                          */
/* ---------------------------------------------------------------- */

const urlset = `<?xml version="1.0"?><urlset><url><loc>https://a.example/one</loc></url><url><loc>https://a.example/two</loc></url></urlset>`;
const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.example/sitemap-1.xml</loc></sitemap></sitemapindex>`;

check('a urlset yields pages', parseSitemap(urlset).pages, ['https://a.example/one', 'https://a.example/two']);
check('a urlset yields no indexes', parseSitemap(urlset).indexes, []);
check('an index yields children, not pages', parseSitemap(index), { pages: [], indexes: ['https://a.example/sitemap-1.xml'] });
check('whitespace inside loc is trimmed', parseSitemap('<urlset><url><loc>\n  https://a.example/x\n</loc></url></urlset>').pages, ['https://a.example/x']);
check('an empty document yields nothing', parseSitemap('<urlset></urlset>').pages, []);

/* ---------------------------------------------------------------- */
/* Chat webhooks                                                     */
/* ---------------------------------------------------------------- */

check('slack is recognised', webhookFlavour('https://hooks.slack.com/services/T/B/x'), 'slack');
check('discord is recognised', webhookFlavour('https://discord.com/api/webhooks/1/x'), 'discord');
check('anything else stays JSON', webhookFlavour('https://hooks.zapier.com/x'), 'json');
check('a broken URL stays JSON', webhookFlavour('not a url'), 'json');
check(
  'a lookalike host is not slack',
  webhookFlavour('https://hooks.slack.com.evil.example/x'),
  'json',
);

const notice = {
  name: 'Competitor pricing',
  url: 'https://example.com/pricing',
  changePct: 4.2,
  summary: 'The Pro price went from $19 to $29.',
  beforeUrl: 'https://esc/a.png',
  afterUrl: 'https://esc/b.png',
  watchUrl: 'https://esc/app/watches/wat_1',
};

check('slack body leads with the summary', webhookBody('slack', notice).text.includes('$19 to $29'), true);
check('discord body uses markdown links', webhookBody('discord', notice).content.includes('[before](https://esc/a.png)'), true);
check('json body keeps the fields', webhookBody('json', notice).event, 'watch.changed');
check(
  'without a summary the percentage carries the message',
  webhookBody('slack', { ...notice, summary: null }).text.includes('4.2%'),
  true,
);

let failures = 0;
for (const c of cases) {
  if (!c.ok) failures++;
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`,
  );
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
