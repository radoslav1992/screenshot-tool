/**
 * Site health: uptime, SSL certificates, domain registration and broken links
 * for the sites behind monitors (src/lib/site-health.ts and its helpers).
 *
 * The certificate reader is checked against real TLS: certificates are built
 * here with node:crypto (DER by hand, signed with a fresh P-256 key), served
 * by a node:tls server, and read through the module's own ClientHello over a
 * stubbed `cloudflare:sockets` that bridges to it. Node's X509Certificate
 * reads the same bytes as a second opinion. The rest runs against SQLite with
 * every migration (and once without 0020), an in-memory KV, a mocked fetch
 * and a stubbed mail binding. No network calls, no real emails.
 *
 *   node scripts/site-health-check.mjs
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'site-health-check-'));
const passed = [];
const section = async (name, fn) => {
  await fn();
  passed.push(name);
  console.log(`ok    ${name}`);
};
const ORIGIN = 'https://app.easyscreencapture.test';
const DAY = 86_400_000;
const T0 = new Date('2026-10-08T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);
const iso = (ms) => at(ms).toISOString();

/* -------------------------------------------------------------------------- */
/* Bundles                                                                     */
/* -------------------------------------------------------------------------- */

const fx = (globalThis.__sh = { env: {}, connect: null, connects: [], fetches: [], routes: new Map(), mails: [] });
const STUBS = {
  'cloudflare:workers': 'export const env = globalThis.__sh.env;',
  'cloudflare:sockets': 'export const connect = (...args) => globalThis.__sh.connect(...args);',
  '@cloudflare/puppeteer': 'export default {};',
  '/lib/renderer.ts': 'export async function render() { throw new Error("no rendering here"); }',
};
const plugin = {
  name: 'site-health-stubs',
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|cloudflare:sockets|@cloudflare\/puppeteer)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js' }));
    for (const [suffix, contents] of Object.entries(STUBS)) {
      if (!suffix.startsWith('/')) continue;
      b.onLoad({ filter: new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, () => ({ contents, loader: 'js' }));
    }
  },
};
/** Everything under test in one bundle, so the sweeps, the summary and account deletion share one probe cache. */
const ENTRY = join(directory, 'entry.ts');
writeFileSync(
  ENTRY,
  [
    ['health', 'src/lib/site-health.ts'],
    ['summary', 'src/lib/site-health-summary.ts'],
    ['tls', 'src/lib/tls-probe.ts'],
    ['rdap', 'src/lib/rdap.ts'],
    ['links', 'src/lib/link-check.ts'],
    ['plans', 'src/lib/plans.ts'],
    ['deletion', 'src/lib/account-deletion.ts'],
  ]
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(join(root, path))};`)
    .join('\n'),
);
let bundles = 0;
/** A fresh copy, with its own per-isolate caches, as a new isolate would have. */
async function loadApp() {
  const result = await build({ entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [plugin], logLevel: 'silent' });
  const out = join(directory, `bundle-${++bundles}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

/* -------------------------------------------------------------------------- */
/* Databases, bindings, fetch                                                  */
/* -------------------------------------------------------------------------- */

