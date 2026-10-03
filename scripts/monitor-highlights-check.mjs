/**
 * Highlighted changes and pinned baselines.
 *
 * The region clustering runs in local Chromium, exactly as it runs in the
 * comparison browser. The check flow runs against SQLite twice — without
 * migration 0014, as production does until it is applied, and with it — and
 * every external service is mocked. No network calls, no real alerts.
 *
 *   node --experimental-strip-types scripts/monitor-highlights-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build, transformSync } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeRunChanges, decodeRunDetail, encodeRunDetail, runLabel } from '../src/lib/monitor-health.ts';

/* -------------------------------------------------------------------------- */
/* Regions and the highlighted copy, in a real browser                         */
/* -------------------------------------------------------------------------- */

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const source = readFileSync(new URL('../src/lib/visual-diff-fn.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts' }).code.replace(/^export\s+/gm, '');
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: script });

/** A striped 400 px wide page before and after, each painted by a snippet, compared as a monitor would. */
const compare = (spec) =>
  page.evaluate(async ({ beforeH = 400, afterH = 400, paintBefore = '', paintAfter = '', region, highlight }) => {
    const make = (height, paint) => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 400, height);
      ctx.fillStyle = '#333';
      for (let y = 0; y < height; y += 20) ctx.fillRect(10, y, 380, 8);
      // eslint-disable-next-line no-new-func
      new Function('ctx', paint)(ctx);
      return canvas.toDataURL();
    };
    const result = await compareInPage(make(beforeH, paintBefore), make(afterH, paintAfter), 12, 2_000_000, region, highlight, 8);
    if (!result.highlight) return result;
    // Read the highlight back: its size, and whether the first box is drawn in brand orange.
    const image = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = result.highlight;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const box = result.regions[0];
    const x = Math.round((box.x + box.w / 2) * canvas.width);
    const top = Math.round(box.y * canvas.height);
    let orange = false;
    for (let y = Math.max(0, top - 2); y <= top + 4; y++) {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r > 200 && g > 70 && g < 170 && b < 100) orange = true;
    }
    return { ...result, highlightSize: [image.naturalWidth, image.naturalHeight], orange };
  }, spec);

const W = 400;
/** The box holds the painted rectangle and fits it, give or take a pixel of rounding. */
const holds = (box, x, y, w, h, height = 400) =>
  box.x <= x / W + 1e-4 &&
  box.y <= y / height + 1e-4 &&
  box.x + box.w >= (x + w) / W - 1e-4 &&
  box.y + box.h >= (y + h) / height - 1e-4 &&
  box.w <= (w + 2) / W &&
  box.h <= (h + 2) / height;
const red = (rects) => `ctx.fillStyle='#e0312b';${rects.map((r) => `ctx.fillRect(${r.join(',')});`).join('')}`;

