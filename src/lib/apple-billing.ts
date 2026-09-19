import { env } from 'cloudflare:workers';
import { HttpError } from './http';

export const APPLE_BUNDLE = 'com.easyscreencapture.ios';
export const APPLE_PRODUCTS = ['com.easyscreencapture.ios.lite.monthly', 'com.easyscreencapture.ios.lite.yearly'];
type Environment = 'Production' | 'Sandbox';
interface Transaction { transactionId: string; originalTransactionId: string; productId: string; bundleId: string; appAccountToken?: string; environment: string; expiresDate?: number; revocationDate?: number; inAppOwnershipType?: string; }
interface Subscription { original_id: string; user_id: string; environment: Environment; }
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
/** Decode ONLY API responses obtained directly from Apple's authenticated HTTPS endpoints.
 * This function does not validate arbitrary client/notification JWS signatures. */
export function decodeApplePayload<T>(jws: string): T {
  if (typeof jws !== 'string' || jws.length > 100000 || jws.split('.').length !== 3) throw new Error('Invalid Apple response');
  const part = jws.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part),c=>c.charCodeAt(0))));
}
export function appleConfigured() { return Boolean(env.APPLE_IAP_KEY_ID && env.APPLE_IAP_ISSUER_ID && env.APPLE_IAP_PRIVATE_KEY); }
async function apiToken() {
  const now=Math.floor(Date.now()/1000);
  const unsigned=`${encode({alg:'ES256',kid:env.APPLE_IAP_KEY_ID,typ:'JWT'})}.${encode({iss:env.APPLE_IAP_ISSUER_ID,iat:now,exp:now+300,aud:'appstoreconnect-v1',bid:APPLE_BUNDLE})}`;
  const pem=env.APPLE_IAP_PRIVATE_KEY!.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(unsigned)));
  return `${unsigned}.${btoa(String.fromCharCode(...sig)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`;
}
async function appleGet(path: string, environment: Environment): Promise<any> {
  if(!appleConfigured()) throw new HttpError(503,'billing_unavailable','Apple purchases are not available yet.');
  const host=environment==='Production'?'api.storekit.itunes.apple.com':'api.storekit-sandbox.itunes.apple.com';
  const response=await fetch(`https://${host}/inApps/v1/${path}`,{headers:{Authorization:`Bearer ${await apiToken()}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new HttpError(502,'apple_unavailable','Apple could not verify this purchase. Try Restore purchases shortly.');
  return response.json();
}
function checkTransaction(t: Transaction, token: string, environment: Environment) {
  if(t.bundleId!==APPLE_BUNDLE || !APPLE_PRODUCTS.includes(t.productId) || t.environment!==environment ||
     t.appAccountToken?.toLowerCase()!==token.toLowerCase() || t.inAppOwnershipType!=='PURCHASED' || !/^\d+$/.test(t.originalTransactionId)) {
    throw new HttpError(409,'purchase_mismatch','This purchase does not belong to this Easy Capture account. Sign in to the account used to purchase it.');
  }
}
export async function appleAccountToken(userId: string) {
  await env.DB.prepare('INSERT INTO apple_accounts(user_id,app_account_token) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING').bind(userId,crypto.randomUUID()).run();
  const row=await env.DB.prepare('SELECT app_account_token FROM apple_accounts WHERE user_id=?').bind(userId).first<{app_account_token:string}>();
  if(!row) throw new Error('Account token unavailable');
  return row.app_account_token;
}
export async function syncAppleSubscription(sub: Subscription) {
  const started=new Date().toISOString();
  const account=await env.DB.prepare('SELECT app_account_token FROM apple_accounts WHERE user_id=?').bind(sub.user_id).first<{app_account_token:string}>();
  if(!account) throw new Error('Missing purchase account');
  const response=await appleGet(`subscriptions/${sub.original_id}`,sub.environment);
  if(response.bundleId!==APPLE_BUNDLE || response.environment!==sub.environment) throw new Error('Apple subscription scope mismatch');
  let expiry=0, product=''; let found=false;
  for(const group of response.data ?? []) for(const item of group.lastTransactions ?? []) {
    if(item.originalTransactionId!==sub.original_id) continue;
    const t=decodeApplePayload<Transaction>(item.signedTransactionInfo);
    checkTransaction(t,account.app_account_token,sub.environment);
    if(t.originalTransactionId!==sub.original_id) throw new Error('Transaction chain mismatch');
    found=true; product=t.productId;
    // No grace period is configured: only Apple's active status grants access.
    if(item.status===1 && !t.revocationDate && Number.isFinite(t.expiresDate)) expiry=Math.max(expiry,t.expiresDate!);
  }
  if(!found) throw new Error('Subscription missing from Apple response');
  const expires=new Date(expiry).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE apple_subscriptions SET product_id=?,expires_at=?,checked_at=?,next_check_at=? WHERE original_id=? AND user_id=? AND checked_at<=?')
      .bind(product,expires,started,new Date(Date.now()+3600000).toISOString(),sub.original_id,sub.user_id,started),
    env.DB.prepare('UPDATE users SET apple_expires_at=(SELECT MAX(expires_at) FROM apple_subscriptions WHERE user_id=?) WHERE id=?').bind(sub.user_id,sub.user_id),
  ]);
  return {active:expiry>Date.now()};
}
export async function verifyApplePurchase(userId: string, transactionId: string, environment: string) {
  if(!/^\d{1,40}$/.test(transactionId) || !['Production','Sandbox'].includes(environment)) throw new HttpError(400,'invalid_purchase','Invalid purchase details.');
  if(environment==='Sandbox' && !(env.APPLE_SANDBOX_USER_IDS ?? '').split(',').map(s=>s.trim()).includes(userId))
    throw new HttpError(403,'sandbox_disabled','This account is not enabled for sandbox purchase testing.');
  const token=await appleAccountToken(userId);
  const response=await appleGet(`transactions/${transactionId}`,environment as Environment);
  const t=decodeApplePayload<Transaction>(response.signedTransactionInfo);
  checkTransaction(t,token,environment as Environment);
  if(t.transactionId!==transactionId) throw new Error('Transaction ID mismatch');
  const existing=await env.DB.prepare('SELECT original_id,user_id,environment FROM apple_subscriptions WHERE original_id=?').bind(t.originalTransactionId).all<{original_id:string;user_id:string;environment:string}>();
  if((existing.results ?? []).some(row=>row.user_id!==userId || row.environment!==environment))
    throw new HttpError(409,'purchase_mismatch','A different subscription is already linked to this account. Contact support.');
  // Unique constraints prevent concurrent claims. Never grant based on the submitted transaction alone.
  await env.DB.prepare(`INSERT INTO apple_subscriptions(original_id,user_id,environment,product_id,expires_at,checked_at,next_check_at)
    VALUES(?,?,?,?,?,'',?) ON CONFLICT(original_id) DO NOTHING`)
    .bind(t.originalTransactionId,userId,environment,t.productId,new Date(0).toISOString(),new Date().toISOString()).run();
  return syncAppleSubscription({original_id:t.originalTransactionId,user_id:userId,environment:environment as Environment});
}
export async function refreshAppleSubscriptions() {
  if(!appleConfigured()) return;
  const rows=await env.DB.prepare('SELECT original_id,user_id,environment FROM apple_subscriptions WHERE next_check_at<=? ORDER BY next_check_at LIMIT 50').bind(new Date().toISOString()).all<Subscription>();
  for(const sub of rows.results ?? []) {
    try { await syncAppleSubscription(sub); }
    catch { // Back off so a broken subscription cannot permanently starve the queue.
      await env.DB.prepare('UPDATE apple_subscriptions SET next_check_at=? WHERE original_id=?').bind(new Date(Date.now()+3600000).toISOString(),sub.original_id).run();
      console.error('[apple] subscription refresh failed');
    }
  }
}
export async function refreshAppleUser(userId: string) {
  if(!appleConfigured()) return;
  const sub=await env.DB.prepare('SELECT original_id,user_id,environment FROM apple_subscriptions WHERE user_id=? AND next_check_at<=?').bind(userId,new Date().toISOString()).first<Subscription>();
  if(sub) await syncAppleSubscription(sub);
}
