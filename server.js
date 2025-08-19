// server.js — نسخة نظيفة ومحكمة
// ----------------------------------------------
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ====== بيانات محلية (fallback) ======
const dataDir     = path.join(__dirname, 'data');
const usersPath   = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const eventsPath  = path.join(dataDir, 'events.json');
const alertsPath  = path.join(dataDir, 'alerts.json'); // توافق قديم
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const readJson = (p, fallback=[]) => {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8') || '[]') : fallback; }
  catch { return fallback; }
};

// ====== ميدلوير عام ======
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== Firebase Admin ======
let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault()
    });
  }
  db = admin.firestore();
  console.log('✅ Firebase Admin ready');
} catch (e) {
  console.log('⚠️ Firestore disabled:', e.message);
}

// ====== Helpers ======
const dayMs = 86400000;
const toYYYYMMDD = (d) => new Date(d).toISOString().slice(0,10);
const toDate = (v) => {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
};

const tenantKey = (v) => (v==null || v==='') ? 'DEFAULT' : String(v);
function resolveTenant(req){
  return tenantKey(
    req.headers['x-user-id'] || req.query.userId ||
    req.headers['x-farm-id'] || req.query.farmId ||
    process.env.DEFAULT_TENANT_ID || process.env.DEFAULT_FARM_ID || 'DEFAULT'
  );
}
function belongs(rec, tenant){
  const t = rec?.userId ?? rec?.farmId ?? 'DEFAULT';
  return tenantKey(t) === tenantKey(tenant);
}
function requireUserId(req, res, next){
  const t = resolveTenant(req);
  if (!t || t === 'DEFAULT') return res.status(400).json({ ok:false, error:'userId_required' });
  req.userId = t;
  next();
}

// ====== Admin Gate ======
const ADMIN_EMAILS   = (process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const ADMIN_DEV_OPEN = process.env.ADMIN_DEV_OPEN === '1';

async function ensureAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer (.+)$/);
    const idToken = m ? m[1] : (req.query.token || '');
    if (idToken && db) {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const okClaim = decoded.admin === true;
      const okEmail = decoded.email && ADMIN_EMAILS.includes(decoded.email.toLowerCase());
      if (okClaim || okEmail) return next();
    }
    if (ADMIN_DEV_OPEN && req.query.dev === '1') return next();
    return res.status(404).send('Not Found');
  } catch {
    return res.status(404).send('Not Found');
  }
}

// ============================================================
//                       API: EVENTS
// ============================================================
app.post('/api/events', requireUserId, async (req, res) => {
  try {
    const event = req.body || {};
    const tenant = req.userId;
    event.userId = tenant;
    event.farmId = event.farmId || tenant;

    if (!event.type || !event.animalId) {
      return res.status(400).json({ ok:false, error:'missing_fields' });
    }

    // محلي
    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    // Mirror إلى Firestore
    if (db) {
      const t = String(event.type||'').toLowerCase();
      const typeNorm =
        t.includes('insemin') || t.includes('تلقيح') ? 'insemination' :
        t.includes('preg')    || t.includes('حمل')    ? 'pregnancy'   :
        t.includes('calv')    || t.includes('ولادة')  ? 'birth'       :
        t.includes('heat')    || t.includes('شياع')   ? 'heat'        : 'event';

      const whenMs  = Number(event.ts || Date.now());
      const whenISO = toYYYYMMDD(whenMs);

      const doc = {
        userId: tenant,
        farmId: tenant,
        animalId: String(event.animalId || ''),
        type: typeNorm,
        date: whenISO,
        createdAt: admin.firestore.Timestamp.fromMillis(whenMs),
        species: (event.species || 'buffalo').toLowerCase(),
        result: event.result || event.status || '',
        note: event.note || ''
      };
      try { await db.collection('events').add(doc); } catch {}
    }

    return res.json({ ok:true, event });
  } catch (e) {
    console.error('events', e);
    res.status(500).json({ ok:false, error:'failed_to_save_event' });
  }
});

// ============================================================
//                       API: ALERTS
// ============================================================
app.get('/api/alerts', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });
    const tenant   = resolveTenant(req);
    const animalId = req.query.animalId || null;
    const sinceMs  = Number(req.query.since || 0);
    const days     = Number(req.query.days || 0);
    const limit    = Math.min(Number(req.query.limit || 100), 2000);

    let q = db.collection('alerts').where('farmId','==', tenant);
    if (animalId) q = q.where('subject.animalId', '==', animalId);

    let since = sinceMs;
    if (!since && days > 0) since = Date.now() - days * dayMs;
    if (since) q = q.where('ts', '>=', since);

    q = q.orderBy('ts', 'desc').limit(limit);
    const snap = await q.get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok:true, count: arr.length, alerts: arr });
  } catch (e) {
    console.error('alerts', e);
    res.status(500).json({ ok:false, error:'alerts_failed' });
  }
});

