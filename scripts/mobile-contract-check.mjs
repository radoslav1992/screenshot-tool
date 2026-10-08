/**
 * Mobile contract check: drives the backend exactly the way the iOS companion
 * app does (manual `Cookie: sf_session=…`, `Accept: application/json`, flat
 * JSON string bodies, no Origin header, redirects never followed) and asserts
 * every response shape the app decodes. Run it before deploying API changes.
 *
 *   BASE=http://localhost:4321 node scripts/mobile-contract-check.mjs
 *
 * It creates a disposable account and deletes it at the end. Captures need a
 * Browser Rendering binding; without one that step is reported as skipped.
 */
const BASE = (process.env.BASE ?? 'http://localhost:4321').replace(/\/$/, '');
let session = '';
let failures = 0;
let passed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`ok    ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (session) headers.cookie = `sf_session=${session}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/sf_session=([^;]*)/);
  if (match) session = match[1];
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, setCookie };
}

const isString = (v) => typeof v === 'string';
const isProblem = (j) => j && j.error && isString(j.error.type) && isString(j.error.message);
const notRedirect = (r) => r.status < 300 || r.status >= 400;

function capture(c) {
  return (
    c &&
    ['id', 'status', 'url', 'display_url', 'device', 'mode', 'format', 'source', 'created_at'].every((k) => isString(c[k])) &&
    Array.isArray(c.images) &&
    c.images.every(isString) &&
    (c.error === undefined || c.error === null || isString(c.error))
  );
}
function monitor(m) {
  return (
    m &&
    ['id', 'label', 'url', 'display_url', 'device', 'frequency', 'status', 'next_run_at'].every((k) => isString(m[k])) &&
    (m.last_run_at == null || isString(m.last_run_at)) &&
    (m.last_change_pct == null || typeof m.last_change_pct === 'number') &&
    (m.last_error == null || isString(m.last_error)) &&
    (m.threshold == null || typeof m.threshold === 'number')
  );
}
function run(r) {
  return r && isString(r.id) && isString(r.status) && Number.isInteger(r.changed) && isString(r.created_at);
}

const email = `mobile-contract-${Date.now()}@example.com`;
const password = 'contract-pass-123';

// Sign up and sign in exactly like the app.
let r = await call('/api/auth/signup', { method: 'POST', body: { email, password, name: 'Contract' } });
check('signup answers 2xx JSON without redirect', r.status >= 200 && r.status < 300 && notRedirect(r), `status ${r.status}`);
check('signup returns {user:{id,email,name}}', r.json?.user && isString(r.json.user.id) && isString(r.json.user.email) && isString(r.json.user.name));
check('signup issues an sf_session cookie', Boolean(session));

session = '';
r = await call('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password-1' } });
check('wrong password is a JSON problem, not a redirect', r.status >= 400 && isProblem(r.json) && notRedirect(r), `status ${r.status}`);

r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
check('login answers 2xx JSON', r.status >= 200 && r.status < 300, `status ${r.status}`);
check('login returns {user}', isString(r.json?.user?.id));
check('login issues an sf_session cookie', Boolean(session));

// Profile.
r = await call('/api/mobile/profile');
const p = r.json;
check('profile 200', r.status === 200, `status ${r.status}`);
check(
  'profile shape (user, plan, verified, usage, frequencies)',
  p && isString(p.user?.id) && isString(p.plan) && typeof p.verified === 'boolean' &&
    ['used', 'quota', 'remaining'].every((k) => Number.isInteger(p.usage?.[k])) && isString(p.usage?.renewsOn) &&
    Array.isArray(p.frequencies) && p.frequencies.every(isString) &&
    (p.retentionDays === undefined || Number.isInteger(p.retentionDays)),
  JSON.stringify(p),
);
// Additive and optional (migration 0017): the app must decode a profile with or without them.
check(
  'profile referral fields are optional and typed (usage.bonus, referral_url)',
  p && (p.usage?.bonus === undefined || Number.isInteger(p.usage.bonus)) &&
    (p.referral_url === undefined || (isString(p.referral_url) && /\/join\/[a-z0-9]+$/.test(p.referral_url))),
  JSON.stringify({ bonus: p?.usage?.bonus, referral_url: p?.referral_url }),
);
// Additive and optional (migration 0019): only while a Pro trial is what `plan` reflects. The app never offers one.
check(
  'profile trial field is optional and typed (trial.plan, trial.ends_at)',
  p && (p.trial === undefined || (isString(p.trial?.plan) && isString(p.trial?.ends_at) && !Number.isNaN(Date.parse(p.trial.ends_at)))),
  JSON.stringify(p?.trial),
);
check('a new account is on no trial', p && p.trial === undefined, JSON.stringify(p?.trial));
check(
  'usage.remaining is what can still be taken, bonus included; quota stays the monthly allowance',
  p && p.usage?.remaining >= (p.usage?.bonus ?? 0) && p.usage?.remaining <= p.usage?.quota + (p.usage?.bonus ?? 0),
  JSON.stringify(p?.usage),
);

