/**
 * Drives the real full-page capture against a page that reveals as you scroll.
 *
 * Chrome's own `fullPage: true` stitches the image from a short viewport, which
 * is exactly wrong for a site whose sections fade in on entry and back out on
 * exit: the capture walks down the page, the reveals fire, and then it returns
 * to the top — putting every section away again — before the stitch begins. The
 * result is a tall image of empty sections, black on a dark site. That was a
 * real report from a real customer's site, so the fix is checked the same way it
 * failed: on a page built to behave that badly, running the shipped function.
 *
 *   node scripts/fullpage-check.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { build } from 'esbuild';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SECTIONS = 8;
const VIEW = { width: 1280, height: 800 };

/*
 * Sections taller than the viewport, invisible until an IntersectionObserver
 * says otherwise — and invisible again the moment they leave. On a dark
 * background an unrevealed section is indistinguishable from nothing.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>reveal</title>
<style>
  body { margin: 0; background: #05060a; }
  section { height: 700px; display: grid; place-items: center;
            opacity: 0; transform: translateY(40px); transition: opacity .6s, transform .6s; }
  section.on { opacity: 1; transform: none; }
  b { width: 900px; height: 400px; background: #7c5cff; border-radius: 24px; }
</style>
${Array.from({ length: SECTIONS }, () => '<section><b></b></section>').join('\n')}
<script>
  const io = new IntersectionObserver(
    (entries) => { for (const e of entries) e.target.classList.toggle('on', e.isIntersecting); },
    { threshold: 0.15 },
  );
  document.querySelectorAll('section').forEach((s) => io.observe(s));
</script>`;

/**
 * The function under test lives in the renderer, which imports Worker-only
 * modules. Bundling with those stubbed gets the shipped code into Node without
 * a transcription of it standing in.
 */
async function loadRenderer() {
  const stubs = {
    // Bindings the renderer reads at request time; none of them on this path.
    'cloudflare:workers': 'export const env = {};',
    // The pool owns the real browser. This check brings its own.
    'browser-pool': `export const acquireBrowser = () => { throw new Error('not used'); };
                     export const releaseBrowser = () => {};`,
    // Only reachable through the Browser Rendering binding, which is not here.
    '@cloudflare/puppeteer': 'export default {};',
  };
  const stub = {
    name: 'stub-worker-imports',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:|^@cloudflare\/puppeteer$|browser-pool$/ }, (args) => ({
        path: args.path.startsWith('@') ? args.path : args.path.replace(/^.*\//, ''),
        namespace: 'stub',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubs[args.path],
        loader: 'js',
      }));
    },
  };
  const result = await build({
    entryPoints: [new URL('../src/lib/renderer.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [stub],
  });
  const code = result.outputFiles[0].text;
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * Puppeteer's page, spelled in Playwright.
 *
 * The renderer talks to `@cloudflare/puppeteer`; local Chromium is driven by
 * Playwright. Only the handful of calls the function under test makes need
 * translating, and translating them is cheaper than shipping a second browser.
 */
function asPuppeteerPage(page) {
  return {
    setViewport: (v) => page.setViewportSize({ width: v.width, height: v.height }),
    evaluate: (fn, ...args) => page.evaluate(fn, ...args),
    screenshot: (opts) => page.screenshot({ fullPage: Boolean(opts?.fullPage) }),
  };
}

/** Share of the image that is not the page's black background. */
async function inkPct(measurer, png) {
  return await measurer.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 24 || data[i + 1] > 24 || data[i + 2] > 24) ink++;
    }
    return { w: img.width, h: img.height, pct: (100 * ink) / (img.width * img.height) };
  }, `data:image/png;base64,${png.toString('base64')}`);
}

/** Mirrors the renderer's scroll pass: down in viewport steps, then back up. */
async function autoScroll(page, step) {
  await page.evaluate(
    async (stepSize) =>
      await new Promise((resolve) => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, stepSize);
          total += stepSize;
          if (total >= document.body.scrollHeight || total > 40_000) {
            clearInterval(timer);
            resolve();
          }
        }, 120);
      }),
    step,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
}

const { captureTallViewport } = await loadRenderer();

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const measurer = await browser.newPage();

async function open() {
  const page = await browser.newPage({ viewport: VIEW });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({
    content:
      `*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;` +
      `transition-duration:0s !important;transition-delay:0s !important}` +
      `html{scroll-behavior:auto !important}`,
  });
  await autoScroll(page, VIEW.height);
  return page;
}

// What the renderer used to do.
const stitchPage = await open();
const stitched = await inkPct(measurer, await stitchPage.screenshot({ fullPage: true }));

// What it does now.
const tallPage = await open();
const shot = await captureTallViewport(
  asPuppeteerPage(tallPage),
  { width: VIEW.width, height: VIEW.height, scale: 1, mobile: false },
  {},
);
const tall = await inkPct(measurer, Buffer.from(shot.data));

await browser.close();
server.close();

const show = (label, r) => `${label.padEnd(22)}${r.w}x${r.h}  content ${r.pct.toFixed(2)}%`;
console.log(show('stitched (the bug)', stitched));
console.log(show('tall viewport', tall));

/*
 * Each section holds a 900x400 block on a 1280-wide page, so a shot with every
 * section revealed is a little under 40% ink. The stitched shot only ever holds
 * the one section that happened to be on screen.
 */
const checks = [
  ['every section is captured, not just the first', tall.pct > 30],
  ['the stitched capture is the one that loses content', stitched.pct < 10],
  ['the reported height matches the image', Math.abs(shot.height - tall.h) <= 1],
  ['the whole document is in frame', tall.h >= SECTIONS * 700],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