// ============================================================
//                       API: ANIMAL TIMELINE
// ============================================================
app.get('/api/animal-timeline', async (req, res) => {
  try {
    const animalId = String(req.query.animalId || '').trim();
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    if (!animalId) return res.status(400).json({ ok:false, error:'animalId required' });

    const items = [];

    // محلي
    const events = readJson(eventsPath, []);
    events.filter(e => String(e.animalId) === animalId)
      .forEach(e => items.push({
        kind:'event',
        ts: e.ts || toDate(e.date)?.getTime() || Date.now(),
        title: e.type || e.title || 'حدث',
        summary: e.note || e.notes || ''
      }));

    // Firestore
    if (db) {
      const alSnap = await db.collection('alerts')
        .where('subject.animalId', '==', animalId)
        .orderBy('ts','desc').limit(limit).get().catch(()=>({docs:[]}));
      for (const d of (alSnap.docs||[])) {
        items.push({ kind:'alert', ts: d.get('ts'), code: d.get('code'), summary: d.get('message') });
      }
      const devSnap = await db.collection('devices')
        .where('subject.animalId','==', animalId)
        .limit(50).get().catch(()=>({docs:[]}));
      for (const d of (devSnap.docs||[])) {
        const m = d.get('metrics') || {};
        const summary = Object.entries(m).slice(0,3).map(([k,v]) => `${k}: ${v.value}${v.unit||''}`).join(' • ');
        items.push({ kind:'reading', ts: d.get('lastSeen') || 0, name: d.id, summary });
      }
    }

    items.sort((a,b)=>b.ts-a.ts);
    const out = items.slice(0, limit);
    res.json({ ok:true, items: out });
  } catch (e) {
    console.error('timeline', e);
    res.status(500).json({ ok:false, error:'timeline_failed' });
  }
});