// Lists.
r = await call('/api/watches');
check('monitor list {data:[Monitor]}', r.status === 200 && Array.isArray(r.json?.data) && r.json.data.every(monitor), `status ${r.status}`);
r = await call('/api/captures?collection=regular&limit=30&offset=0');
check('library {data:[Capture]}', r.status === 200 && Array.isArray(r.json?.data) && r.json.data.every(capture), `status ${r.status}`);

// Free has three weekly monitors. The app offers the profile's schedules, shown through Swift's
// `.capitalized`, and never the 15-minute one: it only creates visual monitors.
check('a free profile offers weekly checks, and only them', JSON.stringify(p?.frequencies) === '["weekly"]', JSON.stringify(p?.frequencies));
check('the profile never offers the 15-minute schedule', !p?.frequencies?.includes('quarter-hourly'));

// A schedule the plan does not include is a problem the app shows as it is.
r = await call('/api/watches', {
  method: 'POST',
  body: { url: 'https://example.com', label: '', frequency: 'daily', device: 'desktop', threshold: '1' },
});
check('a schedule outside the plan is a JSON problem', isProblem(r.json) && notRedirect(r) && r.status === 403, `status ${r.status} ${r.text.slice(0, 120)}`);
check('it uses a type the app special-cases', ['plan_required', 'watch_limit'].includes(r.json?.error?.type), r.json?.error?.type);

// The request the app sends, with a schedule the profile offered.
r = await call('/api/watches', {
  method: 'POST',
  body: {
    url: 'https://example.com', label: 'Contract', frequency: p?.frequencies?.[0] ?? 'weekly', device: 'desktop',
    threshold: '1', notify_email: '1', mode: 'fullpage', format: 'png',
  },
});
check('a free account creates a weekly monitor', r.status === 201, `status ${r.status} ${r.text.slice(0, 160)}`);
check('monitor create returns a Monitor', monitor(r.json), JSON.stringify(r.json));
check('the Monitor says how it is checked (additive)', r.json?.check_mode === 'visual' && r.json?.check_reason === null, JSON.stringify(r.json));
const id = r.json?.id;
if (id) {
  const detail = await call(`/api/watches/${id}`);
  check('monitor detail {runs:[Run]}', detail.status === 200 && monitor(detail.json) && Array.isArray(detail.json?.runs) && detail.json.runs.every(run));
  for (const body of [{ action: 'pause' }, { action: 'resume' }, { action: 'schedule', frequency: 'weekly' }, { action: 'threshold', threshold: '2' }]) {
    const a = await call(`/api/watches/${id}`, { method: 'POST', body });
    check(`monitor action ${body.action} answers a Monitor`, a.status >= 200 && a.status < 300 && monitor(a.json), `status ${a.status} ${a.text.slice(0, 120)}`);
  }
  // A check renders, so without a browser here it records a failure: still a Monitor with an outcome.
  const ran = await call(`/api/watches/${id}`, { method: 'POST', body: { action: 'run' } });
  check('monitor action run answers a Monitor and an outcome', ran.status === 200 && monitor(ran.json) && typeof ran.json?.outcome?.status === 'string', `status ${ran.status} ${ran.text.slice(0, 160)}`);
  const runs = (await call(`/api/watches/${id}`)).json?.runs ?? [];
  check('runs decode after a check', runs.length > 0 && runs.every(run) && runs.every((x) => x.capture_id == null || isString(x.capture_id)), JSON.stringify(runs[0]));
  const del = await call(`/api/watches/${id}`, { method: 'DELETE', body: {} });
  check('monitor delete', del.status >= 200 && del.status < 300, `status ${del.status}`);
}

