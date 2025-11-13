// server.js — stable build, tenant-aware
// ----------------------------------------------
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ===== Local storage (fallback) =====
const dataDir     = path.join(__dirname, 'data');
const usersPath   = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const eventsPath  = path.join(dataDir, 'events.json');
const alertsPath  = path.join(dataDir, 'alerts.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function readJson(p, fallback = []) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8') || '[]') : fallback; }
  catch { return fallback; }
}

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));



// ===== Firebase Admin (best-effort) =====
// ===== Firebase Admin (best-effort) =====
let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa
        ? admin.credential.cert(sa)
        : admin.credential.applicationDefault(),
      projectId: "murabbik", // 🔹 ضروري لتحديد المشروع الصحيح
    });
  }
  console.log("🔥 Admin SDK Auth Identity:", admin.app().options?.credential?.cert);


  db = admin.firestore(admin.app(), "murabbikdata");
  console.log("✅ Firebase Admin ready → murabbikdata");
} catch (e) {
  console.log("⚠️ Firestore disabled:", e.message);
}


// ===== Helpers =====
const dayMs = 86400000;
function toYYYYMMDD(d){ return new Date(d).toISOString().slice(0,10); }
function toDate(v){
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
}

const tenantKey = v => (!v ? 'DEFAULT' : String(v));
function resolveTenant(req) {
  const uid =
    req.get("X-User-Id") ||  // الشكل القياسي للهيدر
    req.headers["x-user-id"] || // fallback إذا Express حوّلها
    req.query.userId ||
    process.env.DEFAULT_TENANT_ID ||
    "DEFAULT";
  return tenantKey(uid);
}


function belongs(rec, tenant){
  const t = rec && (rec.userId || rec.farmId) || 'DEFAULT';
  return tenantKey(t) === tenantKey(tenant);
}
function requireUserId(req, res, next){
  const t = resolveTenant(req);
  if (!t || t === 'DEFAULT') return res.status(400).json({ ok:false, error:'userId_required' });
  req.userId = t;
  next();
}

// ===== Admin gate (optional) =====
const ADMIN_EMAILS   = (process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const ADMIN_DEV_OPEN = process.env.ADMIN_DEV_OPEN === '1';
async function ensureAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer (.+)$/);
    const idToken = m ? m[1] : (req.query.token || '');
    if (idToken && admin.apps.length) {
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

    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    if (db) {
      const t = String(event.type||'').toLowerCase();
      const typeNorm =
        t.includes('insemin') || t.includes('تلقيح') ? 'insemination' :
        t.includes('preg')    || t.includes('حمل')    ? 'pregnancy'   :
        t.includes('calv')    || t.includes('ولادة')  ? 'birth'       :
        t.includes('heat')    || t.includes('شياع')   ? 'heat'        : 'event';

      const whenMs  = Number(event.ts || Date.now());
      const doc = {
        userId: tenant,
        farmId: tenant,
        animalId: String(event.animalId || ''),
        type: typeNorm,
        date: toYYYYMMDD(whenMs),
        createdAt: admin.firestore.Timestamp.fromMillis(whenMs),
        species: (event.species || 'buffalo').toLowerCase(),
        result: event.result || event.status || '',
        note: event.note || ''
      };
      try { await db.collection('events').add(doc); } catch {}
    }

    res.json({ ok:true, event });
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

    const events = readJson(eventsPath, []);
    events.filter(e => String(e.animalId) === animalId)
      .forEach(e => items.push({
        kind:'event',
        ts: e.ts || toDate(e.date)?.getTime() || Date.now(),
        title: e.type || e.title || 'حدث',
        summary: e.note || e.notes || ''
      }));

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
    res.json({ ok:true, items: items.slice(0, limit) });
  } catch (e) {
    console.error('timeline', e);
    res.status(500).json({ ok:false, error:'timeline_failed' });
  }
});

