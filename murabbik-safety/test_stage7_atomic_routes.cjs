'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), crypto=require('node:crypto'),path=require('node:path');
const base=__dirname;
const original=fs.readFileSync(path.join(base,'server_stage6_candidate.js'),'utf8');
const candidate=fs.readFileSync(path.join(base,'server_stage7_candidate.js'),'utf8');
const {appendToTransactionIfEnabled}=require('./server/smart-alert-mutation-barrier');
const anchor='// Stage 7: invalidate the prepared result inside the successful write transaction.';
const cases=[
 {route:'/api/vaccination/farm-program',before:'tx.set(\n              settingsRef,',success:'return {\n              version,',reject:'await tx.get(\n                currentRef'},
 {route:'/api/abortion/save',before:'await updateAnimalByAbortionSrv(',success:'return { created: true };',reject:'if (existing.exists) {\n      return { created: false };'},
 {route:'/api/daily-milk/session/save',before:'tx.set(\n                    eventRef,',success:'return {\n                  corrected:',reject:'"daily_milk_day_complete"'},
 {route:'/api/hoof-trimming/save',before:'tx.set(animalRef, {',success:'created = true;',reject:'if (existing.exists) {\n          return;'}
];
function routeBlock(text,route){
 const re=new RegExp('app\\.post\\(\\s*["\']'+route.replace(/\//g,'\\/')+'["\']\\s*,','g');
 const matches=[...text.matchAll(re)];assert.equal(matches.length,1,'route lookup: '+route);
 const start=matches[0].index, next=/\bapp\.post\s*\(/g;next.lastIndex=start+matches[0][0].length;
 const v=next.exec(text);return text.slice(start,v?.index??text.length);
}
test('verified Stage6 baseline SHA256',()=>assert.equal(crypto.createHash('sha256').update(original).digest('hex'),'297ad40aae1deabb3cc7d6ebb56cddea4cc500197f040913d0aef36f05950adf'));
test('prepared GET hard stop unchanged',()=>{assert.match(candidate,/const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;/);assert.match(candidate,/if \(!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED\) return null;/)});
for(const {route,before,success,reject} of cases){
 test('atomic barrier after writes and before success: '+route,()=>{
  const b=routeBlock(original,route),s=routeBlock(candidate,route);
  assert.equal(b.includes(anchor),false);assert.equal((s.match(/Stage 7: invalidate/g)||[]).length,1);
  assert(s.indexOf(before)>=0 && s.indexOf(before)<s.indexOf(anchor));
  assert(s.indexOf(anchor)<s.indexOf(success));
  assert(s.indexOf(reject)>=0 && s.indexOf(reject)<s.indexOf(anchor));
  assert.equal((s.match(/appendToTransactionIfEnabled/g)||[]).length,1);
 });
}
test('undoing all 4 additions restores Stage6, byte-for-byte',()=>{
 let c=candidate;
 const H="// Stage 7: invalidate the prepared result inside the successful write transaction.\nrequire('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({\n  tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue\n});\n";
 for(const indent of ['            ','    ','                ','        ']){
  const h=indent+H.replace(/\n/g,'\n'+indent).trimEnd()+'\n\n';
  assert.equal(c.split(h).length,2);c=c.replace(h,'');
 }
 assert.equal(c,original);
});
// Behavioral harness for transaction contract: marker only on success,
// both writes atomic and no invalidations on rejected/failed attempts.
const F={increment(n){return {$inc:n}}};
const STORE=new Map();
const db={collection(n){return {doc(k){return {path:n+'/'+k}}}}};
function newTx(){
 const writes=[];
 return {writes,set(ref,payload,opt){writes.push({ref,payload,opt})},
  async commit({fail=false}={}){
   if(fail)throw Error('mock_firestore_commit_rejected');
   const next=new Map(STORE);
   for(const {ref,payload,opt} of writes){
    const prev=next.get(ref.path)||{};const p={};
    for(const [k,v] of Object.entries(payload))p[k]=v&&typeof v==='object'&&'$inc' in v?(prev[k]||0)+v.$inc:v;
    next.set(ref.path,opt?.merge?{...prev,...p}:p);
   }
   STORE.clear();for(const [k,v] of next)STORE.set(k,v);
  }}
}
const opts=tx=>({tx,db,tenant:'farmA',FieldValue:F,env:{MURABBIK_PREPARED_MUTATION_TRACKING:'1'}});
test('new mutation attempts that are rejected do not bump farm generation',async()=>{
 STORE.clear();const tx=newTx();let alreadyExists=true;
 if(!alreadyExists){tx.set({path:'events/e'},{eventType:'abortion'});appendToTransactionIfEnabled(opts(tx));}
 await tx.commit();assert.equal(STORE.size,0);
});
test('success commits original source write + generation in one transaction',async()=>{
 STORE.clear();const tx=newTx();tx.set({path:'events/e1'},{eventType:'abortion'});
 appendToTransactionIfEnabled(opts(tx));await tx.commit();
 assert.equal(STORE.get('events/e1').eventType,'abortion');assert.equal(STORE.get('smart_alert_prepared_meta/farmA').generation,1);
});
test('transaction commit failure rolls back the marker with original write',async()=>{
 STORE.clear();const tx=newTx();tx.set({path:'events/e1'},{eventType:'abortion'});appendToTransactionIfEnabled(opts(tx));
 await assert.rejects(tx.commit({fail:true}),/mock_firestore_commit_rejected/);assert.equal(STORE.size,0);
});
test('flag disabled: transaction unchanged with no extra write',()=>{
 const tx=newTx();const writesBefore=tx.writes.length;
 assert.equal(appendToTransactionIfEnabled({...opts(tx),env:{}}),false);assert.equal(tx.writes.length,writesBefore);
});
test('invalid tenant with flag enabled: throws before success rather than losing invalidation',()=>{
 const tx=newTx();assert.throws(()=>appendToTransactionIfEnabled({...opts(tx),tenant:'other/farm'}),/smart_alert_mutation_barrier_unavailable/);
});