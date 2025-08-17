// ✅ server.js — النسخة النهائية (مُنقّحة)
// ------------------------------------------------------------
// - تجهيز خادم إكسبريس + ملفات محلية (users/animals/events)
// - تكامل Firebase Admin (Firestore) لأجهزة الاستشعار والتنبيهات
// - راوتات: /ingest /api/devices /api/alerts /api/sensors/health /api/animal-timeline
// - استدعاء تنبيهات بدون حساسات داخل /api/events
// ------------------------------------------------------------

const { evaluateSensorAlerts, evaluateAppAlerts } = require('./server/alerts-engine');

const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------
// ملفات التخزين المحلي
// -------------------------
const dataDir = path.join(__dirname, 'data');
const usersPath = path.join(dataDir, 'users.json');
const animalsPath = path.join(dataDir, 'animals.json');
const eventsPath = path.join(dataDir, 'events.json');
const alertsPath = path.join(dataDir, 'alerts.json'); // (مستخدمة لتوافق قديم لمسار /alerts/:id)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// -------------------------
// ميدلوير أساسي
// -------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'www')));

// -------------------------
// Firebase Admin (اختياري)
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
  console.log('⚠️ Sensors API disabled (no service account).', e.message);
}

// ============================================================
//                API ROUTES — بيانات التطبيق
// ============================================================

// تسجيل مستخدم جديد (تخزين محلي)
app.post('/api/users', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'البيانات ناقصة' });
  }
  let users = [];
  if (fs.existsSync(usersPath)) users = JSON.parse(fs.readFileSync(usersPath, 'utf8') || '[]');
  if (users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'رقم الهاتف مستخدم مسبقًا' });
  }
  const newUser = { id: users.length + 1, name, phone, password };
  users.push(newUser);
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
  res.json({ message: 'تم إنشاء الحساب بنجاح', user: newUser });
});

// تسجيل الدخول (تخزين محلي)
app.post('/api/users/login', (req, res) => {
  const { phone, password } = req.body || {};
  if (!fs.existsSync(usersPath)) return res.status(500).send('ملف المستخدمين غير موجود');
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8') || '[]');
  const user = users.find(u => u.phone === phone && u.password === password);
  if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ message: 'تم تسجيل الدخول', user });
});

// تسجيل حيوان جديد (تخزين محلي)
app.post('/api/animals', (req, res) => {
  const newAnimal = req.body || {};
  let animals = [];
  if (fs.existsSync(animalsPath)) animals = JSON.parse(fs.readFileSync(animalsPath, 'utf8') || '[]');
  newAnimal.id = animals.length + 1;
  animals.push(newAnimal);
  fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
  res.status(200).json({ message: 'تم تسجيل الحيوان بنجاح' });
});

// تسجيل حدث عام + توليد تنبيهات بدون حساسات (تخزين محلي للأحداث)
app.post('/api/events', async (req, res) => {
  try {
    const event = req.body || {};
    if (!event || !event.type || !event.animalId) {
      return res.status(400).json({ error: 'بيانات الحدث ناقصة' });
    }
    let events = [];
    if (fs.existsSync(eventsPath)) events = JSON.parse(fs.readFileSync(eventsPath, 'utf8') || '[]');
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

    // تحديثات خاصة بحدث الولادة في ملف animals.json
    if (event.type === 'ولادة' && fs.existsSync(animalsPath)) {
      let animals = JSON.parse(fs.readFileSync(animalsPath, 'utf8') || '[]');
      const index = animals.findIndex(a => String(a.number) === String(event.animalId));
      if (index !== -1) {
        animals[index].lastCalvingDate = event.calvingDate || event.ts;
        animals[index].reproductiveStatus = 'حديث الولادة';
        animals[index].dailyMilkProduction = 0;
        if (animals[index].lastInseminationDate) delete animals[index].lastInseminationDate;
        fs.writeFileSync(animalsPath, JSON.stringify(animals, null, 2));
      }
    }

    // ✅ تنبيهات بدون حساسات — تُكتب في Firestore (لو مُفعّل)
    if (db) {
      await evaluateAppAlerts(db, { now: Date.now(), farmId: event.farmId || 'DEFAULT', event });
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

// صحتـة اتصال API الحساسات للبلاطة
app.get('/api/sensors/health', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, error: 'sensors_api_disabled' });
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const snap = await db.collection('devices').where('lastSeen', '>=', tenMinAgo).get();
    // استبعاد أنواع الطقس/THI من العدّ حسب اتفاقنا
    const count = snap.docs
      .map(d => (d.data().type || '').toLowerCase())
      .filter(t => t !== 'env' && t !== 'thi').length;
    return res.json({ ok: true, devices: count });
  } catch (e) {
    console.error('health', e);
    return res.status(500).json({ ok: false, error: 'health_failed' });
  }
});

