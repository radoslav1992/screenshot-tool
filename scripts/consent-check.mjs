/**
 * Drives the real consent dismissal against pages shaped like the ones that
 * broke it.
 *
 *   node scripts/consent-check.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const source = readFileSync(new URL('../src/lib/actions.ts', import.meta.url), 'utf8');
// The module imports `badRequest`; only the page-side half is needed here.
const start = source.indexOf('export const CONSENT_SELECTORS');
const body = transformSync(source.slice(start), { loader: 'ts' }).code.replace(/^export\s+/gm, '');

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
const cases = [];
const check = (name, actual, expected) =>
  cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

const run = async (html) => {
  await page.setContent(`<!doctype html><body>${html}</body>`);
  await page.addScriptTag({ content: body });
  return page.evaluate(() => {
    const clicked = dismissConsentInPage(CONSENT_SELECTORS, CONSENT_TEXTS);
    return { clicked, bannerGone: !document.querySelector('#banner[data-open="1"]') };
  });
};

const banner = (label) =>
  `<div id="banner" data-open="1">We use cookies.
     <button onclick="document.getElementById('banner').removeAttribute('data-open')">${label}</button>
     <button>Reject all</button>
   </div>`;

// A big marketing page: hundreds of links, banner appended last — the shape
// that silently failed on stripe.com/pricing.
const manyLinks = Array.from({ length: 600 }, (_, i) => `<a href="#x${i}">Link ${i}</a>`).join('');

check('banner after 600 links is still found', (await run(manyLinks + banner('Accept all'))).bannerGone, true);
check('a small page still works', (await run(banner('Accept all'))).bannerGone, true);
check('"Accept all cookies" matches', (await run(banner('Accept all cookies'))).bannerGone, true);
check('"I accept" matches', (await run(banner('I accept'))).bannerGone, true);
check(
  'a policy link is not mistaken for consent',
  (await run('<a href="/terms">Accept our terms of service and privacy policy</a>')).clicked,
  null,
);
check(
  'a hidden leftover dialog is skipped',
  (await run('<div style="display:none"><button>Accept all</button></div>' + banner('Accept all'))).bannerGone,
  true,
);

/*
 * Several consent vendors mount the dialog in a shadow root so the host page's
 * CSS cannot restyle it. Nothing in the light DOM refers to it, so a search that
 * does not cross the boundary finds an empty page and reports success.
 */
await page.setContent('<!doctype html><body><div id="host"></div></body>');
await page.evaluate(() => {
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML =
    '<div id="cmp" style="width:600px;height:120px">We use cookies.' +
    '<button style="width:120px;height:40px">Accept all</button></div>';
  root.querySelector('button').addEventListener('click', () => {
    document.body.dataset.consented = '1';
  });
});
await page.addScriptTag({ content: body });
check(
  'a banner inside a shadow root is found',
  await page.evaluate(() => {
    dismissConsentInPage(CONSENT_SELECTORS, CONSENT_TEXTS);
    return document.body.dataset.consented ?? null;
  }),
  '1',
);

await browser.close();
let failures = 0;
for (const c of cases) {
  if (!c.ok) failures++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  → got ${JSON.stringify(c.actual)}`}`);
}
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${cases.length} checks passed`);
process.exit(failures ? 1 : 0);
