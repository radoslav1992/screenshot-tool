import { assertPublicCaptureUrl } from './capture-options';
import { badRequest } from './http';
export function importUrls(raw: string): string[] {
 if (raw.length > 30000) throw badRequest('URL list is too large.');
 const urls = [...new Set(raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>assertPublicCaptureUrl(s).toString()))];
 if (!urls.length || urls.length > 20) throw badRequest('Import between 1 and 20 distinct page URLs at a time.');
 return urls;
}
export function sitemapUrls(xml: string, origin: string): string[] {
 if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw badRequest('Sitemaps with document types or entities are not supported.');
 if (/<sitemapindex[\s>]/i.test(xml)) throw badRequest('Open a page sitemap from this index and paste its URL.');
 const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
 const urls = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(m=>decode(m[1].trim()));
 const output: string[] = [];
 for (const raw of urls) {
  const url = assertPublicCaptureUrl(raw);
  if (url.origin === origin && !output.includes(url.toString())) output.push(url.toString());
  if (output.length === 20) break;
 }
 if (!output.length) throw badRequest('No page URLs from this origin found. Use a page sitemap, not a sitemap index.');
 return output;
}
export async function readSitemap(raw: string) {
 const url = assertPublicCaptureUrl(raw);
 const response = await fetch(url.toString(),{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/xml,text/xml'}});
 if (!response.ok || !response.body) throw badRequest('Could not read sitemap. Use its final URL without redirects.');
 const reader = response.body.getReader(); const decoder = new TextDecoder(); let size=0, text='';
 try { while(true) { const part = await reader.read(); if(part.done) break; size += part.value.byteLength; if(size > 512000) throw badRequest('Use a sitemap smaller than 512 KB.'); text += decoder.decode(part.value,{stream:true}); } text += decoder.decode(); }
 finally { await reader.cancel(); }
 return sitemapUrls(text,url.origin);
}
