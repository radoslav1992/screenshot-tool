import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { appleAccountToken, appleConfigured, APPLE_PRODUCTS, verifyApplePurchase } from '../../../lib/apple-billing';
import { HttpError, assertSameOrigin, json, readBody } from '../../../lib/http';
import { toHttpError } from '../../../lib/errors';
import { checkRateLimit } from '../../../lib/rate-limit';
export const prerender=false;
export const GET: APIRoute=async({locals})=>{
 try {
  if(!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
  if(!appleConfigured()) return json({available:false,productIds:[],appAccountToken:null,canPurchase:false});
  const row=await env.DB.prepare('SELECT plan,plan_status,apple_expires_at FROM users WHERE id=?').bind(locals.user.id).first<{plan:string;plan_status:string|null;apple_expires_at:string|null}>();
  return json({available:true,productIds:APPLE_PRODUCTS,appAccountToken:await appleAccountToken(locals.user.id),canPurchase:row?.plan==='free' && !['active','trialing','past_due','unpaid','incomplete'].includes(row.plan_status ?? '') && !(row.apple_expires_at && row.apple_expires_at>new Date().toISOString())},{headers:{'cache-control':'no-store'}});
 }catch(e){return toHttpError(e,'apple.config','Could not load purchases.').toResponse();}
};
export const POST: APIRoute=async({locals,request})=>{
 try {
  if(!locals.user) throw new HttpError(401,'unauthorized','Sign in first.');
  assertSameOrigin(request);
  if(!(await checkRateLimit(`apple:${locals.user.id}`,15)).ok) throw new HttpError(429,'rate_limit','Please wait before restoring again.');
  const body=await readBody(request);
  return json(await verifyApplePurchase(locals.user.id,String(body.transactionId ?? ''),String(body.environment ?? '')));
 }catch(e){return toHttpError(e,'apple.purchase','Could not verify your purchase. Try Restore purchases.').toResponse();}
};
