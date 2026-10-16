'use strict';

const crypto = require('node:crypto');

const Q = 'murabbikPreparedQueue';
const V = 'murabbikPreparedViews';

const TTL_MS = 5 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const MAX_PAYLOAD = 600 * 1024;

const hash = x =>
  crypto.createHash('sha256')
    .update(String(x))
    .digest('hex');

const clean = x => String(x ?? '').trim();

function createPreparedEngine({
  db,
  profilesForTenant,
  calculateAlerts,
  calculateStats,
  seedTenants
}) {
  if (
    !db ||
    !profilesForTenant ||
    !calculateAlerts ||
    !calculateStats ||
    !seedTenants
  ) {
    throw new Error('Incomplete prepared-engine configuration');
  }

  const queue = db.collection(Q);
  const views = db.collection(V);

  const qref = tenant =>
    queue.doc(hash(tenant));

  const vref = (tenant, uid, kind) =>
    views.doc(hash(JSON.stringify([tenant, uid, kind])));

  let running = false;
  let active = false;
  let timer = null;

  async function markDirty(tenant) {
    tenant = clean(tenant);
    if (!tenant) return;

    const ref = qref(tenant);

    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() : {};

      tx.set(ref, {
        tenant,
        generation: (Number(old.generation) || 0) + 1,
        runAtMs: Date.now(),
        changedAtMs: Date.now()
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
      if (
        ![6, 'already-exists', 'ALREADY_EXISTS'].includes(e.code)
      ) {
        throw e;
      }
    }
  }

  async function getReady(tenant, uid, kind) {
    tenant = clean(tenant);
    uid = clean(uid);

    if (
      !tenant ||
      !uid ||
      !['alerts', 'stats:cows', 'stats:buffalo'].includes(kind)
    ) {
      return null;
    }

    return db.runTransaction(async tx => {
      const q = await tx.get(qref(tenant));
      const v = await tx.get(vref(tenant, uid, kind));

      if (!q.exists || !v.exists) return null;

      const meta = q.data() || {};
      const entry = v.data() || {};

      if (
        meta.completedGeneration !== meta.generation ||
        entry.generation !== meta.generation ||
        entry.status !== 'ready' ||
        !Number.isFinite(entry.refreshAtMs) ||
        entry.refreshAtMs <= Date.now() ||
        !entry.payload
      ) {
        return null;
      }

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

      if (
        (Number(q.runAtMs) || 0) > now ||
        (Number(q.leaseUntilMs) || 0) > now
      ) {
        return null;
      }

      tx.update(ref, {
        lease,
        leaseUntilMs: now + LEASE_MS
      });

      return {
        tenant: q.tenant,
        generation: q.generation,
        lease
      };
    });
  }

  function asPayload(data) {
    if (data == null) {
      throw new Error('Empty prepared payload');
    }

    const s = JSON.stringify(data);

    if (
      !s ||
      Buffer.byteLength(s, 'utf8') > MAX_PAYLOAD
    ) {
      throw new Error('Prepared payload oversized');
    }

    return JSON.parse(s);
  }

  async function build(job) {
    const {tenant, generation, lease} = job;

    const profiles = await profilesForTenant(tenant);

    if (!Array.isArray(profiles)) {
      throw new Error('Profiles must be array');
    }

    const records = [];
    const now = Date.now();
    let nextAt = now + TTL_MS;

    for (const {uid, profile} of profiles) {
      if (!clean(uid)) continue;

      const args = {
        tenant,
        uid,
        profile
      };

      try {
        const result = await calculateAlerts(args);

        if (
          !result ||
          !Array.isArray(result.alerts) ||
          !result.today ||
          result.degraded
        ) {
          throw new Error('Alert output incomplete');
        }

        const deadline = Number(result.refreshAtMs);

        const until = Number.isFinite(deadline)
          ? Math.max(
              now + 1000,
              Math.min(now + TTL_MS, deadline)
            )
          : now + TTL_MS;

        records.push({
          uid,
          kind: 'alerts',
          refreshAtMs: until,
          payload: asPayload({
            today: result.today,
            alerts: result.alerts
          })
        });

        nextAt = Math.min(nextAt, until);

      } catch (e) {
        console.warn(
          'prepared alerts unavailable',
          tenant,
          uid,
          e.message
        );

        records.push({
          uid,
          kind: 'alerts',
          payload: null
        });
      }

      for (const species of ['cows', 'buffalo']) {
        try {
          const result = await calculateStats({
            ...args,
            species
          });

          if (!result || result.ok !== true) {
            throw new Error('Stats output invalid');
          }

          records.push({
            uid,
            kind: 'stats:' + species,
            refreshAtMs: now + TTL_MS,
            payload: asPayload(result)
          });

        } catch (e) {
          console.warn(
            'prepared stats unavailable',
            tenant,
            uid,
            species,
            e.message
          );

          records.push({
            uid,
            kind: 'stats:' + species,
            payload: null
          });
        }
      }
    }

    // Publish each result with its generation.
    // Readers refuse all results until final commit.
    for (const record of records) {
      await db.runTransaction(async tx => {
        const q = await tx.get(qref(tenant));

        if (
          !q.exists ||
          q.data().generation !== generation ||
          q.data().lease !== lease
        ) {
          throw new Error('Prepared generation/lease superseded');
        }

        tx.set(vref(tenant, record.uid, record.kind), {
          tenant,
          uid: record.uid,
          kind: record.kind,
          generation,
          status: record.payload ? 'ready' : 'unavailable',
          refreshAtMs: record.payload
            ? record.refreshAtMs
            : 0,
          computedAtMs: Date.now(),
          payload: record.payload
        });
      });
    }

    await db.runTransaction(async tx => {
      const ref = qref(tenant);
      const q = await tx.get(ref);

      if (
        !q.exists ||
        q.data().generation !== generation ||
        q.data().lease !== lease
      ) {
        throw new Error('Prepared publish superseded');
      }

      tx.update(ref, {
        completedGeneration: generation,
        runAtMs: Math.max(Date.now() + 1000, nextAt),
        leaseUntilMs: 0,
        lease: null,
        builtAtMs: Date.now()
      });
    });
  }

  async function work() {
    if (!running || active) return;

    active = true;

    try {
      const due = await queue
        .where('runAtMs', '<=', Date.now())
        .orderBy('runAtMs')
        .limit(12)
        .get();

      for (const doc of due.docs) {
        const job = await claim(doc.ref);

        if (!job?.tenant) continue;

        try {
          await build(job);

        } catch (e) {
          console.warn(
            'prepared build retry',
            job.tenant,
            e.message
          );

          await db.runTransaction(async tx => {
            const q = await tx.get(doc.ref);

            if (
              !q.exists ||
              q.data().lease !== job.lease
            ) {
              return;
            }

            tx.update(doc.ref, {
              runAtMs:
                q.data().generation !== job.generation
                  ? Date.now()
                  : Date.now() + 30000,
              leaseUntilMs: 0,
              lease: null
            });
          });
        }
      }

    } catch (e) {
      console.error('prepared queue polling error', e);

    } finally {
      active = false;
    }
  }

  function start() {
    if (running) return;

    running = true;

    void (async () => {
      try {
        await seedTenants(seedIfMissing);
      } catch (e) {
        console.error('prepared tenant seed failed', e);
      }

      await work();
    })();

    timer = setInterval(() => {
      void work();
    }, 12000);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
  }

  return {
    markDirty,
    getReady,
    start,
    stop
  };
}

module.exports = {createPreparedEngine};