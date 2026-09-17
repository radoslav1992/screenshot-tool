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
globalThis.Image=class { naturalWidth=100; naturalHeight=100; set src(value){this.source=value;queueMicrotask(()=>this.onload());} };
globalThis.document={createElement(){ let pixels; return {getContext(){return {
 drawImage(image,x,y,width,height,_dx,_dy,w,h){pixels=new Uint8ClampedArray(w*h*4);for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){const changed=image.source==='after' && x+xx*width/w<50;const i=(yy*w+xx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=changed?0:255;pixels[i+3]=255;}},
 getImageData(){return {data:pixels};}
 };}};}};
try {
 assert.equal((await compareInPage('before','after',12,10000)).changedPct,50);
 assert.equal((await compareInPage('before','after',12,10000,{x:50,y:0,width:50,height:100})).changedPct,0,'changes outside watched region ignored');
 assert.equal((await compareInPage('before','after',12,10000,{x:0,y:0,width:50,height:100})).changedPct,100,'changes within region detected');
 await assert.rejects(compareInPage('before','after',12,10000,{x:90,y:0,width:50,height:100}));
} finally {globalThis.Image=oldImage;globalThis.document=oldDocument;}
console.log('Region comparison passed: inside/outside selection, cropped pixel denominator, and invalid bounds.');
