const fs=require('fs'), vm=require('vm'), assert=require('node:assert/strict');
const s=fs.readFileSync(require('node:path').join(__dirname,'dashboard_stage3_fixture.html'),'utf8');
const helper=s.slice(s.indexOf('// Smart Alerts browser coordination'),s.indexOf('async function respondMurabbikSmartAlert('));
const get=s.slice(s.indexOf('async function loadMurabbikSmartAlerts()'),s.indexOf('// ============ تشغيل ============',s.indexOf('async function loadMurabbikSmartAlerts()')));
const visibility=s.match(/document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]*?\n      \}\);/)[0];
function def(){let resolve, reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {resolve,reject,promise}}
async function tick(){await new Promise(r=>setImmediate(r))}
async function main(){
  const requests=[];const listeners={};let drawn=0;let inflight=0;let peak=0;
  const ctx={document:{hidden:false,addEventListener:(e,fn)=>listeners[e]=fn},
   currentUserId:'u1',API_BASE:'',dashboardAlertSources:{murabbik:[]},
   dashboardMurabbikUiAlert:a=>a,refreshDashboardSmartAlert:()=>drawn++,
   console:{warn:()=>{}},fetch:()=>{const x=def();inflight++;peak=Math.max(peak,inflight);requests.push(x);return x.promise.finally(()=>inflight--)}};
  vm.createContext(ctx);vm.runInContext(helper+'\n'+get+'\n'+visibility,ctx);
  const first=vm.runInContext('loadMurabbikSmartAlerts()',ctx);
  assert.equal(requests.length,1);
  ctx.document.hidden=true;listeners.visibilitychange();
  assert.equal(requests.length,1);
  ctx.document.hidden=false;listeners.visibilitychange();
  assert.equal(requests.length,1,'must not overlap pending GET on resume');
  requests[0].resolve({json:async()=>({ok:true,currentAlert:{id:'outdated'}})});
  await first;await tick();
  assert.equal(requests.length,2,'fresh GET starts immediately after old finishes');
  assert.equal(ctx.dashboardAlertSources.murabbik.length,0,'old response discarded');
  assert.equal(peak,1,'requests must not overlap');
  requests[1].resolve({json:async()=>({ok:true,currentAlert:{id:'fresh'}})});
  await tick();await tick();
  assert.equal(ctx.dashboardAlertSources.murabbik[0].id,'fresh');
  assert.equal(drawn,1,'only fresh alert draws');
  // No third fetch should be queued from the completed resume.
  await tick();assert.equal(requests.length,2);
  // When no GET is pending, resume launches one GET immediately.
  ctx.document.hidden=true;listeners.visibilitychange();
  ctx.document.hidden=false;listeners.visibilitychange();
  assert.equal(requests.length,3);
  requests[2].resolve({json:async()=>({ok:true,currentAlert:{id:'new'}})});await tick();
  assert.equal(ctx.dashboardAlertSources.murabbik[0].id,'new');
  console.log('PASS 5 race assertions: one pending, stale ignored, queued fresh, no overlap, immediate idle resume');
}
main().catch(e=>{console.error(e);process.exitCode=1});