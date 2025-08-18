// ✅ server.js — نسخة مُنقّحة ومحكومة بالمزرعة (farmId)
// ------------------------------------------------------------
// - Express + تخزين محلي (users/animals/events)
// - Firebase Admin (Firestore) للحساسات والتنبيهات
// - Routes: /ingest /api/devices /api/alerts /api/sensors/health /api/animal-timeline
// - /api/herd-stats (ملخص القطيع) مع Fallback للملفات + فلترة farmId
// - بوابة اختيارية /timeline.html للأدمن فقط
// ------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const { evaluateSensorAlerts, evaluateAppAlerts } = require('./server/alerts-engine');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------
// ملفات التخزين المحلي
// -------------------------
const dataDir     = path.join(__dirname, 'data');
const usersPath   = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const eventsPath  = path.join(dataDir, 'events.json');
const alertsPath  = path.join(dataDir, 'alerts.json'); // توافق قديم لمسار /alerts/:id
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// -------------------------
// ميدلوير أساسي
// -------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------
// Firebase Admin (إن أمكن)
// -------------------------
let db = null;
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: sa ? admin.credential.cert(sa) : admin.credential.applicationDefault()
    });
  }
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized');
} catch (e) {
  console.log('⚠️ Firestore disabled (no/invalid service account):', e.message);
}

// -------------------------
// Helpers
// -------------------------
const dayMs = 86400000;
const toYYYYMMDD = (d) => d.toISOString().slice(0, 10);
const toDate = (v) => {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
};
const readJson = (p, fallback=[]) => {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8') || '[]') : fallback; }
  catch { return fallback; }
};
// تطبيع هوية المزرعة + مقارنة آمنة
const farmKey = (v) => (v == null || v === '' ? 'DEFAULT' : String(v));
const sameFarm = (recFarm, targetFarm) => farmKey(recFarm) === farmKey(targetFarm);

// ============================================================
//                API ROUTES — بيانات التطبيق
// ============================================================

// تسجيل مستخدم جديد (محلي)
app.post('/api/users', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'البيانات ناقصة' });
  }
  const users = readJson(usersPath, []);
  if (users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'رقم الهاتف مستخدم مسبقًا' });
  }
  const newUser = { id: users.length + 1, name, phone, password };
  users.push(newUser);
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
  res.json({ message: 'تم إنشاء الحساب بنجاح', user: newUser });
});

// تسجيل الدخول (محلي)
app.post('/api/users/login', (req, res) => {
  const { phone, password } = req.body || {};
  const users = readJson(usersPath, []);
  const user = users.find(u => u.phone === phone && u.password === password);
  if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ message: 'تم تسجيل الدخول', user });
});

// تسجيل حيوان جديد (محلي)
app.post('/api/animals', (req, res) => {
  const animals = readJson(animalsPath, []);
  const farmId = req.body.farmId || req.body.farm || 'DEFAULT';
  const newAnimal = { ...req.body, id: animals.length + 1, farmId };
  animals.push(newAnimal);
  fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
  res.status(200).json({ message: 'تم تسجيل الحيوان بنجاح' });
});

