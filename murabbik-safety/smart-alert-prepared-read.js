'use strict';

// Candidate building block. NOT wired to server.js until mutation-path and
// clock/source certification is complete. A wrong or incomplete certificate
// MUST fall back to the original live collector.
const EXPECTED_SCHEMA = 'murabbik-smart-alerts-prepared-v1';
const MAX_PAYLOAD_BYTES = 490000;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
// Exact baseline registration list. If a new source is added, certification
// must fail until its invalidations and next-change deadline are covered.
const EXPECTED_SOURCES = Object.freeze([
  'milk_mirror', 'dry_off_due', 'close_up_due', 'calving_overdue',
  'pregnancy_diagnosis_due', 'pregnancy_confirmation_120_due',
  'uterine_check_followup', 'postpartum_insemination_followup',
  'vaccination_program_tasks', 'ovsynch_protocol_steps',
  'daily_farm_greeting'
]);

const clean = x => typeof x === 'string' && x.length > 0;
const int = n => Number.isSafeInteger(n) && n >= 0;
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function certified(control) {
  return control?.schema === EXPECTED_SCHEMA &&
    control?.allMutationPathsCertified === true &&
    control?.historicalBackfillCertified === true &&
    control?.allSourceSideEffectsRelocated === true &&
    control?.allDeadlineSourcesCertified === true &&
    int(control?.generation);
}

function allDeadlinesCover(sourceDeadlinesMs, builtAtMs, validUntilMs) {
  if (!sourceDeadlinesMs || typeof sourceDeadlinesMs !== 'object' ||
    Object.keys(sourceDeadlinesMs).length !== EXPECTED_SOURCES.length) return false;
  return EXPECTED_SOURCES.every(name => int(sourceDeadlinesMs[name]) &&
    sourceDeadlinesMs[name] > builtAtMs &&
    sourceDeadlinesMs[name] - builtAtMs <= MAX_HORIZON_MS &&
    validUntilMs <= sourceDeadlinesMs[name]);
}

function revision(control) {
  return int(control?.generation) ? control.generation : 0;
}

// To be invoked IN THE SAME Firestore transaction as a relevant source write.
// Calling it outside that transaction does not establish freshness and is forbidden.
async function invalidateWithSourceWrite(tx, controlRef) {
  const snap = await tx.get(controlRef);
  const current = snap.exists ? (snap.data() || {}) : {};
  const previous = revision(current);
  if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('generation_exhausted');
  tx.set(controlRef, {
    schema: EXPECTED_SCHEMA,
    generation: previous + 1,
    // Until completed, certification remains false. Existing false states
    // cannot become true through ordinary mutation writes.
    allMutationPathsCertified: current.allMutationPathsCertified === true,
    historicalBackfillCertified: current.historicalBackfillCertified === true,
    allSourceSideEffectsRelocated: current.allSourceSideEffectsRelocated === true,
    allDeadlineSourcesCertified: current.allDeadlineSourcesCertified === true
  }, {merge: true});
  return previous + 1;
}

async function beginBuild(db, controlRef) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(controlRef);
    const control = snap.exists ? (snap.data() || {}) : null;
    return certified(control) ? {schema: EXPECTED_SCHEMA, generation: control.generation} : null;
  });
}

async function publishIfUnchanged({db, controlRef, preparedRef, token, actorUid,
  farmDay, builtAtMs, validUntilMs, alerts, sourceDeadlinesMs, sourceErrors = []}) {
  if (!token || token.schema !== EXPECTED_SCHEMA || !int(token.generation)) return 'not_certified';
  if (!clean(actorUid) || !date(farmDay) || !int(builtAtMs) || !int(validUntilMs) ||
    validUntilMs <= builtAtMs || validUntilMs - builtAtMs > MAX_HORIZON_MS ||
    !Array.isArray(alerts) || !Array.isArray(sourceErrors) || sourceErrors.length !== 0) return 'unusable';
  // A bound per source is required. A missing/misnamed/unknown source
  // makes the projection unusable; do not silently assume infinity.
  if (!allDeadlinesCover(sourceDeadlinesMs, builtAtMs, validUntilMs)) return 'unusable';
  const data = {schema: EXPECTED_SCHEMA, generation: token.generation,
    actorUid, farmDay, builtAtMs, validUntilMs, sourceDeadlinesMs, alerts};
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_PAYLOAD_BYTES) return 'oversize';
  return db.runTransaction(async tx => {
    const controlSnap = await tx.get(controlRef);
    const control = controlSnap.exists ? (controlSnap.data() || {}) : null;
    if (!certified(control) || control.generation !== token.generation) return 'changed';
    tx.set(preparedRef, data); // no client user state stored in the read model
    return 'published';
  });
}

async function readIfFresh({db, controlRef, preparedRef, actorUid, farmDay, nowMs}) {
  if (!clean(actorUid) || !date(farmDay) || !int(nowMs)) return null;
  return db.runTransaction(async tx => {
    const [controlSnap, dataSnap] = await Promise.all([tx.get(controlRef), tx.get(preparedRef)]);
    const control = controlSnap.exists ? (controlSnap.data() || {}) : null;
    const data = dataSnap.exists ? (dataSnap.data() || {}) : null;
    if (!certified(control) || !data || data.schema !== EXPECTED_SCHEMA ||
      data.generation !== control.generation || data.actorUid !== actorUid ||
      data.farmDay !== farmDay || !int(data.builtAtMs) || !int(data.validUntilMs) ||
      data.builtAtMs > nowMs || data.validUntilMs <= nowMs ||
      data.validUntilMs - data.builtAtMs > MAX_HORIZON_MS ||
      !allDeadlinesCover(data.sourceDeadlinesMs, data.builtAtMs, data.validUntilMs) ||
      !Array.isArray(data.alerts)) return null;
    // Return only built alert candidates. Per-actor acknowledged/snoozed state
    // must be read and applied live afterwards, as in the existing endpoint.
    return {alerts: data.alerts, builtAtMs: data.builtAtMs, validUntilMs: data.validUntilMs};
  });
}
module.exports = {EXPECTED_SCHEMA, EXPECTED_SOURCES, certified, invalidateWithSourceWrite, beginBuild,
  publishIfUnchanged, readIfFresh};