try {
  let r = await compare({ paintAfter: red([[20, 20, 60, 40], [300, 300, 50, 50]]) });
  assert.equal(r.regions.length, 2, 'two separate changes are two boxes');
  assert.ok(holds(r.regions[0], 20, 20, 60, 40) && holds(r.regions[1], 300, 300, 50, 50), JSON.stringify(r.regions));
  assert.ok(r.regions.every((box) => [box.x, box.y, box.w, box.h].every((n) => n >= 0 && n <= 1)), 'normalised to the after image');

  r = await compare({ paintAfter: red([[20, 20, 60, 40], [20, 70, 60, 30]]) });
  assert.equal(r.regions.length, 1, 'changes a few pixels apart merge into one box');

  // An ignore region is painted into both captures by the renderer, so what
  // changes beneath it never differs — for the percentage or for a box.
  const mask = "ctx.fillStyle='#20251e';ctx.fillRect(100,100,200,200);";
  r = await compare({ paintBefore: mask, paintAfter: red([[120, 120, 100, 100]]) + mask });
  assert.deepEqual([r.changedPct, r.regions], [0, []], 'a change under an ignore region produces no box');
  r = await compare({ paintBefore: mask, paintAfter: red([[120, 120, 100, 100], [10, 350, 30, 30]]) + mask });
  assert.equal(r.regions.length, 1);
  assert.ok(holds(r.regions[0], 10, 350, 30, 30), 'only the change outside the ignored area is boxed');
  assert.ok(r.regions[0].y > 0.75, 'nothing points into the ignored area');

  r = await compare({ afterH: 800 });
  assert.deepEqual(r.regions, [{ x: 0, y: 0.5, w: 1, h: 0.5 }], 'the area a taller page added is a box');
  r = await compare({ afterH: 800, paintAfter: red([[20, 20, 40, 40]]) });
  assert.equal(r.regions.length, 2, 'the added area and a change above it are separate boxes');
  r = await compare({ beforeH: 800 });
  assert.equal(r.regions.length, 1);
  assert.ok(Math.abs(r.regions[0].y + r.regions[0].h - 1) < 1e-3 && r.regions[0].h < 0.1 && r.regions[0].w === 1,
    `a page that lost height gets a band along its new bottom edge (${JSON.stringify(r.regions)})`);

  const dots = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) dots.push([15 + i * 55, 15 + j * 55, 4, 4]);
  r = await compare({ paintAfter: red(dots) });
  assert.ok(r.regions.length >= 1 && r.regions.length <= 8, `49 scattered changes fit in at most 8 boxes (got ${r.regions.length})`);
  for (const [x, y, w, h] of dots) {
    const e = 1e-4;
    assert.ok(r.regions.some((box) => box.x <= x / W + e && box.y <= y / W + e && box.x + box.w >= (x + w) / W - e && box.y + box.h >= (y + h) / W - e),
      `the dot at ${x},${y} is inside a box`);
  }

  r = await compare({ paintAfter: red([[250, 50, 40, 40], [50, 50, 40, 40]]), region: { x: 200, y: 0, width: 200, height: 400 } });
  assert.equal(r.regions.length, 1, 'a change outside the watched region is not boxed');
  assert.ok(holds(r.regions[0], 250, 50, 40, 40), 'boxes inside a watched region are placed on the whole after image');

  const highlight = { minPct: 1, maxWidth: 200, maxPixels: 1_000_000, maxChars: 2_000_000 };
  r = await compare({ paintAfter: red([[0, 0, 400, 40]]), highlight });
  assert.match(r.highlight ?? '', /^data:image\/jpeg;base64,/, 'a change past the threshold gets a highlighted copy');
  assert.deepEqual(r.highlightSize, [200, 200], 'downscaled to the maximum width');
  assert.ok(r.orange, 'the box is drawn in brand orange');
  r = await compare({ paintAfter: red([[0, 0, 400, 40]]), highlight: { ...highlight, minPct: 50 } });
  assert.equal(r.highlight, undefined, 'none below the threshold');
  assert.equal(r.regions.length, 1, 'though the regions are still reported');
  r = await compare({ paintAfter: red([[200, 200, 1, 1]]), highlight: { ...highlight, minPct: 0 } });
  assert.ok(r.highlight, 'any detected change is drawn when the threshold is 0');
  r = await compare({ paintAfter: red([[0, 0, 400, 40]]), highlight: { ...highlight, maxChars: 100 } });
  assert.equal(r.highlight, undefined, 'a copy past the size limit is left out, not sent');
  r = await compare({ highlight: { ...highlight, minPct: 0 } });
  assert.deepEqual([r.regions, r.highlight], [[], undefined], 'identical pages have no boxes and no highlight');
} finally {
  await browser.close();
}
console.log('Region checks passed: separate and nearby changes, ignore regions, added and removed height, the box cap, watched regions, and the bounded highlight.');

/* -------------------------------------------------------------------------- */
/* Run metadata                                                                */
/* -------------------------------------------------------------------------- */

const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
const stored = encodeRunDetail('<0.01% changed · Any detected change was enabled for this check.', { email: 'accepted', webhook: 'disabled' }, { regions: [box], highlight: true });
assert.equal(decodeRunDetail(stored).detail.startsWith('<0.01%'), true, 'the API detail stays the human string the app reads');
assert.deepEqual(decodeRunChanges(stored), { regions: [box], highlight: true, pinned: false, repeat: false });
assert.equal(encodeRunDetail('x', { email: 'disabled', webhook: 'disabled' }), 'esc-run-v1:{"message":"x","delivery":{"email":"disabled","webhook":"disabled"}}', 'runs without changes store exactly what they did');
assert.deepEqual(decodeRunChanges('esc-run-v1:{"regions":[{"x":2,"y":0,"w":1,"h":1},{"x":0,"y":0,"w":0.5,"h":"1"},{"x":0.5,"y":0.5,"w":0.9,"h":0.9}]}').regions,
  [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }], 'stored boxes are checked and clipped to the image');
assert.deepEqual(decodeRunChanges('legacy text'), { regions: [], highlight: false, pinned: false, repeat: false });
assert.equal(runLabel({ status: 'done', changed: 0, baseline_capture_id: 'b', change_pct: 12, repeat: true }), 'No new change');

