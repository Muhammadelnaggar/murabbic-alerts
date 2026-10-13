'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {appendToBatchIfEnabled,appendToTransactionIfEnabled} = require('../server/smart-alert-mutation-barrier');
const prepared = require('../server/smart-alert-prepared-read');
const parent = path.join(__dirname,'..');
const original = fs.readFileSync(path.join(parent,'server_stage4_get_candidate.js'),'utf8');
const updated = fs.readFileSync(path.join(parent,'server_stage6_candidate.js'),'utf8');
const FIELD_INCREMENT = Symbol('Increment');
const FieldValue = {increment(n){return {[FIELD_INCREMENT]:n}}};
const data=new Map();
function fakeDb(){
  const self={collection(coll){return {doc(id){return {id:coll+'/'+id}}}},batch(){
    const ops=[];
    return {ops,set(ref,value,opts){ops.push({ref,value,opts});return this},
      async commit(fail=false){if(fail)throw new Error('firestore_commit_failed');
        const pending = new Map(data);
        for(const {ref,value,opts} of ops){const old=pending.get(ref.id)||{};const patch={};
          for(const [k,v] of Object.entries(value)){
            patch[k]=v?.[FIELD_INCREMENT]!==undefined?(old[k]||0)+v[FIELD_INCREMENT]:v;
          }
          pending.set(ref.id,opts?.merge?{...old,...patch}:patch);
        }
        data.clear();for(const [k,v] of pending)data.set(k,v);
        return ops.length;
      }
    };
  }};return self;
}
function seeded() {data.clear();return fakeDb()}
const opts=(db,batch,tenant='farmA',env={'MURABBIK_PREPARED_MUTATION_TRACKING':'1'})=>({db,batch,tenant,FieldValue,env});
const routes=['/api/insemination/save','/api/pregnancy-diagnosis/save',
 '/api/uterine-check/save','/api/disease/save','/api/lameness/save',
 '/api/mastitis/save','/api/weaning/save','/api/ovsynch/save'];

test('flag OFF by default: no additional Firestore IO',()=>{
  const db=seeded(),batch=db.batch();batch.set({id:'events/e1'},{userId:'farmA'});
  assert.equal(appendToBatchIfEnabled({...opts(db,batch),env:{}}),false);
  assert.equal(batch.ops.length,1);
});

test('feature ON: original document + generation increment commit atomically',async()=>{
  const db=seeded(),batch=db.batch();batch.set({id:'events/e1'},{userId:'farmA'});
  assert.equal(appendToBatchIfEnabled(opts(db,batch)),true);
  assert.equal(batch.ops.length,2);
  await batch.commit();
  assert.deepEqual(data.get('events/e1'),{userId:'farmA'});
  assert.equal(data.get('smart_alert_prepared_meta/farmA').generation,1);
  assert.equal(prepared.certified(data.get('smart_alert_prepared_meta/farmA')),false);
});

test('failed commit: cannot advance control while missing original data',async()=>{
  const db=seeded(),batch=db.batch();batch.set({id:'events/e2'},{date:'2026-10-13'});
  appendToBatchIfEnabled(opts(db,batch));
  await assert.rejects(()=>batch.commit(true),/firestore_commit_failed/);
  assert.equal(data.has('events/e2'),false);
  assert.equal(data.has('smart_alert_prepared_meta/farmA'),false);
});

test('multiple commits from different instances share one global generation',async()=>{
  const db=seeded();
  for(let i=0;i<120;i++){
    const batch=db.batch();batch.set({id:'events/e'+i},{number:i});
    appendToBatchIfEnabled(opts(db,batch));await batch.commit();
  }
  assert.equal(data.get('smart_alert_prepared_meta/farmA').generation,120);
  assert.equal(data.size,121);
});

test('different farms cannot invalidate each others records',async()=>{
  const db=seeded();
  for (const farm of ['farmA','farmB']) {
    const batch=db.batch();batch.set({id:'events/'+farm},{userId:farm});
    appendToBatchIfEnabled(opts(db,batch,farm));await batch.commit();
  }
  assert.equal(data.get('smart_alert_prepared_meta/farmA').generation,1);
  assert.equal(data.get('smart_alert_prepared_meta/farmB').generation,1);
});

test('existing certification flags preserved, generation atomically increased',async()=>{
  const db=seeded();data.set('smart_alert_prepared_meta/farmA',{
    schema:prepared.EXPECTED_SCHEMA,generation:8,allMutationPathsCertified:false,
    historicalBackfillCertified:false,allDeadlineSourcesCertified:false,
    allSourceSideEffectsRelocated:false
  });const batch=db.batch();batch.set({id:'events/new'},{number:1});
  appendToBatchIfEnabled(opts(db,batch));await batch.commit();
  const saved=data.get('smart_alert_prepared_meta/farmA');
  assert.equal(saved.generation,9);assert.equal(saved.allMutationPathsCertified,false);
  assert.equal(prepared.certified(saved),false);
});

test('enabled-but-misconfigured barrier fails closed before batch commit',async()=>{
  const db=seeded();const batch=db.batch();batch.set({id:'events/new'},{n:1});
  assert.throws(()=>appendToBatchIfEnabled(opts(db,batch,'wrong/farm')),/unavailable/);
  assert.throws(()=>appendToBatchIfEnabled({...opts(db,batch),FieldValue:{}}),/unavailable/);
  assert.equal(batch.ops.length,1);
});

