'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const m = require('./smart-alert-prepared-read');
const r = x => ({id: x});
function mem(initial={}) {
  const data = new Map(Object.entries(initial).map(([k,v])=>[k,structuredClone(v)]));
  return {data, runTransaction: async cb => {
    const writes=[];const tx={get:async ref => ({exists:data.has(ref.id),data:()=>structuredClone(data.get(ref.id))}),
      set:(ref,value,opt)=>writes.push([ref.id,structuredClone(value),opt])};
    const result=await cb(tx);
    for(const [k,v,o] of writes) data.set(k,o?.merge?{...data.get(k),...v}:v);
    return result;
  }};
}
const cert={schema:m.EXPECTED_SCHEMA,generation:7,allMutationPathsCertified:true,
  historicalBackfillCertified:true,allSourceSideEffectsRelocated:true,
  allDeadlineSourcesCertified:true};
const a=r('tenant-control'),b=r('actor-projection');
const args={actorUid:'auth_uid_1',farmDay:'2026-10-13',builtAtMs:1000,validUntilMs:3000,alerts:[{id:'a',revision:'r'}],sourceDeadlinesMs:Object.fromEntries(m.EXPECTED_SOURCES.map(name=>[name,3000]))};
test('disabled if not certified',async()=> {const db=mem({[a.id]:{...cert,historicalBackfillCertified:false}});assert.equal(await m.beginBuild(db,a),null);});
test('disabled when historical record missing',async()=>{const db=mem();assert.equal(await m.beginBuild(db,a),null);});
test('valid projection builds and reads same generation',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);assert.equal((await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args})),'published');assert.deepEqual((await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:args.actorUid,farmDay:args.farmDay,nowMs:2000})).alerts,args.alerts);});
test('rejects new version before publication',async()=> {const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,a));assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args}),'changed');});
test('rejects projection if edit after publication',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args});await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,a));assert.equal(await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:args.actorUid,farmDay:args.farmDay,nowMs:2000}),null);});
test('expiry at exact deadline',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args});assert.equal(await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:args.actorUid,farmDay:args.farmDay,nowMs:3000}),null);});
test('prevents next day reused projection',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args});assert.equal(await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:args.actorUid,farmDay:'2026-10-14',nowMs:2000}),null);});
test('prevents another actor reading prepared alert',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args});assert.equal(await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:'auth_uid_2',farmDay:args.farmDay,nowMs:2000}),null);});
test('never publishes source errors',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args,sourceErrors:['vaccination']}),'unusable');});
test('never publishes invalid horizon',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args,validUntilMs:1000}),'unusable');});
test('never publishes oversize payload',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args,alerts:[{text:'A'.repeat(550000)}]}),'oversize');});
test('mutation increments generation with coverage unchanged',async()=>{const db=mem({[a.id]:cert});assert.equal(await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,a)),8);assert.equal(db.data.get(a.id).generation,8);assert.equal(db.data.get(a.id).historicalBackfillCertified,true);});
test('no accidental certification on uninitialized data',async()=>{const db=mem();assert.equal(await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,a)),1);assert.equal(await m.beginBuild(db,a),null);});

test('does not use partial deadline coverage',async()=> {const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);const deadlines={...args.sourceDeadlinesMs};delete deadlines.vaccination_program_tasks;assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args,sourceDeadlinesMs:deadlines}),'unusable');});
test('never publishes when one source becomes due earlier',async()=> {const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);const deadlines={...args.sourceDeadlinesMs,ovsynch_protocol_steps:2000};assert.equal(await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args,sourceDeadlinesMs:deadlines}),'unusable');});

test('rejects persisted results with missing source deadline',async()=>{const db=mem({[a.id]:cert});const token=await m.beginBuild(db,a);await m.publishIfUnchanged({db,controlRef:a,preparedRef:b,token,...args});delete db.data.get(b.id).sourceDeadlinesMs.daily_farm_greeting;assert.equal(await m.readIfFresh({db,controlRef:a,preparedRef:b,actorUid:args.actorUid,farmDay:args.farmDay,nowMs:2000}),null);});