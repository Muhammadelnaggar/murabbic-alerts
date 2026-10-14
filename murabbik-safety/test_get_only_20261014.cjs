const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname,'server_get_only_shared_events_candidate.js'),'utf8');
const before = fs.readFileSync(path.join(__dirname,'server_original.js'),'utf8');
const beg=src.indexOf('const MURABBIK_SMART_ALERT_EVENTS_LIMIT = 8000;');
const end=src.indexOf('async function murabbikSmartAlertReproTruthSrv(',beg);
assert(beg>=0&&end>beg);
const unit=src.slice(beg,end);
const vaccStart=src.indexOf('const MURABBIK_VACCINATION_SMART_ALERT_STATUS = ');
const vaccEnd=src.indexOf('murabbikSmartAlertRegisterSourceSrv(\n  "vaccination_program_tasks",',vaccStart);
assert(vaccStart>=0&&vaccEnd>vaccStart);
const sourceFn=src.slice(vaccStart,vaccEnd);
const cases=[];
async function test(name,fn){await fn();cases.push(name);console.log('PASS',cases.length,name)}
function makeDocs(n,tenant='farmA'){
 return Array.from({length:n},(_,i)=>({id:`e${String(i+1).padStart(5,'0')}`,data(){return {animalNumber:String(i%397),type:i%2?'vaccination':'insemination',date:'2026-10-13',userId:tenant}}}));
}
function mocked(eventsByUser,opts={}){
 const queries=[];
 const db = {
  collection(col) {
   assert.equal(col,'events');
   return {
    where(field,op,userId) {
     assert.equal(field,'userId');
     assert.equal(op,'==');
     return {
      limit(max) {
       return {
        async get() {
         queries.push({userId,max});
         if(max===8000&&opts.fail8000)throw Error('8000 unavailable');
         if(max===5000&&opts.fail5000)throw Error('5000 unavailable');
         const rows=(eventsByUser[userId]||[]).slice(0,max);
         return {
          docs: rows,
          size: rows.length,
          empty: rows.length===0,
          forEach(cb,thisArg){rows.forEach(cb,thisArg)}
         };
        }
       };
      }
     };
    }
   };
  }
 };
 const sandbox={db,console:{warn:()=>{},log:()=>{}},calvingNormDigitsOnlySrv:x=>String(x??'').replace(/\D/g,''),murabbikSmartAlertTextSrv:x=>String(x??'').trim(),Promise};
 vm.createContext(sandbox);
 vm.runInContext(unit,sandbox,{filename:'real-shared-events-functions.js'});
 const ctx=(userId)=>{
  const context={userId,memo:new Map()};
  context.load=async(key,loader)=>{
   if(!context.memo.has(key))context.memo.set(key,Promise.resolve().then(loader));
   return context.memo.get(key)
  };
  return context;
 };
 return {sandbox,queries,ctx};
}
function normalizedDocs(snapshot){const out=[];snapshot.forEach((row)=>out.push(row.id));return out}
async function run(){
 for(const n of [0,1,397,3984,4999,5000,5001,7999,8000]){
  await test(`shared 8000 + vaccine first 5000 preserve ordering at ${n} docs`,async()=>{
   const all=makeDocs(n); const m=mocked({farmA:all});const c=m.ctx('farmA');
   const [indexed,vaccine]=await Promise.all([m.sandbox.murabbikSmartAlertEventsIndexSrv(c),m.sandbox.murabbikSmartAlertVaccinationEventsSnapshotSrv(c)]);
   assert.equal(m.queries.length,1);assert.deepEqual(m.queries[0],{userId:'farmA',max:8000});
   assert.equal(indexed.rows.length,Math.min(8000,n));assert.equal(indexed.complete,n<8000);
   assert.deepEqual(normalizedDocs(vaccine),all.slice(0,5000).map(d=>d.id));
   assert.equal(indexed.byAnimal.get('0')?.length>0,n>0);
  });
 }
 await test('initial-age and initial-maternal both reuse identical vaccine promise',async()=>{
  const m=mocked({farmA:makeDocs(5032)}),c=m.ctx('farmA');
  const [a,b,d]=await Promise.all([
   m.sandbox.murabbikSmartAlertVaccinationEventsSnapshotSrv(c),
   m.sandbox.murabbikSmartAlertVaccinationEventsSnapshotSrv(c),
   m.sandbox.murabbikSmartAlertEventsIndexSrv(c)
  ]);
  assert.equal(m.queries.length,1);assert.deepEqual(normalizedDocs(a),normalizedDocs(b));assert.equal(d.rows.length,5032);
 });
 await test('independent per-tenant queries and no cross-farm reads',async()=>{
  const m=mocked({farmA:makeDocs(11,'farmA'),farmB:makeDocs(13,'farmB')});
  const [a,b]=await Promise.all([m.sandbox.murabbikSmartAlertEventsIndexSrv(m.ctx('farmA')),m.sandbox.murabbikSmartAlertEventsIndexSrv(m.ctx('farmB'))]);
  assert.deepEqual(m.queries,[{userId:'farmA',max:8000},{userId:'farmB',max:8000}]);
  assert.equal(a.rows.length,11);assert.equal(b.rows.length,13);
 });
 await test('new request always rereads fresh events (no cross-request cache)',async()=>{
  const events={farmA:makeDocs(3)};const m=mocked(events);
  const a=await m.sandbox.murabbikSmartAlertEventsIndexSrv(m.ctx('farmA'));
  events.farmA.push(...makeDocs(1).map(x=>({...x,id:'extra'})));
  const b=await m.sandbox.murabbikSmartAlertEventsIndexSrv(m.ctx('farmA'));
  assert.equal(a.rows.length,3);assert.equal(b.rows.length,4);assert.equal(m.queries.length,2);
 });
 await test('failed 8000 read falls back only vaccine to original 5000 query',async()=>{
  const m=mocked({farmA:makeDocs(12)},{fail8000:true});
  const a=await m.sandbox.murabbikSmartAlertVaccinationEventsSnapshotSrv(m.ctx('farmA'));
  assert.deepEqual(m.queries,[{userId:'farmA',max:8000},{userId:'farmA',max:5000}]);
  assert.equal(a.size,12);
 });
 await test('when 8000 AND 5000 fail, no stale or empty fake snapshot',async()=>{
  const m=mocked({farmA:makeDocs(12)},{fail8000:true,fail5000:true});
  await assert.rejects(m.sandbox.murabbikSmartAlertVaccinationEventsSnapshotSrv(m.ctx('farmA')));
  assert.equal(m.queries.length,2);
 });
 await test('raw events payload preserves old types and fields',async()=>{
  const docs=[{id:'historical',data(){return {type:'تحصين',vaccine:'old_name',animalNumber:'٠٠١',programRowId:'v1'}}}];
  const m=mocked({farmA:docs});const index=await m.sandbox.murabbikSmartAlertEventsIndexSrv(m.ctx('farmA'));
  assert.equal(index.rows[0].vaccine,'old_name');assert.equal(index.rows[0].type,'تحصين');
 });
 await test('new code only changes vaccine input and does not alter medical algorithm bodies',async()=>{
  const start='async function vaccinationInitialAgeAlertGroupsSrv(';
  const next='async function vaccinationInitialMaternalAlertGroupsSrv(';
  const maternalEnd='async function vaccinationDashboardAlertsDataSrv(';
  const oldA=before.slice(before.indexOf(start),before.indexOf(next));
  const newA=src.slice(src.indexOf(start),src.indexOf(next));
  assert.equal(oldA,newA);
  // Maternal function end is before dashboard data; ensure identical all middle text
  const oldB=before.slice(before.indexOf(next),before.indexOf(maternalEnd));
  const newB=src.slice(src.indexOf(next),src.indexOf(maternalEnd));
  assert.equal(oldB,newB);
 });
 await test('vaccination standalone API retains default 5000 query',async()=>{
  assert.match(src,/typeof loadInitialEventsSnapshot === "function"[\s\S]{0,200}?: db[\s\S]{0,100}?\.limit\(5000\)/);
  assert.match(src,/vaccinationDashboardAlertsDataSrv\(\{\s*userId: req\.userId,\s*profileUid:/);
 });
 await test('only all-source collector shares 8000; POST live validation is isolated',async()=>{
  assert.match(src,/async function murabbikSmartAlertCollectSrv\(req\) \{[\s\S]{0,400}?shareLargeEventsSnapshot: true/);
  const start=src.indexOf('async function murabbikSmartAlertLiveResponseAlertSrv(');
  const end=src.indexOf('app.post(\n  "/api/smart-alerts/respond",',start);
  assert(start>0&&end>start);assert(!src.slice(start,end).includes('shareLargeEventsSnapshot: true'));
  assert.match(src,/context\.shareLargeEventsSnapshot === true[\s\S]{0,220}?murabbikSmartAlertVaccinationEventsSnapshotSrv\(context\)/);
 });
 await test('source builder injects callback only on collector context',async()=>{
  let received;
  const v={murabbikSmartAlertTextSrv:x=>String(x??''),tenantKey:x=>String(x??'').trim(),vaccinationDashboardAlertsDataSrv:async opts=>{received=opts;return {alerts:[]}}};
  vm.createContext(v);vm.runInContext(sourceFn,v);
  for(const [flag,userId,expected] of [[true,'farmA',true],[false,'farmA',false],[true,' farmA ',false]]){
   const c={userId,profileUid:'owner',shareLargeEventsSnapshot:flag,memo:new Map(),load:async(_,fn)=>fn()};
   await v.murabbikVaccinationProgramAlertSourceSrv(c);
   assert.equal(typeof received.loadInitialEventsSnapshot,expected?'function':'object');
   if(!expected)assert.equal(received.loadInitialEventsSnapshot,null);
  }
 });
 console.log(`FINAL ${cases.length} focused scenarios passed`);
}
run().catch(e=>{console.error(e.stack||e);process.exitCode=1});