/* -------------------------------------------------------------------------- */
/* The check flow, with and without migration 0014                             */
/* -------------------------------------------------------------------------- */

const MIGRATIONS = ['0001_init.sql', '0002_verification_and_retention.sql', '0003_billing.sql', '0004_watches.sql', '0005_page_facts.sql', '0008_monitor_noise.sql', '0009_monitor_workflows.sql'];
function database(withPin) {
  const db = new DatabaseSync(':memory:');
  for (const file of [...MIGRATIONS, ...(withPin ? ['0014_pinned_baseline.sql'] : [])]) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const now = new Date().toISOString();
  for (const id of ['owner', 'other']) {
    db.prepare(`INSERT INTO users (id,email,email_lower,name,plan,period_start,created_at,updated_at) VALUES (?,?,?,'Pilot','pro',?,?,?)`)
      .run(id, `${id}@example.test`, `${id}@example.test`, now, now, now);
  }
  return db;
}

const JPEG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64');
const state = {
  db: null, changedPct: 20, changedPixels: 1, regions: [{ x: 0, y: 0, w: 0.5, h: 0.1 }, { x: 0.2, y: 0.6, w: 0.3, h: 0.2 }],
  previous: null, lastCompare: null, compares: 0, facts: null, mails: [], hooks: [], hookOk: true, puts: new Map(), deletes: [],
};
let captureCount = 0;
const bind = (sql, args = []) => ({
  sql, args,
  bind: (...next) => bind(sql, next),
  first: async () => state.db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: state.db.prepare(sql).all(...args) }),
  run: async () => ({ meta: state.db.prepare(sql).run(...args) }),
});
const batch = async (queries) => {
  state.db.exec('BEGIN');
  try {
    const results = queries.map((query) => ({ meta: state.db.prepare(query.sql).run(...query.args) }));
    state.db.exec('COMMIT');
    return results;
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  }
};
const fileOf = (row) => JSON.parse(row.files)[0];
globalThis.__highlightFixture = {
  state,
  env: {
    DB: { prepare: (sql) => bind(sql), batch },
    SHOTS: {
      put: async (key, bytes, options) => { state.puts.set(key, { bytes, options }); },
      delete: async (keys) => { state.deletes.push(...[keys].flat()); },
    },
  },
  captures: {
    getUsage: async () => ({ remaining: 1000 }),
    createCaptureRow: async (user, options) => {
      const id = `cap-${++captureCount}`;
      state.db.prepare(
        `INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,source,share_token,files,created_at,duration_ms,facts)
         VALUES (?,?,?,'example.test','desktop',1440,900,'fullpage','png','done','watch',?,?,?,900,?)`,
      ).run(id, user.id, options.url, `tok-${id}`, JSON.stringify([{ name: 'capture.png', key: `captures/${user.id}/${id}/capture.png`, width: 1440, height: 900, bytes: 10 }]),
        new Date().toISOString(), state.facts ? JSON.stringify(state.facts) : null);
      return state.db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    },
    runCapture: async (row) => row,
    fileUrl: (row, file, origin) => `${origin}/f/${row.id}/${file.name}?t=${row.share_token}`,
    safeParseFiles: (raw) => { try { const files = JSON.parse(raw); return Array.isArray(files) ? files : []; } catch { return []; } },
  },
};
/** Every external service mocked; `captures.ts` too, unless it is the module under test. */
const services = ({ realCaptures = false } = {}) => ({
  name: 'external-services',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const env = globalThis.__highlightFixture.env;' }));
    if (!realCaptures) {
      b.onLoad({ filter: /\/lib\/captures\.ts$/ }, () => ({
        contents: 'export const {getUsage,createCaptureRow,runCapture,fileUrl,safeParseFiles} = globalThis.__highlightFixture.captures;',
      }));
    }
    // Mirrors the page: a highlight only when the change met the threshold, `previous` only when asked for.
    b.onLoad({ filter: /\/lib\/visual-diff\.ts$/ }, () => ({
      contents: `export function diffAvailable(){return true}
        export async function compareImages(before, after, region, options = {}) {
          const s = globalThis.__highlightFixture.state; s.compares++; s.lastCompare = { before, after, options };
          const met = options.highlight === 0 ? s.changedPixels > 0 : s.changedPct >= options.highlight;
          return { changedPct: s.changedPct, changedPixels: s.changedPixels, sharedPct: s.changedPct, resized: false, width: 1440, height: 900,
            regions: s.changedPixels ? s.regions : [], ...(met && s.changedPixels ? { highlight: '${JPEG}' } : {}),
            ...(options.previous && s.previous ? { previous: s.previous } : {}) };
        }`,
    }));
    b.onLoad({ filter: /\/lib\/mailer\.ts$/ }, () => ({
      contents: 'export function canSendEmail(){return true} export async function sendMail(mail){globalThis.__highlightFixture.state.mails.push(mail);return true}',
    }));
    b.onLoad({ filter: /\/lib\/summarise\.ts$/ }, () => ({ contents: 'export async function summariseChange(){return {sentence:"",detail:"",source:"plain"}}' }));
    b.onLoad({ filter: /\/lib\/renderer\.ts$/ }, () => ({ contents: 'export async function render(){throw new Error("no renderer in tests")}' }));
  },
});
const plugin = services();
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  state.hooks.push({ url, body: JSON.parse(options.body) });
  return new Response('', { status: state.hookOk ? 200 : 500 });
};

