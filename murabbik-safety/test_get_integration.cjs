'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code=fs.readFileSync(__dirname+'/server_stage4_get_candidate.js','utf8');
const start=code.indexOf('async function murabbikSmartAlertReadPreparedCandidateSrv(req) {');
assert(start>=0);
const end=code.indexOf('// END PREPARED SMART ALERT READ CANDIDATE.',start);
const fn=code.slice(start,end);
let calls=0,read=async()=>null;
const sourceNames=['milk_mirror','dry_off_due','close_up_due','calving_overdue',
'pregnancy_diagnosis_due','pregnancy_confirmation_120_due','uterine_check_followup',
'postpartum_insemination_followup','vaccination_program_tasks','ovsynch_protocol_steps','daily_farm_greeting'];
const sourceRegistry=new Map(sourceNames.map(name=>[name,true]));
const ctx={process:{env:{}},murabbikSmartAlertSourcesSrv:sourceRegistry,
  require:()=>({EXPECTED_SOURCES:sourceNames,readIfFresh:async args=>{calls++;return read(args);}}),
  tenantKey:x=>x, murabbikSmartAlertActorUidSrv:req=>req.authSession.uid,
  farmTodayISOSrv:async()=> '2026-10-13',
  db:{collection:name=>({doc:id=>({path:name+'/'+id,collection:sub=>({doc:id2=>({path:name+'/'+id+'/'+sub+'/'+id2})})})})},
  console:{warn:()=>{}},Date,Number};
vm.createContext(ctx);vm.runInContext(fn+'\nthis.reader=murabbikSmartAlertReadPreparedCandidateSrv;',ctx);
const req={userId:'farm1',authSession:{uid:'actor1'}};
test('opt-out calls zero DB reads',async()=>{calls=0;ctx.process.env={};assert.equal(await ctx.reader(req),null);assert.equal(calls,0);});
test('enabled but uncertified returns null for existing collector',async()=>{ctx.process.env.MURABBIK_PREPARED_READ_ENABLE='1';calls=0;read=async()=>null;assert.equal(await ctx.reader(req),null);assert.equal(calls,1);});
test('existing certified result reused with correct actor/day',async()=>{read=async args=>{assert.equal(args.actorUid,'actor1');assert.equal(args.farmDay,'2026-10-13');return {alerts:[{id:'the-alert'}],validUntilMs:Date.now()+3600000};};const value=await ctx.reader(req);assert.equal(value.alerts[0].id,'the-alert');assert.equal(value.context.today,'2026-10-13');assert.deepEqual(Array.from(value.sourceErrors),[]);});
test('error triggers original collector fallback',async()=>{read=async()=>{throw Error('broken prepared read');};assert.equal(await ctx.reader(req),null);});
test('empty actor cannot access prepared projection',async()=>{calls=0;assert.equal(await ctx.reader({userId:'farm1',authSession:{uid:''}}),null);assert.equal(calls,0);});
test('GET old fallback and response contract retained',()=>{assert(code.includes('await murabbikSmartAlertReadPreparedCandidateSrv(req) ||\n  await murabbikSmartAlertCollectSrv(req);'));assert(code.includes('await murabbikSmartAlertApplyUserStateSrv('));assert(code.includes('murabbikSmartAlertPublicSrv('));assert(code.includes('murabbikSmartAlertArchiveSyncSrv('));});

test('new source registration disables prepared fast path',async()=>{calls=0;sourceRegistry.set('new_medical_alert',true);assert.equal(await ctx.reader(req),null);assert.equal(calls,0);sourceRegistry.delete('new_medical_alert');});

test('deadline reached while fetching means fallback',async()=>{read=async()=>({alerts:[{id:'stale'}],validUntilMs:Date.now()-1});assert.equal(await ctx.reader(req),null);});