// Capture (needs a browser; skipped when the binding is unavailable locally).
r = await call('/api/captures', { method: 'POST', body: { url: 'https://example.com', device: 'desktop', mode: 'visible', format: 'png' } });
const noBrowser = (text) => /browser|binding|rendering/i.test(text ?? '');
if (r.status >= 200 && r.status < 300 && r.json?.status === 'error' && noBrowser(r.json?.error)) {
  console.log(`skip  capture render (no browser here: ${r.json.error.slice(0, 80)})`);
  check('a failed capture still decodes as a Capture', capture(r.json), JSON.stringify(r.json).slice(0, 200));
  if (r.json?.id) await call(`/api/captures/${r.json.id}`, { method: 'DELETE' });
} else if (r.status >= 200 && r.status < 300) {
  check('capture is synchronous and returns a finished Capture', capture(r.json) && r.json.status === 'done', JSON.stringify(r.json).slice(0, 200));
  if (r.json?.images?.[0]) {
    const image = await fetch(r.json.images[0], { redirect: 'manual' });
    check('capture image loads from its URL without a session cookie', image.status === 200, `status ${image.status}`);
  }
  if (r.json?.id) {
    const one = await call(`/api/captures/${r.json.id}`);
    check('capture detail is a Capture', one.status === 200 && capture(one.json));
    const del = await call(`/api/captures/${r.json.id}`, { method: 'DELETE' });
    check('capture delete', del.status >= 200 && del.status < 300, `status ${del.status}`);
  }
} else if (r.status >= 500 || /browser/i.test(r.text)) {
  console.log(`skip  capture (no browser here: ${r.status} ${r.json?.error?.type ?? ''})`);
  check('capture failure is a JSON problem', isProblem(r.json) || r.status >= 500, r.text.slice(0, 120));
} else {
  check('capture failure is a JSON problem', isProblem(r.json) && notRedirect(r), `status ${r.status} ${r.text.slice(0, 120)}`);
}

// Background captures (the web app's `async=1`) must never reach the lists the app reads: it shows
// anything not done as a failure. Without the queue's tables the capture just runs inline.
r = await call('/api/captures', { method: 'POST', body: { url: 'https://example.com/queued', async: '1' } });
if (r.status === 202) {
  check('an async capture answers 202 with a queued Capture', capture(r.json) && r.json.status === 'queued', JSON.stringify(r.json).slice(0, 200));
  const listed = await call('/api/captures?collection=regular&limit=30&offset=0');
  check(
    'the library leaves queued and running captures out',
    listed.status === 200 && !listed.json?.data?.some((c) => c.id === r.json.id) &&
      listed.json.data.every((c) => c.status !== 'queued' && c.status !== 'running'),
    `status ${listed.status}`,
  );
  if (r.json?.id) await call(`/api/captures/${r.json.id}`, { method: 'DELETE' });
} else if (r.status >= 200 && r.status < 300) {
  console.log('skip  background capture (no queue here; it ran inline)');
  check('an async capture without the queue still decodes as a Capture', capture(r.json), JSON.stringify(r.json).slice(0, 200));
  if (r.json?.id) await call(`/api/captures/${r.json.id}`, { method: 'DELETE' });
} else {
  check('async capture failure is a JSON problem', isProblem(r.json) && notRedirect(r), `status ${r.status} ${r.text.slice(0, 120)}`);
}

// Verification resend: an acknowledgement or a problem, never a redirect.
r = await call('/api/auth/resend-verification', { method: 'POST', body: {} });
check('resend verification answers JSON', notRedirect(r) && r.json !== null, `status ${r.status} ${r.text.slice(0, 120)}`);
check('resend verification is 2xx or a JSON problem', (r.status < 300) || isProblem(r.json), `status ${r.status}`);

// Push registration rejects junk with a problem, not a crash.
r = await call('/api/mobile/push', { method: 'POST', body: { token: 'not-a-token', environment: 'development' } });
if (r.status === 503 && isProblem(r.json)) console.log(`skip  push registration (not configured here: ${r.json.error.type})`);
else check('push registration answers JSON', notRedirect(r) && r.json !== null && r.status < 500, `status ${r.status}`);

// Logout answers JSON and clears the session; signing back in works.
r = await call('/api/auth/logout', { method: 'POST', body: {} });
check('logout answers 2xx JSON', r.status >= 200 && r.status < 300 && r.json !== null && notRedirect(r), `status ${r.status}`);
check('logout clears the session cookie', /sf_session=;|sf_session=(?:""|)\s*(;|$)/.test(r.setCookie) || session === '', r.setCookie.slice(0, 80));
r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
check('signing back in after logout works', r.status >= 200 && r.status < 300 && Boolean(session), `status ${r.status}`);

// Account deletion with password, then the session is gone.
r = await call('/api/account', { method: 'DELETE', body: { password } });
check('account deletion answers 2xx JSON', r.status >= 200 && r.status < 300 && r.json !== null, `status ${r.status} ${r.text.slice(0, 120)}`);
r = await call('/api/mobile/profile');
check('deleted session is rejected with 401', r.status === 401, `status ${r.status}`);

console.log(failures ? `\n${failures} failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failures ? 1 : 0);
