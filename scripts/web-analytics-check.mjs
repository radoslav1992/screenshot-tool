/**
 * Cloudflare Web Analytics (src/lib/web-analytics.ts): the beacon renders only
 * with a well-formed site token, never on a page whose address carries a
 * secret or belongs to an agency's client, from the one layout every page
 * uses, and the privacy page says which way it is.
 *
 *   node --experimental-strip-types scripts/web-analytics-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const { BEACON_SRC, WEB_ANALYTICS_TOKEN, beaconToken, measuredPage, webAnalyticsEnabled } = await import(
  join(root, 'src/lib/web-analytics.ts')
);

const passed = [];
const section = (name, fn) => {
  fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};
const at = (path) => new URL(path, 'https://easyscreencapture.com');
const TOKEN = '0123456789abcdef0123456789abcdef';

section('a token turns it on; empty or malformed keeps it off everywhere', () => {
  assert.equal(beaconToken(at('/pricing'), TOKEN), TOKEN);
  assert.equal(beaconToken(at('/pricing'), TOKEN.toUpperCase()), TOKEN.toUpperCase());
  for (const bad of ['', 'abc', `${TOKEN}0`, `${TOKEN.slice(0, 31)}g`, ' ' + TOKEN, '"></script><script>alert(1)</script>']) {
    assert.equal(beaconToken(at('/pricing'), bad), null, JSON.stringify(bad));
    assert.equal(webAnalyticsEnabled(bad), false);
  }
  assert.equal(webAnalyticsEnabled(TOKEN), true);
  assert.equal(webAnalyticsEnabled(WEB_ANALYTICS_TOKEN), /^[0-9a-f]{32}$/i.test(WEB_ANALYTICS_TOKEN));
  assert.equal(BEACON_SRC, 'https://static.cloudflareinsights.com/beacon.min.js');
});

section('public pages and the workspace are measured', () => {
  for (const path of ['/', '/pricing', '/features', '/tools/full-page-screenshot', '/client-sign-off?ref=report', '/login?next=/app', '/signup?src=tool-seo', '/app', '/app/watches/w_abc', '/sample-report', '/docs#api']) {
    assert.equal(measuredPage(at(path)), true, path);
  }
});

section('addresses that carry a secret, and clients’ pages, never are', () => {
  for (const path of [
    '/r/' + 'a'.repeat(64),
    '/R/' + 'a'.repeat(64),
    '/r/' + 'a'.repeat(64) + '/0',
    '/care/' + 'b'.repeat(64),
    '/f/cap_1/shot.png?t=secret',
    '/join/ab12cd',
    '/app/invite?token=x',
    '/app/invite',
    '/reset-password?token=x',
    '/reset-password',
    '/verify?token=x',
    '/verify',
    '/pricing?token=x',
    '/app/c/cap_1?t=x',
    '/anything?code=x',
    '/anything?key=x',
  ]) {
    assert.equal(measuredPage(at(path)), false, path);
    assert.equal(beaconToken(at(path), TOKEN), null, path);
  }
  // A prefix match is a path segment match: /reports or /careers would be measured.
  assert.equal(measuredPage(at('/careers')), true);
  assert.equal(measuredPage(at('/rss.xml')), true);
});

section('the one layout every page uses renders the beacon, and nothing else does', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(astro|ts|tsx|mjs|js)$/.test(name)) files.push(path);
    }
  };
  walk(join(root, 'src'));
  // Pages and layouts are .astro; .ts files that mention <head parse other sites' HTML or build PDFs.
  const heads = files.filter((file) => file.endsWith('.astro') && /<head(>|\s)/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(heads.map((file) => file.slice(root.length)), ['src/layouts/Base.astro'], 'only Base renders <head>');
  const beacons = files.filter((file) => readFileSync(file, 'utf8').includes('cloudflareinsights'));
  assert.deepEqual(beacons.map((file) => file.slice(root.length)), ['src/lib/web-analytics.ts'], 'the beacon address lives in one place');

  const base = readFileSync(join(root, 'src/layouts/Base.astro'), 'utf8');
  assert.match(base, /const analyticsToken = beaconToken\(Astro\.url\);/);
  assert.match(base, /analyticsToken && \(\s*<script\s+is:inline\s+type="module"\s+src=\{BEACON_SRC\}\s+data-cf-beacon=\{JSON\.stringify\(\{ token: analyticsToken \}\)\}/);
  assert.ok(base.indexOf('analyticsToken &&') < base.indexOf('</head>'), 'in the head');
});

section('the privacy page says which way it is', () => {
  const privacy = readFileSync(join(root, 'src/pages/privacy.astro'), 'utf8');
  assert.match(privacy, /const analytics = webAnalyticsEnabled\(\);/);
  assert.match(privacy, /analytics\s*\?\s*'We count visits with Cloudflare Web Analytics/);
  assert.match(privacy, /It uses no cookies or local storage and nothing that identifies you or follows you to other sites\./);
  assert.match(privacy, /Review links, care reports, file links, invitations and other pages whose address carries a private link are never measured\./);
  assert.match(privacy, /: 'We do not run analytics, advertising or third-party trackers/);
  assert.doesNotMatch(privacy, /cookies or trackers/, 'no sentence the beacon would make untrue');
});

section('the service worker leaves the beacon alone', () => {
  const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
  assert.match(sw, /if \(url\.origin !== self\.location\.origin\) return;/);
});

console.log(
  `\nWeb analytics checks passed (${passed.length}): token gate, measured and never-measured pages, one layout and one beacon address, the privacy text and the service worker.`,
);
