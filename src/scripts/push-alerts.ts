/**
 * Change alerts on this device (Web Push), for the Account screen. The state
 * is a pure function of what the browser and the server say, so it can be
 * checked without either (scripts/web-push-check.mjs).
 */

export type PushAlertState = 'unsupported' | 'install' | 'blocked' | 'off' | 'on';

export interface PushEnvironment {
  /** Service workers, PushManager and Notification all exist. */
  supported: boolean;
  /** iPhone or iPad, in any browser. */
  ios: boolean;
  standalone: boolean;
  permission: NotificationPermission;
  /** The browser holds a subscription and the server has it for this session. */
  subscribed: boolean;
}

export function pushAlertState(environment: PushEnvironment): PushAlertState {
  // iOS 16.4+ offers web push only to an app added to the Home Screen; in a tab
  // PushManager does not exist at all, so this comes before "unsupported".
  if (environment.ios && !environment.standalone) return 'install';
  if (!environment.supported) return 'unsupported';
  if (environment.permission === 'denied') return 'blocked';
  return environment.subscribed && environment.permission === 'granted' ? 'on' : 'off';
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export interface ServerStatus {
  available: boolean;
  publicKey: string | null;
  subscribed: boolean;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? 'Something went wrong. Try again.');
  return payload as T;
}

export const serverStatus = () => api<ServerStatus>('/api/push/web');

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** The registration Base.astro made, once it has an active worker. */
async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** This browser's subscription, without asking for anything. */
export async function browserSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  return (await existing?.pushManager.getSubscription().catch(() => null)) ?? null;
}

/**
 * Asks for permission (only ever from a click), subscribes and tells the
 * server. A subscription made with an earlier key is replaced, since the push
 * service would refuse alerts signed with the new one.
 */
export async function turnOn(publicKey: string, permission: Promise<NotificationPermission>): Promise<NotificationPermission> {
  const answer = await permission;
  if (answer !== 'granted') return answer;
  const key = keyBytes(publicKey);
  const worker = await registration();
  let subscription = await worker.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameBytes(new Uint8Array(current), key)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/push/web', 'POST', subscription.toJSON());
  return answer;
}

export async function turnOff(): Promise<void> {
  const subscription = await browserSubscription();
  if (!subscription) return;
  await api('/api/push/web', 'DELETE', { endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => false);
}

export const sendTest = () => api<{ sent: number; removed: number; failed: number }>('/api/push/web/test', 'POST');

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
