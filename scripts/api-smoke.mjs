#!/usr/bin/env node
/*
 * End-to-end check of the public API.
 *
 *   KEY=sk_live_… npm run api:smoke
 *   KEY=sk_live_… BASE=http://localhost:4321 npm run api:smoke
 *
 * Runs the whole surface against a real deployment and reports pass or fail per
 * step. It spends a handful of captures from the key's quota and deletes the
 * ones it creates.
 *
 * The checks that matter are the ones a caller would notice: that a frame lands
 * on its exact advertised pixels, that a deleted capture's files really go, and
 * that the failure paths fail the documented way. Those are read out of the
 * responses rather than trusted.
 */

const BASE = (process.env.BASE ?? 'https://easyscreencapture.com').replace(/\/$/, '');
const KEY = process.env.KEY;

/** The page to capture. Override to point at something you control. */
const TARGET = process.env.TARGET ?? 'https://example.com';

if (!KEY) {
  console.error('\n  KEY is not set.\n\n    KEY=sk_live_… npm run api:smoke\n');
  process.exit(1);
}

const auth = { authorization: `Bearer ${KEY}` };
let passed = 0;
let failed = 0;
const created = [];

function report(name, ok, detail) {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, true, detail);
    return true;
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}

function form(fields) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Reads width and height straight out of a PNG's IHDR chunk. */
function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(buffer.subarray(0, 8).equals(signature), 'not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* -------------------------------------------------------------------------- */

console.log(`\n  Easy Screen Capture — API smoke test\n  ${BASE}  capturing ${TARGET}\n`);

// Cheapest call there is, and it proves the key before anything spends quota.
let account;
const authOk = await check('GET /v1/account authenticates', async () => {
  const { status, body } = await api('/v1/account');
  if (status === 401) throw new Error('key rejected — wrong, revoked, or from another environment');
  if (status === 403) throw new Error(`${body?.error?.message ?? 'forbidden'}`);
  assert(status === 200, `expected 200, got ${status}`);
  account = body;
  return `${body.plan}, ${body.usage.used}/${body.usage.quota} used`;
});

if (!authOk) {
  console.log('\n  Nothing else can run without a working key.\n');
  process.exit(1);
}

await check('rate-limit headers present', async () => {
  const { headers } = await api('/v1/account');
  const limit = headers.get('x-ratelimit-limit');
  assert(limit, 'no x-ratelimit-limit header');
  return `${headers.get('x-ratelimit-remaining')}/${limit} left this minute`;
});

let visible;
await check('POST /v1/capture renders a desktop screenshot', async () => {
  const { status, body } = await api('/v1/capture', form({ url: TARGET, device: 'desktop' }));
  assert(status === 201, `expected 201, got ${status}: ${body?.error?.message ?? ''}`);
  assert(body.status === 'done', `status came back ${body.status}: ${body.error ?? ''}`);
  assert(body.images?.length === 1, `expected 1 image, got ${body.images?.length}`);
  visible = body;
  created.push(body.id);
  return `${body.id} in ${body.duration_ms}ms`;
});

if (visible) {
  await check('the file is a real PNG at the viewport size', async () => {
    const response = await fetch(visible.images[0]);
    assert(response.ok, `file fetch returned ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const { width, height } = pngSize(buffer);
    const expected = visible.viewport.width * visible.viewport.scale;
    assert(width === expected, `expected ${expected}px wide, got ${width}`);
    return `${width}×${height}, ${(buffer.length / 1024).toFixed(0)} KB`;
  });
}

// The distinctive feature: a named frame has to land on exact pixels, or the
// whole "no cropping afterwards" promise is false.
await check('an output frame lands on its exact advertised size', async () => {
  const { status, body } = await api('/v1/capture', form({ url: TARGET, device: 'instagram-story' }));
  assert(status === 201, `expected 201, got ${status}: ${body?.error?.message ?? ''}`);
  created.push(body.id);
  const response = await fetch(body.images[0]);
  const { width, height } = pngSize(Buffer.from(await response.arrayBuffer()));
  assert(width === 1080 && height === 1920, `expected 1080×1920, got ${width}×${height}`);
  return '1080×1920';
});

await check('GET /v1/captures lists what was just made', async () => {
  const { status, body } = await api('/v1/captures');
  assert(status === 200, `expected 200, got ${status}`);
  const ids = (body.data ?? []).map((capture) => capture.id);
  for (const id of created) assert(ids.includes(id), `${id} missing from the list`);
  return `${ids.length} returned`;
});

await check('GET /v1/captures/:id fetches one', async () => {
  const { status, body } = await api(`/v1/captures/${created[0]}`);
  assert(status === 200, `expected 200, got ${status}`);
  assert(body.id === created[0], 'wrong capture came back');
  return body.id;
});

/* ---- the failure paths, which are what an integrator actually hits ---- */

await check('an unknown key is rejected', async () => {
  const response = await fetch(`${BASE}/v1/account`, { headers: { authorization: 'Bearer sk_live_definitelynot' } });
  assert(response.status === 401, `expected 401, got ${response.status}`);
  return '401';
});

await check('a private address is refused', async () => {
  const { status, body } = await api('/v1/capture', form({ url: 'http://192.168.1.1/admin' }));
  assert(status === 400, `expected 400, got ${status}`);
  return body?.error?.type ?? '400';
});

await check('pdf with series is refused', async () => {
  const { status, body } = await api('/v1/capture', form({ url: TARGET, mode: 'series', format: 'pdf' }));
  assert(status === 400, `expected 400, got ${status}`);
  return body?.error?.type ?? '400';
});

await check('a missing url is refused', async () => {
  const { status, body } = await api('/v1/capture', form({ device: 'desktop' }));
  assert(status === 400, `expected 400, got ${status}`);
  return body?.error?.param ?? '400';
});

/* ---- deleting has to take the files with it, not just the row ---- */

if (visible) {
  await check('DELETE removes the capture and its files', async () => {
    const { status } = await api(`/v1/captures/${visible.id}`, { method: 'DELETE' });
    assert(status === 200 || status === 204, `expected 200/204, got ${status}`);
    created.splice(created.indexOf(visible.id), 1);

    const gone = await api(`/v1/captures/${visible.id}`);
    assert(gone.status === 404, `the capture still reads back as ${gone.status}`);

    const file = await fetch(visible.images[0]);
    assert(file.status === 404, `the file is still served (${file.status})`);
    return 'row and file both gone';
  });
}

// Leave the account as it was found.
for (const id of created) await api(`/v1/captures/${id}`, { method: 'DELETE' }).catch(() => undefined);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