// تسجيل حدث عام + توليد تنبيهات بدون حساسات (محلي + Firestore إن وُجد)
app.post('/api/events', async (req, res) => {
  try {
    const event = req.body || {};
    // تطبيع/تثبيت farmId للحدث
    event.farmId = event.farmId || event.farm || req.headers['x-farm-id'] || process.env.DEFAULT_FARM_ID || 'DEFAULT';

    if (!event || !event.type || !event.animalId) {
      return res.status(400).json({ error: 'بيانات الحدث ناقصة' });
    }
    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    // Mirror إلى Firestore (غير إلزامي)
    if (db) {
      const t = String(event.type || '').toLowerCase();
      const typeNorm =
        t.includes('insemin') || t.includes('تلقيح') ? 'insemination' :
        t.includes('preg')    || t.includes('حمل')    ? 'pregnancy'   :
        t.includes('calv')    || t.includes('ولادة')  ? 'birth'       :
        t.includes('heat')    || t.includes('شياع')   ? 'heat'        :
        'event';

      const whenMs = Number(event.ts || Date.now());
      const whenISO = new Date(whenMs).toISOString().slice(0,10);

      const doc = {
        farmId: farmKey(event.farmId),
        animalId: String(event.animalId || ''),
        type: typeNorm,
        date: whenISO, // YYYY-MM-DD
        createdAt: admin.firestore.Timestamp.fromMillis(whenMs),
        species: (event.species || 'buffalo').toLowerCase(),
        result: event.result || event.status || '',
        note: event.note || ''
      };
      try { await db.collection('events').add(doc); } catch {}
    }

    // تحديثات خاصة بحدث الولادة في ملف animals.json (بدون فقد باقي الحيوانات)
    if ((event.type === 'ولادة' || /birth|calv/i.test(event.type)) && fs.existsSync(animalsPath)) {
      const animals = readJson(animalsPath, []);
      const idx = animals.findIndex(a =>
        sameFarm(a.farmId, event.farmId) &&
        String(a.number ?? a.id) === String(event.animalId)
      );
      if (idx !== -1) {
        animals[idx].lastCalvingDate = event.calvingDate || event.ts;
        animals[idx].reproductiveStatus = 'حديث الولادة';
        animals[idx].dailyMilkProduction = 0;
        if (animals[idx].lastInseminationDate) delete animals[idx].lastInseminationDate;
        fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
      }
    }

    // تنبيهات بدون حساسات — تُكتب في Firestore إن أمكن
    if (db) {
      await evaluateAppAlerts(db, { now: Date.now(), farmId: farmKey(event.farmId), event });
    }

    res.status(200).json({ message: '✅ تم تسجيل الحدث بنجاح', event });
  } catch (e) {
    console.error('events', e);
    res.status(500).json({ error: 'failed_to_save_event' });
  }
});

// ============================================================
//           API ROUTES — حساسات/أجهزة + تنبيهات + صحة
// ============================================================

// صحة اتصال API الحساسات
app.get('/api/sensors/health', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'sensors_api_disabled' });
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const snap = await db.collection('devices').where('lastSeen', '>=', tenMinAgo).get();
    // استبعاد أنواع الطقس/THI من العدّ حسب الاتفاق
    const count = snap.docs
      .map(d => (d.data().type || '').toLowerCase())
      .filter(t => t !== 'env' && t !== 'thi').length;
    return res.json({ ok: true, devices: count });
  } catch (e) {
    console.error('health', e);
    return res.status(500).json({ ok: false, error: 'health_failed' });
  }
});

// استقبال قراءات أجهزة (ingest)
app.post('/ingest', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });

    const { farmId, deviceId, metrics = [], device = {}, subject } = req.body || {};
    if (!farmId || !deviceId) return res.status(400).json({ ok:false, error:'farmId & deviceId required' });

    const now = Date.now();
    const ref = db.collection('devices').doc(deviceId);
    const prevSnap = await ref.get();
    const prevDoc  = prevSnap.exists ? prevSnap.data() : null;

    const metricsMap = {};
    for (const m of metrics) {
      if (!m || !m.name) continue;
      metricsMap[m.name] = { value: m.value ?? null, unit: m.unit || '', ts: m.ts || now };
    }

    const lastSeen = metrics.reduce((t, m) => Math.max(t, m?.ts || now), now);

    // Snapshot
    await ref.set({
      farmId: farmKey(farmId),
      deviceId,
      name: device.name || deviceId,
      type: (device.type || 'generic').toLowerCase(),
      lastSeen,
      subject: subject || prevDoc?.subject || null
    }, { merge: true });
    await ref.set({ metrics: metricsMap }, { merge: true });

    // Timeline (telemetry)
    await ref.collection('telemetry').doc(String(lastSeen)).set({
      ts: lastSeen, farmId: farmKey(farmId), deviceId,
      subject: subject || prevDoc?.subject || null,
      metrics: metricsMap
    });

    // تنبيهات بالحساسات
    const alerts = evaluateSensorAlerts({
      now: lastSeen, farmId: farmKey(farmId), deviceId,
      subject: subject || prevDoc?.subject || null,
      metricsMap, prevDoc
    });
    for (const a of alerts) await db.collection('alerts').add({ ...a, read:false });

    return res.json({ ok:true, alerts: alerts.length });
  } catch (e) {
    console.error('ingest', e);
    return res.status(500).json({ ok:false, error:'ingest_failed' });
  }
});

