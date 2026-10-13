'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const m = require('./server/smart-alert-prepared-read');
const {prepareIfCertified} = require('./server/smart-alert-prepared-publisher');
const r = id => ({id});
const control=r('control'), projection=r('actor-alerts');
const cert = {schema:m.EXPECTED_SCHEMA, generation:7,allMutationPathsCertified:true,
  historicalBackfillCertified:true,allSourceSideEffectsRelocated:true,allDeadlineSourcesCertified:true};
function mem(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k,v])=>[k,structuredClone(v)]));
  return {data,runTransaction: async work=>{
    const writes=[];
    const tx={get:async ref=>({exists:data.has(ref.id),data:()=>structuredClone(data.get(ref.id))}),
      set:(ref,value,opt)=>writes.push({id:ref.id,value:structuredClone(value),opt})};
    const value=await work(tx);
    for(const w of writes){data.set(w.id,w.opt?.merge?{...data.get(w.id),...w.value}:w.value);}return value;
  }};
}
const day='2026-10-13';
const deadlines=()=>Object.fromEntries(m.EXPECTED_SOURCES.map(name=>[name,2500]));
let collected=0;
const fresh=()=>{collected++;return {context:{today:day},alerts:[{id:'a',revision:'r'}],sourceErrors:[]};};
const opts=db=>({db,controlRef:control,preparedRef:projection,actorUid:'actor1',farmDay:day,
  collectLive:fresh,resolveDeadlines:deadlines,currentFarmDay:async()=>day,clock:()=>1000});

test('without complete certification makes no expensive collection or writes',async()=>{
  collected=0;const db=mem({[control.id]:{...cert,historicalBackfillCertified:false}});
  assert.deepEqual(await prepareIfCertified(opts(db)),{status:'not_certified'});
  assert.equal(collected,0);assert.equal(db.data.has(projection.id),false);
});
test('no next-change resolver means no work',async()=>{
  collected=0;const db=mem({[control.id]:cert});
  assert.deepEqual(await prepareIfCertified({...opts(db),resolveDeadlines:undefined}),{status:'not_ready'});
  assert.equal(collected,0);
});
test('certified live snapshot is published and readable',async()=>{
  const db=mem({[control.id]:cert});const result=await prepareIfCertified(opts(db));
  assert.deepEqual(result,{status:'published'});
  const snapshot=await m.readIfFresh({db,controlRef:control,preparedRef:projection,
    actorUid:'actor1',farmDay:day,nowMs:1400});
  assert.deepEqual(snapshot.alerts,[{id:'a',revision:'r'}]);
});
test('mutation committed while building prevents publication',async()=>{
  const db=mem({[control.id]:cert});
  const result=await prepareIfCertified({...opts(db),collectLive:async()=>{
    await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,control));
    return fresh();
  }});
  assert.deepEqual(result,{status:'changed'});assert.equal(db.data.has(projection.id),false);
});
test('failed source never publishes',async()=>{
  const db=mem({[control.id]:cert});
  assert.deepEqual(await prepareIfCertified({...opts(db),collectLive:async()=>({
    context:{today:day},alerts:[{id:'x'}],sourceErrors:['vaccination_program_tasks']
  })}),{status:'incomplete'});
  assert.equal(db.data.has(projection.id),false);
});
test('missing source deadline never publishes',async()=>{
  const db=mem({[control.id]:cert});let d=deadlines();delete d.daily_farm_greeting;
  assert.deepEqual(await prepareIfCertified({...opts(db),resolveDeadlines:async()=>d}),{status:'deadlines_not_certified'});
  assert.equal(db.data.has(projection.id),false);
});
test('next source expiry gates publication window',async()=>{
  const db=mem({[control.id]:cert});let d=deadlines();d.vaccination_program_tasks=1200;
  assert.deepEqual(await prepareIfCertified({...opts(db),resolveDeadlines:async()=>d}),{status:'published'});
  assert.equal(db.data.get(projection.id).validUntilMs,1200);
  assert.equal(await m.readIfFresh({db,controlRef:control,preparedRef:projection,
    actorUid:'actor1',farmDay:day,nowMs:1200}),null);
});
test('farm day rolled during collection refuses publication',async()=>{
  const db=mem({[control.id]:cert});
  assert.deepEqual(await prepareIfCertified({...opts(db),currentFarmDay:async()=> '2026-10-14'}),{status:'farm_day_changed'});
  assert.equal(db.data.has(projection.id),false);
});
test('old snapshot day differs from collection day refuses publication',async()=>{
  const db=mem({[control.id]:cert});
  assert.deepEqual(await prepareIfCertified({...opts(db),collectLive:async()=>({
    context:{today:'2026-10-12'},alerts:[],sourceErrors:[]
  })}),{status:'incomplete'});
  assert.equal(db.data.has(projection.id),false);
});
test('unusable oversized payload refuses publication',async()=>{
  const db=mem({[control.id]:cert});
  assert.deepEqual(await prepareIfCertified({...opts(db),collectLive:async()=>({
    context:{today:day},alerts:[{content:'a'.repeat(600000)}],sourceErrors:[]
  })}),{status:'oversize'});
  assert.equal(db.data.has(projection.id),false);
});
test('read stays invalid after later mutation of certified version',async()=>{
  const db=mem({[control.id]:cert});await prepareIfCertified(opts(db));
  await db.runTransaction(tx=>m.invalidateWithSourceWrite(tx,control));
  assert.equal(await m.readIfFresh({db,controlRef:control,preparedRef:projection,
    actorUid:'actor1',farmDay:day,nowMs:1400}),null);
});