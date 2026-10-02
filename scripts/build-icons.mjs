#!/usr/bin/env node
/** Regenerate all served icons from the shared vector master: npm run icons. */
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("brand/mark.svg", root), "utf8");
await writeFile(new URL("public/icons/icon.svg", root), source);
await writeFile(new URL("public/icons/favicon.svg", root), source);
for (const [name, size, inset] of [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.2],
  ["apple-touch-icon.png", 180, 0.12],
]) {
  // The opaque square fills platform masks. Inset keeps the camera inside
  // the maskable icon's central safe circle; Apple applies its own corners.
  const art = inset
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#FB7515"/><g transform="translate(${64 * inset} ${64 * inset}) scale(${1 - 2 * inset})">${source.replace(/<svg[^>]*>|<\/svg>/g, "")}</g></svg>`
    : source;
  await sharp(Buffer.from(art))
    .resize(size, size)
    .png()
    .toFile(new URL(`public/icons/${name}`, root).pathname);
  console.log(`${name}: ${size} × ${size}`);
}
