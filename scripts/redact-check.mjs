/**
 * Drives the real redaction function against markup with known contents.
 *
 * This one edits the DOM of someone else's page moments before the shutter, so
 * the failure modes are ugly in both directions: leaving a stranger's email in
 * a shared file, or blanking a page the customer wanted to see. Running the
 * shipped function in a real browser is the only way to know which it did.
 *
 *   node scripts/redact-check.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const source = readFileSync(new URL('../src/lib/redact-fn.ts', import.meta.url), 'utf8');
const body = transformSync(source, { loader: 'ts' }).code.replace(/^export\s+/gm, '');

const PAGE = `
  <header class="cookie-banner">We use cookies</header>
  <main>
    <p id="intro">Contact ada@example.com or call +359 88 123 4567.</p>
    <p id="card">Card on file: 4111 1111 1111 1111</p>
    <p id="safe">The plan costs 1999 leva and launched in 2019.</p>
    <aside class="sidebar">Private notes</aside>
  </main>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();

const run = async (options) => {
  await page.setContent(`<!doctype html><body>${PAGE}</body>`);
  await page.addScriptTag({ content: body });
  return page.evaluate(
    ([opts, patterns]) => {
      const result = redactInPage(opts, patterns);
      return {
        result,
        introText: document.getElementById('intro').textContent,
        safeText: document.getElementById('safe').textContent,
        cardText: document.getElementById('card').textContent,
        bannerDisplay: getComputedStyle(document.querySelector('.cookie-banner')).display,
        sidebarFilter: getComputedStyle(document.querySelector('.sidebar')).filter,
      };
    },
    [options, JSON.parse(readFileSyncPatterns)],
  );
};

// The patterns are data in the module; read them out of the transpiled source
// so the test cannot drift from what ships.
const readFileSyncPatterns = JSON.stringify(
  await (async () => {
    const { transformSync: t } = await import('esbuild');
    const mod = t(source, { loader: 'ts', format: 'esm' }).code;
    const url = 'data:text/javascript;base64,' + Buffer.from(mod).toString('base64');
    return (await import(url)).PII_PATTERNS;
  })(),
);

const cases = [];
const check = (name, actual, expected) =>
  cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

const hidden = await run({ hide: ['.cookie-banner'], blur: [], redactPii: false });
check('hide removes the node from layout', hidden.bannerDisplay, 'none');
check('hide counts what it hid', hidden.result.hidden, 1);
check('untouched text stays intact', hidden.introText.includes('ada@example.com'), true);

const blurred = await run({ hide: [], blur: ['.sidebar'], redactPii: false });
check('blur applies a filter', blurred.sidebarFilter.startsWith('blur('), true);

const redacted = await run({ hide: [], blur: [], redactPii: true });
check('the email is gone from the text', redacted.introText.includes('ada@example.com'), false);
check('the phone number is gone', redacted.introText.includes('88 123 4567'), false);
check('the card number is gone', redacted.cardText.includes('4111'), false);
check('a price and a year survive', redacted.safeText, 'The plan costs 1999 leva and launched in 2019.');
check('surrounding words survive', redacted.introText.includes('Contact'), true);
check('it counts what it covered', redacted.result.redacted >= 3, true);

const missing = await run({ hide: ['.does-not-exist'], blur: [], redactPii: false });
check('a selector matching nothing is reported', missing.result.unmatched, ['.does-not-exist']);

const invalid = await run({ hide: ['<<not a selector'], blur: [], redactPii: false });
check('an invalid selector does not throw', invalid.result.unmatched.length, 1);

await browser.close();

let failures = 0;
for (const c of cases) {
  if (!c.ok) failures++;
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`,
  );
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