// استقبال قراءات أجهزة خارجية/داخلية (ingest)
// body: { farmId, deviceId, device?:{name,type}, subject?:{animalId}, metrics:[{name,value,unit,ts}] }
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
      farmId, deviceId,
      name: device.name || deviceId,
      type: (device.type || 'generic').toLowerCase(),
      lastSeen,
      subject: subject || prevDoc?.subject || null
    }, { merge: true });
    await ref.set({ metrics: metricsMap }, { merge: true });

    // Timeline (telemetry)
    await ref.collection('telemetry').doc(String(lastSeen)).set({
      ts: lastSeen, farmId, deviceId,
      subject: subject || prevDoc?.subject || null,
      metrics: metricsMap
    });

    // تنبيهات "بالحساسات"
    const alerts = evaluateSensorAlerts({
      now: lastSeen, farmId, deviceId,
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

// قراءة قائمة الأجهزة (تستخدمها sensor-test.html)
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

// قراءة التنبيهات للواجهة (بوب-أبس)
app.get('/api/alerts', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'sensors_api_disabled' });
    const farm  = req.query.farm || null;
    const since = Number(req.query.since || 0);

    let q = db.collection('alerts');
    if (farm) q = q.where('farmId', '==', farm);
    if (since) q = q.where('ts', '>=', since);
    q = q.orderBy('ts', 'asc').limit(100);

    const snap = await q.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, items });
  } catch (e) {
    console.error('alerts', e);
    return res.status(500).json({ ok:false, error:'alerts_failed' });
  }
});

// الخط الزمني لحيوان: أحداث (ملف محلي) + تنبيهات (Firestore) + آخر قراءات الأجهزة (Firestore)
app.get('/api/animal-timeline', async (req, res) => {
  try {
    const animalId = String(req.query.animalId || '').trim();
    if (!animalId) return res.status(400).json({ ok:false, error:'animalId required' });

    const items = [];

    // 1) أحداث التطبيق من الملف المحلي
    if (fs.existsSync(eventsPath)) {
      const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8') || '[]');
      events.filter(e => String(e.animalId) === animalId)
        .forEach(e => items.push({ kind:'event', ts: e.ts || Date.now(), title: e.type, summary: e.note || '' }));
    }

    // 2) تنبيهات Firestore
    if (db) {
      const alSnap = await db.collection('alerts')
        .where('subject.animalId', '==', animalId)
        .orderBy('ts', 'desc')
        .limit(200)
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
    return res.json({ ok:true, items });
  } catch (e) {
    console.error('timeline', e);
    return res.status(500).json({ ok:false, error:'timeline_failed' });
  }
});

// ============================================================
//                   WEB PAGES / STATIC
// ============================================================
app.get('/sensors.html', (req, res) => res.redirect(301, '/sensor-test.html'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'www', 'index.html')));

// توافق قديم لمسار قديم
app.get('/alerts/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  let alerts = [];
  if (fs.existsSync(alertsPath)) alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8') || '[]');
  const userAlerts = alerts.filter(a => a.user_id === userId);
  res.json({ alerts: userAlerts });
});

app.get('/api/animals', (req, res) => {
  fs.readFile(animalsPath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'فشل في قراءة البيانات' });
    try { res.json(JSON.parse(data)); } catch { res.status(500).json({ error: 'خطأ في البيانات' }); }
  });
});

// ============================================================
//                    START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