const directory = mkdtempSync(join(tmpdir(), 'monitor-highlights-'));
const ORIGIN = 'https://fixture.test';
try {
  for (const [name, entry] of [['watches', 'src/lib/watches.ts'], ['route', 'src/pages/api/watches/[id].ts'], ['pin', 'src/lib/baseline-pin.ts']]) {
    await build({ entryPoints: [new URL(`../${entry}`, import.meta.url).pathname], outfile: join(directory, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', plugins: [plugin] });
  }
  /** A fresh module instance per database, so each probe cache starts empty, as a new isolate's would. */
  const load = async (phase) => ({
    watches: await import(`${pathToFileURL(join(directory, 'watches.mjs'))}?${phase}`),
    route: await import(`${pathToFileURL(join(directory, 'route.mjs'))}?${phase}`),
  });
  const owner = { id: 'owner', plan: 'pro', email: 'owner@example.test' };
  const options = { url: 'https://example.test/', host: 'example.test', device: 'desktop', width: 1440, height: 900, scale: 1, mode: 'fullpage', format: 'png', hide: [], ignoreRegions: [] };
  const create = (watches, extra = {}) => watches.createWatch(owner, { options: { ...options, url: `https://example.test/${Math.random()}` }, label: 'Pricing', frequency: 'daily', threshold: 1, notifyEmail: true, webhookUrl: 'https://hooks.example.test/x', ...extra });
  const post = (route, id, body, user = owner) => route.POST({
    request: new Request(`${ORIGIN}/api/watches/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    params: { id }, locals: { user },
  });
  const get = (route, id) => route.GET({ params: { id }, locals: { user: owner }, url: new URL(`${ORIGIN}/api/watches/${id}`) });
  const latestRun = (id) => state.db.prepare('SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(id);
  const fresh = (watches, id) => watches.getWatch(id);

  /* ---------------------------- without 0014 ---------------------------- */
  state.db = database(false);
  let { watches, route } = await load('without-0014');
  let watch = await create(watches);
  await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  const first = (await fresh(watches, watch.id)).baseline_capture_id;
  let outcome = await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  assert.equal(outcome.changed, true);
  let row = await fresh(watches, watch.id);
  assert.notEqual(row.baseline_capture_id, first, 'without the migration the baseline moves exactly as before');
  assert.equal(watches.toWatchDTO(row).baseline_pinned, false);
  assert.equal(watches.toWatchDTO(row).baseline_pinned_at, null);
  for (const action of ['pin', 'unpin']) {
    const response = await post(route, watch.id, { action });
    assert.equal(response.status, 503, `${action} waits for the migration`);
    assert.equal((await response.json()).error.type, 'setup_required');
  }

  // Highlights need no migration: the regions ride in the run metadata.
  const after = row.baseline_capture_id;
  const highlightKey = `captures/owner/${after}/changes.jpg`;
  assert.ok(state.puts.has(highlightKey), 'the highlight is stored beside the capture');
  assert.equal(state.puts.get(highlightKey).options.httpMetadata.contentType, 'image/jpeg');
  const highlightLink = `${ORIGIN}/f/${after}/changes.jpg?t=tok-${after}`;
  const mail = state.mails.at(-1);
  assert.match(mail.text, /Changed areas: 2\n/, 'the alert email counts the changed areas');
  assert.ok(mail.text.includes(`Changes highlighted: ${highlightLink}\n`), 'and links the highlighted image');
  assert.doesNotMatch(mail.text, /pinned/);
  const hook = state.hooks.at(-1).body;
  assert.equal(hook.highlight_url, highlightLink, 'the webhook carries highlight_url');
  assert.deepEqual(hook.regions, state.regions, 'and the regions');
  assert.equal(hook.event, 'watch.changed');
  let response = await get(route, watch.id);
  let payload = await response.json();
  const changedRun = payload.runs.find((run) => run.changed === 1);
  assert.equal(changedRun.highlight_url, highlightLink, 'the API run links the highlight');
  assert.deepEqual(changedRun.regions, state.regions, 'and lists the regions');
  assert.ok(payload.runs.every((run) => Array.isArray(run.regions) && !('highlight' in run)), 'every run has regions; the internal flag stays internal');
  assert.ok(payload.runs.every((run) => typeof run.id === 'string' && Number.isInteger(run.changed) && typeof run.created_at === 'string'), 'runs keep the shape the app decodes');
  assert.ok(payload.runs.every((run) => !run.detail?.startsWith('esc-run-v1:')), 'detail stays a human string');
  assert.equal(payload.runs.find((run) => !run.baseline_capture_id).highlight_url, null);
  assert.equal(payload.baseline_pinned, false);

  // Below the threshold: the regions are kept, but nothing is drawn or sent.
  const putsBefore = state.puts.size;
  state.changedPct = 0.5;
  outcome = await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  assert.equal(outcome.changed, false);
  assert.equal(state.puts.size, putsBefore, 'no highlight below the threshold');
  assert.deepEqual(decodeRunChanges(latestRun(watch.id).detail).regions, state.regions);
  state.changedPct = 20;

  // A retried alert keeps the regions and still links the highlight.
  state.hookOk = false;
  await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  const retried = latestRun(watch.id);
  assert.equal(decodeRunDetail(retried.detail).delivery.webhook, 'failed');
  state.db.prepare("UPDATE alert_retries SET next_attempt_at='2000-01-01' WHERE run_id=?").run(retried.id);
  state.hookOk = true;
  await watches.retryAlerts(ORIGIN);
  assert.equal(decodeRunDetail(latestRun(watch.id).detail).delivery.webhook, 'accepted');
  assert.deepEqual(decodeRunChanges(latestRun(watch.id).detail), { regions: state.regions, highlight: true, pinned: false, repeat: false }, 'a retry keeps the metadata');
  assert.equal(state.hooks.at(-1).body.highlight_url, `${ORIGIN}/f/${retried.capture_id}/changes.jpg?t=tok-${retried.capture_id}`);
  console.log('Without 0014 passed: baselines move as before, pin and unpin answer setup_required, highlights stored and linked from email, webhook, API runs and retries.');

  /* ----------------------------- with 0014 ------------------------------ */
  state.db = database(true);
  ({ watches, route } = await load('with-0014'));
  state.mails.length = 0;
  watch = await create(watches);
  response = await post(route, watch.id, { action: 'pin' });
  assert.equal(response.status, 409, 'nothing to pin before the first check');
  assert.equal((await response.json()).error.type, 'no_baseline');
  await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  state.changedPct = 0;
  state.changedPixels = 0;
  await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  const pinnedId = (await fresh(watches, watch.id)).baseline_capture_id;

  response = await post(route, watch.id, { action: 'pin' });
  assert.equal(response.status, 200);
  let dto = await response.json();
  assert.deepEqual([dto.baseline_pinned, dto.baseline_capture_id], [true, pinnedId], 'pin keeps the current baseline');
  assert.ok(!Number.isNaN(Date.parse(dto.baseline_pinned_at)));
  assert.ok(['id', 'label', 'url', 'display_url', 'device', 'frequency', 'status', 'next_run_at'].every((key) => typeof dto[key] === 'string'), 'pin answers with a Monitor');

  const pinnedUrl = `${ORIGIN}/f/${pinnedId}/capture.png?t=tok-${pinnedId}`;
  const mails = () => state.mails.length;
  const check = async () => {
    const result = await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
    return { result, run: latestRun(watch.id), row: await fresh(watches, watch.id) };
  };

  // The page moves away from the pinned version: the first check alerts.
  Object.assign(state, { changedPct: 20, changedPixels: 1, previous: null });
  let step = await check();
  assert.equal(step.result.changed, true, 'the first difference from the pinned baseline alerts');
  assert.equal(state.lastCompare.before, pinnedUrl, 'compared against the pinned capture');
  assert.equal(state.lastCompare.options.previous, undefined, 'a fresh difference needs no second comparison');
  assert.equal(step.row.baseline_capture_id, pinnedId, 'a pinned baseline is never replaced');
  assert.equal(mails(), 1);
  assert.match(state.mails.at(-1).text, /\(your pinned baseline\)/);
  assert.equal(decodeRunChanges(step.run.detail).pinned, true);
  const firstAlert = step.run.capture_id;
  const lastChanged = step.row.last_changed_at;

  // Still the same difference: recorded, not announced.
  state.previous = { changedPct: 0, changedPixels: 0, resized: false };
  step = await check();
  assert.equal(state.lastCompare.options.previous, `${ORIGIN}/f/${firstAlert}/capture.png?t=tok-${firstAlert}`, 'measured against the version last alerted about');
  assert.equal(step.result.changed, false, 'an unchanged difference does not alert again');
  assert.equal(mails(), 1);
  assert.equal(step.run.changed, 0);
  assert.equal(step.run.change_pct, 20, 'the difference from the pinned baseline is still recorded');
  assert.match(decodeRunDetail(step.run.detail).detail, /no new alert was sent\.$/);
  assert.deepEqual(decodeRunChanges(step.run.detail), { regions: state.regions, highlight: true, pinned: true, repeat: true }, 'with its regions and highlight');
  assert.equal(runLabel({ ...step.run, ...decodeRunChanges(step.run.detail) }), 'No new change');
  assert.equal(step.row.baseline_capture_id, pinnedId);
  assert.equal(step.row.last_changed_at, lastChanged, 'a repeat is not a new change');
  step = await check();
  assert.equal(mails(), 1, 'nor on the check after');
  assert.ok(state.lastCompare.options.previous.includes(firstAlert), 'still against the last alert, not the last check');

  // It changes again on top: alert, and that becomes the version to compare with.
  state.previous = { changedPct: 30, changedPixels: 1, resized: false };
  step = await check();
  assert.equal(step.result.changed, true, 'a new change since the last alert alerts');
  assert.equal(mails(), 2);
  const secondAlert = step.run.capture_id;
  state.previous = { changedPct: 0, changedPixels: 0, resized: false };
  step = await check();
  assert.ok(state.lastCompare.options.previous.includes(secondAlert));
  assert.equal(mails(), 2);

  // Back to the pinned version, then away again: that is fresh news.
  Object.assign(state, { changedPct: 0, changedPixels: 0 });
  step = await check();
  assert.equal(step.result.changed, false);
  assert.equal(decodeRunChanges(step.run.detail).repeat, false, 'matching the pin is not a repeat');
  Object.assign(state, { changedPct: 20, changedPixels: 1 });
  step = await check();
  assert.equal(state.lastCompare.options.previous, undefined);
  assert.equal(step.result.changed, true, 'moving away again after matching alerts afresh');
  assert.equal(mails(), 3);

  // A failed second comparison cannot tell, so it alerts rather than staying quiet.
  state.previous = null;
  step = await check();
  assert.ok(state.lastCompare.options.previous, 'the second comparison was asked for');
  assert.equal(step.result.changed, true, 'no answer from it counts as moved');
  assert.equal(mails(), 4);

  // Text rules follow the same rule, compared by their own facts.
  const text = await create(watches, { rule: { kind: 'text', phrase: '', selector: '', region: '' } });
  state.facts = { text: 'Plan A', text_hash: 'a', text_length: 6 };
  await watches.runWatch(await fresh(watches, text.id), ORIGIN);
  assert.equal((await post(route, text.id, { action: 'pin' })).status, 200);
  const comparesBefore = state.compares;
  state.facts = { text: 'Plan B', text_hash: 'b', text_length: 6 };
  assert.equal((await watches.runWatch(await fresh(watches, text.id), ORIGIN)).changed, true);
  assert.equal((await watches.runWatch(await fresh(watches, text.id), ORIGIN)).changed, false, 'the same text change is not announced twice');
  assert.match(decodeRunDetail(latestRun(text.id).detail).detail, /^The page text changed\. Unchanged since the last alert/);
  state.facts = { text: 'Plan C', text_hash: 'c', text_length: 6 };
  assert.equal((await watches.runWatch(await fresh(watches, text.id), ORIGIN)).changed, true, 'a further text change is');
  assert.equal(state.compares, comparesBefore, 'text rules never open the comparison browser');
  state.facts = null;

  // Pin a specific earlier capture, and the checks on what may be pinned.
  const history = state.db.prepare("SELECT capture_id FROM watch_runs WHERE watch_id = ? AND capture_id IS NOT NULL ORDER BY created_at, rowid").all(watch.id);
  const earlier = history[0].capture_id;
  response = await post(route, watch.id, { action: 'pin', capture_id: earlier });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).baseline_capture_id, earlier, 'an earlier capture of this monitor can be pinned');
  const elsewhere = latestRun(text.id).capture_id;
  for (const [capture_id, why] of [[elsewhere, "another monitor's capture"], ['cap-missing', 'a capture that does not exist']]) {
    response = await post(route, watch.id, { action: 'pin', capture_id });
    assert.equal(response.status, 404, why);
  }
  state.db.prepare(`INSERT INTO captures (id,user_id,url,host,device,width,height,mode,format,status,source,share_token,files,created_at)
    VALUES ('cap-theirs','other','https://example.test/','example.test','desktop',1440,900,'fullpage','png','done','watch','t','[]',?)`).run(new Date().toISOString());
  state.db.prepare("UPDATE watch_runs SET capture_id='cap-theirs' WHERE id=?").run(latestRun(text.id).id);
  assert.equal((await post(route, text.id, { action: 'pin', capture_id: 'cap-theirs' })).status, 404, "someone else's capture, even one a run names");
  state.db.prepare("UPDATE captures SET files='[]' WHERE id=?").run(history[1].capture_id);
  response = await post(route, watch.id, { action: 'pin', capture_id: history[1].capture_id });
  assert.equal(response.status, 400, 'a capture without files cannot be pinned');
  assert.equal((await response.json()).error.type, 'invalid_request');
  assert.equal((await post(route, watch.id, { action: 'pin' }, { id: 'other', plan: 'pro' })).status, 404, "someone else's monitor");
  assert.equal((await fresh(watches, watch.id)).baseline_capture_id, earlier, 'refused pins change nothing');

  // A pin or unpin made while a check runs holds against the check's write.
  const stale = await fresh(watches, watch.id);
  response = await post(route, watch.id, { action: 'unpin' });
  dto = await response.json();
  assert.deepEqual([response.status, dto.baseline_pinned, dto.baseline_pinned_at], [200, false, null]);
  await watches.runWatch(stale, ORIGIN);
  row = await fresh(watches, watch.id);
  assert.equal(row.baseline_capture_id, latestRun(watch.id).capture_id, 'unpinned during the check: the new capture becomes the baseline');
  const unpinnedStale = await fresh(watches, watch.id);
  await post(route, watch.id, { action: 'pin' });
  const kept = (await fresh(watches, watch.id)).baseline_capture_id;
  await watches.runWatch(unpinnedStale, ORIGIN);
  row = await fresh(watches, watch.id);
  assert.deepEqual([row.baseline_capture_id, Boolean(row.baseline_pinned_at)], [kept, true], 'pinned during the check: the pin holds');
  await post(route, watch.id, { action: 'unpin' });
  await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  assert.equal((await fresh(watches, watch.id)).baseline_capture_id, latestRun(watch.id).capture_id, 'unpinned, each check replaces the baseline again');

  // A pin whose capture has gone is let go rather than leaving the monitor stuck.
  await post(route, watch.id, { action: 'pin' });
  state.db.prepare('DELETE FROM captures WHERE id = ?').run((await fresh(watches, watch.id)).baseline_capture_id);
  outcome = await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  row = await fresh(watches, watch.id);
  assert.equal(outcome.detail, 'first check — saved as the baseline');
  assert.deepEqual([row.baseline_capture_id, row.baseline_pinned_at], [latestRun(watch.id).capture_id, null]);

  // The monitor list and detail carry the pin.
  await post(route, watch.id, { action: 'pin' });
  payload = await (await get(route, watch.id)).json();
  assert.equal(payload.baseline_pinned, true);
  assert.ok(payload.runs.some((run) => run.highlight_url), 'highlight URLs with the migration too');

  // A capture engine change that reaches a pinned baseline (engine 2 reaches
  // phones; an unmarked file is engine 1) refreshes it and releases the pin:
  // keeping the new capture pinned would approve a version nobody looked at.
  state.db.prepare("UPDATE captures SET device = 'mobile' WHERE id = ?").run((await fresh(watches, watch.id)).baseline_capture_id);
  const mailsBeforeRefresh = state.mails.length;
  outcome = await watches.runWatch(await fresh(watches, watch.id), ORIGIN);
  row = await fresh(watches, watch.id);
  assert.equal(outcome.changed, false, 'a refresh never alerts');
  assert.match(outcome.detail, /^Baseline refreshed after a capture engine update\. The pinned baseline was released/);
  assert.deepEqual([row.baseline_capture_id, row.baseline_pinned_at], [latestRun(watch.id).capture_id, null], 'the new capture is the baseline, unpinned');
  assert.equal(state.mails.length, mailsBeforeRefresh, 'no email for a refresh');
  // And a capture the engine has moved past cannot be pinned in the first place.
  state.db.prepare("UPDATE captures SET device = 'mobile' WHERE id = ?").run(row.baseline_capture_id);
  response = await post(route, watch.id, { action: 'pin' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, 'baseline_outdated');
  assert.equal((await fresh(watches, watch.id)).baseline_pinned_at, null);
  state.db.prepare("UPDATE captures SET device = 'desktop' WHERE id = ?").run(row.baseline_capture_id);
  assert.equal((await post(route, watch.id, { action: 'pin' })).status, 200, 'a current capture pins again');

  console.log('With 0014 passed: pin and unpin, pinned checks never replace the baseline, repeat alerts suppressed until the page moves again, text rules, capture validation, pins made mid-check, lost pins, and pins released by an engine refresh.');

  /* ------------------------- deletion and retention ------------------------ */
  await build({ entryPoints: [new URL('../src/lib/captures.ts', import.meta.url).pathname], outfile: join(directory, 'captures.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [services({ realCaptures: true })] });
  const captures = await import(pathToFileURL(join(directory, 'captures.mjs')));
  const pinnedRow = state.db.prepare('SELECT * FROM captures WHERE id = ?').get((await fresh(watches, watch.id)).baseline_capture_id);
  const dtoImages = captures.toDTO(pinnedRow, ORIGIN);
  assert.deepEqual(dtoImages.images, [`${ORIGIN}/f/${pinnedRow.id}/capture.png?t=${pinnedRow.share_token}`], 'images are the capture files only, never the highlight');
  assert.ok(dtoImages.files.every((file) => file.name !== 'changes.jpg'));
  await assert.rejects(captures.deleteCapture(pinnedRow), (error) => error.type === 'baseline_in_use' && /pinned baseline/.test(error.message), 'the pinned capture cannot be deleted');
  const loose = state.db.prepare(
    "SELECT * FROM captures WHERE source = 'watch' AND user_id = 'owner' AND files <> '[]' AND id NOT IN (SELECT baseline_capture_id FROM watches WHERE baseline_capture_id IS NOT NULL) LIMIT 1",
  ).get();
  state.deletes.length = 0;
  await captures.deleteCapture(loose);
  assert.deepEqual(state.deletes.sort(), [`captures/owner/${loose.id}/capture.png`, `captures/owner/${loose.id}/changes.jpg`].sort(), 'deleting a monitor capture deletes its highlight');
  state.deletes.length = 0;
  await captures.deleteCapture({ ...loose, id: 'cap-app', source: 'app', files: JSON.stringify([{ key: 'captures/owner/cap-app/capture.png', name: 'capture.png' }]) });
  assert.deepEqual(state.deletes, ['captures/owner/cap-app/capture.png'], 'other captures have no highlight to delete');

  await build({ entryPoints: [new URL('../src/lib/retention.ts', import.meta.url).pathname], outfile: join(directory, 'retention.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [plugin] });
  const { sweepExpiredCaptures } = await import(pathToFileURL(join(directory, 'retention.mjs')));
  state.db.exec(`ALTER TABLE users ADD COLUMN apple_expires_at TEXT; UPDATE captures SET created_at = '2020-01-01T00:00:00.000Z'; UPDATE users SET plan = 'free';`);
  state.db.exec(`CREATE TABLE IF NOT EXISTS email_verifications (expires_at TEXT, used_at TEXT); CREATE TABLE IF NOT EXISTS sessions (expires_at TEXT);`);
  state.deletes.length = 0;
  for (let i = 0; i < 6; i++) await sweepExpiredCaptures();
  const left = state.db.prepare('SELECT id FROM captures').all().map((c) => c.id);
  assert.ok(left.includes(pinnedRow.id), 'retention never sweeps the pinned baseline');
  const swept = state.deletes.filter((key) => key.endsWith('/changes.jpg'));
  assert.ok(swept.length > 0 && swept.every((key) => !key.includes(pinnedRow.id)), 'swept monitor captures take their highlights with them');
  console.log('Deletion and retention passed: images exclude the highlight, the pinned capture is kept by deleteCapture and retention, and highlights are deleted with their captures.');
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.__highlightFixture;
  rmSync(directory, { recursive: true, force: true });
}
