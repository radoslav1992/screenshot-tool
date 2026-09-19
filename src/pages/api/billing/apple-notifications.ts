import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { decodeApplePayload, syncAppleSubscription } from '../../../lib/apple-billing';
import { timingSafeEqual } from '../../../lib/ids';
export const prerender=false;
/** Notification contents are only a lookup hint. Entitlements come exclusively from Apple's HTTPS API. */
export const POST: APIRoute=async({request,url})=>{
 if(!env.APPLE_IAP_WEBHOOK_SECRET || !timingSafeEqual(url.searchParams.get('key') ?? '',env.APPLE_IAP_WEBHOOK_SECRET)) return new Response(null,{status:403});
 try {
  const raw=await request.text();if(raw.length>100000) return new Response(null,{status:413});
  const body=JSON.parse(raw);
  const notice=decodeApplePayload<{notificationType:string;data?:{signedTransactionInfo?:string}}>(body.signedPayload);
  if(notice.notificationType==='TEST') return new Response(null,{status:200});
  if(!notice.data?.signedTransactionInfo) return new Response(null,{status:200});
  const hint=decodeApplePayload<{originalTransactionId:string}>(notice.data.signedTransactionInfo);
  if(!/^\d{1,40}$/.test(hint.originalTransactionId)) return new Response(null,{status:400});
  const sub=await env.DB.prepare('SELECT original_id,user_id,environment FROM apple_subscriptions WHERE original_id=?').bind(hint.originalTransactionId).first<{original_id:string;user_id:string;environment:'Production'|'Sandbox'}>();
  if(sub) await syncAppleSubscription(sub);
  return new Response(null,{status:200});
 }catch {console.error('[apple] notification refresh failed');return new Response(null,{status:503});}
};