// قراءة الأجهزة
app.get('/api/devices', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });

    const exclude = String(req.query.exclude || 'env,thi')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    const activeOnly = req.query.activeOnly === '1';
    const tenMinAgo = Date.now() - 10 * 60 * 1000;

    const snap = await db.collection('devices')
      .orderBy('lastSeen', 'desc')
      .limit(200)
      .get();

    let devices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (exclude.length) devices = devices.filter(d => !exclude.includes((d.type || '').toLowerCase()));
    if (activeOnly) devices = devices.filter(d => Number(d.lastSeen || 0) >= tenMinAgo);

    return res.json({ ok:true, devices });
  } catch (e) {
    console.error('devices', e);
    return res.status(500).json({ ok:false, error:'devices_failed' });
  }
});

// قراءة التنبيهات للواجهة (بوب-أبس/تحليلات)
app.get('/api/alerts', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });

    const farm     = req.query.farm || null;
    const animalId = req.query.animalId || null;
    const sinceMs  = Number(req.query.since || 0);
    const days     = Number(req.query.days || 0);
    const limit    = Math.min(Number(req.query.limit || 100), 2000);

    let q = db.collection('alerts');

    if (farm) q = q.where('farmId', '==', farm);
    if (animalId) q = q.where('subject.animalId', '==', animalId);

    let since = sinceMs;
    if (!since && days > 0) since = Date.now() - days * dayMs;
    if (since) q = q.where('ts', '>=', since);

    q = q.orderBy('ts', 'desc').limit(limit);

    const snap = await q.get();
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ ok:true, count: arr.length, alerts: arr, items: arr });
  } catch (e) {
    console.error('alerts', e);
    return res.status(500).json({ ok:false, error:'alerts_failed' });
  }
});

// الخط الزمني لحيوان (محلي + Firestore)
app.get('/api/animal-timeline', async (req, res) => {
  try {
    const animalId = String(req.query.animalId || '').trim();
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    if (!animalId) return res.status(400).json({ ok:false, error:'animalId required' });

    const items = [];

    // 1) أحداث التطبيق من الملف المحلي
    const events = readJson(eventsPath, []);
    events.filter(e => String(e.animalId) === animalId)
      .forEach(e => items.push({
        kind:'event',
        ts: e.ts || toDate(e.date || e.eventDate)?.getTime() || Date.now(),
        title: e.type || e.title || 'حدث',
        summary: e.note || e.notes || ''
      }));

    // 2) تنبيهات Firestore
    if (db) {
      const alSnap = await db.collection('alerts')
        .where('subject.animalId', '==', animalId)
        .orderBy('ts', 'desc')
        .limit(limit)
        .get()
        .catch(() => ({ docs: [] }));
      for (const d of (alSnap.docs || [])) {
        items.push({ kind:'alert', ts: d.get('ts'), code: d.get('code'), summary: d.get('message') });
      }

      // 3) آخر قراءات من الأجهزة المرتبطة بالحيوان
      const devSnap = await db.collection('devices')
        .where('subject.animalId', '==', animalId)
        .limit(50).get().catch(() => ({ docs: [] }));
      for (const d of (devSnap.docs || [])) {
        const m = d.get('metrics') || {};
        const summary = Object.entries(m).slice(0, 3)
          .map(([k, v]) => `${k}: ${v.value}${v.unit || ''}`).join(' • ');
        items.push({ kind:'reading', ts: d.get('lastSeen') || 0, name: d.id, summary });
      }
    }

    items.sort((a, b) => b.ts - a.ts);
    const eventsOut = items.slice(0, limit);
    return res.json({ ok:true, items: eventsOut, events: eventsOut });
  } catch (e) {
    console.error('timeline', e);
    return res.status(500).json({ ok:false, error:'timeline_failed' });
  }
});