// ============================================================
//                       API: HERD STATS (مختصرة)
// ============================================================
app.get('/api/herd-stats', async (req, res) => {
  try {
    const tenant  = resolveTenant(req);
    const species = (req.query.species || '').toLowerCase(); // 'cow' | 'buffalo'
    const analysisDays  = parseInt(req.query.analysisDays || '90', 10);

    // Firestore أولًا
    if (db) {
      const adb = admin.firestore();

      // الحيوانات
      let animalsDocs = [];
      try { animalsDocs = (await adb.collection('animals').where('userId','==',tenant).get()).docs.slice(); } catch {}
      try {
        const d2 = await adb.collection('animals').where('farmId','==',tenant).get();
        const seen = new Set(animalsDocs.map(d=>d.id));
        for (const d of d2.docs) if (!seen.has(d.id)) animalsDocs.push(d);
      } catch {}

      const animals = animalsDocs.map(d => ({ id:d.id, ...(d.data()||{}) }));
      const active = animals.filter(a => a.active !== false && !['sold','dead','archived','inactive'].includes(String(a.status||'').toLowerCase()));
      const totalActive = active.length;

      // أحداث حديثة
      const since = new Date(Date.now() - (analysisDays + 310 + 60) * dayMs);
      const sinceStr = toYYYYMMDD(since);

      async function fetchType(type) {
        const out = [];
        async function tryQ(field) {
          try {
            const s = await adb.collection('events').where(field,'==',tenant).where('type','==',type).where('date','>=',sinceStr).get();
            out.push(...s.docs);
          } catch {
            const s = await adb.collection('events').where(field,'==',tenant).where('type','==',type).orderBy('date','desc').limit(2000).get().catch(()=>({docs:[]}));
            (s.docs||[]).forEach(d=>{ if ((d.get('date')||'') >= sinceStr) out.push(d); });
          }
        }
        await tryQ('userId'); await tryQ('farmId');
        const map = new Map(); out.forEach(d=>map.set(d.id,d));
        return [...map.values()].map(d=>({ id:d.id, ...(d.data()||{}) }));
      }

      const [ins, preg, births] = await Promise.all([
        fetchType('insemination'),
        fetchType('pregnancy'),
        fetchType('birth')
      ]);

      const activeIds = new Set(active.map(a=>String(a.id)));
      const insWin  = ins .filter(e => activeIds.has(String(e.animalId)) && toDate(e.date||e.createdAt) >= new Date(Date.now()-analysisDays*dayMs));
      const pregPos = preg.filter(e => activeIds.has(String(e.animalId)) && /preg|positive|حمل|ايجاب/i.test(String(e.result||e.status||e.outcome||'')));

      const pregSet = new Set(pregPos.map(e=>String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregSet.size);
      const conceptionRate = insWin.length ? +( (pregPos.filter(e=>toDate(e.date||e.createdAt) >= new Date(Date.now()-analysisDays*dayMs)).length / insWin.length) * 100 ).toFixed(1) : 0;

      res.json({
        ok:true,
        totals:{
          totalActive,
          pregnant:   { count: pregSet.size, pct: totalActive? +((pregSet.size/totalActive)*100).toFixed(1):0 },
          inseminated:{ count: new Set(insWin.map(e=>String(e.animalId))).size, pct: totalActive? +((new Set(insWin.map(e=>String(e.animalId))).size/totalActive)*100).toFixed(1):0 },
          open:       { count: openCount, pct: totalActive? +((openCount/totalActive)*100).toFixed(1):0 }
        },
        fertility:{
          conceptionRatePct: conceptionRate
        }
      });
      return;
    }

    // محلي fallback
    const animalsAll = readJson(animalsPath, []).filter(a=>belongs(a,tenant));
    const active = animalsAll.filter(a => a.active !== false && !['sold','dead','archived','inactive'].includes(String(a.status||'').toLowerCase()));
    const totalActive = active.length;
    const evAll = readJson(eventsPath, []).filter(e=>belongs(e,tenant));
    const insWin  = evAll.filter(e => /insemination|تلقيح/i.test(e.type||'') && toDate(e.ts||e.date) >= new Date(Date.now()-analysisDays*dayMs));
    const pregPos = evAll.filter(e => /pregnancy|حمل/i.test(e.type||'') && /positive|ايجاب/i.test(String(e.result||e.status||e.outcome||'')));

    const pregSet = new Set(pregPos.map(e=>String(e.animalId)));
    const openCount = Math.max(0, totalActive - pregSet.size);
    const conceptionRate = insWin.length ? +((pregPos.filter(e=>toDate(e.ts||e.date) >= new Date(Date.now()-analysisDays*dayMs)).length / insWin.length) * 100).toFixed(1) : 0;

    res.json({
      ok:true,
      totals:{
        totalActive,
        pregnant:   { count: pregSet.size, pct: totalActive? +((pregSet.size/totalActive)*100).toFixed(1):0 },
        inseminated:{ count: new Set(insWin.map(e=>String(e.animalId))).size, pct: totalActive? +((new Set(insWin.map(e=>String(e.animalId))).size/totalActive)*100).toFixed(1):0 },
        open:       { count: openCount, pct: totalActive? +((openCount/totalActive)*100).toFixed(1):0 }
      },
      fertility:{ conceptionRatePct: conceptionRate }
    });
  } catch (e) {
    console.error('herd-stats', e);
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ============================================================
//                       API: ANIMALS (Robust)
// ============================================================
app.get('/api/animals', requireUserId, async (req, res) => {
  try {
    const tenant = tenantKey(req.userId);
    const items = new Map();
    const pushDoc = (d) => { if(!d) return; const a=d.data? (d.data()||{}):d; const key=d.ref? d.ref.path : (a.id||Math.random()); items.set(key, { id:d.id||a.id||null, ...a }); };

    if (db) {
      const adb = admin.firestore();
      const ownerFields = ['userId','farmId'];

      // users/{tenant}/animals
      try { (await adb.collection('users').doc(tenant).collection('animals').limit(500).get()).docs.forEach(pushDoc); } catch {}

      // root (userId/farmId)
      for (const f of ownerFields) {
        try { (await adb.collection('animals').where(f,'==',tenant).limit(500).get()).docs.forEach(pushDoc); } catch {}
      }

      // collectionGroup (userId/farmId)
      if (items.size === 0) {
        for (const f of ownerFields) {
          try { (await adb.collectionGroup('animals').where(f,'==',tenant).limit(500).get()).docs.forEach(pushDoc); } catch {}
        }
      }

      // Fallback من الأحداث: animalId → number/docId
      if (items.size === 0) {
        const ev = [];
        async function pull(field){
          try { ev.push(...(await adb.collection('events').where(field,'==',tenant).orderBy('date','desc').limit(2000).get()).docs); }
          catch { ev.push(...((await adb.collection('events').where(field,'==',tenant).orderBy('createdAt','desc').limit(2000).get().catch(()=>({docs:[]}))).docs||[])); }
        }
        await pull('userId'); await pull('farmId');
        const keys = new Set(ev.map(d=>String(d.get('animalId')||'').trim()).filter(Boolean));
        for (const k of keys) {
          const cand=[k]; const n=Number(k); if(!Number.isNaN(n)) cand.push(n);
          for (const v of cand) {
            try { (await adb.collection('animals').where('number','==',v).limit(5).get()).docs.forEach(pushDoc); } catch {}
            try { (await adb.collectionGroup('animals').where('number','==',v).limit(5).get()).docs.forEach(pushDoc); } catch {}
          }
          try { const d = await adb.collection('animals').doc(String(k)).get(); if (d.exists) pushDoc(d); } catch {}
        }
      }
    } else {
      readJson(animalsPath, []).filter(a=>belongs(a,tenant)).forEach(pushDoc);
    }

    const out = [...items.values()].map(a => ({
      id: a.id || null,
      number: a.number ?? null,
      species: a.species ?? null,
      category: a.category ?? null,
      status: a.status ?? null,
      lactationStatus: a.lactationStatus ?? null,
      lastCalvingDate: a.lastCalvingDate ?? null
    }));

    res.json(out);
  } catch (e) {
    console.error('animals', e);
    res.status(500).json({ ok:false, error:'animals_route_failed', message:e?.message });
  }
});

// ============================================================
//                 ADMIN: نقل ملكية أرقام محددة (آمن)
// ============================================================
app.post('/api/admin/animals/transfer-owner', ensureAdmin, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });
    const from = String(req.query.from || '').trim();
    const to   = String(req.query.to   || '').trim();
    const numsParam = String(req.query.nums || '').trim();
    const apply = String(req.query.apply || '') === '1';
    const uidOk = s => /^[A-Za-z0-9_-]{16,64}$/.test(s);
    if (!from || !to || !numsParam) return res.status(400).json({ ok:false, error:'from,to,nums required' });
    if (!uidOk(from) || !uidOk(to))  return res.status(400).json({ ok:false, error:'invalid uid' });
    const wanted = numsParam.split(',').map(s=>s.trim()).filter(Boolean).slice(0,50);
    const adb = admin.firestore();

    function uniqPush(set,d){ if(d&&d.exists) set.set(d.ref.path,d); }
    async function findByNumber(val){
      const set=new Map(); const cand=[val]; const n=Number(val); if(!Number.isNaN(n)) cand.push(n);
      for (const v of cand) {
        try { (await adb.collection('animals').where('number','==',v).limit(50).get()).docs.forEach(d=>uniqPush(set,d)); } catch {}
        try { (await adb.collectionGroup('animals').where('number','==',v).limit(50).get()).docs.forEach(d=>uniqPush(set,d)); } catch {}
      }
      try { const d=await adb.collection('animals').doc(String(val)).get(); uniqPush(set,d); } catch {}
      return [...set.values()];
    }

    const plan=[];
    for (const num of wanted) {
      const docs = await findByNumber(num);
      for (const d of docs) {
        const a=d.data()||{};
        const owner=a.userId||a.farmId||a.createdBy||a.ownerId||a.uid||null;
        const willUpdate = String(owner||'').trim() === from;
        plan.push({ path:d.ref.path, id:d.id, number:a.number??null, owner_before: owner??null, willUpdate });
      }
    }

    let updated=0;
    if (apply) {
      let batch = adb.batch(); let ops=0;
      for (const p of plan) {
        if (!p.willUpdate) continue;
        const ref = adb.doc(p.path);
        batch.set(ref, { userId: to, farmId: to }, { merge:true });
        updated++; ops++;
        if (ops>=450) { await batch.commit(); batch=adb.batch(); ops=0; }
      }
      if (ops>0) await batch.commit();
    }

    try { await db.collection('admin_audits').add({ kind:'animals.transfer-owner', ts:Date.now(), apply, from, to, nums:wanted, matched: plan.filter(p=>p.willUpdate).length, updated }); } catch {}

    res.json({ ok:true, dryRun: !apply, from, to, nums:wanted, found: plan.length, matched: plan.filter(p=>p.willUpdate).length, updated, plan });
  } catch (e) {
    console.error('transfer-owner', e);
    res.status(500).json({ ok:false, error: e?.message || 'transfer_failed' });
  }
});

// ============================================================
//                 DEBUG (يعمل فقط في DEV)
// ============================================================
if (ADMIN_DEV_OPEN) {
  app.get('/api/debug/echo-tenant', (req,res) => {
    res.json({ header_x_user_id: req.headers['x-user-id']||null, query_userId:req.query.userId||null, resolvedTenant: resolveTenant(req) });
  });

  app.get('/api/debug/cloud-animals-sample', async (_req, res) => {
    try {
      if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });
      const snap = await admin.firestore().collectionGroup('animals').limit(10).get();
      const items = snap.docs.map(d => {
        const a = d.data() || {};
        return { path:d.ref.path, id:d.id, userId:a.userId||null, farmId:a.farmId||null, number:a.number||null };
      });
      res.json({ ok:true, items });
    } catch (e) {
      res.status(500).json({ ok:false, error:e?.message||'cloud_sample_failed' });
    }
  });
}

// ============================================================
//                 COMPAT + WEB PAGES
// ============================================================
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const oldAlerts = readJson(alertsPath, []);
  const userAlerts = oldAlerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

app.get('/timeline.html', ensureAdmin, (_req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'www', 'timeline.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// ===== Static must be last
app.use(express.static(path.join(__dirname, 'www')));

// ===== Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
