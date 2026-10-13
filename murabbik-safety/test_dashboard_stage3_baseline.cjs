const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname,'dashboard_stage3_fixture.html'), 'utf8');
const helperStart = source.indexOf('// Smart Alerts browser coordination');
const helperEnd = source.indexOf('async function respondMurabbikSmartAlert(', helperStart);
const getStart = source.indexOf('async function loadMurabbikSmartAlerts()');
const getEnd = source.indexOf('// ============ تشغيل', getStart);
assert(helperStart>0&&helperEnd>helperStart&&getStart>helperEnd&&getEnd>getStart);
const script = source.slice(helperStart, helperEnd)+'\n'+source.slice(getStart,getEnd);
const delay = ()=>new Promise(setImmediate);
function deferred(){ let resolve,reject; const promise = new Promise((r,j)=>{resolve=r; reject=j;}); return {promise,resolve,reject}; }
async function main(){
 const calls=[];let drawn=0;
 const ctx={currentUserId:'user_1',document:{hidden:false},API_BASE:'', dashboardAlertSources:{murabbik:[]},
   dashboardMurabbikUiAlert:x=>x,
   refreshDashboardSmartAlert:()=>{drawn++},
   fetch:(url)=>{const d=deferred();calls.push({url,...d});return d.promise},
   console:{warn:()=>{}}, };
 vm.createContext(ctx);vm.runInContext(script,ctx);
 // Test initial GET single-flight
 const g1=vm.runInContext('loadMurabbikSmartAlerts()',ctx);
 const g2=vm.runInContext('loadMurabbikSmartAlerts()',ctx);
 assert.equal(calls.length,1,'duplicate GET blocked');
 await g2;
 calls[0].resolve({json:()=>Promise.resolve({ok:true,currentAlert:{id:'initial'}})});await g1;
 assert.equal(ctx.dashboardAlertSources.murabbik[0].id,'initial');
 assert.equal(drawn,1);
 // Test hidden tab avoids network.
 ctx.document.hidden=true;await vm.runInContext('loadMurabbikSmartAlerts()',ctx);
 assert.equal(calls.length,1);ctx.document.hidden=false;
 // Test that old GET cannot overwrite a successfully handled alert.
 const slow=vm.runInContext('loadMurabbikSmartAlerts()',ctx);
 assert.equal(calls.length,2);
 const a={disabled:false,textContent:'حسنًا'}, b={disabled:false,textContent:'ذكّرني لاحقًا'}, c={disabled:true,textContent:'تسجيل'};
 ctx.actions={querySelectorAll:()=>[a,b,c]};ctx.clicked=a;
 const work=deferred();ctx.runWork=()=>work.promise;
 const decision=vm.runInContext('mbkSmartAlertsRunDecision(actions,clicked,runWork)',ctx);
 assert.equal(a.disabled,true);assert.equal(b.disabled,true);assert.equal(c.disabled,true);
 assert.equal(a.textContent,'جارٍ التنفيذ…');
 const second=vm.runInContext('mbkSmartAlertsRunDecision(actions,clicked,runWork)',ctx);
 await second;
 // Even after POST success, a late GET is obsolete.
 ctx.dashboardAlertSources.murabbik=[{id:'after POST'}];
 work.resolve({ok:true});await decision;
 calls[1].resolve({json:()=>Promise.resolve({ok:true,currentAlert:{id:'stale GET'}})});await slow;
 assert.equal(ctx.dashboardAlertSources.murabbik[0].id,'after POST','old GET discarded');
 // Simulate newly rendered action buttons after the successful POST.
 a.disabled=false; b.disabled=false; c.disabled=true; a.textContent='حسنًا';
 // Test failure releases lock & restores initially disabled states.
 const fail=deferred();ctx.runWork=()=>fail.promise;
 const failPromise=vm.runInContext('mbkSmartAlertsRunDecision(actions,clicked,runWork)',ctx);
 fail.reject(Error('network issue'));
 await assert.rejects(failPromise,/network issue/);
 assert.equal(a.disabled,false);assert.equal(b.disabled,false);assert.equal(c.disabled,true);
 assert.equal(a.textContent,'حسنًا');
 // New GET works after failure, and is never cancelled as a side-effect.
 const recover=vm.runInContext('loadMurabbikSmartAlerts()',ctx);
 assert.equal(calls.length,3);
 calls[2].resolve({json:()=>Promise.resolve({ok:true,currentAlert:{id:'recovered'}})});
 await recover;assert.equal(ctx.dashboardAlertSources.murabbik[0].id,'recovered');
 // Check all three handlers use the common lock and one-minute interval remains.
 assert.equal((source.match(/await mbkSmartAlertsRunDecision\(actions,/g)||[]).length,3);
 assert.equal((source.match(/60 \* 1000/g)||[]).length,1);
 assert(source.includes("document.addEventListener('visibilitychange'"));
 console.log('PASS: 7 dashboard safeguards: GET single-flight, hidden, stale reply, shared action lock, duplicate decision, error reset, resumed GET');
}
main().catch(e=>{console.error(e);process.exit(1)});