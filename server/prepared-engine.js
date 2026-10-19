
'use strict';

const crypto = require('node:crypto');

const Q = 'murabbikPreparedQueue';
const V = 'murabbikPreparedViews';
const KINDS = Object.freeze(['alerts', 'stats:cows', 'stats:buffalo']);
const TTL_MS = 5 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const REFRESH_EARLY_MS = 15 * 1000;
const POLL_MS = 12 * 1000;
const MAX_PAYLOAD = 600 * 1024;

const hash = x =>
  crypto.createHash('sha256').update(String(x)).digest('hex');
const clean = x => String(x ?? '').trim();
const numberOr = (value, fallback) =>
  value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;

function targetGeneration(meta, kind) {
  return numberOr(meta?.generations?.[kind],
    numberOr(meta?.generation, 0));
}

function completedGeneration(meta, kind) {
  return numberOr(meta?.completedByKind?.[kind],
    numberOr(meta?.completedGeneration, 0));
}

function needBuild(meta, kind, now) {
  return targetGeneration(meta, kind) !== completedGeneration(meta, kind) ||
    numberOr(meta?.kindRefreshAtMs?.[kind], 0) <= now + REFRESH_EARLY_MS;
}

function asPayload(data) {
  if (data == null) throw new Error('Empty prepared payload');
  const value = JSON.stringify(data);
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_PAYLOAD) {
    throw new Error('Prepared payload oversized');
  }
  return JSON.parse(value);
}

async function mapLimited(items, limit, fn) {
  const results = Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)},
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }));
  return results;
}

