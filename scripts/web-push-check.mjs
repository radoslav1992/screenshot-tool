/**
 * Web Push: aes128gcm against RFC 8291's own test vector and back again, the
 * VAPID JWT, the endpoint allowlist and key checks, subscribing (idempotent,
 * re-bound, capped at ten, gone with the session), delivery and how each push
 * service answer is read, queueing beside APNs for the same alert, the test
 * alert's rate limit, staying dormant without migration 0018 or the VAPID
 * secrets, account deletion, and which install hint and alert state a browser
 * gets. Real SQLite (every migration), in-memory KV, a mocked fetch: no
 * network calls.
 *
 *   node scripts/web-push-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecipheriv, createECDH, createHash, createHmac } from 'node:crypto';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'web-push-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__webPush = { env: {} });
const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__webPush.env;',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/mailer.ts': 'export const canSendEmail = () => false; export async function sendMail() { return false; }',
  '/lib/renderer.ts': 'export async function render() { throw new Error("no rendering here"); }',
};
const plugin = {
  name: 'web-push-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
  },
};

/** Everything under test in one bundle, so the routes and the queue share one copy of push.ts and its probe cache. */
const ENTRY = join(directory, 'entry.ts');
writeFileSync(
  ENTRY,
  [
    `export * as push from ${JSON.stringify(join(root, 'src/lib/push.ts'))};`,
    `export * as wp from ${JSON.stringify(join(root, 'src/lib/web-push.ts'))};`,
    `export * as subscriptions from ${JSON.stringify(join(root, 'src/pages/api/push/web/index.ts'))};`,
    `export * as testAlert from ${JSON.stringify(join(root, 'src/pages/api/push/web/test.ts'))};`,
    `export * as deletion from ${JSON.stringify(join(root, 'src/lib/account-deletion.ts'))};`,
    `export * as install from ${JSON.stringify(join(root, 'src/scripts/install.ts'))};`,
    `export * as alerts from ${JSON.stringify(join(root, 'src/scripts/push-alerts.ts'))};`,
  ].join('\n'),
);
let bundles = 0;
/** A fresh copy, with its own per-isolate caches, as a new isolate would have. */
async function load() {
  const result = await build({ entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [plugin], logLevel: 'silent' });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

/** Every migration, or every one before 0018. */
function database({ webPush = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!webPush && file >= '0018') continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}
/** D1 over node:sqlite: a batch is one transaction. */
function d1(db) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((q) => ({ meta: { changes: Number(db.prepare(q.sql).run(...q.args).changes) } }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
const kv = new Map();
const RATE = { get: async (key) => kv.get(key) ?? null, put: async (key, value) => void kv.set(key, value), delete: async (key) => void kv.delete(key) };
const SHOTS = { list: async () => ({ objects: [], truncated: false }), delete: async () => {}, head: async () => null };

/** The server's VAPID pair, as `npm run vapid:keys` prints it, and the same private key as a PKCS8 PEM. */
const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vapidPair.publicKey)).toString('base64url');
const VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapidPair.privateKey)).d;
const VAPID_PEM = `-----BEGIN PRIVATE KEY-----\\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', vapidPair.privateKey)).toString('base64')}\\n-----END PRIVATE KEY-----`;
const VAPID = { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: 'mailto:alerts@easyscreencapture.test' };
const apnsPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const APNS = {
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TESTTEAM12',
  APNS_BUNDLE_ID: 'com.easyscreencapture.ios',
  APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', apnsPair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`,
};

/** A new world: its own database, the same env object every bundle holds on to. */
function world({ webPush = true, secrets = { ...VAPID } } = {}) {
  const db = database({ webPush });
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, { DB: d1(db), RATE, SHOTS, PUBLIC_SITE_URL: ORIGIN, ...secrets });
  kv.clear();
  sent.length = 0;
  return db;
}

const ORIGIN = 'https://easyscreencapture.test';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();
function addUser(db, id) {
  db.prepare(`INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at) VALUES (?, ?, ?, ?, 'pro', ?, ?, ?)`)
    .run(id, `${id}@example.test`, `${id}@example.test`, id, iso(), iso(), iso());
}
/** A signed-in browser: its cookie, and the session row the cookie's hash names. */
function signIn(db, userId, token = `${userId}-token-${Math.random().toString(36).slice(2)}`) {
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, iso(), iso(Date.now() + 30 * 86400000));
  return { user: { id: userId, email: `${userId}@example.test`, plan: 'pro' }, token, sessionId: sha256(token) };
}
function addWatchRun(db, userId, watchId, runId) {
  if (!db.prepare('SELECT 1 FROM watches WHERE id = ?').get(watchId)) {
    db.prepare(
      `INSERT INTO watches (id, user_id, url, host, device, width, height, scale, mode, format, frequency, threshold, status, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'https://shop.test/', 'shop.test', 'desktop', 1440, 900, 1, 'viewport', 'png', 'daily', 0, 'active', ?, ?, ?)`,
    ).run(watchId, userId, iso(), iso(), iso());
  }
  db.prepare(`INSERT INTO watch_runs (id, watch_id, user_id, status, changed, created_at) VALUES (?, ?, ?, 'done', 1, ?)`).run(runId, watchId, userId, iso());
}

