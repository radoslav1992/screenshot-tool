/**
 * Drives the real page-side comparison against known image pairs.
 *
 * The pixel maths is the part of a watch that decides whether a customer gets an
 * email, and it runs somewhere awkward to reach — inside a Browser Rendering
 * page. This runs the exact same function in local Chromium against images whose
 * answer is known in advance, so a change to the algorithm has to keep agreeing
 * with arithmetic rather than with a screenshot nobody re-checks.
 *
 *   node scripts/diff-check.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// The function under test is TypeScript. esbuild strips the types, so the
// browser runs the same code the Worker ships rather than a transcription of it.
const source = readFileSync(new URL('../src/lib/visual-diff-fn.ts', import.meta.url), 'utf8');
// No module format: a classic script leaves the declarations global, which is
// what page.evaluate needs. The `export` keywords go, the code does not.
const body = transformSync(source, { loader: 'ts' }).code.replace(/^export\s+/gm, '');

const cases = [
  { name: 'identical', mutate: () => {}, expect: (r) => r.changedPct === 0 && !r.resized },
  {
    name: 'one tenth painted over',
    mutate: (ctx, w, h) => ctx.fillRect(0, 0, w, Math.round(h / 10)),
    expect: (r) => Math.abs(r.changedPct - 10) < 1.5 && !r.resized,
  },
  {
    name: 'half painted over',
    mutate: (ctx, w, h) => ctx.fillRect(0, 0, w, Math.round(h / 2)),
    expect: (r) => Math.abs(r.changedPct - 50) < 1.5,
  },
  {
    // Two renders of an unchanged page differ slightly from compression and
    // antialiasing. A five-point shift must not read as a change.
    name: 'shift below tolerance ignored',
    flat: true,
    mutate: (ctx, w, h) => {
      ctx.fillStyle = 'rgb(250,250,250)'; // 5 from the white base, tolerance is 12
      ctx.fillRect(0, 0, w, h);
    },
    expect: (r) => r.changedPct === 0,
  },
  {
    // The same shift, but past the tolerance, has to be seen.
    name: 'shift above tolerance counted',
    flat: true,
    mutate: (ctx, w, h) => {
      ctx.fillStyle = 'rgb(200,200,200)'; // 55 from the base
      ctx.fillRect(0, 0, w, h);
    },
    expect: (r) => r.changedPct === 100,
  },
  { name: 'taller page', resize: true, expect: (r) => r.resized === true },
];

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: body });

let failures = 0;

for (const testCase of cases) {
  const result = await page.evaluate(
    async ({ mutateSource, resize, flat }) => {
      const W = 400;
      const H = 400;

      const base = (height) => {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, height);
        // Something to compare that is not flat colour, unless the case is
        // about the tolerance itself, where stripes would drown the signal.
        if (!flat) {
          ctx.fillStyle = '#333';
          for (let y = 0; y < height; y += 20) ctx.fillRect(10, y, W - 20, 8);
        }
        return { canvas, ctx };
      };

      const before = base(H);
      const after = base(resize ? H * 2 : H);
      if (!resize) {
        after.ctx.fillStyle = '#000';
        // eslint-disable-next-line no-new-func
        new Function('ctx', 'w', 'h', `(${mutateSource})(ctx, w, h)`)(after.ctx, W, H);
      }

      return await compareInPage(before.canvas.toDataURL(), after.canvas.toDataURL(), 12, 2_000_000);
    },
    {
      mutateSource: (testCase.mutate ?? (() => {})).toString(),
      resize: Boolean(testCase.resize),
      flat: Boolean(testCase.flat),
    },
  );

  const ok = testCase.expect(result);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${testCase.name.padEnd(38)} changed=${result.changedPct.toFixed(2)}% resized=${result.resized}`,
  );
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