function database({ migrated = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(join(root, 'migrations')).sort().filter((name) => name.endsWith('.sql'))) {
    if (!migrated && file >= '0020') continue;
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/** D1 over node:sqlite: each statement atomic, a batch one transaction, binds bounded as D1 bounds them. */
function d1(db) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => {
      assert.ok(values.length <= 100, 'D1 takes at most 100 bound parameters');
      assert.ok(values.every((value) => value !== undefined), `no undefined binds: ${sql.slice(0, 80)}`);
      return statement(sql, values);
    },
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
const RATE = {
  get: async (key, type) => {
    const value = kv.get(key);
    return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
  },
  put: async (key, value) => void kv.set(key, value),
};
const SHOTS = { list: async () => ({ objects: [], truncated: false }), delete: async () => {}, head: async () => null };

const BLOCKED = () => {
  throw new Error('proxy request failed, cannot connect to the specified address');
};

function world({ migrated = true } = {}) {
  const db = database({ migrated });
  for (const key of Object.keys(fx.env)) delete fx.env[key];
  Object.assign(fx.env, {
    DB: d1(db),
    RATE,
    SHOTS,
    EMAIL: { send: async (message) => void fx.mails.push(message) },
    EMAIL_FROM: 'Easy Screen Capture <noreply@easyscreencapture.test>',
    CAPTURE_HOST_DENYLIST: '',
    PUBLIC_SITE_URL: ORIGIN,
  });
  kv.clear();
  fx.mails.length = 0;
  fx.fetches.length = 0;
  fx.connects.length = 0;
  fx.routes.clear();
  fx.connect = BLOCKED;
  return db;
}

function addUser(db, id, plan = 'free', { trial = false } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, email, email_lower, name, plan, period_start, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)`).run(
    id,
    `${id}@example.test`,
    `${id}@example.test`,
    plan,
    now,
    now,
    now,
  );
  if (trial) {
    db.prepare(`INSERT INTO plan_trials (user_id, plan, started_at, ends_at) VALUES (?, 'pro', ?, ?)`).run(id, iso(-DAY), new Date(Date.now() + 10 * DAY).toISOString());
  }
}

let watchCount = 0;
function addWatch(db, { id = `wat_${++watchCount}`, user, url, notify = 1, status = 'active', created = iso(-30 * DAY + watchCount * 1000) }) {
  db.prepare(
    `INSERT INTO watches (id, user_id, label, url, host, device, width, height, mode, format, frequency, threshold, notify_email, status, next_run_at, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, 'desktop', 1440, 900, 'fullpage', 'png', 'daily', 1, ?, ?, ?, ?, ?)`,
  ).run(id, user, url, new URL(url).hostname, notify, status, iso(DAY), created, created);
  return id;
}

/** The mocked network: a handler per URL, every call recorded; anything unrouted fails as DNS would. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? {});
  fx.fetches.push({ url, method, headers, redirect: init.redirect });
  const route = fx.routes.get(url);
  if (!route) throw new TypeError('fetch failed');
  return route({ url, method, headers });
};
const respond = (status, { headers = {}, body = null } = {}) => () => new Response(body, { status, headers });
const route = (url, handler) => fx.routes.set(url, typeof handler === 'number' ? respond(handler) : handler);
const fetchesTo = (url) => fx.fetches.filter((call) => call.url === url);

/* -------------------------------------------------------------------------- */
/* Certificates, built by hand                                                 */
/* -------------------------------------------------------------------------- */

const derLength = (n) => {
  if (n < 0x80) return [n];
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
};
const tlv = (tag, content) => [tag, ...derLength(content.length), ...content];
const seq = (...parts) => tlv(0x30, parts.flat());
const set = (...parts) => tlv(0x31, parts.flat());
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift(0x80 | (v & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, out);
};
const ascii = (s) => [...Buffer.from(s, 'latin1')];
const utf8 = (s) => tlv(0x0c, [...Buffer.from(s, 'utf8')]);
const printable = (s) => tlv(0x13, ascii(s));
const bmp = (s) => tlv(0x1e, [...Buffer.from(s, 'utf16le').swap16()]);
const two = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
// RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
const time = (d) => (d.getUTCFullYear() >= 2050 ? tlv(0x18, ascii(`${d.getUTCFullYear()}${stamp(d)}`)) : tlv(0x17, ascii(`${two(d.getUTCFullYear() % 100)}${stamp(d)}`)));
const dn = (...attributes) => seq(...attributes.map(([id, value]) => set(seq(oid(id), value))));
const CN = '2.5.4.3';
const ORG = '2.5.4.10';
const COUNTRY = '2.5.4.6';
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const KEYS = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SPKI = [...KEYS.publicKey.export({ type: 'spki', format: 'der' })];
const KEY_PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const CA = dn([COUNTRY, printable('US')], [ORG, printable('Example Trust')], [CN, printable('Example Trust R1')]);

function makeCert({
  notBefore = at(-30 * DAY),
  notAfter = at(60 * DAY),
  subject = dn([CN, utf8('example.test')]),
  issuer = CA,
  dns = ['example.test', '*.example.test'],
  ips = [],
  san = true,
} = {}) {
  const names = [...dns.map((d) => tlv(0x82, ascii(d))), ...ips.map((ip) => tlv(0x87, ip.split('.').map(Number)))];
  const extensions = san ? [tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, seq(...names)))))] : [];
  const tbs = seq(tlv(0xa0, tlv(0x02, [2])), tlv(0x02, [1 + (bundles % 100)]), ECDSA_SHA256, issuer, seq(time(notBefore), time(notAfter)), subject, SPKI, ...extensions);
  const signature = [...sign('sha256', Buffer.from(tbs), KEYS.privateKey)];
  return Uint8Array.from(seq(tbs, ECDSA_SHA256, tlv(0x03, [0, ...signature])));
}
const pem = (der) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

/* TLS records, framed by hand: the server's first flight. */
const u24 = (n) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const record = (type, payload) => [type, 0x03, 0x03, payload.length >> 8, payload.length & 0xff, ...payload];
const message = (type, body) => [type, ...u24(body.length), ...body];
const serverHello = (version = 0x0303) => message(2, [version >> 8, version & 0xff, ...randomBytes(32), 0x00, 0xc0, 0x2b, 0x00]);
const certificateMessage = (...ders) => {
  const entries = ders.flatMap((der) => [...u24(der.length), ...der]);
  return message(11, [...u24(entries.length), ...entries]);
};
const helloDone = () => message(14, []);
const flight = (der) => Uint8Array.from(record(22, [...serverHello(), ...certificateMessage(der), ...helloDone()]));

/** A socket that answers with these chunks, then closes; or never answers. */
function scripted(chunks, { hang = false } = {}) {
  const state = { written: [], closed: 0 };
  const queue = chunks.map((chunk) => Uint8Array.from(chunk));
  const socket = {
    readable: new ReadableStream({
      pull(controller) {
        if (hang) return new Promise(() => {});
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    }),
    writable: new WritableStream({ write: (chunk) => void state.written.push(Uint8Array.from(chunk)) }),
    opened: Promise.resolve({}),
    closed: Promise.resolve(),
    close: async () => void state.closed++,
  };
  return { state, socket };
}
/** connect() answering every host with the flight for `der`, counting connections. */
function serveCertificate(der, sockets = []) {
  fx.connect = (address, options) => {
    fx.connects.push({ address, options });
    const made = scripted([flight(der)]);
    sockets.push(made.state);
    return made.socket;
  };
}

/** Parses a ClientHello back, field by field, checking every length against the bytes. */
function parseHello(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b[0], 0x16, 'a handshake record');
  assert.equal(b.readUInt16BE(1), 0x0301, 'the record version servers expect in a first hello');
  assert.equal(b.readUInt16BE(3), b.length - 5, 'the record length is the rest of the bytes');
  assert.equal(b[5], 0x01, 'a ClientHello');
  assert.equal(b.readUIntBE(6, 3), b.length - 9, 'the handshake length is the rest of the record');
  let p = 9;
  assert.equal(b.readUInt16BE(p), 0x0303, 'TLS 1.2');
  p += 2;
  const random = b.subarray(p, p + 32);
  p += 32;
  const session = b[p];
  p += 1 + session;
  const suitesLength = b.readUInt16BE(p);
  assert.equal(suitesLength % 2, 0);
  const suites = [];
  for (let i = 0; i < suitesLength; i += 2) suites.push(b.readUInt16BE(p + 2 + i));
  p += 2 + suitesLength;
  const compression = [...b.subarray(p + 1, p + 1 + b[p])];
  p += 1 + b[p];
  const extensionsLength = b.readUInt16BE(p);
  p += 2;
  assert.equal(p + extensionsLength, b.length, 'the extensions end the hello');
  const extensions = new Map();
  while (p < b.length) {
    const type = b.readUInt16BE(p);
    const length = b.readUInt16BE(p + 2);
    assert.ok(p + 4 + length <= b.length, `extension ${type} fits`);
    extensions.set(type, b.subarray(p + 4, p + 4 + length));
    p += 4 + length;
  }
  assert.equal(p, b.length);
  return { random, session, suites, compression, extensions };
}

/** A real TLS server on localhost, and a connect() that reaches it whatever host is asked for. */
async function tlsServer(der, options = {}) {
  const sockets = new Set();
  const server = tls.createServer({ key: KEY_PEM, cert: pem(der), ...options });
  server.on('tlsClientError', () => {});
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const closes = { count: 0 };
  fx.connect = (address, connectOptions) => {
    fx.connects.push({ address, options: connectOptions });
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    const { readable, writable } = Duplex.toWeb(socket);
    const opened = new Promise((resolve, reject) => {
      socket.once('connect', () => resolve({}));
      socket.once('error', reject);
    });
    opened.catch(() => {});
    return { readable, writable, opened, closed: new Promise((resolve) => socket.once('close', resolve)), close: async () => {
      closes.count++;
      socket.destroy();
    } };
  };
  return {
    port,
    closes,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The checks                                                                  */
/* -------------------------------------------------------------------------- */

try {
  let app = await loadApp();

  await section('plan tiers: uptime every 15 minutes from Plus, hourly on Free and Lite; SSL daily, domains and links weekly, 100 links a page', async () => {
    const { plans } = app;
    assert.deepEqual(plans.UPTIME_MINUTES, { free: 60, lite: 60, plus: 15, pro: 15, business: 15 });
    assert.equal(plans.uptimeMinutes('nonsense'), 60, 'an unknown plan reads as Free');
    assert.deepEqual([plans.SSL_CHECK_HOURS, plans.DOMAIN_CHECK_HOURS, plans.LINK_CHECK_HOURS, plans.LINKS_PER_PAGE], [24, 168, 168, 100]);
    for (const id of plans.PLAN_ORDER) {
      assert.ok(plans.PLANS[id].features.some((feature) => /uptime, SSL, domain & link checks/.test(feature.text)), `${id} lists the checks`);
      assert.match(plans.PLANS[id].description, plans.UPTIME_MINUTES[id] === 15 ? /uptime checks every 15 minutes/ : /hourly uptime checks/, `${id}'s description says how often`);
      assert.ok(plans.PLANS[id].features.some((feature) => feature.text.startsWith(plans.UPTIME_MINUTES[id] === 15 ? '15-minute uptime' : 'Hourly uptime')));
    }
  });

  /* ------------------------------------------------------------------------ */
  /* TLS                                                                       */
  /* ------------------------------------------------------------------------ */

  await section('TLS: the ClientHello is a well-formed TLS 1.2 hello with SNI, ECDHE/RSA suites, groups, point formats and signature algorithms', () => {
    const { tls: probe } = app;
    const random = Uint8Array.from({ length: 32 }, (_, i) => i);
    const hello = parseHello(probe.clientHello('Shop.Example.TEST.', random));
    assert.deepEqual([...hello.random], [...random]);
    assert.equal(hello.session, 0);
    for (const suite of [0xc02f, 0xc02b, 0xc030, 0xc02c, 0xcca8, 0x009c, 0x002f, 0x00ff]) assert.ok(hello.suites.includes(suite), suite.toString(16));
    assert.deepEqual(hello.compression, [0]);
    const sni = hello.extensions.get(0x0000);
    assert.equal(sni.readUInt16BE(0), sni.length - 2);
    assert.equal(sni[2], 0, 'a host_name entry');
    assert.equal(sni.subarray(5).toString(), 'shop.example.test', 'lowercased, without the trailing dot');
    assert.equal(sni.readUInt16BE(3), sni.length - 5);
    const groups = hello.extensions.get(0x000a);
    assert.deepEqual([...groups.subarray(2)].length, groups.readUInt16BE(0));
    assert.ok([0x001d, 0x0017].every((group) => groups.includes(group >> 8) && groups.indexOf(group & 0xff, 2) > 0));
    assert.deepEqual([...hello.extensions.get(0x000b)], [1, 0], 'uncompressed points');
    const algorithms = hello.extensions.get(0x000d);
    assert.equal(algorithms.readUInt16BE(0), algorithms.length - 2);
    const pairs = [];
    for (let i = 2; i < algorithms.length; i += 2) pairs.push(algorithms.readUInt16BE(i));
    for (const algorithm of [0x0403, 0x0804, 0x0401]) assert.ok(pairs.includes(algorithm));
    assert.ok(!hello.extensions.has(0x002b), 'no supported_versions: the server must answer in TLS 1.2, where the certificate is in the clear');
    assert.ok(!parseHello(probe.clientHello('203.0.113.7')).extensions.has(0x0000), 'no SNI for an address');
    assert.ok(!parseHello(probe.clientHello('2001:db8::1')).extensions.has(0x0000));
  });

  const leaf = makeCert({ notAfter: new Date('2027-01-15T12:30:45Z') });
  const longLived = makeCert({ notAfter: new Date('2051-06-01T00:00:00Z'), san: false, subject: dn([CN, utf8('legacy.example.test')]), issuer: dn([CN, bmp('Ünïcode CA')]) });
  const selfSigned = makeCert({ issuer: dn([CN, utf8('example.test')]) });

  await section('TLS: against a real TLS 1.2 server, the probe reads the leaf certificate it serves, and agrees with Node about it', async () => {
    const { tls: probe } = app;
    const server = await tlsServer(leaf, { maxVersion: 'TLSv1.2' });
    try {
      const result = await probe.probeCertificate('example.test', server.port);
      assert.equal(result.ok, true, JSON.stringify(result));
      const node = new X509Certificate(Buffer.from(leaf));
      assert.equal(result.certificate.notAfter.toISOString(), '2027-01-15T12:30:45.000Z');
      assert.equal(result.certificate.notAfter.getTime(), Date.parse(node.validTo));
      assert.equal(result.certificate.notBefore.getTime(), Date.parse(node.validFrom));
      assert.deepEqual(result.certificate.dnsNames, ['example.test', '*.example.test']);
      assert.equal(node.subjectAltName, 'DNS:example.test, DNS:*.example.test');
      assert.deepEqual(result.certificate.issuer, { commonName: 'Example Trust R1', organization: 'Example Trust' });
      assert.match(node.issuer, /O=Example Trust/);
      assert.equal(probe.issuerName(result.certificate), 'Example Trust (Example Trust R1)');
      assert.equal(result.certificate.selfSigned, false);
      assert.equal(result.version, 0x0303);
      assert.deepEqual(fx.connects.at(-1).options, { secureTransport: 'off', allowHalfOpen: false }, 'a plain socket: the hello is ours');
      assert.equal(server.closes.count, 1, 'the socket is closed once the certificate is read');
      for (const host of ['example.test', 'shop.example.test', 'a.b.example.test', 'example.org', 'xexample.test']) {
        assert.equal(probe.certificateCovers(result.certificate, host), Boolean(node.checkHost(host)), `names: ${host}`);
      }
    } finally {
      server.close();
    }
  });

  await section('TLS: a TLS 1.3-only server answers with an alert, which is a failure with a plain reason, never a crash', async () => {
    const { tls: probe } = app;
    const server = await tlsServer(leaf, { minVersion: 'TLSv1.3' });
    try {
      const result = await probe.probeCertificate('example.test', server.port);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'alert');
      assert.equal(result.alert, 70, 'protocol_version');
      assert.match(result.detail, /only accepts TLS 1\.3/);
      assert.equal(server.closes.count, 1);
    } finally {
      server.close();
    }
  });

  await section('X.509: GeneralizedTime, a certificate with no subjectAltName (common name only), BMPString names and self-signed issuers', () => {
    const { tls: probe } = app;
    const parsed = probe.parseCertificate(longLived);
    assert.equal(parsed.notAfter.toISOString(), '2051-06-01T00:00:00.000Z', 'GeneralizedTime from 2050');
    assert.equal(parsed.notAfter.getTime(), Date.parse(new X509Certificate(Buffer.from(longLived)).validTo));
    assert.deepEqual(parsed.dnsNames, []);
    assert.equal(parsed.subject.commonName, 'legacy.example.test');
    assert.equal(parsed.issuer.commonName, 'Ünïcode CA');
    assert.ok(probe.certificateCovers(parsed, 'legacy.example.test'), 'no SAN at all: the common name is matched');
    assert.ok(!probe.certificateCovers(parsed, 'www.legacy.example.test'));
    assert.ok(probe.certificateCovers({ ...probe.parseCertificate(leaf), subject: { commonName: 'other.test' } }, 'example.test'));
    assert.ok(!probe.certificateCovers({ ...probe.parseCertificate(leaf) }, 'other.test'), 'with SAN, the common name is never used');
    assert.equal(probe.parseCertificate(selfSigned).selfSigned, true);
    const withIp = probe.parseCertificate(makeCert({ dns: [], ips: ['203.0.113.9'] }));
    assert.deepEqual(withIp.ipAddresses, ['203.0.113.9']);
    assert.ok(probe.certificateCovers(withIp, '203.0.113.9'));
    assert.ok(!probe.certificateCovers(withIp, '203.0.113.10'));
  });

  await section('TLS: records are reassembled across reads and records, alerts and non-TLS answers are told apart, and nothing past the cap is read', async () => {
    const { tls: probe } = app;
    const bytes = flight(leaf);
    for (let cut = 1; cut < bytes.length; cut += 7) {
      assert.equal(probe.readServerHandshake(bytes.subarray(0, cut)).kind, 'more', `a valid start of ${cut} bytes needs more`);
    }
    const read = probe.readServerHandshake(bytes);
    assert.equal(read.kind, 'certificate');
    assert.deepEqual([...read.der], [...leaf]);
    // The Certificate message split over two records, and the hello in a record of its own.
    const certMessage = certificateMessage(leaf);
    const split = Uint8Array.from([...record(22, serverHello()), ...record(22, certMessage.slice(0, 100)), ...record(22, certMessage.slice(100))]);
    assert.deepEqual([...probe.readServerHandshake(split).der], [...leaf]);
    assert.deepEqual(probe.readServerHandshake(Uint8Array.from(record(21, [2, 40]))), { kind: 'alert', level: 2, description: 40 });
    assert.equal(probe.readServerHandshake(new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n')).kind, 'error');
    assert.equal(probe.readServerHandshake(Uint8Array.from([22, 3, 3, 0xff, 0xff])).kind, 'error', 'a record larger than TLS allows');
    assert.equal(probe.readServerHandshake(Uint8Array.from(record(22, certMessage))).kind, 'error', 'a certificate before the hello');
    assert.equal(probe.readServerHandshake(Uint8Array.from(record(22, [...serverHello(), ...helloDone()]))).kind, 'error', 'no certificate at all');
    assert.equal(probe.readServerHandshake(Uint8Array.from(record(22, serverHello(0x0200)))).kind, 'error', 'SSL 2 is not read');
    const badList = message(11, [...u24(10), ...u24(500), 1, 2, 3, 4]);
    assert.equal(probe.readServerHandshake(Uint8Array.from(record(22, [...serverHello(), ...badList]))).kind, 'error', 'a certificate longer than its list');

    // Byte by byte through the socket reader, and the other ways a read ends.
    let made = scripted([...bytes].map((byte) => [byte]));
    fx.connect = () => made.socket;
    let result = await probe.probeCertificate('example.test');
    assert.equal(result.ok, true, 'one byte per read');
    assert.equal(made.state.closed, 1);
    assert.deepEqual([...made.state.written[0].subarray(0, 3)], [0x16, 0x03, 0x01], 'the hello went out first');
    made = scripted([bytes.subarray(0, 40)]);
    result = await probe.probeCertificate('example.test');
    assert.deepEqual([result.ok, result.reason, made.state.closed], [false, 'closed', 1]);
    made = scripted([record(22, serverHello()), ...Array.from({ length: 10 }, () => record(22, [11, ...u24(200_000), ...new Array(16_000).fill(1)]))]);
    result = await probe.probeCertificate('example.test');
    assert.deepEqual([result.ok, result.reason], [false, 'too_large'], 'reading stops at 64 KB');
    made = scripted([], { hang: true });
    const started = Date.now();
    result = await probe.probeCertificate('example.test', 443, { timeoutMs: 50, maxBytes: 65_536 });
    assert.deepEqual([result.ok, result.reason, made.state.closed], [false, 'timeout', 1], 'a server that never answers times out, and is closed');
    assert.ok(Date.now() - started < 1000);
    fx.connect = BLOCKED;
    result = await probe.probeCertificate('example.test');
    assert.deepEqual([result.ok, result.reason], [false, 'blocked']);
    assert.match(result.detail, /often Cloudflare/);
    made = scripted([record(22, [...serverHello(), ...certificateMessage(leaf.slice(0, 200))])]);
    fx.connect = () => made.socket;
    result = await probe.probeCertificate('example.test');
    assert.deepEqual([result.ok, result.reason], [false, 'malformed'], 'a cut-off certificate is malformed, not a crash');
  });

  await section('X.509: every truncation and thousands of corrupted copies fail with CertificateError, never anything else', () => {
    const { tls: probe } = app;
    for (let cut = 0; cut < leaf.length; cut++) {
      assert.throws(() => probe.parseCertificate(leaf.subarray(0, cut)), (error) => error.name === 'CertificateError', `cut at ${cut}`);
    }
    let parsedAnyway = 0;
    const started = Date.now();
    for (let i = 0; i < 3000; i++) {
      const copy = Uint8Array.from(leaf);
      for (let flips = 1 + (i % 4); flips > 0; flips--) copy[(i * 7919 + flips * 104_729) % copy.length] = (i * 31 + flips) & 0xff;
      try {
        probe.parseCertificate(copy);
        parsedAnyway++;
      } catch (error) {
        assert.equal(error.name, 'CertificateError', `corruption ${i}: ${error}`);
      }
      // The record reader never throws on noise either.
      const noise = Uint8Array.from(randomBytes(64 + (i % 200)));
      if (i % 3 === 0) noise[0] = 22;
      if (i % 3 === 0) noise[1] = 3;
      assert.ok(['more', 'error', 'alert', 'certificate'].includes(probe.readServerHandshake(noise).kind));
    }
    assert.ok(Date.now() - started < 5000, 'and quickly');
    assert.ok(parsedAnyway < 3000);
  });

  /* ------------------------------------------------------------------------ */
  /* SSL judgement                                                             */
  /* ------------------------------------------------------------------------ */

  await section('SSL: ok, expiring at 14 days, expired, not yet valid, the wrong name, untrusted, and the fallbacks when the certificate cannot be read', async () => {
    const { health, tls: probe } = app;
    const cert = probe.parseCertificate(makeCert({ notBefore: at(-10 * DAY), notAfter: at(60 * DAY) }));
    const ok = health.assessCertificate(cert, 'shop.example.test', T0);
    assert.deepEqual([ok.status, ok.validTo, ok.issuer], ['ok', iso(60 * DAY), 'Example Trust (Example Trust R1)']);
    assert.match(ok.detail, /^Valid until 7 Dec 2026, 60 days from now, issued by Example Trust/);
    assert.equal(health.assessCertificate(cert, 'shop.example.test', at(46 * DAY)).status, 'expiring', '14 days left');
    assert.equal(health.assessCertificate(cert, 'shop.example.test', at(45 * DAY)).status, 'ok', '15 days left');
    assert.match(health.assessCertificate(cert, 'shop.example.test', at(50 * DAY)).detail, /expires in 10 days, on 7 Dec 2026/);
    assert.equal(health.assessCertificate(cert, 'shop.example.test', at(60 * DAY)).status, 'expired');
    assert.equal(health.assessCertificate(cert, 'shop.example.test', at(-11 * DAY)).status, 'invalid', 'not valid yet');
    const wrong = health.assessCertificate(cert, 'shop.other.test', T0);
    assert.equal(wrong.status, 'invalid');
    assert.match(wrong.detail, /is for example\.test, \*\.example\.test, not shop\.other\.test/);

    const read = { ok: true, certificate: cert, version: 0x0303 };
    assert.equal(health.judgeSsl('shop.example.test', read, 'trusted', T0).status, 'ok');
    assert.equal(health.judgeSsl('shop.other.test', read, 'trusted', T0).status, 'ok', 'a fetch that went through has already checked the name');
    const untrusted = health.judgeSsl('shop.example.test', { ok: true, certificate: probe.parseCertificate(selfSigned), version: 0x0303 }, 'untrusted', T0);
    assert.deepEqual([untrusted.status, untrusted.detail], ['invalid', "Browsers don't trust this certificate: it is self-signed."]);
    const unread = { ok: false, reason: 'alert', detail: 'the server only accepts TLS 1.3, which keeps the certificate encrypted', alert: 70 };
    const fallback = health.judgeSsl('shop.example.test', unread, 'trusted', T0);
    assert.deepEqual([fallback.status, fallback.validTo], ['ok', null], 'HTTPS works: valid, expiry unknown');
    assert.match(fallback.detail, /HTTPS works and the certificate is trusted\. Its expiry date couldn't be read: the server only accepts TLS 1\.3/);
    assert.equal(health.judgeSsl('shop.example.test', unread, 'untrusted', T0).status, 'invalid');
    assert.equal(health.judgeSsl('shop.example.test', unread, 'unreachable', T0).status, 'unknown');

    world();
    route('https://bad.example.test/', 526);
    assert.equal(await health.httpsTrust('https://bad.example.test/'), 'untrusted', 'a 526 from the edge');
    fx.routes.set('https://tls.example.test/', () => {
      throw new TypeError('fetch failed', { cause: new Error('certificate has expired') });
    });
    assert.equal(await health.httpsTrust('https://tls.example.test/'), 'untrusted', 'a TLS error');
    assert.equal(await health.httpsTrust('https://gone.example.test/'), 'unreachable', 'no answer');
    route('https://good.example.test/', respond(301, { headers: { location: 'https://elsewhere.test/' } }));
    assert.equal(await health.httpsTrust('https://good.example.test/'), 'trusted', 'any answer, a redirect included, means the TLS held');
    assert.equal(fetchesTo('https://good.example.test/')[0].method, 'HEAD');
    assert.equal(fetchesTo('https://elsewhere.test/').length, 0, 'and it is not followed');
    assert.equal(await health.httpsTrust('https://10.0.0.8/'), 'unreachable');
    assert.ok(!fx.fetches.some((call) => call.url.includes('10.0.0.8')), 'a private address is never asked');

    // Plain HTTP: HTTPS on the same host is tried; nothing there is "no HTTPS", not an error.
    let reading = await health.checkSsl('http://plain.example.test', T0);
    assert.equal(reading.status, 'no_https');
    assert.match(reading.detail, /monitored over plain HTTP and doesn't answer over HTTPS/);
    route('https://both.example.test/', 200);
    reading = await health.checkSsl('http://both.example.test', T0);
    assert.equal(reading.status, 'ok');
    assert.match(reading.detail, /^Monitored over HTTP, but HTTPS works too\./);
    serveCertificate(makeCert({ dns: ['other.test'] }));
    route('https://half.example.test/', 526);
    reading = await health.checkSsl('http://half.example.test', T0);
    assert.equal(reading.status, 'no_https', 'a broken HTTPS on an HTTP site is not alerted as an SSL problem');
    assert.match(reading.detail, /HTTPS on this host isn't set up properly/);
    assert.equal((await health.checkSsl('https://192.168.1.1', T0)).status, 'unknown');

    assert.equal(health.sslAlertKey({ status: 'expiring', validTo: iso(10 * DAY) }, T0), `expiring14:${iso(10 * DAY)}`);
    assert.equal(health.sslAlertKey({ status: 'expiring', validTo: iso(3 * DAY) }, T0), `expiring3:${iso(3 * DAY)}`);
    assert.equal(health.sslAlertKey({ status: 'expired', validTo: iso(-DAY) }, T0), `expired:${iso(-DAY)}`);
    assert.equal(health.sslAlertKey({ status: 'invalid', validTo: null }, T0), 'invalid');
    for (const status of ['ok', 'no_https', 'unknown']) assert.equal(health.sslAlertKey({ status, validTo: null }, T0), null);
  });

  /* ------------------------------------------------------------------------ */
  /* RDAP                                                                      */
  /* ------------------------------------------------------------------------ */

  const BOOTSTRAP = {
    version: '1.0',
    services: [
      [['com', 'net'], ['http://rdap.verisign.test/com/v1', 'https://rdap.verisign.test/com/v1/']],
      [['uk'], ['https://rdap.nominet.test/uk']],
      [['de'], ['https://rdap.denic.test/']],
      [['at'], ['https://rdap.nic.at.test/']],
      [['test'], ['https://rdap.registry.test/']],
    ],
  };
  const rdapDomain = (name, { expires, registrar = 'Example Registrar, Inc.', status = ['client transfer prohibited'] } = {}) =>
    respond(200, {
      headers: { 'content-type': 'application/rdap+json' },
      body: JSON.stringify({
        objectClassName: 'domain',
        ldhName: name,
        status,
        events: [{ eventAction: 'registration', eventDate: '2015-02-01T00:00:00Z' }, ...(expires ? [{ eventAction: 'expiration', eventDate: expires }] : [])],
        entities: [{ objectClassName: 'entity', roles: ['registrar'], handle: '9999', vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', registrar]]] }],
      }),
    });

  await section('RDAP: the IANA bootstrap (cached in KV for a day), registrable domains, multi-label suffixes, a registry without expiry dates and network failures', async () => {
    const { rdap } = app;
    assert.deepEqual(rdap.registrableCandidates('www.example.com'), ['example.com', 'www.example.com']);
    assert.deepEqual(rdap.registrableCandidates('example.com.'), ['example.com']);
    assert.deepEqual(rdap.registrableCandidates('shop.example.co.uk'), ['example.co.uk'], 'a known two-label suffix: one lookup');
    assert.deepEqual(rdap.registrableCandidates('a.b.example.com.au'), ['example.com.au']);
    for (const host of ['203.0.113.5', '[2001:db8::1]', 'localhost', '-bad-.com']) assert.deepEqual(rdap.registrableCandidates(host), [], host);
    assert.deepEqual(rdap.bootstrapMap(BOOTSTRAP).com, 'https://rdap.verisign.test/com/v1/', 'https://, with a trailing slash');
    assert.deepEqual(rdap.bootstrapMap({ services: 'nope' }), {});

    world();
    rdap.forgetBootstrap();
    route(rdap.BOOTSTRAP_URL, respond(200, { body: JSON.stringify(BOOTSTRAP) }));
    route('https://rdap.verisign.test/com/v1/domain/example.com', rdapDomain('example.com', { expires: iso(200 * DAY) }));
    let reading = await rdap.checkDomain('www.example.com', T0);
    assert.deepEqual(
      { ...reading },
      { status: 'ok', domain: 'example.com', expiresAt: iso(200 * DAY), registrar: 'Example Registrar, Inc.', detail: 'example.com is registered until 26 Apr 2027.' },
    );
    assert.equal(fetchesTo(rdap.BOOTSTRAP_URL).length, 1);
    assert.equal(fetchesTo('https://rdap.verisign.test/com/v1/domain/www.example.com').length, 0, 'found on the first try');
    assert.match(fetchesTo('https://rdap.verisign.test/com/v1/domain/example.com')[0].headers.get('accept'), /application\/rdap\+json/);
    assert.ok(kv.has(rdap.BOOTSTRAP_KEY), 'the bootstrap is kept in KV');
    rdap.forgetBootstrap();
    await rdap.checkDomain('example.com', T0);
    assert.equal(fetchesTo(rdap.BOOTSTRAP_URL).length, 1, 'a new isolate reads it from KV, not IANA');
    await rdap.checkDomain('example.com', at(2 * DAY));
    assert.equal(fetchesTo(rdap.BOOTSTRAP_URL).length, 2, 'after a day it is fetched again');

    route('https://rdap.verisign.test/com/v1/domain/soon.com', rdapDomain('soon.com', { expires: iso(20 * DAY) }));
    reading = await rdap.checkDomain('soon.com', T0);
    assert.equal(reading.status, 'expiring');
    assert.match(reading.detail, /^soon\.com expires in 20 days, on 28 Oct 2026\. Renew it with Example Registrar, Inc\./);
    route('https://rdap.verisign.test/com/v1/domain/late.com', rdapDomain('late.com', { expires: iso(-2 * DAY) }));
    assert.equal((await rdap.checkDomain('late.com', T0)).status, 'expired');
    route('https://rdap.verisign.test/com/v1/domain/held.com', rdapDomain('held.com', { status: ['redemption period'] }));
    assert.equal((await rdap.checkDomain('held.com', T0)).status, 'expired', 'a domain in redemption has lapsed whatever its dates say');

    // Multi-label suffixes: known ones cost one lookup; unknown ones are found by the registry's 404.
    route('https://rdap.nominet.test/uk/domain/example.co.uk', rdapDomain('example.co.uk', { expires: iso(400 * DAY), registrar: 'Nominet Registrar' }));
    reading = await rdap.checkDomain('shop.example.co.uk', T0);
    assert.deepEqual([reading.status, reading.domain, reading.registrar], ['ok', 'example.co.uk', 'Nominet Registrar']);
    assert.equal(fx.fetches.filter((call) => call.url.startsWith('https://rdap.nominet.test/')).length, 1);
    route('https://rdap.nic.at.test/domain/gv.at', 404);
    route('https://rdap.nic.at.test/domain/agency.gv.at', rdapDomain('agency.gv.at', { expires: iso(90 * DAY) }));
    reading = await rdap.checkDomain('www.agency.gv.at', T0);
    assert.deepEqual([reading.status, reading.domain], ['ok', 'agency.gv.at']);

    // .de publishes no expiry: said plainly, and not retried tomorrow.
    route('https://rdap.denic.test/domain/beispiel.de', rdapDomain('beispiel.de', { registrar: 'DENIC Member' }));
    reading = await rdap.checkDomain('www.beispiel.de', T0);
    assert.deepEqual([reading.status, reading.expiresAt, reading.registrar, reading.retry], ['unknown', null, 'DENIC Member', undefined]);
    assert.equal(reading.detail, "The .de registry doesn't publish when domains expire, so the expiry date can't be checked.");

    reading = await rdap.checkDomain('down.net', T0);
    assert.deepEqual([reading.status, reading.retry], ['unknown', true], 'a registry that cannot be reached is asked again tomorrow');
    assert.match(reading.detail, /couldn't be reached; it is asked again tomorrow/);
    route('https://rdap.verisign.test/com/v1/domain/busy.com', 429);
    assert.match((await rdap.checkDomain('busy.com', T0)).detail, /limiting lookups/);
    reading = await rdap.checkDomain('example.museum', T0);
    assert.match(reading.detail, /\.museum registry doesn't offer RDAP lookups/);
    assert.equal((await rdap.checkDomain('203.0.113.5', T0)).status, 'unknown');

    // One lookup for every host on the same domain in a sweep.
    const asked = new Map();
    const before = fetchesTo('https://rdap.verisign.test/com/v1/domain/example.com').length;
    await Promise.all(['www.example.com', 'shop.example.com', 'example.com'].map((host) => rdap.checkDomain(host, T0, asked)));
    assert.equal(fetchesTo('https://rdap.verisign.test/com/v1/domain/example.com').length, before + 1);

    // The bootstrap down: rdap.org stands in.
    world();
    rdap.forgetBootstrap();
    route('https://rdap.org/domain/example.com', rdapDomain('example.com', { expires: iso(100 * DAY) }));
    reading = await rdap.checkDomain('example.com', T0);
    assert.equal(reading.status, 'ok', 'via rdap.org');
    assert.equal(fetchesTo(rdap.BOOTSTRAP_URL).length, 1);
    rdap.forgetBootstrap();
  });

  /* ------------------------------------------------------------------------ */
  /* Uptime                                                                    */
  /* ------------------------------------------------------------------------ */

  await section('uptime: up, down (no answer, timeout, TLS failure, 5xx), "up but erroring" (4xx), bot checks count as up', async () => {
    const { health } = app;
    world();
    route('https://up.example.test/', 200);
    route('https://five.example.test/', 503);
    route('https://four.example.test/', 404);
    route('https://cf.example.test/', respond(403, { headers: { 'cf-mitigated': 'challenge' } }));
    route('https://moment.example.test/', respond(503, { headers: { 'content-type': 'text/html' }, body: '<title>Just a moment...</title>' }));
    route('https://edge.example.test/', 526);
    fx.routes.set('https://slow.example.test/', () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    fx.routes.set('https://tls.example.test/', () => {
      throw new TypeError('fetch failed', { cause: new Error('unable to verify the first certificate; SSL routines') });
    });
    route('https://hop.example.test/', respond(302, { headers: { location: 'http://127.0.0.1/admin' } }));
    const check = async (url) => {
      const reading = await health.checkUptime(url);
      return [reading.state, reading.code, reading.detail];
    };
    assert.deepEqual((await check('https://up.example.test/')).slice(0, 2), ['up', 200]);
    assert.deepEqual(await check('https://five.example.test/'), ['down', 503, 'The site answers with a server error (HTTP 503)']);
    assert.deepEqual(await check('https://four.example.test/'), ['error', 404, 'The site answers, but with HTTP 404 (not found)']);
    assert.deepEqual((await check('https://cf.example.test/')).slice(0, 2), ['up', 403], 'a bot check is the site answering');
    assert.deepEqual((await check('https://moment.example.test/')).slice(0, 2), ['up', 503]);
    assert.deepEqual(await check('https://edge.example.test/'), ['down', 526, "The site's certificate isn't valid (HTTP 526)"]);
    assert.deepEqual(await check('https://slow.example.test/'), ['down', null, 'No answer within 10 seconds']);
    assert.deepEqual(await check('https://tls.example.test/'), ['down', null, 'The secure connection failed (a certificate or TLS error)']);
    assert.deepEqual(await check('https://nowhere.example.test/'), ['down', null, "The site can't be reached (DNS or connection failure)"]);
    assert.deepEqual(await check('https://hop.example.test/'), ['error', null, "The page redirects somewhere that can't be checked"]);
    assert.ok(!fx.fetches.some((call) => call.url.includes('127.0.0.1')), 'a redirect to a private address is never followed');
    const agents = fx.fetches.map((call) => call.headers.get('user-agent'));
    assert.ok(agents.every((agent) => /EasyScreenCapture-SiteHealth\/1; \+https:\/\/easyscreencapture\.com/.test(agent)), 'it says what is asking');
    assert.ok(fx.fetches.every((call) => !call.headers.has('cookie') && !call.headers.has('authorization')), 'and sends no credentials');
    assert.ok(fx.fetches.every((call) => call.redirect === 'manual'), 'every hop is checked by hand');

    // The rules on their own.
    const site = { uptime_fails: 0, uptime_down_since: null, uptime_incident_id: null };
    const down = { state: 'down', code: 503, ms: 20, detail: 'x' };
    const up = { state: 'up', code: 200, ms: 20, detail: 'y' };
    let step = health.uptimeStep(site, down, T0);
    assert.deepEqual(step, { fails: 1, downSince: iso(0) }, 'one down check is not an incident');
    step = health.uptimeStep({ ...site, uptime_fails: 1, uptime_down_since: iso(0) }, down, at(15 * 60_000));
    assert.deepEqual(step, { fails: 2, downSince: iso(0), open: { startedAt: iso(0) } }, 'the second opens one, dated from the first');
    step = health.uptimeStep({ uptime_fails: 2, uptime_down_since: iso(0), uptime_incident_id: 'inc_1' }, down, at(30 * 60_000));
    assert.deepEqual(step, { fails: 3, downSince: iso(0) }, 'and only one');
    assert.deepEqual(health.uptimeStep({ uptime_fails: 3, uptime_down_since: iso(0), uptime_incident_id: 'inc_1' }, up, T0), { fails: 0, downSince: null, close: true });
    assert.deepEqual(health.uptimeStep({ uptime_fails: 3, uptime_down_since: iso(0), uptime_incident_id: 'inc_1' }, { ...up, state: 'error' }, T0), { fails: 0, downSince: null, close: true }, 'a 4xx is not downtime');
    assert.deepEqual(health.uptimeStep({ ...site, uptime_fails: 1, uptime_down_since: iso(0) }, up, T0), { fails: 0, downSince: null });

    const { summary } = app;
    assert.equal(summary.uptimePct(0, 0), null);
    assert.equal(summary.uptimePct(4, 0), 100);
    assert.equal(summary.uptimePct(4, 2), 50);
    assert.equal(summary.uptimePct(2000, 1), 99.95);
    assert.equal(summary.uptimePct(3, 1), 66.67);
    assert.equal(health.nextUptimeAt(new Date('2026-10-08T10:00:00Z'), 15), '2026-10-08T10:15:00.000Z');
    assert.equal(health.nextUptimeAt(new Date('2026-10-08T10:07:12Z'), 15), '2026-10-08T10:15:00.000Z');
    assert.equal(health.nextUptimeAt(new Date('2026-10-08T10:00:00Z'), 60), '2026-10-08T11:00:00.000Z');
    assert.equal(health.nextUptimeAt(new Date('2026-10-08T10:59:59Z'), 60), '2026-10-08T11:00:00.000Z');
  });

  await section('the site list follows active monitors: one row per account and origin, its oldest page, stopped when nobody watches it', async () => {
    const { health } = app;
    const db = world();
    for (const url of [
      'https://example.com/',
      'https://www.example.com/a/b?c=1',
      'http://example.com:8080/x',
      'https://xn--bcher-kva.example/',
      'https://example.com/?q=/x',
      'https://[2001:db8::1]:8443/p',
      'https://example.com',
    ]) {
      const stored = new URL(url).toString();
      assert.equal(db.prepare(`SELECT ${health.originSql('?1')} AS o`).get(stored).o, new URL(stored).origin, `originSql(${stored})`);
    }
    addUser(db, 'ana', 'pro');
    addUser(db, 'bob', 'free');
    addWatch(db, { id: 'a1', user: 'ana', url: 'https://shop.example.test/pricing', created: iso(-3 * DAY) });
    addWatch(db, { id: 'a2', user: 'ana', url: 'https://shop.example.test/', created: iso(-5 * DAY) });
    addWatch(db, { id: 'a3', user: 'ana', url: 'https://blog.example.test/post', created: iso(-1 * DAY) });
    addWatch(db, { id: 'a4', user: 'ana', url: 'https://paused.example.test/', status: 'paused' });
    addWatch(db, { id: 'b1', user: 'bob', url: 'https://shop.example.test/cart' });
    let sync = await health.syncSites(T0);
    assert.deepEqual(sync, { sites: 3, stopped: 0, pages: 4 });
    const sites = () => db.prepare(`SELECT user_id, origin, url, active FROM site_health_sites ORDER BY user_id, origin`).all().map((row) => ({ ...row }));
    assert.deepEqual(sites(), [
      { user_id: 'ana', origin: 'https://blog.example.test', url: 'https://blog.example.test/post', active: 1 },
      { user_id: 'ana', origin: 'https://shop.example.test', url: 'https://shop.example.test/', active: 1 },
      { user_id: 'bob', origin: 'https://shop.example.test', url: 'https://shop.example.test/cart', active: 1 },
    ]);
    assert.deepEqual(await health.syncSites(T0), { sites: 0, stopped: 0, pages: 0 }, 'nothing changes, nothing is written');
    db.prepare(`UPDATE watches SET status = 'paused' WHERE id = 'a2'`).run();
    sync = await health.syncSites(T0);
    assert.equal(sync.sites, 1, 'the next-oldest page takes over');
    assert.equal(sites()[1].url, 'https://shop.example.test/pricing');
    db.prepare(`UPDATE watches SET status = 'paused' WHERE id = 'a3'`).run();
    db.prepare(`UPDATE site_health_sites SET uptime_incident_id = 'inc_x' WHERE origin = 'https://blog.example.test'`).run();
    db.prepare(`INSERT INTO site_uptime_incidents (id, user_id, origin, started_at) VALUES ('inc_x', 'ana', 'https://blog.example.test', ?)`).run(iso(-DAY));
    sync = await health.syncSites(at(DAY));
    assert.equal(sync.stopped, 1);
    assert.equal(sites()[0].active, 0, 'paused everywhere: no longer checked');
    assert.equal(db.prepare(`SELECT ended_at FROM site_uptime_incidents WHERE id = 'inc_x'`).get().ended_at, iso(DAY), 'its open incident ends, with no email');
    db.prepare(`UPDATE watches SET status = 'active' WHERE id = 'a3'`).run();
    db.prepare(`UPDATE site_health_sites SET uptime_next_at = ? WHERE origin = 'https://blog.example.test'`).run(iso(-5 * DAY));
    await health.syncSites(at(2 * DAY));
    const back = db.prepare(`SELECT active, uptime_next_at FROM site_health_sites WHERE origin = 'https://blog.example.test'`).get();
    assert.deepEqual({ ...back }, { active: 1, uptime_next_at: iso(2 * DAY) }, 'resumed: checked again straight away');
    assert.equal(fx.mails.length, 0);
  });

  await section('uptime sweeps: one request per site for every account, each account its own results; 15 minutes on Plus and up and during a Pro trial, hourly below', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'free1', 'free');
    addUser(db, 'plus1', 'plus');
    addUser(db, 'trial1', 'free', { trial: true });
    addUser(db, 'lite1', 'lite');
    for (const user of ['free1', 'plus1', 'trial1', 'lite1']) addWatch(db, { user, url: 'https://shared.example.test/' });
    addWatch(db, { user: 'plus1', url: 'https://solo.example.test/' });
    route('https://shared.example.test/', 200);
    route('https://solo.example.test/', 200);
    await health.syncSites(T0);
    let result = await health.runUptimeChecks(ORIGIN, T0);
    assert.deepEqual({ ...result }, { due: 5, checked: 5, fetched: 2, down: 0, opened: 0, closed: 0, backlog: 0 });
    assert.equal(fetchesTo('https://shared.example.test/').length, 1, 'four accounts, one request');
    const next = Object.fromEntries(db.prepare(`SELECT user_id || ' ' || origin AS k, uptime_next_at FROM site_health_sites`).all().map((row) => [row.k, row.uptime_next_at]));
    assert.equal(next['free1 https://shared.example.test'], '2026-10-08T11:00:00.000Z');
    assert.equal(next['lite1 https://shared.example.test'], '2026-10-08T11:00:00.000Z');
    assert.equal(next['plus1 https://shared.example.test'], '2026-10-08T10:15:00.000Z');
    assert.equal(next['trial1 https://shared.example.test'], '2026-10-08T10:15:00.000Z', 'a Pro trial counts');
    const hours = db.prepare(`SELECT user_id, hour, checks, down, total_ms >= 0 AS timed FROM site_uptime_hourly ORDER BY user_id, origin`).all();
    assert.equal(hours.length, 5, 'a rollup per account');
    assert.ok(hours.every((row) => row.hour === '2026-10-08T10:00:00.000Z' && row.checks === 1 && row.down === 0 && row.timed === 1));

    result = await health.runUptimeChecks(ORIGIN, at(15 * 60_000));
    assert.deepEqual([result.due, result.checked], [3, 3], 'at a quarter past, only the 15-minute sites');
    assert.equal(db.prepare(`SELECT checks FROM site_uptime_hourly WHERE user_id = 'plus1' AND origin = 'https://shared.example.test'`).get().checks, 2, 'same hour, same row');
    assert.equal((await health.runUptimeChecks(ORIGIN, at(16 * 60_000))).due, 0);

    // Two ticks at once take each site once.
    db.prepare(`UPDATE site_health_sites SET uptime_next_at = ?`).run(iso(0));
    const [first, second] = await Promise.all([health.runUptimeChecks(ORIGIN, at(60 * 60_000)), health.runUptimeChecks(ORIGIN, at(60 * 60_000))]);
    assert.equal(first.checked + second.checked, 5);

    // A tick takes at most UPTIME_PER_TICK; the rest wait for the next.
    const many = world();
    addUser(many, 'big', 'business');
    const count = health.UPTIME_PER_TICK + 5;
    many.exec('BEGIN');
    for (let i = 0; i < count; i++) addWatch(many, { user: 'big', url: `https://s${i}.example.test/` });
    many.exec('COMMIT');
    await health.syncSites(T0);
    result = await health.runUptimeChecks(ORIGIN, T0);
    assert.deepEqual([result.due, result.checked, result.backlog], [count, health.UPTIME_PER_TICK, 5]);
    result = await health.runUptimeChecks(ORIGIN, T0);
    assert.deepEqual([result.due, result.checked, result.backlog], [5, 5, 0]);
  });

  await section('incidents: open after two down checks, close on the first up one, one email each way for owners with email alerts on, none for the rest', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'loud', 'pro');
    addUser(db, 'quiet', 'pro');
    addWatch(db, { id: 'wl', user: 'loud', url: 'https://flaky.example.test/', notify: 1 });
    addWatch(db, { id: 'wq', user: 'quiet', url: 'https://flaky.example.test/', notify: 0 });
    await health.syncSites(T0);
    route('https://flaky.example.test/', 503);
    const tick = (minutes) => health.runUptimeChecks(ORIGIN, at(minutes * 60_000));
    let result = await tick(0);
    assert.deepEqual([result.down, result.opened, fx.mails.length], [2, 0, 0], 'one down check: nothing yet');
    result = await tick(15);
    assert.deepEqual([result.opened, fx.mails.length], [2, 1], 'two: an incident for each account, an email only where alerts are on');
    assert.equal(fx.mails[0].to, 'loud@example.test');
    assert.equal(fx.mails[0].subject, 'flaky.example.test is down');
    assert.match(fx.mails[0].text, /https:\/\/flaky\.example\.test\/ failed 2 checks in a row: the site answers with a server error \(HTTP 503\)\./);
    assert.match(fx.mails[0].text, /First failed check: 8 Oct 2026, 10:00 UTC\./);
    assert.ok(fx.mails[0].text.includes(`${ORIGIN}/app/watches/wl#site-health`), 'it links to the monitor page');
    assert.equal(fetchesTo('https://flaky.example.test/').length, 2, 'one request a tick for both accounts');
    await tick(30);
    assert.equal(fx.mails.length, 1, 'still down: no second email');
    route('https://flaky.example.test/', 200);
    result = await tick(45);
    assert.deepEqual([result.closed, fx.mails.length], [2, 2]);
    assert.equal(fx.mails[1].subject, 'flaky.example.test is back up');
    assert.match(fx.mails[1].text, /It was down for about 45 minutes, from 8 Oct 2026, 10:00 UTC to 8 Oct 2026, 10:45 UTC\./);
    const incident = db.prepare(`SELECT * FROM site_uptime_incidents WHERE user_id = 'loud'`).get();
    assert.deepEqual(
      [incident.started_at, incident.ended_at, incident.detail, Boolean(incident.opened_alert_at), Boolean(incident.closed_alert_at)],
      [iso(0), iso(45 * 60_000), 'The site answers with a server error (HTTP 503)', true, true],
    );
    const rollup = db.prepare(`SELECT checks, down FROM site_uptime_hourly WHERE user_id = 'loud'`).get();
    assert.deepEqual({ ...rollup }, { checks: 4, down: 3 });
    await tick(60);
    assert.equal(fx.mails.length, 2, 'up again: nothing more');

    // A 4xx is shown but is not downtime, and does not open anything.
    route('https://flaky.example.test/', 404);
    await tick(75);
    await tick(90);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM site_uptime_incidents`).get().n, 2);
    const site = db.prepare(`SELECT uptime_state, uptime_code, uptime_fails FROM site_health_sites WHERE user_id = 'loud'`).get();
    assert.deepEqual({ ...site }, { uptime_state: 'error', uptime_code: 404, uptime_fails: 0 });
    assert.equal(db.prepare(`SELECT down FROM site_uptime_hourly WHERE user_id = 'loud' AND hour = ?`).get(iso(60 * 60_000)).down, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Links                                                                     */
  /* ------------------------------------------------------------------------ */

  await section('links: read from <a href> only, resolved, deduplicated and capped, linear on hostile HTML', async () => {
    const { links } = app;
    const html = `<!doctype html><html><head><base href="/docs/"><title>x</title></head><body>
      <a href="guide">Guide</a> <a href='/about#team'>About us</a> <a href=https://other.test/x?a=1&amp;b=2>Other</a>
      <a href="guide#part-2">Guide again</a> <a href="#top">Top</a> <a href="mailto:a@b.test">Mail</a> <a href="tel:123">Call</a>
      <a href="javascript:void(0)">JS</a> <a href="https://page.example.test/docs/page">Itself</a>
      <a title="a > b" href="/quoted">Quoted <b>bold</b></a> <a href="/empty" aria-label="Empty link"><img src="x.png"></a>
      <a href="https://user:pw@secret.test/">Secret</a> <a href="ftp://files.test/">FTP</a>
      <!-- <a href="/commented">no</a> --> <script>var s = '<a href="/scripted">no</a>';</script>
      <template><a href="/templated">no</a></template> <abbr href="/abbr">no</abbr>
      <a href="/long">${'Very long link text '.repeat(10)}</a> <a href="/unclosed">Unclosed <a href="/next">Next</a>
      <a data-href="/data" href="/real">Real</a> <a href="  /spaced  ">Spaced</a></body></html>`;
    const found = links.extractLinks(html, 'https://page.example.test/docs/page#x');
    assert.deepEqual(
      found.map((link) => link.url),
      [
        'https://page.example.test/docs/guide',
        'https://page.example.test/about',
        'https://other.test/x?a=1&b=2',
        'https://page.example.test/quoted',
        'https://page.example.test/empty',
        'https://secret.test/',
        'https://page.example.test/long',
        'https://page.example.test/unclosed',
        'https://page.example.test/next',
        'https://page.example.test/real',
        'https://page.example.test/spaced',
      ],
    );
    const text = Object.fromEntries(found.map((link) => [link.url, link.text]));
    assert.equal(text['https://page.example.test/docs/guide'], 'Guide', 'the first text a URL had');
    assert.equal(text['https://page.example.test/quoted'], 'Quoted bold');
    assert.equal(text['https://page.example.test/empty'], 'Empty link', 'aria-label when there is no text');
    assert.equal(text['https://page.example.test/long'].length, 80);
    assert.ok(text['https://page.example.test/long'].endsWith('…'));
    assert.equal(text['https://page.example.test/unclosed'], 'Unclosed');
    assert.equal(links.extractLinks(html, 'https://page.example.test/', 3).length, 3, 'capped');
    const hostile = '<a "'.repeat(150_000) + '<a href=/x>'.repeat(50) + "<a title='".repeat(50_000);
    const started = Date.now();
    links.extractLinks(hostile, 'https://page.example.test/');
    assert.ok(Date.now() - started < 1500, `hostile HTML is read in linear time (${Date.now() - started} ms)`);
  });

  await section('links: HEAD first, GET when HEAD is refused; 404, 410, 5xx and dead hosts are broken; 401, 403, 429 and bot checks could not be verified; private addresses are never asked', async () => {
    const { links } = app;
    world();
    const methods = (url) => fetchesTo(url).map((call) => call.method);
    route('https://l.example.test/ok', 200);
    route('https://l.example.test/head-refused', ({ method }) => new Response(method === 'GET' ? 'body' : null, { status: method === 'HEAD' ? 405 : 200 }));
    route('https://l.example.test/head-501', ({ method }) => new Response(null, { status: method === 'HEAD' ? 501 : 404 }));
    for (const status of [404, 410, 500, 503, 401, 403, 429]) route(`https://l.example.test/${status}`, status);
    route('https://l.example.test/challenge', respond(403, { headers: { 'cf-mitigated': 'challenge' } }));
    route('https://l.example.test/moved', respond(301, { headers: { location: '/ok' } }));
    route('https://l.example.test/loop', respond(301, { headers: { location: '/loop' } }));
    route('https://l.example.test/inward', respond(302, { headers: { location: 'http://192.168.0.10/' } }));
    fx.routes.set('https://l.example.test/slow', () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const verdict = async (path) => {
      const result = await links.checkLink(path.startsWith('http') ? path : `https://l.example.test/${path}`);
      return [result.kind, result.status, result.requests];
    };
    assert.deepEqual(await verdict('ok'), ['ok', 200, 1]);
    assert.deepEqual(await verdict('head-refused'), ['ok', 200, 2]);
    assert.deepEqual(methods('https://l.example.test/head-refused'), ['HEAD', 'GET']);
    assert.deepEqual(await verdict('head-501'), ['broken', 404, 2]);
    for (const status of [404, 410, 500, 503]) assert.deepEqual(await verdict(String(status)), ['broken', status, 1], String(status));
    for (const status of [401, 403, 429]) assert.deepEqual(await verdict(String(status)), ['unverified', status, 1], String(status));
    assert.deepEqual(methods('https://l.example.test/404'), ['HEAD'], 'a HEAD answer is enough unless it is 405 or 501');
    assert.deepEqual(await verdict('challenge'), ['unverified', 403, 1]);
    assert.deepEqual(await verdict('moved'), ['ok', 200, 2], 'redirects are followed, each hop counted');
    assert.equal((await links.checkLink('https://l.example.test/loop')).kind, 'broken');
    assert.match((await links.checkLink('https://l.example.test/loop')).reason, /Redirects too many times/);
    assert.deepEqual((await verdict('inward')).slice(0, 2), ['unverified', null], 'a redirect to a private address is not followed');
    assert.deepEqual((await verdict('slow')).slice(0, 2), ['unverified', null]);
    assert.deepEqual((await verdict('https://nxdomain.example.test/')).slice(0, 2), ['broken', null], 'a dead host is broken');
    for (const url of ['http://10.0.0.5/admin', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      const result = await links.checkLink(url);
      assert.deepEqual([result.kind, result.skipped, result.requests], ['unverified', true, 0], url);
    }
    assert.ok(!fx.fetches.some((call) => /10\.0\.0\.5|localhost|169\.254|\[::1\]|192\.168/.test(call.url)), 'never asked');
    assert.ok(fx.fetches.every((call) => /EasyScreenCapture-LinkCheck\/1/.test(call.headers.get('user-agent')) && !call.headers.has('cookie') && !call.headers.has('authorization')));
  });

  const page = (hrefs) => respond(200, { headers: { 'content-type': 'text/html; charset=utf-8' }, body: hrefs.map((href) => `<a href="${href}">${href}</a>`).join('\n') });

  await section('link checks: broken links kept with when they were first seen, fixed when they work again or leave the page, couldn\'t-verify left as it was; no email', async () => {
    const { health, summary } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    addWatch(db, { id: 'wp', user: 'ana', url: 'https://site.example.test/' });
    await health.syncSites(T0);
    route('https://site.example.test/', page(['/ok', '/gone', '/moved', '/flaky', 'http://10.1.2.3/private', 'mailto:x@y.test']));
    route('https://site.example.test/ok', 200);
    for (const path of ['/gone', '/moved', '/flaky']) route(`https://site.example.test${path}`, 404);
    let sweep = await health.runSiteHealthSweep(ORIGIN, T0);
    assert.deepEqual([sweep.links.pages, sweep.links.broken, sweep.links.fixed], [1, 3, 0]);
    let check = db.prepare(`SELECT checked, broken, unverified, checked_at, next_at, page_url FROM site_link_checks WHERE watch_id = 'wp'`).get();
    assert.deepEqual({ ...check }, { checked: 4, broken: 3, unverified: 0, checked_at: iso(0), next_at: iso(7 * DAY), page_url: 'https://site.example.test/' }, 'the private link is not checked or counted');
    const open = () => db.prepare(`SELECT url, status, reason, first_seen_at, fixed_at FROM site_broken_links WHERE watch_id = 'wp' ORDER BY url, first_seen_at`).all().map((row) => ({ ...row }));
    assert.deepEqual(open().map((row) => [row.url, row.status, row.reason, row.first_seen_at, row.fixed_at]), [
      ['https://site.example.test/flaky', 404, 'Not found (HTTP 404)', iso(0), null],
      ['https://site.example.test/gone', 404, 'Not found (HTTP 404)', iso(0), null],
      ['https://site.example.test/moved', 404, 'Not found (HTTP 404)', iso(0), null],
    ]);

    // A week later: /gone works, /moved is no longer linked, /flaky now refuses bots, /new is broken.
    route('https://site.example.test/', page(['/ok', '/gone', '/flaky', '/new']));
    route('https://site.example.test/gone', 200);
    route('https://site.example.test/flaky', 403);
    route('https://site.example.test/new', 410);
    sweep = await health.runSiteHealthSweep(ORIGIN, at(7 * DAY));
    assert.deepEqual([sweep.links.broken, sweep.links.fixed], [1, 2]);
    assert.deepEqual(open().map((row) => [row.url, row.first_seen_at, row.fixed_at]), [
      ['https://site.example.test/flaky', iso(0), null],
      ['https://site.example.test/gone', iso(0), iso(7 * DAY)],
      ['https://site.example.test/moved', iso(0), iso(7 * DAY)],
      ['https://site.example.test/new', iso(7 * DAY), null],
    ]);
    check = db.prepare(`SELECT checked, broken, unverified FROM site_link_checks WHERE watch_id = 'wp'`).get();
    assert.deepEqual({ ...check }, { checked: 4, broken: 1, unverified: 1 });

    // Broken again after being fixed: a new row, and the earlier fix still counts.
    route('https://site.example.test/gone', 404);
    await health.runSiteHealthSweep(ORIGIN, at(14 * DAY));
    assert.deepEqual(
      open().filter((row) => row.url.endsWith('/gone')).map((row) => [row.first_seen_at, row.fixed_at]),
      [[iso(0), iso(7 * DAY)], [iso(14 * DAY), null]],
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM site_broken_links WHERE watch_id = 'wp' AND fixed_at IS NULL`).get().n, 3, 'flaky, new and gone again');

    // A page that cannot be read keeps its last results, says why, and is tried tomorrow.
    route('https://site.example.test/', 500);
    await health.runSiteHealthSweep(ORIGIN, at(21 * DAY));
    check = db.prepare(`SELECT checked_at, next_at, detail, broken FROM site_link_checks WHERE watch_id = 'wp'`).get();
    assert.deepEqual({ ...check }, { checked_at: iso(14 * DAY), next_at: iso(22 * DAY), detail: "The page answered HTTP 500, so its links weren't read", broken: 2 });
    assert.equal(fx.mails.length, 0, 'broken links are never emailed');

    const window = await summary.siteHealthForWatches('ana', ['wp'], iso(6 * DAY), iso(8 * DAY));
    assert.equal(window[0].links.fixed, 2, 'fixed inside the window');
  });

  await section('link sweeps: 100 links a page, one request per link across pages and accounts, and the per-tick request budget', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    addUser(db, 'bob', 'free');
    addWatch(db, { id: 'big', user: 'ana', url: 'https://big.example.test/' });
    addWatch(db, { id: 'p1', user: 'ana', url: 'https://one.example.test/' });
    addWatch(db, { id: 'p2', user: 'bob', url: 'https://two.example.test/' });
    route('https://big.example.test/', page(Array.from({ length: 150 }, (_, i) => `https://ext.example.test/${i}`)));
    for (let i = 0; i < 150; i++) route(`https://ext.example.test/${i}`, 200);
    route('https://one.example.test/', page(['https://shared.example.test/a', 'https://shared.example.test/b', '/own']));
    route('https://two.example.test/', page(['https://shared.example.test/a', 'https://shared.example.test/b']));
    for (const url of ['https://shared.example.test/a', 'https://shared.example.test/b', 'https://one.example.test/own']) route(url, 200);
    const sweep = await health.runSiteHealthSweep(ORIGIN, T0);
    assert.equal(sweep.links.pages, 3);
    assert.equal(db.prepare(`SELECT checked FROM site_link_checks WHERE watch_id = 'big'`).get().checked, 100, 'the first 100 links');
    assert.equal(fx.fetches.filter((call) => call.url.startsWith('https://ext.example.test/')).length, 100);
    assert.equal(fetchesTo('https://shared.example.test/a').length, 1, 'a link on two accounts\' pages is asked for once');
    assert.equal(db.prepare(`SELECT checked FROM site_link_checks WHERE watch_id = 'p2'`).get().checked, 2, 'and counted for both');
    assert.equal(sweep.links.requests, 103);
    assert.ok(health.LINK_REQUESTS_PER_TICK >= 1000 && health.LINK_PAGES_PER_TICK <= 50);

    // Out of budget: pages wait for the next tick.
    const crowded = world();
    addUser(crowded, 'many', 'business');
    const pages = Math.ceil(health.LINK_REQUESTS_PER_TICK / 100) + 3;
    for (let p = 0; p < pages; p++) {
      addWatch(crowded, { user: 'many', url: `https://p${p}.example.test/` });
      route(`https://p${p}.example.test/`, page(Array.from({ length: 100 }, (_, i) => `/l${i}`)));
    }
    const result = await health.runSiteHealthSweep(ORIGIN, T0);
    assert.ok(result.links.requests <= health.LINK_REQUESTS_PER_TICK, `${result.links.requests} requests`);
    assert.ok(result.links.pages < Math.min(pages, health.LINK_PAGES_PER_TICK), 'it stops before the budget runs out');
    assert.equal(result.links.due, pages);
  });

  /* ------------------------------------------------------------------------ */
  /* Alerts for certificates and domains                                       */
  /* ------------------------------------------------------------------------ */

  await section('SSL alerts: once at 14 days, again at 3, quiet after a renewal, then expired and invalid; owners with email off get nothing', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    addUser(db, 'mute', 'pro');
    addWatch(db, { id: 'ws', user: 'ana', url: 'https://secure.example.test/' });
    addWatch(db, { id: 'wm', user: 'mute', url: 'https://secure.example.test/', notify: 0 });
    route('https://secure.example.test/', 200);
    const expiring = makeCert({ notAfter: at(10 * DAY), dns: ['secure.example.test'] });
    const sockets = [];
    serveCertificate(expiring, sockets);
    const sweep = (days) => health.runSiteHealthSweep(ORIGIN, at(days * DAY));
    const sslMails = () => fx.mails.filter((mail) => /SSL/.test(mail.subject));
    let result = await sweep(0);
    assert.deepEqual([result.ssl.due, result.ssl.checked, result.ssl.alerts], [2, 2, 1]);
    assert.equal(fx.connects.length, 1, 'two accounts, one certificate read');
    assert.ok(sockets.every((socket) => socket.closed === 1));
    assert.equal(sslMails().length, 1);
    assert.equal(sslMails()[0].to, 'ana@example.test');
    assert.equal(sslMails()[0].subject, 'SSL certificate for secure.example.test expires in 10 days');
    assert.match(sslMails()[0].text, /expires on 18 Oct 2026, 10:00 UTC, in 10 days \(issued by Example Trust \(Example Trust R1\)\)/);
    assert.ok(sslMails()[0].text.includes(`${ORIGIN}/app/watches/ws#site-health`));
    const row = () => db.prepare(`SELECT ssl_status, ssl_valid_to, ssl_alert, ssl_next_at FROM site_health_sites WHERE user_id = 'ana'`).get();
    assert.deepEqual({ ...row() }, { ssl_status: 'expiring', ssl_valid_to: iso(10 * DAY), ssl_alert: `expiring14:${iso(10 * DAY)}`, ssl_next_at: iso(DAY) });
    assert.equal(db.prepare(`SELECT ssl_alert FROM site_health_sites WHERE user_id = 'mute'`).get().ssl_alert, `expiring14:${iso(10 * DAY)}`, 'claimed even with email off, so it is not sent later');
    await sweep(1);
    assert.equal(sslMails().length, 1, 'the next day: the same warning is not sent again');
    db.prepare(`UPDATE watches SET notify_email = 1 WHERE id = 'wm'`).run();
    await sweep(2);
    assert.equal(sslMails().length, 1, 'nor sent late to an owner who turned email on since');
    db.prepare(`UPDATE watches SET notify_email = 0 WHERE id = 'wm'`).run();
    await sweep(8);
    assert.equal(sslMails().length, 2, '2 days left: the second warning');
    assert.equal(sslMails()[1].subject, 'SSL certificate for secure.example.test expires in 2 days');
    await sweep(9);
    assert.equal(sslMails().length, 2);

    serveCertificate(makeCert({ notAfter: at(100 * DAY), dns: ['secure.example.test'] }));
    await sweep(10);
    assert.deepEqual([row().ssl_status, row().ssl_alert, sslMails().length], ['ok', null, 2], 'renewed: quiet, and the warnings start afresh');
    serveCertificate(makeCert({ notBefore: at(-200 * DAY), notAfter: at(10.5 * DAY), dns: ['secure.example.test'] }));
    await sweep(11);
    assert.equal(sslMails().length, 3, 'a certificate that has expired');
    assert.equal(sslMails()[2].subject, 'SSL certificate for secure.example.test has expired');
    await sweep(12);
    assert.equal(sslMails().length, 3);
    route('https://secure.example.test/', 526);
    const own = dn([CN, utf8('secure.example.test')]);
    serveCertificate(makeCert({ notAfter: at(300 * DAY), dns: ['secure.example.test'], subject: own, issuer: own }));
    await sweep(13);
    assert.equal(sslMails().length, 4);
    assert.equal(sslMails()[3].subject, 'SSL certificate problem on secure.example.test');
    assert.match(sslMails()[3].text, /Browsers don't trust this certificate: it is self-signed\./);
    await sweep(14);
    assert.equal(sslMails().length, 4, 'invalid, once');
    assert.ok(sslMails().every((mail) => mail.to === 'ana@example.test'));
    // A day the certificate could not be read changes nothing about the warnings.
    fx.connect = BLOCKED;
    fx.routes.delete('https://secure.example.test/');
    await sweep(15);
    assert.deepEqual([row().ssl_status, row().ssl_alert], ['unknown', 'invalid']);
  });

  await section('domain alerts: once at 30 days, again at 7, quiet after renewal; a registry with no expiry never alerts', async () => {
    const { health, rdap } = app;
    const db = world();
    rdap.forgetBootstrap();
    addUser(db, 'ana', 'plus');
    addWatch(db, { id: 'wd', user: 'ana', url: 'https://www.client.test/' });
    addWatch(db, { id: 'wd2', user: 'ana', url: 'https://shop.client.test/' });
    addWatch(db, { id: 'wde', user: 'ana', url: 'https://www.kunde.de/' });
    route(rdap.BOOTSTRAP_URL, respond(200, { body: JSON.stringify(BOOTSTRAP) }));
    route('https://rdap.denic.test/domain/kunde.de', rdapDomain('kunde.de'));
    const lookup = 'https://rdap.registry.test/domain/client.test';
    route(lookup, rdapDomain('client.test', { expires: iso(25 * DAY) }));
    const domainMails = () => fx.mails.filter((mail) => /client\.test|kunde/.test(mail.subject));
    let result = await health.runSiteHealthSweep(ORIGIN, T0);
    assert.deepEqual([result.domain.due, result.domain.checked, result.domain.lookups], [3, 3, 2], 'www. and shop. share one lookup');
    assert.equal(fetchesTo(lookup).length, 1);
    assert.equal(domainMails().length, 1, 'www. and shop. on one registration: one email');
    assert.equal(domainMails()[0].subject, 'client.test expires in 25 days');
    assert.match(domainMails()[0].text, /registered with Example Registrar, Inc\./);
    const de = db.prepare(`SELECT domain_status, domain_name, domain_detail, domain_next_at FROM site_health_sites WHERE origin = 'https://www.kunde.de'`).get();
    assert.deepEqual({ ...de }, { domain_status: 'unknown', domain_name: 'kunde.de', domain_detail: "The .de registry doesn't publish when domains expire, so the expiry date can't be checked.", domain_next_at: iso(7 * DAY) });
    await health.runSiteHealthSweep(ORIGIN, at(7 * DAY));
    assert.equal(domainMails().length, 1, '18 days left: no second email');
    route(lookup, rdapDomain('client.test', { expires: iso(25 * DAY) }));
    await health.runSiteHealthSweep(ORIGIN, at(21 * DAY));
    assert.equal(domainMails().length, 2, '4 days left: the second');
    assert.equal(domainMails()[1].subject, 'client.test expires in 4 days');
    route(lookup, rdapDomain('client.test', { expires: iso(400 * DAY) }));
    await health.runSiteHealthSweep(ORIGIN, at(28 * DAY));
    const renewed = db.prepare(`SELECT domain_status, domain_alert FROM site_health_sites WHERE origin = 'https://www.client.test'`).get();
    assert.deepEqual({ ...renewed }, { domain_status: 'ok', domain_alert: null });
    assert.equal(domainMails().length, 2);
    assert.ok(domainMails().every((mail) => !/kunde/.test(mail.subject)));
    assert.equal(health.domainAlertKey({ status: 'expired', expiresAt: iso(-DAY) }, T0), `expiring7:${iso(-DAY)}`, 'expired counts as the second warning');
    assert.equal(health.domainAlertKey({ status: 'expiring', expiresAt: iso(8 * DAY) }, T0), `expiring30:${iso(8 * DAY)}`);
    assert.equal(health.domainAlertKey({ status: 'unknown', expiresAt: null }, T0), null);
    rdap.forgetBootstrap();
  });

  /* ------------------------------------------------------------------------ */
  /* The summary                                                               */
  /* ------------------------------------------------------------------------ */

  await section('summary: one entry per origin, uptime and incidents inside the window, the latest SSL, domain and links, fixed inside the window, only the owner\'s rows', async () => {
    const { summary } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    addUser(db, 'bob', 'pro');
    addWatch(db, { id: 'w1', user: 'ana', url: 'https://shop.example.test/' });
    addWatch(db, { id: 'w2', user: 'ana', url: 'https://shop.example.test/pricing' });
    addWatch(db, { id: 'w3', user: 'ana', url: 'https://blog.example.test/' });
    addWatch(db, { id: 'wb', user: 'bob', url: 'https://shop.example.test/' });
    const site = db.prepare(
      `INSERT INTO site_health_sites (user_id, origin, url, created_at, uptime_next_at, ssl_next_at, domain_next_at, ssl_status, ssl_valid_to, ssl_issuer, ssl_detail, ssl_checked_at,
         domain_name, domain_status, domain_expires_at, domain_registrar, domain_detail, domain_checked_at)
       VALUES (?, 'https://shop.example.test', 'https://shop.example.test/', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'example.test', ?, ?, ?, ?, ?)`,
    );
    site.run('ana', '2025-01-01T00:00:00.000Z', '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z', 'expiring', '2025-04-10T00:00:00.000Z', "Let's Encrypt (R11)", 'Expires soon.', '2025-03-31T10:00:00.000Z', 'ok', '2026-02-01T00:00:00.000Z', 'Registrar A', 'Fine.', '2025-03-30T00:00:00.000Z');
    site.run('bob', '2025-01-01T00:00:00.000Z', '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z', 'invalid', null, null, 'Bob only.', '2025-03-31T10:00:00.000Z', 'expired', '2025-03-01T00:00:00.000Z', 'Registrar B', 'Bob only.', '2025-03-30T00:00:00.000Z');
    const hour = db.prepare(`INSERT INTO site_uptime_hourly (user_id, origin, hour, checks, down, total_ms) VALUES (?, ?, ?, ?, ?, 1000)`);
    for (let d = 1; d <= 10; d++) hour.run('ana', 'https://shop.example.test', `2025-03-${String(d).padStart(2, '0')}T10:00:00.000Z`, 4, 0);
    hour.run('ana', 'https://shop.example.test', '2025-03-15T10:00:00.000Z', 4, 2);
    hour.run('ana', 'https://shop.example.test', '2025-02-28T23:00:00.000Z', 4, 4);
    hour.run('ana', 'https://shop.example.test', '2025-04-01T00:00:00.000Z', 4, 4);
    hour.run('bob', 'https://shop.example.test', '2025-03-05T10:00:00.000Z', 4, 4);
    const incident = db.prepare(`INSERT INTO site_uptime_incidents (id, user_id, origin, started_at, ended_at, detail) VALUES (?, ?, 'https://shop.example.test', ?, ?, ?)`);
    incident.run('i1', 'ana', '2025-03-05T10:00:00.000Z', '2025-03-05T10:30:00.000Z', 'No answer within 10 seconds');
    incident.run('i2', 'ana', '2025-02-28T23:50:00.000Z', '2025-03-01T00:20:00.000Z', 'Server error');
    incident.run('i3', 'ana', '2025-02-10T10:00:00.000Z', '2025-02-10T11:00:00.000Z', 'Outside');
    incident.run('i4', 'ana', '2025-03-31T23:30:00.000Z', null, 'Still down');
    incident.run('ib', 'bob', '2025-03-10T10:00:00.000Z', '2025-03-10T11:00:00.000Z', 'Bob only');
    const check = db.prepare(`INSERT INTO site_link_checks (watch_id, user_id, next_at, checked_at, page_url, checked, broken) VALUES (?, ?, '2025-04-07T00:00:00.000Z', ?, ?, ?, ?)`);
    check.run('w1', 'ana', '2025-03-27T10:00:00.000Z', 'https://shop.example.test/', 50, 1);
    check.run('w2', 'ana', '2025-03-28T10:00:00.000Z', 'https://shop.example.test/pricing', 20, 1);
    check.run('wb', 'bob', '2025-03-28T10:00:00.000Z', 'https://shop.example.test/', 99, 9);
    db.prepare(`INSERT INTO site_link_checks (watch_id, user_id, next_at) VALUES ('w3', 'ana', '2025-04-01T00:00:00.000Z')`).run();
    const link = db.prepare(`INSERT INTO site_broken_links (watch_id, url, user_id, status, reason, first_seen_at, last_seen_at, fixed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    link.run('w1', 'https://shop.example.test/a', 'ana', 404, 'Not found (HTTP 404)', '2025-03-01T00:00:00.000Z', '2025-03-27T10:00:00.000Z', null);
    link.run('w2', 'https://shop.example.test/b', 'ana', 500, 'Server error (HTTP 500)', '2025-03-20T00:00:00.000Z', '2025-03-28T10:00:00.000Z', null);
    link.run('w1', 'https://shop.example.test/c', 'ana', 404, 'Not found (HTTP 404)', '2025-02-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', '2025-03-03T00:00:00.000Z');
    link.run('w1', 'https://shop.example.test/d', 'ana', 404, 'Not found (HTTP 404)', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '2025-02-25T00:00:00.000Z');
    link.run('wb', 'https://shop.example.test/z', 'bob', 404, 'Bob only', '2025-03-01T00:00:00.000Z', '2025-03-28T10:00:00.000Z', null);
    link.run('wb', 'https://shop.example.test/y', 'bob', 404, 'Bob only', '2025-03-01T00:00:00.000Z', '2025-03-28T10:00:00.000Z', '2025-03-10T00:00:00.000Z');

    const result = await summary.siteHealthForWatches('ana', ['w1', 'w2', 'w3', 'wb', 'nope'], '2025-03-01T00:00:00Z', '2025-04-01T00:00:00Z');
    assert.deepEqual(result, [
      {
        origin: 'https://shop.example.test',
        uptime: {
          checks: 44,
          down: 2,
          pct: 95.45,
          incidents: [
            { startedAt: '2025-02-28T23:50:00.000Z', endedAt: '2025-03-01T00:20:00.000Z', minutes: 20, detail: 'Server error' },
            { startedAt: '2025-03-05T10:00:00.000Z', endedAt: '2025-03-05T10:30:00.000Z', minutes: 30, detail: 'No answer within 10 seconds' },
            { startedAt: '2025-03-31T23:30:00.000Z', endedAt: null, minutes: 30, detail: 'Still down' },
          ],
        },
        ssl: { status: 'expiring', validTo: '2025-04-10T00:00:00.000Z', issuer: "Let's Encrypt (R11)", checkedAt: '2025-03-31T10:00:00.000Z', detail: 'Expires soon.' },
        domain: { status: 'ok', domain: 'example.test', expiresAt: '2026-02-01T00:00:00.000Z', registrar: 'Registrar A', checkedAt: '2025-03-30T00:00:00.000Z', detail: 'Fine.' },
        links: {
          checkedAt: '2025-03-28T10:00:00.000Z',
          pages: 2,
          checked: 70,
          broken: [
            { page: 'https://shop.example.test/', url: 'https://shop.example.test/a', status: 404, reason: 'Not found (HTTP 404)' },
            { page: 'https://shop.example.test/pricing', url: 'https://shop.example.test/b', status: 500, reason: 'Server error (HTTP 500)' },
          ],
          fixed: 1,
        },
      },
      { origin: 'https://blog.example.test', uptime: null, ssl: null, domain: null, links: null },
    ]);
    assert.deepEqual(await summary.siteHealthForWatches('bob', ['w1', 'w2'], '2025-03-01T00:00:00Z', '2025-04-01T00:00:00Z'), [], "another account's monitors give nothing");
    const bobs = await summary.siteHealthForWatches('bob', ['wb'], '2025-03-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z');
    assert.deepEqual([bobs[0].uptime.down, bobs[0].ssl.detail, bobs[0].links.checked, bobs[0].links.fixed], [4, 'Bob only.', 99, 1]);
    assert.deepEqual(await summary.siteHealthForWatches('ana', [], '2025-03-01T00:00:00Z', '2025-04-01T00:00:00Z'), []);
    assert.deepEqual(await summary.siteHealthForWatches('ana', ['w1'], 'not a date', '2025-04-01T00:00:00Z'), []);
    assert.equal(await summary.siteHealthReady(), true);
  });

  await section('the monitor page panel and the list tones: pending, healthy, warning and problem', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'ana', 'plus');
    const watch = { id: addWatch(db, { user: 'ana', url: 'https://panel.example.test/' }), url: 'https://panel.example.test/' };
    const user = { id: 'ana', plan: 'plus' };
    let panel = await health.siteHealthPanel(user, watch, T0);
    assert.deepEqual([panel.tone, panel.uptime, panel.ssl, panel.domain, panel.links, panel.uptimeMinutes, panel.host], ['pending', null, null, null, null, 15, 'panel.example.test']);
    assert.deepEqual([...(await health.siteHealthTones('ana', [watch]))], [[watch.id, 'pending']]);
    await health.syncSites(T0);
    route('https://panel.example.test/', page(['/fine']));
    route('https://panel.example.test/fine', 200);
    await health.runUptimeChecks(ORIGIN, T0);
    await health.runSiteHealthSweep(ORIGIN, T0);
    panel = await health.siteHealthPanel(user, watch, T0);
    assert.equal(panel.tone, 'healthy', 'up, links fine, certificate trusted though unread, registry unknown');
    assert.deepEqual(panel.uptime.pct, { day: 100, week: 100, month: 100 });
    assert.deepEqual([panel.ssl.status, panel.ssl.validTo], ['ok', null]);
    assert.equal(panel.domain.status, 'unknown');
    assert.deepEqual([panel.links.checked, panel.links.brokenCount], [1, 0]);
    db.prepare(`UPDATE site_link_checks SET broken = 1`).run();
    db.prepare(`INSERT INTO site_broken_links (watch_id, url, user_id, status, reason, link_text, first_seen_at, last_seen_at) VALUES (?, 'https://panel.example.test/x', 'ana', 404, 'Not found (HTTP 404)', 'X', ?, ?)`).run(watch.id, iso(0), iso(0));
    panel = await health.siteHealthPanel(user, watch, T0);
    assert.equal(panel.tone, 'warning');
    assert.deepEqual(panel.links.broken, [{ url: 'https://panel.example.test/x', status: 404, reason: 'Not found (HTTP 404)', text: 'X', since: iso(0) }]);
    route('https://panel.example.test/', 503);
    await health.runUptimeChecks(ORIGIN, at(15 * 60_000));
    await health.runUptimeChecks(ORIGIN, at(30 * 60_000));
    panel = await health.siteHealthPanel(user, watch, at(30 * 60_000));
    assert.equal(panel.tone, 'problem');
    assert.deepEqual([panel.uptime.state, panel.uptime.lastIncident.startedAt, panel.uptime.lastIncident.endedAt], ['down', iso(15 * 60_000), null]);
    assert.deepEqual(panel.uptime.pct.day, 33.33);
    assert.deepEqual([...(await health.siteHealthTones('ana', [watch]))], [[watch.id, 'problem']]);
    assert.equal(health.overallTone(['healthy', 'neutral', 'pending']), 'healthy');
    assert.equal(health.overallTone(['neutral']), 'healthy', 'no HTTPS, or a registry with no dates, is not a problem');
    assert.equal(health.overallTone([]), 'pending');
  });

  /* ------------------------------------------------------------------------ */
  /* Pruning, deletion, and before 0020                                        */
  /* ------------------------------------------------------------------------ */

  await section('pruning: 13 months kept, older rollups, incidents, fixed links and abandoned sites removed in bounded batches', async () => {
    const { health } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    const wid = addWatch(db, { user: 'ana', url: 'https://old.example.test/' });
    const now = T0.getTime();
    const old = (days) => new Date(now - days * DAY).toISOString();
    const hour = db.prepare(`INSERT INTO site_uptime_hourly (user_id, origin, hour, checks) VALUES ('ana', ?, ?, 1)`);
    db.exec('BEGIN');
    for (let i = 0; i < 6_000; i++) hour.run(`https://s${i % 50}.example.test`, new Date(now - 500 * DAY + Math.floor(i / 50) * 3_600_000).toISOString());
    for (let i = 0; i < 10; i++) hour.run('https://s0.example.test', new Date(now - i * 3_600_000).toISOString());
    db.exec('COMMIT');
    const incident = db.prepare(`INSERT INTO site_uptime_incidents (id, user_id, origin, started_at, ended_at) VALUES (?, 'ana', 'https://s0.example.test', ?, ?)`);
    incident.run('gone', old(500), old(499));
    incident.run('open', old(450), null);
    incident.run('recent', old(10), old(9));
    const link = db.prepare(`INSERT INTO site_broken_links (watch_id, url, user_id, reason, first_seen_at, last_seen_at, fixed_at) VALUES (?, ?, 'ana', 'x', ?, ?, ?)`);
    link.run(wid, 'https://old.example.test/fixed-long-ago', old(600), old(500), old(400));
    link.run(wid, 'https://old.example.test/fixed-recently', old(100), old(20), old(10));
    link.run(wid, 'https://old.example.test/still-broken', old(600), old(1), null);
    const site = db.prepare(`INSERT INTO site_health_sites (user_id, origin, url, active, created_at, uptime_next_at, ssl_next_at, domain_next_at) VALUES ('ana', ?, ?, ?, ?, ?, ?, ?)`);
    site.run('https://abandoned.example.test', 'https://abandoned.example.test/', 0, old(800), old(400), old(400), old(400));
    site.run('https://resting.example.test', 'https://resting.example.test/', 0, old(800), old(30), old(30), old(30));
    site.run('https://busy.example.test', 'https://busy.example.test/', 1, old(800), old(400), old(400), old(400));

    let pruned = await health.pruneSiteHealth(now);
    assert.deepEqual({ ...pruned }, { hours: 5_000, incidents: 1, links: 1, sites: 1 }, 'five batches of rollups an hour at most');
    pruned = await health.pruneSiteHealth(now);
    assert.equal(pruned.hours, 1_000);
    assert.equal((await health.pruneSiteHealth(now)).hours, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM site_uptime_hourly`).get().n, 10, 'the recent hours stay');
    assert.deepEqual(db.prepare(`SELECT id FROM site_uptime_incidents ORDER BY id`).all().map((row) => row.id), ['open', 'recent'], 'an open incident is never pruned');
    assert.deepEqual(db.prepare(`SELECT url FROM site_broken_links ORDER BY url`).all().map((row) => row.url.split('/').pop()), ['fixed-recently', 'still-broken']);
    assert.deepEqual(db.prepare(`SELECT origin FROM site_health_sites ORDER BY origin`).all().map((row) => row.origin), ['https://busy.example.test', 'https://resting.example.test']);
    assert.equal(health.RETENTION_DAYS, 395);
  });

  await section('account deletion removes every site health row of the account and none of anyone else\'s', async () => {
    const { health, deletion } = app;
    const db = world();
    addUser(db, 'ana', 'pro');
    addUser(db, 'bob', 'pro');
    addWatch(db, { id: 'wa', user: 'ana', url: 'https://same.example.test/' });
    addWatch(db, { id: 'wbb', user: 'bob', url: 'https://same.example.test/' });
    route('https://same.example.test/', page(['/dead']));
    route('https://same.example.test/dead', 404);
    await health.syncSites(T0);
    await health.runUptimeChecks(ORIGIN, T0);
    await health.runSiteHealthSweep(ORIGIN, T0);
    const counts = (user) =>
      ['site_health_sites', 'site_uptime_hourly', 'site_link_checks', 'site_broken_links'].map(
        (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(user).n,
      );
    assert.deepEqual(counts('ana'), [1, 1, 1, 1]);
    db.prepare(`INSERT INTO site_uptime_incidents (id, user_id, origin, started_at) VALUES ('ia', 'ana', 'https://same.example.test', ?)`).run(iso(0));
    await deletion.deleteAccount('ana');
    assert.deepEqual(counts('ana'), [0, 0, 0, 0]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM site_uptime_incidents WHERE user_id = 'ana'`).get().n, 0);
    assert.deepEqual(counts('bob'), [1, 1, 1, 1]);
  });

  await section('before migration 0020 everything is dormant: nothing checked, fetched, shown or summarised, and deletion still works', async () => {
    const db = world({ migrated: false });
    app = await loadApp();
    const { health, summary, deletion } = app;
    addUser(db, 'ana', 'pro');
    const id = addWatch(db, { user: 'ana', url: 'https://dormant.example.test/' });
    route('https://dormant.example.test/', 200);
    assert.equal(await summary.siteHealthReady(), false);
    assert.deepEqual(await health.syncSites(T0), { sites: 0, stopped: 0, pages: 0 });
    assert.deepEqual(await health.runUptimeChecks(ORIGIN, T0), { due: 0, checked: 0, fetched: 0, down: 0, opened: 0, closed: 0, backlog: 0 });
    const sweep = await health.runSiteHealthSweep(ORIGIN, T0);
    assert.deepEqual([sweep.sync, sweep.pruned, sweep.ssl.due, sweep.domain.due, sweep.links.due], [null, null, 0, 0, 0]);
    assert.deepEqual(await health.pruneSiteHealth(T0.getTime()), { hours: 0, incidents: 0, links: 0, sites: 0 });
    assert.equal(await health.siteHealthPanel({ id: 'ana', plan: 'pro' }, { id, url: 'https://dormant.example.test/' }, T0), null, 'the panel is not rendered');
    assert.equal((await health.siteHealthTones('ana', [{ id, url: 'https://dormant.example.test/' }])).size, 0);
    assert.deepEqual(await summary.siteHealthForWatches('ana', [id], '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), []);
    assert.deepEqual(await summary.siteHealthCleanup('ana'), []);
    await deletion.deleteAccount('ana');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 'ana'`).get().n, 0);
    assert.equal(fx.fetches.length, 0, 'not one request');
    assert.equal(fx.connects.length, 0);
    assert.equal(fx.mails.length, 0);
  });

  await section('the wiring: the minute cron runs uptime at the quarter ticks, the hourly one runs uptime and the sweep, each catching its own failure', () => {
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    assert.match(worker, /import \{ runSiteHealthSweep, runUptimeChecks \} from '\.\/lib\/site-health';/);
    const minute = worker.slice(worker.indexOf('if (event.cron === JOBS_CRON)'), worker.indexOf('hourly(event, ctx);'));
    assert.match(minute, /ctx\.waitUntil\(uptime\(now, '\[uptime:15m\]'\)\)/);
    const hourly = worker.slice(worker.indexOf('function hourly('));
    assert.match(hourly, /ctx\.waitUntil\(uptime\(now\)\)/);
    assert.match(hourly, /runSiteHealthSweep\(siteOrigin\(\), now\)[\s\S]*?\.catch\(\(error\) => console\.error\('\[site-health\] sweep failed', error\)\)/);
    const uptime = worker.slice(worker.indexOf('async function uptime('), worker.indexOf('function logSweep('));
    assert.match(uptime, /try \{[\s\S]*runUptimeChecks[\s\S]*\} catch \(error\)/);
    const source = readFileSync(join(root, 'src/lib/site-health.ts'), 'utf8');
    assert.ok(!/\bfetch\(/.test(source.replace(/fetchPublic\(|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/await fetch\(url, \{\s*method: 'HEAD'/, '')), 'every other request goes through fetchPublic');
  });
} finally {
  globalThis.fetch = realFetch;
  delete globalThis.__sh;
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\nSite health checks passed (${passed.length}): plan tiers; the ClientHello, a real TLS 1.2 handshake and a TLS 1.3-only alert; X.509 dates, names and corrupted input; SSL states and fallbacks; RDAP bootstrap, suffixes, missing expiry and failures; uptime rules, incidents, rollups, plan intervals and dedupe; link extraction, HEAD/GET, classification, private addresses, fixed links and budgets; SSL and domain alerts once per change; the summary's windows and ownership; the panel; pruning; account deletion; dormancy before 0020; and the cron wiring.`);