function createPreparedEngine({
  db,
  profilesForTenant,
  calculateAlerts,
  calculateStats,
  seedTenants
}) {
  if (!db || !profilesForTenant || !calculateAlerts ||
      !calculateStats || !seedTenants) {
    throw new Error('Incomplete prepared-engine configuration');
  }

  const queue = db.collection(Q);
  const views = db.collection(V);
  const qref = tenant => queue.doc(hash(tenant));
  const vref = (tenant, uid, kind) =>
    views.doc(hash(JSON.stringify([tenant, uid, kind])));

  let running = false;
  let active = false;
  let rerun = false;
  let timer = null;
  let unsubscribe = null;
  const seenQueueGenerations = new Map();

  async function markDirty(tenant, kinds = KINDS) {
    tenant = clean(tenant);
    if (!tenant) return;
    const selected = [...new Set(kinds)].filter(k => KINDS.includes(k));
    if (!selected.length) return;
    const ref = qref(tenant);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() || {} : {};
      const generations = Object.fromEntries(
        KINDS.map(kind => [kind, targetGeneration(old, kind)])
      );
      for (const kind of selected) {
        generations[kind] = targetGeneration(old, kind) + 1;
      }
      const now = Date.now();
      const activeLeaseUntil = numberOr(old.leaseUntilMs, 0);
      tx.set(ref, {
        tenant,
        generation: numberOr(old.generation, 0) + 1,
        generations,
        // Leased work will observe the new generation and reschedule it.
        // Do not let a leased farm block the due-queue's first page.
        runAtMs: activeLeaseUntil > now ? activeLeaseUntil : now,
        changedAtMs: now
      }, {merge: true});
    });
  }

  async function seedIfMissing(tenant) {
    tenant = clean(tenant);
    if (!tenant) return;
    try {
      await qref(tenant).create({
        tenant,
        generation: 1,
        runAtMs: 0,
        changedAtMs: Date.now()
      });
    } catch (e) {
      if (![6, 'already-exists', 'ALREADY_EXISTS'].includes(e.code)) {
        throw e;
      }
    }
  }

  async function getReady(tenant, uid, kind) {
    tenant = clean(tenant);
    uid = clean(uid);
    if (!tenant || !uid || !KINDS.includes(kind)) return null;
    return db.runTransaction(async tx => {
      const q = await tx.get(qref(tenant));
      const v = await tx.get(vref(tenant, uid, kind));
      if (!q.exists || !v.exists) return null;
      const meta = q.data() || {};
      const entry = v.data() || {};
      const required = targetGeneration(meta, kind);
      // A view is safe as soon as this user's kind is published for the
      // current generation. Other users and kinds must not block it.
      if (entry.generation !== required ||
          entry.status !== 'ready' ||
          !Number.isFinite(entry.refreshAtMs) ||
          entry.refreshAtMs <= Date.now() ||
          !entry.payload) return null;
      return entry.payload;
    });
  }

  async function claim(ref) {
    const lease = crypto.randomUUID();
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const q = snap.data() || {};
      const now = Date.now();
      if (numberOr(q.runAtMs, 0) > now ||
          numberOr(q.leaseUntilMs, 0) > now) return null;
      const kinds = KINDS.filter(kind => needBuild(q, kind, now));
      if (!kinds.length) {
        // Legacy or concurrent queue scheduling: avoid a hot loop.
        tx.update(ref, {runAtMs: now + RETRY_MS});
        return null;
      }
      tx.update(ref, {
        lease,
        leaseUntilMs: now + LEASE_MS,
        // Prevent a currently claimed tenant from monopolizing the first
        // page of due work while its calculation is still running.
        runAtMs: now + LEASE_MS
      });
      return {
        tenant: q.tenant,
        lease,
        kinds,
        generations: Object.fromEntries(
          kinds.map(kind => [kind, targetGeneration(q, kind)]))
      };
    });
  }

  async function buildKind(job, profiles, kind) {
    const {tenant, lease} = job;
    const generation = job.generations[kind];

    // Calculate AND publish for each user separately. A slow profile must
    // not delay the ready view of another profile in the same lane.
    const outcomes = await mapLimited(profiles, 3, async ({uid, profile}) => {
      const args = {tenant, uid, profile};
      const now = Date.now();
      let record;
      try {
        if (kind === 'alerts') {
          const result = await calculateAlerts(args);
          if (!result || !Array.isArray(result.alerts) ||
              !result.today || result.degraded) {
            throw new Error('Alert output incomplete');
          }
          const deadline = Number(result.refreshAtMs);
          const until = Number.isFinite(deadline)
            ? Math.max(now + 1000, Math.min(now + TTL_MS, deadline))
            : now + TTL_MS;
          record = {
            uid, kind, refreshAtMs: until,
            payload: asPayload({today: result.today, alerts: result.alerts})
          };
        } else {
          const species = kind === 'stats:cows' ? 'cows' : 'buffalo';
          const result = await calculateStats({...args, species});
          if (!result || result.ok !== true) {
            throw new Error('Stats output invalid');
          }
          record = {
            uid, kind, refreshAtMs: now + TTL_MS,
            payload: asPayload(result)
          };
        }
      } catch (e) {
        console.warn('prepared kind unavailable', tenant, uid, kind, e.message);
        record = {uid, kind, refreshAtMs: now + RETRY_MS, payload: null};
      }

      try {
        // This transaction is the publication fence: an older calculation
        // is never allowed to overwrite a newer generation.
        await db.runTransaction(async tx => {
          const q = await tx.get(qref(tenant));
          if (!q.exists || q.data().lease !== lease ||
              targetGeneration(q.data(), kind) !== generation) {
            throw new Error('Prepared generation/lease superseded');
          }
          tx.set(vref(tenant, uid, kind), {
            tenant,
            uid,
            kind,
            generation,
            status: record.payload ? 'ready' : 'unavailable',
            refreshAtMs: record.payload ? record.refreshAtMs : 0,
            computedAtMs: Date.now(),
            payload: record.payload
          });
        });
        return {record, error: null};
      } catch (error) {
        console.warn('prepared publish failed', tenant, uid, kind,
          error?.message || error);
        return {record, error};
      }
    });

    // Never mark an incompletely published lane as finished.
    if (outcomes.some(result => result.error)) {
      throw new Error('Prepared lane publication incomplete: ' + kind);
    }

    const nextAt = outcomes.reduce((min, item) =>
      Math.min(min, item.record.refreshAtMs), Date.now() + TTL_MS);

    await db.runTransaction(async tx => {
      const ref = qref(tenant);
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().lease !== lease ||
          targetGeneration(snap.data(), kind) !== generation) {
        throw new Error('Prepared publish superseded');
      }
      const meta = snap.data() || {};
      tx.update(ref, {
        completedByKind: {
          ...(meta.completedByKind || {}), [kind]: generation
        },
        kindRefreshAtMs: {
          ...(meta.kindRefreshAtMs || {}), [kind]: nextAt
        }
      });
    });
  }

  async function build(job) {
    const profiles = await profilesForTenant(job.tenant);
    if (!Array.isArray(profiles)) throw new Error('Profiles must be array');
    const validProfiles = profiles.filter(p => clean(p?.uid));
    if (!validProfiles.length) {
      throw new Error('Prepared tenant has no user profiles');
    }

    // Alerts and both species are independent lanes: neither waits for the others.
    const results = await Promise.allSettled(job.kinds.map(kind =>
      buildKind(job, validProfiles, kind)));
    const failures = results.filter(item => item.status === 'rejected');

    await db.runTransaction(async tx => {
      const ref = qref(job.tenant);
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().lease !== job.lease) {
        throw new Error('Prepared job lease superseded');
      }
      const meta = snap.data() || {};
      const now = Date.now();
      const kindsNeedingWork = KINDS.filter(kind =>
        targetGeneration(meta, kind) !== completedGeneration(meta, kind));
      const nextDeadline = Math.min(...KINDS.map(kind =>
        numberOr(meta.kindRefreshAtMs?.[kind], now + RETRY_MS)));
      // Prioritize new writes, but back off on persistent build failures.
      // Otherwise a failed Firestore transaction can spin the worker forever.
      const changedWhileBuilding = job.kinds.some(kind =>
        targetGeneration(meta, kind) !== job.generations[kind]);
      const unclaimedDirtyKind = KINDS.some(kind =>
        !job.kinds.includes(kind) &&
        targetGeneration(meta, kind) !== completedGeneration(meta, kind));
      const hasNewGeneration = changedWhileBuilding || unclaimedDirtyKind;
      const nextRun = hasNewGeneration
        ? now
        : failures.length || kindsNeedingWork.length
          ? now + RETRY_MS
          : Math.max(now + 1000, nextDeadline - REFRESH_EARLY_MS);
      if (hasNewGeneration) rerun = true;
      tx.update(ref, {
        runAtMs: nextRun,
        leaseUntilMs: 0,
        lease: null,
        builtAtMs: now
      });
    });

    if (failures.length) {
      console.warn('prepared partial publish', job.tenant,
        failures.map(x => x.reason?.message || String(x.reason)));
    }
  }

  async function work() {
    if (!running) return;
    if (active) {
      rerun = true;
      return;
    }
    active = true;
    try {
      const due = await queue
        .where('runAtMs', '<=', Date.now())
        .orderBy('runAtMs')
        .limit(12)
        .get();
      // Multiple farms may be due; don't serialize every farm behind one.
      await mapLimited(due.docs, 3, async doc => {
        const job = await claim(doc.ref);
        if (!job?.tenant) return;
        try {
          const startedAtMs = Date.now();

          await build(job);

          console.log('[prepared-worker-time]', {
            tenant: job.tenant,
            kinds: job.kinds,
            durationMs: Date.now() - startedAtMs
          });
        } catch (e) {
          console.warn('prepared build retry', job.tenant, e.message);
          await db.runTransaction(async tx => {
            const q = await tx.get(doc.ref);
            if (!q.exists || q.data().lease !== job.lease) return;
            const changed = job.kinds.some(kind =>
              targetGeneration(q.data(), kind) !== job.generations[kind]);
            tx.update(doc.ref, {
              runAtMs: changed ? Date.now() : Date.now() + RETRY_MS,
              leaseUntilMs: 0,
              lease: null
            });
          });
        }
      });
    } catch (e) {
      console.error('prepared queue polling error', e);
    } finally {
      active = false;
      if (rerun && running) {
        rerun = false;
        setImmediate(() => void work());
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    // Watch mutations, not lease/refresh writes: no self-triggered poll storm.
    // The due-time poll below remains the safety net for TTL and missed events.
    try {
      unsubscribe = queue.orderBy('changedAtMs', 'desc').limit(24)
        .onSnapshot(snapshot => {
          let changed = false;
          for (const doc of snapshot.docs) {
            const row = doc.data() || {};
            const version = String(row.generation) + ':' +
              String(row.changedAtMs);
            if (seenQueueGenerations.get(doc.id) !== version) {
              seenQueueGenerations.set(doc.id, version);
              changed = true;
            }
          }
          if (changed) void work();
        }, error => {
          console.warn('prepared queue listener failed', error);
        });
    } catch (e) {
      console.warn('prepared queue listener unavailable', e);
    }
    void (async () => {
      try {
        await seedTenants(seedIfMissing);
      } catch (e) {
        console.error('prepared tenant seed failed', e);
      }
      await work();
    })();
    timer = setInterval(() => { void work(); }, POLL_MS);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  return {markDirty, getReady, start, stop};
}

module.exports = {createPreparedEngine};
