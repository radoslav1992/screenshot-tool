#!/usr/bin/env node
/*
 * Regenerates the served app icons from brand/logo.png.
 *
 *   npm run icons
 *
 * Run it whenever the master artwork changes. Chromium does the resampling
 * because it is already here for capturing screenshots; there is no image
 * library in the dependency tree and this is not worth adding one for.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const src = fs.readFileSync(`${ROOT}/brand/logo.png`).toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });

// `inset` leaves breathing room; the maskable icon needs its art inside the
// safe circle, so it gets more.
const render = async (size, inset, round) =>
  page.evaluate(async ([data, size, inset, round]) => {
    const img = new Image();
    img.src = data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    // The artwork is centred in a landscape frame; take the middle square.
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;

    // Rounded for the icons shown as-is; square for the maskable one, which
    // must fill its whole square, and for Apple, which applies its own mask.
    if (round) {
      const r = size * 0.22;
      ctx.beginPath();
      ctx.roundRect(0, 0, size, size, r);
      ctx.clip();
    }

    // Paint the ground first so the glow has something to sit on and the icon
    // is never transparent — a transparent app icon shows the launcher through.
    ctx.fillStyle = '#0B0D08';
    ctx.fillRect(0, 0, size, size);

    const pad = size * inset;
    ctx.drawImage(img, sx, sy, side, side, pad, pad, size - 2 * pad, size - 2 * pad);
    return c.toDataURL('image/png');
  }, [`data:image/png;base64,${src}`, size, inset, round]);

for (const [out, size, inset, round] of [
  ['public/icons/icon-192.png', 192, 0, true],
  ['public/icons/icon-512.png', 512, 0, true],
  ['public/icons/icon-maskable-512.png', 512, 0.10, false],
  ['public/icons/apple-touch-icon.png', 180, 0, false],
]) {
  const url = await render(size, inset, round);
  fs.writeFileSync(`${ROOT}/${out}`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(' ', out, size, `${fs.statSync(`${ROOT}/${out}`).size} B`);
}
await browser.close();
