export interface APNsConfig { APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_PRIVATE_KEY?: string; APNS_BUNDLE_ID?: string }
export function pushConfigured(c: APNsConfig) { return Boolean(c.APNS_KEY_ID && c.APNS_TEAM_ID && c.APNS_PRIVATE_KEY && c.APNS_BUNDLE_ID); }
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
let cached: { config: string; token: string; expires: number } | undefined;
export async function providerToken(c: APNsConfig, now = Date.now()): Promise<string> {
  if (!pushConfigured(c)) throw new Error('APNs is not configured');
  const config = `${c.APNS_KEY_ID}:${c.APNS_TEAM_ID}:${c.APNS_PRIVATE_KEY}`;
  if (cached?.config === config && cached.expires > now) return cached.token;
  const pem = c.APNS_PRIVATE_KEY!.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const unsigned = `${encode({ alg: 'ES256', kid: c.APNS_KEY_ID })}.${encode({ iss: c.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const token = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  cached = { config, token, expires: now + 50 * 60 * 1000 };
  return token;
}
export function pushPayload(watchId: string, runId: string) {
  // Deliberately omit monitored URLs, labels and page content from lock screens.
  return { aps: { alert: { title: 'A monitored page changed', body: 'Open Easy Capture to review the before and after.' }, sound: 'default', 'thread-id': watchId }, watch_id: watchId, run_id: runId };
}
export function classifyAPNs(status: number, reason: string): 'accepted' | 'invalid' | 'retry' | 'failed' {
  if (status === 200) return 'accepted';
  if (status === 410 || (status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason))) return 'invalid';
  if (status === 429 || status >= 500) return 'retry';
  return 'failed';
}
export async function sendPush(c: APNsConfig, token: string, environment: string, watchId: string, runId: string, expiresAt: string) {
  const auth = await providerToken(c);
  const host = environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const response = await fetch(`https://${host}/3/device/${token}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `bearer ${auth}`, 'content-type': 'application/json', 'apns-topic': c.APNS_BUNDLE_ID!, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.parse(expiresAt) / 1000)), 'apns-collapse-id': runId.slice(0, 64) },
    body: JSON.stringify(pushPayload(watchId, runId)),
  });
  const result = response.status === 200 ? {} : await response.json().catch(() => ({})) as { reason?: string; timestamp?: number };
  const reason = typeof result.reason === 'string' ? result.reason.slice(0, 80) : `HTTP_${response.status}`;
  return { state: classifyAPNs(response.status, reason), reason, timestamp: result.timestamp };
}
