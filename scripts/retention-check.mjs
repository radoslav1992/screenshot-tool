import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE users(id TEXT,plan TEXT); CREATE TABLE captures(id TEXT PRIMARY KEY,user_id TEXT,created_at TEXT,files TEXT,bytes INTEGER); CREATE TABLE watches(baseline_capture_id TEXT); CREATE TABLE email_verifications(expires_at TEXT,used_at TEXT); CREATE TABLE sessions(expires_at TEXT); INSERT INTO users VALUES('free','free'),('paid','business');`);
const add=(id,user='free',date='2025-01-01',files=JSON.stringify([{key:id}]))=>db.prepare('INSERT INTO captures VALUES(?,?,?,?,?)').run(id,user,date,files,100);
for(let i=0;i<120;i++)add(`old-${i}`);
add('baseline');db.exec("INSERT INTO watches VALUES('baseline')");add('recent','free','2026-09-18');add('paid-recent','paid','2026-01-01');add('paid-old','paid');add('fail','free','2024-01-01');add('corrupt','free','2024-01-01','invalid');
let fail=true;const deleted=new Set();
const bind=(sql,args=[])=>({bind:(...v)=>{assert(v.length<=100);return bind(sql,v)},all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)})});
globalThis.__retentionEnv={DB:{prepare:sql=>bind(sql)},SHOTS:{delete:async keys=>{if(fail&&keys.includes('fail'))throw Error('Simulated R2 outage');keys.forEach(k=>deleted.add(k));}}};
const dir=mkdtempSync(join(tmpdir(),'retention-'));
try{
await build({entryPoints:['src/lib/retention.ts'],outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'env',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__retentionEnv;',loader:'js'}));}}]});
const {sweepExpiredCaptures}=await import(pathToFileURL(join(dir,'test.mjs')));const now=Date.parse('2026-09-19T00:00:00Z');const first=await sweepExpiredCaptures(now);
assert.equal(first.failed,2);assert(first.truncated);assert(deleted.has('paid-old'));assert(db.prepare("SELECT id FROM captures WHERE id='fail'").get());assert(!deleted.has('baseline'));assert(!deleted.has('recent'));assert(!deleted.has('paid-recent'));
fail=false;await sweepExpiredCaptures(now);await sweepExpiredCaptures(now);assert(!db.prepare("SELECT id FROM captures WHERE id='fail'").get());assert.equal(db.prepare("SELECT count(*) AS n FROM captures WHERE id LIKE 'old-%'").get().n,0);assert(db.prepare("SELECT id FROM captures WHERE id='corrupt'").get());
console.log('Retention checks passed: expiry, plan windows, baselines, bounded queries, backlog drain, R2 retry and corrupt manifests.');
}finally{db.close();delete globalThis.__retentionEnv;rmSync(dir,{recursive:true,force:true});}
