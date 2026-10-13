'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname;
const old=fs.readFileSync(path.join(root,'server_stage7_candidate.js'),'utf8');
const updated=fs.readFileSync(path.join(root,'server_stage8_candidate.js'),'utf8');
const {appendToBatchIfEnabled}=require('./server/smart-alert-mutation-barrier');
const hook=`// Stage 8: source writes and prepared-generation change share ONE Firestore batch.\nrequire('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({\n  batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue\n});\n`;
function route(s,name){
 const start=s.indexOf(`app.post("${name}"`);assert(start>=0,name);
 const suffix=s.slice(start+1);let n=suffix.search(/\napp\.(?:post|patch|put|delete|get)\(/);return s.slice(start,n<0?undefined:start+1+n);
}
function testRouteBulk(n,commits){
 test('route '+n+' has one marker per original committed batch',()=>{
 const a=route(old,n),b=route(updated,n);
 assert.equal((a.match(/await batch\.commit\(\)/g)||[]).length,commits,n);
 assert.equal((b.match(/await batch\.commit\(\)/g)||[]).length,commits,n);
 assert.equal((b.match(/Stage 8: source writes/g)||[]).length,commits,n);
 assert.equal(b.replaceAll(hook,''),a,'no other route content changed');
 let idx=0;for(let k=0;k<commits;k++){
   const mark=b.indexOf(hook,idx),commit=b.indexOf('await batch.commit()',mark);
   assert(mark>=0&&commit>mark,n);idx=commit+3;
 }
 });
}
test('source Stage7 SHA256 is exactly the audited baseline',()=>assert.equal(crypto.createHash('sha256').update(old).digest('hex'),'d51b2e397798f54782be6872337e095e7192f014f7e9b00a8ffb3b1a69197a69'));
testRouteBulk('/api/add-animal/import',2);
testRouteBulk('/api/herd-import-v2/save-operational',2);
testRouteBulk('/api/insemination/bulk-save',1);
testRouteBulk('/api/pregnancy-diagnosis/bulk-save',1);
test('V2 atomic write set marks seed events + job completion before commit, but not skip/rejections',()=>{
 const begin='async function herdImportV2CommitAtomicWriteSetInternalSrv(';const end='function addAnimalImportKindSrv';
 const a=old.slice(old.indexOf(begin),old.indexOf(end));
 const b=updated.slice(updated.indexOf(begin),updated.indexOf(end));
 assert.equal(b.replaceAll(hook,''),a);
 assert.equal((b.match(/Stage 8: source writes/g)||[]).length,1);
 assert(b.indexOf('alreadyCompleted: true')<b.indexOf(hook));
 assert(b.indexOf('batch.set(jobRef, {')<b.indexOf(hook));
 assert(b.indexOf(hook)<b.indexOf('await batch.commit()'));
 assert.match(b,/if \(finalBatchWrites > 430\)/);
});
test('whole file exactly matches Stage7 after removing precisely 7 new hooks',()=>{
 assert.equal((updated.split(hook).length)-1,7);
 assert.equal(updated.replaceAll(hook,''),old);
});
test('prepared GET remains impossible to enable by env or Firestore flags',()=>{
 assert.match(updated,/const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;/);
 assert.match(updated,/if \(!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED\) return null;/);
});
// This harness exercises the actual unchanged shared barrier with Firestore-like
// commit/rollback semantics. It is NOT a Firestore integration test.
const db={collection(c){return {doc(id){return {key:c+'/'+id}}}}};
const F={increment(n){return {inc:n}}};
const records=new Map();
let commits=0;
function nextBatch(){const operations=[];return {operations,set(ref,data,opt){operations.push({ref,data,opt});},async commit(fail=false){
 if(fail)throw Error('mock_firestore_commit_failure');
 const pending=new Map(records);
 for(const {ref,data,opt} of operations){const prev=pending.get(ref.key)||{},patch={};for(const [k,v] of Object.entries(data))patch[k]=typeof v==='object'&&v!==null&&v.inc!==undefined?(prev[k]||0)+v.inc:v;pending.set(ref.key,opt?.merge?{...prev,...patch}:patch);}
 records.clear();for(const [k,v] of pending)records.set(k,v);commits++;
 }};}
function barrier(batch,env={'MURABBIK_PREPARED_MUTATION_TRACKING':'1'}){return appendToBatchIfEnabled({batch,db,tenant:'farm',FieldValue:F,env});}
test('multi-chunk import bumps one generation per successful chunk, including when later chunk fails',async()=>{
 records.clear();commits=0;for(let i=0;i<3;i++){
 const batch=nextBatch();for(let j=0;j<3;j++)batch.set({key:'animals/'+(3*i+j)},{animalNumber:String(3*i+j)});
 barrier(batch);if(i===2){await assert.rejects(()=>batch.commit(true),/mock_firestore_commit_failure/);break;}
 await batch.commit();}
 assert.equal(records.get('smart_alert_prepared_meta/farm').generation,2);
 assert.equal([...records.keys()].filter(x=>x.startsWith('animals/')).length,6);
 assert.equal(commits,2);
});
test('empty/rejected imports do not create an invalidation',async()=>{
 records.clear();const batch=nextBatch();let ops=0;
 if(ops>0){barrier(batch);await batch.commit();}
 assert.equal(records.size,0);
});
test('disabled flag writes no metadata for a committed chunk',async()=>{
 records.clear();const batch=nextBatch();batch.set({key:'events/e1'},{n:1});assert.equal(barrier(batch,{}),false);await batch.commit();assert.equal(records.has('events/e1'),true);assert.equal(records.has('smart_alert_prepared_meta/farm'),false);
});
test('V2 atomic import failure rolls back animals, seed events, and generation together',async()=>{
 records.clear();const batch=nextBatch();batch.set({key:'animals/a'},{state:'active'});batch.set({key:'events/e'},{kind:'seed'});batch.set({key:'herd_import_jobs/job'},{status:'completed'});barrier(batch);
 await assert.rejects(()=>batch.commit(true),/mock_firestore_commit_failure/);assert.equal(records.size,0);
 await batch.commit();assert.equal(records.get('smart_alert_prepared_meta/farm').generation,1);assert.equal(records.get('events/e').kind,'seed');
});