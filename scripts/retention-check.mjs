import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE users(id TEXT,plan TEXT,apple_expires_at TEXT); CREATE TABLE captures(id TEXT PRIMARY KEY,user_id TEXT,created_at TEXT,files TEXT,bytes INTEGER); CREATE TABLE watches(id TEXT,baseline_capture_id TEXT,last_changed_at TEXT); CREATE TABLE watch_runs(id TEXT PRIMARY KEY,watch_id TEXT,capture_id TEXT,baseline_capture_id TEXT,changed INTEGER,created_at TEXT); CREATE TABLE alert_retries(run_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE email_verifications(expires_at TEXT,used_at TEXT); CREATE TABLE sessions(expires_at TEXT); INSERT INTO users VALUES('free','free',NULL),('paid','business',NULL);`);
const add=(id,user='free',date='2025-01-01',files=JSON.stringify([{key:id}]))=>db.prepare('INSERT INTO captures VALUES(?,?,?,?,?)').run(id,user,date,files,100);
for(let i=0;i<120;i++)add(`old-${i}`);
add('baseline');db.exec("INSERT INTO watches VALUES('w1','baseline',NULL)");add('recent','free','2026-09-18');add('paid-recent','paid','2026-01-01');add('paid-old','paid');add('fail','free','2024-01-01');add('corrupt','free','2024-01-01','invalid');
// A watch paused since its last change keeps that change's before and after, and so does an alert awaiting a retry; an older change and a finished retry do not.
for(const id of ['change-before','change-after','stale-before','stale-after','retry-before','retry-after','done-before','done-after'])add(id,'free','2025-03-01');
db.exec(`INSERT INTO watches VALUES('w2','change-after','2025-06-01T00:00:00.000Z');
INSERT INTO watch_runs VALUES('latest','w2','change-after','change-before',1,'2025-06-01T00:00:04.000Z'),('older','w2','stale-after','stale-before',1,'2025-05-01T00:00:04.000Z'),('retry','w3','retry-after','retry-before',1,'2025-05-02T00:00:00.000Z'),('done','w3','done-after','done-before',1,'2025-05-03T00:00:00.000Z'),('quiet','w2',NULL,NULL,0,'2025-06-02T00:00:00.000Z');
INSERT INTO alert_retries VALUES('retry','pending'),('done','done');`);
let fail=true;const deleted=new Set();
const bind=(sql,args=[])=>({bind:(...v)=>{assert(v.length<=100);return bind(sql,v)},first:async()=>db.prepare(sql).get(...args)??null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)})});
globalThis.__retentionEnv={DB:{prepare:sql=>bind(sql)},SHOTS:{delete:async keys=>{if(fail&&keys.includes('fail'))throw Error('Simulated R2 outage');keys.forEach(k=>deleted.add(k));}}};
const dir=mkdtempSync(join(tmpdir(),'retention-'));
try{
await build({entryPoints:['src/lib/retention.ts'],outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'env',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__retentionEnv;',loader:'js'}));}}]});
const {sweepExpiredCaptures}=await import(pathToFileURL(join(dir,'test.mjs')));const now=Date.parse('2026-09-19T00:00:00Z');const first=await sweepExpiredCaptures(now);
assert.equal(first.failed,2);assert(first.truncated);assert(deleted.has('paid-old'));assert(db.prepare("SELECT id FROM captures WHERE id='fail'").get());assert(!deleted.has('baseline'));assert(!deleted.has('recent'));assert(!deleted.has('paid-recent'));
fail=false;await sweepExpiredCaptures(now);await sweepExpiredCaptures(now);assert(!db.prepare("SELECT id FROM captures WHERE id='fail'").get());assert.equal(db.prepare("SELECT count(*) AS n FROM captures WHERE id LIKE 'old-%'").get().n,0);assert(db.prepare("SELECT id FROM captures WHERE id='corrupt'").get());
for(const id of ['change-before','change-after','retry-before','retry-after'])assert(!deleted.has(id),`${id} is still linked from an alert`);
for(const id of ['stale-before','stale-after','done-before','done-after'])assert(deleted.has(id),`${id} is no longer linked from anything`);
// Quiet monitor runs (read the page, nothing new, no screenshot) go after 35 days; every other run stays.
const runs=new DatabaseSync(':memory:');
runs.exec(`CREATE TABLE watch_runs(id TEXT PRIMARY KEY,watch_id TEXT,capture_id TEXT,baseline_capture_id TEXT,status TEXT,changed INTEGER,created_at TEXT);
INSERT INTO watch_runs VALUES('q-old','w',NULL,'cap','done',0,'2026-08-01T00:00:00Z'),('changed-old','w','cap',NULL,'done',1,'2026-08-01T01:00:00Z'),('error-old','w',NULL,NULL,'error',0,'2026-08-01T02:00:00Z'),('skipped-old','w',NULL,NULL,'skipped',0,'2026-08-01T03:00:00Z'),('shot-old','w','cap2','cap','done',0,'2026-08-01T04:00:00Z'),('q-old-2','w',NULL,'cap','done',0,'2026-08-02T00:00:00Z'),('q-recent','w',NULL,'cap','done',0,'2026-09-10T00:00:00Z');`);
globalThis.__retentionEnv.DB={prepare:sql=>({bind:(...v)=>({run:async()=>({meta:runs.prepare(sql).run(...v)})})})};
const {pruneQuietRuns}=await import(pathToFileURL(join(dir,'test.mjs')));
assert.equal(await pruneQuietRuns(now),2,'both old quiet runs go');
assert.deepEqual(runs.prepare('SELECT id FROM watch_runs ORDER BY rowid').all().map((r)=>r.id),['changed-old','error-old','skipped-old','shot-old','q-recent'],'changes, failures, skips, screenshots and recent quiet runs stay');
assert.equal(await pruneQuietRuns(now),0,'nothing left to prune');
runs.exec('DELETE FROM watch_runs');assert.equal(await pruneQuietRuns(now),0,'an empty table is fine');
runs.close();
console.log('Retention checks passed: expiry, plan windows, baselines, alert links, bounded queries, backlog drain, R2 retry, corrupt manifests and quiet run pruning.');
}finally{db.close();delete globalThis.__retentionEnv;rmSync(dir,{recursive:true,force:true});}
