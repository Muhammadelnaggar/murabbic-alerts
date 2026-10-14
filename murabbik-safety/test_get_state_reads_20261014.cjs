// Focused safety regression: GET-only parallel alert-state reads.
// Run from this folder: node test_get_state_reads_20261014.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const path = require('node:path');

const before = zlib.gunzipSync(
  fs.readFileSync(path.join(__dirname, 'server_get_only_shared_events_candidate_20261014.js.gz'))
).toString('utf8');
const after = fs.readFileSync(
  path.join(__dirname, 'server_get_state_reads_candidate_20261014.js'),
  'utf8'
);
new vm.Script(after, {filename: 'server_get_state_reads_candidate_20261014.js'});

const fnStart = 'async function murabbikSmartAlertApplyUserStateSrv(';
function extractFn(src) {
  const start = src.indexOf(fnStart);
  const end = src.indexOf('\n// =================================================', start);
  assert(start >= 0 && end > start, 'state function boundaries');
  return src.slice(start, end);
}
const oldFn = extractFn(before);
const newFn = extractFn(after);
assert.notEqual(oldFn, newFn);
let predicted = before.replace(oldFn, newFn);
const getAnchor = 'app.get("/api/smart-alerts", requireUserId, async (req, res) => {';
const oldCall = `const stateResult =
  await murabbikSmartAlertApplyUserStateSrv(
    req,
    result.alerts,
    result.context.nowMs
  );`;
const newCall = `const stateResult =
  await murabbikSmartAlertApplyUserStateSrv(
    req,
    result.alerts,
    result.context.nowMs,
    { parallelStateReads: true }
  );`;
const route = predicted.indexOf(getAnchor);
const call = predicted.indexOf(oldCall, route);
const followingPost = predicted.indexOf('\napp.post(', route);
assert(route >= 0 && call > route && (followingPost < 0 || call < followingPost));
predicted = predicted.slice(0, call) + newCall + predicted.slice(call + oldCall.length);
// No unrelated modifications anywhere across the 2.8M-character server.
assert.equal(after, predicted, 'only the state function and exact GET call may change');
assert.match(newFn, /options\?\.parallelStateReads === true/);
assert.match(newFn, /j \+= 100/);
assert.match(newFn, /i \+= 300/);

function runner(src, states, fail = false) {
  let inFlight = 0, peak = 0, reads = 0, ids = [];
  const db = {
    async getAll(...refs) {
      assert(refs.length <= 100, 'per-request read batch exceeds limit');
      reads++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      ids.push(...refs.map(r => r.id));
      await Promise.resolve();
      inFlight--;
      if (fail) throw Error('firestore-getAll-unavailable');
      return refs.map(ref => ({
        id: ref.id,
        exists: states.has(ref.id),
        data() { return states.get(ref.id); }
      }));
    }
  };
  const sandbox = {
    db,
    murabbikSmartAlertStateRefSrv: (req, id) => ({id: req.userId + ':' + id}),
    murabbikSmartAlertStateDocIdSrv: (req, id) => req.userId + ':' + id,
    murabbikSmartAlertTextSrv: value => String(value ?? '').trim(),
    murabbikSmartAlertDateMsSrv: value => Number(value)
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(src), sandbox);
  return {
    apply: sandbox.murabbikSmartAlertApplyUserStateSrv,
    stats: () => ({peak, reads, ids})
  };
}
function fixtures(n) {
  const alerts = Array.from({length:n}, (_,i) => ({
    id:'a'+i, revision:'rev1', source:'ovsynch_protocol_steps',
    code:'ovsynch_step_due', action:{type:'none'}
  }));
  const states = new Map();
  for(let i=0;i<n;i++) {
    let state = i%7===0 ? {decision:'acknowledged',revision:'rev1'} :
      i%11===0 ? {decision:'snoozed',revision:'rev1',snoozedUntil:999999} :
      i%13===0 ? {decision:'snoozed',revision:'old',snoozedUntil:999999} : null;
    if(state) states.set('farmA:a'+i,state);
  }
  return {alerts,states};
}
async function main() {
  for(const n of [0,1,100,101,300,301,800,1000]) {
    const {alerts,states} = fixtures(n);
    const reference = runner(before,states);
    const optimized = runner(after,states);
    const unchanged = runner(after,states);
    const [a,b,c] = await Promise.all([
      reference.apply({userId:'farmA'},alerts,100),
      optimized.apply({userId:'farmA'},alerts,100,{parallelStateReads:true}),
      unchanged.apply({userId:'farmA'},alerts,100)
    ]);
    assert.equal(JSON.stringify(a),JSON.stringify(b), 'GET semantic mismatch @'+n);
    assert.equal(JSON.stringify(a),JSON.stringify(c), 'other callers changed @'+n);
    assert.equal(optimized.stats().reads,Math.ceil(n/100));
    assert.deepEqual(optimized.stats().ids,reference.stats().ids);
    assert(optimized.stats().peak <= 3);
    assert(reference.stats().peak <= 1);
    assert(unchanged.stats().peak <= 1);
    console.log('PASS state equivalence and batching',n);
  }
  const failing = runner(after,new Map(),true);
  await assert.rejects(
    failing.apply({userId:'farmA'},[{id:'a0',revision:'r'}],100,{parallelStateReads:true}),
    /firestore-getAll-unavailable/
  );
  console.log('PASS Firestore failures are not silently swallowed');
  console.log('PASS exact full-server scope and syntax');
}
main().catch(e => {console.error(e.stack || e);process.exitCode=1});
