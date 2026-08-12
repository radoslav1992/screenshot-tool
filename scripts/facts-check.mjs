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

let failures = 0;
for (const c of cases) {
  if (!c.ok) failures++;
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`,
  );
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
