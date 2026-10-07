import { base64url, pemBytes, pushPayload, signES256 } from './apns';

/**
 * Web Push (RFC 8030) for browsers and installed web apps: VAPID to say who is
 * sending (RFC 8292), and the alert encrypted to the browser's keys with
 * aes128gcm (RFC 8291, RFC 8188). WebCrypto does all of it. Like apns.ts, this
 * is the protocol alone; push.ts queues and retries.
 */
export interface VAPIDConfig { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
export interface WebPushSubscription { endpoint: string; p256dh: string; auth: string }
export type WebPushState = 'accepted' | 'invalid' | 'retry' | 'failed';
type Bytes = Uint8Array<ArrayBuffer>;

const text = (value: string): Bytes => new TextEncoder().encode(value) as Bytes;
export function fromBase64url(value: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  try { return Uint8Array.from(atob(value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
  catch { return null; }
}
/** An uncompressed P-256 point: how browsers give `p256dh`, and how VAPID_PUBLIC_KEY is written. */
function point(value: unknown): Bytes | null {
  const bytes = typeof value === 'string' ? fromBase64url(value.trim()) : null;
  return bytes?.length === 65 && bytes[0] === 4 ? bytes : null;
}
export function webPushConfigured(c: VAPIDConfig) {
  return Boolean(point(c.VAPID_PUBLIC_KEY) && c.VAPID_PRIVATE_KEY?.trim() && /^(mailto:|https:\/\/)\S+$/.test(c.VAPID_SUBJECT?.trim() ?? ''));
}

/**
 * Only the push services the browsers use, over https: a subscription is an
 * address this server will POST to, so anything else is refused (SSRF).
 */
export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname;
  return host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com')
    || host === 'web.push.apple.com' || host.endsWith('.push.apple.com');
}
/** What `PushSubscription.toJSON()` posts, checked: an allowed endpoint, a 65-byte key and a 16-byte secret. */
export function parseSubscription(body: { endpoint?: unknown; keys?: unknown }): WebPushSubscription | null {
  let keys = body.keys;
  if (typeof keys === 'string') { try { keys = JSON.parse(keys); } catch { return null; } }
  const { p256dh, auth } = (keys && typeof keys === 'object' ? keys : {}) as { p256dh?: unknown; auth?: unknown };
  const key = point(p256dh), secret = typeof auth === 'string' ? fromBase64url(auth.trim()) : null;
  if (!pushEndpointAllowed(body.endpoint) || !key || secret?.length !== 16) return null;
  return { endpoint: body.endpoint, p256dh: base64url(key), auth: base64url(secret) };
}

/** The right length is not enough: an alert is encrypted to this point, so it has to be on the curve. */
export async function keyOnCurve(p256dh: string): Promise<boolean> {
  const bytes = point(p256dh);
  return Boolean(bytes) && crypto.subtle.importKey('raw', bytes!, { name: 'ECDH', namedCurve: 'P-256' }, false, []).then(() => true, () => false);
}

/** The words of the APNs alert, so nothing about the page reaches a lock screen either. */
export function webPushPayload(watchId: string, runId: string) {
  const { title, body } = pushPayload(watchId, runId).aps.alert;
  return { title, body, url: `/app/watches/${encodeURIComponent(watchId)}`, watch_id: watchId, run_id: runId };
}
export function webPushTestPayload() {
  return { title: 'Test alert', body: 'Change alerts are on for this device.', url: '/app/account#device-alerts', watch_id: null, run_id: null };
}

export function classifyWebPush(status: number): WebPushState {
  if (status === 201 || status === 202) return 'accepted';
  if (status === 404 || status === 410) return 'invalid';
  if (status === 429 || status >= 500) return 'retry';
  // 413 is an alert too large, and 400, 401 and 403 a request or VAPID key the
  // service refuses: this server's fault, not the subscription's, so it is kept.
  return 'failed';
}

/** VAPID_PRIVATE_KEY is the 32-byte scalar in base64url, or a PKCS8 key (PEM or bare base64). */
async function signingKey(c: VAPIDConfig): Promise<CryptoKey> {
  const secret = c.VAPID_PRIVATE_KEY!.trim(), pub = point(c.VAPID_PUBLIC_KEY)!;
  const raw = secret.includes('-----') ? null : fromBase64url(secret);
  if (raw?.length === 32) {
    const jwk = { kty: 'EC', crv: 'P-256', d: base64url(raw), x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33)) };
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  return crypto.subtle.importKey('pkcs8', pemBytes(secret), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
const tokens = new Map<string, { token: string; expires: number }>();
/** `vapid t=…, k=…` for one push service. A token lasts 12 hours and is reused for 11. */
export async function vapidAuthorization(c: VAPIDConfig, endpoint: string, now = Date.now()): Promise<string> {
  if (!webPushConfigured(c)) throw new Error('Web Push is not configured');
  const aud = new URL(endpoint).origin, publicKey = base64url(point(c.VAPID_PUBLIC_KEY)!);
  const config = `${c.VAPID_PRIVATE_KEY}:${publicKey}:${c.VAPID_SUBJECT}:${aud}`;
  let entry = tokens.get(config);
  if (!entry || entry.expires <= now) {
    const exp = Math.floor(now / 1000) + 12 * 3600;
    entry = { token: await signES256(await signingKey(c), { typ: 'JWT', alg: 'ES256' }, { aud, exp, sub: c.VAPID_SUBJECT!.trim() }), expires: now + 11 * 3600 * 1000 };
    if (tokens.size > 50) tokens.clear();
    tokens.set(config, entry);
  }
  return `vapid t=${entry.token}, k=${publicKey}`;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const RECORD_SIZE = 4096;
/** Push services take 4096 bytes of body: less the 86-byte header, the 16-byte tag and the delimiter. */
const MAX_PAYLOAD = 4096 - 86 - 16 - 1;
/**
 * One aes128gcm record (RFC 8188) keyed as RFC 8291 says: ECDH between a fresh
 * key pair and the browser's key, mixed with its auth secret, then a random
 * salt. `fixed` pins the salt and key pair, for the RFC's own test vector.
 */
export async function encryptPayload(plaintext: Bytes, p256dh: Bytes, authSecret: Bytes, fixed?: { salt: Bytes; keys: CryptoKeyPair }): Promise<Bytes> {
  if (plaintext.length > MAX_PAYLOAD) throw new Error('Web Push payload too large');
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keys = fixed?.keys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const serverKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer);
  const browserKey = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: browserKey }, keys.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(text('WebPush: info\0'), p256dh, serverKey), 32);
  const cek = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt']);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  // A single record: the alert, then 0x02, which marks the last record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverKey.length;
  return concat(header, serverKey, sealed);
}

/** POSTs one encrypted alert. TTL is what is left of the delivery's own expiry. */
export async function sendWebPush(c: VAPIDConfig, subscription: WebPushSubscription, payload: object, expiresAt: string, now = Date.now()): Promise<{ state: WebPushState; reason: string }> {
  // Stored subscriptions were checked on the way in; this is the last word before a fetch.
  if (!pushEndpointAllowed(subscription.endpoint)) return { state: 'invalid', reason: 'EndpointNotAllowed' };
  const p256dh = point(subscription.p256dh), auth = fromBase64url(subscription.auth);
  if (!p256dh || auth?.length !== 16) return { state: 'invalid', reason: 'BadSubscriptionKeys' };
  const body = await encryptPayload(text(JSON.stringify(payload)), p256dh, auth);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {
      authorization: await vapidAuthorization(c, subscription.endpoint, now),
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000))), urgency: 'normal',
    },
    body,
  });
  const detail = await response.text().catch(() => '');
  let reason = `HTTP_${response.status}`;
  try { const parsed = JSON.parse(detail) as { reason?: unknown }; if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 80); } catch { /* most services answer in plain text */ }
  return { state: classifyWebPush(response.status), reason };
}