/** A browser's push keys: an ECDH pair and a 16-byte auth secret, as PushSubscription.toJSON() gives them. */
async function browser(host = 'https://fcm.googleapis.com/fcm/send/') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `${host}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return { ecdh, auth, json: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.from(auth).toString('base64url') } } };
}

/** RFC 8291 decryption written out with node:crypto, independent of the code under test. */
function decrypt(body, ecdh, auth) {
  const buffer = Buffer.from(body);
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  const salt = buffer.subarray(0, 16);
  const rs = buffer.readUInt32BE(16);
  const keyid = buffer.subarray(21, 21 + buffer[20]);
  const sealed = buffer.subarray(21 + buffer[20]);
  assert.ok(sealed.length <= rs, 'one record');
  const secret = ecdh.computeSecret(keyid);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), keyid, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'the last record ends with the 0x02 delimiter');
  return { plaintext: padded.subarray(0, end), secret, ikm, prk, cek, nonce, salt, rs, keyid };
}

/* A push service per endpoint host: APNs answers 200, a web endpoint whatever `answer` says. */
const sent = [];
let answer = () => new Response(null, { status: 201 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const request = { url: String(url), init, headers: init.headers };
  sent.push(request);
  if (String(url).startsWith('https://api.sandbox.push.apple.com/3/device/')) return new Response(null, { status: 200 });
  return answer(request);
};
const webSent = () => sent.filter((request) => !request.url.includes('/3/device/'));

const errors = [];
const originalError = console.error;

try {
  console.error = (...args) => errors.push(args.map(String).join(' '));

  /* ------------------------------------------------------------------------ */
  /* The protocol                                                              */
  /* ------------------------------------------------------------------------ */

  world();
  const { wp } = await load();
  const b64 = (text) => Buffer.from(text, 'base64url');

  await section('aes128gcm: RFC 8291 Appendix A, byte for byte, with its keys and salt', async () => {
    // Appendix A of RFC 8291: the application server's key pair, the user agent's public key, salt and auth secret.
    const asPublic = b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const asPrivate = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
    const uaPublic = b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const salt = b64('DGv6ra1nlYgDCS1FRnbzlw');
    const auth = b64('BTBZMqHH6r4Tts7J_aSIgg');
    const jwk = { kty: 'EC', crv: 'P-256', x: asPublic.subarray(1, 33).toString('base64url'), y: asPublic.subarray(33).toString('base64url') };
    const keys = {
      privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: asPrivate }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const plaintext = new TextEncoder().encode('When I grow up, I want to be a watermelon');
    const body = await wp.encryptPayload(plaintext, new Uint8Array(uaPublic), new Uint8Array(auth), { salt: new Uint8Array(salt), keys });
    assert.equal(
      Buffer.from(body).toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
      'the encrypted message is exactly the RFC’s',
    );

    // And back, with the user agent's private key from the same appendix: every intermediate value matches too.
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
    assert.deepEqual(ua.getPublicKey(), uaPublic);
    const opened = decrypt(body, ua, auth);
    assert.equal(opened.secret.toString('base64url'), 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs', 'ecdh_secret');
    assert.equal(opened.ikm.toString('base64url'), 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg', 'IKM');
    assert.equal(opened.prk.toString('base64url'), '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc', 'PRK');
    assert.equal(opened.cek.toString('base64url'), 'oIhVW04MRdy2XN9CiKLxTg', 'CEK');
    assert.equal(opened.nonce.toString('base64url'), '4h_95klXJ5E_qnoN', 'NONCE');
    assert.equal(opened.rs, 4096);
    assert.deepEqual(opened.keyid, asPublic, 'the key id is the server’s public key');
    assert.equal(opened.plaintext.toString(), 'When I grow up, I want to be a watermelon');
  });

  await section('aes128gcm: a fresh key and salt every time, and the browser decrypts each one', async () => {
    const { ecdh, auth } = await browser();
    const message = new TextEncoder().encode(JSON.stringify(wp.webPushPayload('wch_1', 'wrn_1')));
    const first = await wp.encryptPayload(message, new Uint8Array(ecdh.getPublicKey()), auth);
    const second = await wp.encryptPayload(message, new Uint8Array(ecdh.getPublicKey()), auth);
    assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86), 'salt and server key change per message');
    for (const body of [first, second]) assert.deepEqual(JSON.parse(decrypt(body, ecdh, auth).plaintext), wp.webPushPayload('wch_1', 'wrn_1'));
    // Tampering with one byte is caught by the tag.
    const tampered = new Uint8Array(first);
    tampered[100] ^= 1;
    assert.throws(() => decrypt(tampered, ecdh, auth));
    await assert.rejects(wp.encryptPayload(new Uint8Array(4000), new Uint8Array(ecdh.getPublicKey()), auth), /too large/);
  });

  await section('the alert says what the APNs alert says, and nothing about the page', async () => {
    const payload = wp.webPushPayload('wch_abc', 'wrn_123');
    assert.deepEqual(payload, {
      title: 'A monitored page changed',
      body: 'Open Easy Capture to review the before and after.',
      url: '/app/watches/wch_abc',
      watch_id: 'wch_abc',
      run_id: 'wrn_123',
    });
    assert.ok(!JSON.stringify(payload).includes('https://'), 'no monitored URL');
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length < 400, 'small');
  });

  await section('VAPID: an ES256 JWT for the push service’s origin, verified with WebCrypto, from either key format', async () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    for (const privateKey of [VAPID_PRIVATE_KEY, VAPID_PEM]) {
      const config = { ...VAPID, VAPID_PRIVATE_KEY: privateKey };
      const header = await wp.vapidAuthorization(config, 'https://fcm.googleapis.com/fcm/send/abc:def', now);
      const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
      assert.equal(key, VAPID_PUBLIC_KEY);
      const [head, claims, signature] = token.split('.');
      assert.deepEqual(JSON.parse(b64(head)), { typ: 'JWT', alg: 'ES256' });
      const body = JSON.parse(b64(claims));
      assert.deepEqual(body, { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: VAPID.VAPID_SUBJECT });
      assert.ok(body.exp - now / 1000 <= 24 * 3600, 'RFC 8292: at most 24 hours ahead');
      const verifier = await crypto.subtle.importKey('raw', b64(VAPID_PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.equal(b64(signature).length, 64, 'a raw r‖s signature');
      assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, b64(signature), new TextEncoder().encode(`${head}.${claims}`)));
      assert.equal(await wp.vapidAuthorization(config, 'https://fcm.googleapis.com/fcm/send/other', now + 60000), header, 'reused for the same service');
    }
    const apple = await wp.vapidAuthorization(VAPID, 'https://web.push.apple.com/QGuQ', now);
    assert.equal(JSON.parse(b64(/t=([^.]+)\.([^.]+)/.exec(apple)[2])).aud, 'https://web.push.apple.com', 'each service gets its own audience');
    assert.ok(wp.webPushConfigured(VAPID));
    assert.ok(!wp.webPushConfigured({ ...VAPID, VAPID_SUBJECT: 'alerts@example.test' }), 'the subject is a mailto: or https: URL');
    assert.ok(!wp.webPushConfigured({ ...VAPID, VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY.slice(4) }), 'the public key is a 65-byte point');
    assert.ok(!wp.webPushConfigured({ ...VAPID, VAPID_PRIVATE_KEY: '' }));
    await assert.rejects(wp.vapidAuthorization({}, 'https://fcm.googleapis.com/x'), /not configured/);
  });

  await section('endpoints: https on the browsers’ push services only; keys of the right length, on the curve', async () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
      'https://eu.push.services.mozilla.com/wpush/v1/gAAAAAB',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
      'https://web.push.apple.com/QGuQyavXutnMH',
      'https://api.push.apple.com/3/x',
    ])
      assert.ok(wp.pushEndpointAllowed(endpoint), endpoint);
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.attacker.test/x',
      'https://evil.googleapis.com/x',
      'https://notify.windows.com/x',
      'https://push.apple.com/x',
      'https://web.push.apple.com.attacker.test/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com./x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data',
      'javascript:alert(1)',
      `https://fcm.googleapis.com/${'x'.repeat(2100)}`,
      '',
      42,
      null,
    ])
      assert.ok(!wp.pushEndpointAllowed(endpoint), String(endpoint));

    const { json } = await browser();
    const parsed = wp.parseSubscription(json);
    assert.deepEqual(parsed, { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
    // readBody hands a nested object over as JSON text.
    assert.deepEqual(wp.parseSubscription({ endpoint: json.endpoint, keys: JSON.stringify(json.keys) }), parsed);
    // Padded base64url is accepted and stored without padding.
    assert.deepEqual(wp.parseSubscription({ endpoint: json.endpoint, keys: { p256dh: `${json.keys.p256dh}=`, auth: `${json.keys.auth}==` } }), parsed);
    const key = b64(json.keys.p256dh);
    const bad = [
      { p256dh: key.subarray(0, 64).toString('base64url'), auth: json.keys.auth },
      { p256dh: Buffer.concat([key, Buffer.from([1])]).toString('base64url'), auth: json.keys.auth },
      { p256dh: Buffer.concat([Buffer.from([2]), key.subarray(1)]).toString('base64url'), auth: json.keys.auth },
      { p256dh: json.keys.p256dh, auth: Buffer.alloc(15).toString('base64url') },
      { p256dh: json.keys.p256dh, auth: Buffer.alloc(17).toString('base64url') },
      { p256dh: json.keys.p256dh, auth: 'not base64!' },
      { p256dh: json.keys.p256dh },
      {},
    ];
    for (const keys of bad) assert.equal(wp.parseSubscription({ endpoint: json.endpoint, keys }), null, JSON.stringify(keys));
    assert.equal(wp.parseSubscription({ endpoint: json.endpoint, keys: '{not json' }), null);
    assert.equal(wp.parseSubscription({ endpoint: 'https://attacker.test/x', keys: json.keys }), null);
    assert.equal(await wp.keyOnCurve(json.keys.p256dh), true);
    assert.equal(await wp.keyOnCurve(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url')), false, 'right length, not a point');
  });

  await section('push service answers: 201/202 taken, 404/410 gone, 429/5xx retried, the rest failed', async () => {
    const expect = { 201: 'accepted', 202: 'accepted', 404: 'invalid', 410: 'invalid', 413: 'failed', 429: 'retry', 500: 'retry', 502: 'retry', 503: 'retry', 400: 'failed', 401: 'failed', 403: 'failed', 200: 'failed' };
    for (const [status, state] of Object.entries(expect)) assert.equal(wp.classifyWebPush(Number(status)), state, `HTTP ${status}`);
  });

  /* ------------------------------------------------------------------------ */
  /* Subscribing                                                               */
  /* ------------------------------------------------------------------------ */

  let db = world();
  let app = await load();
  const call = async (handler, who, { method = 'POST', body, origin = ORIGIN, agent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0' } = {}) => {
    const headers = { 'user-agent': agent, accept: 'application/json' };
    if (origin) headers.origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const request = new Request(`${ORIGIN}/api/push/web`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = { get: (name) => (who && name === 'sf_session' ? { value: who.token } : undefined) };
    const response = await handler({ request, locals: { user: who?.user ?? null }, cookies });
    return { status: response.status, json: await response.json() };
  };
  const rows = () => db.prepare('SELECT * FROM web_push_subscriptions ORDER BY created_at').all();

  await section('subscribe: signed in and same-origin, checked, idempotent per endpoint', async () => {
    addUser(db, 'u');
    const alice = signIn(db, 'u');
    const { GET, POST } = app.subscriptions;
    assert.equal((await call(GET, null, { method: 'GET' })).status, 401);
    assert.deepEqual((await call(GET, alice, { method: 'GET' })).json, { available: true, publicKey: VAPID_PUBLIC_KEY, subscribed: false });

    const { json } = await browser();
    assert.equal((await call(POST, null, { body: json })).status, 401);
    assert.equal((await call(POST, alice, { body: json, origin: 'https://attacker.test' })).status, 403);
    let r = await call(POST, alice, { body: { ...json, endpoint: 'https://attacker.test/collect' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.param, 'endpoint');
    r = await call(POST, alice, { body: { ...json, keys: { ...json.keys, auth: 'AAAA' } } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.param, 'keys');
    r = await call(POST, alice, { body: { ...json, keys: { ...json.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') } } });
    assert.equal(r.status, 400, 'a point off the curve');
    assert.equal(rows().length, 0, 'nothing refused was stored');

    const agent = `  Mozilla/5.0   (iPhone; CPU iPhone OS 18_0 like Mac OS X)  ${'Safari '.repeat(40)}`;
    r = await call(POST, alice, { body: json, agent });
    assert.deepEqual(r.json, { subscribed: true });
    let [row] = rows();
    assert.equal(row.endpoint, json.endpoint);
    assert.equal(row.user_id, 'u');
    assert.equal(row.session_id, alice.sessionId);
    assert.equal(row.p256dh, json.keys.p256dh);
    assert.equal(row.auth, json.keys.auth);
    assert.ok(row.user_agent.length <= 120 && row.user_agent.startsWith('Mozilla/5.0 (iPhone; CPU') && !/\s{2}/.test(row.user_agent), 'user agent trimmed and short');
    assert.equal(row.last_success_at, null);

    const created = row.created_at;
    assert.equal((await call(POST, alice, { body: json })).status, 200);
    assert.equal(rows().length, 1, 'the same endpoint again is the same subscription');
    assert.equal(rows()[0].created_at, created);
    assert.equal((await call(GET, alice, { method: 'GET' })).json.subscribed, true);

    // Another session of the same person, and then someone else entirely, takes the endpoint over.
    const phone = signIn(db, 'u');
    await call(POST, phone, { body: json });
    [row] = rows();
    assert.equal(rows().length, 1);
    assert.equal(row.session_id, phone.sessionId, 're-bound to the session that subscribed last');
    assert.equal((await call(GET, alice, { method: 'GET' })).json.subscribed, false);
    addUser(db, 'v');
    const bob = signIn(db, 'v');
    await call(POST, bob, { body: json });
    assert.deepEqual(rows().map((s) => [s.user_id, s.session_id]), [['v', bob.sessionId]], 'and to whoever is signed in now');

    // A browser has one subscription per site: a new endpoint from the same session replaces the old one.
    const renewed = await browser();
    await call(POST, bob, { body: renewed.json });
    assert.deepEqual(rows().map((s) => s.endpoint), [renewed.json.endpoint]);
  });

  await section('subscribe: ten per account, the oldest replaced', async () => {
    db.exec('DELETE FROM web_push_subscriptions');
    const browsers = [];
    for (let i = 0; i < 11; i++) {
      const who = signIn(db, 'u');
      const device = await browser(i % 2 ? 'https://web.push.apple.com/' : 'https://fcm.googleapis.com/fcm/send/');
      assert.equal((await call(app.subscriptions.POST, who, { body: device.json })).status, 200);
      if (i < 10) db.prepare('UPDATE web_push_subscriptions SET created_at = ? WHERE endpoint = ?').run(`2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, device.json.endpoint);
      browsers.push(device.json.endpoint);
    }
    const kept = rows().map((s) => s.endpoint);
    assert.equal(kept.length, 10);
    assert.ok(!kept.includes(browsers[0]), 'the oldest went');
    assert.ok(kept.includes(browsers[10]), 'the newest stays');
    assert.deepEqual(new Set(kept), new Set(browsers.slice(1)));
  });

  await section('unsubscribe: only your own; signing out, or an expired session, removes the rest', async () => {
    db.exec('DELETE FROM web_push_subscriptions');
    const alice = signIn(db, 'u');
    const bob = signIn(db, 'v');
    const a = await browser();
    const b = await browser();
    await call(app.subscriptions.POST, alice, { body: a.json });
    await call(app.subscriptions.POST, bob, { body: b.json });
    assert.equal((await call(app.subscriptions.DELETE, alice, { method: 'DELETE', body: { endpoint: b.json.endpoint } })).status, 200);
    assert.equal(rows().length, 2, 'someone else’s endpoint is not yours to remove');
    assert.equal((await call(app.subscriptions.DELETE, alice, { method: 'DELETE', body: {} })).status, 400);
    assert.deepEqual((await call(app.subscriptions.DELETE, alice, { method: 'DELETE', body: { endpoint: a.json.endpoint } })).json, { subscribed: false });
    assert.deepEqual(rows().map((s) => s.user_id), ['v']);

    // Signing out deletes the session row (lib/auth.ts destroySession); the subscription goes with it.
    await call(app.subscriptions.POST, alice, { body: a.json });
    addWatchRun(db, 'u', 'wch_out', 'wrn_out');
    for (const statement of await app.push.pushQueueStatements('wrn_out', 'u')) await statement.run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_deliveries').get().n, 1);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(alice.sessionId);
    assert.deepEqual(rows().map((s) => s.user_id), ['v'], 'signed out: gone');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_deliveries').get().n, 0, 'with its queued alert');

    // An expired session is swept on the next drain.
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(iso(Date.now() - 1000), bob.sessionId);
    await app.push.drainPush();
    assert.equal(rows().length, 0);
    assert.equal(webSent().length, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Delivery                                                                  */
  /* ------------------------------------------------------------------------ */

  await section('one alert, both kinds of device: an APNs device and a browser each get the run', async () => {
    db = world({ secrets: { ...VAPID, ...APNS } });
    app = await load();
    addUser(db, 'u');
    const phone = signIn(db, 'u');
    const laptop = signIn(db, 'u');
    db.prepare('INSERT INTO push_devices VALUES (?, ?, ?, ?, ?, ?)').run('dev_1', 'u', phone.sessionId, 'a'.repeat(64), 'sandbox', iso());
    const device = await browser();
    await call(app.subscriptions.POST, laptop, { body: device.json });
    addWatchRun(db, 'u', 'wch_1', 'wrn_1');

    // As runWatch does: the queue inserts commit in the same batch as the run, then the run is drained.
    const statements = await app.push.pushQueueStatements('wrn_1', 'u');
    assert.equal(statements.length, 2, 'one insert per kind of device');
    await fx.env.DB.batch(statements);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_deliveries').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_deliveries').get().n, 1);
    const queued = db.prepare('SELECT * FROM web_push_deliveries').get();
    assert.equal(queued.device_id, rows()[0].id);
    assert.equal(queued.session_id, laptop.sessionId);
    assert.ok(Math.abs(Date.parse(queued.expires_at) - Date.now() - 86400000) < 5000, 'a day to deliver, as for APNs');

    await app.push.drainPush('wrn_1');
    assert.equal(sent.length, 2);
    assert.ok(sent.some((r) => r.url === `https://api.sandbox.push.apple.com/3/device/${'a'.repeat(64)}`), 'APNs got it');
    const [web] = webSent();
    assert.equal(web.url, device.json.endpoint, 'and the browser’s push service');
    assert.equal(web.init.method, 'POST');
    assert.equal(web.init.redirect, 'error');
    assert.equal(web.headers['content-encoding'], 'aes128gcm');
    assert.equal(web.headers['content-type'], 'application/octet-stream');
    assert.equal(web.headers.urgency, 'normal');
    const ttl = Number(web.headers.ttl);
    assert.ok(ttl > 86000 && ttl <= 86400, `TTL matches the delivery expiry (${ttl})`);
    assert.match(web.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID_PUBLIC_KEY}$`));
    assert.deepEqual(JSON.parse(decrypt(web.init.body, device.ecdh, device.auth).plaintext), wp.webPushPayload('wch_1', 'wrn_1'));
    assert.deepEqual(db.prepare('SELECT status FROM push_deliveries').all().map((r) => r.status), ['accepted']);
    assert.deepEqual({ ...db.prepare('SELECT status, attempts, reason FROM web_push_deliveries').get() }, { status: 'accepted', attempts: 1, reason: 'HTTP_201' });
    assert.ok(rows()[0].last_success_at, 'the last success is noted');

    // Claimed once: draining again sends nothing more.
    await Promise.all([app.push.drainPush(), app.push.drainPush('wrn_1')]);
    assert.equal(sent.length, 2);
    // Without APNs configured, only the browser's insert is made.
    delete fx.env.APNS_KEY_ID;
    assert.equal((await app.push.pushQueueStatements('wrn_1', 'u')).length, 1);
  });

  await section('delivery: 404/410 remove the subscription, 429/5xx retry on the hour, 413 and others fail, no answer is never resent', async () => {
    const laptop = signIn(db, 'u');
    let n = 1;
    const deliver = async (status, { throws = false } = {}) => {
      const run = `wrn_d${++n}`;
      addWatchRun(db, 'u', 'wch_1', run);
      answer = () => {
        if (throws) throw new Error('timeout');
        return new Response(status === 410 ? JSON.stringify({ reason: 'Unregistered' }) : 'gone', { status });
      };
      await app.push.queuePush(run, 'u');
      return { run, row: db.prepare('SELECT * FROM web_push_deliveries WHERE run_id = ?').get(run) };
    };
    const subscribe = async () => {
      const device = await browser();
      await call(app.subscriptions.POST, laptop, { body: device.json });
      return device;
    };

    for (const status of [404, 410]) {
      await subscribe();
      const { row } = await deliver(status);
      assert.equal(row, undefined, `${status}: the delivery went with the subscription`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE session_id = ?').get(laptop.sessionId).n, 0, `${status}: subscription removed`);
    }

    await subscribe();
    let { run, row } = await deliver(413);
    assert.deepEqual([row.status, row.reason], ['failed', 'HTTP_413']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE session_id = ?').get(laptop.sessionId).n, 1, '413 keeps the subscription');

    ({ run, row } = await deliver(429));
    assert.deepEqual([row.status, row.attempts], ['pending', 1]);
    const retryAt = Date.parse(row.next_attempt_at);
    assert.equal(retryAt % 3600000, 0, 'due on the hour the sweep runs');
    assert.ok(retryAt > Date.now() && retryAt <= Date.now() + 3600000);
    const before = webSent().length;
    await app.push.drainPush();
    assert.equal(webSent().length, before, 'not before it is due');
    for (const [attempt, status] of [[2, 'pending'], [3, 'failed']]) {
      db.prepare("UPDATE web_push_deliveries SET next_attempt_at = '2000-01-01' WHERE run_id = ?").run(run);
      answer = () => new Response('busy', { status: 503 });
      await app.push.drainPush();
      assert.deepEqual(
        Object.values(db.prepare('SELECT status, attempts FROM web_push_deliveries WHERE run_id = ?').get(run)),
        [status, attempt],
        `5xx, attempt ${attempt}`,
      );
    }
    db.prepare("UPDATE web_push_deliveries SET next_attempt_at = '2000-01-01' WHERE run_id = ?").run(run);
    const capped = webSent().length;
    await app.push.drainPush();
    assert.equal(webSent().length, capped, 'three attempts at most');

    ({ run, row } = await deliver(0, { throws: true }));
    assert.deepEqual([row.status, row.reason], ['unknown', 'TransportUnconfirmed']);
    const unknown = webSent().length;
    await app.push.drainPush();
    assert.equal(webSent().length, unknown, 'an unknown outcome is not retried');
    answer = () => new Response(null, { status: 201 });
  });

  await section('the test alert: this browser only, five an hour', async () => {
    const alice = signIn(db, 'u');
    const other = signIn(db, 'u');
    const { POST } = app.testAlert;
    assert.equal((await call(POST, null)).status, 401);
    assert.equal((await call(POST, alice, { origin: 'https://attacker.test' })).status, 403);
    assert.equal((await call(POST, alice)).status, 409, 'nothing to test before subscribing');
    const mine = await browser();
    const theirs = await browser('https://updates.push.services.mozilla.com/wpush/v2/');
    await call(app.subscriptions.POST, alice, { body: mine.json });
    await call(app.subscriptions.POST, other, { body: theirs.json });
    const before = webSent().length;
    const r = await call(POST, alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { subscriptions: 1, sent: 1, removed: 0, failed: 0 });
    const [test] = webSent().slice(before);
    assert.equal(test.url, mine.json.endpoint, 'only this session’s subscription');
    assert.deepEqual(JSON.parse(decrypt(test.init.body, mine.ecdh, mine.auth).plaintext), wp.webPushTestPayload());
    assert.ok(Number(test.headers.ttl) <= 600);
    for (let i = 2; i <= 4; i++) assert.equal((await call(POST, alice)).status, 200, `test ${i}`);
    const limited = await call(POST, alice);
    assert.equal(limited.status, 429, 'the sixth within the hour is refused');
    assert.equal(limited.json.error.type, 'rate_limited');
    assert.equal(webSent().length, before + 4, 'and sends nothing');

    // A push service that no longer knows the browser: removed, and said so.
    kv.clear();
    answer = () => new Response(null, { status: 410 });
    assert.deepEqual((await call(POST, other)).json, { subscriptions: 1, sent: 0, removed: 1, failed: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE session_id = ?').get(other.sessionId).n, 0);
    answer = () => new Response(null, { status: 201 });
  });

  await section('account deletion removes every subscription and queued alert', async () => {
    addUser(db, 'gone');
    const who = signIn(db, 'gone');
    await call(app.subscriptions.POST, who, { body: (await browser()).json });
    addWatchRun(db, 'gone', 'wch_gone', 'wrn_gone');
    await fx.env.DB.batch(await app.push.pushQueueStatements('wrn_gone', 'gone'));
    // deleteAccount names its tables rather than leaning on cascades, so check it with them off.
    db.exec('PRAGMA foreign_keys=OFF');
    await app.deletion.deleteAccount('gone');
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE user_id = 'gone'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM web_push_deliveries WHERE run_id = 'wrn_gone'").get().n, 0);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE user_id = 'u'").get().n > 0, 'nobody else’s');
  });

  /* ------------------------------------------------------------------------ */
  /* Dormant                                                                   */
  /* ------------------------------------------------------------------------ */

  await section('dormant without migration 0018: hidden, nothing queued, nothing breaks', async () => {
    db = world({ webPush: false, secrets: { ...VAPID, ...APNS } });
    app = await load();
    addUser(db, 'u');
    const alice = signIn(db, 'u');
    assert.equal(await app.push.webPushReady(), false);
    assert.deepEqual((await call(app.subscriptions.GET, alice, { method: 'GET' })).json, { available: false, publicKey: null, subscribed: false });
    const r = await call(app.subscriptions.POST, alice, { body: (await browser()).json });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.type, 'setup_required');
    assert.equal((await call(app.testAlert.POST, alice)).status, 503);
    assert.equal((await call(app.subscriptions.DELETE, alice, { method: 'DELETE', body: { endpoint: 'https://fcm.googleapis.com/x' } })).status, 200);
    // APNs alone carries on exactly as before.
    db.prepare('INSERT INTO push_devices VALUES (?, ?, ?, ?, ?, ?)').run('dev_1', 'u', alice.sessionId, 'b'.repeat(64), 'sandbox', iso());
    addWatchRun(db, 'u', 'wch_1', 'wrn_1');
    const statements = await app.push.pushQueueStatements('wrn_1', 'u');
    assert.equal(statements.length, 1);
    await fx.env.DB.batch(statements);
    await app.push.drainPush('wrn_1');
    assert.deepEqual(sent.map((s) => new URL(s.url).host), ['api.sandbox.push.apple.com']);
    await app.deletion.deleteAccount('u');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'u'").get().n, 0, 'account deletion works without the tables');
  });

  await section('dormant without the VAPID secrets: the tables alone switch nothing on', async () => {
    db = world({ secrets: {} });
    app = await load();
    addUser(db, 'u');
    const alice = signIn(db, 'u');
    for (const partial of [{}, { VAPID_PUBLIC_KEY }, { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY }, { VAPID_PRIVATE_KEY, VAPID_SUBJECT: VAPID.VAPID_SUBJECT }]) {
      for (const key of Object.keys(VAPID)) delete fx.env[key];
      Object.assign(fx.env, partial);
      assert.equal(await app.push.webPushReady(), false, Object.keys(partial).join('+') || 'none');
      assert.equal((await call(app.subscriptions.GET, alice, { method: 'GET' })).json.available, false);
      assert.equal((await call(app.subscriptions.POST, alice, { body: (await browser()).json })).status, 503);
    }
    db.prepare('INSERT INTO web_push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('sub_1', 'u', alice.sessionId, 'https://fcm.googleapis.com/fcm/send/kept', (await browser()).json.keys.p256dh, Buffer.alloc(16).toString('base64url'), iso());
    addWatchRun(db, 'u', 'wch_1', 'wrn_1');
    assert.deepEqual(await app.push.pushQueueStatements('wrn_1', 'u'), [], 'nothing is queued');
    await app.push.drainPush();
    assert.equal(sent.length, 0);
    // The secrets arrive: picked up at once, configuration is read every time.
    Object.assign(fx.env, VAPID);
    assert.equal(await app.push.webPushReady(), true);
    assert.equal((await app.push.pushQueueStatements('wrn_1', 'u')).length, 1);
  });

  /* ------------------------------------------------------------------------ */
  /* In the browser                                                            */
  /* ------------------------------------------------------------------------ */

  await section('install hint: a button for Chromium, Home Screen steps for iOS Safari, nothing installed, dismissed or elsewhere', async () => {
    const { installHint, isIOS, isIOSSafari } = app.install;
    const base = { standalone: false, canPrompt: false, iosSafari: false, dismissed: false };
    assert.equal(installHint({ ...base, canPrompt: true }), 'prompt');
    assert.equal(installHint({ ...base, iosSafari: true }), 'ios');
    assert.equal(installHint(base), null, 'Firefox, desktop Safari: nothing to offer');
    assert.equal(installHint({ ...base, canPrompt: true, standalone: true }), null, 'already installed');
    assert.equal(installHint({ ...base, iosSafari: true, standalone: true }), null, 'opened from the Home Screen');
    assert.equal(installHint({ ...base, canPrompt: true, dismissed: true }), null, 'closed on this device');
    assert.equal(installHint({ ...base, iosSafari: true, dismissed: true }), null);

    const UA = {
      iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
      iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
      iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0',
      ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    };
    assert.equal(isIOSSafari(UA.iphoneSafari, 5), true);
    assert.equal(isIOSSafari(UA.ipadDesktop, 5), true, 'iPadOS asking for desktop pages');
    assert.equal(isIOSSafari(UA.ipadDesktop, 0), false, 'a Mac');
    assert.equal(isIOSSafari(UA.iphoneChrome, 5), false);
    assert.equal(isIOSSafari(UA.iphoneFirefox, 5), false);
    assert.equal(isIOSSafari(UA.iphoneInstagram, 5), false, 'an in-app browser cannot add to the Home Screen');
    assert.equal(isIOSSafari(UA.androidChrome, 5), false);
    assert.equal(isIOS(UA.iphoneChrome, 5), true, 'but Chrome on iPhone is still iOS, for push');
    assert.equal(isIOS(UA.androidChrome, 5), false);
  });

  await section('alert state: install first on iOS, then unsupported, blocked, off or on', async () => {
    const { pushAlertState } = app.alerts;
    const base = { supported: true, ios: false, standalone: false, permission: 'default', subscribed: false };
    assert.equal(pushAlertState(base), 'off');
    assert.equal(pushAlertState({ ...base, permission: 'granted', subscribed: true }), 'on');
    assert.equal(pushAlertState({ ...base, permission: 'granted' }), 'off', 'allowed but not subscribed here');
    assert.equal(pushAlertState({ ...base, permission: 'default', subscribed: true }), 'off', 'permission reset since');
    assert.equal(pushAlertState({ ...base, permission: 'denied', subscribed: true }), 'blocked');
    assert.equal(pushAlertState({ ...base, supported: false }), 'unsupported');
    assert.equal(pushAlertState({ ...base, ios: true, supported: false }), 'install', 'iOS Safari in a tab has no PushManager');
    assert.equal(pushAlertState({ ...base, ios: true, standalone: true, supported: false }), 'unsupported', 'installed on iOS before 16.4');
    assert.equal(pushAlertState({ ...base, ios: true, standalone: true, permission: 'granted', subscribed: true }), 'on');
  });

  assert.deepEqual(errors, [], 'nothing unexpected logged');
  console.log(`Web push checks passed (${passed.length}): RFC 8291 vector and round trip, VAPID, allowlist and keys, subscriptions, delivery and retries beside APNs, the test alert limit, dormancy, account deletion, install hint and alert state.`);
} finally {
  console.error = originalError;
  globalThis.fetch = originalFetch;
  delete globalThis.__webPush;
  rmSync(directory, { recursive: true, force: true });
}