test('candidate has precisely one pre-commit barrier in all 8 baseline batch routes',()=>{
  for(const route of routes){
    const key='"'+route+'"';const start=updated.indexOf(key), stop=updated.indexOf('app.post(',start+key.length);
    assert(start>=0,route);const sec=updated.slice(start,stop<0?undefined:stop);
    assert.equal((sec.match(/appendToBatchIfEnabled\(/g)||[]).length,1,route);
    assert(sec.indexOf('appendToBatchIfEnabled') < sec.indexOf('await batch.commit()'),route);
    assert.equal((sec.match(/await batch.commit\(\);/g)||[]).length,1,route);
  }
});

test('candidate GET stays hard-disabled even if env and DB cert flags are turned on',()=>{
  assert.match(updated,/const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;/);
  assert.match(updated,/if \(!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED\) return null;/);
});

test('removing 14 barrier hooks and hard stop reproduces Stage4 candidate',()=>{
  const inject=`// Stage 6: write generation alongside the event and animal updates.\n// The feature flag is OFF by default; it never certifies the prepared read.\nrequire('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({\n  batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue\n});\n`;
  let copy=updated.replace(`  // HARD STOP: incomplete write paths/deadlines and historical migration.\n  // This cannot be enabled by environment variables or Firestore data alone.\n  const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;\n  if (!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED) return null;\n`,'');
  for(let i=0;i<8;i++){assert(copy.includes(inject));copy=copy.replace(inject,'')}
  const txHook=`// Stage 6: invalidate prepared output atomically with this event transaction.\nrequire('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({\n  tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue\n});\n`;
  const highValueHook=v=>`// Stage 6: invalidation is committed atomically with each source event.\nrequire('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({\n  batch: ${v}, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue\n});\n`;
  for(let i=0;i<2;i++){assert(copy.includes(txHook));copy=copy.replace(txHook,'')}
  for(const v of ['writeBatch','batch']){
    const hook=highValueHook(v);assert(copy.includes(hook));copy=copy.replace(hook,'');
  }
  for (const extra of [`      // Stage 6: correction invalidates prior results in the SAME batch.
      require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
        batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
      });
`,
    `            // Stage 6: atomic generation bump only for successful calving.
            require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
              tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
            });
`]) {
    assert(copy.includes(extra));copy=copy.replace(extra,'');
  }
  assert.equal(copy,original);
});


test('two Firestore transaction routes have invalidation ONLY on success branches',()=>{
  for (const route of ['/api/close-up/save','/api/dry-off/save']) {
    const start=updated.indexOf('"'+route+'"'), end=updated.indexOf('app.post(',start+route.length+2);
    assert(start!==-1,route);const block=updated.slice(start,end<0?undefined:end);
    assert.equal((block.match(/appendToTransactionIfEnabled\(/g)||[]).length,1,route);
    assert(block.indexOf('appendToTransactionIfEnabled')>block.indexOf('await updateAnimalAfter'),route);
    assert(block.indexOf('appendToTransactionIfEnabled')<block.indexOf('created: true'),route);
  }
});

test('vaccination and daily milk writers invalidate once per small writeBatch',()=>{
  for(const [route,varname] of [['/api/vaccination/save','writeBatch'],['/api/daily-milk/save','batch']]){
    const start=updated.indexOf('"'+route+'"'),end=updated.indexOf('app.post(',start+route.length+2);
    assert(start>=0,route);const block=updated.slice(start,end<0?undefined:end);
    assert.equal((block.match(/appendToBatchIfEnabled\(/g)||[]).length,1,route);
    assert(block.indexOf('appendToBatchIfEnabled')<block.indexOf('await '+varname+'.commit()'),route);
  }
});

test('transaction marker is atomic and does not run for rejected decision',async()=>{
  const db=seeded();
  const outcome=async allow=>{
    const tx=db.batch();
    if(!allow)return {created:false};
    tx.set({id:'events/tx-only'}, {type:'close_up'});
    appendToTransactionIfEnabled({...opts(db,tx),tx,batch:undefined});
    await tx.commit();return {created:true};
  };
  assert.deepEqual(await outcome(false),{created:false});
  assert.equal(data.size,0);
  assert.deepEqual(await outcome(true),{created:true});
  assert.equal(data.get('smart_alert_prepared_meta/farmA').generation,1);
  assert.equal(data.get('events/tx-only').type,'close_up');
});

test('historical event correction marker added before the original commit',()=>{
  const mark=updated.indexOf('Stage 6: correction invalidates prior results in the SAME batch.');
  assert(mark>0);
  const target=updated.indexOf('await batch.commit();',mark);
  assert(target>mark);
  assert(updated.slice(mark,target).includes('tenantKey(uid)'));
});

test('calving marker added after calf writes, and before success return',()=>{
  const mark=updated.indexOf('Stage 6: atomic generation bump only for successful calving.');
  assert(mark>0);
  const initial=updated.lastIndexOf('for (',mark);
  const next=updated.indexOf('created:',mark);
  assert(initial>=0 && initial<mark && next>mark);
  assert(updated.slice(mark,next).includes('appendToTransactionIfEnabled'));
});