// ============================================================
//           ملخصات القطيع للداشبورد: /api/herd-stats
// ============================================================
app.get('/api/herd-stats', async (req, res) => {
  try {
    const species = (req.query.species || '').toLowerCase(); // 'cow' | 'buffalo'
    // قيّد بالـ farmId (Header ثم Query ثم ENV ثم DEFAULT)
    const farmId = String(
      req.headers['x-farm-id'] || req.query.farmId || process.env.DEFAULT_FARM_ID || 'DEFAULT'
    );
    const inFarm = (recFarm) => sameFarm(recFarm, farmId);

    const analysisDays = parseInt(req.query.analysisDays || '90', 10);
    const gestationDays = species.includes('buffalo') ? 310 : 280;
    const pregLookbackDays = parseInt(req.query.pregnantLookbackDays || String(gestationDays), 10);
    const eventsLookbackDays = Math.max(analysisDays + gestationDays + 60, 420);

    const now = new Date();
    const sinceAnalysis = new Date(now.getTime() - analysisDays * dayMs);
    const sincePreg = new Date(now.getTime() - pregLookbackDays * dayMs);
    const sinceEvents = new Date(now.getTime() - eventsLookbackDays * dayMs);

    // ===== Firestore
    if (db) {
      const adb = admin.firestore();

      // الحيوانات (مفلترة بالمزرعة)
      const animalsSnap = await adb.collection('animals').get();
      const animals = animalsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(a => inFarm(a.farmId));

      const activeAnimals = animals.filter(a => {
        const st = String(a.status || '').toLowerCase();
        if (a.active === false) return false;
        if (['sold','dead','archived','inactive'].includes(st)) return false;
        return true;
      });
      const activeIds = new Set(activeAnimals.map(a => String(a.id)));
      const totalActive = activeIds.size;

      // الأحداث (مع fallback لو نقص اندكس)
      const eventsCol = adb.collection('events');
      const sinceStr = toYYYYMMDD(sinceEvents);

      async function fetchType(type) {
        try {
          const snap = await eventsCol
            .where('farmId','==', farmId)
            .where('type','==', type)
            .where('date','>=', sinceStr)
            .get();
          return snap.docs;
        } catch (e) {
          // Fallback: farm+type ثم فلترة التاريخ في الذاكرة
          const snap = await eventsCol
            .where('farmId','==', farmId)
            .where('type','==', type)
            .orderBy('date','desc')
            .limit(2000)
            .get()
            .catch(() => ({ docs: [] }));
          return (snap.docs || []).filter(d => (d.get('date') || '') >= sinceStr);
        }
      }

      const [insDocs, pregDocs, calvDocs] = await Promise.all([
        fetchType('insemination'),
        fetchType('pregnancy'),
        fetchType('birth')
      ]);

      const insAll  = insDocs .map(d => ({ id: d.id, ...d.data() })).filter(e => activeIds.has(String(e.animalId)));
      const pregAll = pregDocs.map(d => ({ id: d.id, ...d.data() })).filter(e => activeIds.has(String(e.animalId)));
      const births  = calvDocs.map(d => ({ id: d.id, ...d.data() })).filter(e => activeIds.has(String(e.animalId)));

      const byAnimal = (arr) => arr.reduce((m, e) => ((m[e.animalId] ||= []).push(e), m), {});
      const birthsByAnimal = byAnimal(births);
      const insByAnimal = byAnimal(insAll);

      const insInWindow = insAll.filter(e => toDate(e.date || e.createdAt) >= sinceAnalysis);

      const pregPosAll = pregAll.filter(e => {
        const resField = String(e.result || e.status || e.outcome || '').toLowerCase();
        const ok = /preg|positive|حمل|ايجاب/.test(resField);
        const when = toDate(e.date || e.createdAt);
        return ok && when >= sincePreg;
      });

      const pregnantSet = new Set(pregPosAll.map(e => String(e.animalId)));
      const openCount = Math.max(0, totalActive - pregnantSet.size);
      const inseminatedSet = new Set(insInWindow.map(e => String(e.animalId)));

      const pregPosInAnalysis = pregAll.filter(e => {
        const resField = String(e.result || e.status || e.outcome || '').toLowerCase();
        const ok = /preg|positive|حمل|ايجاب/.test(resField);
        const when = toDate(e.date || e.createdAt);
        return ok && when >= sinceAnalysis;
      });

      // Conception%
      const conceptionRate = insInWindow.length > 0
        ? (pregPosInAnalysis.length / insInWindow.length) * 100
        : 0;

      // متوسط خدمات/حمل
      let totals = 0, cases = 0;
      for (const pe of pregPosInAnalysis) {
        const aId = String(pe.animalId);
        const peDate = toDate(pe.date || pe.createdAt);
        if (!aId || !peDate) continue;
        const birthsForA = (birthsByAnimal[aId] || [])
          .sort((a,b)=> toDate(b.date||b.createdAt) - toDate(a.date||a.createdAt));
        const lastBirthBefore = birthsForA.find(b => toDate(b.date||b.createdAt) <= peDate);
        const lacStart = lastBirthBefore ? toDate(lastBirthBefore.date || lastBirthBefore.createdAt) : new Date(peDate.getTime() - 420*dayMs);
        const services = (insByAnimal[aId] || []).filter(s => {
          const d = toDate(s.date || s.createdAt);
          return d && d >= lacStart && d <= peDate;
        }).length;
        if (services > 0) { totals += services; cases += 1; }
      }
      const avgServicesPerConception = cases ? (totals / cases) : 0;

      const pct = (num) => totalActive > 0 ? +((num / totalActive) * 100).toFixed(1) : 0.0;

      return res.json({
        ok: true,
        windows: { analysisDays, pregnantLookbackDays: pregLookbackDays },
        totals: {
          totalActive,
          pregnant:   { count: pregnantSet.size,    pct: pct(pregnantSet.size) },
          inseminated:{ count: inseminatedSet.size, pct: pct(inseminatedSet.size) },
          open:       { count: openCount,           pct: pct(openCount) },
        },
        fertility: {
          conceptionRatePct: +conceptionRate.toFixed(1),
          avgServicesPerConception: +avgServicesPerConception.toFixed(2),
          denominators: {
            inseminationsInWindow: insInWindow.length,
            pregnanciesInWindow: pregPosInAnalysis.length
          }
        }
      });
    }

    // ===== Fallback: ملفات محلية (مفلترة بالمزرعة)
    const animals = readJson(animalsPath, []).filter(a => inFarm(a.farmId));
    const activeAnimals = animals.filter(a =>
      a.active !== false &&
      !['sold','dead','archived','inactive'].includes(String(a.status||'').toLowerCase())
    );
    const totalActive = activeAnimals.length;
    const events = readJson(eventsPath, []).filter(e => inFarm(e.farmId));

    // نعتبر: type قد يكون بالعربي أو إنجليزي
    const insAll  = events.filter(e => /insemination|تلقيح/i.test(e.type || ''));
    const pregAll = events.filter(e => /pregnancy|حمل/i.test(e.type || ''));
    const births  = events.filter(e => /birth|ولادة/i.test(e.type || ''));

    const insInWindow = insAll.filter(e => (toDate(e.ts || e.date) >= sinceAnalysis));
    const pregPosAll = pregAll.filter(e => {
      const ok = /positive|ايجاب/i.test(String(e.result || e.status || e.outcome || e.note || ''));
      const when = toDate(e.ts || e.date);
      return ok && when >= sincePreg;
    });

    const pregnantSet = new Set(pregPosAll.map(e => String(e.animalId)));
    const inseminatedSet = new Set(insInWindow.map(e => String(e.animalId)));
    const openCount = Math.max(0, totalActive - pregnantSet.size);

    const pregPosInAnalysis = pregAll.filter(e => {
      const ok = /positive|ايجاب/i.test(String(e.result || e.status || e.outcome || e.note || ''));
      const when = toDate(e.ts || e.date);
      return ok && when >= sinceAnalysis;
    });

    const conceptionRate = insInWindow.length > 0
      ? (pregPosInAnalysis.length / insInWindow.length) * 100
      : 0;

    // متوسط خدمات/حمل (تقريبي محليًا)
    const byAnimal = (arr) => arr.reduce((m, e) => ((m[String(e.animalId)] ||= []).push(e), m), {});
    const birthsByAnimal = byAnimal(births);
    const insByAnimal = byAnimal(insAll);

    let totals = 0, cases = 0;
    for (const pe of pregPosInAnalysis) {
      const aId = String(pe.animalId);
      const peDate = toDate(pe.ts || pe.date);
      const birthsForA = (birthsByAnimal[aId] || []).sort((a,b)=> (toDate(b.ts||b.date) - toDate(a.ts||a.date)));
      const lastBirthBefore = birthsForA.find(b => toDate(b.ts||b.date) <= peDate);
      const lacStart = lastBirthBefore ? toDate(lastBirthBefore.ts || lastBirthBefore.date) : new Date(peDate.getTime() - 420*dayMs);
      const services = (insByAnimal[aId] || []).filter(s => {
        const d = toDate(s.ts || s.date);
        return d && d >= lacStart && d <= peDate;
      }).length;
      if (services > 0) { totals += services; cases += 1; }
    }
    const avgServicesPerConception = cases ? (totals / cases) : 0;

    const pct = (num) => totalActive > 0 ? +((num / totalActive) * 100).toFixed(1) : 0.0;

    return res.json({
      ok: true,
      windows: { analysisDays, pregnantLookbackDays: pregLookbackDays },
      totals: {
        totalActive,
        pregnant:   { count: pregnantSet.size,    pct: pct(pregnantSet.size) },
        inseminated:{ count: inseminatedSet.size, pct: pct(inseminatedSet.size) },
        open:       { count: openCount,           pct: pct(openCount) },
      },
      fertility: {
        conceptionRatePct: +conceptionRate.toFixed(1),
        avgServicesPerConception: +avgServicesPerConception.toFixed(2),
        denominators: {
          inseminationsInWindow: insInWindow.length,
          pregnanciesInWindow: pregPosInAnalysis.length
        }
      }
    });
  } catch (e) {
    console.error('herd-stats error', e);
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// ============================================================
//                   WEB PAGES / ROUTES
// ============================================================

// (اختياري) بوابة timeline.html للأدمن فقط
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
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

app.get('/timeline.html', ensureAdmin, (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'www', 'timeline.html'));
});

app.get('/sensors.html', (req, res) => res.redirect(301, '/sensor-test.html'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// توافق قديم لمسار قديم
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const oldAlerts = readJson(alertsPath, []);
  const userAlerts = oldAlerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

app.get('/api/animals', (req, res) => {
  fs.readFile(animalsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'فشل في قراءة البيانات' });
    try { res.json(JSON.parse(data)); } catch { res.status(500).json({ error: 'خطأ في البيانات' }); }
  });
});

// ============================================================
//                    STATIC & START SERVER
// ============================================================
// مهم: static ييجي بعد الراوتات الخاصة (عشان حماية timeline.html)
app.use(express.static(path.join(__dirname, 'www')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