// ============================================================
//                       API: HERD STATS
// ============================================================
app.get('/api/herd-stats', async (req, res) => {
  try {
    const tenant  = resolveTenant(req);
    const analysisDays  = parseInt(req.query.analysisDays || '90', 10);

    if (db) {
   const adb = db;

let animalsDocs = [];
try {
  // 🟢 استخدم Firestore الافتراضي مباشرة بدل murabbikdata
 const snap = await db.collection('animals')
  .where('userId','==',tenant)
  .limit(2000)
  .get();

  animalsDocs = snap.docs;
  console.log(`✅ Found ${animalsDocs.length} animals for`, tenant);
} catch (e) {
  console.error('❌ animals query failed:', e.code || e.message);
}


// 🔹 تحويل نتائج Firestore إلى مصفوفة حيوانات
const animals = animalsDocs.map(d => ({ id: d.id, ...(d.data() || {}) }));
      console.log("🧭 herd-stats tenant =", tenant);


// ✅ جميع الحيوانات تعتبر نشطة مؤقتاً (لا يوجد حقل active/status حالياً)
const active = animals;
const totalActive = animals.length;


      const since = new Date(Date.now() - (analysisDays + 340) * dayMs);
      const sinceStr = toYYYYMMDD(since);

  async function fetchType(type) {
  const out = [];
  async function tryQ(field) {
    try {
      const s = await adb.collection('events')
        .where(field, '==', tenant)
        .where('eventType', '==', type)
        .where('eventDate', '>=', sinceStr)
        .get();
      out.push(...s.docs);
    } catch {
      const s = await adb.collection('events')
        .where(field, '==', tenant)
        .where('eventType', '==', type)
        .orderBy('eventDate', 'desc')
        .limit(2000)
        .get()
        .catch(() => ({ docs: [] }));
      (s.docs || []).forEach(d => {
        if ((d.get('eventDate') || '') >= sinceStr) out.push(d);
      });
    }
  }
  await tryQ('userId');
  await tryQ('farmId');
  const map = new Map();
  out.forEach(d => map.set(d.id, d));
  return [...map.values()].map(d => ({ id: d.id, ...(d.data() || {}) }));
}


      const [ins, preg] = await Promise.all([fetchType('insemination'), fetchType('pregnancy')]);

      const activeIds = new Set(active.map(a=>String(a.id)));
      const winStart = new Date(Date.now() - analysisDays * dayMs);

      const insWin  = ins .filter(e => activeIds.has(String(e.animalId)) && toDate(e.date||e.createdAt) >= winStart);
      const pregPos = preg.filter(e => activeIds.has(String(e.animalId)) && /preg|positive|حمل|ايجاب/i.test(String(e.result||e.status||e.outcome||'')));

      const pregSet = new Set(pregPos.map(e=>String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregSet.size);
      const conceptionRate = insWin.length ? +((pregPos.filter(e=>toDate(e.date||e.createdAt) >= winStart).length / insWin.length) * 100).toFixed(1) : 0;

      return res.json({
        ok:true,
        totals:{
          totalActive,
          pregnant:   { count: pregSet.size, pct: totalActive? +((pregSet.size/totalActive)*100).toFixed(1):0 },
          inseminated:{ count: new Set(insWin.map(e=>String(e.animalId))).size, pct: totalActive? +((new Set(insWin.map(e=>String(e.animalId))).size/totalActive)*100).toFixed(1):0 },
          open:       { count: openCount, pct: totalActive? +((openCount/totalActive)*100).toFixed(1):0 }
        },
        fertility:{ conceptionRatePct: conceptionRate }
      });
    }

    // Local fallback
    const animalsAll = readJson(animalsPath, []).filter(a=>belongs(a,tenant));
    const active  = animalsAll.filter(a => a.active !== false && !['sold','dead','archived','inactive'].includes(String(a.status||'').toLowerCase()));
    const totalActive = active.length;

    const evAll   = readJson(eventsPath, []).filter(e=>belongs(e,tenant));
    const winStart = new Date(Date.now() - analysisDays * dayMs);
    const insWin  = evAll.filter(e => /insemination|تلقيح/i.test(e.type||'') && toDate(e.ts||e.date) >= winStart);
    const pregPos = evAll.filter(e => /pregnancy|حمل/i.test(e.type||'') && /positive|ايجاب/i.test(String(e.result||e.status||e.outcome||'')));

    const pregSet = new Set(pregPos.map(e=>String(e.animalId)));
    const openCount = Math.max(0, totalActive - pregSet.size);
    const conceptionRate = insWin.length ? +((pregPos.filter(e=>toDate(e.ts||e.date) >= winStart).length / insWin.length) * 100).toFixed(1) : 0;

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
//                       API: ANIMALS (robust)
// ============================================================
app.get('/api/animals', async (req, res) => {
  try {
    const tenant = resolveTenant(req);
    const analysisDays = parseInt(req.query.analysisDays || '90', 10);

    if (db) {
      const adb = db;
      console.log('🧭 herd-stats tenant =', tenant);

      // ✅ جلب الحيوانات عبر collectionGroup
      let animalsDocs = [];
     try {
  const snap = await adb.collection('animals')
    .where('userId', '==', tenant)
    .limit(2000)
    .get();

  animalsDocs = snap.docs;
  console.log(`✅ Found ${animalsDocs.length} animals for`, tenant);
} catch (e) {
  console.error('❌ animals query failed:', e.code || e.message);
}


      const animals = animalsDocs.map(d => ({ id: d.id, ...(d.data() || {}) }));
      const totalActive = animals.length;

      const since = new Date(Date.now() - (analysisDays + 340) * 86400000);
      const sinceStr = since.toISOString().slice(0, 10);

      async function fetchType(type) {
        const out = [];
        for (const field of ['userId', 'farmId']) {
          try {
            const s = await adb.collection('events')
              .where(field, '==', tenant)
              .where('eventType', '==', type)
              .where('eventDate', '>=', sinceStr)
              .get();
            out.push(...s.docs);
          } catch {}
        }
        const map = new Map();
        out.forEach(d => map.set(d.id, d));
        return [...map.values()].map(d => ({ id: d.id, ...(d.data() || {}) }));
      }

      const [ins, preg] = await Promise.all([
        fetchType('insemination'),
        fetchType('pregnancy')
      ]);

      const activeIds = new Set(animals.map(a => String(a.id)));
      const winStart = new Date(Date.now() - analysisDays * 86400000);

      const insWin = ins.filter(e => activeIds.has(String(e.animalId)));
      const pregPos = preg.filter(e =>
        activeIds.has(String(e.animalId)) &&
        /preg|positive|حمل|ايجاب/i.test(String(e.result || e.status || e.outcome || ''))
      );

      const pregSet = new Set(pregPos.map(e => String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregSet.size);
      const conceptionRate = insWin.length
        ? +((pregPos.length / insWin.length) * 100).toFixed(1)
        : 0;

      return res.json({
        ok: true,
        totals: {
          totalActive,
          pregnant: {
            count: pregSet.size,
            pct: totalActive
              ? +((pregSet.size / totalActive) * 100).toFixed(1)
              : 0
          },
          inseminated: {
            count: new Set(insWin.map(e => String(e.animalId))).size,
            pct: totalActive
              ? +(
                  (new Set(insWin.map(e => String(e.animalId))).size /
                    totalActive) *
                  100
                ).toFixed(1)
              : 0
          },
          open: {
            count: openCount,
            pct: totalActive
              ? +((openCount / totalActive) * 100).toFixed(1)
              : 0
          }
        },
        fertility: { conceptionRatePct: conceptionRate }
      });
    } else {
      return res.json({ ok: false, error: 'firestore_disabled' });
    }
  } catch (e) {
    console.error('herd-stats', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============================================================
//                 ADMIN: transfer owner (safe)
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
  const adb = db;


    function uniqPush(set,d){ if(d&&d.exists) set.set(d.ref.path,d); }
    async function findByNumber(val){
      const set=new Map(); const cand=[val]; const n=Number(val); if(!Number.isNaN(n)) cand.push(n);
      for (const v of cand) {
        try { (await adb.collection('animals').where('number','==',v).limit(50).get()).docs.forEach(d=>uniqPush(set,d)); } catch {}
       
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
//                 FIX: claim numbers to current user
// ============================================================
app.post('/api/fix/animals/claim', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });
    const tenant = req.userId;
    const numsParam = String(req.query.nums || '').trim();
    const allow = new Set(String(req.query.allow||'').split(',').map(s=>s.trim()).filter(Boolean));
    const dry = String(req.query.dry||'') === '1';
    if (!numsParam) return res.status(400).json({ ok:false, error:'nums required' });

   const adb = db;

    const wanted = numsParam.split(',').map(s=>s.trim()).filter(Boolean).slice(0,50);
    const seen = new Map();
    const push = d => { if (d && d.exists) seen.set(d.ref.path, d); };

    async function findByNumber(v){
      const cand=[v]; const n=Number(v); if(!Number.isNaN(n)) cand.push(n);
      for(const x of cand){
        try{ (await adb.collection('animals').where('number','==',x).limit(50).get()).docs.forEach(push);}catch{}
       
      }
      try{ const d=await adb.collection('animals').doc(String(v)).get(); push(d);}catch{}
    }

    for(const num of wanted) await findByNumber(num);

    const plan=[];
    for(const d of seen.values()){
      const a=d.data()||{};
      const owner=a.userId||a.farmId||a.createdBy||a.ownerId||a.uid||null;
      const can = !owner || allow.has(String(owner).trim());
      plan.push({ path:d.ref.path, id:d.id, number:a.number??null, owner_before:owner??null, willUpdate:!!can });
      if (can && !dry) await d.ref.set({ userId: tenant, farmId: tenant }, { merge:true });
    }

    res.json({ ok:true, dryRun:dry, tenant, found:plan.length,
      updated: dry ? 0 : plan.filter(p=>p.willUpdate).length, plan });
  } catch (e) {
    console.error('claim error', e);
    res.status(500).json({ ok:false, error:e?.message||'claim_failed' });
  }
});

// ============================================================
//                 DEBUG + PAGES
// ============================================================
app.get('/api/sensors/health', async (_req, res) => {
  if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });
  try {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const snap = await db.collection('devices').where('lastSeen', '>=', tenMinAgo).get();
    const count = snap.docs
      .map(d => (d.data().type || '').toLowerCase())
      .filter(t => t !== 'env' && t !== 'thi').length;
    return res.json({ ok:true, devices: count });
  } catch {
    return res.status(500).json({ ok:false, error:'health_failed' });
  }
});

if (ADMIN_DEV_OPEN) {
  app.get('/api/debug/echo-tenant', (req, res) => {
    const headerUserId = req.headers['x-user-id'] || null;
    const queryUserId = req.query.userId || null;
    const resolvedTenant = headerUserId || queryUserId || 'none';
    res.json({
      header_x_user_id: headerUserId,
      query_user_id: queryUserId,
      resolvedTenant,
      env: 'DEV',
      time: new Date().toISOString()
    });
  });
}


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

// Static last
app.use(express.static(path.join(__dirname, 'www')));

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
