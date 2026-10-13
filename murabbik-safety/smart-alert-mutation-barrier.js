'use strict';

// Partial, staged migration. NEVER enables the prepared read or certifies
// mutation coverage. Use only alongside the original source write in ONE
// Firestore WriteBatch, so both either commit or fail together.
const SCHEMA = 'murabbik-smart-alerts-prepared-v1';

function appendToBatchIfEnabled({batch, db, tenant, FieldValue, env = process.env}) {
  if (env?.MURABBIK_PREPARED_MUTATION_TRACKING !== '1') {
    return false;
  }
  if (!batch || typeof batch.set !== 'function' || !db ||
      typeof db.collection !== 'function' || !FieldValue ||
      typeof FieldValue.increment !== 'function' ||
      typeof tenant !== 'string' || !tenant.trim() || tenant.includes('/')) {
    // An enabled-but-invalid barrier MUST make the farm operation fail
    // before commit, never quietly succeed without its invalidation.
    throw new Error('smart_alert_mutation_barrier_unavailable');
  }
  const controlRef = db.collection('smart_alert_prepared_meta').doc(tenant);
  // Firestore transforms serialize concurrent increments atomically without
  // a read/modify/write race, even from different Render instances.
  // On first use certification flags remain absent (=> NOT certified).
  batch.set(controlRef, {
    schema: SCHEMA,
    generation: FieldValue.increment(1)
  }, {merge: true});
  return true;
}

function appendToTransactionIfEnabled({tx, ...rest}) {
  return appendToBatchIfEnabled({...rest, batch: tx});
}

module.exports = {appendToBatchIfEnabled, appendToTransactionIfEnabled};