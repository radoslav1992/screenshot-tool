import assert from 'node:assert/strict';

import { build } from 'esbuild';
const ruleBundle = await build({entryPoints:['src/lib/monitor-rules.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {evaluateRule,parseMonitorRule,defaultRule} = await import('data:text/javascript;base64,'+Buffer.from(ruleBundle.outputFiles[0].text).toString('base64'));
const facts = (text,element) => ({text,monitored_element:element});
const rule = (kind,extra={}) => ({...defaultRule,kind,...extra});
assert.equal(evaluateRule(rule('text'),facts('Hello  world'),facts('Hello world')).changed,false);
assert.equal(evaluateRule(rule('text'),facts('Hello'),facts('World')).changed,true);
assert.equal(evaluateRule(rule('appeared',{phrase:'IN STOCK'}),facts('Sold out'),facts('In stock now')).changed,true);
assert.equal(evaluateRule(rule('appeared',{phrase:'IN STOCK'}),facts('In stock'),facts('In stock now')).changed,false);
assert.equal(evaluateRule(rule('disappeared',{phrase:'Sold out'}),facts('Sold out'),facts('Available')).changed,true);
const element = text => ({selector:'.price',found:true,text});
assert.equal(evaluateRule(rule('price',{selector:'.price'}),facts('',element('€19,99')),facts('',element('€29,99'))).changed,true);
assert.equal(evaluateRule(rule('price',{selector:'.price'}),facts('',element('Price €19')),facts('',element('Now €19'))).changed,false);
assert.throws(()=>evaluateRule(rule('price',{selector:'.price'}),facts('',element('€19')),facts('',{selector:'.price',found:false,text:''})));
assert.throws(()=>evaluateRule(rule('text'),null,facts('x')));
assert.equal(evaluateRule(rule('element',{selector:'.price'}),facts('old'),facts('',element('new'))).changed,false,'new element rule must establish baseline');
// The stored text is an 8,000-character excerpt; the hash and phrase answers cover the whole page.
const whole = (text,hash,length,phrases) => ({text,text_hash:hash,text_length:length,...(phrases?{phrases}:{})});
assert.equal(evaluateRule(rule('text'),whole('Same top','a',20000),whole('Same top','b',20000)).changed,true,'a change past the excerpt still counts');
assert.equal(evaluateRule(rule('text'),whole('Top','a',3),whole('Top, reflowed','a',13)).changed,false,'equal hashes mean an unchanged page');
assert.equal(evaluateRule(rule('disappeared',{phrase:'Sold out'}),whole('Sold out','a',20000,{'Sold out':true}),whole('Header','b',20000,{'Sold out':true})).changed,false,'a phrase that moved past the excerpt has not disappeared');
assert.equal(evaluateRule(rule('appeared',{phrase:'In  stock'}),whole('Header','a',20000,{'In stock':false}),whole('Header','b',20000,{'in stock':true})).changed,true,'a phrase appearing past the excerpt is seen');
const partial = evaluateRule(rule('disappeared',{phrase:'Sold out'}),whole('Sold out','a',20000),whole('Header','b',20000));
assert.equal(partial.changed,false,'an absence read only from the excerpt does not alert');
assert.match(partial.detail,/Only the first 8,000 characters could be checked/,'and says why it stayed quiet');
// A baseline taken before whole-page phrase answers must not make a phrase that was always there "appear".
assert.equal(evaluateRule(rule('appeared',{phrase:'In stock'}),whole('Header','a',20000),whole('Header','b',20000,{'In stock':true})).changed,false,'no false alert on the first exact check');
assert.equal(evaluateRule(rule('appeared',{phrase:'In stock'}),facts('Sold out'),facts('In stock now')).detail,'“In stock” appeared on the page.','rule alerts say what was found');
assert.match(evaluateRule(rule('price',{selector:'.price'}),facts('',element('€19,99')),facts('',element('€29,99'))).detail,/^Price changed: €19,99 → €29,99$/);
assert.throws(()=>parseMonitorRule({rule_kind:'appeared'}));
assert.throws(()=>parseMonitorRule({rule_kind:'price'}));
assert.throws(()=>parseMonitorRule({watch_region:'0,0,2,2;1,1,2,2'}));
assert.deepEqual(parseMonitorRule({watch_region:'10,20,100,200'}),{...defaultRule,region:'10,20,100,200'});
const output = await build({entryPoints:['src/lib/monitor-import.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'cf',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cf',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env = {};'}));}}]});
const {importUrls,sitemapUrls}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
assert.deepEqual(importUrls('https://example.com/a\nhttps://example.com/a'),['https://example.com/a']);
assert.throws(()=>importUrls('http://127.0.0.1/private'));
assert.throws(()=>importUrls(Array.from({length:21},(_,i)=>`https://example.com/${i}`).join('\n')));
assert.deepEqual(sitemapUrls('<urlset><url><loc>https://example.com/a?a=1&amp;b=2</loc></url><url><loc>https://other.com/b</loc></url></urlset>','https://example.com'),['https://example.com/a?a=1&b=2']);
assert.throws(()=>sitemapUrls('<!DOCTYPE x><urlset/>','https://example.com'));
assert.throws(()=>sitemapUrls('<sitemapindex/>','https://example.com'));
console.log('Workflow checks passed: text/price/element rules, missing facts, baseline changes, URL limits, SSRF rejection and sitemap parsing.');
const diffBundle = await build({entryPoints:['src/lib/visual-diff-fn.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {compareInPage}=await import('data:text/javascript;base64,'+Buffer.from(diffBundle.outputFiles[0].text).toString('base64'));
const oldImage=globalThis.Image, oldDocument=globalThis.document;
globalThis.Image=class { naturalWidth=100; naturalHeight=100; set src(value){this.source=value;if(value==='taller')this.naturalHeight=200;queueMicrotask(()=>this.onload());} };
globalThis.document={createElement(){ let pixels; return {getContext(){return {
 drawImage(image,x,y,width,height,_dx,_dy,w,h){pixels=new Uint8ClampedArray(w*h*4);for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const changed=image.source==='after' && x+xx*width/w<50;const i=(yy*w+xx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=changed?0:255;pixels[i+3]=255;}},
 getImageData(){return {data:pixels};}
 };}};}};
try {
 assert.equal((await compareInPage('before','after',12,10000)).changedPct,50);
 assert.equal((await compareInPage('before','after',12,10000,{x:50,y:0,width:50,height:100})).changedPct,0,'changes outside watched region ignored');
 assert.equal((await compareInPage('before','after',12,10000,{x:0,y:0,width:50,height:100})).changedPct,100,'changes within region detected');
 await assert.rejects(compareInPage('before','after',12,10000,{x:90,y:0,width:50,height:100}));
 const taller=await compareInPage('before','taller',12,10000);
 assert.deepEqual([taller.resized,taller.changedPct,taller.sharedPct],[true,50,0],'a page twice as tall changed by the half it grew, not by all of it');
 assert.ok(taller.changedPixels>0,'a resize is always a detected change');
 const same=await compareInPage('before','after',12,10000);
 assert.equal(same.sharedPct,same.changedPct,'without a resize both measures agree');
} finally {globalThis.Image=oldImage;globalThis.document=oldDocument;}
console.log('Region comparison passed: inside/outside selection, cropped pixel denominator, invalid bounds, and resize area.');
