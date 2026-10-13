'use strict';

// Staging-only publisher. Intentionally not connected to production server.js.
// A certified source mutation barrier, historical backfill, side-effect removal
// and independently checked next-change deadlines are prerequisites.
const readModel = require('./smart-alert-prepared-read');

function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
function validDay(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }

/**
 * Prepare an immutable candidate from one complete live collection, and publish
 * only if no relevant mutation committed before the publication transaction.
 * The caller MUST NOT estimate deadlines from visible/filtered alert dates:
 * each source's next possible change must be certified independently.
 *
 * Calls no Firestore writes unless the control record was ALREADY fully
 * certified and the collector succeeded with all source deadlines supplied.
 */
async function prepareIfCertified({db, controlRef, preparedRef, actorUid,
  farmDay, collectLive, resolveDeadlines, currentFarmDay,
  clock = Date.now, model = readModel}) {
  if (!db || !controlRef || !preparedRef || typeof actorUid !== 'string' || !actorUid ||
    !validDay(farmDay) || typeof collectLive !== 'function' ||
    typeof resolveDeadlines !== 'function' || typeof currentFarmDay !== 'function' ||
    typeof clock !== 'function') return {status:'not_ready'};

  const token = await model.beginBuild(db, controlRef);
  if (!token) return {status:'not_certified'};

  // collectLive MUST be the existing all-sources collector (not a subset).
  const result = await collectLive();
  if (!result || !Array.isArray(result.alerts) ||
    !Array.isArray(result.sourceErrors) || result.sourceErrors.length ||
    result.context?.today !== farmDay) return {status:'incomplete'};

  const builtAtMs = clock();
  if (!timestamp(builtAtMs) || await currentFarmDay() !== farmDay) {
    return {status:'farm_day_changed'};
  }

  // No implicit 24h deadline: all eleven sources must explicitly report their
  // earliest potential change (including weather, campaign, snooze-independent
  // external inputs, and farm-local midnight).
  const deadlines = await resolveDeadlines(result);
  if (!deadlines || typeof deadlines !== 'object' ||
    Object.keys(deadlines).length !== model.EXPECTED_SOURCES.length ||
    !model.EXPECTED_SOURCES.every(name => timestamp(deadlines[name]) &&
      deadlines[name] > builtAtMs)) return {status:'deadlines_not_certified'};

  const validUntilMs = Math.min(...model.EXPECTED_SOURCES.map(name => deadlines[name]));
  if (validUntilMs <= builtAtMs || await currentFarmDay() !== farmDay) {
    return {status:'farm_day_changed'};
  }

  const status = await model.publishIfUnchanged({db, controlRef, preparedRef,
    token, actorUid, farmDay, builtAtMs, validUntilMs,
    alerts: result.alerts, sourceDeadlinesMs: deadlines,
    sourceErrors: result.sourceErrors});
  return {status};
}

module.exports = {prepareIfCertified};