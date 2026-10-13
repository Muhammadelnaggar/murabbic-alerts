const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const paths = {
  original: require('node:path').join(__dirname, 'server_original.js'),
  revised: require('node:path').join(__dirname, 'server_stage2_navigation_candidate.js')
};
const example = [
 {id:'msa_01',revision:'msr_01',source:'vaccination_program_tasks',action:{type:'navigate',url:'vaccination.html'},kind:'operational',_snoozeMinutes:45},
 {id:'msa_02',revision:'msr_02',source:'dry_off_due',action:{type:'navigate',url:'dry-off.html'},kind:'operational',_snoozeMinutes:45},
 {id:'msa_03',revision:'msr_03',source:'milk_anomaly',action:{type:'none'},kind:'technical',_snoozeMinutes:45}
];
function factory(codeName){
 const source=fs.readFileSync(paths[codeName],'utf8');
 const start=source.indexOf('app.post(\n  "/api/smart-alerts/respond",');
 const end=source.indexOf('// ============================================================\n//       DAILY TASKS REPORT',start);
 assert(start>0&&end>start);
 const route = source.slice(start,end);
 let handler;
 const state=new Map(); const steps=[];
 const v={
  app:{post:(path,auth,fn)=>{assert.equal(path,'/api/smart-alerts/respond');handler=fn;}},
  requireUserId:()=>{},
  db:{},
  admin:{firestore:{FieldValue:{serverTimestamp:()=>({marker:'time'})},Timestamp:{fromMillis:ms=>({toMillis:()=>ms})}}},
  murabbikSmartAlertTextSrv:(v)=>String(v||'').trim().replace(/\s+/g,' '),
  murabbikSmartAlertSourcesSrv:new Map(example.map(a=>[a.source,()=>a])),
  murabbikSmartAlertLiveResponseAlertSrv:async(_req,id,rev,sourceHint)=>{
    steps.push('live');
    if(v.failLive)throw new Error('live failed');
    if(sourceHint && v.murabbikSmartAlertSourcesSrv.has(sourceHint))
      return example.find(a=>a.source===sourceHint && a.id===id&&a.revision===rev)||null;
    return example.find(a=>a.id===id&&a.revision===rev)||null;
  },
  murabbikSmartAlertCollectSrv:async()=>{
    steps.push('collect');
    if(v.failCollect)throw new Error('collect failed');
    return {alerts:v.alerts||example,sourceErrors:[],context:{today:'2026-10-13',nowMs:Date.now()}};
  },
  murabbikSmartAlertStateRefSrv:(_req,id)=>({set:async(s,options)=>{
    steps.push('set');
    assert.equal(options.merge,true);
    if(v.failSave)throw new Error('save failed');
    state.set(id,s);
  }}),
  murabbikSmartAlertActorUidSrv:()=>"actor",
  murabbikSmartAlertApplyUserStateSrv:async(_req,alerts)=>{
    steps.push('apply');
    let hiddenCount=0;
    const visibleAlerts=alerts.filter(a=>{
      const s=state.get(a.id);
      if(!s)return true;
      if(s.decision==='acknowledged'||s.decision==='snoozed'){hiddenCount++;return false;}
      return true;
    });
    return {visibleAlerts,hiddenCount};
  },
  murabbikSmartAlertPublicSrv:a=>a?Object.fromEntries(Object.entries(a).filter(([k])=>k!=='_snoozeMinutes')):null,
  murabbikSmartAlertArchiveSyncSrv:async()=>{steps.push('archive');if(v.failArchive)throw new Error('archive failed')},
  console:{error:()=>{},warn:()=>{},log:()=>{}},Date,
 };
 vm.createContext(v); vm.runInContext(route,v,{filename:'server-post-extracted.js'});
 async function call(body){
   const req={body,userId:'farm',authSession:{uid:'actor'}};
   const out={statusCode:200,payload:null};
   const res={status(c){out.statusCode=c;return this;},json(o){steps.push('response');out.payload=JSON.parse(JSON.stringify(o));return this;}};
   steps.length=0;state.clear();
   await handler(req,res);
   return {out,steps:[...steps],state:new Map(state)};
 }
 return {v,call};
}
async function main(){
 let n=0; const checked=(desc)=>{n++;console.log('PASS',n,desc)};
 const f=factory('revised');
 const body={alertId:'msa_01',revision:'msr_01',source:'vaccination_program_tasks',decision:'acknowledged'};
 let x=await f.call(body);
 assert.equal(x.out.statusCode,200); assert.equal(x.out.payload.currentAlert.id,'msa_02');
 assert.deepEqual(x.steps,['collect','set','apply','response','archive']);checked('acknowledge: one collect, correct next after write, archive after response');
 x=await f.call({...body,decision:'snoozed'});
 assert.equal(x.out.statusCode,200);assert.equal(x.state.get('msa_01').snoozeMinutes,45);
 assert.equal(x.out.payload.currentAlert.id,'msa_02');assert.equal(x.steps.filter(x=>x==='collect').length,1);checked('snooze: same window and correct next');
 x=await f.call({...body,actionRequested:true});
 assert.equal(x.out.statusCode,200);assert.equal(x.out.payload.navigateUrl,'vaccination.html');assert.equal(x.out.payload.currentAlert,undefined);assert.deepEqual(x.steps,['live','set','response','archive']);checked('navigate: no all-sources collection, only live target verification, archive after reply');
 x=await f.call({...body,revision:'msr_old'});assert.equal(x.out.statusCode,409);assert.equal(x.steps.includes('set'),false);checked('stale revision rejected without writing');
 x=await f.call({...body,source:'dry_off_due'});assert.equal(x.out.statusCode,409);assert.equal(x.steps.includes('set'),false);checked('known but wrong source rejected');
 x=await f.call({...body,source:'unknown_hint'});assert.equal(x.out.statusCode,200);checked('legacy unknown source hint falls back to live collector');
 x=await f.call({...body,source:''});assert.equal(x.out.statusCode,200);checked('legacy missing source allowed');
 x=await f.call({...body,decision:'invalid'});assert.equal(x.out.statusCode,400);assert.equal(x.steps.length,1); // response only
 checked('invalid decision short-circuits all IO');
 f.v.failCollect=true;
 x=await f.call(body);assert.equal(x.out.statusCode,500);assert.equal(x.steps.includes('set'),false);f.v.failCollect=false;checked('collector failure writes no decision');
 f.v.failSave=true;
 x=await f.call(body);assert.equal(x.out.statusCode,500);assert.equal(x.steps.includes('apply'),false);f.v.failSave=false;checked('write failure aborts next-state processing');
 f.v.failArchive=true;
 x=await f.call(body);assert.equal(x.out.statusCode,200);f.v.failArchive=false;checked('archive failure does not invalidate persisted decision');
 f.v.alerts=[{...example[0],action:{type:'none'}}];
 x=await f.call({...body,actionRequested:true});assert.equal(x.out.statusCode,200);assert.equal(x.steps.includes('collect'),false);f.v.alerts=null;checked('navigation validates live source rather than cached collector');
 f.v.failSave=true;
 x=await f.call({...body,actionRequested:true});assert.equal(x.out.statusCode,500);assert.deepEqual(x.steps,['live','set','response']);f.v.failSave=false;checked('navigation never succeeds unless state write acknowledged');
 x=await f.call({...body,actionRequested:true,source:'dry_off_due'});assert.equal(x.out.statusCode,409);assert.deepEqual(x.steps,['live','response']);checked('navigation wrong valid source rejected before persistence');
 x=await f.call({...body,actionRequested:true,revision:'stale'});assert.equal(x.out.statusCode,409);assert.deepEqual(x.steps,['live','response']);checked('navigation outdated revision rejected');
 const old=factory('original');const oldRes=await old.call(body);const newRes=await f.call(body);
 for(const field of ['decision','alertId','revision','currentAlert','remainingCount','remainingOperational','remainingTechnical','hasMore','hiddenByInteractionCount','degraded','navigateUrl'])assert.deepEqual(newRes.out.payload[field],oldRes.out.payload[field],field);
 assert.deepEqual(oldRes.steps,['live','set','collect','apply','response','archive']);checked('POST response parity with original and removed one source rebuild');
 console.log(`FINAL ${n} scenario checks passed`);
}
main().catch(e=>{console.error(e);process.exit(1)});