// server.js — stable build, tenant-aware
// ----------------------------------------------
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const { computeTargets, getStandardWeight } = require('./server/nutrition-engine.js');
const { analyzeRation } = require('./server/ration-engine.js');
const EVENT_SYNONYMS = {
  insemination: ['insemination', 'تلقيح'],
  pregnancy_diagnosis: ['pregnancy diagnosis', 'pregnancy_diagnosis', 'تشخيص حمل', 'سونار', 'جس'],
  calving: ['calving', 'birth', 'ولادة'],
  dry_off: ['dry_off', 'dry-off', 'تجفيف', 'dry', 'جاف'],
  close_up: ['close-up', 'close_up', 'تحضير ولادة', 'تحضير'],
  daily_milk: ['daily milk', 'daily_milk', 'لبن يومي', 'اللبن اليومي', 'لبن'],
  nutrition: ['nutrition', 'تغذية', 'عليقة'],
  weaning: ['weaning', 'فطام'],
  lameness: ['lameness', 'عرج'], 
  hoof_trimming: ['hoof trimming', 'تقليم حوافر', 'حافر'], 
  vaccination: ['vaccination', 'تحصين', 'تطعيم'],
  milking_status: ['milking', 'milking status', 'حلاب'],
  fresh: ['fresh', 'حديث الولادة', 'فريش'],
  diagnosis: ['diagnosis', 'التشخيص', 'فحص', 'كشف']
};

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));



// ===== Firebase Admin (best-effort) =====
// ===== Firebase Admin (best-effort) =====
let db = null;
try {
  const sa = require("/etc/secrets/murabbik-470511-firebase-adminsdk-fbsvc-650a6ab6ef.json");
  console.log("SA project_id:", sa.project_id);
console.log("SA client_email:", sa.client_email);


  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa)
    });
  }

  console.log("🔥 Admin SDK Auth Identity:", sa.client_email);

  // اتصال Firestore الصحيح → murabbikdata
 const firestore = admin.firestore();
firestore.settings({ databaseId: "murabbikdata" });
db = firestore;

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

const tenantKey = v => String(v || '').trim();

function resolveTenant(req) {
  const uid =
    req.get("X-User-Id") ||
    req.headers["x-user-id"] ||
    req.query.userId ||
    null;
  return uid ? tenantKey(uid) : null;
}

// ============================================================
//                  WEATHER / THI CENTRAL SOURCE
// ============================================================
const WEATHER_DEFAULT_LAT = Number(process.env.WEATHER_LAT || 30.0444);
const WEATHER_DEFAULT_LON = Number(process.env.WEATHER_LON || 31.2357);
const WEATHER_CACHE_MS = 5 * 60 * 1000;

let weatherThiCache = {
  at: 0,
  data: null
};

function calcTHI(tempC, humidityPct) {
  const t = Number(tempC);
  const h = Number(humidityPct);

  if (!Number.isFinite(t) || !Number.isFinite(h)) return null;

  const tf = (t * 9 / 5) + 32;
  return Math.round(tf - ((0.55 - (0.0055 * h)) * (tf - 58)));
}

function classifyTHI(thi) {
  const n = Number(thi);

  if (!Number.isFinite(n)) {
    return {
      level: 'unknown',
      label: 'غير متاح',
      severity: 0
    };
  }

  if (n < 68) {
    return {
      level: 'comfort',
      label: 'راحة',
      severity: 0
    };
  }

  if (n < 72) {
    return {
      level: 'mild',
      label: 'إجهاد خفيف',
      severity: 1
    };
  }

  if (n < 78) {
    return {
      level: 'moderate',
      label: 'إجهاد متوسط',
      severity: 2
    };
  }

  return {
    level: 'high',
    label: 'إجهاد عالي',
    severity: 3
  };
}

function belongs(rec, tenant){
  const t = rec && rec.userId ? rec.userId : '';
  return tenantKey(t) === tenantKey(tenant);
}

function requireUserId(req, res, next){
  const t = resolveTenant(req);
  if (!t) return res.status(400).json({ ok:false, error:'userId_required' });
  req.userId = t;
  next();
}
function eventTextSrv(e = {}) {
  return [
    e?.type,
    e?.eventType,
    e?.name,
    e?.kind,
    e?.eventTypeNorm
  ].map(v => String(v || '').trim().toLowerCase()).join(' ');
}

function isWeaningEventSrv(e = {}) {
  const txt = eventTextSrv(e);
  return txt.includes('فطام') || txt.includes('weaning') || txt.includes('weaned');
}

function isCloseUpEventSrv(e = {}) {
  const txt = eventTextSrv(e);
  return txt.includes('انتظار الولادة') || txt.includes('close up') || txt.includes('closeup');
}

function isMilkEventSrv(e = {}) {
  const txt = eventTextSrv(e);
  return (
    txt.includes('daily_milk') ||
    txt.includes('لبن يومي') ||
    txt.includes('milk') ||
    txt.includes('milk report')
  );
}

function numSrv(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getEventMsSrv(e = {}) {
  const d =
    toDate(e?.eventDate) ||
    toDate(e?.date) ||
    toDate(e?.createdAt) ||
    toDate(e?.timestamp);
  return d ? d.getTime() : 0;
}

function eventAnimalKeySrv(e = {}) {
  return String(
    e?.animalNumber ??
    e?.number ??
    e?.calfNumber ??
    e?.animalId ??
    e?.animalID ??
    ''
  ).trim();
}
// ============================================================
//                  DIM: Daily updater (server-side)
// ============================================================
function cairoTodayISO(){
  // "YYYY-MM-DD" بتوقيت القاهرة (لتحديد اليوم الصحيح فقط)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function isoToUtcMidnightMs(iso){
  const [y,m,d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m-1, d);
}

function diffDaysISO(fromISO, toISO){
  // فرق أيام “تاريخ فقط” (بدون ساعات/دقائق)
  const ms = isoToUtcMidnightMs(toISO) - isoToUtcMidnightMs(fromISO);
  return Math.floor(ms / 86400000);
}
function reproAutoNormArSrv(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

function isFreshReproStatusForAutoOpenSrv(v) {
  const n = reproAutoNormArSrv(v);

  return (
    n === "حديثه الولاده" ||
    (n.includes("حديث") && n.includes("ولاد"))
  );
}

function reproAutoOpenThresholdDaysSrv(a = {}) {
  const t = String(
    a.animaltype ||
    a.animalTypeAr ||
    a.animalType ||
    a.species ||
    a.type ||
    ""
  ).trim().toLowerCase();

  const isBuffalo =
    t.includes("buffalo") ||
    t.includes("جاموس");

  // نفس السلوك الفعلي في repro-auto القديم:
  // جاموس: من 41 يوم، أبقار: من 50 يوم
  return isBuffalo ? 41 : 50;
}

function buildReproAutoOpenPatchSrv(a = {}, todayISO = "") {
  if (!isFreshReproStatusForAutoOpenSrv(a.reproductiveStatus)) return null;
  if (a.breedingBlocked === true) return null;

  const lcd = String(
    a.lastCalvingDate ||
    a.calvingDate ||
    a.lastCalving ||
    ""
  ).trim().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(lcd)) return null;

  const dim = diffDaysISO(lcd, todayISO);
  if (!Number.isFinite(dim) || dim < 0) return null;

  const threshold = reproAutoOpenThresholdDaysSrv(a);
  if (dim < threshold) return null;

  return {
    reproductiveStatus: "مفتوحة",
    reproAutoUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    reproAutoReason: `AutoOpenAfter${threshold}Days`,
    reproAutoDim: dim,
    reproAutoSource: "server:daily_maintenance"
  };
}
async function updateAllDIM(){
  try{
    if (!db) {
      console.log("⚠️ DIM skipped: Firestore disabled");
      return;
    }

    const todayISO = cairoTodayISO();

    const snap = await db.collection("animals").get();

    let updated = 0;
    let scanned = 0;
    const touchedTenants = new Set();

    let batch = db.batch();
    let ops = 0;

    for (const doc of snap.docs){
      scanned++;
      const a = doc.data() || {};

      const st = String(a.status || "active").toLowerCase();
      if (st === "inactive") continue;
      const reproPatch = buildReproAutoOpenPatchSrv(a, todayISO);

if (reproPatch) {
  batch.set(doc.ref, reproPatch, { merge: true });

  if (a.userId) touchedTenants.add(String(a.userId).trim());
  updated++;
  ops++;

  if (ops >= 400) {
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }
}
      const productionStatusText = String(a.productionStatus || "").trim().toLowerCase();

const isDryAnimal =
  a.inMilk === false ||
  productionStatusText === "جاف" ||
  productionStatusText === "dry" ||
  productionStatusText.includes("جاف") ||
  productionStatusText.includes("dry");

if (isDryAnimal) {
  const needsDryDimReset =
    a.daysInMilk !== null ||
    a.dailyMilk !== null ||
    a.milkTodayKg !== null;

  if (needsDryDimReset) {
    batch.set(doc.ref, {
      daysInMilk: null,
      dailyMilk: null,
      milkTodayKg: null,
      _dimUpdatedAt: todayISO
    }, { merge: true });

    if (a.userId) touchedTenants.add(String(a.userId).trim());
    updated++;
    ops++;
  }

  if (ops >= 400) {
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }

  continue;
}

      const lcd = String(a.lastCalvingDate || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lcd)) continue;

      let dim = diffDaysISO(lcd, todayISO);
      if (!Number.isFinite(dim) || dim < 0) dim = 0;

      if (Number(a.daysInMilk) === dim) continue;

      batch.set(doc.ref, { daysInMilk: dim, _dimUpdatedAt: todayISO }, { merge:true });
      if (a.userId) touchedTenants.add(String(a.userId).trim());
      updated++;
      ops++;

      if (ops >= 400){
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    for (const uid of touchedTenants) {
      if (typeof scheduleGroupsRebuildSrv === 'function') {
        scheduleGroupsRebuildSrv(uid, 'daily_dim_update');
      }
    }

    console.log("✅ DIM updated:", { todayISO, scanned, updated, groupsRebuildQueued: touchedTenants.size });
  } catch (e){
    console.error("❌ DIM update failed:", e.message || e);
  }
}

function msUntilNextCairo0010(){
  // تشغيل يومي 00:10 بتوقيت القاهرة
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(now).reduce((acc,p)=>{ acc[p.type]=p.value; return acc; }, {});

  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const hh = Number(parts.hour), mm = Number(parts.minute), ss = Number(parts.second);

  const nowCairoUtcMs = Date.UTC(y, m-1, d, hh, mm, ss);

  const targetTodayUtcMs = Date.UTC(y, m-1, d, 0, 10, 0);
  const targetUtcMs = (nowCairoUtcMs < targetTodayUtcMs)
    ? targetTodayUtcMs
    : Date.UTC(y, m-1, d+1, 0, 10, 0);

  return Math.max(1000, targetUtcMs - nowCairoUtcMs);
}

function startDailyDimJob(){
  const first = msUntilNextCairo0010();
  console.log("⏳ DIM job scheduled (ms):", first);

  setTimeout(async () => {
    await updateAllDIM();
    setInterval(updateAllDIM, 24 * 60 * 60 * 1000);
  }, first);
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
//                  API: WEATHER / THI
// ============================================================
app.get('/api/weather/thi', async (req, res) => {
  try {
    const now = Date.now();

    if (weatherThiCache.data && (now - weatherThiCache.at) < WEATHER_CACHE_MS) {
      return res.json({
        ok: true,
        cached: true,
        ...weatherThiCache.data
      });
    }

    let lat = Number(req.query.lat);
    let lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      lat = WEATHER_DEFAULT_LAT;
    }

    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      lon = WEATHER_DEFAULT_LON;
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=temperature_2m,relative_humidity_2m&timezone=auto`;

    let r = null;
    let j = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);

      r = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Murabbik/1.0'
        }
      });

      clearTimeout(timer);

      if (!r.ok) {
        throw new Error(`open_meteo_${r.status}`);
      }

      j = await r.json();
    } catch (e) {
      console.warn('weather.thi upstream failed:', e.message || e);

      if (weatherThiCache.data) {
        return res.json({
          ok: true,
          cached: true,
          stale: true,
          warning: 'weather_upstream_failed',
          ...weatherThiCache.data
        });
      }

      return res.json({
        ok: true,
        cached: false,
        fallback: true,
        warning: 'weather_unavailable',
        tempC: null,
        humidity: null,
        thi: null,
        status: {
          level: 'unknown',
          label: 'غير متاح',
          severity: 0
        },
        source: 'weather-fallback',
        lat,
        lon,
        updatedAt: new Date().toISOString()
      });
    }

    const tempC = Number(j?.current?.temperature_2m);
    const humidity = Number(j?.current?.relative_humidity_2m);
    const thi = calcTHI(tempC, humidity);
    const status = classifyTHI(thi);

    const data = {
      tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
      humidity: Number.isFinite(humidity) ? Math.round(humidity) : null,
      thi,
      status,
      source: 'open-meteo',
      lat,
      lon,
      updatedAt: new Date().toISOString()
    };

    weatherThiCache = {
      at: now,
      data
    };

    return res.json({
      ok: true,
      cached: false,
      ...data
    });

  } catch (e) {
    console.error('weather.thi fatal error:', e.message || e);

    return res.json({
      ok: true,
      cached: false,
      fallback: true,
      warning: 'weather_route_failed',
      tempC: null,
      humidity: null,
      thi: null,
      status: {
        level: 'unknown',
        label: 'غير متاح',
        severity: 0
      },
      source: 'weather-fallback',
      lat: WEATHER_DEFAULT_LAT,
      lon: WEATHER_DEFAULT_LON,
      updatedAt: new Date().toISOString()
    });
  }
});
// ============================================================
//                       API: EVENTS
// ============================================================
// ========================
//  Event Type Normalizer
// ========================
function normalizeEventType(raw) {
  const t = String(raw || '').toLowerCase();
  for (const [norm, arr] of Object.entries(EVENT_SYNONYMS)) {
    for (const w of arr) {
      if (t.includes(w.toLowerCase())) return norm;
    }
  }
  return t;
}
// ============================================================
//                 API: ADD ANIMAL — SERVER SIDE SAVE
//                 تسجيل حيوان جديد من السيرفر فقط
// ============================================================

function addAnimalDigitsSrv(v) {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };

  return String(v || "")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, "")
    .replace(/[٠-٩۰-۹]/g, d => map[d] || d);
}

function addAnimalStrSrv(v) {
  return String(v ?? "").trim();
}

function addAnimalNumSrv(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function addAnimalIsDateSrv(v) {
  const s = String(v || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addAnimalDateOrNullSrv(v) {
  const s = String(v || "").trim().slice(0, 10);
  return addAnimalIsDateSrv(s) ? s : null;
}

function addAnimalTodaySrv() {
  return typeof cairoTodayISO === "function"
    ? cairoTodayISO()
    : new Date().toISOString().slice(0, 10);
}

function addAnimalDiffDaysSrv(fromISO, toISO) {
  if (!addAnimalIsDateSrv(fromISO) || !addAnimalIsDateSrv(toISO)) return null;

  const [fy, fm, fd] = String(fromISO).slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = String(toISO).slice(0, 10).split("-").map(Number);

  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  const d = Math.floor((b - a) / 86400000);

  return Number.isFinite(d) && d >= 0 ? d : null;
}

function addAnimalSpeciesFromTypeSrv(animalType) {
  const raw = addAnimalStrSrv(animalType);

  if (raw === "بقرة" || /cow|بقر|ابقار|أبقار/i.test(raw)) {
    return {
      animalTypeAr: "بقرة",
      animaltype: "cow",
      species: "أبقار"
    };
  }

  if (raw === "جاموسة" || /buffalo|جاموس/i.test(raw)) {
    return {
      animalTypeAr: "جاموسة",
      animaltype: "buffalo",
      species: "جاموس"
    };
  }

  return {
    animalTypeAr: raw,
    animaltype: "",
    species: ""
  };
}

function addAnimalBasicFieldsDecisionSrv(fd = {}) {
  const errors = {};

  if (!addAnimalDigitsSrv(fd.animalNumber || fd.number || fd.calfNumber)) {
    errors.animalNumber = "رقم الحيوان مطلوب.";
  }

  if (!addAnimalStrSrv(fd.animalType || fd.animalTypeAr)) {
    errors.animalType = "نوع الحيوان مطلوب.";
  }

  if (!addAnimalStrSrv(fd.breed)) {
    errors.breed = "السلالة مطلوبة.";
  }

  if (!addAnimalStrSrv(fd.entryType)) {
    errors.entryType = "نوع الإدخال غير محدد.";
  }

  const dateFields = [
    ["birthDate", "تاريخ الميلاد غير صالح."],
    ["lastCalvingDate", "تاريخ آخر ولادة غير صالح."],
    ["lastInseminationDate", "تاريخ آخر تلقيح غير صالح."],
    ["weaningDate", "تاريخ الفطام غير صالح."],
    ["followerLastInseminationDate", "تاريخ آخر تلقيح غير صالح."]
  ];

  for (const [field, msg] of dateFields) {
    if (addAnimalStrSrv(fd[field]) && !addAnimalIsDateSrv(fd[field])) {
      errors[field] = msg;
    }
  }

  const numFields = [
    ["dailyMilk", "إنتاج اللبن غير صالح."],
    ["servicesCount", "عدد مرات التلقيح غير صالح."],
    ["lactationNumber", "رقم موسم الحليب غير صالح."],
    ["daysInMilk", "عدد أيام الحليب غير صالح."],
    ["pregnancyDays", "عدد أيام الحمل غير صالح."],
    ["followerServicesCount", "عدد مرات التلقيح غير صالح."],
    ["followerPregnancyDays", "عدد أيام الحمل غير صالح."]
  ];

  for (const [field, msg] of numFields) {
    const val = addAnimalStrSrv(fd[field]);
    if (val && !Number.isFinite(Number(val))) {
      errors[field] = msg;
    }
  }

  return errors;
}

function addAnimalDecisionSrv(fd = {}) {
  const mode = addAnimalStrSrv(fd.entryType);

  if (mode === "mothers") {
    if (!addAnimalStrSrv(fd.productionStatus)) {
      return "❌ الحالة الإنتاجية مطلوبة.";
    }

    if (!addAnimalStrSrv(fd.reproductiveStatus)) {
      return "❌ الحالة التناسلية مطلوبة.";
    }

    if (addAnimalStrSrv(fd.productionStatus) === "حلاب" && !addAnimalStrSrv(fd.dailyMilk)) {
      return "❌ إنتاج اللبن اليومي مطلوب للحيوان الحلاب.";
    }

    const repro = addAnimalStrSrv(fd.reproductiveStatus);
    const services = addAnimalNumSrv(fd.servicesCount, 0);

    if (
      (repro === "ملقحة" || repro === "ملقح" || repro === "عشار" || services > 0) &&
      !addAnimalStrSrv(fd.lastInseminationDate)
    ) {
      return "❌ تاريخ آخر تلقيح مطلوب للحيوان العشار أو الملقح أو الذي له تلقيح سابق في الموسم.";
    }

    return null;
  }

  if (mode === "followers") {
    if (!addAnimalStrSrv(fd.birthDate)) {
      return "❌ تاريخ الميلاد مطلوب للتابع.";
    }

    if (!addAnimalStrSrv(fd.followerSex)) {
      return "❌ جنس التابع مطلوب.";
    }

    if (!addAnimalStrSrv(fd.followerStatus)) {
      return "❌ الحالة الحالية للتابع مطلوبة.";
    }

    if (!addAnimalStrSrv(fd.damNumber)) {
      return "❌ رقم الأم مطلوب.";
    }

    if (addAnimalStrSrv(fd.followerStatus) === "فطام" && !addAnimalStrSrv(fd.weaningDate)) {
      return "❌ تاريخ الفطام مطلوب.";
    }

    const st = addAnimalStrSrv(fd.followerStatus);

    if ((st === "ملقح" || st === "عشار") && !addAnimalStrSrv(fd.followerLastInseminationDate)) {
      return "❌ تاريخ آخر تلقيح مطلوب.";
    }

    return null;
  }

  return "❌ نوع الإدخال غير معروف.";
}

async function addAnimalDuplicateCheckSrv(uid, numberStr) {
  if (!db || !uid || !numberStr) {
    return {
      ok: false,
      message: "⚠️ تعذّر التحقق من رقم الحيوان الآن."
    };
  }

  const key = `${uid}#${numberStr}`;
  const nNum = Number(numberStr);
  const collectionsToCheck = ["animals", "calves"];

  for (const colName of collectionsToCheck) {
    const q1 = await db.collection(colName)
      .where("userId_number", "==", key)
      .limit(1)
      .get();

    if (!q1.empty) {
      return {
        ok: false,
        duplicate: true,
        collection: colName,
        message: `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${numberStr} في حسابك.`
      };
    }

    const q2 = await db.collection(colName)
      .where("userId", "==", uid)
      .where("number", "==", numberStr)
      .limit(1)
      .get();

    if (!q2.empty) {
      return {
        ok: false,
        duplicate: true,
        collection: colName,
        message: `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${numberStr} في حسابك.`
      };
    }

    if (Number.isFinite(nNum)) {
      const q3 = await db.collection(colName)
        .where("userId", "==", uid)
        .where("animalNumber", "==", nNum)
        .limit(1)
        .get();

      if (!q3.empty) {
        return {
          ok: false,
          duplicate: true,
          collection: colName,
          message: `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${numberStr} في حسابك.`
        };
      }
    }
  }

  return { ok: true };
}
app.get("/api/add-animal/check-number", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const numberStr = addAnimalDigitsSrv(
      req.query.number ||
      req.query.animalNumber ||
      req.query.calfNumber ||
      ""
    );

    if (!numberStr) {
      return res.status(400).json({
        ok: false,
        error: "animal_number_required",
        available: false,
        message: "رقم الحيوان مطلوب."
      });
    }

    const duplicate = await addAnimalDuplicateCheckSrv(uid, numberStr);

    if (!duplicate.ok && duplicate.duplicate) {
      return res.json({
        ok: true,
        available: false,
        duplicate: true,
        animalNumber: numberStr,
        collection: duplicate.collection || null,
        message: duplicate.message || `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${numberStr} في حسابك.`
      });
    }

    if (!duplicate.ok) {
      return res.status(503).json({
        ok: false,
        available: false,
        error: "duplicate_check_failed",
        animalNumber: numberStr,
        message: duplicate.message || "تعذّر التحقق من رقم الحيوان الآن."
      });
    }

    return res.json({
      ok: true,
      available: true,
      duplicate: false,
      animalNumber: numberStr,
      message: `✅ الرقم ${numberStr} متاح للتسجيل.`
    });

  } catch (e) {
    console.error("add-animal-check-number failed", e);

    return res.status(500).json({
      ok: false,
      available: false,
      error: "add_animal_check_number_failed",
      message: "تعذّر التحقق من رقم الحيوان الآن."
    });
  }
});
function addAnimalBuildSinglePayloadSrv(uid, fd = {}) {
  const entryType = addAnimalStrSrv(fd.entryType || "mothers");
  const numberStr = addAnimalDigitsSrv(fd.animalNumber || fd.number || fd.calfNumber);
  const speciesInfo = addAnimalSpeciesFromTypeSrv(fd.animalType || fd.animalTypeAr);
  const key = `${uid}#${numberStr}`;
  const today = addAnimalTodaySrv();

  if (entryType === "followers") {
    const followerStatus = addAnimalStrSrv(fd.followerStatus);
    const followerLastAI = addAnimalDateOrNullSrv(fd.followerLastInseminationDate);
    const isInseminatedFollower = followerStatus === "ملقح" || followerStatus === "عشار";

    const followerPregDays =
      followerStatus === "عشار" && followerLastAI
        ? addAnimalDiffDaysSrv(followerLastAI, today)
        : addAnimalNumSrv(fd.followerPregnancyDays, 0);

    return {
      collectionName: "calves",
      payload: {
        ownerUid: uid,
        userId: uid,
        userId_number: key,
        entryType: "followers",

        calfNumber: numberStr,
        number: numberStr,
        animalNumber: Number(numberStr),

        species: speciesInfo.species,
        animaltype: speciesInfo.animaltype,
        animalTypeAr: speciesInfo.animalTypeAr,
        breed: addAnimalStrSrv(fd.breed),

        sex: addAnimalStrSrv(fd.followerSex),
        status: followerStatus,
        followerStatus,

        birthDate: addAnimalDateOrNullSrv(fd.birthDate),
        damNumber: addAnimalStrSrv(fd.damNumber) || null,

        weaningDate: followerStatus === "فطام"
          ? addAnimalDateOrNullSrv(fd.weaningDate)
          : null,

        lastInseminationDate: isInseminatedFollower
          ? followerLastAI
          : null,

        servicesCount: isInseminatedFollower
          ? addAnimalNumSrv(fd.followerServicesCount, 0)
          : 0,

        sireNumber: isInseminatedFollower
          ? (addAnimalStrSrv(fd.followerSireNumber) || null)
          : null,

        pregnancyDays: followerStatus === "عشار"
          ? (Number.isFinite(Number(followerPregDays)) ? Number(followerPregDays) : null)
          : null,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "server:/api/add-animal/save"
      }
    };
  }

  const productionStatus = addAnimalStrSrv(fd.productionStatus);
  const reproductiveStatus = addAnimalStrSrv(fd.reproductiveStatus);
  const lastCalvingDate = addAnimalDateOrNullSrv(fd.lastCalvingDate);
  const lastAI = addAnimalDateOrNullSrv(fd.lastInseminationDate);
  const servicesCount = addAnimalNumSrv(fd.servicesCount, 0);

 const hasMotherInseminationHistory =
  reproductiveStatus === "ملقحة" ||
  reproductiveStatus === "ملقح" ||
  reproductiveStatus === "عشار" ||
  servicesCount > 0;

const daysInMilk =
  productionStatus === "جاف"
    ? null
    : lastCalvingDate
      ? addAnimalDiffDaysSrv(lastCalvingDate, today)
      : null;

const pregnancyDays =
  reproductiveStatus === "عشار" && lastAI
    ? addAnimalDiffDaysSrv(lastAI, today)
    : addAnimalNumSrv(fd.pregnancyDays, 0);
  return {
    collectionName: "animals",
    payload: {
      ownerUid: uid,
      userId: uid,
      userId_number: key,
      entryType: "mothers",

      number: numberStr,
      animalNumber: Number(numberStr),

      animaltype: speciesInfo.animaltype,
      animalTypeAr: speciesInfo.animalTypeAr,
      species: speciesInfo.species,
      breed: addAnimalStrSrv(fd.breed),

      productionStatus,
      dailyMilk: productionStatus === "حلاب"
        ? Number(addAnimalNumSrv(fd.dailyMilk, 0))
        : null,

      reproductiveStatus,
      servicesCount,
      lactationNumber: addAnimalNumSrv(fd.lactationNumber, 0),

      birthDate: addAnimalDateOrNullSrv(fd.birthDate),
      lastCalvingDate,
      lastInseminationDate: hasMotherInseminationHistory ? lastAI : null,
      sireNumber: hasMotherInseminationHistory ? (addAnimalStrSrv(fd.sireNumber) || null) : null,

      daysInMilk: Number.isFinite(Number(daysInMilk)) ? Number(daysInMilk) : null,
      pregnancyDays: reproductiveStatus === "عشار"
        ? (Number.isFinite(Number(pregnancyDays)) ? Number(pregnancyDays) : null)
        : null,

      status: "active",

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "server:/api/add-animal/save"
    }
  };
}

app.post("/api/add-animal/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const fd = body.formData && typeof body.formData === "object"
      ? body.formData
      : body;

    const numberStr = addAnimalDigitsSrv(fd.animalNumber || fd.number || fd.calfNumber);

    const fieldErrors = addAnimalBasicFieldsDecisionSrv(fd);

    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({
        ok: false,
        error: "add_animal_fields_invalid",
        message: "راجع بيانات الحيوان المطلوبة.",
        fieldErrors
      });
    }

    const guardMessage = addAnimalDecisionSrv(fd);

    if (guardMessage) {
      return res.status(400).json({
        ok: false,
        error: "add_animal_decision_failed",
        message: guardMessage
      });
    }

    const duplicate = await addAnimalDuplicateCheckSrv(uid, numberStr);

    if (!duplicate.ok) {
      return res.status(duplicate.duplicate ? 409 : 503).json({
        ok: false,
        error: duplicate.duplicate ? "duplicate_animal_number" : "duplicate_check_failed",
        message: duplicate.message,
        collection: duplicate.collection || null
      });
    }

    const { collectionName, payload } = addAnimalBuildSinglePayloadSrv(uid, fd);

    const ref = await db.collection(collectionName).add(payload);

    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "add_animal_save");
    }

    return res.json({
      ok: true,
      message: "✅ تم تسجيل الحيوان بنجاح",
      animalId: ref.id,
      animalNumber: numberStr,
      number: numberStr,
      entryType: payload.entryType,
      collection: collectionName,
      redirectUrl: `add-event.html?number=${encodeURIComponent(numberStr)}&date=${encodeURIComponent(addAnimalTodaySrv())}`
    });

  } catch (e) {
    console.error("add-animal-save failed", e);

    return res.status(500).json({
      ok: false,
      error: "add_animal_save_failed",
      message: "حدث خطأ أثناء تسجيل الحيوان."
    });
  }
});
app.post("/api/add-animal/preview", requireUserId, async (req, res) => {
  try {
    const body = req.body || {};
    const fd = body.formData && typeof body.formData === "object"
      ? body.formData
      : body;

    const today = addAnimalTodaySrv();

    const productionStatus = addAnimalStrSrv(fd.productionStatus);
    const reproductiveStatus = addAnimalStrSrv(fd.reproductiveStatus);
    const followerStatus = addAnimalStrSrv(fd.followerStatus);

    const lastCalvingDate = addAnimalDateOrNullSrv(fd.lastCalvingDate);
    const lastInseminationDate = addAnimalDateOrNullSrv(fd.lastInseminationDate);
    const followerLastInseminationDate = addAnimalDateOrNullSrv(fd.followerLastInseminationDate);

    const daysInMilk =
      productionStatus === "جاف"
        ? null
        : lastCalvingDate
          ? addAnimalDiffDaysSrv(lastCalvingDate, today)
          : null;

    const pregnancyDays =
      reproductiveStatus === "عشار" && lastInseminationDate
        ? addAnimalDiffDaysSrv(lastInseminationDate, today)
        : null;

    const followerPregnancyDays =
      followerStatus === "عشار" && followerLastInseminationDate
        ? addAnimalDiffDaysSrv(followerLastInseminationDate, today)
        : null;

    return res.json({
      ok: true,
      today,
      daysInMilk,
      pregnancyDays,
      followerPregnancyDays
    });

  } catch (e) {
    console.error("add-animal-preview failed", e);

    return res.status(500).json({
      ok: false,
      error: "add_animal_preview_failed",
      message: "تعذّر حساب المعاينة الآن."
    });
  }
});
// ============================================================
//                 API: ADD ANIMAL — SERVER SIDE IMPORT
//                 استيراد الحيوانات من السيرفر فقط
// ============================================================

function addAnimalImportRowsSrv(body = {}) {
  if (Array.isArray(body.rows)) return body.rows;
  if (Array.isArray(body.preview)) return body.preview;
  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.formData?.rows)) return body.formData.rows;
  return [];
}
function addAnimalImportDecodeBase64Srv(fileBase64 = "") {
  const raw = String(fileBase64 || "").trim();
  if (!raw) return Buffer.alloc(0);

  const clean = raw.includes(",")
    ? raw.split(",").pop()
    : raw;

  return Buffer.from(clean, "base64");
}

function addAnimalImportSplitCsvLineSrv(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur.trim());
  return out;
}

function addAnimalImportParseCsvTextSrv(text = "") {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const headers = addAnimalImportSplitCsvLineSrv(lines[0])
    .map(h => String(h || "").trim())
    .filter(Boolean);

  if (!headers.length) return [];

  return lines.slice(1).map(line => {
    const vals = addAnimalImportSplitCsvLineSrv(line);
    const row = {};

    headers.forEach((h, i) => {
      row[h] = vals[i] ?? "";
    });

    return row;
  }).filter(r => Object.keys(r).length > 0);
}

function addAnimalImportNormalizeSheetRowsSrv(rows = []) {
  return rows
    .map(r => {
      const clean = {};
      Object.keys(r || {}).forEach(k => {
        const key = String(k || "").trim();
        if (!key) return;
        clean[key] = r[k] == null ? "" : String(r[k]).trim();
      });
      return clean;
    })
    .filter(r => Object.keys(r).length > 0);
}

function addAnimalImportParseUploadedFileSrv(body = {}) {
  const fileName = String(body.fileName || body.filename || "").toLowerCase().trim();
  const fileBase64 = String(body.fileBase64 || body.base64 || "").trim();

  if (!fileBase64) return [];

  const buf = addAnimalImportDecodeBase64Srv(fileBase64);
  if (!buf.length) return [];

  if (fileName.endsWith(".csv") || fileName.endsWith(".txt")) {
    return addAnimalImportParseCsvTextSrv(buf.toString("utf8"));
  }

  if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
    const XLSX = require("xlsx");

    const wb = XLSX.read(buf, { type: "buffer" });
    const firstSheetName = wb.SheetNames?.[0];

    if (!firstSheetName) return [];

    const sheet = wb.Sheets[firstSheetName];
    if (!sheet) return [];

    const jsonRows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false
    });

    return addAnimalImportNormalizeSheetRowsSrv(jsonRows);
  }

  return [];
}

function addAnimalImportRowsFromBodySrv(body = {}) {
  const existing = addAnimalImportRowsSrv(body);
  if (existing.length) return existing;

  return addAnimalImportParseUploadedFileSrv(body);
}
function addAnimalImportKindSrv(body = {}) {
  const raw = addAnimalStrSrv(
    body.importKind ||
    body.kind ||
    body.entryType ||
    body.mode ||
    body.formData?.entryType ||
    "mothers"
  );

  return raw === "followers" ? "followers" : "mothers";
}

function addAnimalImportPickSrv(row = {}, keys = []) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
      return row[k];
    }
  }
  return "";
}
function addAnimalImportNormKeySrv(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_\-\/\\.#!:;()\[\]]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه");
}

function addAnimalImportPickAnySrv(row = {}, keys = []) {
  const wanted = keys.map(addAnimalImportNormKeySrv);

  for (const rawKey of Object.keys(row || {})) {
    const nk = addAnimalImportNormKeySrv(rawKey);
    if (!wanted.includes(nk)) continue;

    const val = row[rawKey];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return val;
    }
  }

  return "";
}

function addAnimalImportNormalizeAnimalTypeSrv(v) {
  const s = String(v || "").trim().toLowerCase();

  if (!s) return "بقرة";

  if (
    s.includes("buffalo") ||
    s.includes("buff") ||
    s.includes("جاموس")
  ) {
    return "جاموسة";
  }

  if (
    s.includes("cow") ||
    s.includes("cattle") ||
    s.includes("bovine") ||
    s.includes("بقر") ||
    s.includes("بقرة") ||
    s.includes("بقره")
  ) {
    return "بقرة";
  }

  return String(v || "").trim();
}

function addAnimalImportNormalizeProductionSrv(v, hint = {}) {
  const s = String(v || "").trim().toLowerCase();

  if (
    s === "dry" ||
    s.includes("dry") ||
    s.includes("جاف")
  ) {
    return "جاف";
  }

  if (
    s === "milking" ||
    s.includes("milk") ||
    s.includes("lact") ||
    s.includes("fresh") ||
    s.includes("حلاب") ||
    s.includes("لبن") ||
    s.includes("حليب") ||
    s.includes("حديث")
  ) {
    return "حلاب";
  }

  if (addAnimalStrSrv(hint.dailyMilk)) return "حلاب";

  return String(v || "").trim();
}

function addAnimalImportNormalizeReproSrv(v) {
  const s0 = String(v || "").trim();
  const s = s0.toLowerCase().replace(/\s+/g, "");

  if (!s) return "";

  if (
    s === "bred" ||
    s.includes("bred") ||
    s.includes("inseminated") ||
    s.includes("insemination") ||
    s.includes("served") ||
    s.includes("service") ||
    s === "ai" ||
    s.includes("ملقح") ||
    s.includes("ملقحة")
  ) {
    return "ملقحة";
  }

  if (
    s.includes("preg") ||
    s.includes("confirmedpreg") ||
    s.includes("pregnant") ||
    s.includes("حامل") ||
    s.includes("عشار")
  ) {
    return "عشار";
  }

  if (
    s.includes("open") ||
    s.includes("empty") ||
    s.includes("notpreg") ||
    s.includes("مفتوح") ||
    s.includes("مفتوحة")
  ) {
    return "مفتوحة";
  }

  if (
    s.includes("fresh") ||
    s.includes("postpartum") ||
    s.includes("حديث")
  ) {
    return "حديث الولادة";
  }

  if (
    s.includes("abort") ||
    s.includes("abortion") ||
    s.includes("اجهاض") ||
    s.includes("إجهاض")
  ) {
    return "إجهاض";
  }

  return s0;
}

function addAnimalImportNormalizeSexSrv(v) {
  const s = String(v || "").trim().toLowerCase();

  if (!s) return "";

  if (
    s === "f" ||
    s.includes("female") ||
    s.includes("heifer") ||
    s.includes("انثى") ||
    s.includes("أنثى")
  ) {
    return "أنثى";
  }

  if (
    s === "m" ||
    s.includes("male") ||
    s.includes("bull") ||
    s.includes("ذكر")
  ) {
    return "ذكر";
  }

  return String(v || "").trim();
}

function addAnimalImportNormalizeFollowerStatusSrv(v) {
  const s0 = String(v || "").trim();
  const s = s0.toLowerCase().replace(/\s+/g, "");

  if (!s) return "";

  if (s.includes("calf") || s.includes("suck") || s.includes("رضيع")) return "رضيع";
  if (s.includes("wean") || s.includes("فطام")) return "فطام";
  if (s.includes("grow") || s.includes("growing") || s.includes("نامي")) return "نامي";
  if (s.includes("ready") || s.includes("breedable") || s.includes("تحت")) return "تحت التلقيح";
  if (s.includes("bred") || s.includes("inseminated") || s.includes("ملقح")) return "ملقح";
  if (s.includes("preg") || s.includes("عشار") || s.includes("حامل")) return "عشار";

  return s0;
}
function addAnimalImportNormalizeDateSrv(v) {
  if (v === null || v === undefined || v === "") return "";

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }

  const s = String(v || "").trim();
  if (!s) return "";

  // already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  // Excel serial date, e.g. 43929
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const ms = Math.round((n - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  // dd/mm/yyyy or mm/dd/yyyy — نتركها محافظة كـ month/day عند ملفات DairyComp الإنجليزية
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let mm = Number(m[1]);
    let dd = Number(m[2]);
    let yy = Number(m[3]);

    if (yy < 100) yy += yy >= 70 ? 1900 : 2000;

    return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  return s;
}

function addAnimalImportPickDateSrv(row = {}, keys = []) {
  return addAnimalImportNormalizeDateSrv(
    addAnimalImportPickAnySrv(row, keys)
  );
}
function addAnimalImportFdSrv(row = {}, importKind = "mothers") {
  const number = addAnimalImportPickAnySrv(row, [
    "animalNumber",
    "number",

    // DairyComp / VAS
    "ID",
    "COW",
    "COWID",
    "COWNO",
    "COW#",
    "ANIMALID",

    // common herd files
    "earTag",
    "eartag",
    "tag",
    "tagNo",
    "tagNumber",

    // Arabic
    "رقم الحيوان",
    "رقم",
    "رقم البقرة",
    "رقم الاذن",
    "رقم الأذن"
  ]);

  const animalTypeRaw = addAnimalImportPickAnySrv(row, [
    "animalType",
    "animalTypeAr",
    "TYPE",
    "species",
    "kind",
    "نوع الحيوان",
    "النوع",
    "الفصيلة"
  ]);

  const breed = addAnimalImportPickAnySrv(row, [
    "breed",
    "BREED",
    "brd",
    "race",
    "strain",
    "سلالة",
    "السلالة"
  ]);

  if (importKind === "followers") {
    const followerStatusRaw = addAnimalImportPickAnySrv(row, [
      "followerStatus",
      "STATUS",
      "status",
      "heiferStatus",
      "calfStatus",
      "الحالة",
      "الحالة الحالية",
      "حالة التابع"
    ]);

    return {
      entryType: "followers",
      animalNumber: number,
      animalType: addAnimalImportNormalizeAnimalTypeSrv(animalTypeRaw),
      animalTypeAr: addAnimalImportNormalizeAnimalTypeSrv(animalTypeRaw),
      breed,

     birthDate: addAnimalImportPickDateSrv(row, [
        "birthDate",
        "BIRTH",
        "birth",
        "DOB",
        "dateOfBirth",
        "born",
        "تاريخ الميلاد",
        "ميلاد"
      ]),

      followerSex: addAnimalImportNormalizeSexSrv(addAnimalImportPickAnySrv(row, [
        "followerSex",
        "SEX",
        "sex",
        "gender",
        "الجنس",
        "نوع الجنس"
      ])),

      followerStatus: addAnimalImportNormalizeFollowerStatusSrv(followerStatusRaw),

      damNumber: addAnimalImportPickAnySrv(row, [
        "damNumber",
        "DAM",
        "dam",
        "damId",
        "mother",
        "motherNumber",
        "رقم الأم",
        "رقم الام",
        "الأم",
        "الام"
      ]),

     weaningDate: addAnimalImportPickDateSrv(row, [
        "weaningDate",
        "WEANDATE",
        "weanDate",
        "weanedDate",
        "تاريخ الفطام",
        "فطام"
      ]),

     followerLastInseminationDate: addAnimalImportPickDateSrv(row, [
        "followerLastInseminationDate",
        "lastInseminationDate",
        "LASTBRED",
        "BRED",
        "bredDate",
        "lastBred",
        "lastService",
        "serviceDate",
        "AIDATE",
        "aiDate",
        "lastAI",
        "inseminationDate",
        "تاريخ آخر تلقيح",
        "تاريخ اخر تلقيح",
        "آخر تلقيح",
        "اخر تلقيح"
      ]),

      followerServicesCount: addAnimalImportPickAnySrv(row, [
        "followerServicesCount",
        "SERVICES",
        "servicesCount",
        "services",
        "breedings",
        "timesBred",
        "عدد التلقيحات",
        "عدد مرات التلقيح",
        "مرات التلقيح"
      ]),

      followerSireNumber: addAnimalImportPickAnySrv(row, [
        "followerSireNumber",
        "sireNumber",
        "SIRE",
        "sire",
        "sireId",
        "BULL",
        "bull",
        "bullId",
        "bullCode",
        "SEMEN",
        "semen",
        "semenCode",
        "straw",
        "رقم الطلوقة",
        "كود السائل",
        "الطلوقة"
      ])
    };
  }

  const dailyMilk = addAnimalImportPickAnySrv(row, [
    "dailyMilk",
    "MILK",
    "milk",
    "milkKg",
    "milkL",
    "milkYield",
    "currentMilk",
    "lastMilk",
    "testMilk",
    "kgMilk",
    "إنتاج اللبن",
    "انتاج اللبن",
    "إنتاج اللبن اليومي",
    "لبن",
    "حليب"
  ]);

  const productionRaw = addAnimalImportPickAnySrv(row, [
    "productionStatus",
    "LACT_STATUS",
    "milkStatus",
    "lactStatus",
    "lactationStatus",
    "prodStatus",
    "الحالة الإنتاجية",
    "الحالة الانتاجية"
  ]);

  const reproRaw = addAnimalImportPickAnySrv(row, [
    "reproductiveStatus",
    "RPRO",
    "REPRO",
    "reproStatus",
    "breedStatus",
    "bredStatus",
    "pregStatus",
    "remarks",
    "remark",
    "الحالة التناسلية",
    "الحاله التناسليه"
  ]);

  return {
    entryType: "mothers",
    animalNumber: number,
    animalType: addAnimalImportNormalizeAnimalTypeSrv(animalTypeRaw),
    animalTypeAr: addAnimalImportNormalizeAnimalTypeSrv(animalTypeRaw),
    breed,

  birthDate: addAnimalImportPickDateSrv(row, [
      "birthDate",
      "BIRTH",
      "birth",
      "DOB",
      "dateOfBirth",
      "born",
      "تاريخ الميلاد",
      "ميلاد"
    ]),

    productionStatus: addAnimalImportNormalizeProductionSrv(productionRaw, { dailyMilk }),

    dailyMilk,

    reproductiveStatus: addAnimalImportNormalizeReproSrv(reproRaw),

    servicesCount: addAnimalImportPickAnySrv(row, [
      "servicesCount",
      "SERVICES",
      "services",
      "breedings",
      "breedingCount",
      "timesBred",
      "noServices",
      "serviceNo",
      "servNo",
      "عدد التلقيحات",
      "عدد مرات التلقيح",
      "مرات التلقيح"
    ]),

    lactationNumber: addAnimalImportPickAnySrv(row, [
      "lactationNumber",
      "LACT",
      "LAC",
      "lactNo",
      "parity",
      "lactation",
      "رقم الموسم",
      "موسم الحليب",
      "الموسم"
    ]),

   lastCalvingDate: addAnimalImportPickDateSrv(row, [
      "lastCalvingDate",
      "FRESH",
      "fresh",
      "freshDate",
      "lastFresh",
      "lastCalv",
      "calvingDate",
      "calvDate",
      "تاريخ آخر ولادة",
      "تاريخ اخر ولادة",
      "آخر ولادة",
      "اخر ولادة"
    ]),

   lastInseminationDate: addAnimalImportPickDateSrv(row, [
      "lastInseminationDate",
      "BRED",
      "bred",
      "LASTBRED",
      "lastBred",
      "bredDate",
      "lastService",
      "serviceDate",
      "AIDATE",
      "aiDate",
      "lastAI",
      "inseminationDate",
      "تاريخ آخر تلقيح",
      "تاريخ اخر تلقيح",
      "آخر تلقيح",
      "اخر تلقيح"
    ]),

    sireNumber: addAnimalImportPickAnySrv(row, [
      "sireNumber",
      "SIRE",
      "sire",
      "sireId",
      "BULL",
      "bull",
      "bullId",
      "bullCode",
      "SEMEN",
      "semen",
      "semenCode",
      "straw",
      "رقم الطلوقة",
      "كود السائل",
      "الطلوقة"
    ])
  };
}
app.post("/api/add-animal/import-preview", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "قاعدة البيانات غير متاحة الآن.",
        rows: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const importKind = addAnimalImportKindSrv(body);
    const rows = addAnimalImportRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: "import_rows_required",
        message: "لا توجد صفوف صالحة للمعاينة.",
        importKind,
        rows: []
      });
    }

    const seenInFile = new Set();
    const previewRows = [];

    let readyCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      const row = rows[i] || {};
      const fd = addAnimalImportFdSrv(row, importKind);
      const numberStr = addAnimalDigitsSrv(fd.animalNumber || fd.number || fd.calfNumber);

      const item = {
        row: rowNumber,
        animalNumber: numberStr,
        importKind,
        status: "ready",
        ok: true,
        reason: null,
        message: "جاهز للحفظ.",
        data: fd
      };

      if (!numberStr) {
        item.status = "rejected";
        item.ok = false;
        item.reason = "animal_number_required";
        item.message = `السطر ${rowNumber}: رقم الحيوان مطلوب.`;
        previewRows.push(item);
        rejectedCount++;
        continue;
      }

      if (seenInFile.has(numberStr)) {
        item.status = "rejected";
        item.ok = false;
        item.reason = "duplicate_in_file";
        item.message = `السطر ${rowNumber}: الرقم ${numberStr} مكرر داخل ملف الاستيراد.`;
        previewRows.push(item);
        rejectedCount++;
        continue;
      }

      seenInFile.add(numberStr);

      const fieldErrors = addAnimalBasicFieldsDecisionSrv(fd);

      if (Object.keys(fieldErrors).length) {
        item.status = "rejected";
        item.ok = false;
        item.reason = "fields_invalid";
        item.message = `السطر ${rowNumber}: راجع بيانات الحيوان المطلوبة.`;
        item.fieldErrors = fieldErrors;
        previewRows.push(item);
        rejectedCount++;
        continue;
      }

      const guardMessage = addAnimalDecisionSrv(fd);

      if (guardMessage) {
        item.status = "rejected";
        item.ok = false;
        item.reason = "decision_failed";
        item.message = `السطر ${rowNumber}: ${guardMessage}`;
        previewRows.push(item);
        rejectedCount++;
        continue;
      }

      const duplicate = await addAnimalDuplicateCheckSrv(uid, numberStr);

      if (!duplicate.ok) {
        item.status = "rejected";
        item.ok = false;
        item.reason = duplicate.duplicate ? "duplicate_animal_number" : "duplicate_check_failed";
        item.collection = duplicate.collection || null;
        item.message = `السطر ${rowNumber}: ${duplicate.message}`;
        previewRows.push(item);
        rejectedCount++;
        continue;
      }

      previewRows.push(item);
      readyCount++;
    }

    return res.json({
      ok: true,
      importKind,
      totalCount: rows.length,
      readyCount,
      rejectedCount,
      partial: readyCount > 0 && rejectedCount > 0,
      message: `تمت معاينة ${rows.length} سجل: ${readyCount} جاهز، ${rejectedCount} مرفوض.`,
      rows: previewRows
    });

  } catch (e) {
    console.error("add-animal-import-preview failed", e);

    return res.status(500).json({
      ok: false,
      error: "add_animal_import_preview_failed",
      message: "حدث خطأ أثناء معاينة ملف الاستيراد.",
      rows: []
    });
  }
});
app.post("/api/add-animal/import", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "قاعدة البيانات غير متاحة الآن.",
        saved: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const importKind = addAnimalImportKindSrv(body);
   const rows = addAnimalImportRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: "import_rows_required",
        message: "لا توجد صفوف صالحة للاستيراد.",
        saved: [],
        rejected: []
      });
    }

    const saved = [];
    const rejected = [];
    const seenInFile = new Set();

    let batch = db.batch();
    let ops = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      const row = rows[i] || {};
      const fd = addAnimalImportFdSrv(row, importKind);
      const numberStr = addAnimalDigitsSrv(fd.animalNumber || fd.number || fd.calfNumber);

      if (!numberStr) {
        rejected.push({
          row: rowNumber,
          animalNumber: "",
          reason: "animal_number_required",
          message: `السطر ${rowNumber}: رقم الحيوان مطلوب.`
        });
        continue;
      }

      if (seenInFile.has(numberStr)) {
        rejected.push({
          row: rowNumber,
          animalNumber: numberStr,
          reason: "duplicate_in_file",
          message: `السطر ${rowNumber}: الرقم ${numberStr} مكرر داخل ملف الاستيراد.`
        });
        continue;
      }

      seenInFile.add(numberStr);

      const fieldErrors = addAnimalBasicFieldsDecisionSrv(fd);

      if (Object.keys(fieldErrors).length) {
        rejected.push({
          row: rowNumber,
          animalNumber: numberStr,
          reason: "fields_invalid",
          message: `السطر ${rowNumber}: راجع بيانات الحيوان المطلوبة.`,
          fieldErrors
        });
        continue;
      }

      const guardMessage = addAnimalDecisionSrv(fd);

      if (guardMessage) {
        rejected.push({
          row: rowNumber,
          animalNumber: numberStr,
          reason: "decision_failed",
          message: `السطر ${rowNumber}: ${guardMessage}`
        });
        continue;
      }

      const duplicate = await addAnimalDuplicateCheckSrv(uid, numberStr);

      if (!duplicate.ok) {
        rejected.push({
          row: rowNumber,
          animalNumber: numberStr,
          reason: duplicate.duplicate ? "duplicate_animal_number" : "duplicate_check_failed",
          collection: duplicate.collection || null,
          message: `السطر ${rowNumber}: ${duplicate.message}`
        });
        continue;
      }

      const { collectionName, payload } = addAnimalBuildSinglePayloadSrv(uid, fd);
      const ref = db.collection(collectionName).doc();

      batch.set(ref, payload);
      ops++;

      saved.push({
        row: rowNumber,
        animalNumber: numberStr,
        animalId: ref.id,
        collection: collectionName,
        message: `تم تجهيز الحيوان رقم ${numberStr} للحفظ.`
      });

      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "add_animal_import");
    }

    return res.status(saved.length ? 200 : 400).json({
      ok: saved.length > 0,
      partial: saved.length > 0 && rejected.length > 0,
      message: saved.length
        ? `✅ تم استيراد ${saved.length} حيوان بنجاح.`
        : "لم يتم استيراد أي حيوان.",
      importKind,
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected
    });

  } catch (e) {
    console.error("add-animal-import failed", e);

    return res.status(500).json({
      ok: false,
      error: "add_animal_import_failed",
      message: "حدث خطأ أثناء استيراد الحيوانات.",
      saved: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: HERD IMPORT V2 — SOURCE PREVIEW ONLY
//                 اكتشاف مصدر ملف القطيع فقط — لا حفظ نهائيًا
// ============================================================

const HERD_IMPORT_V2_SOURCE_SIGNATURES = {
  dairycomp: {
    name: "DairyComp / DC305 / VAS style",
    requiredGroups: [
      "animalNumber",
      "lastCalvingDate",
      "daysInMilk",
      "dailyMilk",
      "reproductiveStatus",
      "lastInseminationDate"
    ],
    groups: {
      animalNumber: ["COW", "COWID", "COWNO", "COW#", "ID", "ANIMALID"],
      animalType: ["TYPE", "CLASS", "SPECIES"],
      breed: ["BREED", "BRD"],
      birthDate: ["BDAT", "BIRTH", "DOB", "BIRTHDATE"],
      lactationNumber: ["LACT", "LAC", "PARITY"],

      lastCalvingDate: ["FRESH", "LASTFRESH", "FRESHDATE", "CALV", "CALVDATE", "LASTCALV"],
      daysInMilk: ["DIM"],
      dailyMilk: ["MILK", "TESTMILK", "LASTMILK", "KG", "KGMILK", "LBS", "LBSMILK"],

      reproductiveStatus: ["RPRO", "REPRO", "REPROSTATUS", "BREEDSTATUS", "PREGSTATUS"],
      lastInseminationDate: ["BRED", "LASTBRED", "BREDATE", "BREDDATE", "SERVDATE", "SERVICE_DATE", "AIDATE"],
      servicesCount: ["SERV", "SERVS", "SERVICES", "BREEDINGS", "TIMESBRED"],
      sireNumber: ["SIRE", "BULL", "SEMEN", "SIREID", "BULLID", "STRAW"],
      timeBred: ["TIMEBRED", "BREDTIME", "SERVTIME", "AITIME"],

      pregDays: ["DCC", "PREGDAYS", "DAYSPREG"],
      pdDate: ["PDDATE", "PD_DATE", "PREGCHECKDATE", "CHECKDATE", "VETCHECKDATE"],
      pdResult: ["PREG", "PD", "PDRESULT", "PREGRESULT", "PREG_STATUS"],
      dryOffDate: ["DRY", "DRYDATE", "DRYOFF", "DRYOFFDATE"],
      heatDate: ["HEAT", "HEATDATE", "LASTHEAT"],
      heatDates: ["HEATS", "HEATDATES"],
      group: ["GROUP", "STRING", "HERD"],
      pen: ["PEN", "LOT"],
      animalStatus: ["STATUS", "COWSTATUS"]
    }
  },

  delpro: {
    name: "DeLaval DelPro style",
    requiredGroups: [
      "animalNumber",
      "lastCalvingDate",
      "daysInMilk",
      "dailyMilk",
      "lastInseminationDate"
    ],
    groups: {
      animalNumber: ["Animal ID", "Animal Number", "Cow No.", "Cow Number", "Ear tag", "Tag"],
      breed: ["Breed", "Animal breed"],
      birthDate: ["Date of birth", "Birth date", "DOB"],
      lactationNumber: ["Lactation", "Lactation No.", "Lactation number", "Parity"],
      lastCalvingDate: ["Last calving", "Calving date", "Last calving date"],
      daysInMilk: ["Days in milk", "DIM"],
      dailyMilk: ["Milk yield", "Daily milk", "Last milk", "Milk kg", "Milk production"],
      lastInseminationDate: ["Last insemination", "Last breeding", "Insemination date", "Service date"],
      servicesCount: ["No. of inseminations", "Number of inseminations", "Services", "Service count"],
      sireNumber: ["Sire", "Bull", "Semen", "Semen code"],
      reproductiveStatus: ["Pregnancy status", "Reproduction status", "Repro status", "Breeding status"],
      pdDate: ["Pregnancy check date", "Vet check date", "Diagnosis date"],
      pdResult: ["Pregnancy result", "Pregnancy status", "Pregnancy check result"],
      pregDays: ["Days pregnant", "Pregnant days"],
      dryOffDate: ["Dry off date", "Dry-off date", "Dry date"],
      heatDate: ["Heat date", "Last heat", "Estrus date"],
      group: ["Group"],
      pen: ["Pen"]
    }
  },

  afimilk: {
    name: "Afimilk / AfiFarm style",
    requiredGroups: [
      "animalNumber",
      "lastCalvingDate",
      "daysInMilk",
      "dailyMilk",
      "lastInseminationDate"
    ],
    groups: {
      animalNumber: ["Cow", "Cow ID", "Animal ID", "Animal No", "Tag", "Tag No"],
      breed: ["Breed"],
      birthDate: ["Birth date", "Date of birth", "DOB"],
      lactationNumber: ["Lactation", "Lactation number", "Parity"],
      lastCalvingDate: ["Calving date", "Last calving", "Fresh date"],
      daysInMilk: ["DIM", "Days in milk"],
      dailyMilk: ["Milk", "Milk yield", "Daily yield", "Daily milk", "Last milk"],
      lastInseminationDate: ["Insemination", "Insemination date", "AI date", "Breeding date"],
      servicesCount: ["Inseminations", "Services", "Service count"],
      sireNumber: ["Bull", "Sire", "Semen", "Semen code"],
      reproductiveStatus: ["Pregnancy", "Preg status", "Repro status", "Breeding status"],
      pdDate: ["Preg check", "Preg check date", "Diagnosis date"],
      pdResult: ["Preg result", "Pregnancy result", "Pregnancy"],
      pregDays: ["Days pregnant", "Pregnant days"],
      heatDate: ["Heat", "Heat date", "Activity date", "Estrus date"],
      dryOffDate: ["Dry off", "Dry off date", "Dry date"],
      group: ["Group"],
      pen: ["Pen"]
    }
  },

  uniform_agri: {
    name: "Uniform-Agri style",
    requiredGroups: [
      "animalNumber",
      "lastCalvingDate",
      "daysInMilk",
      "dailyMilk",
      "lastInseminationDate"
    ],
    groups: {
      animalNumber: ["Animal number", "Animal no", "Ear tag", "Life number", "Cow number", "Tag"],
      breed: ["Breed"],
      birthDate: ["Birth date", "Date of birth", "DOB"],
      lactationNumber: ["Lactation number", "Lactation", "Parity"],
      lastCalvingDate: ["Calving date", "Last calving", "Last calving date"],
      daysInMilk: ["Days in milk", "DIM"],
      dailyMilk: ["Milk kg", "Milk production", "Daily milk", "Milk yield"],
      lastInseminationDate: ["Insemination date", "Service date", "Breeding date", "Last insemination"],
      servicesCount: ["Number of inseminations", "Inseminations", "Services", "Service count"],
      sireNumber: ["Sire", "Bull", "Semen"],
      reproductiveStatus: ["Pregnancy status", "Reproduction status", "Breeding status"],
      pdDate: ["Pregnancy diagnosis date", "Pregnancy check date", "Diagnosis date"],
      pdResult: ["Pregnancy diagnosis", "Pregnancy result", "Pregnancy status"],
      pregDays: ["Pregnant days", "Days pregnant"],
      dryOffDate: ["Dry off date", "Dry date"],
      heatDate: ["Heat date", "Estrus date"],
      group: ["Group"],
      pen: ["Pen"]
    }
  },

  arabic_excel: {
    name: "Arabic Excel / manual farm sheet",
    requiredGroups: [
      "animalNumber",
      "lastCalvingDate",
      "daysInMilk",
      "dailyMilk",
      "reproductiveStatus",
      "lastInseminationDate"
    ],
    groups: {
      animalNumber: ["رقم الحيوان", "رقم", "رقم البقرة", "رقم الجاموسة", "رقم الأذن", "رقم الاذن"],
      animalType: ["نوع الحيوان", "النوع", "الفصيلة"],
      breed: ["السلالة", "سلالة"],
      birthDate: ["تاريخ الميلاد", "ميلاد"],
      lactationNumber: ["رقم الموسم", "الموسم", "موسم الحليب"],
      productionStatus: ["الحالة الإنتاجية", "الحالة الانتاجية", "حالة الإنتاج", "حالة الانتاج"],
      reproductiveStatus: ["الحالة التناسلية", "الحاله التناسليه", "حالة الحمل"],
      lastCalvingDate: ["تاريخ آخر ولادة", "تاريخ اخر ولادة", "آخر ولادة", "اخر ولادة"],
      daysInMilk: ["أيام الحليب", "ايام الحليب", "أيام اللبن", "ايام اللبن", "DIM"],
      dailyMilk: ["إنتاج اللبن", "انتاج اللبن", "إنتاج اللبن اليومي", "لبن", "حليب"],
      lastInseminationDate: ["تاريخ آخر تلقيح", "تاريخ اخر تلقيح", "آخر تلقيح", "اخر تلقيح"],
      servicesCount: ["عدد التلقيحات", "عدد مرات التلقيح", "مرات التلقيح"],
      sireNumber: ["الطلوقة", "رقم الطلوقة", "كود السائل", "كود السائل المنوي"],
      timeBred: ["وقت التلقيح", "توقيت التلقيح", "فترة التلقيح"],
      heatDate: ["تاريخ الشياع", "تاريخ الشبق", "آخر شياع", "اخر شياع"],
      heatDates: ["تواريخ الشياع", "تواريخ الشبق"],
      pdDate: ["تاريخ تشخيص الحمل", "تاريخ فحص الحمل", "تاريخ السونار", "تاريخ الجس"],
      pdResult: ["نتيجة تشخيص الحمل", "نتيجة الحمل", "نتيجة الفحص"],
      pregDays: ["أيام الحمل", "ايام الحمل"],
      dryOffDate: ["تاريخ التجفيف", "تاريخ الجفاف", "جفاف"],
      group: ["المجموعة", "الجروب"],
      pen: ["الحظيرة", "العنبر"]
    }
  }
};
// ============================================================
// HERD IMPORT V2 - operational dictionary patch only
// قاموس تشغيلي فقط: لا نخزن إلا ما يستخدمه مُرَبِّيك
// ============================================================

function herdImportV2MergeProfilePatchSrv(profileKey, patch = {}) {
  const profile = HERD_IMPORT_V2_SOURCE_SIGNATURES[profileKey] || {
    name: patch.name || profileKey,
    requiredGroups: [],
    groups: {}
  };

  profile.name = patch.name || profile.name || profileKey;

  profile.requiredGroups = [
    ...new Set([
      ...(profile.requiredGroups || []),
      ...(patch.requiredGroups || [])
    ])
  ];

  profile.groups = profile.groups || {};

  for (const [groupKey, aliases] of Object.entries(patch.groups || {})) {
    profile.groups[groupKey] = [
      ...new Set([
        ...(profile.groups[groupKey] || []),
        ...(aliases || [])
      ])
    ];
  }

  HERD_IMPORT_V2_SOURCE_SIGNATURES[profileKey] = profile;
}

(function herdImportV2ApplyOperationalDictionaryPatchSrv() {
  // DairyComp 305
  herdImportV2MergeProfilePatchSrv("dairycomp", {
    groups: {
      animalNumber: ["ID"],
      birthDate: ["BIRT"],
      lactationNumber: ["LACT"],
      sireNumber: ["SIRE"],
      reproductiveStatus: ["RC"],
      daysInMilk: ["DIM"],
      dailyMilk: ["MILK"],
      pregDays: ["DCC"],
      servicesCount: ["TIMES"],

      lastCalvingDate: ["FRESH"],
      lastInseminationDate: ["BRED"],
      dryOffDate: ["DRY"],
      heatDate: ["HEAT"],
      pdResult: ["PREG", "OPEN"]
    }
  });

  // AfiFarm
  herdImportV2MergeProfilePatchSrv("afimilk", {
    groups: {
      animalNumber: ["Cow ID"],
      birthDate: ["Birth Date"],
      lactationNumber: ["Lact"],
      sireNumber: ["Sire"],
      reproductiveStatus: ["Rep. Status"],
      daysInMilk: ["DIM"],
      dailyMilk: ["Daily Milk"],
      pregDays: ["Days Pregnant"],
      servicesCount: ["Ins. Number"],

      lastCalvingDate: ["Calv"],
      lastInseminationDate: ["Insem", "Ins"],
      dryOffDate: ["Dry Off"],
      heatDate: ["Heat"],
      pdResult: ["PD+", "PD-"]
    }
  });

  // DelPro / DeLaval
  herdImportV2MergeProfilePatchSrv("delpro", {
    groups: {
      animalNumber: ["Animal ID", "Animal No.", "Animal No"],
      birthDate: ["DOB"],
      lactationNumber: ["Lact. No", "Lact No"],
      sireNumber: ["Sire"],
      reproductiveStatus: ["Rep. State"],
      daysInMilk: ["DIM"],
      dailyMilk: ["Today Milk"],
      pregDays: ["Days Preg"],
      servicesCount: ["Inseminations"],

      lastCalvingDate: ["Calving"],
      lastInseminationDate: ["Bred", "Ins"],
      dryOffDate: ["Dry"],
      heatDate: ["Heat"],
      pdResult: ["Preg", "Non-Preg"]
    }
  });

  // DairyPlan / GEA
  herdImportV2MergeProfilePatchSrv("dairyplan_gea", {
    name: "DairyPlan / GEA style",
    requiredGroups: [
      "animalNumber",
      "lactationNumber",
      "reproductiveStatus",
      "daysInMilk",
      "dailyMilk"
    ],
    groups: {
      animalNumber: ["Animal ID", "Animal No.", "Animal No", "ID"],
      birthDate: ["DOB"],
      lactationNumber: ["Lact. No", "Lact No"],
      sireNumber: ["Sire"],
      reproductiveStatus: ["Rep. State"],
      daysInMilk: ["DIM"],
      dailyMilk: ["Today Milk"],
      pregDays: ["Days Preg"],
      servicesCount: ["Inseminations"],

      lastCalvingDate: ["Calving", "CAL"],
      lastInseminationDate: ["Bred", "Ins", "INS"],
      dryOffDate: ["Dry", "DRY"],
      heatDate: ["Heat", "OES"],
      pdResult: ["Preg", "PRG", "Non-Preg", "OPEN"]
    }
  });
})();
// ============================================================
// HERD IMPORT V2 - follower / dam columns dictionary patch
// دعم أعمدة التوابع ورقم الأم داخل نفس ملف الاستيراد
// ============================================================

(function herdImportV2ApplyFollowerDictionaryPatchSrv() {
  const followerGroups = {
    damNumber: [
      "DAM",
      "Dam",
      "DAM ID",
      "DAMID",
      "Dam No",
      "Dam Number",
      "Dam ID No",
      "MOTHER",
      "Mother",
      "Mother ID",
      "MOTHERID",
      "Mother No",
      "Mother Number",
      "رقم الأم",
      "رقم الام",
      "الأم",
      "الام",
      "ام",
      "أم"
    ],

    followerSex: [
      "SEX",
      "Sex",
      "GENDER",
      "Gender",
      "CALF SEX",
      "Calf Sex",
      "Calf Gender",
      "الجنس",
      "جنس",
      "جنس التابع",
      "جنس العجل",
      "نوع الجنس"
    ],

    followerStatus: [
      "Follower Status",
      "Calf Status",
      "Youngstock Status",
      "Heifer Status",
      "حالة التابع",
      "حالة العجل",
      "حالة العجلة",
      "حالة"
    ]
  };

  for (const profileKey of Object.keys(HERD_IMPORT_V2_SOURCE_SIGNATURES || {})) {
    herdImportV2MergeProfilePatchSrv(profileKey, {
      groups: followerGroups
    });
  }
})();
function herdImportV2UniqueHeadersSrv(rows = []) {
  const seen = new Set();
  const headers = [];

  for (const row of rows.slice(0, 30)) {
    for (const key of Object.keys(row || {})) {
      const raw = String(key || "").trim();
      if (!raw) continue;

      const norm = addAnimalImportNormKeySrv(raw);
      if (seen.has(norm)) continue;

      seen.add(norm);
      headers.push(raw);
    }
  }

  return headers;
}

function herdImportV2GroupHitSrv(normHeaders, aliases = []) {
  for (const alias of aliases || []) {
    if (normHeaders.has(addAnimalImportNormKeySrv(alias))) {
      return alias;
    }
  }

  return "";
}

function herdImportV2DetectSourceProfileSrv(rows = []) {
  const headers = herdImportV2UniqueHeadersSrv(rows);
  const normHeaders = new Set(headers.map(addAnimalImportNormKeySrv));

  let best = {
    key: "unknown",
    name: "غير محدد",
    confidence: 0,
    hits: [],
    matchedGroups: [],
    missingImportantGroups: [],
    headers
  };

  for (const [profileKey, profile] of Object.entries(HERD_IMPORT_V2_SOURCE_SIGNATURES)) {
    const groups = profile.groups || {};
    const requiredGroups = profile.requiredGroups || Object.keys(groups);

    const hits = [];
    const matchedGroups = [];
    const missingImportantGroups = [];

    for (const [groupKey, aliases] of Object.entries(groups)) {
      const hit = herdImportV2GroupHitSrv(normHeaders, aliases);

      if (hit) {
        hits.push(hit);
        matchedGroups.push(groupKey);
      }
    }

    for (const groupKey of requiredGroups) {
      if (!matchedGroups.includes(groupKey)) {
        missingImportantGroups.push(groupKey);
      }
    }

    const requiredMatched = requiredGroups.filter(g => matchedGroups.includes(g)).length;
    const requiredScore = requiredGroups.length
      ? requiredMatched / requiredGroups.length
      : 0;

    const optionalGroups = Object.keys(groups).filter(g => !requiredGroups.includes(g));
    const optionalMatched = optionalGroups.filter(g => matchedGroups.includes(g)).length;
    const optionalScore = optionalGroups.length
      ? optionalMatched / optionalGroups.length
      : 0;

    const confidence = Number(
      Math.min(1, (requiredScore * 0.85) + (optionalScore * 0.15)).toFixed(2)
    );

    if (confidence > best.confidence) {
      best = {
        key: profileKey,
        name: profile.name,
        confidence,
        hits,
        matchedGroups,
        missingImportantGroups,
        headers
      };
    }
  }

  return best;
}
function herdImportV2FindHeaderCanonicalInternalSrv(header, groups = {}) {
  const nh = addAnimalImportNormKeySrv(header);

  for (const [groupKey, aliases] of Object.entries(groups || {})) {
    for (const alias of aliases || []) {
      if (nh === addAnimalImportNormKeySrv(alias)) {
        return {
          canonical: groupKey,
          matchedAlias: alias
        };
      }
    }
  }

  return null;
}

function herdImportV2BuildColumnMappingInternalSrv(rows = [], profileKey = "unknown") {
  const headers = herdImportV2UniqueHeadersSrv(rows);
  const profile = HERD_IMPORT_V2_SOURCE_SIGNATURES[profileKey] || null;
  const groups = profile?.groups || {};
  const requiredGroups = profile?.requiredGroups || [];

  const columnMapInternal = {};
  const matchedGroupsSet = new Set();
  let mappedColumnsCount = 0;
  let unmappedColumnsCount = 0;

  for (const header of headers) {
    const hit = herdImportV2FindHeaderCanonicalInternalSrv(header, groups);

    if (hit) {
      columnMapInternal[header] = {
        canonical: hit.canonical,
        matchedAlias: hit.matchedAlias
      };

      matchedGroupsSet.add(hit.canonical);
      mappedColumnsCount++;
    } else {
      unmappedColumnsCount++;
    }
  }

  const missingImportantGroups = requiredGroups.filter(g => !matchedGroupsSet.has(g));

  const mappingConfidence = headers.length
    ? Number((mappedColumnsCount / headers.length).toFixed(2))
    : 0;

  const readyForNextStep =
    profileKey !== "unknown" &&
    mappingConfidence >= 0.6 &&
    missingImportantGroups.length === 0;

  return {
    columnMapInternal,
    mappedColumnsCount,
    unmappedColumnsCount,
    mappingConfidence,
    matchedGroupsCount: matchedGroupsSet.size,
    missingImportantGroups,
    readyForNextStep
  };
}

function herdImportV2PublicConfidenceLevelSrv(confidence) {
  const n = Number(confidence);

  if (!Number.isFinite(n) || n <= 0) return "غير معروف";
  if (n >= 0.85) return "عالية";
  if (n >= 0.6) return "متوسطة";
  return "منخفضة";
}

function herdImportV2PublicSourceProfileSrv(sourceProfile = {}) {
  return {
    key: sourceProfile.key || "unknown",
    name: sourceProfile.name || "غير محدد",
    confidence: Number(sourceProfile.confidence || 0),
    confidenceLevel: herdImportV2PublicConfidenceLevelSrv(sourceProfile.confidence)
  };
}
// ============================================================
// HERD IMPORT V2 - internal value mapping only
// لا يتم كشف قاموس القيم للمستخدم
// ============================================================

function herdImportV2NormalizePdResultInternalSrv(v) {
  const raw = String(v ?? "").trim();
  const s = raw.toLowerCase().replace(/[\s_\-]+/g, "");

  if (!s) return "";

  // السالب أولًا حتى لا تتحول Non-Preg إلى Preg بالغلط
  if (
    s === "pd-" ||
    s === "-" ||
    s === "o" ||
    s === "open" ||
    s === "nonpreg" ||
    s === "nonpregnant" ||
    s.includes("notpreg") ||
    s.includes("negative") ||
    s.includes("empty") ||
    s.includes("فارغ") ||
    s.includes("فاضي") ||
    s.includes("غيرحامل") ||
    s.includes("مفتوح")
  ) {
    return "فارغة";
  }

  if (
    s === "pd+" ||
    s === "+" ||
    s === "p" ||
    s === "prg" ||
    s === "preg" ||
    s.includes("positive") ||
    s.includes("confirmed") ||
    s.includes("pregnant") ||
    s.includes("preg") ||
    s.includes("حامل") ||
    s.includes("عشار")
  ) {
    return "عشار";
  }

  return "";
}
function herdImportV2NormalizeReproductiveStatusInternalSrv(v) {
  const raw = String(v ?? "").trim();
  const s = raw.toLowerCase().replace(/[\s_\-]+/g, "");

  if (!s) return "";

  // غير حامل / مفتوحة أولًا
  if (
    s === "open" ||
    s === "o" ||
    s === "pd-" ||
    s === "nonpreg" ||
    s === "nonpregnant" ||
    s.includes("notpreg") ||
    s.includes("empty") ||
    s.includes("مفتوح") ||
    s.includes("مفتوحة") ||
    s.includes("غيرحامل") ||
    s.includes("فارغ") ||
    s.includes("فاضي")
  ) {
   return "مفتوحة";
  }

  if (
    s === "bred" ||
    s === "insem" ||
    s === "ins" ||
    s.includes("bred") ||
    s.includes("inseminated") ||
    s.includes("insemination") ||
    s.includes("served") ||
    s.includes("service") ||
    s.includes("ملقح") ||
    s.includes("ملقحة")
  ) {
    return "ملقحة";
  }

  if (
    s === "pd+" ||
    s === "p" ||
    s === "prg" ||
    s === "preg" ||
    s.includes("pregnant") ||
    s.includes("preg") ||
    s.includes("حامل") ||
    s.includes("عشار")
  ) {
    return "عشار";
  }

  if (
    s.includes("fresh") ||
    s.includes("postpartum") ||
    s.includes("حديث")
  ) {
    return "حديث الولادة";
  }

  return raw;
}

function herdImportV2NormalizeArchiveStatusInternalSrv(v) {
  const raw = String(v ?? "").trim();
  const s = raw.toLowerCase().replace(/\s+/g, "");

  if (!s) return "";

  if (
    s.includes("active") ||
    s.includes("alive") ||
    s.includes("inherd") ||
    s.includes("بالقطيع") ||
    s.includes("نشط")
  ) {
    return "active";
  }

  if (
    s.includes("sold") ||
    s.includes("sale") ||
    s.includes("sell") ||
    s.includes("مباع") ||
    s.includes("بيع")
  ) {
    return "archived_sale";
  }

  if (
    s.includes("dead") ||
    s.includes("death") ||
    s.includes("died") ||
    s.includes("نافق") ||
    s.includes("نفوق")
  ) {
    return "archived_death";
  }

  return "";
}

function herdImportV2NormalizeValueInternalSrv(canonical, rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return "";

if (canonical === "reproductiveStatus") {
  return herdImportV2NormalizeReproductiveStatusInternalSrv(raw);
}

  if (canonical === "productionStatus") {
    const v = addAnimalImportNormalizeProductionSrv(raw, {});
    return v || "";
  }

  if (canonical === "reproductiveStatus") {
    const v = addAnimalImportNormalizeReproSrv(raw);
    return v || "";
  }

  if (canonical === "pdResult") {
    return herdImportV2NormalizePdResultInternalSrv(raw);
  }

  if (canonical === "animalStatus") {
    return herdImportV2NormalizeArchiveStatusInternalSrv(raw);
  }

  return raw;
}

function herdImportV2AnalyzeValueMappingInternalSrv(rows = [], columnMapInternal = {}) {
  const valueFields = new Set([
    "animalType",
    "productionStatus",
    "reproductiveStatus",
    "pdResult",
    "animalStatus"
  ]);

  let checkedValuesCount = 0;
  let normalizedValuesCount = 0;
  let unrecognizedValuesCount = 0;

  const fieldsAnalyzed = new Set();
  const fieldsWithUnknownValues = new Set();

  for (const row of rows.slice(0, 200)) {
    for (const [header, info] of Object.entries(columnMapInternal || {})) {
      const canonical = info?.canonical || "";

      if (!valueFields.has(canonical)) continue;

      const raw = row?.[header];
      const rawText = String(raw ?? "").trim();
      if (!rawText) continue;

      checkedValuesCount++;
      fieldsAnalyzed.add(canonical);

      const normalized = herdImportV2NormalizeValueInternalSrv(canonical, rawText);

      if (normalized) {
        normalizedValuesCount++;
      } else {
        unrecognizedValuesCount++;
        fieldsWithUnknownValues.add(canonical);
      }
    }
  }

  const valueConfidence = checkedValuesCount
    ? Number((normalizedValuesCount / checkedValuesCount).toFixed(2))
    : 0;

  return {
    checkedValuesCount,
    normalizedValuesCount,
    unrecognizedValuesCount,
    valueConfidence,
    valueConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(valueConfidence),
    fieldsAnalyzedCount: fieldsAnalyzed.size,
    fieldsWithUnknownValuesCount: fieldsWithUnknownValues.size
  };
}
// ============================================================
// HERD IMPORT V2 - animal baseline preview only
// بناء حالة الحيوان المبدئية داخليًا — بدون حفظ وبدون كشف التفاصيل
// ============================================================

function herdImportV2FirstValueByCanonicalInternalSrv(row = {}, columnMapInternal = {}, canonical = "") {
  for (const [header, info] of Object.entries(columnMapInternal || {})) {
    if (info?.canonical !== canonical) continue;

    const v = row?.[header];
    const s = String(v ?? "").trim();

    if (s) return v;
  }

  return "";
}

function herdImportV2NumberInternalSrv(v) {
  const s = String(v ?? "")
    .trim()
    .replace(/[٬,]/g, ".")
    .replace(/[^\d.\-]/g, "");

  if (!s) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function herdImportV2IntInternalSrv(v) {
  const n = herdImportV2NumberInternalSrv(v);
  if (n === null) return null;
  return Math.round(n);
}

function herdImportV2NormalizeBaselineDateInternalSrv(v) {
  const d = addAnimalImportNormalizeDateSrv(v);
  return addAnimalIsDateSrv(d) ? d : "";
}

function herdImportV2DateMinusDaysInternalSrv(days, todayISO = addAnimalTodaySrv()) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0 || !addAnimalIsDateSrv(todayISO)) return "";

  const [y, m, d] = String(todayISO).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - Math.round(n));

  return dt.toISOString().slice(0, 10);
}

function herdImportV2NormalizeBaselineAnimalStatusInternalSrv(v) {
  return herdImportV2NormalizeArchiveStatusInternalSrv(v) || "active";
}

function herdImportV2InferProductionStatusInternalSrv(base = {}) {
  if (base.dryOffDate) return "جاف";

  if (
    base.lastCalvingDate ||
    Number(base.daysInMilk || 0) > 0 ||
    Number(base.dailyMilk || 0) > 0
  ) {
    return "حلاب";
  }

  return "";
}

function herdImportV2InferReproductiveStatusInternalSrv(base = {}) {
  if (base.pdResult === "عشار") return "عشار";
 if (base.pdResult === "فارغة") return "مفتوحة";

  const repro = String(base.reproductiveStatus || "").trim();

  // في الاستيراد: Fresh/حديث الولادة لا تُحفظ كحالة تناسلية نهائية.
  // وجود آخر ولادة/DIM سيُستخدم لبناء حدث ولادة Seed، أما تناسليًا فهي غير حامل.
  if (repro === "حديث الولادة") return "مفتوحة";

  if (repro) return repro;

  if (base.lastInseminationDate) return "ملقحة";

  return "";
}
function herdImportV2NormalizeBreedKeyInternalSrv(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[_\-\/\\.#!:;()\[\]]/g, " ")
    .replace(/\s+/g, " ");
}

function herdImportV2InferAnimalTypeFromBreedInternalSrv(breedRaw) {
  const b = herdImportV2NormalizeBreedKeyInternalSrv(breedRaw);
  if (!b) return "";

  const cowSignals = [
    "holstein",
    "friesian",
    "freisian",
    "jersey",
    "brown swiss",
    "montbeliarde",
    "montbéliarde",
    "simmental",
    "fleckvieh",
    "ayrshire",
    "guernsey",
    "shorthorn"
  ];

  const buffaloSignals = [
    "buffalo",
    "murrah",
    "nili ravi",
    "nili-ravi",
    "mediterranean buffalo",
    "egyptian buffalo",
    "surti",
    "jaffarabadi",
    "mehsana",
    "banni",
    "pandharpuri"
  ];

  const isCow = cowSignals.some(x => b.includes(herdImportV2NormalizeBreedKeyInternalSrv(x)));
  const isBuffalo = buffaloSignals.some(x => b.includes(herdImportV2NormalizeBreedKeyInternalSrv(x)));

  if (isCow && !isBuffalo) return "بقرة";
  if (isBuffalo && !isCow) return "جاموسة";

  return "";
}
function herdImportV2BuildAnimalBaselineOneInternalSrv(row = {}, rowIndex = 0, columnMapInternal = {}, options = {}) {
  const rawAnimalNumber = herdImportV2FirstValueByCanonicalInternalSrv(
    row,
    columnMapInternal,
    "animalNumber"
  );

  const animalNumber = addAnimalDigitsSrv(rawAnimalNumber);

  const rawAnimalType = herdImportV2FirstValueByCanonicalInternalSrv(
  row,
  columnMapInternal,
  "animalType"
);

const breedRawForType = String(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "breed") || ""
).trim();

const inferredAnimalTypeFromBreed =
  herdImportV2InferAnimalTypeFromBreedInternalSrv(breedRawForType);

const defaultAnimalType = addAnimalStrSrv(
  options.defaultAnimalType ||
  options.animalTypeDefault ||
  options.herdAnimalType ||
  ""
);

const animalType = addAnimalStrSrv(rawAnimalType)
  ? herdImportV2NormalizeAnimalTypeStrictInternalSrv(rawAnimalType)
  : (
      inferredAnimalTypeFromBreed
        ? herdImportV2NormalizeAnimalTypeStrictInternalSrv(inferredAnimalTypeFromBreed)
        : (
            defaultAnimalType
              ? herdImportV2NormalizeAnimalTypeStrictInternalSrv(defaultAnimalType)
              : ""
          )
    );
  const damNumber = addAnimalDigitsSrv(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "damNumber")
);

const followerSex = addAnimalImportNormalizeSexSrv(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "followerSex")
);

const followerStatus = addAnimalImportNormalizeFollowerStatusSrv(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "followerStatus")
);
  const birthDate = herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "birthDate")
  );

 let lastCalvingDate = herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "lastCalvingDate")
  );

  let lastInseminationDate = herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "lastInseminationDate")
  );

  const pdDate = herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "pdDate")
  );

  const dryOffDate = herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "dryOffDate")
  );

  const daysInMilkRaw = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "daysInMilk");
  const daysInMilk = herdImportV2IntInternalSrv(daysInMilkRaw);

  const dailyMilkRaw = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "dailyMilk");
  const dailyMilk = herdImportV2NumberInternalSrv(dailyMilkRaw);

  const lactationRaw = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "lactationNumber");
  const lactationNumber = herdImportV2IntInternalSrv(lactationRaw);

  const servicesRaw = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "servicesCount");
  const servicesCount = herdImportV2IntInternalSrv(servicesRaw);

  const rawRepro = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "reproductiveStatus");
 const reproductiveStatus = herdImportV2NormalizeReproductiveStatusInternalSrv(rawRepro);

  const rawPdResult = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "pdResult");
  const pdResult = herdImportV2NormalizePdResultInternalSrv(rawPdResult);
  const pregDays = herdImportV2IntInternalSrv(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "pregDays")
);

// لو الملف أعطى DIM ولم يعطِ تاريخ آخر ولادة:
// نشتق تاريخ آخر ولادة كأساس حسابي ليبدأ مُرَبِّيك حساب DIM يوميًا بعد الاستيراد.
if (!lastCalvingDate && Number.isFinite(Number(daysInMilk)) && Number(daysInMilk) > 0) {
  lastCalvingDate = herdImportV2DateMinusDaysInternalSrv(daysInMilk);
}

// لو الملف أعطى أيام حمل مؤكدة ولم يعطِ آخر تلقيح:
// نشتق آخر تلقيح كأساس حسابي ليحسب مُرَبِّيك عمر الحمل لاحقًا.
if (
  !lastInseminationDate &&
  Number.isFinite(Number(pregDays)) &&
  Number(pregDays) > 0 &&
  (pdResult === "عشار" || reproductiveStatus === "عشار")
) {
  lastInseminationDate = herdImportV2DateMinusDaysInternalSrv(pregDays);
}
  const rawAnimalStatus = herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "animalStatus");
  const animalStatus = herdImportV2NormalizeBaselineAnimalStatusInternalSrv(rawAnimalStatus);

  const base = {
    rowIndex: rowIndex + 1,
    animalNumber,
    animalType,
    entryType: "mothers",
    damNumber,
    followerSex,
    followerStatus,
    breed: breedRawForType,
    birthDate,
    lactationNumber,
    lastCalvingDate,
    daysInMilk,
    dailyMilk,
    lastInseminationDate,
    servicesCount,
    sireNumber: String(herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "sireNumber") || "").trim(),
    pdDate,
    pdResult,
    pregDays,
    dryOffDate,
    heatDate: herdImportV2NormalizeBaselineDateInternalSrv(
    herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "heatDate")
),
heatDatesRaw: String(
  herdImportV2FirstValueByCanonicalInternalSrv(row, columnMapInternal, "heatDates") || ""
).trim(),
animalStatus
  };

  base.productionStatus = herdImportV2InferProductionStatusInternalSrv(base);
  base.reproductiveStatus = herdImportV2InferReproductiveStatusInternalSrv({
    ...base,
    reproductiveStatus,
    pdResult
  });
 base.entryType = herdImportV2InferEntryTypeInternalSrv(base);

if (base.entryType === "followers") {
  base.followerStatus = herdImportV2InferFollowerStatusInternalSrv(base);
  base.productionStatus = "";

  if (base.followerStatus !== "ملقح" && base.followerStatus !== "عشار") {
    base.reproductiveStatus = "";
    base.lastCalvingDate = "";
    base.daysInMilk = null;
    base.dailyMilk = null;
    base.dryOffDate = "";
  }
}

if (base.entryType === "mothers") {
  const lact = Number(base.lactationNumber);
  const dim = Number(base.daysInMilk);

  const hasCalvedSignal =
    !!base.lastCalvingDate ||
    (Number.isFinite(dim) && dim > 0);

  if ((!Number.isFinite(lact) || lact < 1) && hasCalvedSignal) {
    base.lactationNumber = 1;
  }
}

const reviewReasons = [];
  if (!base.animalNumber) reviewReasons.push("missing_animal_number");
  if (!base.animalType) reviewReasons.push("missing_animal_type");
  if (base.animalStatus && base.animalStatus !== "active") reviewReasons.push("not_active_animal");

  if (base.entryType === "followers") {
  if (!base.damNumber || !base.birthDate) {
    reviewReasons.push("weak_follower_identity");
  }
} else if (
  !base.lastCalvingDate &&
  !base.daysInMilk &&
  !base.dailyMilk &&
  !base.reproductiveStatus &&
  !base.lastInseminationDate &&
  !base.dryOffDate
) {
  reviewReasons.push("weak_current_state");
}

  return {
    base,
    ok: reviewReasons.length === 0,
    reviewReasons
  };
}
function herdImportV2NormalizeAnimalTypeStrictInternalSrv(v) {
  const raw = addAnimalStrSrv(v);
  if (!raw) return "";
  return addAnimalImportNormalizeAnimalTypeSrv(raw);
}
function herdImportV2OperationalCollectionNameInternalSrv(base = {}) {
  return base.entryType === "followers" ? "calves" : "animals";
}

function herdImportV2InferEntryTypeInternalSrv(base = {}) {
  const damNumber = addAnimalDigitsSrv(base.damNumber);
  if (!damNumber) return "mothers";

  const lact = Number(base.lactationNumber);
  const dim = Number(base.daysInMilk);
  const milk = Number(base.dailyMilk);

  const hasMotherSignals =
    !!base.lastCalvingDate ||
    !!base.dryOffDate ||
    (Number.isFinite(lact) && lact > 0) ||
    (Number.isFinite(dim) && dim > 0) ||
    (Number.isFinite(milk) && milk > 0);

  return hasMotherSignals ? "mothers" : "followers";
}

function herdImportV2InferFollowerStatusInternalSrv(base = {}) {
  const explicit = addAnimalImportNormalizeFollowerStatusSrv(base.followerStatus);
  if (explicit) return explicit;

  if (base.reproductiveStatus === "عشار") return "عشار";
  if (base.reproductiveStatus === "ملقحة") return "ملقح";

  if (base.birthDate) {
    const ageDays = Number(addAnimalDiffDaysSrv(base.birthDate, addAnimalTodaySrv()));
    if (Number.isFinite(ageDays)) {
      if (ageDays < 120) return "رضيع";
      if (ageDays < 240) return "فطام";
      return "نامي";
    }
  }

  return "نامي";
}
function herdImportV2BuildAnimalBaselinePreviewInternalSrv(rows = [], columnMapInternal = {}, options = {}) {
  const built = [];
  const seenNumbers = new Set();
  const duplicateNumbers = new Set();

  for (let i = 0; i < rows.length; i++) {
    const item = herdImportV2BuildAnimalBaselineOneInternalSrv(rows[i], i, columnMapInternal, options);

    if (item.base.animalNumber) {
      if (seenNumbers.has(item.base.animalNumber)) {
        duplicateNumbers.add(item.base.animalNumber);
        item.ok = false;
        item.reviewReasons.push("duplicate_in_file");
      } else {
        seenNumbers.add(item.base.animalNumber);
      }
    }

    built.push(item);
  }

  const reasonCounts = {};
  const animalTypeCounts = {};
  const productionStatusCounts = {};
  const reproductiveStatusCounts = {};

  let readyAnimalsCount = 0;
  let needsReviewCount = 0;
  let missingNumberCount = 0;
  let archivedRowsCount = 0;

  for (const item of built) {
    const base = item.base || {};

    if (item.ok) readyAnimalsCount++;
    else needsReviewCount++;

    if (!base.animalNumber) missingNumberCount++;
    if (base.animalStatus && base.animalStatus !== "active") archivedRowsCount++;

    if (base.animalType) {
      animalTypeCounts[base.animalType] = (animalTypeCounts[base.animalType] || 0) + 1;
    }

    if (base.productionStatus) {
      productionStatusCounts[base.productionStatus] = (productionStatusCounts[base.productionStatus] || 0) + 1;
    }

    if (base.reproductiveStatus) {
      reproductiveStatusCounts[base.reproductiveStatus] = (reproductiveStatusCounts[base.reproductiveStatus] || 0) + 1;
    }

    for (const reason of item.reviewReasons || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }

  return {
    animalsInternal: built.map(x => x.base),
    totalRows: rows.length,
    readyAnimalsCount,
    needsReviewCount,
    missingNumberCount,
    duplicateInFileCount: duplicateNumbers.size,
    archivedRowsCount,
    baselineConfidence: rows.length
      ? Number((readyAnimalsCount / rows.length).toFixed(2))
      : 0,
    reasonCounts,
    animalTypeCounts,
    productionStatusCounts,
    reproductiveStatusCounts,
    readyForSavePreview: rows.length > 0 && readyAnimalsCount > 0 && needsReviewCount === 0
  };
}
// ============================================================
// HERD IMPORT V2 - seed events preview only
// بناء الأحداث التأسيسية داخليًا — بدون حفظ وبدون كشف التفاصيل
// ============================================================

function herdImportV2SplitSeedDatesInternalSrv(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[\n;,،|]+/g)
    .map(x => x.trim())
    .filter(Boolean);

  const out = [];

  for (const p of parts) {
    const d = addAnimalImportNormalizeDateSrv(p);
    if (d) out.push(d);
  }

  return [...new Set(out)];
}

function herdImportV2PushSeedEventInternalSrv(list, base, eventTypeNorm, eventTypeAr, eventDate, details = {}) {
  if (!base?.animalNumber || !eventDate) return false;

  list.push({
    animalNumber: base.animalNumber,
    animalType: base.animalType || "",
    eventTypeNorm,
    eventTypeAr,
    eventDate,
    details: {
      ...details,
      importedBy: "herd_import_v2",
      importMode: "seed_history",
      isImportedSeed: true
    }
  });

  return true;
}
// ============================================================
// HERD IMPORT V2 - operational save
// حفظ تشغيلي فقط: animals baseline + seed events
// ============================================================

function herdImportV2DateOrNullInternalSrv(v) {
  const s = String(v || "").trim().slice(0, 10);
  return addAnimalIsDateSrv(s) ? s : null;
}

function herdImportV2PregnancyDaysForSaveInternalSrv(base = {}) {
  if (base.reproductiveStatus !== "عشار") return null;

  const pregDays = Number(base.pregDays);
  if (Number.isFinite(pregDays) && pregDays >= 0) {
    return Math.round(pregDays);
  }

  if (base.lastInseminationDate) {
    const d = addAnimalDiffDaysSrv(base.lastInseminationDate, addAnimalTodaySrv());
    return Number.isFinite(Number(d)) ? Number(d) : null;
  }

  return null;
}

function herdImportV2DaysInMilkForSaveInternalSrv(base = {}) {
  if (base.productionStatus === "جاف") return null;

  const dim = Number(base.daysInMilk);
  if (Number.isFinite(dim) && dim >= 0) {
    return Math.round(dim);
  }

  if (base.lastCalvingDate) {
    const d = addAnimalDiffDaysSrv(base.lastCalvingDate, addAnimalTodaySrv());
    return Number.isFinite(Number(d)) ? Number(d) : null;
  }

  return null;
}

async function herdImportV2FindAnimalRefInternalSrv(uid, numberStr, collectionName = "animals") {
  const col = collectionName === "calves" ? "calves" : "animals";
  const key = `${uid}#${numberStr}`;
  const nNum = Number(numberStr);

  const q1 = await db.collection(col)
    .where("userId_number", "==", key)
    .limit(1)
    .get();

  if (!q1.empty) {
    return {
      ref: q1.docs[0].ref,
      exists: true
    };
  }

  const q2 = await db.collection(col)
    .where("userId", "==", uid)
    .where("number", "==", numberStr)
    .limit(1)
    .get();

  if (!q2.empty) {
    return {
      ref: q2.docs[0].ref,
      exists: true
    };
  }

  if (Number.isFinite(nNum)) {
    const q3 = await db.collection(col)
      .where("userId", "==", uid)
      .where("animalNumber", "==", nNum)
      .limit(1)
      .get();

    if (!q3.empty) {
      return {
        ref: q3.docs[0].ref,
        exists: true
      };
    }
  }

  return {
    ref: db.collection(col).doc(),
    exists: false
  };
}

function herdImportV2BuildAnimalOperationalPayloadInternalSrv(uid, base = {}, sourceProfile = {}, isNew = true) {
  const numberStr = addAnimalDigitsSrv(base.animalNumber);
  const speciesInfo = addAnimalSpeciesFromTypeSrv(base.animalType || base.animalTypeAr);

  const productionStatus = addAnimalStrSrv(base.productionStatus);
  const reproductiveStatus = addAnimalStrSrv(base.reproductiveStatus);
  if (herdImportV2OperationalCollectionNameInternalSrv(base) === "calves") {
  const followerStatus = herdImportV2InferFollowerStatusInternalSrv(base);
  const isInseminatedFollower = followerStatus === "ملقح" || followerStatus === "عشار";

  const payload = {
    ownerUid: uid,
    userId: uid,
    userId_number: `${uid}#${numberStr}`,
    entryType: "followers",

    calfNumber: numberStr,
    number: numberStr,
    animalNumber: Number(numberStr),

    animaltype: speciesInfo.animaltype,
    animalTypeAr: speciesInfo.animalTypeAr,
    species: speciesInfo.species,
    breed: addAnimalStrSrv(base.breed),

    sex: addAnimalStrSrv(base.followerSex),
    status: followerStatus,
    followerStatus,

    birthDate: herdImportV2DateOrNullInternalSrv(base.birthDate),
    damNumber: addAnimalStrSrv(base.damNumber) || null,

    lastInseminationDate: isInseminatedFollower
      ? herdImportV2DateOrNullInternalSrv(base.lastInseminationDate)
      : null,

    servicesCount: isInseminatedFollower && Number.isFinite(Number(base.servicesCount))
      ? Number(base.servicesCount)
      : 0,

    sireNumber: isInseminatedFollower
      ? (addAnimalStrSrv(base.sireNumber) || null)
      : null,

    pregnancyDays: followerStatus === "عشار"
      ? herdImportV2PregnancyDaysForSaveInternalSrv({
          ...base,
          reproductiveStatus: "عشار"
        })
      : null,

    statusInHerd: "active",

    importedBy: "herd_import_v2",
    importMode: "operational_baseline",
    isImportedBaseline: true,
    sourceProfileKey: sourceProfile.key || "unknown",

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "server:/api/herd-import-v2/save-operational"
  };

  if (isNew) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  return payload;
}
  const payload = {
    ownerUid: uid,
    userId: uid,
    userId_number: `${uid}#${numberStr}`,
    entryType: "mothers",

    number: numberStr,
    animalNumber: Number(numberStr),

    animaltype: speciesInfo.animaltype,
    animalTypeAr: speciesInfo.animalTypeAr,
    species: speciesInfo.species,
    breed: addAnimalStrSrv(base.breed),

    birthDate: herdImportV2DateOrNullInternalSrv(base.birthDate),

    lactationNumber: Number.isFinite(Number(base.lactationNumber))
      ? Number(base.lactationNumber)
      : 0,

    productionStatus,
    dailyMilk: productionStatus === "حلاب" && Number.isFinite(Number(base.dailyMilk))
      ? Number(base.dailyMilk)
      : null,

    reproductiveStatus,

    lastCalvingDate: herdImportV2DateOrNullInternalSrv(base.lastCalvingDate),
    daysInMilk: herdImportV2DaysInMilkForSaveInternalSrv(base),

    lastInseminationDate: herdImportV2DateOrNullInternalSrv(base.lastInseminationDate),
    servicesCount: Number.isFinite(Number(base.servicesCount))
      ? Number(base.servicesCount)
      : 0,

    sireNumber: addAnimalStrSrv(base.sireNumber) || null,
    pregnancyDays: herdImportV2PregnancyDaysForSaveInternalSrv(base),

    dryOffDate: herdImportV2DateOrNullInternalSrv(base.dryOffDate),

    status: "active",

    importedBy: "herd_import_v2",
    importMode: "operational_baseline",
    isImportedBaseline: true,
    sourceProfileKey: sourceProfile.key || "unknown",

    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "server:/api/herd-import-v2/save-operational"
  };

  if (isNew) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  return payload;
}

function herdImportV2SeedEventDocIdInternalSrv(uid, ev = {}) {
  const crypto = require("crypto");

  const raw = [
    uid,
    ev.animalNumber,
    ev.eventTypeNorm,
    ev.eventDate,
    ev.details?.sourceField || ""
  ].map(x => String(x || "").trim()).join("|");

  return "herdimp_" + crypto
    .createHash("sha1")
    .update(raw)
    .digest("hex")
    .slice(0, 32);
}

function herdImportV2BuildSeedEventPayloadInternalSrv(uid, ev = {}, sourceProfile = {}) {
  const numberStr = addAnimalDigitsSrv(ev.animalNumber);
  const eventTypeNorm = addAnimalStrSrv(ev.eventTypeNorm);
  const eventTypeAr = addAnimalStrSrv(ev.eventTypeAr);

  return {
    ownerUid: uid,
    userId: uid,
    animalNumber: Number(numberStr),
    number: numberStr,
    animalTypeAr: addAnimalStrSrv(ev.animalType),

    eventTypeNorm,
    eventTypeAr,
    eventType: eventTypeAr,
    type: eventTypeAr,
    eventDate: herdImportV2DateOrNullInternalSrv(ev.eventDate),

    details: {
      ...(ev.details || {}),
      importedBy: "herd_import_v2",
      importMode: "seed_history",
      isImportedSeed: true,
      sourceProfileKey: sourceProfile.key || "unknown"
    },

    importedBy: "herd_import_v2",
    importMode: "seed_history",
    isImportedSeed: true,
    sourceProfileKey: sourceProfile.key || "unknown",

    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "server:/api/herd-import-v2/save-operational"
  };
}
function herdImportV2BuildSeedEventsPreviewInternalSrv(animalsInternal = []) {
  const seedEventsInternal = [];

  const counts = {
    calvingEventsCount: 0,
    inseminationEventsCount: 0,
    pregnancyDiagnosisEventsCount: 0,
    dryOffEventsCount: 0,
    heatEventsCount: 0
  };

  let skippedNoAnimalNumberCount = 0;
  let skippedNoEventDateCount = 0;
  let animalsWithSeedEventsCount = 0;

  for (const base of animalsInternal || []) {
    const eventsBeforeThisAnimal = seedEventsInternal.length;
    if (!base?.animalNumber) {
      skippedNoAnimalNumberCount++;
      continue;
    }

    if (base.lastCalvingDate) {
      const ok = herdImportV2PushSeedEventInternalSrv(
        seedEventsInternal,
        base,
        "calving",
        "ولادة",
        base.lastCalvingDate,
        {
          sourceField: "lastCalvingDate",
          lactationNumber: base.lactationNumber ?? null,
          daysInMilkAtImport: base.daysInMilk ?? null
        }
      );

      if (ok) counts.calvingEventsCount++;
    }

    if (base.lastInseminationDate) {
      const ok = herdImportV2PushSeedEventInternalSrv(
        seedEventsInternal,
        base,
        "insemination",
        "تلقيح",
        base.lastInseminationDate,
        {
          sourceField: "lastInseminationDate",
          servicesCountAtImport: base.servicesCount ?? null,
          sireNumber: base.sireNumber || ""
        }
      );

      if (ok) counts.inseminationEventsCount++;
    }

    if (base.pdDate && base.pdResult) {
      const ok = herdImportV2PushSeedEventInternalSrv(
        seedEventsInternal,
        base,
        "pregnancy_diagnosis",
        "تشخيص حمل",
        base.pdDate,
        {
          sourceField: "pdDate/pdResult",
          result: base.pdResult,
          pregDaysAtImport: base.pregDays ?? null
        }
      );

      if (ok) counts.pregnancyDiagnosisEventsCount++;
    }

    if (base.dryOffDate) {
      const ok = herdImportV2PushSeedEventInternalSrv(
        seedEventsInternal,
        base,
        "dry_off",
        "تجفيف",
        base.dryOffDate,
        {
          sourceField: "dryOffDate"
        }
      );

      if (ok) counts.dryOffEventsCount++;
    }

    const heatDates = [
      ...(base.heatDate ? [base.heatDate] : []),
      ...herdImportV2SplitSeedDatesInternalSrv(base.heatDatesRaw)
    ];

    for (const heatDate of [...new Set(heatDates)]) {
      const ok = herdImportV2PushSeedEventInternalSrv(
        seedEventsInternal,
        base,
        "heat",
        "شياع",
        heatDate,
        {
          sourceField: "heatDate/heatDates"
        }
      );

      if (ok) counts.heatEventsCount++;
    }
    if (seedEventsInternal.length > eventsBeforeThisAnimal) {
  animalsWithSeedEventsCount++;
}
  }

  const totalSeedEventsCount =
    counts.calvingEventsCount +
    counts.inseminationEventsCount +
    counts.pregnancyDiagnosisEventsCount +
    counts.dryOffEventsCount +
    counts.heatEventsCount;

  return {
    seedEventsInternal,
    ...counts,
    totalSeedEventsCount,
    skippedNoAnimalNumberCount,
    skippedNoEventDateCount,
    animalsWithSeedEventsCount,
seedEventsPerAnimal: animalsInternal.length
  ? Number((totalSeedEventsCount / animalsInternal.length).toFixed(2))
  : 0,
seedEventsConfidence: animalsInternal.length
  ? Number((animalsWithSeedEventsCount / animalsInternal.length).toFixed(2))
  : 0,
    readyForSavePreview: animalsInternal.length > 0 && totalSeedEventsCount > 0
  };
}
app.post("/api/herd-import-v2/preview", requireUserId, async (req, res) => {
  try {
    const body = req.body || {};
    const rows = addAnimalImportRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: "herd_import_v2_rows_required",
        message: "لا توجد صفوف صالحة للمعاينة.",
        sourceProfile: null,
        headers: []
      });
    }

    const sourceProfile = herdImportV2DetectSourceProfileSrv(rows);
    const columnMapping = herdImportV2BuildColumnMappingInternalSrv(rows, sourceProfile.key);
    const valueMapping = herdImportV2AnalyzeValueMappingInternalSrv(
  rows,
  columnMapping.columnMapInternal
);
    const importOptions = {
  defaultAnimalType: addAnimalStrSrv(
    body.defaultAnimalType ||
    body.animalTypeDefault ||
    body.herdAnimalType ||
    ""
  )
};
const baselinePreview = herdImportV2BuildAnimalBaselinePreviewInternalSrv(
  rows,
  columnMapping.columnMapInternal,
  importOptions
);
 const missingAnimalTypeCount = Number(
  baselinePreview.reasonCounts?.missing_animal_type || 0
);
const requiresDefaultAnimalType = missingAnimalTypeCount > 0;
const seedEventsPreview = herdImportV2BuildSeedEventsPreviewInternalSrv(
  baselinePreview.animalsInternal
);

return res.json({
  ok: true,
  mode: "herd_import_v2",
  importMode: "source_profile_preview_only",
 message: requiresDefaultAnimalType
  ? "الملف لا يحتوي على نوع الحيوان. اختر نوع القطيع ثم أعد المعاينة."
  : "تمت قراءة ملف القطيع وتحليل بنيته بنجاح. لم يتم حفظ أي بيانات.",
  totalRows: rows.length,
  requiresDefaultAnimalType,
requiredInput: requiresDefaultAnimalType
  ? {
      field: "defaultAnimalType",
      label: "نوع القطيع",
      options: ["بقرة", "جاموسة"],
      message: "الملف لا يحتوي على نوع الحيوان. اختر نوع القطيع ثم أعد المعاينة."
    }
  : null,

  sourceProfile: herdImportV2PublicSourceProfileSrv(sourceProfile),

mappingSummary: {
  mappedColumnsCount: columnMapping.mappedColumnsCount,
  unmappedColumnsCount: columnMapping.unmappedColumnsCount,
  mappingConfidence: columnMapping.mappingConfidence,
  mappingConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(columnMapping.mappingConfidence),
  readyForNextStep: columnMapping.readyForNextStep
},

valueSummary: {
  checkedValuesCount: valueMapping.checkedValuesCount,
  normalizedValuesCount: valueMapping.normalizedValuesCount,
  unrecognizedValuesCount: valueMapping.unrecognizedValuesCount,
  valueConfidence: valueMapping.valueConfidence,
  valueConfidenceLevel: valueMapping.valueConfidenceLevel,
  fieldsAnalyzedCount: valueMapping.fieldsAnalyzedCount,
  fieldsWithUnknownValuesCount: valueMapping.fieldsWithUnknownValuesCount
},

baselineSummary: {
  totalRows: baselinePreview.totalRows,
  readyAnimalsCount: baselinePreview.readyAnimalsCount,
  needsReviewCount: baselinePreview.needsReviewCount,
  missingNumberCount: baselinePreview.missingNumberCount,
  duplicateInFileCount: baselinePreview.duplicateInFileCount,
  archivedRowsCount: baselinePreview.archivedRowsCount,
  baselineConfidence: baselinePreview.baselineConfidence,
  baselineConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(baselinePreview.baselineConfidence),
  readyForSavePreview: !requiresDefaultAnimalType && baselinePreview.readyForSavePreview,

  animalTypeCounts: baselinePreview.animalTypeCounts,
  productionStatusCounts: baselinePreview.productionStatusCounts,
  reproductiveStatusCounts: baselinePreview.reproductiveStatusCounts,
  reasonCounts: baselinePreview.reasonCounts
},
  seedEventsSummary: {
  calvingEventsCount: seedEventsPreview.calvingEventsCount,
  inseminationEventsCount: seedEventsPreview.inseminationEventsCount,
  pregnancyDiagnosisEventsCount: seedEventsPreview.pregnancyDiagnosisEventsCount,
  dryOffEventsCount: seedEventsPreview.dryOffEventsCount,
  heatEventsCount: seedEventsPreview.heatEventsCount,
  totalSeedEventsCount: seedEventsPreview.totalSeedEventsCount,
  skippedNoAnimalNumberCount: seedEventsPreview.skippedNoAnimalNumberCount,
  skippedNoEventDateCount: seedEventsPreview.skippedNoEventDateCount,
  seedEventsConfidence: seedEventsPreview.seedEventsConfidence,
  animalsWithSeedEventsCount: seedEventsPreview.animalsWithSeedEventsCount,
  seedEventsPerAnimal: seedEventsPreview.seedEventsPerAnimal,
  seedEventsConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(
    Math.min(1, seedEventsPreview.seedEventsConfidence)
  ),
  readyForSavePreview: seedEventsPreview.readyForSavePreview
}    
});

  } catch (e) {
    console.error("herd-import-v2-source-preview failed", e);

    return res.status(500).json({
      ok: false,
      error: "herd_import_v2_source_preview_failed",
      message: "تعذّر تحليل مصدر ملف القطيع الآن.",
      sourceProfile: null,
      headers: []
    });
  }
});
app.post("/api/herd-import-v2/save-operational", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const rows = addAnimalImportRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: "herd_import_v2_rows_required",
        message: "لا توجد صفوف صالحة للاستيراد."
      });
    }

    const importOptions = {
      defaultAnimalType: addAnimalStrSrv(
        body.defaultAnimalType ||
        body.animalTypeDefault ||
        body.herdAnimalType ||
        ""
      )
    };

    const sourceProfile = herdImportV2DetectSourceProfileSrv(rows);
    const columnMapping = herdImportV2BuildColumnMappingInternalSrv(rows, sourceProfile.key);

    const valueMapping = herdImportV2AnalyzeValueMappingInternalSrv(
      rows,
      columnMapping.columnMapInternal
    );

    const baselinePreview = herdImportV2BuildAnimalBaselinePreviewInternalSrv(
      rows,
      columnMapping.columnMapInternal,
      importOptions
    );
    const missingAnimalTypeCount = Number(
  baselinePreview.reasonCounts?.missing_animal_type || 0
);

if (missingAnimalTypeCount > 0) {
  return res.status(400).json({
    ok: false,
    error: "herd_import_v2_missing_animal_type",
    message: "الملف لا يحتوي على نوع الحيوان. اختر نوع القطيع ثم أعد المعاينة والحفظ.",
    missingAnimalTypeCount
  });
}
    const seedEventsPreview = herdImportV2BuildSeedEventsPreviewInternalSrv(
      baselinePreview.animalsInternal
    );

    if (
      sourceProfile.key === "unknown" ||
      !columnMapping.readyForNextStep ||
      valueMapping.valueConfidence < 0.6 ||
      !baselinePreview.readyForSavePreview
    ) {
      return res.status(400).json({
        ok: false,
        error: "herd_import_v2_not_operationally_ready",
        message: "ملف القطيع غير كافٍ لتشغيل مُرَبِّيك بعد الاستيراد.",
        summary: {
          sourceProfile: herdImportV2PublicSourceProfileSrv(sourceProfile),
          mappingReady: columnMapping.readyForNextStep,
          valueConfidence: valueMapping.valueConfidence,
          readyAnimalsCount: baselinePreview.readyAnimalsCount,
          needsReviewCount: baselinePreview.needsReviewCount,
          missingNumberCount: baselinePreview.missingNumberCount,
          duplicateInFileCount: baselinePreview.duplicateInFileCount,
          baselineReady: baselinePreview.readyForSavePreview
        }
      });
    }

    let batch = db.batch();
    let ops = 0;

    let insertedAnimalsCount = 0;
    let updatedAnimalsCount = 0;
    let savedSeedEventsCount = 0;

    for (const base of baselinePreview.animalsInternal || []) {
      const numberStr = addAnimalDigitsSrv(base.animalNumber);
      if (!numberStr) continue;

     const collectionName = herdImportV2OperationalCollectionNameInternalSrv(base);

const found = await herdImportV2FindAnimalRefInternalSrv(
  uid,
  numberStr,
  collectionName
);

      const payload = herdImportV2BuildAnimalOperationalPayloadInternalSrv(
        uid,
        base,
        sourceProfile,
        !found.exists
      );

      batch.set(found.ref, payload, { merge: true });
      ops++;

      if (found.exists) updatedAnimalsCount++;
      else insertedAnimalsCount++;

      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    for (const ev of seedEventsPreview.seedEventsInternal || []) {
      if (!ev?.animalNumber || !ev?.eventDate || !ev?.eventTypeNorm) continue;

      const eventDocId = herdImportV2SeedEventDocIdInternalSrv(uid, ev);
      const eventRef = db.collection("events").doc(eventDocId);
      const payload = herdImportV2BuildSeedEventPayloadInternalSrv(uid, ev, sourceProfile);

      batch.set(eventRef, payload, { merge: true });
      ops++;
      savedSeedEventsCount++;

      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    if ((insertedAnimalsCount || updatedAnimalsCount || savedSeedEventsCount) && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "herd_import_v2_save_operational");
    }

    return res.json({
      ok: true,
      mode: "herd_import_v2",
      importMode: "save_operational_import",
      message: `✅ تم استيراد القطيع تشغيليًا: ${insertedAnimalsCount} حيوان جديد، ${updatedAnimalsCount} تحديث، ${savedSeedEventsCount} حدث تأسيسي.`,
      insertedAnimalsCount,
      updatedAnimalsCount,
      savedSeedEventsCount,
      totalAnimalsTouched: insertedAnimalsCount + updatedAnimalsCount,

      sourceProfile: herdImportV2PublicSourceProfileSrv(sourceProfile),

      baselineSummary: {
        totalRows: baselinePreview.totalRows,
        readyAnimalsCount: baselinePreview.readyAnimalsCount,
        needsReviewCount: baselinePreview.needsReviewCount,
        baselineConfidence: baselinePreview.baselineConfidence,
        baselineConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(
          baselinePreview.baselineConfidence
        )
      },

      seedEventsSummary: {
        totalSeedEventsCount: seedEventsPreview.totalSeedEventsCount,
        animalsWithSeedEventsCount: seedEventsPreview.animalsWithSeedEventsCount,
        seedEventsPerAnimal: seedEventsPreview.seedEventsPerAnimal,
        seedEventsConfidence: seedEventsPreview.seedEventsConfidence,
        seedEventsConfidenceLevel: herdImportV2PublicConfidenceLevelSrv(
          seedEventsPreview.seedEventsConfidence
        )
      }
    });

  } catch (e) {
    console.error("herd-import-v2-save-operational failed", e);

    return res.status(500).json({
      ok: false,
      error: "herd_import_v2_save_operational_failed",
      message: "تعذّر استيراد القطيع تشغيليًا الآن."
    });
  }
});
// ============================================================
//                 EVENTS PAGE: SERVER-ONLY CONTEXT / GROUPS / RESOLVE
//                 صفحة الأحداث تسأل السيرفر — الواجهة عرض فقط لاحقًا
// ============================================================

const EVENTS_PAGE_BULK_ALLOWED = new Set([
  "ovysynch.html",
  "heat.html",
  "nutrition.html",
  "weaning.html",
  "supernumerary-teat-removal.html",
  "daily-milk.html",
  "insemination.html",
  "pregnancy-diagnosis.html",
  "vaccination.html",
  "dry-off.html",
  "close-up.html"
]);
const EVENTS_PAGE_BULK_ALLOWED_ACTIONS = new Set([
  "trimming"
]);
const EVENTS_PAGE_NO_NUMBER_ALLOWED = new Set([
  "event-list.html",
  "smart-camera.html"
]);

const EVENTS_PAGE_KNOWN_PAGES = new Set([
  "calving.html",
  "insemination.html",
  "vaccination.html",
  "dry-off.html",
  "close-up.html",
  "daily-milk.html",
  "nutrition.html",
  "pregnancy-diagnosis.html",
  "disease.html",
  "abortion.html",
  "early-fetal-death.html",
  "weaning.html",
  "supernumerary-teat-removal.html",
  "colostrum-feeding.html",
  "ovysynch.html",
  "event-list.html",
  "heat.html",
  "death.html",
  "cull.html",
  "sale.html",
  "smart-camera.html"
]);

const EVENTS_PAGE_NUTRITION_ALLOWED_GROUP_KEYS = new Set([
  "fresh",
  "closeup",
  "dry",
  "high",
  "med",
  "low"
]);

const EVENTS_PAGE_NUTRITION_BLOCKED_GROUP_KEYS = new Set([
  "suckling",
  "weaned",
  "growing",
  "breeding",
  "heiferOpen",
  "pregHeifers",
  "heiferCloseup",
  "males",
  "hospital",
  "all"
]);

const EVENTS_PAGE_NUTRITION_LAUNCH_CORE_MSG =
  "⚠️ التغذية متاحة الآن لمجموعات الحلاب والجاف وانتظار الولادة فقط. اختر مجموعة تغذية معتمدة من مُرَبِّيك.";

function eventsPageTodayISO(){
  return typeof cairoTodayISO === "function"
    ? cairoTodayISO()
    : toYYYYMMDD(Date.now());
}

function eventsPageDigitsSrv(v){
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };

  return String(v || "").replace(/[٠-٩۰-۹]/g, d => map[d] || d);
}

function eventsPageParseNumbersSrv(raw){
  if (Array.isArray(raw)) {
    return raw
      .map(x => eventsPageDigitsSrv(x).replace(/[^\d]/g, ""))
      .filter(Boolean);
  }

  return eventsPageDigitsSrv(raw || "")
    .match(/\d+/g)?.map(x => String(x).trim()).filter(Boolean) || [];
}

function eventsPageDateSrv(raw){
  const s = String(raw || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : eventsPageTodayISO();
}

function eventsPageNormPageSrv(page){
  return String(page || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/^\.?\//, "");
}

function eventsPageNormGroupTextSrv(s){
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه");
}

function eventsPageNormGroupKeySrv(s){
  return String(s || "").trim();
}

function eventsPageInferNutritionAllowedFromTextSrv(text){
  const s = eventsPageNormGroupTextSrv(text);

  return (
    s.includes("حديث الولاده") ||
    s.includes("حديثه الولاده") ||
    s.includes("عالي الادرار") ||
    s.includes("متوسط الادرار") ||
    s.includes("منخفض الادرار") ||
    s.includes("حلاب") ||
    s.includes("حليب") ||
    s.includes("لبن") ||
    s.includes("جاف") ||
    s.includes("انتظار ولاده") ||
    s.includes("انتظار الولاده") ||
    s.includes("قبل الولاده") ||
    s.includes("تحضير للولاده") ||
    s.includes("fresh") ||
    s.includes("closeup") ||
    s.includes("dry") ||
    s.includes("high") ||
    s.includes("med") ||
    s.includes("low")
  );
}

function eventsPageInferNutritionBlockedFromTextSrv(text){
  const s = eventsPageNormGroupTextSrv(text);

  return (
    s.includes("رضيع") ||
    s.includes("فطام") ||
    s.includes("نامي") ||
    s.includes("تحت التلقيح") ||
    s.includes("عجلات") ||
    s.includes("عجله") ||
    s.includes("عجل") ||
    s.includes("ذكور") ||
    s.includes("ذكر") ||
    s.includes("كل الابقار") ||
    s.includes("كل الجاموس") ||
    s.includes("كل الحيوانات") ||
    s.includes("مستشفى") ||
    s.includes("مستشفي") ||
    s.includes("suckling") ||
    s.includes("weaned") ||
    s.includes("growing") ||
    s.includes("breeding") ||
    s.includes("heifer") ||
    s.includes("males") ||
    s.includes("hospital") ||
    s.includes("all")
  );
}

function eventsPageIsNutritionLaunchCoreGroupSrv(meta = {}){
  const key = eventsPageNormGroupKeySrv(meta.groupKey || meta.groupId)
    .replace(/^cow_/, "")
    .replace(/^buffalo_/, "");

  const label = `${meta.name || ""} ${meta.groupId || ""} ${meta.groupKey || ""}`;

  if (EVENTS_PAGE_NUTRITION_ALLOWED_GROUP_KEYS.has(key)) return true;
  if (EVENTS_PAGE_NUTRITION_BLOCKED_GROUP_KEYS.has(key)) return false;

  if (meta.feedingEligible === true && eventsPageInferNutritionAllowedFromTextSrv(label)) {
    return true;
  }

  return (
    eventsPageInferNutritionAllowedFromTextSrv(label) &&
    !eventsPageInferNutritionBlockedFromTextSrv(label)
  );
}

function eventsPageBuildRedirectSrv({ page, numbers, eventDate, group = {} }){
  const p = eventsPageNormPageSrv(page);
  const nums = Array.isArray(numbers) ? numbers.filter(Boolean) : [];
  const date = eventsPageDateSrv(eventDate);
  const isBulk = nums.length > 1;

  const qs = new URLSearchParams();

  if (isBulk) {
    qs.set("mode", "bulk");
    qs.set("numbers", nums.join(","));
    qs.set("bulk", nums.join(","));

    if (group.name || group.groupName) {
      qs.set("group", String(group.name || group.groupName || ""));
    }
    if (group.groupId) qs.set("groupId", String(group.groupId));
    if (group.groupKey) qs.set("groupKey", String(group.groupKey));
    if (group.animalType) qs.set("animalType", String(group.animalType));
  } else if (nums.length === 1) {
    qs.set("number", nums[0]);
  }

  qs.set("date", date);
  qs.set("eventDate", date);

  return qs.toString() ? `${p}?${qs.toString()}` : p;
}

app.get("/api/events-page/context", requireUserId, async (req, res) => {
  try {
    const rawNumbers =
      req.query.numbers ||
      req.query.bulk ||
      req.query.number ||
      req.query.animalNumber ||
      "";

    const numbers = eventsPageParseNumbersSrv(rawNumbers);
    const eventDate = eventsPageDateSrv(req.query.eventDate || req.query.date);

    return res.json({
      ok: true,
      userId: req.userId,
      eventDate,
      numbers,
      mode: numbers.length > 1 ? "bulk" : "single",
      animalInfoText: numbers.length === 1
        ? `🐄 الحيوان الحالي: ${numbers[0]}`
        : numbers.length > 1
          ? `🐄 إدخال جماعي: ${numbers.length} أرقام`
          : "🐄 الحيوان الحالي: غير محدد"
    });

  } catch (e) {
    console.error("events-page-context failed", e);

    return res.status(500).json({
      ok: false,
      error: "events_page_context_failed",
      message: "تعذّر تحميل سياق صفحة الأحداث."
    });
  }
});

app.get("/api/events-page/groups", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر تحميل المجموعات — قاعدة البيانات غير متاحة.",
        groups: []
      });
    }

    const snap = await db.collection("groups")
      .where("userId", "==", req.userId)
      .limit(100)
      .get();

    const groups = [];

    snap.forEach(doc => {
      const d = doc.data() || {};

      const members = Array.isArray(d.animalNumbers)
        ? d.animalNumbers
        : Array.isArray(d.members)
          ? d.members
          : [];

      groups.push({
        id: doc.id,
        name: String(d.groupName || d.name || doc.id),
        members: members.map(x => String(x || "").trim()).filter(Boolean),
        animalType: String(d.animalType || d.species || ""),
        animalsCount: Number(d.animalsCount || members.length || 0),
        groupId: String(d.groupId || doc.id || ""),
        groupKey: String(d.groupKey || ""),
        feedingEligible: d.feedingEligible === true
      });
    });

    return res.json({
      ok: true,
      groups
    });

  } catch (e) {
    console.error("events-page-groups failed", e);

    return res.status(500).json({
      ok: false,
      error: "events_page_groups_failed",
      message: "فشل تحميل المجموعات من السيرفر.",
      groups: []
    });
  }
});

app.post("/api/events-page/resolve", requireUserId, async (req, res) => {
  try {
    const body = req.body || {};

    const action = String(body.action || "").trim();
    const page = eventsPageNormPageSrv(body.page || body.targetPage || "");
    const numbers = eventsPageParseNumbersSrv(
      body.numbers ||
      body.animalNumbers ||
      body.number ||
      body.animalNumber ||
      ""
    );

    const eventDate = eventsPageDateSrv(body.eventDate || body.date);
    const group = body.group && typeof body.group === "object" ? body.group : {};

   if (!page && !action) {
  return res.status(400).json({
    ok: false,
    allowed: false,
    error: "event_page_required",
    message: "لم يتم تحديد نوع الحدث."
  });
}

if (action === "trimming") {
  if (!numbers.length) {
    return res.status(400).json({
      ok: false,
      allowed: false,
      error: "animal_number_required",
      message: "اكتب رقم الحيوان أو اختر مجموعة أولًا."
    });
  }

  return res.json({
    ok: true,
    allowed: true,
    action: "trimming",
    mode: numbers.length > 1 ? "bulk" : "single",
    numbers,
    eventDate,
    api: "/api/hoof-trimming/save"
  });
}
    if (!EVENTS_PAGE_KNOWN_PAGES.has(page)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        error: "unknown_event_page",
        message: "نوع الحدث غير معروف في مُرَبِّيك."
      });
    }

    if (!numbers.length && !EVENTS_PAGE_NO_NUMBER_ALLOWED.has(page)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        error: "animal_number_required",
        message: "اكتب رقم الحيوان أو اختر مجموعة أولًا."
      });
    }

    if (numbers.length > 1 && !EVENTS_PAGE_BULK_ALLOWED.has(page)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        error: "bulk_not_allowed",
        message: "هذا الحدث لا يقبل الإدخال الجماعي من صفحة الأحداث."
      });
    }

    if (page === "nutrition.html") {
      const hasGroup = !!String(group.name || group.groupName || group.groupId || group.groupKey || "").trim();

      if (numbers.length > 1 && !hasGroup) {
        return res.status(400).json({
          ok: false,
          allowed: false,
          error: "nutrition_group_required",
          message: "اختر مجموعة تغذية أولًا."
        });
      }

      if (numbers.length > 1 && !eventsPageIsNutritionLaunchCoreGroupSrv(group)) {
        return res.status(400).json({
          ok: false,
          allowed: false,
          error: "nutrition_group_not_allowed",
          message: EVENTS_PAGE_NUTRITION_LAUNCH_CORE_MSG
        });
      }
    }

    const redirectUrl = eventsPageBuildRedirectSrv({
      page,
      numbers,
      eventDate,
      group
    });

    return res.json({
      ok: true,
      allowed: true,
      page,
      mode: numbers.length > 1 ? "bulk" : "single",
      numbers,
      eventDate,
      redirectUrl
    });

  } catch (e) {
    console.error("events-page-resolve failed", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "events_page_resolve_failed",
      message: "تعذّر تجهيز الحدث من السيرفر."
    });
  }
});
// ============================================================
//                 API: HOOF TRIMMING SAVE
//                 حفظ تقليم الحوافر فردي/جماعي من السيرفر فقط
// ============================================================

async function eventsPageFindAnimalByNumberSrv(uid, number) {
  const n = eventsPageParseNumbersSrv(number)[0] || "";

  if (!db || !n) return null;

  const snap = await db.collection("animals")
    .where("userId", "==", uid)
    .where("number", "==", n)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];

  return {
    id: doc.id,
    data: doc.data() || {}
  };
}

async function existsHoofTrimmingSameDaySrv(uid, animalNumber, eventDate) {
  if (!db) return false;

  const n = eventsPageParseNumbersSrv(animalNumber)[0] || "";
  const d = eventsPageDateSrv(eventDate);

  const snap = await db.collection("events")
    .where("userId", "==", uid)
    .where("animalNumber", "==", n)
    .where("eventTypeNorm", "==", "hoof_trimming")
    .where("eventDate", "==", d)
    .limit(1)
    .get();

  return !snap.empty;
}

app.post("/api/hoof-trimming/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تقليم الحوافر — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const numbers = eventsPageParseNumbersSrv(
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      ""
    );

    const eventDate = eventsPageDateSrv(body.eventDate || body.date);
    const notes = String(body.notes || "").trim() || null;

    if (!numbers.length) {
      return res.status(400).json({
        ok: false,
        error: "animal_number_required",
        message: "اكتب رقم الحيوان أو اختر مجموعة أولًا.",
        saved: [],
        rejected: []
      });
    }

    const saved = [];
    const rejected = [];

    for (const animalNumber of numbers) {
      const animal = await eventsPageFindAnimalByNumberSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "animal_not_found",
          message: `الحيوان رقم ${animalNumber} غير موجود في القطيع.`
        });
        continue;
      }

      const already = await existsHoofTrimmingSameDaySrv(uid, animalNumber, eventDate);

      if (already) {
        rejected.push({
          animalNumber,
          reason: "duplicate_same_day",
          message: `تم تسجيل تقليم الحوافر للحيوان رقم ${animalNumber} في نفس التاريخ من قبل.`
        });
        continue;
      }

      const payload = {
        userId: uid,

        animalNumber,
        animalId: animal.id,

        eventDate,
        date: eventDate,

        eventType: "تقليم الحوافر",
        eventTypeNorm: "hoof_trimming",
        type: "تقليم الحوافر",

        notes,

        source: "server:/api/hoof-trimming/save",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const eventRef = await db.collection("events").add(payload);

      await db.collection("animals").doc(animal.id).set({
        lastHoofTrimmingDate: eventDate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      saved.push({
        animalNumber,
        animalId: animal.id,
        eventId: eventRef.id,
        message: `تم تسجيل تقليم الحوافر للحيوان رقم ${animalNumber}.`
      });
    }

    return res.json({
      ok: saved.length > 0,
      partial: saved.length > 0 && rejected.length > 0,
      message: saved.length
        ? `✅ تم تسجيل تقليم الحوافر لعدد ${saved.length} حيوان.`
        : "لم يتم تسجيل تقليم الحوافر لأي حيوان.",
      saved,
      rejected,
      eventDate,
      redirectUrl: "/event-list.html"
    });

  } catch (e) {
    console.error("hoof-trimming-save failed", e);

    return res.status(500).json({
      ok: false,
      error: "hoof_trimming_save_failed",
      message: "تعذّر حفظ تقليم الحوافر الآن.",
      saved: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: EVENTS PAGE LIST
//                 قائمة الأحداث من السيرفر فقط
// ============================================================

function eventsPagePickSrv(obj, keys, def = "") {
  for (const k of keys) {
    if (!k.includes(".")) {
      if (obj && obj[k] != null && obj[k] !== "") return obj[k];
      continue;
    }

    const parts = k.split(".");
    let cur = obj;

    for (const p of parts) {
      cur = cur?.[p];
    }

    if (cur != null && cur !== "") return cur;
  }

  return def;
}

function eventsPageNormalizeTypeKeySrv(ev = {}) {
  const raw = String(eventsPagePickSrv(ev, [
    "eventTypeNorm",
    "eventType",
    "type",
    "event_name",
    "name",
    "نوع الحدث"
  ], "")).trim();

  const k = raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  const map = {
    "لبن_يومي": "daily_milk",
    "daily_milk": "daily_milk",
    "daily_milk_report": "daily_milk",
    "dailymilk": "daily_milk",

    "تلقيح": "insemination",
    "insemination": "insemination",

    "تحصين": "vaccination",
    "vaccination": "vaccination",

    "تشخيص_حمل": "pregnancy_diagnosis",
    "pregnancy_diagnosis": "pregnancy_diagnosis",

    "ولادة": "calving",
    "calving": "calving",

    "شياع": "heat",
    "heat": "heat",

    "تجفيف": "dry_off",
    "dryoff": "dry_off",
    "dry_off": "dry_off",

    "إجهاض": "abortion",
    "اجهاض": "abortion",
    "abortion": "abortion",

    "فطام": "weaning",
    "weaning": "weaning",

    "تقليم_الحوافر": "hoof_trimming",
    "hoof_trimming": "hoof_trimming",

    "feces_eval": "feces_eval",
    "تقييم_الروث_بالكاميرا": "feces_eval",
    "تقييم_الروث": "feces_eval",

    "bcs_eval": "bcs_eval",
    "تقييم_حالة_الجسم": "bcs_eval",
    "فحص_حالة_الجسم": "bcs_eval",

    "بيع": "sale",
    "sale": "sale",

    "نفوق": "death",
    "death": "death",

    "استبعاد": "cull",
    "cull": "cull",

    "مرض": "health",
    "health": "health",
    "disease": "health",

    "تزامن": "ovsynch",
    "ovsynch": "ovsynch",
    "ovysynch": "ovsynch",

    "تحضير_ولادة": "close_up",
    "تحضير_للولادة": "close_up",
    "closeup": "close_up",
    "close_up": "close_up",
    "close_up_save": "close_up"
  };

  return map[k] || k;
}

function eventsPageTypeLabelSrv(ev = {}) {
  const key = eventsPageNormalizeTypeKeySrv(ev);

  const labels = {
    daily_milk: "لبن يومي",
    insemination: "تلقيح",
    vaccination: "تحصين",
    pregnancy_diagnosis: "تشخيص حمل",
    calving: "ولادة",
    heat: "شياع",
    dry_off: "تجفيف",
    abortion: "إجهاض",
    weaning: "فطام",
    hoof_trimming: "تقليم الحوافر",
    feces_eval: "تقييم الروث",
    bcs_eval: "فحص حالة الجسم",
    sale: "بيع",
    death: "نفوق",
    cull: "استبعاد",
    health: "مرض",
    ovsynch: "تزامن",
    close_up: "تحضير ولادة"
  };

  const rawAr = String(eventsPagePickSrv(ev, ["eventType", "type"], "")).trim();
  return rawAr || labels[key] || "حدث";
}

function eventsPageDetailsSrv(ev = {}) {
  const key = eventsPageNormalizeTypeKeySrv(ev);

  if (key === "insemination") {
    const at = eventsPagePickSrv(ev, ["inseminationTime", "time", "eventTime", "at", "وقت", "ساعة"], "");
    const method = eventsPagePickSrv(ev, ["inseminationMethod", "method", "طريقة"], "");
    const semen = eventsPagePickSrv(ev, ["semenCode", "strawCode", "straw", "القشة", "كود القشة"], "");
    const who = eventsPagePickSrv(ev, ["inseminator", "by", "الملقح"], "");
    const heat = eventsPagePickSrv(ev, ["heatStatus", "heatTime", "الشياع"], "");

    return [
      at ? `الوقت: ${at}` : "",
      method ? `الطريقة: ${method}` : "",
      semen ? `السائل/القشة: ${semen}` : "",
      who ? `الملقّح: ${who}` : "",
      heat ? `الشياع: ${heat}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "daily_milk") {
    const total = eventsPagePickSrv(ev, ["milkKg", "dailyMilk", "kg", "milk", "milkTotalKg", "totalMilkKg"], "");
    const sessions = Array.isArray(ev.milkSessions) ? ev.milkSessions : [];
    const sText = sessions.length
      ? `الحلبات: ${sessions.map(s => s?.kg ?? s?.milkKg ?? s?.value).filter(v => v != null).join("+")}`
      : "";

    return [
      total !== "" ? `إجمالي: ${total} كجم` : "",
      sessions.length ? `عدد الحلبات: ${sessions.length}` : "",
      sText
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "vaccination") {
    const v = eventsPagePickSrv(ev, ["vaccine", "vaccineName", "vaccineKey"], "");
    const dose = eventsPagePickSrv(ev, ["doseType", "dose", "جرعة"], "");

    return [
      v ? `اللقاح: ${v}` : "",
      dose ? `الجرعة: ${dose}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "pregnancy_diagnosis") {
    const method = eventsPagePickSrv(ev, ["method", "طريقة"], "");
    const result = eventsPagePickSrv(ev, ["result", "النتيجة"], "");
    const vet = eventsPagePickSrv(ev, ["vet", "doctor", "الطبيب"], "");

    return [
      method ? `الطريقة: ${method}` : "",
      result ? `النتيجة: ${result}` : "",
      vet ? `الطبيب: ${vet}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "calving") {
    const kind = eventsPagePickSrv(ev, ["calvingKind"], "");
    const cnt = eventsPagePickSrv(ev, ["calfCount"], "");
    const calfId = eventsPagePickSrv(ev, ["calfId"], "");

    return [
      kind ? `الولادة: ${kind}` : "",
      cnt ? `عدد العجول: ${cnt}` : "",
      calfId ? `رقم العجل: ${calfId}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "abortion") {
    const cause = eventsPagePickSrv(ev, ["probableCause", "cause", "reason", "سبب", "السبب"], "");
    const age = eventsPagePickSrv(ev, ["abortionAgeMonths", "ageMonths"], "");
    const lastAI = eventsPagePickSrv(ev, ["lastInseminationDate"], "");

    return [
      cause ? `السبب المحتمل: ${cause}` : "",
      age !== "" ? `عمر الحمل: ${age} شهر` : "",
      lastAI ? `آخر تلقيح: ${lastAI}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "dry_off") {
    const reason = eventsPagePickSrv(ev, ["reason", "سبب", "السبب"], "");
    const ab = eventsPagePickSrv(ev, ["usedDryingAntibiotics", "dryingAntibiotics"], "");
    const preg = eventsPagePickSrv(ev, ["pregnancyStatus", "reproStatus"], "");
    const dt = eventsPagePickSrv(ev, ["dryOffDate", "eventDate"], "");

    return [
      dt ? `تاريخ: ${dt}` : "",
      preg ? `الحالة: ${preg}` : "",
      reason ? `السبب: ${reason}` : "",
      ab ? `مضاد تجفيف: ${ab}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "hoof_trimming") {
    const notes = eventsPagePickSrv(ev, ["notes", "note", "description"], "");
    return notes ? `ملاحظة: ${notes}` : "تقليم الحوافر";
  }

  if (key === "feces_eval") {
    const score = eventsPagePickSrv(ev, ["fecesScore", "value"], "");
    const desc = eventsPagePickSrv(ev, ["description", "note", "notes", "ملاحظة"], "");

    return [
      score !== "" ? `الدرجة: ${score}` : "",
      desc ? `الوصف: ${desc}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "health") {
    const name = eventsPagePickSrv(ev, ["diseaseName", "disease", "name"], "");
    const code = eventsPagePickSrv(ev, ["diseaseCode"], "");

    return [
      name ? `المرض: ${name}` : "",
      code ? `الكود: ${code}` : ""
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "ovsynch") {
    const prog = eventsPagePickSrv(ev, ["program", "type"], "");
    const start = eventsPagePickSrv(ev, ["startDate", "eventDate"], "");
    const steps = Array.isArray(ev.steps) ? ev.steps : [];
    const next = steps.find(s => !s?.done);
    const nextTxt = next ? `التالي: ${next.name} (${next.date || ""})` : "";

    return [
      prog ? `البرنامج: ${prog}` : "",
      start ? `البداية: ${start}` : "",
      nextTxt
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "cull") {
    const r = eventsPagePickSrv(ev, ["reason", "cullMain", "cullDetail"], "");
    return r ? `السبب: ${r}` : "استبعاد";
  }

  if (key === "sale") {
    const price = eventsPagePickSrv(ev, ["price"], "");
    const reason = String(eventsPagePickSrv(ev, ["saleReason", "reason", "notes", "note"], "")).trim();

    return [
      price !== "" ? `السعر: ${price}` : "",
      reason ? `السبب: ${reason}` : "السبب: غير مسجل"
    ].filter(Boolean).join(" — ") || "—";
  }

  if (key === "death") {
    const reason = eventsPagePickSrv(ev, ["deathReason", "reason", "notes", "note"], "");
    return reason ? `السبب: ${reason}` : "نفوق";
  }

  if (key === "close_up") {
    const ration = eventsPagePickSrv(ev, ["ration"], "");
    const an = eventsPagePickSrv(ev, ["anionicSalts"], "");

    return [
      ration ? `عليقة: ${ration}` : "",
      an ? `أملاح أنيونية: ${an}` : ""
    ].filter(Boolean).join(" — ") || "تحضير ولادة";
  }

  if (key === "milking_traits_eval" || key === "milking_traits") {
    const score = eventsPagePickSrv(ev, ["kpi.overallScore", "overallScore"], "");
    return score !== "" ? `الدرجة الكلية: ${score}` : "تقييم صفات اللبن";
  }

  const note = eventsPagePickSrv(ev, ["note", "notes", "ملاحظة", "description"], "");
  const result = eventsPagePickSrv(ev, ["result", "النتيجة"], "");

  return [note, result].filter(Boolean).join(" — ") || "—";
}

function eventsPageEventAnimalNumberSrv(ev = {}) {
  return String(eventsPagePickSrv(ev, [
    "animalNumber",
    "number",
    "animalId",
    "animalID",
    "calfNumber"
  ], "")).trim();
}

function eventsPageRowSrv(docId, ev = {}) {
  const eventDate = eventsPageDateSrv(
    eventsPagePickSrv(ev, ["eventDate", "date", "dt"], "")
  );

  return {
    id: docId,
    eventDate,
    animalNumber: eventsPageEventAnimalNumberSrv(ev),
    typeKey: eventsPageNormalizeTypeKeySrv(ev),
    typeLabel: eventsPageTypeLabelSrv(ev),
    details: eventsPageDetailsSrv(ev)
  };
}

app.get("/api/events-page/list", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر تحميل قائمة الأحداث — قاعدة البيانات غير متاحة.",
        rows: []
      });
    }

    const uid = req.userId;
    const number = eventsPageParseNumbersSrv(
      req.query.number ||
      req.query.animalNumber ||
      req.query.num ||
      req.query.n ||
      ""
    )[0] || "";

    const typeRaw = String(req.query.type || req.query.eventType || "").trim();

    if (!number) {
      return res.status(400).json({
        ok: false,
        error: "animal_number_required",
        message: "رقم الحيوان مطلوب لعرض قائمة الأحداث.",
        rows: []
      });
    }

    const snap = await db.collection("events")
      .where("userId", "==", uid)
      .orderBy("eventDate", "desc")
      .limit(300)
      .get();

    const rows = [];

    snap.forEach(doc => {
      const ev = doc.data() || {};
      const animalNumber = eventsPageEventAnimalNumberSrv(ev);

      if (String(animalNumber).trim() !== String(number).trim()) return;

      const row = eventsPageRowSrv(doc.id, ev);

      if (typeRaw && row.typeLabel !== typeRaw && row.typeKey !== typeRaw) return;

      rows.push(row);
    });

    return res.json({
      ok: true,
      number,
      type: typeRaw,
      count: rows.length,
      rows
    });

  } catch (e) {
    console.error("events-page-list failed", e);

    return res.status(500).json({
      ok: false,
      error: "events_page_list_failed",
      message: "تعذّر تحميل قائمة الأحداث الآن.",
      rows: []
    });
  }
});
// ============================================================
//                 NUTRITION: CENTRAL SAVE HELPERS
// ============================================================
function cleanObj(x){
  if (Array.isArray(x)) {
    return x
      .map(cleanObj)
      .filter(v => v !== undefined);
  }
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      const cv = cleanObj(v);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  if (x === undefined) return undefined;
  return x;
}

function asYMD(v){
  const s = String(v || '').trim();
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

function toNumOrNull(v){
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeNutritionContext(ctx = {}) {
  const speciesRaw = String(ctx.species || '').trim();
  let species = speciesRaw;
  if (/cow|بقر|بقرة|أبقار/i.test(speciesRaw)) species = 'بقر';
  if (/buffalo|جاموس/i.test(speciesRaw)) species = 'جاموس';

  const groupName = String(
    ctx.groupName ||
    ctx.group ||
    ctx.groupLabel ||
    ''
  ).trim() || null;

  const groupNumbers = Array.isArray(ctx.groupNumbers)
    ? ctx.groupNumbers.map(x => String(x || '').trim()).filter(Boolean)
    : null;

  return cleanObj({
    groupName,
    group: groupName,
    groupLabel: String(ctx.groupLabel || groupName || '').trim() || null,
    groupNumbers,
    groupMode: ctx.groupMode || null,
    groupType: ctx.groupType || null,
    groupContextSource: ctx.groupContextSource || null,
    headCount: toNumOrNull(ctx.headCount),

    species,
    breed: ctx.breed || null,
    daysInMilk: toNumOrNull(ctx.daysInMilk),
    avgMilkKg: toNumOrNull(ctx.avgMilkKg),

    earlyDry: !!ctx.earlyDry,
    closeUp: !!ctx.closeUp,
    pregnancyStatus: ctx.pregnancyStatus || null,
    pregnancyDays: toNumOrNull(ctx.pregnancyDays),
    daysToCalving: toNumOrNull(ctx.daysToCalving),

    bodyWeight: toNumOrNull(ctx.bodyWeight ?? ctx.bodyWeightKg),
    bodyWeightKg: toNumOrNull(ctx.bodyWeight ?? ctx.bodyWeightKg),

    cameraWeightKg: toNumOrNull(
      ctx.cameraWeightKg ?? ctx.estimatedWeightKg ?? ctx.weightEstimateKg
    ),

    groupBodyWeightKg: toNumOrNull(
      ctx.groupBodyWeightKg ?? ctx.representativeBodyWeightKg
    ),

    milkFatPct: toNumOrNull(ctx.milkFatPct),
    milkProteinPct: toNumOrNull(ctx.milkProteinPct),

     parity: toNumOrNull(ctx.parity ?? ctx.lactationNumber),
    lactationNumber: toNumOrNull(ctx.parity ?? ctx.lactationNumber),

    frameGainKgDay: toNumOrNull(
      ctx.frameGainKgDay ??
      ctx.frameGain ??
      ctx.targetFrameGainKgDay ??
      ctx.frmGainTarget
    ),

    dietNDFPct: toNumOrNull(ctx.dietNDFPct),

    thi: toNumOrNull(ctx.thi),

    bcs: toNumOrNull(ctx.bcs),
    groupBcs: toNumOrNull(ctx.groupBcs ?? ctx.representativeBcs),

    observedAvgMilkKg: toNumOrNull(ctx.observedAvgMilkKg),
    milkMin: toNumOrNull(ctx.milkMin),
    milkMax: toNumOrNull(ctx.milkMax),
    milkSd: toNumOrNull(ctx.milkSd),
    milkCvPct: toNumOrNull(ctx.milkCvPct),

    groupNutritionProfile: ctx.groupNutritionProfile || null,
    homogeneity: ctx.homogeneity || null,
    formulationTarget: ctx.formulationTarget || null
  });
}

function normalizeNutritionAnalysis(a = {}) {
  return cleanObj({
   totals: {
  asFedKg: toNumOrNull(a?.totals?.asFedKg),
  dmKg: toNumOrNull(a?.totals?.dmKg),
  totCost: toNumOrNull(a?.totals?.totCost),
  mixPriceDM: toNumOrNull(a?.totals?.mixPriceDM),
  mixPriceAsFed: toNumOrNull(a?.totals?.mixPriceAsFed)
},
  nutrition: {
  cpPctTotal: toNumOrNull(a?.nutrition?.cpPctTotal),
  mpSupplyG: toNumOrNull(a?.nutrition?.mpSupplyG),
  mpDensityGkgDM: toNumOrNull(a?.nutrition?.mpDensityGkgDM),
  mpBalanceG: toNumOrNull(a?.nutrition?.mpBalanceG),
  fcRatio: toNumOrNull(a?.nutrition?.fcRatio),
  nelActual: toNumOrNull(a?.nutrition?.nelActual),
  nelDensity: toNumOrNull(a?.nutrition?.nelDensity),
  ndfPctActual: toNumOrNull(a?.nutrition?.ndfPctActual),
    peNDFPctActual: toNumOrNull(a?.nutrition?.peNDFPctActual),
  fatPctActual: toNumOrNull(a?.nutrition?.fatPctActual),
  starchPctActual: toNumOrNull(a?.nutrition?.starchPctActual ?? a?.nutrition?.starchPct),
 roughPctDM: toNumOrNull(a?.nutrition?.roughPctDM),
concPctDM: toNumOrNull(a?.nutrition?.concPctDM),
forageNDFPctDM: toNumOrNull(a?.nutrition?.forageNDFPctDM),
forageNDFShareOfTotalNDF: toNumOrNull(a?.nutrition?.forageNDFShareOfTotalNDF),
  rumenStatus: a?.nutrition?.rumenStatus || null,
  rumenNote: a?.nutrition?.rumenNote || null,

mineralSupplyModel: a?.nutrition?.mineralSupplyModel || null,
vitaminSupplyModel: a?.nutrition?.vitaminSupplyModel || null,
dcadModel: a?.nutrition?.dcadModel || null,
proteinModel: a?.nutrition?.proteinModel || null,
energySupplyModel: a?.nutrition?.energySupplyModel || null,
fatModel: a?.nutrition?.fatModel || null,
carbohydrateModel: a?.nutrition?.carbohydrateModel || null,
carbohydrateSafetyModel: a?.nutrition?.carbohydrateSafetyModel || null,
rumenHealthModel: a?.nutrition?.rumenHealthModel || null,
dmiRationEffect: a?.nutrition?.dmiRationEffect || null
    
},
targets: {
  dmiTarget: toNumOrNull(a?.targets?.dmiTarget),
  nelTarget: toNumOrNull(a?.targets?.nelTarget),
  cpReferencePct: toNumOrNull(a?.targets?.cpReferencePct ?? a?.targets?.cpTarget),
  mpTargetG: toNumOrNull(a?.targets?.mpTargetG),
  ndfTarget: toNumOrNull(a?.targets?.ndfTarget),
  fatTarget: toNumOrNull(a?.targets?.fatTarget),
  starchMax: toNumOrNull(a?.targets?.starchMax),
  roughageMin: toNumOrNull(a?.targets?.roughageMin),
  peNDFMin: toNumOrNull(a?.targets?.peNDFMin),
  forageNDFMin: toNumOrNull(a?.targets?.forageNDFMin),

    proteinRequirementModel: a?.targets?.proteinRequirementModel || null,
  mineralRequirementModel: a?.targets?.mineralRequirementModel || null,
  vitaminRequirementModel: a?.targets?.vitaminRequirementModel || null,
  chapter12EnergyModel: a?.targets?.chapter12EnergyModel || null,
  chapter12ProteinModel: a?.targets?.chapter12ProteinModel || null,
  chapter12MineralModel: a?.targets?.chapter12MineralModel || null,
  chapter12VitaminModel: a?.targets?.chapter12VitaminModel || null
},
       economics: {
      costPerKgMilk: toNumOrNull(a?.economics?.costPerKgMilk),
      dmPerKgMilk: toNumOrNull(a?.economics?.dmPerKgMilk),
      milkRevenue: toNumOrNull(a?.economics?.milkRevenue),
      milkMargin: toNumOrNull(a?.economics?.milkMargin),

      ecmKg: toNumOrNull(a?.economics?.ecmKg),
      fpcmKg: toNumOrNull(a?.economics?.fpcmKg),

      feedCostPctOfMilkIncome: toNumOrNull(a?.economics?.feedCostPctOfMilkIncome),
      iofcPctOfMilkIncome: toNumOrNull(a?.economics?.iofcPctOfMilkIncome),

      feedEfficiencyECM: toNumOrNull(a?.economics?.feedEfficiencyECM),
      feedEfficiencyFPCM: toNumOrNull(a?.economics?.feedEfficiencyFPCM),

      economicDecision: a?.economics?.economicDecision || null
    },
             inputs: {
      bodyWeightKgUsed: toNumOrNull(a?.inputs?.bodyWeightKgUsed),
      milkPriceUsed: toNumOrNull(a?.inputs?.milkPriceUsed),
      bodyWeightSource: a?.inputs?.bodyWeightSource || null,
      bcsSource: a?.inputs?.bcsSource || null,
      representativeWarning: a?.inputs?.representativeWarning || null,
      milkFatPctUsed: toNumOrNull(a?.inputs?.milkFatPctUsed),
      milkProteinPctUsed: toNumOrNull(a?.inputs?.milkProteinPctUsed),
      lactationNumberUsed: toNumOrNull(a?.inputs?.lactationNumberUsed),
      thiUsed: toNumOrNull(a?.inputs?.thiUsed),
      bcsUsed: toNumOrNull(a?.inputs?.bcsUsed),
      buffaloMilkEnergyFactor: toNumOrNull(a?.inputs?.buffaloMilkEnergyFactor),
      buffaloDmiFactor: toNumOrNull(a?.inputs?.buffaloDmiFactor)
    }
  });
}
function emptyFeedBand() {
  return {
    headCount: 0,
    avgMilkKg: 0,
    totalMilkKg: 0,
    feedCostPerLiter: 0,
    feedEfficiency: 0,
    feedCostPerHeadPerDay: 0,
    totalFeedCost: 0,
    totalMilkRevenue: 0,
    iofc: 0,
    totalMargin: 0,
    eventDate: null
  };
}

function feedBandKey(raw = '') {
  const s = String(raw || '').trim().toLowerCase();

  if (/fresh|حديث الولادة|فريش|ولادة حديثة/.test(s)) return 'fresh';
  if (/high|عالي/.test(s)) return 'high';
  if (/medium|med|متوسط/.test(s)) return 'medium';
  if (/low|منخفض/.test(s)) return 'low';

  return 'overall';
}

function buildFeedBandFromEvent(e = {}, officialHeadCount = null) {
  const a = e?.nutrition?.analysis || {};
  const ctx = e?.nutrition?.context || {};
  const economics = a?.economics || {};
  const totals = a?.totals || {};
  const inputs = a?.inputs || {};

const headCount = Number.isFinite(Number(officialHeadCount)) && Number(officialHeadCount) > 0
  ? Number(officialHeadCount)
  : (
      Number(
        e?.groupSize ??
        ctx?.headCount ??
        (Array.isArray(ctx?.groupNumbers) ? ctx.groupNumbers.length : null) ??
        1
      ) || 1
    );

  const avgMilkKg = Number(
    ctx?.avgMilkKg ??
    ctx?.observedAvgMilkKg ??
    0
  ) || 0;

  const feedCostPerHeadPerDay = Number(totals?.totCost || 0) || 0;

  const milkRevenuePerHead = Number.isFinite(Number(economics?.milkRevenue))
    ? Number(economics.milkRevenue)
    : (
        Number.isFinite(Number(inputs?.milkPriceUsed)) && avgMilkKg > 0
          ? Number(inputs.milkPriceUsed) * avgMilkKg
          : 0
      );

  const marginPerHead = Number.isFinite(Number(economics?.milkMargin))
    ? Number(economics.milkMargin)
    : (milkRevenuePerHead - feedCostPerHeadPerDay);

  const totalMilkKg = +(headCount * avgMilkKg).toFixed(2);
  const totalFeedCost = +(headCount * feedCostPerHeadPerDay).toFixed(2);
  const totalMilkRevenue = +(headCount * milkRevenuePerHead).toFixed(2);
  const totalMargin = +(headCount * marginPerHead).toFixed(2);

const feedEfficiencyECM = Number(economics?.feedEfficiencyECM);
const feedEfficiencyFPCM = Number(economics?.feedEfficiencyFPCM);
const dmPerKgMilk = Number(economics?.dmPerKgMilk || 0);

const feedEfficiency =
  Number.isFinite(feedEfficiencyECM) && feedEfficiencyECM > 0
    ? +feedEfficiencyECM.toFixed(2)
    : (
        Number.isFinite(feedEfficiencyFPCM) && feedEfficiencyFPCM > 0
          ? +feedEfficiencyFPCM.toFixed(2)
          : (dmPerKgMilk > 0 ? +(1 / dmPerKgMilk).toFixed(2) : 0)
      );

  return {
    headCount,
    avgMilkKg: +avgMilkKg.toFixed(2),
    totalMilkKg,
    feedCostPerLiter: Number.isFinite(Number(economics?.costPerKgMilk))
      ? Number(economics.costPerKgMilk)
      : (totalMilkKg > 0 ? +(totalFeedCost / totalMilkKg).toFixed(2) : 0),
    feedEfficiency,
    feedCostPerHeadPerDay: +feedCostPerHeadPerDay.toFixed(2),
    totalFeedCost,
    totalMilkRevenue,
    iofc: +marginPerHead.toFixed(2),
    totalMargin,
    eventDate: e?.eventDate || e?.date || null
  };
}

function weightedFeedBands(cards = []) {
  const valid = cards.filter(x => x && Number(x.headCount) > 0);
  if (!valid.length) return emptyFeedBand();

  const totalHeads = valid.reduce((s, x) => s + Number(x.headCount || 0), 0) || 0;
  if (!totalHeads) return emptyFeedBand();

  const totalMilkKg = valid.reduce((s, x) => s + Number(x.totalMilkKg || 0), 0);
  const totalFeedCost = valid.reduce((s, x) => s + Number(x.totalFeedCost || 0), 0);
  const totalMilkRevenue = valid.reduce((s, x) => s + Number(x.totalMilkRevenue || 0), 0);
  const totalMargin = valid.reduce((s, x) => s + Number(x.totalMargin || 0), 0);

  const wavg = (key) => {
    const sum = valid.reduce((s, x) => s + (Number(x[key] || 0) * Number(x.headCount || 0)), 0);
    return +(sum / totalHeads).toFixed(2);
  };
 const feedCostPctOfMilkIncome =
  totalMilkRevenue > 0 ? +(totalFeedCost / totalMilkRevenue * 100).toFixed(2) : 0;

const iofcPctOfMilkIncome =
  totalMilkRevenue > 0 ? +(totalMargin / totalMilkRevenue * 100).toFixed(2) : 0;
  return {
    headCount: totalHeads,
    avgMilkKg: totalHeads ? +(totalMilkKg / totalHeads).toFixed(2) : 0,
    totalMilkKg: +totalMilkKg.toFixed(2),
    feedCostPerLiter: totalMilkKg > 0 ? +(totalFeedCost / totalMilkKg).toFixed(2) : 0,
    feedEfficiency: wavg('feedEfficiency'),
    feedCostPerHeadPerDay: totalHeads ? +(totalFeedCost / totalHeads).toFixed(2) : 0,
    totalFeedCost: +totalFeedCost.toFixed(2),
    totalFeedCostPerDay: +totalFeedCost.toFixed(2),

    totalMilkRevenue: +totalMilkRevenue.toFixed(2),
    totalMilkRevenuePerDay: +totalMilkRevenue.toFixed(2),

    iofc: totalHeads ? +(totalMargin / totalHeads).toFixed(2) : 0,
    totalMargin: +totalMargin.toFixed(2),
    totalIofc: +totalMargin.toFixed(2),
    totalMilkFeedMarginPerDay: +totalMargin.toFixed(2),

    feedCostPctOfMilkIncome,
    iofcPctOfMilkIncome,

    eventDate: null
  };
}
function buildDashboardFeedAdviceSrv(overall = {}) {
  const fe = Number(overall.feedEfficiency || 0);
  const iofcPct = Number(overall.iofcPctOfMilkIncome || 0);
  const costPct = Number(overall.feedCostPctOfMilkIncome || 0);

  if (!Number.isFinite(fe) || !Number.isFinite(iofcPct) || iofcPct <= 0) {
    return 'بيانات التغذية غير مكتملة؛ احفظ علائق الحلاب بسعر اللبن لتظهر قراءة مُرَبِّيك.';
  }

  if (fe > 1.8) {
    return 'كفاءة تحويل المادة الجافة مرتفعة جدًا؛ راجع حالة الجسم واحتمال الاعتماد على مخزون الجسم، واقرأها مع IOFC قبل أي قرار.';
  }

  if (fe < 1.3 && iofcPct < 40) {
    return 'كفاءة التحويل و IOFC ضعيفان؛ التغذية تضغط اقتصاد اللبن. افتح تقرير التغذية وابدأ بالمجموعة الأعلى تكلفة أو الأقل كفاءة.';
  }

  if (iofcPct >= 60 && fe >= 1.4 && fe <= 1.8) {
    return 'اقتصاد التغذية قوي؛ كفاءة التحويل داخل النطاق العلمي و IOFC قوي. حافظ على الاتزان ولا تخفض تكلفة العليقة إذا كان ذلك سيكسر الطاقة أو البروتين أو أمان الكرش.';
  }

  if (iofcPct >= 50 && fe >= 1.3) {
    return 'اقتصاد التغذية مقبول؛ راجع المجموعة الأعلى تكلفة أو الأقل كفاءة من تقرير التغذية قبل تعديل الخلطة.';
  }

  if (costPct > 60 || iofcPct < 40) {
    return 'تكلفة التغذية تضغط هامش اللبن. افتح تقرير التغذية وابدأ بالمجموعة الأعلى تكلفة قبل تغيير الخلطة.';
  }

  return 'تحتاج مؤشرات التغذية إلى متابعة؛ راجع كفاءة تحويل المادة الجافة و IOFC في تقرير التغذية.';
}
function buildDashboardFeedGaugeCardsSrv(overall = {}) {
  const fe = Number(overall.feedEfficiency || 0);
  const iofcPct = Number(overall.iofcPctOfMilkIncome || 0);
  const marginDay = Number(overall.totalMilkFeedMarginPerDay ?? overall.totalMargin ?? 0);

  const hasEconomicData =
    Number.isFinite(iofcPct) &&
    iofcPct > 0 &&
    Number.isFinite(marginDay);

  let iofcCard = {
    title: 'IOFC — هامش اللبن بعد العلف',
    metric: 'iofc',
    value: Number.isFinite(iofcPct) ? +iofcPct.toFixed(1) : null,
    valueText: Number.isFinite(iofcPct) && iofcPct > 0 ? `${iofcPct.toFixed(1)}%` : '—',
    state: 'neutral',
    stateLabel: 'غير مكتمل',
    message: 'احفظ علائق الحلاب بسعر اللبن لتظهر قراءة الاقتصاد.',
    subText: 'يعرض المتبقي من دخل اللبن بعد تكلفة العلف.',
    scaleText: 'المقياس: IOFC من دخل اللبن',
    pointerPct: 0,
    reference: 'IOFC = Milk income − Feed cost'
  };

  if (hasEconomicData) {
    if (iofcPct >= 60) {
      iofcCard.state = 'good';
      iofcCard.stateLabel = 'اقتصاد قوي';
      iofcCard.message = 'الهامش بعد العلف قوي؛ حافظ على الاتزان ولا تخفض جودة العليقة.';
    } else if (iofcPct >= 50) {
      iofcCard.state = 'ok';
      iofcCard.stateLabel = 'اقتصاد مقبول';
      iofcCard.message = 'قريب من المستوى القوي؛ راجع أعلى مجموعة تكلفة قبل تعديل الخلطة.';
    } else if (iofcPct >= 40) {
      iofcCard.state = 'warn';
      iofcCard.stateLabel = 'يحتاج متابعة';
      iofcCard.message = 'الهامش تحت الضغط؛ راجع تكلفة العليقة وسعر اللبن في التقرير.';
    } else {
      iofcCard.state = 'danger';
      iofcCard.stateLabel = 'خطر اقتصادي';
      iofcCard.message = 'هامش اللبن بعد العلف ضعيف؛ افتح تقرير التغذية قبل الاعتماد.';
    }

    iofcCard.subText = `${marginDay.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} جنيه / يوم`;
    iofcCard.pointerPct = Math.max(0, Math.min(100, (iofcPct / 80) * 100));
  }

  let feCard = {
    title: 'كفاءة تحويل المادة الجافة إلى لبن',
    metric: 'feedEfficiency',
    value: Number.isFinite(fe) ? +fe.toFixed(2) : null,
    valueText: Number.isFinite(fe) && fe > 0 ? fe.toFixed(2) : '—',
    state: 'neutral',
    stateLabel: 'غير مكتمل',
    message: 'احفظ علائق الحلاب مع المادة الجافة واللبن لتظهر قراءة الكفاءة.',
    subText: 'ECM / كجم مادة جافة',
    scaleText: 'المقياس: ECM ÷ DMI',
    pointerPct: 0,
    reference: 'Feed efficiency = ECM / DMI'
  };

  if (Number.isFinite(fe) && fe > 0) {
    if (fe > 1.8) {
      feCard.state = 'watch';
      feCard.stateLabel = 'مرتفع جدًا';
      feCard.message = 'الكفاءة مرتفعة جدًا؛ اقرأها مع IOFC وحالة الجسم لاحتمال السحب من الجسم.';
    } else if (fe >= 1.45) {
      feCard.state = 'good';
      feCard.stateLabel = 'كفاءة مناسبة';
      feCard.message = 'كفاءة التحويل داخل النطاق العملي؛ حافظ على الاتزان واقرأها مع IOFC.';
    } else if (fe >= 1.30) {
      feCard.state = 'warn';
      feCard.stateLabel = 'تحتاج متابعة';
      feCard.message = 'الكفاءة أقل من النطاق العملي؛ راجع المادة الجافة والإنتاج قبل تعديل الخلطة.';
    } else {
      feCard.state = 'danger';
      feCard.stateLabel = 'كفاءة منخفضة';
      feCard.message = 'التحويل ضعيف؛ افتح تقرير التغذية وراجع DMI والإنتاج والتكلفة.';
    }

    feCard.pointerPct = Math.max(0, Math.min(100, ((fe - 1.0) / (2.0 - 1.0)) * 100));
  }

  return {
    iofc: iofcCard,
    feedEfficiency: feCard
  };
}
function normalizeNutritionRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => cleanObj({
    id: r?.id || null,
    name: r?.name || r?.feedName || null,
    cat: r?.cat || r?.category || null,
    asFedKg: toNumOrNull(r?.asFedKg ?? r?.kg ?? r?.amount),
    pct: toNumOrNull(r?.pct),
    dmPct: toNumOrNull(r?.dmPct ?? r?.dm),
    cpPct: toNumOrNull(r?.cpPct ?? r?.cp),
   pricePerTon: toNumOrNull(r?.pricePerTon ?? r?.pTon ?? r?.price ?? r?.pTonRaw),
    pricePerTonDM: toNumOrNull(r?.pricePerTonDM ?? r?.pTonDM),
nelMcalPerKgDM: toNumOrNull(r?.nelMcalPerKgDM ?? r?.nel),
mpGPerKgDM: toNumOrNull(r?.mpGPerKgDM ?? r?.mp),

// NASEM 2021 feed energy inputs
baseDEMcalPerKgDM: toNumOrNull(
  r?.baseDEMcalPerKgDM ??
  r?.baseDE ??
  r?.de ??
  r?.deMcalPerKgDM
),

// Carbohydrate / fiber / fat
ndfPct: toNumOrNull(r?.ndfPct ?? r?.ndf),
adfPct: toNumOrNull(r?.adfPct ?? r?.adf),
fatPct: toNumOrNull(r?.fatPct ?? r?.fat),
crudeFatPct: toNumOrNull(r?.crudeFatPct ?? r?.fatPct ?? r?.fat),
faPct: toNumOrNull(r?.faPct ?? r?.fattyAcidsPct ?? r?.totalFaPct),
starchPct: toNumOrNull(r?.starchPct ?? r?.starch),
wscPct: toNumOrNull(r?.wscPct ?? r?.waterSolubleCarbsPct),
ndsfPct: toNumOrNull(r?.ndsfPct ?? r?.neutralDetergentSolubleFiberPct),
ligninPct: toNumOrNull(r?.ligninPct),

// Digestibility fields for NASEM energy / microbial protein
forageNdfDigestibilityPct: toNumOrNull(
  r?.forageNdfDigestibilityPct ??
  r?.fNDFD ??
  r?.ndfDigestibilityPct ??
  r?.ndfd
),

fNDFD: toNumOrNull(
  r?.fNDFD ??
  r?.forageNdfDigestibilityPct ??
  r?.ndfDigestibilityPct ??
  r?.ndfd
),

rumDigNdfPctOfNdf: toNumOrNull(
  r?.rumDigNdfPctOfNdf ??
  r?.rumenDigestedNdfPctOfNdf ??
  r?.ruminalNdfDigestibilityPct ??
  r?.rumenNdfDigestibilityPct
),

rumDigStarchPctOfStarch: toNumOrNull(
  r?.rumDigStarchPctOfStarch ??
  r?.rumenDigestedStarchPctOfStarch ??
  r?.ruminalStarchDigestibilityPct ??
  r?.rumenStarchDigestibilityPct ??
  r?.starchDigestibilityPct
),

starchDigestibilityPct: toNumOrNull(
  r?.starchDigestibilityPct ??
  r?.rumDigStarchPctOfStarch ??
  r?.rumenDigestedStarchPctOfStarch
),

faDigestibilityCoeff: toNumOrNull(r?.faDigestibilityCoeff ?? r?.faDigestibility ?? r?.faDigCoeff),
faSourceClass: r?.faSourceClass ?? r?.fatSourceClass ?? r?.fatClass ?? null,

caPct: toNumOrNull(r?.caPct ?? r?.calciumPct),
pPct: toNumOrNull(r?.pPct ?? r?.phosphorusPct),
mgPct: toNumOrNull(r?.mgPct ?? r?.magnesiumPct),
naPct: toNumOrNull(r?.naPct ?? r?.sodiumPct),
kPct: toNumOrNull(r?.kPct ?? r?.potassiumPct),
clPct: toNumOrNull(r?.clPct ?? r?.chloridePct),
sPct: toNumOrNull(r?.sPct ?? r?.sulfurPct ?? r?.sulphurPct),
caAbsCoeff: toNumOrNull(r?.caAbsCoeff ?? r?.caAbsorptionCoeff),
pAbsCoeff: toNumOrNull(r?.pAbsCoeff ?? r?.pAbsorptionCoeff),
mgAbsCoeff: toNumOrNull(r?.mgAbsCoeff ?? r?.mgAbsorptionCoeff),
naAbsCoeff: toNumOrNull(r?.naAbsCoeff ?? r?.naAbsorptionCoeff),
kAbsCoeff: toNumOrNull(r?.kAbsCoeff ?? r?.kAbsorptionCoeff),
clAbsCoeff: toNumOrNull(r?.clAbsCoeff ?? r?.clAbsorptionCoeff),
sAbsCoeff: toNumOrNull(r?.sAbsCoeff ?? r?.sAbsorptionCoeff),
vitAIUPerKgDM: toNumOrNull(r?.vitAIUPerKgDM ?? r?.vitaminAIUPerKgDM),
vitDIUPerKgDM: toNumOrNull(r?.vitDIUPerKgDM ?? r?.vitaminDIUPerKgDM),
vitEIUPerKgDM: toNumOrNull(r?.vitEIUPerKgDM ?? r?.vitaminEIUPerKgDM),

adfPct: toNumOrNull(r?.adfPct ?? r?.adf),
ashPct: toNumOrNull(r?.ashPct ?? r?.ash),

solubleProteinPctCP: toNumOrNull(
  r?.solubleProteinPctCP ??
  r?.solubleProtein ??
  r?.solubleCP
),

proteinAFractionPctCP: toNumOrNull(
  r?.proteinAFractionPctCP ??
  r?.proteinA ??
  r?.aFractionPctCP
),

proteinBFractionPctCP: toNumOrNull(
  r?.proteinBFractionPctCP ??
  r?.proteinB ??
  r?.bFractionPctCP
),

proteinBKdPctPerHour: toNumOrNull(
  r?.proteinBKdPctPerHour ??
  r?.proteinBKd ??
  r?.kdProteinB
),

proteinCFractionPctCP: toNumOrNull(
  r?.proteinCFractionPctCP ??
  r?.proteinC ??
  r?.cFractionPctCP
),

rdpPctCP: toNumOrNull(r?.rdpPctCP ?? r?.rdpPctOfCP ?? r?.rdp),
rupPctCP: toNumOrNull(r?.rupPctCP ?? r?.rupPctOfCP ?? r?.rup),
rupDigestibilityPct: toNumOrNull(r?.rupDigestibilityPct ?? r?.digestibleRupPct ?? r?.dRUPPct),

wscPct: toNumOrNull(r?.wscPct ?? r?.waterSolubleCarbsPct ?? r?.waterSolubleCarbohydratesPct),

faPct: toNumOrNull(r?.faPct ?? r?.fattyAcidsPct ?? r?.totalFaPct ?? r?.totalFAPct),
faSourceClass: r?.faSourceClass || r?.fatSourceClass || r?.fatClass || null,
faProfilePctTFA: r?.faProfilePctTFA || null,

forageNdfDigestibilityPct: toNumOrNull(r?.forageNdfDigestibilityPct),
fNDFD: toNumOrNull(r?.fNDFD ?? r?.forageNdfDigestibilityPct ?? r?.ndfd ?? r?.ndfDigestibilityPct),

rumDigNdfPctOfNdf: toNumOrNull(r?.rumDigNdfPctOfNdf ?? r?.rumenDigestedNdfPctOfNdf ?? r?.ruminalNdfDigestibilityPct ?? r?.rumenNdfDigestibilityPct),
rumDigStarchPctOfStarch: toNumOrNull(r?.rumDigStarchPctOfStarch ?? r?.rumenDigestedStarchPctOfStarch ?? r?.ruminalStarchDigestibilityPct ?? r?.rumenStarchDigestibilityPct),

aaProfilePctCP: r?.aaProfilePctCP || null,
aaProfilePctTP: r?.aaProfilePctTP || null,
aaProfile: r?.aaProfile || null,

coMgKgDM: toNumOrNull(r?.coMgKgDM),
cuMgKgDM: toNumOrNull(r?.cuMgKgDM),
feMgKgDM: toNumOrNull(r?.feMgKgDM),
iMgKgDM: toNumOrNull(r?.iMgKgDM),
mnMgKgDM: toNumOrNull(r?.mnMgKgDM),
seMgKgDM: toNumOrNull(r?.seMgKgDM),
znMgKgDM: toNumOrNull(r?.znMgKgDM),
moMgKgDM: toNumOrNull(r?.moMgKgDM),

coAbsCoeff: toNumOrNull(r?.coAbsCoeff ?? r?.coAbsorptionCoeff),
cuAbsCoeff: toNumOrNull(r?.cuAbsCoeff ?? r?.cuAbsorptionCoeff),
feAbsCoeff: toNumOrNull(r?.feAbsCoeff ?? r?.feAbsorptionCoeff),
iAbsCoeff: toNumOrNull(r?.iAbsCoeff ?? r?.iAbsorptionCoeff),
mnAbsCoeff: toNumOrNull(r?.mnAbsCoeff ?? r?.mnAbsorptionCoeff),
seAbsCoeff: toNumOrNull(r?.seAbsCoeff ?? r?.seAbsorptionCoeff),
znAbsCoeff: toNumOrNull(r?.znAbsCoeff ?? r?.znAbsorptionCoeff)
  }));
}
function feedKeySrv(v){
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/\s+/g, ' ');
}

function pickFeedIdFromRowSrv(r = {}){
  return String(
    r.feedId ||
    r.itemId ||
    r.feedItemId ||
    r.id ||
    ''
  ).trim();
}

async function enrichNutritionRowsFromFeedItems(tenant, rawRows = []) {
  if (!db || !Array.isArray(rawRows) || !rawRows.length) return rawRows;

  try {
    const byId = new Map();
    const byName = new Map();

    const addFeedDoc = (doc) => {
      const d = doc.data() || {};
      if (d.enabled === false) return;

      const feed = {
        id: doc.id,
        feedId: doc.id,
        ...d
      };

      byId.set(doc.id, feed);

      [
        d.nameAr,
        d.name,
        d.userLabel,
        d.sourceFeedName,
        doc.id
      ].forEach(x => {
        const k = feedKeySrv(x);
        if (k && !byName.has(k)) byName.set(k, feed);
      });
    };

    const publicSnap = await db.collection('feed_items').get();
    publicSnap.forEach(addFeedDoc);

    if (tenant) {
      const customSnap = await db.collection('custom_feed_items')
        .where('userId', '==', tenant)
        .get();

      customSnap.forEach(addFeedDoc);
    }

    return rawRows.map(r => {
      const row = r || {};
      const explicitId = pickFeedIdFromRowSrv(row);

      const feed =
        (explicitId && byId.get(explicitId)) ||
        byName.get(feedKeySrv(row.name || row.feedName || row.nameAr || row.userLabel)) ||
        null;

      if (!feed) return row;

      const amountPatch = {
        asFedKg: row.asFedKg ?? row.kg ?? row.amount,
        kg: row.kg ?? row.asFedKg ?? row.amount,
        amount: row.amount,
        pct: row.pct,
        pricePerTon: row.pricePerTon ?? row.pTon ?? row.price ?? row.pTonRaw,
        pTon: row.pTon,
        price: row.price,
        pTonRaw: row.pTonRaw,
        pricePerTonDM: row.pricePerTonDM ?? row.pTonDM,
        pTonDM: row.pTonDM
      };

      return cleanObj({
        ...row,
        ...feed,

        id: feed.id || explicitId || row.id || null,
        feedId: feed.id || explicitId || row.feedId || null,
        name: row.name || feed.nameAr || feed.userLabel || feed.name || null,
        nameAr: feed.nameAr || row.nameAr || row.name || null,
        cat: row.cat || feed.cat || feed.category || null,

        ...amountPatch,

        _feedLibraryMerged: true,
        _feedLibrarySource: feed.source || null
      });
    });
  } catch (e) {
    console.error('nutrition feed_items/custom_feed_items merge failed:', e.message || e);
    return rawRows;
  }
}
function round2(v){
  return Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null;
}
const BREED_NUTRITION_DEFAULTS = {
  holstein:               { bodyWeightKg: 650, milkFatPct: 3.7, milkProteinPct: 3.2 },
  montbeliarde:           { bodyWeightKg: 680, milkFatPct: 4.0, milkProteinPct: 3.4 },
  simmental:              { bodyWeightKg: 700, milkFatPct: 4.1, milkProteinPct: 3.5 },

  buffalo_masry:          { bodyWeightKg: 525, milkFatPct: 6.8, milkProteinPct: 4.2 },
  buffalo_italian_cross:  { bodyWeightKg: 610, milkFatPct: 7.2, milkProteinPct: 4.4 },
  buffalo_murrah_cross:   { bodyWeightKg: 650, milkFatPct: 7.5, milkProteinPct: 4.5 },

  default_cow:            { bodyWeightKg: 650, milkFatPct: 3.7, milkProteinPct: 3.2 },
   default_buffalo:        { bodyWeightKg: 560, milkFatPct: 7.0, milkProteinPct: 4.3 }
};

function pickFirstFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeBreedKey(species, breed = '') {
  const s = String(species || '').trim().toLowerCase();
  const b = String(breed || '').trim().toLowerCase();

  if (/holstein|هولشتاين|هولستين/.test(b)) return 'holstein';
  if (/montbeliarde|مونتبليارد|مونتبليارده/.test(b)) return 'montbeliarde';
  if (/simmental|سيمنتال|سمنتال/.test(b)) return 'simmental';

  if (/جاموس|buffalo/.test(s)) {
    if (/مورا|murrah/.test(b)) return 'buffalo_murrah_cross';
    if (/ايطال|ital/i.test(b)) return 'buffalo_italian_cross';
    if (/مصري|masry|egypt/i.test(b)) return 'buffalo_masry';
    return 'default_buffalo';
  }

  return 'default_cow';
}

function getBreedNutritionDefaults(species, breed) {
  const key = normalizeBreedKey(species, breed);
  return BREED_NUTRITION_DEFAULTS[key] || BREED_NUTRITION_DEFAULTS.default_cow;
}


function isBuffaloSpecies(species = '') {
  return /جاموس|buffalo/i.test(String(species || '').trim());
}

function getBuffaloDmiFactor(species, breed = '') {
  if (!isBuffaloSpecies(species)) return 1;

  const b = String(breed || '').toLowerCase();
  if (/مورا|murrah/.test(b)) return 1.03;
  if (/ايطال|ital/i.test(b)) return 1.02;
  if (/مصري|masry|egypt/i.test(b)) return 0.98;

  return 1.00;
}

function getBuffaloMilkEnergyFactor(species, breed = '') {
  if (!isBuffaloSpecies(species)) return 1;

  const b = String(breed || '').toLowerCase();
  if (/مورا|murrah/.test(b)) return 1.12;
  if (/ايطال|ital/i.test(b)) return 1.10;
  if (/مصري|masry|egypt/i.test(b)) return 1.08;

  return 1.10;
}

function applyBuffaloNutritionRules(targetsCore = {}, context = {}) {
  if (!isBuffaloSpecies(context?.species)) return targetsCore;

  const milkKg = Number(context?.avgMilkKg || 0);

  let cpTarget = 12;
  if (milkKg >= 8 && milkKg < 12) cpTarget = 13;
  else if (milkKg >= 12 && milkKg < 16) cpTarget = 14;
  else if (milkKg >= 16) cpTarget = 15;

  targetsCore.cpTarget = cpTarget;
  targetsCore.ndfTarget = 34;
  targetsCore.starchMax = 22;
  targetsCore.roughageMin = 50;

  return targetsCore;
}


function deriveNutritionRuntimeContext(context = {}) {
  const breedDefaults = getBreedNutritionDefaults(context.species, context.breed);

  const isGroupContext =
    String(context.groupMode || '').toLowerCase() === 'group' ||
    Number(context.headCount || 0) > 1 ||
    String(context.groupContextSource || '').trim() !== '';

  const standardBodyWeightKg = getStandardWeight(context.species, context.breed);

  const hasUserBodyWeight =
    Number.isFinite(Number(context.bodyWeightKg)) ||
    Number.isFinite(Number(context.bodyWeight));

  const hasGroupBodyWeight =
    Number.isFinite(Number(context.groupBodyWeightKg));

  const bodyWeightKgUsed = pickFirstFinite(
    context.bodyWeightKg,
    context.bodyWeight,
    context.cameraWeightKg,
    context.groupBodyWeightKg,
    standardBodyWeightKg,
    breedDefaults.bodyWeightKg
  );

  const bodyWeightSource =
    hasUserBodyWeight ? 'user_body_weight' :
    Number.isFinite(Number(context.cameraWeightKg)) ? 'camera_weight' :
    hasGroupBodyWeight ? 'group_representative_body_weight_input' :
    Number.isFinite(Number(standardBodyWeightKg)) ? 'standard_weight_fallback' :
    'breed_default_fallback';

  const milkFatPctUsed = pickFirstFinite(
    context.milkFatPct,
    breedDefaults.milkFatPct
  );

  const milkProteinPctUsed = pickFirstFinite(
    context.milkProteinPct,
    breedDefaults.milkProteinPct
  );

  const lactationNumberUsed = pickFirstFinite(
    context.lactationNumber,
    3
  );

  const thiUsed = pickFirstFinite(
    context.thi
  );

  const hasBcsInput =
    Number.isFinite(Number(context.bcs)) ||
    Number.isFinite(Number(context.groupBcs));

  const bcsUsed = pickFirstFinite(
    context.bcs,
    context.groupBcs,
    isGroupContext ? 3.0 : null
  );

  const bcsSource =
    Number.isFinite(Number(context.bcs)) ? 'user_bcs' :
    Number.isFinite(Number(context.groupBcs)) ? 'group_representative_bcs_input' :
    isGroupContext ? 'standard_bcs_fallback' :
    'not_available';

  const representativeWarning =
    isGroupContext && (!hasUserBodyWeight && !hasGroupBodyWeight || !hasBcsInput)
      ? 'تم استخدام وزن/BCS قياسي للمجموعة. إدخال وزن وBCS ممثلين يعطي تحليلًا أدق.'
      : null;

  return {
    breedDefaults,
    bodyWeightKgUsed,
    bodyWeightSource,
    bcsSource,
    representativeWarning,
    milkFatPctUsed,
    milkProteinPctUsed,
    lactationNumberUsed,
    thiUsed,
    bcsUsed
  };
}
function buildNutritionCentralTargets(context = {}) {
  const runtimeCtx = deriveNutritionRuntimeContext(context);

 let targetsCore = computeTargets({
  species: context.species,
  breed: context.breed,
  daysInMilk: context.daysInMilk,
  avgMilkKg: context.avgMilkKg,
  pregnancyDays: context.pregnancyDays,
  daysToCalving: context.daysToCalving,
  earlyDry: context.earlyDry,
  closeUp: context.closeUp,

  bodyWeight: runtimeCtx.bodyWeightKgUsed,
  milkFatPct: runtimeCtx.milkFatPctUsed,
  milkProteinPct: runtimeCtx.milkProteinPctUsed,
  parity: runtimeCtx.lactationNumberUsed,
  dietNDFPct: context.dietNDFPct,
  mineralDmi: context.mineralDmi,
  frameGainKgDay: context.frameGainKgDay,
  thi: runtimeCtx.thiUsed,
  bcs: runtimeCtx.bcsUsed
});



 return {
  targetsCore,
  runtimeCtx
};
}

function deriveDietNDFPctFromRows(rows = [], mode = 'tmr_asfed', concKg = null) {
  const cleanRows = Array.isArray(rows) ? rows : [];
  const modeNorm = String(mode || 'tmr_asfed').trim();

  let dmKg = 0;
  let ndfKg = 0;

  if (modeNorm === 'tmr_asfed') {
    for (const r of cleanRows) {
      const asFedKg = Number(r.asFedKg || 0);
      const dmPct = Number(r.dmPct || 0);
      const ndfPct = Number(r.ndfPct || 0);

      const rowDmKg = asFedKg * (dmPct / 100);
      dmKg += rowDmKg;
      ndfKg += rowDmKg * (ndfPct / 100);
    }
  }

  if (modeNorm === 'tmr_percent') {
    for (const r of cleanRows) {
      const pct = Number(r.pct || 0) / 100;
      const dmPct = Number(r.dmPct || 0);
      const ndfPct = Number(r.ndfPct || 0);

      const rowDmPart = pct * (dmPct / 100);
      dmKg += rowDmPart;
      ndfKg += rowDmPart * (ndfPct / 100);
    }
  }

  if (modeNorm === 'split') {
    const concKgNum = Number(concKg || 0);

    let concDmFrac = 0;
    let concNdfFrac = 0;

    for (const r of cleanRows) {
      const cat = String(r.cat || '').trim();
      const dmPct = Number(r.dmPct || 0);
      const ndfPct = Number(r.ndfPct || 0);

      if (cat === 'rough') {
        const asFedKg = Number(r.asFedKg || 0);
        const rowDmKg = asFedKg * (dmPct / 100);
        dmKg += rowDmKg;
        ndfKg += rowDmKg * (ndfPct / 100);
      }

      if (cat === 'conc') {
        const pct = Number(r.pct || 0) / 100;
        concDmFrac += pct * (dmPct / 100);
        concNdfFrac += pct * (dmPct / 100) * (ndfPct / 100);
      }
    }

    const concDmKg = concKgNum * concDmFrac;
    const concNdfKg = concKgNum * concNdfFrac;

    dmKg += concDmKg;
    ndfKg += concNdfKg;
  }

  if (!(dmKg > 0)) return null;

  const out = (ndfKg / dmKg) * 100;
  return Number.isFinite(out) ? round2(out) : null;
}
function deriveRationDmKgFromRows(rows = [], mode = 'tmr_asfed', concKg = null) {
  const cleanRows = Array.isArray(rows) ? rows : [];
  const modeNorm = String(mode || 'tmr_asfed').trim();

  let dmKg = 0;

  if (modeNorm === 'tmr_asfed') {
    for (const r of cleanRows) {
      const asFedKg = Number(r.asFedKg || 0);
      const dmPct = Number(r.dmPct || 0);
      dmKg += asFedKg * (dmPct / 100);
    }
  }

  if (modeNorm === 'split') {
    const concKgNum = Number(concKg || 0);
    let concDmFrac = 0;

    for (const r of cleanRows) {
      const cat = String(r.cat || '').trim();
      const dmPct = Number(r.dmPct || 0);

      if (cat === 'rough') {
        const asFedKg = Number(r.asFedKg || 0);
        dmKg += asFedKg * (dmPct / 100);
      }

      if (cat === 'conc') {
        const pct = Number(r.pct || 0) / 100;
        concDmFrac += pct * (dmPct / 100);
      }
    }

    dmKg += concKgNum * concDmFrac;
  }

  if (!(dmKg > 0)) return null;

  return round2(dmKg);
}
function buildNutritionCentralAnalysis({ rows = [], context = {}, mode = 'tmr_asfed', concKg = null, milkPrice = null }) {
  const cleanRows = Array.isArray(rows) ? rows : [];
const modeNorm = String(mode || 'tmr_asfed').trim();

const dietNDFPctFromRation = deriveDietNDFPctFromRows(
  cleanRows,
  modeNorm,
  concKg
);

const contextDietNDF = Number(context?.dietNDFPct);
const derivedDietNDF = Number(dietNDFPctFromRation);

const actualRationDmKg = deriveRationDmKgFromRows(
  cleanRows,
  modeNorm,
  concKg
);

const contextForTargets = {
  ...context,
  frameGainKgDay:
    Number.isFinite(Number(context?.frameGainKgDay)) && Number(context.frameGainKgDay) > 0
      ? Number(context.frameGainKgDay)
      : null,
  dietNDFPct:
    Number.isFinite(contextDietNDF) && contextDietNDF > 0
      ? contextDietNDF
      : (
          Number.isFinite(derivedDietNDF) && derivedDietNDF > 0
            ? derivedDietNDF
            : null
        ),
  mineralDmi:
    Number.isFinite(Number(actualRationDmKg)) && Number(actualRationDmKg) > 0
      ? Number(actualRationDmKg)
      : null
};

let builtTargets = buildNutritionCentralTargets(contextForTargets);
let runtimeCtx = builtTargets.runtimeCtx;
let targetsCore = builtTargets.targetsCore;

const rationCore = analyzeRation(
  cleanRows.map(r => ({
...r,

kg: r.asFedKg,
dm: r.dmPct,
cp: r.cpPct,

// Legacy values remain available, but NASEM engine does not depend on them as feed truth
mp: r.mpGPerKgDM,
nel: r.nelMcalPerKgDM,

// NASEM 2021 feed composition
baseDE: r.baseDEMcalPerKgDM,
baseDEMcalPerKgDM: r.baseDEMcalPerKgDM,

ndf: r.ndfPct,
ndfPct: r.ndfPct,
adf: r.adfPct,
adfPct: r.adfPct,
fat: r.fatPct,
fatPct: r.fatPct,
crudeFatPct: r.crudeFatPct,
faPct: r.faPct,
starch: r.starchPct,
starchPct: r.starchPct,
wscPct: r.wscPct,
ndsfPct: r.ndsfPct,
ligninPct: r.ligninPct,

forageNdfDigestibilityPct: r.forageNdfDigestibilityPct,
fNDFD: r.fNDFD,
rumDigNdfPctOfNdf: r.rumDigNdfPctOfNdf,
rumDigStarchPctOfStarch: r.rumDigStarchPctOfStarch,
starchDigestibilityPct: r.starchDigestibilityPct,

faDigestibilityCoeff: r.faDigestibilityCoeff,
faSourceClass: r.faSourceClass,

// NASEM 2021 protein fractions
solubleProteinPctCP: r.solubleProteinPctCP,
proteinAFractionPctCP: r.proteinAFractionPctCP,
proteinBFractionPctCP: r.proteinBFractionPctCP,
proteinBKdPctPerHour: r.proteinBKdPctPerHour,
proteinCFractionPctCP: r.proteinCFractionPctCP,

rdpPctCP: r.rdpPctCP,
rupPctCP: r.rupPctCP,
rupDigestibilityPct: r.rupDigestibilityPct,

aaProfilePctCP: r.aaProfilePctCP,
aaProfilePctTP: r.aaProfilePctTP,
aaProfile: r.aaProfile,

// Trace minerals — NASEM 2021
coMgKgDM: r.coMgKgDM,
cuMgKgDM: r.cuMgKgDM,
feMgKgDM: r.feMgKgDM,
iMgKgDM: r.iMgKgDM,
mnMgKgDM: r.mnMgKgDM,
seMgKgDM: r.seMgKgDM,
znMgKgDM: r.znMgKgDM,

coAbsCoeff: r.coAbsCoeff,
cuAbsCoeff: r.cuAbsCoeff,
feAbsCoeff: r.feAbsCoeff,
iAbsCoeff: r.iAbsCoeff,
mnAbsCoeff: r.mnAbsCoeff,
seAbsCoeff: r.seAbsCoeff,
znAbsCoeff: r.znAbsCoeff,

cat: r.cat,
pricePerTonAsFed: r.pricePerTon
  })),
 {
  ...targetsCore,

  dmi: targetsCore?.dmi,
  dmiTarget: targetsCore?.dmi,
  nel: targetsCore?.nel,
  nelTarget: targetsCore?.nel,
  mpTargetG: targetsCore?.mpTargetG,
  ndfTarget: targetsCore?.ndfTarget,
  starchMax: targetsCore?.starchMax,
  roughageMin: targetsCore?.roughageMin,
  peNDFMin: targetsCore?.peNDFMin,

  proteinRequirementModel: targetsCore?.proteinRequirementModel || null,
  mineralRequirementModel: targetsCore?.mineralRequirementModel || null,
  vitaminRequirementModel: targetsCore?.vitaminRequirementModel || null,
  chapter12MineralModel: targetsCore?.chapter12MineralModel || null,
  chapter12VitaminModel: targetsCore?.chapter12VitaminModel || null
},
  {
    ...contextForTargets,
    ...targetsCore,

    avgMilkKg: context?.avgMilkKg,
    milkFatPct: runtimeCtx?.milkFatPctUsed,
    milkProteinPct: runtimeCtx?.milkProteinPctUsed,
    milkPrice: milkPrice,

    proteinRequirementModel: targetsCore?.proteinRequirementModel || null,
    mineralRequirementModel: targetsCore?.mineralRequirementModel || null,
    vitaminRequirementModel: targetsCore?.vitaminRequirementModel || null,
    chapter12MineralModel: targetsCore?.chapter12MineralModel || null,
    chapter12VitaminModel: targetsCore?.chapter12VitaminModel || null
  }
);

  let totCost = null;
  let mixPriceDM = null;
  let mixPriceAsFed = null;

  if (modeNorm === 'tmr_asfed') {
    let totalAsFed = 0;
    let totalDmKg = 0;
    let totalCostVal = 0;

    for (const r of cleanRows) {
      const kg = Number(r.asFedKg || 0);
      const dmPct = Number(r.dmPct || 0);
      const pricePerTon = Number(r.pricePerTon || 0);

      const dmKg = kg * (dmPct / 100);
      const cost = (kg / 1000) * pricePerTon;

      totalAsFed += kg;
      totalDmKg += dmKg;
      totalCostVal += cost;
    }

    totCost = round2(totalCostVal);
    mixPriceAsFed = totalAsFed > 0 ? round2((totalCostVal / totalAsFed) * 1000) : null;
    mixPriceDM = totalDmKg > 0 ? round2((totalCostVal / totalDmKg) * 1000) : null;
  }

  if (modeNorm === 'tmr_percent') {
    let dmFrac = 0;
    let mixAsFed = 0;

    for (const r of cleanRows) {
      const pct = Number(r.pct || 0) / 100;
      const dmPct = Number(r.dmPct || 0);
      const pricePerTon = Number(r.pricePerTon || 0);

      dmFrac += pct * (dmPct / 100);
      mixAsFed += pct * pricePerTon;
    }

    mixPriceAsFed = mixAsFed > 0 ? round2(mixAsFed) : null;
    mixPriceDM = dmFrac > 0 ? round2(mixAsFed / dmFrac) : null;
  }

  if (modeNorm === 'split') {
    const concKgNum = Number(concKg || 0);

    let roughDm = 0;
    let roughCost = 0;
    let concDmFrac = 0;
    let concMixAsFed = 0;

    for (const r of cleanRows) {
      const cat = String(r.cat || '').trim();
      const dmPct = Number(r.dmPct || 0);
      const pricePerTon = Number(r.pricePerTon || 0);
      const kg = Number(r.asFedKg || 0);
      const pct = Number(r.pct || 0);

      if (cat === 'rough') {
        const dmKg = kg * (dmPct / 100);
        const cost = (kg / 1000) * pricePerTon;
        roughDm += dmKg;
        roughCost += cost;
      }

      if (cat === 'conc') {
        const frac = pct / 100;
        concDmFrac += frac * (dmPct / 100);
        concMixAsFed += frac * pricePerTon;
      }
    }

    const concKgDM = concKgNum * concDmFrac;
    const concCost = (concKgNum / 1000) * concMixAsFed;
    const totalCostAll = roughCost + concCost;
    const totalDmAll = roughDm + concKgDM;

    totCost = round2(totalCostAll);
    mixPriceAsFed = concMixAsFed > 0 ? round2(concMixAsFed) : null;
    mixPriceDM = concDmFrac > 0 ? round2(concMixAsFed / concDmFrac) : null;

    if (rationCore?.totals) {
      rationCore.totals.asFedKg = round2((rationCore.totals.asFedKg || 0) + concKgNum);
      rationCore.totals.dmKg = round2(totalDmAll);
    }
  }

 const milkKg = Number(context?.avgMilkKg || 0);
const milkPriceNum = Number(milkPrice || 0);

// ===== الطاقة: لازم الفعلي والاحتياج بنفس المقياس =====
// الفعلي هنا /يوم = إجمالي طاقة العليقة اليومية
const nelActualDay = round2(rationCore?.totals?.nelMcal ?? null);

// اختياري للعرض المتقدم فقط: كثافة الطاقة /كجم DM
const nelDensity = (rationCore?.totals?.dmKg > 0)
  ? round2((rationCore?.totals?.nelMcal || 0) / rationCore.totals.dmKg)
  : null;

// ===== صحة الكرش: تقييم خطر اضطراب الكرش من تركيب العليقة =====
let forageDm = 0;
let concDm = 0;
let forageNdfKg = 0;
let totalNdfKgForRumen = 0;

for (const r of cleanRows) {
  const kg = Number(r.asFedKg || 0);
  const dmPct = Number(r.dmPct || 0);
  const ndfPct = Number(r.ndfPct || 0);
  const dmKg = kg * (dmPct / 100);
  const ndfKg = dmKg * (ndfPct / 100);
  const cat = String(r.cat || '').trim();

  if (cat === 'rough') {
    forageDm += dmKg;
    forageNdfKg += ndfKg;
  }

  if (cat === 'conc') {
    concDm += dmKg;
  }

  totalNdfKgForRumen += ndfKg;
}

forageDm = round2(forageDm) || 0;
concDm = round2(concDm) || 0;
forageNdfKg = round2(forageNdfKg) || 0;
totalNdfKgForRumen = round2(totalNdfKgForRumen) || 0;

const totalDmForRumen = forageDm + concDm;

const roughPctDM = totalDmForRumen > 0
  ? round2((forageDm / totalDmForRumen) * 100)
  : 0;

const concPctDM = totalDmForRumen > 0
  ? round2((concDm / totalDmForRumen) * 100)
  : 0;

const forageNDFPctDM = totalDmForRumen > 0
  ? round2((forageNdfKg / totalDmForRumen) * 100)
  : 0;

const forageNDFShareOfTotalNDF = totalNdfKgForRumen > 0
  ? round2((forageNdfKg / totalNdfKgForRumen) * 100)
  : 0;

const isDryOrCloseUpForRumen =
  !!contextForTargets?.earlyDry ||
  !!contextForTargets?.closeUp ||
  /جاف|dry|انتظار|تحضير|close/i.test(String(contextForTargets?.pregnancyStatus || ''));

const forageNDFMinForRumen =
  Number.isFinite(Number(targetsCore?.forageNDFMin))
    ? Number(targetsCore.forageNDFMin)
    : (isDryOrCloseUpForRumen ? 21 : 19);

const peNDFMinForRumen =
  Number.isFinite(Number(targetsCore?.peNDFMin))
    ? Number(targetsCore.peNDFMin)
    : 18;

const starchActual = Number(rationCore?.nutrition?.starchPct || 0);
const ndfActual = Number(rationCore?.nutrition?.ndfPctActual || 0);
const peNDFActual = Number(rationCore?.nutrition?.peNDFPctActual || 0);

const rumenHealthModel = buildRumenHealthModel({
  roughPctDM,
  concPctDM,
  forageNDFPctDM,
  forageNDFShareOfTotalNDF,
  starchActual,
  starchMax: targetsCore?.starchMax,
  ndfActual,
  isBuffaloRumen: /جاموس|buffalo/i.test(String(contextForTargets?.species || '')),
  carbohydrateSafetyModel: rationCore?.nutrition?.carbohydrateSafetyModel || null,
  dmiRationEffect: rationCore?.nutrition?.dmiRationEffect || null,
  animalDmiExpected: targetsCore?.dmi ?? null
});

const rumenStatus =
  rumenHealthModel.status === 'danger'
    ? 'danger'
    : rumenHealthModel.status === 'watch'
      ? 'warn'
      : 'good';

const rumenNote = `${rumenHealthModel.title}: ${rumenHealthModel.reason}`;
const costPerKgMilk = (milkKg > 0 && totCost != null) ? round2(totCost / milkKg) : null;
const dmPerKgMilk = (milkKg > 0 && rationCore?.totals?.dmKg > 0) ? round2(rationCore.totals.dmKg / milkKg) : null;
const milkRevenue = (milkKg > 0 && milkPriceNum > 0) ? round2(milkKg * milkPriceNum) : null;
const milkMargin = (milkRevenue != null && totCost != null) ? round2(milkRevenue - totCost) : null;

const ecmKg = round2(rationCore?.economics?.ecmKg ?? rationCore?.economics?.ecm ?? null);
const fpcmKg = round2(rationCore?.economics?.fpcmKg ?? rationCore?.economics?.fpcm ?? null);

const feedEfficiencyECM =
  Number.isFinite(Number(ecmKg)) &&
  Number.isFinite(Number(rationCore?.totals?.dmKg)) &&
  Number(rationCore.totals.dmKg) > 0
    ? round2(Number(ecmKg) / Number(rationCore.totals.dmKg))
    : null;

const feedEfficiencyFPCM =
  Number.isFinite(Number(fpcmKg)) &&
  Number.isFinite(Number(rationCore?.totals?.dmKg)) &&
  Number(rationCore.totals.dmKg) > 0
    ? round2(Number(fpcmKg) / Number(rationCore.totals.dmKg))
    : null;

const feedCostPctOfMilkIncome =
  Number.isFinite(Number(totCost)) &&
  Number.isFinite(Number(milkRevenue)) &&
  Number(milkRevenue) > 0
    ? round2((Number(totCost) / Number(milkRevenue)) * 100)
    : null;

const iofcPctOfMilkIncome =
  Number.isFinite(Number(milkMargin)) &&
  Number.isFinite(Number(milkRevenue)) &&
  Number(milkRevenue) > 0
    ? round2((Number(milkMargin) / Number(milkRevenue)) * 100)
    : null;

const mpSupplyForSafety = Number(rationCore?.nutrition?.mpSupplyG);
const mpTargetForSafety = Number(targetsCore?.mpTargetG);
const fatActualForSafety = Number(rationCore?.nutrition?.fatPctActual);
const carbSafetyStatus = String(rationCore?.nutrition?.carbohydrateSafetyModel?.status || '').toLowerCase();

const economicDecision = buildEconomicDecision({
  milkRevenue,
  feedCost: totCost,
  milkMargin,
  costPerKgMilk,
  dmKg: rationCore?.totals?.dmKg,
  ecmKg,
  fpcmKg,
  rationSafety: {
    rumenUnsafe: rumenHealthModel.status === 'danger',
    energyDeficit:
      Number.isFinite(Number(nelActualDay)) &&
      Number.isFinite(Number(targetsCore?.nel)) &&
      Number(nelActualDay) < Number(targetsCore.nel) - 0.5,
    mpDeficit:
      Number.isFinite(mpSupplyForSafety) &&
      Number.isFinite(mpTargetForSafety) &&
      (
      Number.isFinite(mpSupplyForSafety) &&
      Number.isFinite(mpTargetForSafety) &&
      mpTargetForSafety > 0 &&
  (((mpSupplyForSafety - mpTargetForSafety) / mpTargetForSafety) * 100) < -5
),
    ndfUnsafe: carbSafetyStatus === 'danger',
    starchUnsafe: carbSafetyStatus === 'danger',
    fatUnsafe:
      Number.isFinite(fatActualForSafety) &&
      fatActualForSafety > 7
  }
});

  return normalizeNutritionAnalysis({
    totals: {
      asFedKg: rationCore?.totals?.asFedKg ?? null,
      dmKg: rationCore?.totals?.dmKg ?? null,
      totCost,
      mixPriceDM,
      mixPriceAsFed
    },
 nutrition: {
  cpPctTotal: rationCore?.nutrition?.cpPctTotal ?? null,
  mpSupplyG: rationCore?.nutrition?.mpSupplyG ?? null,
  mpDensityGkgDM: rationCore?.nutrition?.mpDensityGkgDM ?? null,
  mpBalanceG: (
    Number.isFinite(Number(rationCore?.nutrition?.mpSupplyG)) &&
    Number.isFinite(Number(targetsCore?.mpTargetG))
  )
    ? round2(Number(rationCore.nutrition.mpSupplyG) - Number(targetsCore.mpTargetG))
    : null,
  fcRatio: concDm > 0 ? round2(forageDm / concDm) : null,
  nelActual: nelActualDay,
  nelDensity: nelDensity,
  ndfPctActual: rationCore?.nutrition?.ndfPctActual ?? null,
  peNDFPctActual: rationCore?.nutrition?.peNDFPctActual ?? null,
  fatPctActual: rationCore?.nutrition?.fatPctActual ?? null,
  starchPctActual: rationCore?.nutrition?.starchPct ?? null,
  roughPctDM,
  concPctDM,
  forageNDFPctDM,
  forageNDFShareOfTotalNDF,
  rumenStatus,
  rumenNote,
  rumenHealthModel,

mineralSupplyModel: rationCore?.nutrition?.mineralSupplyModel || null,
vitaminSupplyModel: rationCore?.nutrition?.vitaminSupplyModel || null,
dcadModel: rationCore?.nutrition?.dcadModel || null,
proteinModel: rationCore?.nutrition?.proteinModel || null,
energySupplyModel: rationCore?.nutrition?.energySupplyModel || null,
fatModel: rationCore?.nutrition?.fatModel || null,
carbohydrateModel: rationCore?.nutrition?.carbohydrateModel || null,
carbohydrateSafetyModel: rationCore?.nutrition?.carbohydrateSafetyModel || null,
dmiRationEffect: rationCore?.nutrition?.dmiRationEffect || null
},

  targets: {
  dmiTarget: targetsCore?.dmi ?? null,
  nelTarget: targetsCore?.nel ?? null,
  cpReferencePct: targetsCore?.cpReferencePct ?? targetsCore?.cpTarget ?? null,
  mpTargetG: targetsCore?.mpTargetG ?? null,
  ndfTarget: targetsCore?.ndfTarget ?? null,
  fatTarget: null,
  starchMax: targetsCore?.starchMax ?? null,
  roughageMin: targetsCore?.roughageMin ?? null,
  peNDFMin: peNDFMinForRumen,
  forageNDFMin: forageNDFMinForRumen,

  proteinRequirementModel: targetsCore?.proteinRequirementModel || null,
  mineralRequirementModel: targetsCore?.mineralRequirementModel || null,
  vitaminRequirementModel: targetsCore?.vitaminRequirementModel || null,
  chapter12EnergyModel: targetsCore?.chapter12EnergyModel || null,
  chapter12ProteinModel: targetsCore?.chapter12ProteinModel || null,
  chapter12MineralModel: targetsCore?.chapter12MineralModel || null,
  chapter12VitaminModel: targetsCore?.chapter12VitaminModel || null
},
       economics: {
      costPerKgMilk,
      dmPerKgMilk,
      milkRevenue,
      milkMargin,

      ecmKg,
      fpcmKg,

      feedCostPctOfMilkIncome,
      iofcPctOfMilkIncome,

      feedEfficiencyECM,
      feedEfficiencyFPCM,

      economicDecision
    },
             inputs: {
      bodyWeightKgUsed: runtimeCtx.bodyWeightKgUsed,
      milkPriceUsed: milkPriceNum > 0 ? milkPriceNum : null,
      bodyWeightSource: runtimeCtx.bodyWeightSource,
      bcsSource: runtimeCtx.bcsSource,
      representativeWarning: runtimeCtx.representativeWarning,
      milkFatPctUsed: runtimeCtx.milkFatPctUsed,
      milkProteinPctUsed: runtimeCtx.milkProteinPctUsed,
      lactationNumberUsed: runtimeCtx.lactationNumberUsed,
      thiUsed: runtimeCtx.thiUsed,
      bcsUsed: runtimeCtx.bcsUsed
    }
  });
}
function pctOrNull(v){
  return Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null;
}
function findMissingNutritionPrices(rows = []) {
  const list = Array.isArray(rows) ? rows : [];

  return list.filter(r => {
    const name = String(r?.name || r?.nameAr || r?.feedName || r?.id || '').trim();

    const hasAmount =
      Number(r?.asFedKg || 0) > 0 ||
      Number(r?.kg || 0) > 0 ||
      Number(r?.amount || 0) > 0 ||
      Number(r?.pct || 0) > 0;

    const price = Number(
      r?.pricePerTon ??
      r?.pTon ??
      r?.price ??
      r?.pTonRaw
    );

    return name && hasAmount && !(Number.isFinite(price) && price > 0);
  });
}

function buildRumenHealthModel({
  roughPctDM,
  concPctDM,
  forageNDFPctDM,
  forageNDFShareOfTotalNDF,
  starchActual,
  starchMax,
  ndfActual,
  isBuffaloRumen = false,
  carbohydrateSafetyModel = null,
  dmiRationEffect = null,
  animalDmiExpected = null
}) {
  const safePct = (v) =>
    Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null;

  const carb = carbohydrateSafetyModel && typeof carbohydrateSafetyModel === 'object'
    ? carbohydrateSafetyModel
    : null;

  const rough = safePct(roughPctDM);
  const conc = safePct(concPctDM);
  const forageNDF = safePct(forageNDFPctDM);
  const forageNDFShare = safePct(forageNDFShareOfTotalNDF);
  const starch = safePct(starchActual);
  const starchLimit = safePct(starchMax);
  const ndf = safePct(ndfActual);

  const minTotalNDF = safePct(carb?.minTotalNDFPctDM);
  const maxStarch = safePct(carb?.maxStarchPctDM);
  const carbStatus = String(carb?.status || '').toLowerCase();

  const rationDmi = Number(
    dmiRationEffect?.dmi ??
    dmiRationEffect?.dmiKg ??
    dmiRationEffect?.predictedDmiKg ??
    dmiRationEffect?.predictedDMI
  );

  const animalDmi = Number(animalDmiExpected);

  const hasRationDmi = Number.isFinite(rationDmi) && rationDmi > 0;
  const hasAnimalDmi = Number.isFinite(animalDmi) && animalDmi > 0;

  let status = 'good';
  let score = 90;
  let title = 'صحة الكرش آمنة';
  let reason = 'توازن الألياف والنشا مناسب حسب بيانات العليقة الحالية.';
  let instruction = 'حافظ على جودة الخشن وثبات الخلط، وراقب الروث والاجترار ودهن اللبن.';

  if (carbStatus === 'danger') {
    status = 'danger';
    score = 45;
    title = 'خطر اضطراب كرش';
    reason = 'توازن الخشن والنشا غير آمن: NDF أقل من حد الأمان أو النشا أعلى من الحد.';
    instruction = 'اضبط الخشن والنشا قبل رفع الطاقة أو الحبوب.';
  } else if (carbStatus === 'warn' || carbStatus === 'watch') {
    status = 'watch';
    score = 72;
    title = 'صحة الكرش تحتاج متابعة';
    reason = 'توازن الخشن والنشا قريب من حدود الأمان.';
    instruction = 'راجع الخشن والنشا، ولا ترفع الحبوب قبل التأكد من ثبات الروث والاجترار.';
  }

  const dmiLine =
    hasRationDmi && hasAnimalDmi
      ? `تأثير العليقة على المأكول: تقدير العليقة ${rationDmi.toFixed(1)} كجم DM مقابل ${animalDmi.toFixed(1)} كجم متوقع من الحيوان.`
      : hasRationDmi
        ? `تأثير العليقة على المأكول: تقدير العليقة ${rationDmi.toFixed(1)} كجم DM.`
        : '';

  const operatingAdvice =
    'توجيه تشغيلي دائم: راجع طول تقطيع الخشن، تجانس الخلطة، ومنع الفرز؛ التحليل الكيميائي لا يكشف طول الألياف أو فرز العليقة.';

  const noteText = [
    reason,
    dmiLine
  ].filter(Boolean).join(' ');

  const adviceText = [
    instruction,
    operatingAdvice
  ].filter(Boolean).join(' ');

  return {
    model: 'MURABBIK_RUMEN_HEALTH_CARBOHYDRATE_DMI_V2',
    status,
    score,
    title,
    reason,
    instruction,
    displayText: title,
    noteText,
    adviceText,
    indicators: {
      carbohydrateSafety: {
        status: carbStatus || null,
        fNDFPctDM: safePct(carb?.fNDFPctDM),
        totalNDFPctDM: safePct(carb?.totalNDFPctDM ?? ndf),
        starchPctDM: safePct(carb?.starchPctDM ?? starch),
        minTotalNDFPctDM: minTotalNDF,
        maxStarchPctDM: maxStarch,
        note: carb?.note || null
      },
      ndf: {
        label: 'NDF الكلي',
        actual: ndf,
        target: minTotalNDF,
        rule: 'minimum_safety_only'
      },
      starch: {
        label: 'النشا',
        actual: starch,
        target: maxStarch ?? starchLimit,
        rule: 'maximum_safety'
      },
      forageNDF: {
        label: 'Forage NDF',
        actual: forageNDF,
        shareOfTotalNDF: forageNDFShare,
        rule: 'carbohydrate_safety_input'
      },
      roughage: {
        label: 'الخشن',
        actual: rough
      },
      concentrate: {
        label: 'المركزات',
        actual: conc
      },
      dmiRationEffect: hasRationDmi
        ? {
            model: dmiRationEffect?.model || null,
            rationDmiKg: Math.round(rationDmi * 10) / 10,
            animalExpectedDmiKg: hasAnimalDmi ? Math.round(animalDmi * 10) / 10 : null,
            note: dmiLine
          }
        : null
    },
    sourceBasis: [
      'MURABBIK_SERVER_SIDE_ONLY',
      'CARBOHYDRATE_SAFETY_FOR_RUMEN_HEALTH',
      'TOTAL_NDF_MINIMUM_NOT_NDF_REQUIREMENT',
      'STARCH_MAXIMUM_SAFETY',
      'DMI_RATION_EFFECT_DISPLAY_ONLY_WHEN_AVAILABLE',
      'NO_PEF_OR_PENDF_IN_CURRENT_RUMEN_JUDGMENT'
    ],
    isBuffaloRumen: !!isBuffaloRumen
  };
}

function buildEconomicDecision({
  milkRevenue,
  feedCost,
  milkMargin,
  costPerKgMilk,
  dmKg,
  ecmKg,
  fpcmKg,
  rationSafety = {}
} = {}) {
  const revenue = Number(milkRevenue);
  const cost = Number(feedCost);
  const margin = Number(milkMargin);
  const dm = Number(dmKg);
  const ecm = Number(ecmKg);
  const fpcm = Number(fpcmKg);

  const feedCostPctOfMilkIncome =
    revenue > 0 && Number.isFinite(cost) && cost >= 0
      ? round2((cost / revenue) * 100)
      : null;

  const iofcPctOfMilkIncome =
    revenue > 0 && Number.isFinite(margin)
      ? round2((margin / revenue) * 100)
      : null;

  const feedEfficiencyECM =
    dm > 0 && ecm > 0
      ? round2(ecm / dm)
      : null;

  const feedEfficiencyFPCM =
    dm > 0 && fpcm > 0
      ? round2(fpcm / dm)
      : null;

  const hasUnsafeNutrition =
    rationSafety?.rumenUnsafe === true ||
    rationSafety?.energyDeficit === true ||
    rationSafety?.mpDeficit === true ||
    rationSafety?.ndfUnsafe === true ||
    rationSafety?.starchUnsafe === true ||
    rationSafety?.fatUnsafe === true;

  let status = 'good';
  let title = 'اقتصاد العليقة قوي';
  let reason = '';
  let action = 'حافظ على العليقة ولا تخفض التكلفة بطريقة تكسر الطاقة أو البروتين أو أمان الكرش.';

  if (feedCostPctOfMilkIncome == null || iofcPctOfMilkIncome == null) {
    status = 'warn';
    title = 'التحليل الاقتصادي غير مكتمل';
    reason = 'تعذر حساب نسبة تكلفة العلف أو نسبة IOFC من دخل اللبن.';
    action = 'راجع مدخلات اللبن وسعر اللبن وتكلفة العلف لأنها إلزامية لإصدار قرار اقتصادي كامل.';
  } else if (feedCostPctOfMilkIncome <= 40) {
    status = 'good';
    title = 'اقتصاد العليقة قوي';
    reason = `تكلفة العلف تمثل ${feedCostPctOfMilkIncome}% من دخل اللبن، وIOFC يمثل ${iofcPctOfMilkIncome}%.`;
    action = 'العليقة قوية اقتصاديًا. حافظ على الاتزان ولا تخفض تكلفة العلف إذا كان ذلك سيكسر NEL أو MP أو أمان الكرش.';
  } else if (feedCostPctOfMilkIncome <= 50) {
    status = 'good';
    title = 'اقتصاد العليقة مقبول';
    reason = `تكلفة العلف تمثل ${feedCostPctOfMilkIncome}% من دخل اللبن، وIOFC يمثل ${iofcPctOfMilkIncome}%.`;
    action = 'الاقتصاد مقبول. يمكن مراجعة الخامات الأعلى تكلفة فقط إذا بقيت الطاقة والبروتين وصحة الكرش داخل الأمان.';
  } else if (feedCostPctOfMilkIncome <= 60) {
    status = 'warn';
    title = 'تحذير اقتصادي: تكلفة العلف مرتفعة نسبيًا';
    reason = `تكلفة العلف تمثل ${feedCostPctOfMilkIncome}% من دخل اللبن، وIOFC يمثل ${iofcPctOfMilkIncome}%.`;
    action = 'راجع الخامات الأعلى مساهمة في التكلفة وكفاءة التحويل، ولا تخفض المركزات أو البروتين قبل التأكد من عدم كسر NEL وMP وNDF والنشا والدهن.';
  } else {
    status = 'danger';
    title = 'خطر اقتصادي: تكلفة العلف تلتهم دخل اللبن';
    reason = `تكلفة العلف تمثل ${feedCostPctOfMilkIncome}% من دخل اللبن، وIOFC يمثل ${iofcPctOfMilkIncome}%.`;
    action = 'الأولوية تحديد السبب: سعر خامات مرتفع، إنتاج لبن منخفض، أو كفاءة تحويل ضعيفة. أي تعديل اقتصادي يجب أن يمر أولًا على بوابة الاتزان الغذائي وصحة الكرش.';
  }

  if (Number.isFinite(margin) && margin < 0) {
    status = 'danger';
    title = 'خطر اقتصادي: هامش لبن-علف سلبي';
    reason = `تكلفة العلف أعلى من دخل اللبن اليومي. تكلفة العلف = ${round2(cost)}، دخل اللبن = ${round2(revenue)}.`;
    action = 'العليقة خاسرة على مستوى اللبن والعلف. راجع تكلفة الخامات وإنتاج اللبن وسعر اللبن فورًا، مع منع أي خفض يضر NEL أو MP أو صحة الكرش.';
  }

  if (hasUnsafeNutrition && (status === 'good')) {
    status = 'warn';
    title = 'الربحية الظاهرة تحتاج حذرًا غذائيًا';
    action = 'رغم أن المؤشر الاقتصادي مقبول، توجد ملاحظة غذائية قد تؤثر على استمرار الربحية. أصلح أمان الكرش أو الاتزان الغذائي قبل اعتماد العليقة.';
  }

  return {
    model: 'MURABBIK_ECONOMIC_DECISION_IOFC_V1',
    status,
    title,
    reason,
    action,
    metrics: {
      feedCostPctOfMilkIncome,
      iofcPctOfMilkIncome,
      feedEfficiencyECM,
      feedEfficiencyFPCM,
      iofcPerHead: Number.isFinite(margin) ? round2(margin) : null,
      costPerKgMilk: Number.isFinite(Number(costPerKgMilk)) ? round2(costPerKgMilk) : null
    },
    benchmarks: {
      feedCostPctOfMilkIncome: {
        strongMax: 40,
        acceptableMax: 50,
        warningMax: 60,
        dangerAbove: 60
      },
      iofcPctOfMilkIncome: {
        strongMin: 60,
        acceptableMin: 50,
        warningMin: 40,
        dangerBelow: 40
      }
    },
    sourceBasis: [
      'PENN_STATE_IOFC_FEED_COST_40_PERCENT_OR_LESS_OF_MILK_INCOME',
      'VIRGINIA_TECH_IOFC_MILK_INCOME_MINUS_FEED_COST',
      'JDS_IOFC_NOT_FEED_COST_ALONE',
      'WISCONSIN_FEED_EFFICIENCY_READ_WITH_IOFC',
      'MURABBIK_NUTRITION_SAFETY_GATE'
    ]
  };
}

function buildNutritionPanels(analysis = {}, context = {}) {
  const totals = analysis?.totals || {};
  const nutrition = analysis?.nutrition || {};
  const targets = analysis?.targets || {};
  const economics = analysis?.economics || {};
    const dcad = nutrition?.dcadModel || null;
  const isCloseUpContext =
    dcad?.closeUpContext === true ||
    context?.closeUp === true ||
    analysis?.targets?.category === 'close_up_mature_cow' ||
    analysis?.targets?.category === 'close_up_buffalo' ||
    /close|close_up|تحضير|انتظار/i.test(String(
      context?.pregnancyStatus ||
      context?.category ||
      analysis?.targets?.category ||
      ''
    ));

  const dcadValue = Number(dcad?.dcadMeqKgDM);

  const isBuffaloForDcad =
    /جاموس|buffalo/i.test(String(
      context?.species ||
      context?.animalType ||
      context?.kind ||
      dcad?.species ||
      ''
    ));

  let dcadCard = null;

  if (isCloseUpContext && Number.isFinite(dcadValue)) {
    const lowLimit  = isBuffaloForDcad ? -100 : -50;
    const highLimit = isBuffaloForDcad ? -50  : -10;

    let dcadStatus = 'good';
    let dcadText = 'مناسب';

    if (dcadValue > highLimit) {
      dcadStatus = 'warn';
      dcadText = 'أعلى من المطلوب';
    } else if (dcadValue < lowLimit) {
      dcadStatus = 'warn';
      dcadText = 'أقل من المطلوب';
    }

    const layerName = isBuffaloForDcad ? 'جاموس' : 'أبقار';
    const rangeText = `${lowLimit} إلى ${highLimit} mEq/kg DM`;

    dcadCard = {
      key: 'dcad',
      title: `DCAD انتظار الولادة — ${layerName}`,
      value: `${dcadValue} mEq/kg DM`,
      actual: dcadValue,
      target: highLimit,
      targetText:
        dcadStatus === 'good'
          ? `مربيك: DCAD مناسب لمرحلة انتظار الولادة (${rangeText}).`
          : dcadValue > highLimit
            ? `مربيك: DCAD أعلى من نطاق انتظار الولادة المطلوب (${rangeText}). راجع البوتاسيوم والصوديوم والخشن عالي K، واضبط الأملاح الأنيونية تحت إشراف فني.`
            : `مربيك: DCAD أقل من نطاق انتظار الولادة المطلوب (${rangeText}). راجع الاستساغة ومأكول المادة الجافة ولا تخفضه أكثر بدون متابعة فنية.`,
      status: dcadStatus,
      model: {
        ...dcad,
        interpretation: {
          speciesLayer: isBuffaloForDcad ? 'buffalo' : 'cattle',
          rangeMin: lowLimit,
          rangeMax: highLimit,
          status: dcadStatus,
          label: dcadText,
          sourceBasis: isBuffaloForDcad
            ? 'MURABBIK_BUFFALO_CLOSEUP_DCAD_RANGE_USER_APPROVED'
            : 'MURABBIK_CATTLE_CLOSEUP_DCAD_RANGE_USER_APPROVED'
        }
      }
    };
  }
    const isBuffalo =
    /جاموس|buffalo/i.test(String(context?.species || context?.animalType || context?.kind || ''));

  const num = (v, d = 2) => {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
  };

  const txt = (v, unit = '', d = 2) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const out = Number.isInteger(n) ? String(n) : n.toFixed(d);
    return unit ? `${out} ${unit}` : out;
  };

  const pctTxt = (v, d = 1) => txt(v, '%', d);

const stateFromBalance = (actual, target) => {
  const a = Number(actual);
  const t = Number(target);

  if (!Number.isFinite(a) || !Number.isFinite(t) || t <= 0) {
    return { state: 'warn', ratioPct: null };
  }

  const ratioPct = (a / t) * 100;
  const ratioRounded = Number(ratioPct.toFixed(1));

  if (ratioPct >= 95 && ratioPct <= 105) {
    return { state: 'good', ratioPct: ratioRounded };
  }

  if (ratioPct > 115) {
    return { state: 'danger', ratioPct: ratioRounded };
  }

  return { state: 'warn', ratioPct: ratioRounded };
};

  const uiStatus = (state) => {
    if (state === 'danger') return 'danger';
    if (state === 'watch' || state === 'warn') return 'warn';
    return 'good';
  };

  const dmActual = num(totals.dmKg, 2);
  const dmTarget = num(targets.dmiTarget, 2);

  const nelActual = num(nutrition.nelActual, 2);
  const nelTarget = num(targets.nelTarget, 2);

  const mpActual = num(nutrition.mpSupplyG, 0);
  const mpTarget = num(targets.mpTargetG, 0);

const cpActual = num(nutrition.cpPctTotal, 1);
const cpTarget = num(targets.cpTarget, 1);

const cpIntakeG =
  Number.isFinite(Number(totals?.dmKg)) &&
  Number.isFinite(Number(nutrition?.cpPctTotal))
    ? Number(totals.dmKg) * (Number(nutrition.cpPctTotal) / 100) * 1000
    : null;

const cpTargetG =
  Number.isFinite(Number(targets?.proteinRequirementModel?.cpTargetG))
    ? Number(targets.proteinRequirementModel.cpTargetG)
    : (
        Number.isFinite(Number(targets?.cpTargetG))
          ? Number(targets.cpTargetG)
          : (
              isBuffalo &&
              Number.isFinite(Number(targets?.cpTarget)) &&
              Number.isFinite(Number(targets?.dmiTarget)) &&
              Number(targets.dmiTarget) > 0
                ? Number(targets.dmiTarget) * (Number(targets.cpTarget) / 100) * 1000
                : null
            )
      );

const buffaloCpState =
  isBuffalo &&
  Number.isFinite(Number(cpIntakeG)) &&
  Number.isFinite(Number(cpTargetG)) &&
  Number(cpTargetG) > 0
    ? stateFromBalance(cpIntakeG, cpTargetG, 5)
    : null;

const starchActual = num(nutrition.starchPctActual, 1);
  const starchMax = num(targets.starchMax, 1);

  const fatActual = num(nutrition.fatPctActual, 1);
  const fatMax = 7;

  const rough = num(nutrition.roughPctDM, 0);
  const conc = num(nutrition.concPctDM, 0);

  const rumenModel = nutrition.rumenHealthModel || null;
  const rumenState =
    rumenModel?.status === 'danger'
      ? 'danger'
      : rumenModel?.status === 'watch'
        ? 'warn'
        : 'good';

  const dmRatioPct =
    Number.isFinite(Number(dmActual)) &&
    Number.isFinite(Number(dmTarget)) &&
    Number(dmTarget) > 0
      ? +((Number(dmActual) / Number(dmTarget)) * 100).toFixed(1)
      : null;

  // DMI في مُرَبِّيك = مأكول/مقدم مقابل المتوقع، وليس احتياجًا غذائيًا للحكم بنقص أو زيادة.
  const dmState = 'info';
  const nelBalance = stateFromBalance(nelActual, nelTarget);
  const mpBalance = stateFromBalance(mpActual, mpTarget);

  const nelState = nelBalance.state;
  const mpState = mpBalance.state;

  const nelRatioPct = nelBalance.ratioPct;
  const mpRatioPct = mpBalance.ratioPct;

  const starchHigh =
    Number.isFinite(Number(starchActual)) &&
    Number.isFinite(Number(starchMax)) &&
    Number(starchActual) > Number(starchMax);

  const fatHigh =
    Number.isFinite(Number(fatActual)) &&
    Number(fatActual) > fatMax;

  const cpState = buffaloCpState || stateFromBalance(cpActual, cpTarget, 5);
  const carbohydrateSafety =
  nutrition?.carbohydrateSafetyModel ||
  nutrition?.rumenHealthModel?.indicators?.carbohydrateSafety ||
  {};

const ndfSafetyMin = num(carbohydrateSafety?.minTotalNDFPctDM, 1);
const ndfActualForCard = num(nutrition.ndfPctActual, 1);

const ndfState =
  Number.isFinite(Number(ndfActualForCard)) &&
  Number.isFinite(Number(ndfSafetyMin)) &&
  Number(ndfSafetyMin) > 0
    ? (
        Number(ndfActualForCard) < Number(ndfSafetyMin)
          ? 'danger'
          : 'good'
      )
    : 'info';

  let dmHint =
    Number.isFinite(Number(dmRatioPct))
      ? (
          dmRatioPct < 95
            ? `مربيك: المادة الجافة المقدمة/المأكولة أقل من المتوقع (${dmRatioPct}%). هذا مؤشر شهية أو تقديم، وليس نقص احتياج غذائي بذاته. راقب المتبقي وBunk score.`
            : dmRatioPct > 120
              ? `مربيك: المادة الجافة المقدمة/المأكولة أعلى من المتوقع (${dmRatioPct}%). إذا كانت العليقة متزنة والاستجابة اللبنية جيدة فليست مشكلة بذاتها. راقب المتبقي والروث وBCS.`
              : `مربيك: المادة الجافة المقدمة/المأكولة قريبة من المتوقع (${dmRatioPct}%). الحكم الغذائي يكون من الطاقة والبروتين وأمان الكرش.`
        )
      : 'مربيك: المادة الجافة المتوقعة مرجع تشغيل للشهية والتقديم، وليست Target تغذية للحكم بنقص أو زيادة.';
const nelDiffText = reportUnitBalanceTextSrv(nelActual, nelTarget, 2, 'ميجاكالوري/يوم');
const mpDiffText = reportUnitBalanceTextSrv(mpActual, mpTarget, 0, 'جم/يوم');
let nelHint =
  nelState === 'good'
    ? `مربيك: الطاقة متزنة. فرق الاتزان ${nelDiffText}. استمر على نفس مستوى الطاقة مع متابعة إنتاج اللبن وحالة الجسم؛ لا ترفع كثافة العليقة بدون سبب واضح.`
    : Number(nelActual) < Number(nelTarget)
      ? `مربيك: الطاقة أقل من المطلوب. فرق الاتزان ${nelDiffText}. راجع أولًا كمية المادة الجافة المقدمة والمأكولة، ثم حسّن كثافة الطاقة بمصدر آمن مع الحفاظ على أمان الكرش.`
      : `مربيك: الطاقة أعلى من المطلوب. فرق الاتزان ${nelDiffText}. راجع التكلفة ومصادر الطاقة الزائدة حسب الإنتاج وحالة الجسم.`;
let mpHint =
  mpState === 'good'
    ? `مربيك: البروتين الممثل متزن. فرق الاتزان ${mpDiffText}. لا تزود البروتين الخام بدون سبب؛ حافظ على جودة مصدر البروتين وتوازن العليقة.`
    : Number(mpActual) < Number(mpTarget)
      ? `مربيك: البروتين الممثل أقل من المطلوب. فرق الاتزان ${mpDiffText}. لا تزود البروتين الخام عشوائيًا؛ الأفضل تحسين مصدر البروتين المفيد للحيوان.`
      : `مربيك: البروتين الممثل أعلى من المطلوب. فرق الاتزان ${mpDiffText}. راجع كمية أو نوع مصدر البروتين لتقليل التكلفة والهدر.`;
 
 ndfHint =
  ndfState === 'danger'
    ? 'مربيك: NDF أقل من حد أمان الكرش. راجع الخشن قبل زيادة المركزات.'
    : ndfState === 'good'
      ? 'مربيك: NDF يغطي حد أمان الكرش الأدنى. لا نحكم بزيادة NDF كاحتياج مستقل.'
      : 'مربيك: NDF قراءة ألياف للعليقة، وليس احتياجًا مستقلًا.';

 let starchWarnForUi = starchHigh;
let fatWarnForUi = fatHigh;

let starchHint =
  starchHigh
    ? 'مربيك: النشا أعلى من الحد الآمن. راجع كارت صحة الكرش قبل تعديل الحبوب.'
    : 'مربيك: النشا داخل الحد. حافظ على توازن الحبوب والخشن.';

let fatHint =
  fatHigh
    ? 'مربيك: دهن العليقة أعلى من الحد؛ قد يقلل هضم الألياف ويضغط على دهن اللبن.'
    : 'مربيك: دهن العليقة داخل الحد. لا ترفعه إلا لهدف طاقة واضح.';

if (isBuffalo) {
  const buffaloRumenSafe =
    String(rumenModel?.status || '').toLowerCase() === 'good';

  const fatModelStatus =
    String(nutrition?.fatModel?.status || '').toLowerCase();

  const buffaloFatModelSafe =
    fatModelStatus === 'ok' ||
    fatModelStatus === 'good' ||
    fatModelStatus === 'calculated';

  starchWarnForUi = starchHigh && !buffaloRumenSafe;
  fatWarnForUi = fatHigh && !buffaloFatModelSafe;

  starchHint =
    starchWarnForUi
      ? 'مربيك: النشا يحتاج مراجعة لأن صحة الكرش غير آمنة؛ اضبط الخشن الفعّال وتجانس الخلطة قبل زيادة الحبوب.'
      : 'مربيك: النشا يُقرأ مع صحة الكرش؛ طالما صحة الكرش آمنة فلا تعدّل الحبوب لمجرد رقم النشا.';

  fatHint =
    fatWarnForUi
      ? 'مربيك: دهن العليقة يحتاج مراجعة لأن نموذج الدهون لا يؤكد الأمان؛ راجع مصدر الدهون الغير محمية وتأثيره على هضم الألياف.'
      : 'مربيك: دهن العليقة مقبول حسب نموذج الدهون الحالي؛ لا ترفعه إلا لهدف طاقة واضح ومصدر دهون محمية مناسب.';
}
 const dmCtx = analysis?.context || context || ctx || {};
const isDryOrCloseUpDm =
  !!dmCtx?.earlyDry ||
  !!dmCtx?.closeUp ||
  /جاف|dry|انتظار|تحضير|close/i.test(String(dmCtx?.pregnancyStatus || dmCtx?.groupType || ''));
if (isDryOrCloseUpDm) {
  dmHint =
    Number.isFinite(Number(dmRatioPct))
      ? (
          dmRatioPct < 95
            ? `مربيك: المادة الجافة المقدمة أقل من المتوقع (${dmRatioPct}%). راقب توفر العلف في المعلف والمتبقي وحالة الجسم.`
            : dmRatioPct > 120
              ? `مربيك: المادة الجافة المقدمة أعلى من المتوقع (${dmRatioPct}%). راجع الكمية المقدمة والمتبقي وحالة الجسم حسب مرحلة الجفاف.`
              : `مربيك: المادة الجافة المقدمة قريبة من المتوقع (${dmRatioPct}%). الحكم الغذائي يكون من الطاقة والبروتين والمعادن ومرحلة الجفاف.`
        )
      : 'مربيك: المادة الجافة المتوقعة مرجع لتقديم العلف ومتابعة المعلف والمتبقي، وليست حكم نقص أو زيادة بذاتها.';
} else if (isBuffalo) {
    
    dmHint =
      Number.isFinite(Number(dmRatioPct))
        ? (
            dmRatioPct < 95
              ? `مربيك: المادة الجافة المقدمة/المأكولة للجاموس أقل من المتوقع (${dmRatioPct}%). هذا مؤشر شهية أو تقديم، وليس حكم نقص غذائي بذاته. راقب المتبقي وBunk score.`
              : dmRatioPct > 120
                ? `مربيك: المادة الجافة المقدمة/المأكولة للجاموس أعلى من المتوقع (${dmRatioPct}%). إذا كانت العليقة متزنة والاستجابة اللبنية جيدة فليست مشكلة بذاتها. راقب المتبقي والروث وBCS.`
                : `مربيك: المادة الجافة المقدمة/المأكولة للجاموس قريبة من المتوقع (${dmRatioPct}%). الحكم الغذائي يكون من الطاقة والبروتين وأمان الكرش.`
          )
        : 'مربيك: المادة الجافة المتوقعة للجاموس مرجع تشغيل للشهية والتقديم، وليست Target تغذية للحكم بنقص أو زيادة.';

nelHint =
  nelState === 'good'
    ? `مربيك: الطاقة متزنة للجاموس. فرق الاتزان ${nelDiffText}. استمر على نفس مستوى الطاقة مع متابعة اللبن وحالة الجسم، ولا تزود الحبوب بدون سبب واضح.`
    : Number(nelActual) < Number(nelTarget)
      ? `مربيك: الطاقة أقل من المطلوب للجاموس. فرق الاتزان ${nelDiffText}. راجع كمية المادة الجافة أولًا، ثم حسّن كثافة الطاقة بدون تجاوز حد النشا أو خفض الألياف الفعالة.`
      : `مربيك: الطاقة أعلى من المطلوب للجاموس. فرق الاتزان ${nelDiffText}. راجع التكلفة وقلّل مصادر الطاقة الزائدة تدريجيًا إذا لم يظهر مقابلها إنتاج أو تحسن واضح في حالة الجسم.`;

mpHint =
  mpState === 'good'
    ? `مربيك: البروتين الممثل متزن للجاموس. فرق الاتزان ${mpDiffText}. لا تزود البروتين الخام بدون سبب؛ حافظ على جودة مصدر البروتين وتوازن العليقة.`
    : Number(mpActual) < Number(mpTarget)
      ? `مربيك: البروتين الممثل أقل من المطلوب للجاموس. فرق الاتزان ${mpDiffText}. راجع مصدر البروتين المفيد للحيوان بدل رفع البروتين الخام عشوائيًا.`
      : `مربيك: البروتين الممثل أعلى من المطلوب للجاموس. فرق الاتزان ${mpDiffText}. راجع كمية أو نوع مصدر البروتين لتقليل التكلفة والهدر.`;


ndfHint =
  ndfState === 'danger'
    ? 'مربيك: NDF أقل من حد أمان الكرش. راجع الخشن قبل زيادة المركزات.'
    : ndfState === 'good'
      ? 'مربيك: NDF يغطي حد أمان الكرش الأدنى. لا نحكم بزيادة NDF كاحتياج مستقل.'
      : 'مربيك: NDF قراءة ألياف للعليقة، وليس احتياجًا مستقلًا.';
  }

   let priorityText = (() => {
    if (rumenModel?.status === 'danger') {
      return 'مربيك: أصلح صحة الكرش قبل رفع الطاقة أو الحبوب.';
    }

    if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      return 'مربيك: حسّن البروتين الممثل قبل رفع البروتين الخام.';
    }

    if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      return 'مربيك: حسّن الطاقة مع الحفاظ على أمان الكرش.';
    }

    if (fatHigh) {
      return 'مربيك: خفّض دهن العليقة لحماية هضم الألياف ودهن اللبن.';
    }

    if (starchHigh) {
      return 'مربيك: راجع صحة الكرش قبل تعديل الحبوب.';
    }

    return 'مربيك: العليقة مقبولة؛ تابع الإنتاج والروث والمتبقي.';
  })();
    if (isBuffalo) {
    if (rumenModel?.status === 'danger') {
      priorityText = 'مربيك: اضبط أمان كرش الجاموس أولًا؛ لا ترفع الحبوب أو الدهون الآن.';
   } else if (starchWarnForUi) {
  priorityText = 'مربيك: راجع النشا مع صحة الكرش والخشن الفعّال قبل اعتماد العليقة.';
} else if (fatWarnForUi) {
  priorityText = 'مربيك: راجع مصدر الدهون وتأثيره على هضم الألياف قبل اعتماد العليقة.';
    } else if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      priorityText = 'مربيك: حسّن البروتين الممثل للجاموس مع ضبط الطاقة، ولا ترفع CP عشوائيًا.';
    } else if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      priorityText = 'مربيك: ادعم طاقة الجاموس بدون تجاوز حد النشا أو خفض الألياف.';
    } else {
      priorityText = 'مربيك: عليقة الجاموس مقبولة؛ تابع الروث والاجترار ودهن اللبن والمتبقي.';
    }
  }
   let decisionText = (() => {
    if (rumenModel?.status === 'danger') {
      return 'مربيك: العليقة تحتاج ضبط صحة الكرش أولًا.';
    }

    if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      return 'مربيك: العليقة تحتاج تحسين البروتين الممثل.';
    }

    if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      return 'مربيك: العليقة تحتاج دعم طاقة محسوب.';
    }

    if (fatHigh || starchHigh) {
      return 'مربيك: العليقة تحتاج مراقبة النشا ودهن العليقة مع صحة الكرش.';
    }

    return 'مربيك: العليقة متوازنة تشغيليًا حسب المدخلات الحالية.';
  })();
    if (isBuffalo) {
    if (rumenModel?.status === 'danger') {
      decisionText = 'مربيك: عليقة الجاموس تحتاج ضبط أمان الكرش أولًا.';
    } else if (starchWarnForUi) {
      decisionText = 'مربيك: عليقة الجاموس تحتاج مراجعة النشا مع صحة الكرش.';
    } else if (fatWarnForUi) {
      decisionText = 'مربيك: عليقة الجاموس تحتاج مراجعة مصدر الدهون.';
    } else if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      decisionText = 'مربيك: العليقة تحتاج تحسين بروتين ممثل مناسب للجاموس.';
    } else if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      decisionText = 'مربيك: العليقة تحتاج دعم طاقة آمن للجاموس.';
    } else {
      decisionText = 'مربيك: عليقة الجاموس متوازنة تشغيليًا حسب المدخلات الحالية.';
    }
  }
  const analysisCards = [
    {
      key: 'decision',
      title: 'قرار مُرَبِّيك',
      value: decisionText,
      actual: null,
      target: null,
      targetText: priorityText,
      status:
        rumenModel?.status === 'danger'
          ? 'danger'
          : (
              nelState !== 'good' ||
              mpState !== 'good' ||
              starchHigh ||
              fatHigh
            )
              ? 'warn'
              : 'good'
    },

    {
      key: 'dm',
      title: 'المادة الجافة المقدمة/المتوقعة',
      value: txt(dmActual, 'كجم', 2),
      actual: dmActual,
      target: dmTarget,
      targetText: `${txt(dmActual, 'كجم', 2)} / المتوقع ${txt(dmTarget, 'كجم', 2)} — ${dmHint}`,
      status: 'info'
    },

    {
      key: 'nel',
      title: 'الطاقة',
      value: txt(nelActual, 'Mcal', 2),
      actual: nelActual,
      target: nelTarget,
      targetText: `${txt(nelActual, 'Mcal', 2)} / ${txt(nelTarget, 'Mcal', 2)} — ${nelHint}`,
      status: uiStatus(nelState)
    },

       {
      key: 'mp',
      title: 'البروتين الممثل',
      value: txt(mpActual, 'جم/يوم', 0),
      actual: mpActual,
      target: mpTarget,
      targetText: `${txt(mpActual, 'جم/يوم', 0)} / ${txt(mpTarget, 'جم/يوم', 0)} — ${mpHint}`,
      status: uiStatus(mpState)
    },
      
   {
  key: 'ndf',
  title: 'الألياف NDF',
  value: pctTxt(nutrition.ndfPctActual, 1),
  actual: num(nutrition.ndfPctActual, 1),
  target: ndfSafetyMin,
  targetText: `${pctTxt(nutrition.ndfPctActual, 1)} / حد أمان ${pctTxt(ndfSafetyMin, 1)} — ${ndfHint}`,
  status: uiStatus(ndfState)
},
    {
  key: 'starch',
  title: 'النشا',
  value: pctTxt(starchActual, 1),
  actual: starchActual,
  target: starchMax,
  targetText: `${pctTxt(starchActual, 1)} / ${pctTxt(starchMax, 1)} — ${starchHint}`,
  status: starchWarnForUi ? 'warn' : 'good'
},

 {
  key: 'fat',
  title: 'الدهون',
  value: pctTxt(fatActual, 1),
  actual: fatActual,
  target: fatMax,
  targetText: `${pctTxt(fatActual, 1)} / ${pctTxt(fatMax, 1)} — ${fatHint}`,
  status: fatWarnForUi ? 'warn' : 'good'
},
{
  key: 'rumen',
      title: 'صحة الكرش',
      value: rumenModel?.displayText || (
        Number.isFinite(rough) && Number.isFinite(conc)
          ? `خشن ${rough}% / مركز ${conc}%`
          : '—'
      ),
      actual: rumenModel?.score ?? null,
      target: 80,
      targetText: [
        rumenModel?.noteText || nutrition.rumenNote || '',
        rumenModel?.adviceText
          ? `تعليمات مُرَبِّيك: ${rumenModel.adviceText}`
          : ''
      ].filter(Boolean).join(' — '),
      status: nutrition.rumenStatus || null,
      model: rumenModel || null
    },
        ...(dcadCard ? [dcadCard] : []),
    {
      key: 'priority',
      title: 'أولوية التعديل',
      value: priorityText,
      actual: null,
      target: null,
      targetText: 'خطوة واحدة الآن — التفاصيل في تقرير التغذية.',
      status:
        rumenModel?.status === 'danger'
          ? 'danger'
          : (
             nelState !== 'good' ||
             mpState !== 'good' ||
             starchWarnForUi ||
             fatWarnForUi
            )
              ? 'warn'
              : 'good'
    }
  ];
  const economicDecision = economics?.economicDecision || null;
  const economicMetrics = economicDecision?.metrics || {};

  const feedCostPctOfMilkIncome =
    Number.isFinite(Number(economics.feedCostPctOfMilkIncome))
      ? Number(economics.feedCostPctOfMilkIncome)
      : (
          Number.isFinite(Number(economicMetrics.feedCostPctOfMilkIncome))
            ? Number(economicMetrics.feedCostPctOfMilkIncome)
            : null
        );

  const iofcPctOfMilkIncome =
    Number.isFinite(Number(economics.iofcPctOfMilkIncome))
      ? Number(economics.iofcPctOfMilkIncome)
      : (
          Number.isFinite(Number(economicMetrics.iofcPctOfMilkIncome))
            ? Number(economicMetrics.iofcPctOfMilkIncome)
            : null
        );

  const feedEfficiencyECM =
    Number.isFinite(Number(economics.feedEfficiencyECM))
      ? Number(economics.feedEfficiencyECM)
      : (
          Number.isFinite(Number(economicMetrics.feedEfficiencyECM))
            ? Number(economicMetrics.feedEfficiencyECM)
            : null
        );

  const feedEfficiencyFPCM =
    Number.isFinite(Number(economics.feedEfficiencyFPCM))
      ? Number(economics.feedEfficiencyFPCM)
      : (
          Number.isFinite(Number(economicMetrics.feedEfficiencyFPCM))
            ? Number(economicMetrics.feedEfficiencyFPCM)
            : null
        );

  const feedCostBand =
    feedCostPctOfMilkIncome == null
      ? { status: 'warn', label: 'غير مكتمل' }
      : feedCostPctOfMilkIncome <= 40
        ? { status: 'good', label: 'قوي' }
        : feedCostPctOfMilkIncome <= 50
          ? { status: 'good', label: 'مقبول' }
          : feedCostPctOfMilkIncome <= 60
            ? { status: 'warn', label: 'مرتفع' }
            : { status: 'danger', label: 'خطر' };

  const iofcBand =
    iofcPctOfMilkIncome == null
      ? { status: 'warn', label: 'غير مكتمل' }
      : iofcPctOfMilkIncome >= 60
        ? { status: 'good', label: 'قوي' }
        : iofcPctOfMilkIncome >= 50
          ? { status: 'good', label: 'مقبول' }
          : iofcPctOfMilkIncome >= 40
            ? { status: 'warn', label: 'ضعيف' }
            : { status: 'danger', label: 'خطر' };

  const safeNutritionGate =
    economicDecision?.status === 'warn' &&
    /حذر|غذائي|الكرش|الاتزان/.test(String(economicDecision?.title || economicDecision?.action || ''));

  const economicActionText =
    String(economicDecision?.action || '').trim() ||
    'اقرأ الاقتصاد مع الاتزان الغذائي وصحة الكرش قبل أي تعديل في الخامات.';
   const econCard = (key, title, value, actual, status, uiHint) => ({
    key,
    title,
    value,
    actual,
    target: null,
    status,
    uiHint,
    targetText: uiHint,
    model: economicDecision || null
  });

  const nutritionGateText =
    safeNutritionGate
      ? ' عالج التحذير الغذائي قبل الحفظ.'
      : '';

  const feedCostHint =
    feedCostPctOfMilkIncome == null
      ? 'أكمل بيانات اللبن والتكلفة.'
      : feedCostPctOfMilkIncome <= 40
        ? `تكلفة قوية؛ لا تخفض جودة العليقة.${nutritionGateText}`
        : feedCostPctOfMilkIncome <= 50
          ? 'مقبولة؛ راجع أغلى خامتين فقط دون كسر الاتزان.'
          : feedCostPctOfMilkIncome <= 60
            ? 'مرتفعة؛ خفّض التكلفة مع الحفاظ على الطاقة والبروتين والكرش.'
            : 'خطر اقتصادي؛ راجع سعر اللبن والإنتاج وأغلى الخامات.';

  const milkAfterFeedHint =
    iofcPctOfMilkIncome == null
      ? 'أكمل بيانات اللبن والتكلفة.'
      : iofcPctOfMilkIncome >= 60
        ? `هامش قوي؛ يمكن تصحيح العليقة دون خوف من التكلفة.${nutritionGateText}`
        : iofcPctOfMilkIncome >= 50
          ? 'هامش مقبول؛ لا تزود التكلفة إلا لتحسين واضح.'
          : iofcPctOfMilkIncome >= 40
            ? 'هامش ضعيف؛ راجع التكلفة وكفاءة التحويل.'
            : 'خطر ربحية؛ لا تحفظ قبل مراجعة العليقة والسعر.';

  const correctedMilkEfficiency =
    feedEfficiencyECM != null
      ? feedEfficiencyECM
      : feedEfficiencyFPCM;

  const correctedMilkStatus =
    correctedMilkEfficiency == null
      ? 'warn'
      : correctedMilkEfficiency >= 1.6
        ? 'good'
        : correctedMilkEfficiency >= 1.4
          ? 'good'
          : correctedMilkEfficiency >= 1.3
            ? 'warn'
            : 'danger';

  const correctedMilkHint =
    correctedMilkEfficiency == null
      ? 'يحتاج بيانات اللبن والمادة الجافة.'
      : correctedMilkEfficiency >= 1.6
        ? `كفاءة ممتازة؛ لا تطارد رفعها قبل ضبط الكرش والبروتين.${nutritionGateText}`
        : correctedMilkEfficiency >= 1.4
          ? `كفاءة جيدة؛ حسّنها من الطاقة والكرش لا من تقليل المأكول.${nutritionGateText}`
          : correctedMilkEfficiency >= 1.3
            ? 'كفاءة متوسطة؛ راجع جودة الخشن والطاقة والمأكول.'
            : 'كفاءة ضعيفة؛ راجع المأكول والطاقة وجودة العليقة.';

  const costPerKgMilkVal =
    Number.isFinite(Number(economics.costPerKgMilk))
      ? Number(economics.costPerKgMilk)
      : null;

  const costPerKgMilkHint =
    costPerKgMilkVal == null
      ? 'يحتاج إنتاج اللبن وتكلفة العلف.'
      : feedCostPctOfMilkIncome != null && feedCostPctOfMilkIncome <= 40
        ? 'التكلفة جيدة؛ لا تخفض الجودة لمجرد رقم أقل.'
        : feedCostPctOfMilkIncome != null && feedCostPctOfMilkIncome > 50
          ? 'مرتفعة؛ راجع الخامات الأعلى تكلفة.'
          : 'اقرأها مع الهامش وكفاءة اللبن المصحح.';

  const milkMarginVal =
    Number.isFinite(Number(economics.milkMargin))
      ? Number(economics.milkMargin)
      : null;

  const milkMarginHint =
    milkMarginVal == null
      ? 'يحتاج دخل اللبن وتكلفة العلف.'
      : safeNutritionGate
        ? 'اقتصاديًا جيد؛ القرار الآن غذائي قبل الحفظ.'
        : iofcPctOfMilkIncome != null && iofcPctOfMilkIncome >= 60
          ? 'هامش قوي؛ ثبّت العليقة وراقب الأسعار.'
          : iofcPctOfMilkIncome != null && iofcPctOfMilkIncome >= 50
            ? 'هامش مقبول؛ راقب التكلفة والإنتاج.'
            : 'هامش ضعيف؛ راجع العليقة قبل الاعتماد.';
  const isDryEconomics =
  context?.earlyDry === true ||
  context?.closeUp === true ||
  /جاف|dry|انتظار|تحضير|close/i.test(String(
    context?.groupType ||
    context?.groupName ||
    context?.pregnancyStatus ||
    analysis?.targets?.category ||
    ''
  ));

const feedCostPerHeadDay =
  Number.isFinite(Number(totals.totCost))
    ? Number(totals.totCost)
    : null;

const mixPriceDmVal =
  Number.isFinite(Number(totals.mixPriceDM))
    ? Number(totals.mixPriceDM)
    : null;

const mixPriceAsFedVal =
  Number.isFinite(Number(totals.mixPriceAsFed))
    ? Number(totals.mixPriceAsFed)
    : null;

if (isDryEconomics) {
  return {
    analysisCards,
    economicsCards: [
      econCard(
        'feedCostPerHeadDay',
        'تكلفة التغذية / رأس / يوم',
        feedCostPerHeadDay != null ? `${num(feedCostPerHeadDay, 2)} ج/رأس/يوم` : '—',
        feedCostPerHeadDay,
        feedCostPerHeadDay != null ? 'good' : 'warn',
        feedCostPerHeadDay != null
          ? 'هذه تكلفة التغذية اليومية للحيوان في مرحلة الجفاف أو انتظار الولادة.'
          : 'أكمل كميات وأسعار الخامات لحساب تكلفة التغذية اليومية.'
      ),
      econCard(
        'mixPriceDM',
        'سعر طن الخلطة مادة جافة',
        mixPriceDmVal != null ? `${num(mixPriceDmVal, 0)} ج/طن DM` : '—',
        mixPriceDmVal,
        mixPriceDmVal != null ? 'good' : 'warn',
        'مؤشر تكلفة الخلطة على أساس المادة الجافة.'
      ),
      econCard(
        'mixPriceAsFed',
        'سعر طن الخلطة طازج',
        mixPriceAsFedVal != null ? `${num(mixPriceAsFedVal, 0)} ج/طن طازج` : '—',
        mixPriceAsFedVal,
        mixPriceAsFedVal != null ? 'good' : 'warn',
        'مؤشر تكلفة الخلطة كما تُقدَّم في المعلف.'
      )
    ],
    advancedCards: []
  };
}
  const economicsCards = [
    econCard(
      'feedCostPctOfMilkIncome',
      'تكلفة العلف من دخل اللبن',
      feedCostPctOfMilkIncome != null ? `${num(feedCostPctOfMilkIncome, 1)}%` : '—',
      feedCostPctOfMilkIncome,
      feedCostBand.status,
      feedCostHint
    ),
    econCard(
      'iofcPctOfMilkIncome',
      'هامش اللبن بعد العلف',
      iofcPctOfMilkIncome != null ? `${num(iofcPctOfMilkIncome, 1)}%` : '—',
      iofcPctOfMilkIncome,
      iofcBand.status,
      milkAfterFeedHint
    ),
    econCard(
      'feedEfficiencyECM',
      'لبن مصحح لكل 1 كجم مادة جافة',
      correctedMilkEfficiency != null ? `${num(correctedMilkEfficiency, 2)} كجم لبن مصحح` : '—',
      correctedMilkEfficiency,
      correctedMilkStatus,
      correctedMilkEfficiency != null
        ? `مقابل كل 1 كجم مادة جافة من العليقة تنتج الحيوانات ${num(correctedMilkEfficiency, 2)} كجم لبن مصحح.`
        : 'يحتاج بيانات اللبن والمادة الجافة.'
    ),
    econCard(
      'costPerKgMilk',
      'تكلفة كجم اللبن',
      costPerKgMilkVal != null ? `${num(costPerKgMilkVal, 2)} ج/كجم` : '—',
      costPerKgMilkVal,
      feedCostBand.status === 'danger' ? 'danger' : feedCostBand.status === 'warn' ? 'warn' : 'good',
      costPerKgMilkHint
    ),
    econCard(
      'milkMargin',
      'هامش لبن-علف',
      milkMarginVal != null ? `${num(milkMarginVal, 2)} ج` : '—',
      milkMarginVal,
      economicDecision?.status || iofcBand.status,
      milkMarginHint
    )
  ];

  const advancedCards = [
    {
      key: 'dmiTarget',
      title: 'المأكول المتوقع للمادة الجافة',
      value: txt(targets.dmiTarget, 'كجم', 2)
    },
    {
      key: 'totDM',
      title: 'المادة الجافة المقدمة/المأكولة',
      value: txt(totals.dmKg, 'كجم', 2)
    },

    {
      key: 'mpTargetG',
      title: 'احتياجات البروتين الممثل',
      value: txt(targets.mpTargetG, 'جم/يوم', 0)
    },
    {
      key: 'mpSupplyG',
      title: 'العليقة الحالية — البروتين الممثل',
      value: txt(nutrition.mpSupplyG, 'جم/يوم', 0)
    },

    {
      key: 'ndfTarget',
      title: 'احتياجات الألياف NDF',
      value: txt(targets.ndfTarget, '%', 0)
    },
    {
      key: 'ndfPctActual',
      title: 'العليقة الحالية — ألياف NDF',
      value: txt(nutrition.ndfPctActual, '%', 1)
    },
    {
      key: 'peNDFMin',
      title: 'الحد الأدنى للألياف المؤثرة',
      value: txt(targets.peNDFMin, '%', 0)
    },
    {
      key: 'peNDFPctActual',
      title: 'العليقة الحالية — ألياف مؤثرة',
      value: txt(nutrition.peNDFPctActual, '%', 1)
    },
    {
      key: 'starchMax',
      title: 'الحد الأقصى للنشا',
      value: txt(targets.starchMax, '%', 0)
    },
    {
      key: 'starchPctActual',
      title: 'العليقة الحالية — نشا',
      value: txt(nutrition.starchPctActual, '%', 1)
    },
    {
      key: 'roughageMin',
      title: 'الحد الأدنى للخشن',
      value: txt(targets.roughageMin, '%', 0)
    },

    {
      key: 'fatLimit',
      title: 'الحد المسموح به لدهن العليقة',
      value: '6–7 % من المادة الجافة'
    },
    {
      key: 'fatPctActual',
      title: 'العليقة الحالية — دهن',
      value: txt(nutrition.fatPctActual, '%', 1)
    },

    {
      key: 'nelTarget',
      title: 'احتياجات الطاقة',
      value: txt(targets.nelTarget, 'ميجاكال NEL/يوم', 2)
    },
    {
      key: 'nelActual',
      title: 'العليقة الحالية — طاقة',
      value: txt(nutrition.nelActual, 'ميجاكال NEL/يوم', 2)
    }
  ];

  return {
    analysisCards,
    economicsCards,
    advancedCards
  };
}
async function findAnimalDocRefByNumberForTenant(tenant, rawNumber) {
  if (!db) return null;

  const tries = [];
  const s = String(rawNumber || '').trim();
  const n = Number(s);

  if (s) tries.push(s);
  if (Number.isFinite(n)) tries.push(n);

  for (const ownerField of ['userId', 'ownerUid']) {
    for (const numberField of ['animalNumber', 'number']) {
      for (const val of tries) {
        try {
          const snap = await db.collection('animals')
            .where(ownerField, '==', tenant)
            .where(numberField, '==', val)
            .limit(1)
            .get();

          if (!snap.empty) return snap.docs[0];
        } catch (_) {}
      }
    }
  }

  return null;
}
async function syncAnimalGroupFieldsSrv(tenant, groups = []) {
  if (!db || !tenant) return;

  const desired = new Map();

  for (const g of (Array.isArray(groups) ? groups : [])) {
    const groupId = String(g?.groupId || '').trim();
    const groupKey = String(g?.groupKey || '').trim();
    const groupName = String(g?.groupName || g?.name || groupId || '').trim();
    const species = String(g?.species || '').trim() || null;
    const feedingEligible = !!g?.feedingEligible;
    const avgMilkKg = Number.isFinite(Number(g?.avgMilkKg)) ? Number(g.avgMilkKg) : null;
    const avgDim = Number.isFinite(Number(g?.avgDim)) ? Number(g.avgDim) : null;

    const nums = Array.isArray(g?.animalNumbers)
      ? g.animalNumbers.map(x => String(x).trim()).filter(Boolean)
      : [];

    for (const n of nums) {
      const animalNumberKey = String(n);

      const incomingPatch = {
        group: groupName || null,
        groupId: groupId || null,
        groupKey: groupKey || null,
        feedingEligible,
        groupSpecies: species,
        groupAvgMilkKg: avgMilkKg,
        groupAvgDim: avgDim,
        groupUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const currentPatch = desired.get(animalNumberKey);

      const incomingIsAll =
        groupKey === "all" ||
        groupId === "cow_all" ||
        groupId === "buffalo_all";

      const currentIsOperational =
        currentPatch &&
        currentPatch.groupKey &&
        currentPatch.groupKey !== "all" &&
        currentPatch.groupId !== "cow_all" &&
        currentPatch.groupId !== "buffalo_all";

      // لا تجعل جروب "كل الأبقار/كل الجاموس" يغطي الجروب التشغيلي
      // مثل حديث الولادة / عالي / متوسط / منخفض / جاف / انتظار ولادة
      if (incomingIsAll && currentIsOperational) {
        continue;
      }

      desired.set(animalNumberKey, incomingPatch);
    }
  }

  const animalsSnap = await db.collection('animals')
    .where('userId', '==', tenant)
    .limit(5000)
    .get();

  if (animalsSnap.empty) return;

  let batch = db.batch();
  let ops = 0;

  for (const d of animalsSnap.docs) {
    const a = d.data() || {};
    const animalNum = String(a.animalNumber ?? a.number ?? '').trim();
    const patch = desired.get(animalNum);

    if (patch) {
      batch.set(d.ref, patch, { merge: true });
    } else {
      batch.set(d.ref, {
        group: admin.firestore.FieldValue.delete(),
        groupId: admin.firestore.FieldValue.delete(),
        groupKey: admin.firestore.FieldValue.delete(),
        feedingEligible: admin.firestore.FieldValue.delete(),
        groupSpecies: admin.firestore.FieldValue.delete(),
        groupAvgMilkKg: admin.firestore.FieldValue.delete(),
        groupAvgDim: admin.firestore.FieldValue.delete(),
        groupUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    ops++;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) {
    await batch.commit();
  }
}
// ============================================================
//                API: NUTRITION TARGETS (CENTRAL)
// ============================================================
app.post('/api/nutrition/targets', requireUserId, async (req, res) => {
  try {
    const body = req.body || {};
    const ctx = normalizeNutritionContext(body.context || {});

const built = buildNutritionCentralTargets(ctx);
const publicTargets = { ...built.targetsCore };
publicTargets.cpReferencePct = publicTargets.cpReferencePct ?? publicTargets.cpTarget ?? null;
delete publicTargets.cpTarget;

return res.json({
  ok: true,
  targets: cleanObj({
    ...publicTargets,
        inputs: {
          bodyWeightKgUsed: built.runtimeCtx.bodyWeightKgUsed,
          milkFatPctUsed: built.runtimeCtx.milkFatPctUsed,
          milkProteinPctUsed: built.runtimeCtx.milkProteinPctUsed,
          lactationNumberUsed: built.runtimeCtx.lactationNumberUsed,
          thiUsed: built.runtimeCtx.thiUsed,
          bcsUsed: built.runtimeCtx.bcsUsed,
          
        }
      })
    });
  } catch (e) {
    console.error('nutrition.targets error:', e);
    return res.status(500).json({
      ok: false,
      error: 'nutrition_targets_failed',
      message: e.message || String(e)
    });
  }
});
app.post('/api/nutrition/analyze-ration', requireUserId, async (req, res) => {
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: 'nutrition_rows_required'
      });
    }

   const context = normalizeNutritionContext(body.context || {});
const mode = body.mode || 'tmr_asfed';
const concKg = toNumOrNull(body.concKg);
const milkPrice = toNumOrNull(body.milkPrice);

const enrichedRows = await enrichNutritionRowsFromFeedItems(req.userId, rows);
const normalizedRows = normalizeNutritionRows(enrichedRows);
const missingPriceRows = findMissingNutritionPrices(normalizedRows);
if (missingPriceRows.length) {
  return res.status(400).json({
    ok: false,
    error: 'feed_price_required',
    message: 'سعر كل خامة داخل التركيبة إجباري لحساب التحليل الاقتصادي بدقة',
    missingRows: missingPriceRows.map(r => r.name || r.nameAr || r.feedName || r.id).slice(0, 10)
  });
}
console.log('NUTRITION ANALYZE rawRows[0] =', rows[0] || null);
console.log('NUTRITION ANALYZE enrichedRows[0] =', enrichedRows[0] || null);
console.log('NUTRITION ANALYZE normalizedRows[0] =', normalizedRows[0] || null);

const analysis = buildNutritionCentralAnalysis({
  rows: normalizedRows,
  context,
  mode,
  concKg,
  milkPrice
});

const panels = buildNutritionPanels(analysis, context);

return res.json({
  ok: true,
  analysis,
  panels
});

  } catch (e) {
    console.error('nutrition.analyze-ration error:', e);
    return res.status(500).json({
      ok: false,
      error: 'nutrition_analyze_failed',
      message: e.message || String(e)
    });
  }
});
app.get('/api/nutrition/custom-feeds', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_unavailable' });

    const snap = await db.collection('custom_feed_items')
      .where('userId', '==', req.userId)
      .get();

    const feeds = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (d.enabled === false) return;
      if (d.source !== 'user_custom' && d.scope !== 'farm_private') return;

      feeds.push({
        id: doc.id,
        ...d
      });
    });

    return res.json({ ok:true, feeds });
  } catch (e) {
    console.error('custom feeds list failed:', e.message || e);
    return res.status(500).json({ ok:false, error:'custom_feeds_list_failed' });
  }
});

app.post('/api/nutrition/custom-feed', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_unavailable' });

    const body = req.body || {};
    const customType = String(body.customType || 'mineral_vitamin_premix').trim();
    const userLabel = String(body.userLabel || '').trim();

    const nameAr = String(
      body.nameAr ||
      userLabel ||
      'بريمكس مزرعتي'
    ).trim();

    const feed = cleanObj({
      userId: req.userId,
      ownerUid: req.userId,
      scope: 'farm_private',
      source: 'user_custom',
      sourceStatus: 'USER_ENTERED',
      enabled: true,

      customType,
      userLabel,
      nameAr,

      cat: 'add',
      category: body.category || 'Vitamin/Mineral',
      type: body.type || 'Concentrate',
      dmPct: 100,
      cpPct: toNumOrNull(body.cpPct) || 0,
      caPct: toNumOrNull(body.caPct),
      pPct: toNumOrNull(body.pPct),
      mgPct: toNumOrNull(body.mgPct),
      naPct: toNumOrNull(body.naPct),
      kPct: toNumOrNull(body.kPct),
      clPct: toNumOrNull(body.clPct),
      sPct: toNumOrNull(body.sPct),

      znMgKgDM: toNumOrNull(body.znMgKgDM),
      cuMgKgDM: toNumOrNull(body.cuMgKgDM),
      mnMgKgDM: toNumOrNull(body.mnMgKgDM),
      seMgKgDM: toNumOrNull(body.seMgKgDM),
      iMgKgDM: toNumOrNull(body.iMgKgDM),
      coMgKgDM: toNumOrNull(body.coMgKgDM),
      feMgKgDM: toNumOrNull(body.feMgKgDM),

      vitAIUPerKgDM: toNumOrNull(body.vitAIUPerKgDM),
      vitDIUPerKgDM: toNumOrNull(body.vitDIUPerKgDM),
      vitEIUPerKgDM: toNumOrNull(body.vitEIUPerKgDM),
      biotinMgKgDM: toNumOrNull(body.biotinMgKgDM),
      niacinMgKgDM: toNumOrNull(body.niacinMgKgDM),
      cholineMgKgDM: toNumOrNull(body.cholineMgKgDM),

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const ref = db.collection('custom_feed_items').doc();
    await ref.set(feed, { merge:true });

    return res.json({
      ok:true,
      feed: {
        id: ref.id,
        ...feed
      }
    });
  } catch (e) {
    console.error('custom feed save failed:', e.message || e);
    return res.status(500).json({
      ok:false,
      error:'custom_feed_save_failed',
      message:'تعذر حفظ البريمكس المخصص.'
    });
  }
});
// ============================================================
//                  API: NUTRITION SAVE (CENTRAL)
// ============================================================
app.post('/api/nutrition/save', requireUserId, async (req, res) => {
  try {
const tenant = req.userId;
const body = req.body || {};
const editEventId = String(body.eventId || body.id || '').trim();
const isGroup = !!body.isGroup;

const rawNumber =
  body.animalNumber ||
  body.number ||
  body.animalId ||
  '';

const animalNumber = String(rawNumber || '').trim();
const eventDate = asYMD(body.eventDate) || toYYYYMMDD(Date.now());

const groupNumbers = Array.isArray(body.groupNumbers)
  ? body.groupNumbers.map(x => String(x).trim()).filter(Boolean)
  : [];

if (!isGroup && !animalNumber) {
  return res.status(400).json({ ok:false, error:'animalNumber_required' });
}

if (isGroup && !groupNumbers.length) {
  return res.status(400).json({ ok:false, error:'groupNumbers_required' });
}

const nutrition = body.nutrition || {};
const rawRows = Array.isArray(nutrition.rows) ? nutrition.rows : [];
const enrichedRows = await enrichNutritionRowsFromFeedItems(tenant, rawRows);
const rows = normalizeNutritionRows(enrichedRows);
const missingPriceRows = findMissingNutritionPrices(rows);

if (missingPriceRows.length) {
  return res.status(400).json({
    ok: false,
    error: 'feed_price_required',
    message: 'سعر كل خامة داخل التركيبة إجباري لحساب التحليل الاقتصادي بدقة',
    missingRows: missingPriceRows.map(r => r.name).slice(0, 10)
  });
}    
const context = normalizeNutritionContext(nutrition.context || {});

console.log('NUTRITION SAVE rawRows.length =', rawRows.length);
console.log('NUTRITION SAVE rawRows[0] =', rawRows[0] || null);
console.log('NUTRITION SAVE normalizedRows.length =', rows.length);
console.log('NUTRITION SAVE normalizedRows[0] =', rows[0] || null);
console.log('NUTRITION SAVE normalizedContext =', context);
console.log('NUTRITION SAVE enrichedRows[0] =', enrichedRows[0] || null);

if (!rows.length) {
  return res.status(400).json({
    ok:false,
    error:'nutrition_rows_required',
    debug: {
      rawRowsLength: rawRows.length,
      firstRawRow: rawRows[0] || null,
      normalizedRowsLength: rows.length,
      firstNormalizedRow: rows[0] || null
    }
  });
}

const mode = nutrition.mode || 'tmr_asfed';
const concKg = toNumOrNull(nutrition.concKg);

const milkPrice = toNumOrNull(
  nutrition.milkPrice ??
  nutrition.context?.milkPrice
);

const isDrySave =
  context?.earlyDry === true ||
  context?.closeUp === true ||
  /جاف|dry|انتظار|تحضير|close/i.test(String(
    context?.groupType ||
    context?.groupName ||
    context?.pregnancyStatus ||
    ''
  ));

if (!isDrySave && (!Number.isFinite(Number(milkPrice)) || Number(milkPrice) <= 0)) {
  return res.status(400).json({
    ok: false,
    error: 'milk_price_required',
    message: 'سعر اللبن إجباري للحلاب فقط لحساب الهامش و IOFC في تقرير التغذية.'
  });
}

if (Number.isFinite(Number(milkPrice)) && Number(milkPrice) > 0) {
  context.milkPrice = milkPrice;
}
const centralAnalysis = buildNutritionCentralAnalysis({
  rows,
  context,
  mode,
  concKg,
  milkPrice
});
    const centralPanels = buildNutritionPanels(centralAnalysis, context);
   let animalDoc = null;
let animalDocId = '';

if (!isGroup && db) {
  animalDoc = await findAnimalDocRefByNumberForTenant(tenant, animalNumber);
  if (!animalDoc) {
    return res.status(404).json({ ok:false, error:'animal_not_found' });
  }
  animalDocId = animalDoc.id;
}

    const nowMs = Date.now();

 const doc = cleanObj({
  userId: tenant,
  ownerUid: tenant,

  animalId: isGroup ? null : (animalDocId || animalNumber),
  animalNumber: isGroup
    ? null
    : (Number.isFinite(Number(animalNumber)) ? Number(animalNumber) : animalNumber),

  groupNumbers: isGroup ? groupNumbers : null,
  groupSize: isGroup ? groupNumbers.length : null,

  type: isGroup ? 'nutrition_group' : 'nutrition',
  eventType: isGroup ? 'تغذية مجموعة' : 'تغذية',
  eventTypeNorm: isGroup ? 'nutrition_group' : 'nutrition',

  eventDate,
  date: eventDate,
  ts: nowMs,
  source: '/nutrition.html',

nutrition: {
  mode: nutrition.mode || 'tmr_asfed',
  rows,
  context,
  milkPrice,
  analysis: centralAnalysis,
  panels: centralPanels
}
});

const localEvents = readJson(eventsPath, []);

if (editEventId) {
  const idx = localEvents.findIndex(e =>
    String(e.firestoreId || e.id || '') === editEventId
  );

  if (idx >= 0) {
    localEvents[idx] = {
      ...localEvents[idx],
      ...doc,
      firestoreId: editEventId,
      updatedAt: nowMs,
      createdAt: localEvents[idx].createdAt || localEvents[idx].ts || nowMs
    };
    fs.writeFileSync(eventsPath, JSON.stringify(localEvents, null, 2));
  }
} else {
  localEvents.push({ id: localEvents.length + 1, ...doc });
  fs.writeFileSync(eventsPath, JSON.stringify(localEvents, null, 2));
}
let firestoreId = null;
let updatedExisting = false;

if (db) {
  const fireDoc = {
    ...doc,
    updatedAt: admin.firestore.Timestamp.fromMillis(nowMs)
  };

  if (editEventId) {
    const ref = db.collection('events').doc(editEventId);
    const oldSnap = await ref.get();

    if (!oldSnap.exists) {
      return res.status(404).json({
        ok: false,
        error: 'nutrition_event_not_found',
        message: 'العليقة المحفوظة غير موجودة.'
      });
    }

    const old = oldSnap.data() || {};
    const oldUserId = String(old.userId || old.ownerUid || '').trim();

    if (oldUserId && oldUserId !== tenant) {
      return res.status(403).json({
        ok: false,
        error: 'nutrition_event_forbidden',
        message: 'لا يمكن تعديل عليقة لا تخص هذا المستخدم.'
      });
    }

    const oldTypeText = [
      old.type,
      old.eventTypeNorm,
      old.eventType
    ].map(x => String(x || '').toLowerCase()).join(' ');

    const isNutritionDoc =
      oldTypeText.includes('nutrition') ||
      oldTypeText.includes('تغذية');

    if (!isNutritionDoc) {
      return res.status(400).json({
        ok: false,
        error: 'not_nutrition_event',
        message: 'هذه الوثيقة ليست عليقة تغذية.'
      });
    }

    await ref.set({
      ...fireDoc,
      createdAt: old.createdAt || admin.firestore.Timestamp.fromMillis(nowMs)
    }, { merge: true });

    firestoreId = editEventId;
    updatedExisting = true;
  } else {
    fireDoc.createdAt = admin.firestore.Timestamp.fromMillis(nowMs);

    const ref = await db.collection('events').add(fireDoc);
    firestoreId = ref.id;
  }
}

return res.json({
  ok: true,
  saved: true,
  updated: updatedExisting,
  eventType: 'nutrition',
  animalNumber,
  eventDate,
  firestoreId
});

  } catch (e) {
    console.error('nutrition.save error:', e);
    return res.status(500).json({ ok:false, error:'nutrition_save_failed', message: e.message || String(e) });
  }
});

// ============================================================
//                  API: NUTRITION REPORTS
// ============================================================
function eventCreatedMs(e = {}) {
  const c = e.createdAt;
  try {
    if (c && typeof c.toMillis === 'function') return c.toMillis();
    if (c && typeof c.toDate === 'function') return c.toDate().getTime();
  } catch (_) {}
  if (c && Number.isFinite(Number(c._seconds))) return Number(c._seconds) * 1000;
  if (c && Number.isFinite(Number(c.seconds))) return Number(c.seconds) * 1000;
  if (Number.isFinite(Number(e.ts))) return Number(e.ts);
  const d = toDate(e.eventDate || e.date);
  return d ? d.getTime() : 0;
}

function normReportText(v = '') {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

function nutritionGroupNameFromEvent(e = {}) {
  const ctx = e?.nutrition?.context || {};
  return String(
    ctx.groupName ||
    ctx.group ||
    ctx.groupLabel ||
    e.groupName ||
    ''
  ).trim();
}

function nutritionStageFromEvent(e = {}) {
  const ctx = e?.nutrition?.context || {};
  const targets = e?.nutrition?.analysis?.targets || {};
  const groupType = String(ctx.groupType || '').trim().toLowerCase();
  const avgMilk = Number(ctx.avgMilkKg || e?.nutrition?.analysis?.inputs?.avgMilkKg || 0);

  if (ctx.closeUp || groupType.includes('close')) return 'close_up';
  if (ctx.earlyDry || groupType.includes('far') || groupType.includes('dry')) return 'far_dry';
  if (avgMilk > 0 || groupType.includes('lact')) return 'lactating';

  const chapterStage = String(targets?.chapter12EnergyModel?.stage || '').toLowerCase();
  if (chapterStage.includes('close')) return 'close_up';
  if (chapterStage.includes('far') || chapterStage.includes('dry')) return 'far_dry';

  return 'unknown';
}

function nutritionSpeciesKeyFromEvent(e = {}) {
  const s = String(e?.nutrition?.context?.species || '').trim().toLowerCase();
  if (s.includes('جاموس') || s.includes('buffalo')) return 'buffalo';
  if (s.includes('بقر') || s.includes('cow')) return 'cows';
  return '';
}

function isNutritionSavedEvent(e = {}) {
  const t = String(e.type || e.eventTypeNorm || '').trim().toLowerCase();
  return t === 'nutrition' || t === 'nutrition_group';
}

async function fetchNutritionReportEvents(tenant, limit = 900) {
  if (!db) return readJson(eventsPath, []).filter(e => belongs(e, tenant) || tenantKey(e.ownerUid) === tenantKey(tenant));

  const byId = new Map();
  async function pull(field) {
    try {
      const snap = await db.collection('events')
        .where(field, '==', tenant)
        .limit(limit)
        .get();
      snap.forEach(d => byId.set(d.id, { id: d.id, ...(d.data() || {}) }));
    } catch (e) {
      console.error('nutrition report pull failed:', field, e.message || e);
    }
  }

  await pull('ownerUid');
  await pull('userId');

  return [...byId.values()];
}

function filterNutritionReportEvents(events, { type, stage, groupName } = {}) {
  const typeKey = String(type || '').trim().toLowerCase();
  const wantedSpecies = typeKey === 'buffalo' ? 'buffalo' : (typeKey === 'cows' ? 'cows' : '');
  const wantedStage = String(stage || '').trim().toLowerCase();
  const wantedGroup = normReportText(groupName || '');

  return (events || [])
    .filter(isNutritionSavedEvent)
    .filter(e => e?.nutrition?.analysis && e?.nutrition?.context)
    .filter(e => !wantedSpecies || nutritionSpeciesKeyFromEvent(e) === wantedSpecies)
    .filter(e => !wantedStage || nutritionStageFromEvent(e) === wantedStage)
    .filter(e => !wantedGroup || normReportText(nutritionGroupNameFromEvent(e)) === wantedGroup)
    .sort((a, b) => eventCreatedMs(b) - eventCreatedMs(a));
}

function buildLactatingNutritionSummary(events = []) {
  const latestByGroup = new Map();

  for (const e of events) {
    if (nutritionStageFromEvent(e) !== 'lactating') continue;
    const name = nutritionGroupNameFromEvent(e) || `مجموعة ${e.groupSize || e?.nutrition?.context?.headCount || ''}`.trim();
    const key = normReportText(name) || e.id || String(eventCreatedMs(e));
    if (!latestByGroup.has(key)) latestByGroup.set(key, e);
  }

  const groups = [...latestByGroup.values()].map(e => {
    const a = e.nutrition.analysis || {};
    const ctx = e.nutrition.context || {};
    const heads = Number(e.groupSize || ctx.headCount || 1) || 1;
    const avgMilk = Number(ctx.avgMilkKg || 0) || 0;
    const totalMilk = +(heads * avgMilk).toFixed(2);
    const feedCostHead = Number(a?.totals?.totCost || 0) || 0;
    const milkRevenueHead = Number(a?.economics?.milkRevenue || 0) || 0;
    const marginHead = Number.isFinite(Number(a?.economics?.milkMargin))
      ? Number(a.economics.milkMargin)
      : (milkRevenueHead - feedCostHead);

    return {
      id: e.id || null,
      groupName: nutritionGroupNameFromEvent(e) || null,
      eventDate: e.eventDate || e.date || null,
      headCount: heads,
      avgMilkKg: avgMilk,
      totalMilkKg: totalMilk,
      feedCostPerHead: +feedCostHead.toFixed(2),
      milkRevenuePerHead: +milkRevenueHead.toFixed(2),
      marginPerHead: +marginHead.toFixed(2),
      totalFeedCost: +(feedCostHead * heads).toFixed(2),
      totalMilkRevenue: +(milkRevenueHead * heads).toFixed(2),
      totalMargin: +(marginHead * heads).toFixed(2),
      costPerKgMilk: Number(a?.economics?.costPerKgMilk || 0) || 0,
      dmPerKgMilk: Number(a?.economics?.dmPerKgMilk || 0) || 0,
      cpPctTotal: Number(a?.nutrition?.cpPctTotal || 0) || 0,
      mpBalanceG: Number(a?.nutrition?.mpBalanceG || 0) || 0,
      nelActual: Number(a?.nutrition?.nelActual || 0) || 0,
      ndfPctActual: Number(a?.nutrition?.ndfPctActual || 0) || 0,
      starchPctActual: Number(a?.nutrition?.starchPctActual || 0) || 0,
      fatPctActual: Number(a?.nutrition?.fatPctActual || 0) || 0,
      rumenStatus: a?.nutrition?.rumenStatus || null
    };
  });

  const totals = groups.reduce((acc, g) => {
    acc.headCount += Number(g.headCount || 0);
    acc.totalMilkKg += Number(g.totalMilkKg || 0);
    acc.totalFeedCost += Number(g.totalFeedCost || 0);
    acc.totalMilkRevenue += Number(g.totalMilkRevenue || 0);
    acc.totalMargin += Number(g.totalMargin || 0);
    return acc;
  }, { headCount: 0, totalMilkKg: 0, totalFeedCost: 0, totalMilkRevenue: 0, totalMargin: 0 });

  totals.avgMilkKg = totals.headCount ? +(totals.totalMilkKg / totals.headCount).toFixed(2) : 0;
  totals.costPerKgMilk = totals.totalMilkKg ? +(totals.totalFeedCost / totals.totalMilkKg).toFixed(2) : 0;
  totals.marginPerHead = totals.headCount ? +(totals.totalMargin / totals.headCount).toFixed(2) : 0;

  for (const k of Object.keys(totals)) totals[k] = +Number(totals[k] || 0).toFixed(2);

  const weakest = [...groups].sort((a, b) => Number(a.marginPerHead || 0) - Number(b.marginPerHead || 0))[0] || null;
  const best = [...groups].sort((a, b) => Number(b.marginPerHead || 0) - Number(a.marginPerHead || 0))[0] || null;

  return { groups, totals, best, weakest };
}
function nutritionReportKeyFromEvent(e = {}) {
  const species = nutritionSpeciesKeyFromEvent(e) || 'unknown_species';
  const stage = nutritionStageFromEvent(e) || 'unknown_stage';
  const groupName = nutritionGroupNameFromEvent(e) || 'مجموعة بدون اسم';

  return [
    species,
    stage,
    normReportText(groupName)
  ].join('__');
}

function stageSortWeight(stage = '') {
  const s = String(stage || '').toLowerCase();
  if (s === 'lactating') return 1;
  if (s === 'far_dry') return 2;
  if (s === 'close_up') return 3;
  return 9;
}

function stageLabelSrv(stage = '') {
  const s = String(stage || '').toLowerCase();
  if (s === 'lactating') return 'حلاب';
  if (s === 'far_dry') return 'جاف بعيد';
  if (s === 'close_up') return 'انتظار الولادة';
  return 'غير محدد';
}

function speciesLabelSrv(species = '') {
  const s = String(species || '').toLowerCase();
  if (s === 'buffalo') return 'جاموس';
  if (s === 'cows') return 'أبقار';
  return 'غير محدد';
}

function pickDecisionCardSrv(e = {}) {
  const cards = e?.nutrition?.panels?.analysisCards || [];
  return cards.find(c => String(c?.key || '').toLowerCase() === 'decision') || null;
}

function pickPriorityCardSrv(e = {}) {
  const cards = e?.nutrition?.panels?.analysisCards || [];
  return cards.find(c => String(c?.key || '').toLowerCase() === 'priority') || null;
}

function reportStatusFromEventSrv(e = {}) {
  const status = String(
    e?.nutrition?.reportStatus ||
    e?.nutrition?.reportDecision?.status ||
    e?.nutrition?.analysis?.nutrition?.rumenStatus ||
    ''
  ).toLowerCase();

  if (status.includes('danger')) return 'danger';
  if (status.includes('warn') || status.includes('watch')) return 'warn';
  if (status.includes('good') || status.includes('ok')) return 'good';

  return 'muted';
}
function reportEconomicsMetricsSrv(e = {}){
  const ec = e?.nutrition?.analysis?.economics || {};
  const m = ec?.economicDecision?.metrics || {};

  const n = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  return {
    costPerKgMilk: n(m.costPerKgMilk ?? ec.costPerKgMilk),
    feedCostPctOfMilkIncome: n(m.feedCostPctOfMilkIncome ?? ec.feedCostPctOfMilkIncome),
    iofcPctOfMilkIncome: n(m.iofcPctOfMilkIncome ?? ec.iofcPctOfMilkIncome),
    milkMargin: n(m.iofcPerHead ?? ec.milkMargin),
    iofcPerHead: n(m.iofcPerHead ?? ec.milkMargin)
  };
}
function buildNutritionReportIndexItem(e = {}) {
  const ctx = e?.nutrition?.context || {};
  const a = e?.nutrition?.analysis || {};
  const ecoReport = reportEconomicsMetricsSrv(e);
  const stage = nutritionStageFromEvent(e);
  const species = nutritionSpeciesKeyFromEvent(e);
  const reportDecision = e?.nutrition?.reportDecision || {};
  const finalStatus = e?.nutrition?.reportStatus || reportDecision.status || reportStatusFromEventSrv(e);
  const headCount =
    Number(e.groupSize || ctx.headCount || 0) || null;

  const milkTarget =
    Number(ctx?.formulationTarget?.milkKg || ctx.avgMilkKg || 0) || null;

  return cleanObj({
    id: e.id || null,
    groupName: nutritionGroupNameFromEvent(e) || 'مجموعة بدون اسم',
    stage,
    stageLabel: stageLabelSrv(stage),
    species,
    speciesLabel: speciesLabelSrv(species),
    eventDate: e.eventDate || e.date || null,
    createdMs: eventCreatedMs(e),
    headCount,
    milkTargetKg: milkTarget,
    dmiTarget: a?.targets?.dmiTarget ?? null,
    dmActual: a?.totals?.dmKg ?? null,
    nelTarget: a?.targets?.nelTarget ?? null,
    nelActual: a?.nutrition?.nelActual ?? null,
    mpTargetG: a?.targets?.mpTargetG ?? null,
    mpSupplyG: a?.nutrition?.mpSupplyG ?? null,
    mpBalanceG: a?.nutrition?.mpBalanceG ?? null,
    ndfPctActual: a?.nutrition?.ndfPctActual ?? null,
    starchPctActual: a?.nutrition?.starchPctActual ?? null,
    fatPctActual: a?.nutrition?.fatPctActual ?? null,
    costPerKgMilk: ecoReport.costPerKgMilk,
    milkMargin: ecoReport.milkMargin,
    feedCostPctOfMilkIncome: ecoReport.feedCostPctOfMilkIncome,
    iofcPctOfMilkIncome: ecoReport.iofcPctOfMilkIncome,
    rumenStatus: a?.nutrition?.rumenStatus || null,
    reportStatus: finalStatus,
    reportStatusText: reportDecision.statusText || reportStatusTextSrv(finalStatus),
    decisionText: reportDecision.title || null,
    priorityText: reportDecision.action || null
  });
}
function finiteSrv(v){
  return Number.isFinite(Number(v));
}

function fmtSrv(v, d = 2, suffix = ''){
  if (!finiteSrv(v)) return '—';
  const n = Number(v);
  const txt = Number.isInteger(n) ? String(n) : n.toFixed(d);
  return suffix ? `${txt} ${suffix}` : txt;
}

function reportBalanceStatusSrv(balance, tolerance = 0){
  if (!finiteSrv(balance)) return 'muted';
  if (Number(balance) < -Math.abs(tolerance)) return 'danger';
  if (Number(balance) > Math.abs(tolerance)) return 'warn';
  return 'good';
}
function reportRatioStatusSrv(actual, target, tolerancePct = 5){
  if (!finiteSrv(actual) || !finiteSrv(target) || Number(target) === 0) return 'muted';

  const ratioPct = ((Number(actual) - Number(target)) / Number(target)) * 100;

  if (ratioPct < -Math.abs(tolerancePct)) return 'danger';
  if (ratioPct > Math.abs(tolerancePct)) return 'warn';
  return 'good';
}
function reportCoverageStatusSrv(cover, tolerancePct = 5){
  if (!finiteSrv(cover)) return 'muted';

  const diffPct = Number(cover) - 100;

  if (diffPct < -Math.abs(tolerancePct)) return 'danger';
  if (diffPct > Math.abs(tolerancePct)) return 'warn';
  return 'good';
}

function reportCoverageBalanceTextSrv(cover){
  if (!finiteSrv(cover)) return '—';

  const diffPct = Number(cover) - 100;
  const sign = diffPct > 0 ? '+' : '';

  return `${sign}${diffPct.toFixed(1)}%`;
}
function reportUnitBalanceTextSrv(actual, target, decimals = 2, suffix = ''){
  if (!finiteSrv(actual) || !finiteSrv(target)) return '—';

  const diff = Number(actual) - Number(target);
  const sign = diff > 0 ? '+' : '';

  return `${sign}${fmtSrv(diff, decimals, suffix)}`;
}
function reportRatioBalanceTextSrv(actual, target){
  if (!finiteSrv(actual) || !finiteSrv(target) || Number(target) === 0) return '—';

  const ratioPct = ((Number(actual) - Number(target)) / Number(target)) * 100;
  const sign = ratioPct > 0 ? '+' : '';

  return `${sign}${ratioPct.toFixed(1)}%`;
}
function reportMinStatusSrv(actual, min){
  if (!finiteSrv(actual) || !finiteSrv(min)) return 'muted';
  return Number(actual) < Number(min) ? 'warn' : 'good';
}

function reportMaxStatusSrv(actual, max){
  if (!finiteSrv(actual) || !finiteSrv(max)) return 'muted';
  return Number(actual) > Number(max) ? 'warn' : 'good';
}

function reportStatusTextSrv(status = ''){
  const s = String(status || '').toLowerCase();
  if (s.includes('danger')) return 'تنبيه';
  if (s.includes('warn') || s.includes('watch')) return 'متابعة';
  if (s.includes('good') || s.includes('ok')) return 'متزن';
  return 'معلومة';
}

function reportRowSrv(section, key, label, targetText, actualText, balanceText, status, note, statusTextOverride = null){
  return cleanObj({
    section,
    key,
    label,
    targetText: targetText || '—',
    actualText: actualText || '—',
    balanceText: balanceText || '—',
    status: status || 'muted',
    statusText: statusTextOverride || reportStatusTextSrv(status),
    note: note || '—'
  });
}
function reportBalanceStateTextSrv(status, balance = null){
  const s = String(status || '').toLowerCase();
  const b = Number(balance);

  if (s.includes('good') || s.includes('ok')) return 'كافية';
  if (Number.isFinite(b) && b < 0) return 'ناقصة';
  if (Number.isFinite(b) && b > 0) return 'زائدة';
  if (s.includes('warn') || s.includes('watch') || s.includes('danger')) return 'يحتاج ضبط';
  return 'غير مكتمل';
}

function reportMurabbikGuidanceSrv(key, status, balance = null, stage = ''){
  const k = String(key || '').trim();
  const s = String(status || '').toLowerCase();
  const b = Number(balance);
  const good = s.includes('good') || s.includes('ok');

  const st = String(stage || '').toLowerCase();
  const isFarDry = st === 'far_dry';
  const isCloseUp = st === 'close_up';

  if (k === 'dmi') {
    if (isCloseUp) return 'يجب أن يتوفر العلف في المعلف 24 ساعة يوميًا مع متابعة المتبقي والشهية؛ أي هبوط في المأكول قبل الولادة يحتاج مراجعة فورية.';
    if (isFarDry) return 'يجب أن يتوفر العلف في المعلف 24 ساعة يوميًا مع متابعة المتبقي وحالة الجسم، بدون دفع زائد للطاقة.';
    return '—';
  }

  if (k === 'nel') {
    if (isCloseUp) {
      if (good) return 'الطاقة مناسبة لمرحلة انتظار الولادة؛ حافظ على المأكول وثبات الخلطة لتقليل اضطرابات ما بعد الولادة.';
      if (Number.isFinite(b) && b < 0) return 'الطاقة أقل من الاحتياج في انتظار الولادة؛ راجع كثافة الطاقة مع الحفاظ على أمان الكرش وعدم رفع النشا عشوائيًا.';
      if (Number.isFinite(b) && b > 0) return 'الطاقة أعلى من الاحتياج في انتظار الولادة؛ راجع كثافة العليقة لتجنب زيادة الحالة الجسمانية واضطرابات الولادة.';
      return 'اضبط طاقة عليقة انتظار الولادة قبل الاعتماد.';
    }

    if (isFarDry) {
      if (good) return 'الطاقة مناسبة للجاف البعيد؛ حافظ على حالة الجسم بدون تسمين زائد.';
      if (Number.isFinite(b) && b < 0) return 'الطاقة أقل من احتياج الجاف البعيد؛ راجع جودة الخشن وكفاية المادة الجافة.';
      if (Number.isFinite(b) && b > 0) return 'الطاقة أعلى من احتياج الجاف البعيد؛ قلل كثافة العليقة لتجنب السمنة قبل الدخول في انتظار الولادة.';
      return 'اضبط طاقة عليقة الجاف البعيد قبل الاعتماد.';
    }

    if (good) return 'ممتاز؛ حافظ على اتزان الطاقة وصحة الكرش.';
    if (Number.isFinite(b) && b < 0) return 'ارفع كثافة الطاقة في العليقة مع الحفاظ على صحة الكرش؛ نقص الطاقة يؤدي إلى فقد في إنتاج اللبن وجودته وفقد الحالة الجسمانية للحيوان.';
    if (Number.isFinite(b) && b > 0) return 'اضبط الطاقة في العليقة؛ زيادة الطاقة ترفع تكاليف التغذية بلا داعٍ وقد تسبب سمنة الحيوان.';
    return 'اضبط توازن الطاقة قبل اعتماد العليقة.';
  }

  if (k === 'mp') {
    if (isCloseUp) {
      if (good) return 'البروتين الممثل مناسب لانتظار الولادة؛ حافظ على جودة البروتين لدعم الجنين واللبأ وبداية الموسم.';
      if (Number.isFinite(b) && b < 0) return 'البروتين الممثل أقل من الاحتياج في انتظار الولادة؛ راجع جودة مصدر البروتين والهضم دون رفع البروتين الخام عشوائيًا.';
      if (Number.isFinite(b) && b > 0) return 'البروتين الممثل أعلى من الاحتياج في انتظار الولادة؛ راجع كمية أو نوع مصدر البروتين لتقليل التكلفة والهدر.';
      return 'اضبط البروتين الممثل في عليقة انتظار الولادة قبل الاعتماد.';
    }

    if (isFarDry) {
      if (good) return 'البروتين الممثل مناسب للجاف البعيد؛ حافظ على الاتزان بدون زيادة غير ضرورية في تكلفة البروتين.';
      if (Number.isFinite(b) && b < 0) return 'البروتين الممثل أقل من احتياج الجاف البعيد؛ راجع جودة مصدر البروتين وكفاية الإمداد.';
      if (Number.isFinite(b) && b > 0) return 'البروتين الممثل أعلى من احتياج الجاف البعيد؛ راجع مصدر البروتين لتقليل التكلفة والهدر.';
      return 'اضبط البروتين الممثل في عليقة الجاف البعيد قبل الاعتماد.';
    }

    if (good) return 'ممتاز؛ حافظ على اتزان البروتين الممثل للحفاظ على إنتاج اللبن وجودته وصحة الحيوان والحمل.';
    if (Number.isFinite(b) && b < 0) return 'نقص البروتين الممثل يؤدي إلى نقص إنتاج اللبن وجودته؛ حسّن مصدر البروتين في العليقة.';
    if (Number.isFinite(b) && b > 0) return 'زيادة البروتين الممثل تعني رفع التكاليف وتقليص هامش لبن / علف.';
    return 'اضبط البروتين الممثل قبل اعتماد العليقة.';
  }

  if (k === 'cp') return '—';

  if (k === 'ndf') {
    if (isCloseUp) {
      if (good) return 'الألياف المتعادلة مناسبة لانتظار الولادة؛ حافظ على الخشن الكافي مع منع فرز العليقة.';
      return 'راجع مستوى وجودة الخشن والألياف الفعالة لحماية الكرش قبل الولادة.';
    }

    if (isFarDry) {
      if (good) return 'الألياف المتعادلة مناسبة للجاف البعيد؛ تدعم الشبع وصحة الكرش مع التحكم في الطاقة.';
      return 'راجع جودة وكمية الخشن لدعم الشبع ومنع زيادة الطاقة في الجاف البعيد.';
    }

    if (good) return 'الألياف المتعادلة داخل حدود احتياجات صحة الكرش؛ زيادتها الكبيرة في الحلاب قد تقلل المأكول والإنتاج.';
    return 'ارفع الخشن أو حسّن الألياف الفعالة.';
  }

  if (k === 'starch') {
    if (isCloseUp) {
      if (good) return 'النشا داخل حد الأمان لانتظار الولادة؛ حافظ على توازن الحبوب والخشن وثبات الخلطة.';
      return 'النشا أعلى من حد الأمان في انتظار الولادة؛ راجع الحبوب وتوازن الخشن لتقليل خطر اضطراب الكرش.';
    }

    if (isFarDry) {
      if (good) return 'النشا مناسب للجاف البعيد؛ لا ترفع الحبوب بدون احتياج واضح.';
      return 'النشا أعلى من المناسب للجاف البعيد؛ راجع الحبوب لتجنب زيادة الطاقة والسمنة.';
    }

    if (good) return 'النشا في حدود أمان الكرش ويمكن زيادته بشرط الحفاظ على صحة الكرش.';
    return 'زيادة النشا في العليقة دون ألياف فعالة كافية قد تؤدي إلى الحموضة وقلة الدهن في اللبن.';
  }

  if (k === 'fat') {
    if (isCloseUp) {
      if (good) return 'دهن العليقة داخل حد الأمان لانتظار الولادة ولا يهدد هضم الألياف.';
      return 'دهن العليقة أعلى من حد الأمان في انتظار الولادة؛ راجع مصدر الدهون لأنه قد يؤثر على هضم الألياف وصحة الكرش.';
    }

    if (isFarDry) {
      if (good) return 'دهن العليقة داخل حد الأمان للجاف البعيد.';
      return 'دهن العليقة أعلى من حد الأمان للجاف البعيد؛ راجع مصدر الدهون وتكلفة الإضافة.';
    }

    if (good) return 'الدهون آمنة ولا تهدد كفاءة هضم الألياف وجودة اللبن.';
    return 'تخطي حدود الأمان في الدهون الحرة في العليقة قد يؤدي إلى تقليل هضم الألياف وقلة الطاقة ودهن اللبن.';
  }

  if (k === 'roughage') {
    if (isCloseUp) {
      if (good) return 'الخشن مناسب لانتظار الولادة؛ حافظ على جودة الخشن ومنع الفرز وثبات المعلف.';
      return 'راجع نسبة الخشن وجودته في انتظار الولادة لحماية الكرش والشهية قبل الولادة.';
    }

    if (isFarDry) {
      if (good) return 'الخشن مناسب للجاف البعيد؛ حافظ على الشبع وصحة الكرش والتحكم في الطاقة.';
      return 'ارفع أو حسّن الخشن في الجاف البعيد لدعم الشبع وتقليل مخاطر السمنة.';
    }

    if (good) return 'ممتاز؛ حافظ على جودة الخشن وطول التقطيع من 3 إلى 5 سم لصحة الكرش وكفاءة الاجترار وإفراز اللعاب.';
    return 'ارفع نسبة الخشن في العليقة لتحسين الاجترار والهضم وأمان الكرش.';
  }

  if (k === 'forage_ndf') {
    if (isCloseUp) {
      if (good) return 'ألياف الخشن مناسبة لانتظار الولادة؛ تابع جودة الخشن والمتبقي وصحة الكرش.';
      return 'راجع مصدر الخشن وجودته ونسبة إضافته قبل الولادة.';
    }

    if (isFarDry) {
      if (good) return 'ألياف الخشن مناسبة للجاف البعيد وتساعد على الشبع والتحكم في الطاقة.';
      return 'راجع مصدر الخشن وجودته ونسبة إضافته في الجاف البعيد.';
    }

    if (good) return '—';
    return 'يجب ألا تقل الألياف المتعادلة من الخشن عن 65% من إجمالي الألياف في العليقة.';
  }

  if (k === 'dcad') {
    if (isCloseUp) {
      if (good) return 'DCAD مناسب لانتظار الولادة؛ حافظ على توازن أملاح الأنيون والكالسيوم والماغنسيوم لتقليل مخاطر حمى اللبن.';
      return 'راجع أملاح الأنيون والكالسيوم والماغنسيوم واضبط DCAD؛ هذا بند خاص بانتظار الولادة.';
    }

    return 'DCAD لا يُعرض كهدف تشغيلي في الجاف البعيد.';
  }

  if (k.startsWith('mineral_')) {
    if (good) {
      if (isCloseUp) return 'العنصر يغطي احتياج انتظار الولادة؛ حافظ على الاتزان خاصة الكالسيوم والماغنسيوم والعناصر المرتبطة بالمناعة.';
      if (isFarDry) return 'العنصر يغطي احتياج الجاف البعيد؛ لا تكرر الإضافات بدون سبب.';
      return '—';
    }
    if (Number.isFinite(b) && b < 0) return 'زِد مصدر العنصر أو اضبط الإضافة المعدنية حسب المرحلة.';
    if (Number.isFinite(b) && b > 0) return 'راجع زيادة العنصر وتداخلاته مع باقي المعادن حسب المرحلة.';
    return 'اضبط مصدر الإضافة المعدنية ومعدل الاستخدام.';
  }

  if (k.startsWith('vitamin_')) {
    if (good) {
      if (isCloseUp) return 'الفيتامين يغطي احتياج انتظار الولادة؛ حافظ على الإمداد لدعم المناعة وبداية الموسم.';
      if (isFarDry) return 'الفيتامين يغطي احتياج الجاف البعيد؛ لا تكرر الإضافات بدون داعٍ.';
      return '—';
    }
    if (Number.isFinite(b) && b < 0) return 'زِد مصدر الفيتامين أو اضبط معدل الإضافة حسب المرحلة.';
    if (Number.isFinite(b) && b > 0) return 'راجع زيادة الفيتامين وتكرار مصادر الإضافة.';
    return 'اضبط مصدر الفيتامينات ومعدل الاستخدام.';
  }

  return '—';
}
function reportIofcStatusSrv(pct){
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'muted';
  if (n > 40) return 'good';
  if (n >= 35) return 'warn';
  return 'danger';
}

function reportIofcReadSrv(pct){
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'غير مكتمل';
  if (n > 40) return 'ممتاز';
  if (n >= 35) return 'متابعة';
  return 'يحتاج مراجعة';
}

function reportIofcNoteSrv(pct){
  const n = Number(pct);

  if (!Number.isFinite(n)) {
    return 'أكمل سعر اللبن وتكلفة الخامات حتى يظهر هامش اللبن بعد العلف.';
  }

  if (n > 40) {
    return 'هامش اللبن بعد العلف ممتاز، ويترك مساحة جيدة لتغطية باقي مصروفات المزرعة وتحقيق الربح.';
  }

  if (n >= 35) {
    return 'هامش اللبن بعد العلف مقبول لكنه يحتاج متابعة أسعار الخامات وسعر اللبن والإنتاج.';
  }

  return 'هامش اللبن بعد العلف منخفض؛ راجع تكلفة العلف أو إنتاج اللبن قبل اعتماد العليقة.';
}
function mineralReportRowsSrv(balance = {}, unit = 'g', stage = ''){
  const names = {
    ca: 'كالسيوم',
    p: 'فوسفور',
    mg: 'ماغنسيوم',
    na: 'صوديوم',
    k: 'بوتاسيوم',
    cl: 'كلور',
    s: 'كبريت',
    co: 'كوبالت',
    cu: 'نحاس',
    fe: 'حديد',
    i: 'يود',
    mn: 'منجنيز',
    se: 'سيلينيوم',
    zn: 'زنك',
    mo: 'مولبيدنم'
  };

  return Object.entries(balance || {}).map(([k, item]) => {
    const required = item?.required ?? item?.requiredG ?? item?.requiredMg ?? item?.target ?? null;
    const supplied = item?.supplied ?? item?.suppliedG ?? item?.suppliedMg ?? item?.actual ?? null;
    const bal = item?.balance ?? item?.balanceG ?? item?.balanceMg ??
      (finiteSrv(required) && finiteSrv(supplied) ? Number(supplied) - Number(required) : null);

    const cover = item?.supplyPctOfRequirement ?? item?.coveragePct ?? null;
    const status = reportCoverageStatusSrv(cover, 10);
    const u = unit === 'mg' ? 'مجم' : 'جم';

    let stateText = 'غير مكتمل';
    if (status === 'good') stateText = 'كافية';
    else if (Number.isFinite(Number(bal)) && Number(bal) < 0) stateText = 'ناقصة';
    else if (Number.isFinite(Number(bal)) && Number(bal) > 0) stateText = 'زائدة';

    return reportRowSrv(
      unit === 'mg' ? 'المعادن الصغرى' : 'المعادن الكبرى',
      `mineral_${k}`,
      names[String(k).toLowerCase()] || k,
      fmtSrv(required, unit === 'mg' ? 0 : 2, u),
      fmtSrv(supplied, unit === 'mg' ? 0 : 2, u),
      reportCoverageBalanceTextSrv(cover),
      status,
     reportMurabbikGuidanceSrv(`mineral_${k}`, status, bal, stage),
      stateText
    );
  });
}

function vitaminReportRowsSrv(balance = {}, stage = ''){
  const names = {
    A: 'فيتامين أ',
    D: 'فيتامين د',
    E: 'فيتامين هـ'
  };

  return Object.entries(balance || {}).map(([k, item]) => {
    const required = item?.requiredIU ?? item?.required ?? null;
    const supplied = item?.suppliedIU ?? item?.supplied ?? null;
    const bal = item?.balanceIU ?? item?.balance ??
      (finiteSrv(required) && finiteSrv(supplied) ? Number(supplied) - Number(required) : null);

    const cover = item?.supplyPctOfRequirement ?? item?.coveragePct ?? null;
    const status = reportCoverageStatusSrv(cover, 20);

    let stateText = 'غير مكتمل';
    if (status === 'good') stateText = 'كافية';
    else if (Number.isFinite(Number(bal)) && Number(bal) < 0) stateText = 'ناقصة';
    else if (Number.isFinite(Number(bal)) && Number(bal) > 0) stateText = 'زائدة';

    return reportRowSrv(
      'الفيتامينات',
      `vitamin_${k}`,
      names[k] || `فيتامين ${k}`,
      fmtSrv(required, 0, 'وحدة دولية'),
      fmtSrv(supplied, 0, 'وحدة دولية'),
      reportCoverageBalanceTextSrv(cover),
      status,
      reportMurabbikGuidanceSrv(`vitamin_${k}`, status, bal, stage),
      stateText
    );
  });
}

function reportRowPriorityWeightSrv(r = {}){
  const status = String(r.status || '').toLowerCase();
  const key = String(r.key || '').toLowerCase();
  const section = String(r.section || '').trim();

  let w = 0;

  if (status.includes('danger')) w += 1000;
  else if (status.includes('warn') || status.includes('watch')) w += 500;
  else if (status.includes('good')) w += 100;
  else w += 10;

  // الهامش والاقتصاد لهم أولوية في قراءة التقرير العلوية
  if (section === 'الاقتصاد') w += 220;
  if (key === 'iofc') w += 300;
  if (key === 'feed_cost_daily') w += 180;
  if (key === 'milk_revenue') w += 120;
  // صحة الكرش ثم الطاقة والبروتين
  if (section === 'صحة الكرش') w += 170;
  if (key === 'nel') w += 150;
  if (key === 'mp') w += 150;
  if (key === 'starch') w += 130;
  if (key === 'fat') w += 120;
  if (key === 'ndf') w += 110;

  return w;
}

function pickMainReportRowSrv(rows = []){
  const arr = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!arr.length) return null;

  const bad = arr
    .filter(r => {
      const s = String(r.status || '').toLowerCase();
      return s.includes('danger') || s.includes('warn') || s.includes('watch');
    })
    .sort((a, b) => reportRowPriorityWeightSrv(b) - reportRowPriorityWeightSrv(a));

  if (bad.length) return bad[0];

  return [...arr].sort((a, b) => reportRowPriorityWeightSrv(b) - reportRowPriorityWeightSrv(a))[0] || null;
}
function reportRowByKeySrv(rows = [], key = ''){
  const k = String(key || '').toLowerCase();
  return (Array.isArray(rows) ? rows : []).find(r =>
    String(r?.key || '').toLowerCase() === k
  ) || null;
}

function reportRowBadSrv(row = {}){
  const s = String(row?.status || '').toLowerCase();
  return s.includes('danger') || s.includes('warn') || s.includes('watch');
}

function reportRowDangerSrv(row = {}){
  const s = String(row?.status || '').toLowerCase();
  return s.includes('danger');
}

function buildNutritionFinalDecisionSrv(e = {}, rows = []){
  const stage = nutritionStageFromEvent(e);

  const rumen = reportRowByKeySrv(rows, 'rumen');
  const nel = reportRowByKeySrv(rows, 'nel');
  const mp = reportRowByKeySrv(rows, 'mp');
  const dcad = reportRowByKeySrv(rows, 'dcad');
  const iofc = reportRowByKeySrv(rows, 'iofc');

  const mineralVitaminBad = (Array.isArray(rows) ? rows : []).find(r => {
    const sec = String(r?.section || '').trim();
    return (
      (sec === 'المعادن الكبرى' || sec === 'المعادن الصغرى' || sec === 'الفيتامينات') &&
      reportRowBadSrv(r)
    );
  });

  if (reportRowDangerSrv(rumen)) {
    return cleanObj({
      title: 'تنبيه صحة الكرش.',
      action: rumen.note || 'راجع الألياف الفعالة وتوازن الخشن والحبوب قبل اعتماد العليقة.',
      status: 'danger',
      statusText: 'تنبيه صحة الكرش',
      sourceKey: 'rumen',
      sourceSection: rumen.section || 'صحة الكرش'
    });
  }

  if (reportRowBadSrv(nel)) {
    return cleanObj({
      title: 'متابعة الطاقة.',
      action: nel.note || 'راجع اتزان الطاقة مع الحفاظ على صحة الكرش.',
      status: 'warn',
      statusText: 'متابعة الطاقة',
      sourceKey: 'nel',
      sourceSection: nel.section || 'الاحتياجات الأساسية'
    });
  }

  if (reportRowBadSrv(mp)) {
    return cleanObj({
      title: 'متابعة البروتين الممثل.',
      action: mp.note || 'راجع مصدر البروتين الحقيقي وجودته وتكلفته قبل رفع البروتين الخام.',
      status: 'warn',
      statusText: 'متابعة البروتين الممثل',
      sourceKey: 'mp',
      sourceSection: mp.section || 'الاحتياجات الأساسية'
    });
  }

  if (stage === 'close_up' && reportRowBadSrv(dcad)) {
    return cleanObj({
      title: 'متابعة DCAD.',
      action: dcad.note || 'راجع أملاح الأنيون والكالسيوم والماغنسيوم قبل الاعتماد.',
      status: 'warn',
      statusText: 'متابعة DCAD',
      sourceKey: 'dcad',
      sourceSection: dcad.section || 'المعادن الكبرى'
    });
  }

  if (mineralVitaminBad) {
    return cleanObj({
      title: 'متابعة المعادن والفيتامينات.',
      action: mineralVitaminBad.note || 'راجع الإضافة المعدنية/الفيتامينية ومعدل استخدامها قبل اعتماد العليقة.',
      status: 'warn',
      statusText: 'متابعة المعادن والفيتامينات',
      sourceKey: mineralVitaminBad.key || 'minerals_vitamins',
      sourceSection: mineralVitaminBad.section || 'المعادن والفيتامينات'
    });
  }

  if (reportRowDangerSrv(iofc)) {
    return cleanObj({
      title: 'متابعة الاقتصاد.',
      action: iofc.note || 'راجع تكلفة الخامات أو إنتاج اللبن قبل اعتماد العليقة.',
      status: 'warn',
      statusText: 'متابعة الاقتصاد',
      sourceKey: 'iofc',
      sourceSection: iofc.section || 'الاقتصاد'
    });
  }

  return cleanObj({
    title: 'العليقة متزنة في الأساسيات وقابلة للتنفيذ.',
    action: 'راجع التفاصيل داخل التقرير لتحسين أي بند ثانوي عند الحاجة.',
    status: 'good',
    statusText: 'متزن',
    sourceKey: 'core_balance',
    sourceSection: 'الاحتياجات الأساسية'
  });
}
function buildNutritionReportDecisionSrv(e = {}, preparedRows = null){
  const rows = Array.isArray(preparedRows) ? preparedRows : buildNutritionReportRowsSrv(e);
  return buildNutritionFinalDecisionSrv(e, rows);
}
function buildNutritionReportRowsSrv(e = {}){
const a = e?.nutrition?.analysis || {};
const n = a.nutrition || {};
const t = a.targets || {};
const totals = a.totals || {};
const ec = a.economics || {};
const rows = [];
const reportStage = nutritionStageFromEvent(e);
const isDryReport =
  reportStage === 'far_dry' ||
  reportStage === 'close_up';

const guidanceSrv = (key, status, balance = null) =>
  reportMurabbikGuidanceSrv(key, status, balance, reportStage);
// الاقتصاد في التقرير يُقرأ فقط من قرار الاقتصاد النهائي المحفوظ
const ecoReport = reportEconomicsMetricsSrv(e);

const costPerKgMilkSrv = ecoReport.costPerKgMilk;
const feedCostSrv = a?.totals?.totCost ?? null;
const milkRevenueSrv = a?.economics?.milkRevenue ?? null;
const milkMarginSrv = ecoReport.milkMargin;
const feedCostPctSrv = ecoReport.feedCostPctOfMilkIncome;
const iofcPctSrv = ecoReport.iofcPctOfMilkIncome;
  const nelBal = finiteSrv(n.nelActual) && finiteSrv(t.nelTarget)
    ? Number(n.nelActual) - Number(t.nelTarget)
    : null;

  const mpBal = finiteSrv(n.mpBalanceG)
    ? Number(n.mpBalanceG)
    : (finiteSrv(n.mpSupplyG) && finiteSrv(t.mpTargetG)
      ? Number(n.mpSupplyG) - Number(t.mpTargetG)
      : null);

rows.push(reportRowSrv(
  'الاحتياجات الأساسية',
  'dmi',
  'قدرة الأكل / المادة الجافة',
  'قدرة أكل متوقعة',
  fmtSrv(totals.dmKg, 2, 'كجم'),
  '—',
  'muted',
  'يجب أن يتوفر العلف في المعلف 24 ساعة يوميًا مع متابعة المعلف والمتبقي.',
  '—'
));
const nelReportLabel = isDryReport ? 'الطاقة الصافية' : 'الطاقة الصافية للحليب';
 {
  const status = reportRatioStatusSrv(n.nelActual, t.nelTarget, 5);

  rows.push(reportRowSrv(
    'الاحتياجات الأساسية',
    'nel',
   nelReportLabel,
    fmtSrv(t.nelTarget, 2, 'ميجاكالوري/يوم'),
    fmtSrv(n.nelActual, 2, 'ميجاكالوري/يوم'),
    reportUnitBalanceTextSrv(n.nelActual, t.nelTarget, 2, 'ميجاكالوري/يوم'),
    status,
    guidanceSrv('nel', status, nelBal),
    reportBalanceStateTextSrv(status, nelBal)
  ));
}

{
  const status = reportRatioStatusSrv(n.mpSupplyG, t.mpTargetG, 5);

  rows.push(reportRowSrv(
    'الاحتياجات الأساسية',
    'mp',
    'البروتين الممثل',
    fmtSrv(t.mpTargetG, 0, 'جم/يوم'),
    fmtSrv(n.mpSupplyG, 0, 'جم/يوم'),
    reportUnitBalanceTextSrv(n.mpSupplyG, t.mpTargetG, 0, 'جم/يوم'),
    status,
    guidanceSrv('mp', status, mpBal),
    reportBalanceStateTextSrv(status, mpBal)
  ));
}

 rows.push(reportRowSrv(
  'الاحتياجات الأساسية',
  'cp',
  'البروتين الخام',
  'مؤشر تركيبي فقط',
  fmtSrv(n.cpPctTotal, 1, '% من المادة الجافة'),
  '—',
  'muted',
  '—',
  'مؤشر تركيبي'
));

  const carb = n.carbohydrateSafetyModel || a.carbohydrateSafetyModel || {};
  const ndfMin = carb.minTotalNDFPctDM ?? t.ndfSafetyMin ?? t.ndfMin ?? t.ndfTarget;
  const starchMax = carb.starchMaxPctDM ?? t.starchMax;
  const fatMaxRaw = t.fatSafeMax ?? t.fatMax ?? t.fatTarget;
  const fatMax = finiteSrv(fatMaxRaw) && Number(fatMaxRaw) > 0 ? Number(fatMaxRaw) : 7;
  

 {
  const status = reportMinStatusSrv(n.ndfPctActual, ndfMin);
  const bal = finiteSrv(n.ndfPctActual) && finiteSrv(ndfMin)
    ? Number(n.ndfPctActual) - Number(ndfMin)
    : null;

  rows.push(reportRowSrv(
    'الألياف والكربوهيدرات والدهون',
    'ndf',
    'الألياف المتعادلة',
    finiteSrv(ndfMin) ? `حد أدنى ${fmtSrv(ndfMin, 1, '% من المادة الجافة')}` : 'حد أدنى',
    fmtSrv(n.ndfPctActual, 1, '% من المادة الجافة'),
    finiteSrv(bal) ? fmtSrv(bal, 1, '%') : '—',
    status,
    guidanceSrv('ndf', status, bal),
    status === 'good' ? 'كافية' : 'منخفضة'
  ));
}

{
  const status = reportMaxStatusSrv(n.starchPctActual, starchMax);
  const bal = finiteSrv(n.starchPctActual) && finiteSrv(starchMax)
    ? Number(n.starchPctActual) - Number(starchMax)
    : null;

  rows.push(reportRowSrv(
    'الألياف والكربوهيدرات والدهون',
    'starch',
    'النشا',
    finiteSrv(starchMax) ? `حد أقصى ${fmtSrv(starchMax, 1, '% من المادة الجافة')}` : 'حد أقصى',
    fmtSrv(n.starchPctActual, 1, '% من المادة الجافة'),
    finiteSrv(bal) ? fmtSrv(bal, 1, '%') : '—',
    status,
    guidanceSrv('starch', status, bal),
    status === 'good' ? 'داخل الحد' : 'مرتفع'
  ));
}

{
  const status = reportMaxStatusSrv(n.fatPctActual, fatMax);
  const bal = finiteSrv(n.fatPctActual) && finiteSrv(fatMax)
    ? Number(n.fatPctActual) - Number(fatMax)
    : null;

  rows.push(reportRowSrv(
    'الألياف والكربوهيدرات والدهون',
    'fat',
    'دهن العليقة',
    finiteSrv(fatMax) ? `حد أقصى ${fmtSrv(fatMax, 1, '% من المادة الجافة')}` : 'حد أقصى',
    fmtSrv(n.fatPctActual, 1, '% من المادة الجافة'),
    finiteSrv(bal) ? fmtSrv(bal, 1, '%') : '—',
    status,
    guidanceSrv('fat', status, bal),
    status === 'good' ? 'داخل الحد' : 'مرتفعة'
  ));
}

{
  const status = reportMinStatusSrv(n.roughPctDM, t.roughageMin);
  const bal = finiteSrv(n.roughPctDM) && finiteSrv(t.roughageMin)
    ? Number(n.roughPctDM) - Number(t.roughageMin)
    : null;

  rows.push(reportRowSrv(
    'الألياف والكربوهيدرات والدهون',
    'roughage',
    'الخشن من المادة الجافة',
    finiteSrv(t.roughageMin) ? `حد أدنى ${fmtSrv(t.roughageMin, 1, '% من المادة الجافة')}` : 'حد أدنى',
    fmtSrv(n.roughPctDM, 1, '% من المادة الجافة'),
    finiteSrv(bal) ? fmtSrv(bal, 1, '%') : '—',
    status,
    guidanceSrv('roughage', status, bal),
    status === 'good' ? 'كافٍ' : 'منخفض'
  ));
}

{
  const status = reportMinStatusSrv(n.forageNDFPctDM, t.forageNDFMin);
  const bal = finiteSrv(n.forageNDFPctDM) && finiteSrv(t.forageNDFMin)
    ? Number(n.forageNDFPctDM) - Number(t.forageNDFMin)
    : null;

  rows.push(reportRowSrv(
    'الألياف والكربوهيدرات والدهون',
    'forage_ndf',
    'ألياف الخشن المتعادلة',
    finiteSrv(t.forageNDFMin) ? `حد أدنى ${fmtSrv(t.forageNDFMin, 1, '% من المادة الجافة')}` : 'حد أدنى',
    fmtSrv(n.forageNDFPctDM, 1, '% من المادة الجافة'),
    finiteSrv(bal) ? fmtSrv(bal, 1, '%') : '—',
    status,
    guidanceSrv('forage_ndf', status, bal),
    status === 'good' ? 'كافٍ' : 'منخفض'
  ));
}

  const rh = n.rumenHealthModel || {};
  rows.push(reportRowSrv(
    'صحة الكرش',
    'rumen',
    'صحة الكرش',
    'آمن',
    rh.title || n.rumenStatus || '—',
    '—',
    rh.status || n.rumenStatus || 'muted',
    rh.reason || rh.instruction || n.rumenNote || '—'
  ));

const dcadVal = n.dcadModel?.dcadMeqKgDM;
if (reportStage === 'close_up' && finiteSrv(dcadVal)) {
  const isBuffaloForDcad =
    /جاموس|buffalo/i.test(String(
      e?.nutrition?.context?.species ||
      n?.dcadModel?.species ||
      ''
    ));

  const lowLimit = isBuffaloForDcad ? -100 : -50;
  const highLimit = isBuffaloForDcad ? -50 : -10;
  const dcadNum = Number(dcadVal);

  const status =
    dcadNum >= lowLimit && dcadNum <= highLimit
      ? 'good'
      : 'warn';

  const statusText =
    status === 'good'
      ? 'مناسب'
      : (dcadNum > highLimit ? 'أعلى من المطلوب' : 'أقل من المطلوب');

  rows.push(reportRowSrv(
    'المعادن الكبرى',
    'dcad',
    'ميزان الكاتيونات والأنيونات الغذائي',
    `نطاق انتظار الولادة ${lowLimit} إلى ${highLimit} ملي مكافئ/كجم مادة جافة`,
    fmtSrv(dcadNum, 0, 'ملي مكافئ/كجم مادة جافة'),
    '—',
    status,
    guidanceSrv('dcad', status, dcadNum),
    statusText
  ));
}
  const mineralSupply = n.mineralSupplyModel || {};
  rows.push(...mineralReportRowsSrv(mineralSupply?.mineralBalanceModel?.balance || {}, 'g', reportStage));
rows.push(...mineralReportRowsSrv(mineralSupply?.traceMineralBalanceModel?.balance || {}, 'mg', reportStage));
rows.push(...vitaminReportRowsSrv(n.vitaminSupplyModel?.vitaminBalanceModel?.balance || {}, reportStage));

if (isDryReport) {
  rows.push(reportRowSrv(
    'الاقتصاد',
    'feed_cost_daily',
    'تكلفة التغذية / رأس / يوم',
    'تكلفة يومية',
    fmtSrv(feedCostSrv, 2, 'جنيه/رأس/يوم'),
    '—',
    finiteSrv(feedCostSrv) ? 'muted' : 'warn',
    finiteSrv(feedCostSrv)
      ? 'هذه تكلفة التغذية اليومية للحيوان في مرحلة الجفاف أو انتظار الولادة.'
      : 'أكمل كميات وأسعار الخامات لحساب تكلفة التغذية اليومية.',
    finiteSrv(feedCostSrv) ? 'مدخل حساب' : 'غير مكتمل'
  ));

  if (finiteSrv(totals.mixPriceDM)) {
    rows.push(reportRowSrv(
      'الاقتصاد',
      'mix_price_dm',
      'سعر طن الخلطة مادة جافة',
      'مؤشر تكلفة',
      fmtSrv(totals.mixPriceDM, 0, 'جنيه/طن مادة جافة'),
      '—',
      'muted',
      'مؤشر تكلفة الخلطة على أساس المادة الجافة.',
      'معلومة'
    ));
  }

  if (finiteSrv(totals.mixPriceAsFed)) {
    rows.push(reportRowSrv(
      'الاقتصاد',
      'mix_price_asfed',
      'سعر طن الخلطة طازج',
      'مؤشر تكلفة',
      fmtSrv(totals.mixPriceAsFed, 0, 'جنيه/طن طازج'),
      '—',
      'muted',
      'مؤشر تكلفة الخلطة كما تُقدَّم في المعلف.',
      'معلومة'
    ));
  }
} else {
  rows.push(reportRowSrv(
    'الاقتصاد',
    'milk_revenue',
    'دخل اللبن اليومي',
    'مدخل الحساب',
    fmtSrv(milkRevenueSrv, 2, 'جنيه/رأس/يوم'),
    '100% من دخل اللبن',
    finiteSrv(milkRevenueSrv) ? 'muted' : 'warn',
    'دخل اللبن اليومي هو أساس حساب هامش اللبن بعد العلف.',
    finiteSrv(milkRevenueSrv) ? 'أساس الحساب' : 'غير مكتمل'
  ));

  rows.push(reportRowSrv(
    'الاقتصاد',
    'feed_cost_daily',
    'تكلفة العلف اليومية',
    'مدخل الحساب',
    fmtSrv(feedCostSrv, 2, 'جنيه/رأس/يوم'),
    finiteSrv(feedCostPctSrv) ? `${Number(feedCostPctSrv).toFixed(1)}% من دخل اللبن` : '—',
    finiteSrv(feedCostPctSrv) && Number(feedCostPctSrv) > 50 ? 'warn' : (finiteSrv(feedCostPctSrv) ? 'muted' : 'warn'),
    'تكلفة العلف اليومية هي البند المخصوم من دخل اللبن لحساب IOFC.',
    finiteSrv(feedCostPctSrv) ? 'مدخل حساب' : 'غير مكتمل'
  ));

  rows.push(reportRowSrv(
    'الاقتصاد',
    'iofc',
    'IOFC — هامش اللبن بعد العلف',
    'مؤشر الربحية',
    fmtSrv(milkMarginSrv, 2, 'جنيه/رأس/يوم'),
    finiteSrv(iofcPctSrv) ? `${Number(iofcPctSrv).toFixed(1)}% من دخل اللبن` : '—',
    reportIofcStatusSrv(iofcPctSrv),
    reportIofcNoteSrv(iofcPctSrv),
    reportIofcReadSrv(iofcPctSrv)
  ));
}  return rows.filter(r => r && (r.actualText !== '—' || r.targetText !== '—'));
}
function buildNutritionOperationalBatchSrv(e = {}, options = {}) {
  const n = e?.nutrition || {};
  const ctx = n?.context || {};
  const rows = Array.isArray(n?.rows) ? n.rows : [];

  const headCount = Number(
    e?.groupSize ??
    ctx?.headCount ??
    (Array.isArray(ctx?.groupNumbers) ? ctx.groupNumbers.length : null)
  );

  const distributionsPerDay = Math.max(
    1,
    Math.min(12, Math.round(Number(options?.distributionsPerDay || 2) || 2))
  );

  if (!Number.isFinite(headCount) || headCount <= 0 || !rows.length) {
    return cleanObj({
      available: false,
      reason: 'batch_context_missing',
      headCount: Number.isFinite(headCount) ? headCount : null,
      distributionsPerDay,
      rows: [],
      totals: null
    });
  }

  const batchRows = rows.map((r = {}) => {
    const asFedKgPerHead = Number(r.asFedKg ?? r.kg ?? r.amount ?? 0) || 0;
    const dmPct = Number(r.dmPct ?? r.dm ?? 0) || 0;
    const pricePerTon = Number(r.pricePerTon ?? r.pTon ?? r.price ?? r.pTonRaw ?? 0) || 0;

    const dmKgPerHead = asFedKgPerHead * (dmPct / 100);
    const asFedKgGroupDay = asFedKgPerHead * headCount;
    const dmKgGroupDay = dmKgPerHead * headCount;
    const asFedKgPerDistribution = asFedKgGroupDay / distributionsPerDay;
    const costGroupDay = (asFedKgGroupDay / 1000) * pricePerTon;

    return cleanObj({
      id: r.id || r.feedId || null,
      name: r.name || r.nameAr || r.feedName || r.id || 'خامة',
      category: r.cat || r.category || null,

      asFedKgPerHead: round2(asFedKgPerHead),
      dmKgPerHead: round2(dmKgPerHead),
      asFedKgGroupDay: round2(asFedKgGroupDay),
      dmKgGroupDay: round2(dmKgGroupDay),
      distributionsPerDay,
      asFedKgPerDistribution: round2(asFedKgPerDistribution),
      costGroupDay: round2(costGroupDay)
    });
  });

  const totals = batchRows.reduce((acc, r) => {
    acc.asFedKgPerHead += Number(r.asFedKgPerHead || 0);
    acc.dmKgPerHead += Number(r.dmKgPerHead || 0);
    acc.asFedKgGroupDay += Number(r.asFedKgGroupDay || 0);
    acc.dmKgGroupDay += Number(r.dmKgGroupDay || 0);
    acc.asFedKgPerDistribution += Number(r.asFedKgPerDistribution || 0);
    acc.costGroupDay += Number(r.costGroupDay || 0);
    return acc;
  }, {
    asFedKgPerHead: 0,
    dmKgPerHead: 0,
    asFedKgGroupDay: 0,
    dmKgGroupDay: 0,
    asFedKgPerDistribution: 0,
    costGroupDay: 0
  });

  Object.keys(totals).forEach(k => {
    totals[k] = round2(totals[k]);
  });

  return cleanObj({
    available: true,
    headCount,
    distributionsPerDay,
    unit: 'kg_as_fed',
    note: 'تقرير تشغيلي يحول عليقة الرأس الواحد إلى باتش جماعي حسب عدد الرؤوس وعدد النقلات اليومية. لا يغير احتياجات الحيوان.',
    rows: batchRows,
    totals
  });
}
function attachNutritionReportPayloadSrv(e = {}, options = {}){
  const reportRows = buildNutritionReportRowsSrv(e);
  const reportDecision = buildNutritionReportDecisionSrv(e, reportRows);
  const operationalBatch = buildNutritionOperationalBatchSrv(e, options);
  
  return cleanObj({
    ...e,
    nutrition: {
      ...(e.nutrition || {}),
      reportDecision,
      reportStatus: reportDecision.status || reportStatusFromEventSrv(e),
     reportRows,
     operationalBatch
    }
  });
}
function buildAllNutritionReport(events = [], options = {}) {
  const latestByKey = new Map();

  for (const e of events || []) {
    const key = nutritionReportKeyFromEvent(e);
    const prev = latestByKey.get(key);

    if (!prev || eventCreatedMs(e) > eventCreatedMs(prev)) {
      latestByKey.set(key, e);
    }
  }

  const latestEvents = [...latestByKey.values()].sort((a, b) => {
    const sw = stageSortWeight(nutritionStageFromEvent(a)) - stageSortWeight(nutritionStageFromEvent(b));
    if (sw !== 0) return sw;

    const an = normReportText(nutritionGroupNameFromEvent(a));
    const bn = normReportText(nutritionGroupNameFromEvent(b));
    if (an !== bn) return an.localeCompare(bn);

    return eventCreatedMs(b) - eventCreatedMs(a);
  });

  const reportEvents = latestEvents.map(e => attachNutritionReportPayloadSrv(e, options));
  const index = reportEvents.map(buildNutritionReportIndexItem);

  const danger = index.filter(x => x.reportStatus === 'danger');
  const warn = index.filter(x => x.reportStatus === 'warn');

  const lactatingEvents = reportEvents.filter(e => nutritionStageFromEvent(e) === 'lactating');
  const lactatingSummary = buildLactatingNutritionSummary(lactatingEvents);

  const highestCost = [...index]
    .filter(x => Number.isFinite(Number(x.costPerKgMilk)))
    .sort((a, b) => Number(b.costPerKgMilk || 0) - Number(a.costPerKgMilk || 0))[0] || null;

  const weakestMargin = [...index]
    .filter(x => Number.isFinite(Number(x.milkMargin)))
    .sort((a, b) => Number(a.milkMargin || 0) - Number(b.milkMargin || 0))[0] || null;

  const firstPriority =
    danger[0] ||
    warn[0] ||
    weakestMargin ||
    highestCost ||
    index[0] ||
    null;

  return cleanObj({
   count: reportEvents.length,
    index,
    executive: {
     totalRations: reportEvents.length,
      dangerCount: danger.length,
      warningCount: warn.length,
      okCount: index.filter(x => x.reportStatus === 'good').length,
      firstPriority,
      highestCost,
      weakestMargin
    },
    lactatingSummary,
   events: reportEvents
  });
}
function nutritionStageLabelSrv(stage = '') {
  const s = String(stage || '').toLowerCase();
  if (s === 'lactating') return 'علائق الحلاب';
  if (s === 'far_dry') return 'علائق الجاف البعيد';
  if (s === 'close_up') return 'علائق انتظار الولادة';
  return 'علائق غير مصنفة';
}

function buildStageSeparatedNutritionReport(events = [], options = {}) {
  const buckets = new Map();

  for (const e of events || []) {
    const stage = nutritionStageFromEvent(e) || 'unknown';
    const species = nutritionSpeciesKeyFromEvent(e) || 'unknown';
    const key = `${species}__${stage}`;

    if (!buckets.has(key)) {
      buckets.set(key, {
        stage,
        species,
        title: nutritionStageLabelSrv(stage),
        showMilkEconomics: stage === 'lactating',
        events: []
      });
    }

    buckets.get(key).events.push(e);
  }

  const order = { lactating: 1, far_dry: 2, close_up: 3, unknown: 9 };

  const sections = [...buckets.values()]
    .sort((a, b) => (order[a.stage] || 9) - (order[b.stage] || 9))
    .map(sec => {
      const report = buildAllNutritionReport(sec.events, options);
      return cleanObj({
        stage: sec.stage,
        species: sec.species,
        title: sec.title,
        showMilkEconomics: sec.showMilkEconomics,
        count: report.count || 0,
        report
      });
    })
    .filter(sec => Number(sec.count || 0) > 0);

  return cleanObj({
    count: sections.reduce((s, x) => s + Number(x.count || 0), 0),
    sectioned: true,
    sections
  });
}
// ============================================================
//        API: NUTRITION SAVED RATIONS LIST + LOAD ONE
// ============================================================
app.get('/api/nutrition/events/list', requireUserId, async (req, res) => {
  try {
    const tenant = req.userId;

    const byId = new Map();

    async function pull(field) {
      if (!db) return;

      const snap = await db.collection('events')
        .where(field, '==', tenant)
        .limit(120)
        .get();

      snap.forEach(d => {
        const e = { id: d.id, ...(d.data() || {}) };
        if (isNutritionSavedEvent(e)) byId.set(d.id, e);
      });
    }

    if (db) {
      await pull('ownerUid');
      await pull('userId');
    } else {
      readJson(eventsPath, [])
        .filter(e => belongs(e, tenant) || tenantKey(e.ownerUid) === tenantKey(tenant))
        .filter(isNutritionSavedEvent)
        .forEach(e => {
          if (e.id) byId.set(String(e.id), e);
        });
    }

    const wantedAnimalNumber = String(
      req.query.animalNumber ||
      req.query.number ||
      req.query.animalId ||
      ''
    ).trim();

    const wantedAnimalKey = String(
      Number.isFinite(Number(wantedAnimalNumber))
        ? Number(wantedAnimalNumber)
        : wantedAnimalNumber
    ).trim();

    const wantedGroupName = normReportText(
      req.query.groupName ||
      req.query.group ||
      ''
    );

    const wantedStage = String(
      req.query.stage ||
      ''
    ).trim().toLowerCase();

    const events = [...byId.values()]
      .filter(e => Array.isArray(e?.nutrition?.rows) && e.nutrition.rows.length)
      .filter(e => {
        if (!wantedAnimalNumber) return true;

        const ctx = e?.nutrition?.context || {};

        const raw = String(
          e.animalNumber ||
          e.number ||
          e.animalId ||
          ctx.animalNumber ||
          ctx.number ||
          ctx.animalId ||
          ''
        ).trim();

        const rawKey = String(
          Number.isFinite(Number(raw))
            ? Number(raw)
            : raw
        ).trim();

        return raw === wantedAnimalNumber || rawKey === wantedAnimalKey;
      })
      .filter(e => {
        if (!wantedGroupName) return true;

        const ctx = e?.nutrition?.context || {};
        const name = normReportText(
          nutritionGroupNameFromEvent(e) ||
          ctx.groupName ||
          ctx.group ||
          ctx.groupLabel ||
          ''
        );

        return name === wantedGroupName;
      })
      .filter(e => {
        if (!wantedStage) return true;
        return nutritionStageFromEvent(e) === wantedStage;
      })
      .sort((a, b) => eventCreatedMs(b) - eventCreatedMs(a))
      .slice(0, 20);

    const list = events.map(e => {
      const n = e.nutrition || {};
      const ctx = n.context || {};
      const ec = n.analysis?.economics || {};
      const stage = nutritionStageFromEvent(e);

      const name =
        nutritionGroupNameFromEvent(e) ||
        ctx.groupName ||
        ctx.group ||
        ctx.groupLabel ||
        e.animalNumber ||
        'عليقة محفوظة';

      const speciesKey = nutritionSpeciesKeyFromEvent(e);
      const speciesLabel =
        speciesKey === 'buffalo' ? 'جاموس' :
        speciesKey === 'cows' ? 'أبقار' :
        String(ctx.species || '');

      const stageLabel =
        stage === 'lactating' ? 'حلاب' :
        stage === 'far_dry' ? 'جاف بعيد' :
        stage === 'close_up' ? 'انتظار ولادة' :
        'غير محدد';

      const avgMilkKg = toNumOrNull(
        ctx.avgMilkKg ??
        ctx.formulationTarget?.milkKg
      );

      const milkRevenue = toNumOrNull(ec.milkRevenue);

      const milkPrice = toNumOrNull(
        n.milkPrice ??
        ctx.milkPrice ??
        n.analysis?.inputs?.milkPriceUsed ??
        (
          Number.isFinite(Number(milkRevenue)) &&
          Number(milkRevenue) > 0 &&
          Number.isFinite(Number(avgMilkKg)) &&
          Number(avgMilkKg) > 0
            ? Math.round((Number(milkRevenue) / Number(avgMilkKg)) * 100) / 100
            : null
        )
      );

      return cleanObj({
        id: e.id,
        groupName: name,
        eventDate: e.eventDate || e.date || null,
        species: speciesLabel || null,
        stage,
        stageLabel,
        headCount: e.groupSize || ctx.headCount || null,
        avgMilkKg,
        milkPrice,
        createdAtMs: eventCreatedMs(e)
      });
    });

    return res.json({
      ok: true,
      count: list.length,
      events: list
    });

  } catch (e) {
    console.error('nutrition.events.list error:', e);
    return res.status(500).json({
      ok: false,
      error: 'nutrition_events_list_failed',
      message: e.message || String(e)
    });
  }
});
app.get('/api/nutrition/event/:id', requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: 'firestore_disabled'
      });
    }

    const tenant = req.userId;
    const id = String(req.params.id || '').trim();

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'event_id_required'
      });
    }

    const snap = await db.collection('events').doc(id).get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: 'nutrition_event_not_found'
      });
    }

    const event = {
      id: snap.id,
      ...(snap.data() || {})
    };

    const owner = String(event.userId || event.ownerUid || '').trim();

    if (owner !== tenant) {
      return res.status(403).json({
        ok: false,
        error: 'forbidden'
      });
    }

    if (!isNutritionSavedEvent(event)) {
      return res.status(400).json({
        ok: false,
        error: 'not_nutrition_event'
      });
    }
const n = event.nutrition || {};
const ctx = n.context || {};
const ec = n.analysis?.economics || {};

const milkKgForPrice = Number(
  ctx.avgMilkKg ??
  ctx.formulationTarget?.milkKg ??
  0
);

const milkRevenueForPrice = Number(ec.milkRevenue);

const resolvedMilkPrice =
  n.milkPrice ??
  ctx.milkPrice ??
  n.analysis?.inputs?.milkPriceUsed ??
  (
    Number.isFinite(milkRevenueForPrice) &&
    milkRevenueForPrice > 0 &&
    Number.isFinite(milkKgForPrice) &&
    milkKgForPrice > 0
      ? Math.round((milkRevenueForPrice / milkKgForPrice) * 100) / 100
      : null
  );

if (Number.isFinite(Number(resolvedMilkPrice)) && Number(resolvedMilkPrice) > 0) {
  event.nutrition = {
    ...n,
    milkPrice: Number(resolvedMilkPrice),
    context: {
      ...ctx,
      milkPrice: Number(resolvedMilkPrice)
    },
    analysis: {
      ...(n.analysis || {}),
      inputs: {
        ...(n.analysis?.inputs || {}),
        milkPriceUsed: Number(resolvedMilkPrice)
      }
    }
  };
}
    return res.json({
      ok: true,
      event
    });

  } catch (e) {
    console.error('nutrition.event.load error:', e);
    return res.status(500).json({
      ok: false,
      error: 'nutrition_event_load_failed',
      message: e.message || String(e)
    });
  }
});
app.get('/api/nutrition/report/latest', requireUserId, async (req, res) => {
  try {
    const tenant = req.userId;
    const scope = String(req.query.scope || 'group').trim();
    const type = String(req.query.type || '').trim();
    const stage = String(req.query.stage || '').trim();
    const groupName = String(req.query.groupName || req.query.group || '').trim();
    const distributionsPerDay = Math.max(
  1,
  Math.min(12, Math.round(Number(req.query.distributionsPerDay || 2) || 2))
);

const reportOptions = { distributionsPerDay };
    const events = await fetchNutritionReportEvents(tenant);
    const filtered = filterNutritionReportEvents(events, { type, stage, groupName });

    if (scope === 'all') {
const report = buildStageSeparatedNutritionReport(filtered, reportOptions);

if (!report.count) {
  return res.status(404).json({
    ok: false,
    error: 'nutrition_report_not_found',
    message: 'لا توجد علائق تغذية محفوظة مطابقة للتقرير الشامل'
  });
}

return res.json({
  ok: true,
  scope,
  type: type || null,
  count: report.count,
  report
});
    }

    if (scope === 'lactating_summary') {
      const summary = buildLactatingNutritionSummary(filtered);
      return res.json({
        ok: true,
        scope,
        type: type || null,
        count: summary.groups.length,
        summary
      });
    }

    const event = filtered[0] || null;

    if (!event) {
      return res.status(404).json({
        ok: false,
        error: 'nutrition_report_not_found',
        message: 'لا يوجد تحليل تغذية محفوظ مطابق للتقرير المطلوب'
      });
    }

    return res.json({
      ok: true,
      scope,
      type: type || null,
      stage: nutritionStageFromEvent(event),
      groupName: nutritionGroupNameFromEvent(event) || null,
      event: attachNutritionReportPayloadSrv(event, reportOptions)
    });
  } catch (e) {
    console.error('nutrition.report.latest error:', e);
    return res.status(500).json({
      ok: false,
      error: 'nutrition_report_failed',
      message: e.message || String(e)
    });
  }
});
// ============================================================
//                 CALVING RULES — moved from frontend rules
//                 نقل كما هو من form-rules.js
// ============================================================

const CALVING_THRESHOLDS_SRV = {
  "أبقار": { minGestationDays: 255 },
  "جاموس": { minGestationDays: 285 },
};

function calvingToDateSrv(v) {
  return (v instanceof Date ? v : (v ? new Date(v) : null));
}

function calvingDaysBetweenSrv(a, b) {
  const d1 = calvingToDateSrv(a), d2 = calvingToDateSrv(b);
  if (!d1 || !d2) return NaN;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}

function calvingIsDateSrv(v) {
  return !Number.isNaN(calvingToDateSrv(v)?.getTime());
}

function calvingStripArSrv(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "");
}

function calvingNormalizeSpeciesSrv(spRaw) {
  let sp = String(spRaw || "").trim();
  if (/cow|بقر/i.test(sp)) return "أبقار";
  if (/buffalo|جاموس/i.test(sp)) return "جاموس";
  return sp;
}

function calvingNormDigitsOnlySrv(s) {
  const map = {
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'
  };
  return String(s || '')
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, '')
    .replace(/[٠-٩۰-۹]/g, d => map[d]);
}

function calvingIsOddSrv(n) {
  return Number(n) % 2 === 1;
}

function calvingIsEvenSrv(n) {
  return Number(n) % 2 === 0;
}

function calvingDecisionSrv(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر العثور على الحيوان — تحقق من الرقم.";

  // ✅ خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل ولادة — الحيوان خارج القطيع.";

  // ✅ تحديد النوع (Normalize)
  let sp = String(fd.species || doc.species || doc.animalTypeAr || doc.animalType || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const th = CALVING_THRESHOLDS_SRV[sp]?.minGestationDays;
  if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

  // ✅ الحالة التناسلية: events أولًا ثم الوثيقة
  const rsRaw = String(
    fd.reproStatusFromEvents ||
    doc.reproductiveStatus ||
    doc.reproStatus ||
    ""
  ).trim();

  const rsNorm = rsRaw.replace(/\s+/g, "").replace(/[ًٌٍَُِّْ]/g, "");

  // ✅ تسمية الحيوان لغويًا
  const animalWord = (sp === "جاموس") ? "جاموسة" : "بقرة";

  // ✅ عرض الحالة الفعلية للمستخدم
  const shownStatus = rsRaw ? `«${rsRaw}»` : "غير معروفة";

  // ✅ رسائل أدق حسب الحالة
  if (!rsNorm.includes("عشار")) {

    // ملقحة
    if (rsNorm.includes("ملقح")) {
      return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
    }

    // مفتوحة/فارغة
    if (rsNorm.includes("مفتوح") || rsNorm.includes("فارغ")) {
      return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
    }

    // حديثة الولادة (لو عندك هذا النص في النظام)
    if (rsNorm.includes("حديث") || rsNorm.includes("ولاد")) {
      return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
    }

    // أي حالة أخرى
    return `❌ لا يمكن تسجيل ولادة لـ${animalWord} — الحالة التناسلية الحالية: ${shownStatus}.`;
  }

  // ✅ آخر تلقيح مُخصِّب: events أولًا ثم الوثيقة
  const lf =
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    doc.lastServiceDate ||
    "";

  if (!calvingIsDateSrv(lf)) return '❌ لا يمكن تسجيل ولادة — لا يوجد "آخر تلقيح".';

  if (!calvingIsDateSrv(fd.eventDate)) return "❌ تاريخ الولادة غير صالح.";

  // ✅ Boundary: لو في (ولادة/إجهاض) أحدث من التلقيح → يلغي الحمل
  const boundary = String(fd.lastBoundary || "").trim();
  if (boundary && calvingIsDateSrv(boundary)) {
    const b = new Date(boundary); b.setHours(0,0,0,0);
    const l = new Date(lf);       l.setHours(0,0,0,0);
    if (b.getTime() >= l.getTime()) {
      return `❌ لا يُسمح بتسجيل الولادة: آخر حدث (${boundary}) يلغي أي حمل حالي.`;
    }
  }

  const gDays = calvingDaysBetweenSrv(lf, fd.eventDate);
  if (Number.isNaN(gDays)) return "تعذّر حساب عمر الحمل.";

  if (gDays < th) {
    // ✅ Prefix خاص عشان forms-init يعرف يعرض زر “تسجيل إجهاض”
    return `OFFER_ABORT|لا يُسمح بتسجيل الولادة: عمر الحمل ${gDays} يوم أقل من الحد الأدنى ${th} يوم للـ${sp}.`;
  }

  return null;
}

function calvingRequiredFieldsSrv(fd) {
  // 1) نوع الولادة لازم موجود
  const kind = String(fd.calvingKind || "").trim();
  if (!kind) return "❌ نوع الولادة مطلوب.";

  // 2) آخر تلقيح مُخصِّب لازم موجود وصالح
  const lf = String(fd.lastInseminationDate || "").trim();
  if (!calvingIsDateSrv(lf)) return '❌ "آخر تلقيح مُخصِّب" مطلوب (تاريخ صحيح).';

  // 3) لو الولادة "نافقة" → لا نطلب أي بيانات عجول
  if (kind === "نافقة") return null;

  // 4) غير نافقة → بيانات العجول إجبارية
  // 4) غير نافقة → بيانات العجول إجبارية
  const count = Number(String(fd.calfCount || "").trim());
  if (!(count === 1 || count === 2 || count === 3)) {
    return { field: "calfCount", msg: "❌ عدد المواليد مطلوب (1 أو 2 أو 3)." };
  }

  // المولود 1
  if (!String(fd.calf1Sex || "").trim()) {
    return { field: "calf1Sex", msg: "❌ جنس المولود (1) مطلوب." };
  }
  if (!String(fd.calfId || "").trim()) {
    return { field: "calfId", msg: "❌ رقم العجل (1) مطلوب." };
  }

  // مصير العجل
  // مصير العجل/العجول حسب العدد
  if (!String(fd.calf1Fate || "").trim()) {
    return { field: "calf1Fate", msg: "❌ مصير العجل (1) مطلوب." };
  }
  if (count >= 2 && !String(fd.calf2Fate || "").trim()) {
    return { field: "calf2Fate", msg: "❌ مصير العجل (2) مطلوب." };
  }
  if (count >= 3 && !String(fd.calf3Fate || "").trim()) {
    return { field: "calf3Fate", msg: "❌ مصير العجل (3) مطلوب." };
  }

  // المولود 2
  if (count >= 2) {
    if (!String(fd.calf2Sex || "").trim()) {
      return { field: "calf2Sex", msg: "❌ جنس المولود (2) مطلوب." };
    }
    if (!String(fd.calf2Id || "").trim()) {
      return { field: "calf2Id", msg: "❌ رقم العجل (2) مطلوب." };
    }
  }

  // المولود 3
  if (count >= 3) {
    if (!String(fd.calf3Sex || "").trim()) {
      return { field: "calf3Sex", msg: "❌ جنس المولود (3) مطلوب." };
    }
    if (!String(fd.calf3Id || "").trim()) {
      return { field: "calf3Id", msg: "❌ رقم العجل (3) مطلوب." };
    }
  }

  // 5) قواعد أرقام العجول: الذكر فردي، الأنثى زوجي + منع تكرار داخل الولادة
  const nums = [];
  const checkOne = (sexKey, idKey, label) => {
    const sex = String(fd[sexKey] || "").trim();
    const id  = calvingNormDigitsOnlySrv(fd[idKey]);
    if (!sex || !id) return null;

    nums.push(id);

    const n = Number(id);
    if (!Number.isFinite(n)) return { field: idKey, msg: `❌ رقم العجل (${label}) غير صالح.` };

    if (sex === "ذكر" && !calvingIsOddSrv(n)) {
      return { field: idKey, msg: `❌ رقم العجل الذكر يجب أن يكون فردي. (${id})` };
    }
    if (sex === "أنثى" && !calvingIsEvenSrv(n)) {
      return { field: idKey, msg: `❌ رقم العجل الأنثى يجب أن يكون زوجي. (${id})` };
    }
    return null;
  };

  let e;
  e = checkOne("calf1Sex", "calfId", "1");   if (e) return e;
  if (count >= 2) { e = checkOne("calf2Sex", "calf2Id", "2"); if (e) return e; }
  if (count >= 3) { e = checkOne("calf3Sex", "calf3Id", "3"); if (e) return e; }

  const s2 = new Set(nums);
  if (s2.size !== nums.length) {
    return { field: "calfId", msg: "❌ لا يجوز تكرار رقم العجل داخل نفس الولادة." };
  }

  return null;
}
// ============================================================
//                 CALVING SIGNALS — moved from forms-init.js
//                 نقل كما هو من fetchCalvingSignalsFromEvents
// ============================================================

async function fetchCalvingSignalsFromEventsSrv(uid, number) {
  const num = String(calvingNormDigitsOnlySrv(number || "")).trim();

  if (!uid || !num) {
    return {
      reproStatusFromEvents: "",
      lastBoundary: "",
      lastBoundaryType: "",
      lastInseminationDateFromEvents: ""
    };
  }

  const snap = await db.collection("events")
    .where("userId", "==", uid)
    .where("animalNumber", "==", num)
    .limit(60)
    .get();

  const arr = snap.docs
    .map((d) => d.data() || {})
    .filter((ev) => ev.eventDate)
    .sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)));

  let reproStatusFromEvents = "";
  let lastBoundary = "";
  let lastBoundaryType = "";
  let lastInseminationDateFromEvents = "";

  for (const ev of arr) {
    const type = String(ev.eventType || ev.type || "").trim();
    const res  = String(ev.result || ev.status || "").trim();
    const dt   = String(ev.eventDate || "").trim();

    if ((type === "ولادة" || type === "إجهاض") && !lastBoundary) {
      lastBoundary = dt;
      lastBoundaryType = type;
      if (!reproStatusFromEvents) reproStatusFromEvents = "مفتوحة";
      continue;
    }

    // ✅ آخر تلقيح من الأحداث (حتى لو وثيقة الحيوان لم تتحدث بعد)
    if ((type === "تلقيح" || type === "insemination") && !lastInseminationDateFromEvents) {
      lastInseminationDateFromEvents = dt;
    }

    if (type === "تشخيص حمل") {
      const r = calvingStripArSrv(res);
      if (!reproStatusFromEvents) {
        if (r.includes("عشار")) reproStatusFromEvents = "عشار";
        if (r.includes("فارغه") || r.includes("فارغة")) reproStatusFromEvents = "مفتوحة";
      }
    }

    if (reproStatusFromEvents && lastBoundary) break;
  }

  return {
    reproStatusFromEvents,
    lastBoundary,
    lastBoundaryType,
    lastInseminationDateFromEvents
  };
}
// ============================================================
//                 INSEMINATION VALIDATION + DECISION
//                 نقل فاليديشن وقرار التلقيح كما هو للسيرفر
// ============================================================

function inseminationReqSrv(v) {
  return !(v === undefined || v === null || String(v).trim() === "");
}

function inseminationIsDateSrv(v) {
  const d = v instanceof Date ? v : (v ? new Date(v) : null);
  return !Number.isNaN(d?.getTime());
}

function inseminationDaysBetweenSrv(a, b) {
  const d1 = a instanceof Date ? a : (a ? new Date(a) : null);
  const d2 = b instanceof Date ? b : (b ? new Date(b) : null);
  if (!d1 || !d2) return NaN;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
}

function validateInseminationFieldsSrv(fd = {}) {
  const fieldErrors = {};

  if (!inseminationReqSrv(fd.animalNumber)) {
    fieldErrors.animalNumber = "رقم الحيوان مطلوب.";
  }

  if (!inseminationReqSrv(fd.eventDate) || !inseminationIsDateSrv(fd.eventDate)) {
    fieldErrors.eventDate = "تاريخ التلقيح غير صالح.";
  }

  if (!fd.documentData) {
    fieldErrors.documentData = "تعذّر العثور على الحيوان.";
  }

  if (!inseminationReqSrv(fd.species)) {
    fieldErrors.species = "نوع الحيوان غير محدد.";
  }

  if (!inseminationReqSrv(fd.inseminationMethod)) {
    fieldErrors.inseminationMethod = "طريقة التلقيح مطلوبة.";
  }

  if (!inseminationReqSrv(fd.semenCode)) {
    fieldErrors.semenCode = "كود السائل المنوي مطلوب.";
  }

  if (!inseminationReqSrv(fd.inseminator)) {
    fieldErrors.inseminator = "اسم الملقّح مطلوب.";
  }

  if (!inseminationReqSrv(fd.inseminationTime)) {
    fieldErrors.inseminationTime = "وقت التلقيح مطلوب.";
  }

  if (!inseminationReqSrv(fd.heatStatus)) {
    fieldErrors.heatStatus = "حالة الشياع مطلوبة.";
  }

  return fieldErrors;
}

function inseminationDecisionSrv(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // ❌ خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل تلقيح — الحيوان خارج القطيع.";

  // ✅ تحديد النوع
  let sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const minPostCalving = { "أبقار": 60, "جاموس": 45 };

  // ❌ عشار
  const repro = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  if (repro.includes("عشار")) {
    return "❌ الحيوان مسجل عِشار — لا يمكن تلقيحه.";
  }

  // ❌ لازم تاريخ ولادة
  const lastCalving =
    String(doc.lastCalvingDate || "").trim() ||
    (String(fd.lastBoundaryType || "").trim() === "ولادة" ? String(fd.lastBoundary || "").trim() : "");

  if (!lastCalving) return "❌ لا يوجد تاريخ آخر ولادة.";

  const gapCalving = inseminationDaysBetweenSrv(lastCalving, fd.eventDate);

  if (!Number.isFinite(gapCalving)) {
    return "❌ تعذّر حساب الأيام منذ آخر ولادة.";
  }

  if (gapCalving < minPostCalving[sp]) {
    return `❌ لا يمكن التلقيح الآن — مرّ ${gapCalving} يوم فقط بعد آخر ولادة.\nالحد الأدنى: ${minPostCalving[sp]} يوم.`;
  }

  // ✅ آخر تلقيح: من الأحداث أولًا ثم الوثيقة
  const lastAI = String(fd.lastInseminationDate || doc.lastInseminationDate || "").trim();

  if (lastAI) {
    const gapAI = inseminationDaysBetweenSrv(lastAI, fd.eventDate);

    // ❌ منع تكرار نفس اليوم
    if (gapAI === 0) {
      return "❌ لا يمكن تسجيل تلقيح مرتين في نفس اليوم.";
    }

    // ⚠️ تحذير لو أقل من 11 يوم
    if (gapAI < 11) {
      return `WARN|⚠️ تنبيه: آخر تلقيح منذ ${gapAI} يوم فقط (أقل من 11 يوم).`;
    }
  }

  return null;
}
// ============================================================
//                 ABORTION DECISION — moved from form-rules.js
//                 نقل قرار الإجهاض للسيرفر فقط
// ============================================================

function abortionDecisionSrv(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // ✅ خارج القطيع
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return "❌ لا يمكن تسجيل إجهاض — الحيوان خارج القطيع.";
  }

  // ✅ تاريخ صالح
  if (!calvingIsDateSrv(fd.eventDate)) {
    return "❌ تاريخ الإجهاض غير صالح.";
  }

  // ✅ تحديد النوع
  let sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const th = CALVING_THRESHOLDS_SRV[sp]?.minGestationDays;
  if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

  // ✅ لازم يكون عشار
  const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  const rsNorm = calvingStripArSrv(rsRaw);

  if (!rsNorm.includes("عشار")) {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ الحيوان ليس عِشار — الحالة التناسلية الحالية: ${shown}.`;
  }

  // ✅ لازم آخر تلقيح
  const lf =
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    doc.lastServiceDate ||
    "";

  if (!calvingIsDateSrv(lf)) {
    return '❌ لا يمكن تسجيل إجهاض — لا يوجد "آخر تلقيح".';
  }

  // ✅ لو في ولادة/إجهاض بعد آخر تلقيح يبقى الحمل انتهى
  const boundary = String(fd.lastBoundary || "").trim();
  if (boundary && calvingIsDateSrv(boundary)) {
    const b = new Date(boundary); b.setHours(0,0,0,0);
    const l = new Date(lf);       l.setHours(0,0,0,0);

    if (b.getTime() >= l.getTime()) {
      return `❌ لا يُسمح بتسجيل الإجهاض: آخر حدث (${boundary}) يلغي أي حمل حالي.`;
    }
  }

  // ✅ عمر الحمل أقل من حد الولادة
  const gDays = calvingDaysBetweenSrv(lf, fd.eventDate);
  if (Number.isNaN(gDays)) {
    return "تعذّر حساب عمر الحمل.";
  }

  if (gDays >= th) {
    return `❌ عمر الحمل ${gDays} يوم — هذا أقرب لولادة وليس إجهاض (الحد الأدنى للولادة ${th} يوم).`;
  }

  return null;
}

// ============================================================
//                 ABORTION DERIVED FIELDS — moved from abortion.html
//                 حساب عمر الإجهاض والسبب في السيرفر فقط
// ============================================================

function calcAbortionAgeAndCauseSrv(lastAI, eventDate) {
  if (!calvingIsDateSrv(lastAI) || !calvingIsDateSrv(eventDate)) {
    return {
      gestationDays: null,
      abortionAgeMonths: null,
      probableCause: "",
      probableCauses: [],
      abortionDiagnosticMatrix: [],
      abortionDiagnosticNote: ""
    };
  }

  const gDays = calvingDaysBetweenSrv(lastAI, eventDate);

  if (!Number.isFinite(gDays)) {
    return {
      gestationDays: null,
      abortionAgeMonths: null,
      probableCause: "",
      probableCauses: [],
      abortionDiagnosticMatrix: [],
      abortionDiagnosticNote: ""
    };
  }

  const monthsRaw = Math.max(0, gDays / 30.44);
  const months = Number.isFinite(monthsRaw) ? Number(monthsRaw.toFixed(1)) : null;

  // ======================================================
  // Murabbik — Abortion Diagnostic Matrix by DCC
  // ملاحظة: هذه احتمالات وبائية/تشخيصية حسب عمر الحمل
  // وليست تشخيصًا نهائيًا بدون معمل
  // ======================================================
  const matrix = [
    {
      key: "bvdv",
      name: "BVDV",
      labelAr: "فيروس الإسهال الفيروسي البقري BVD",
      minDcc: 45,
      maxDcc: 125,
      zoonotic: false,
      regulatory: false,
      shortNote: "إجهاض مبكر إلى متوسط؛ قد يسبب موت جنيني/تحنط، وتشوهات إذا حدثت العدوى تقريبًا بين 100–150 يوم.",
      tests: [
        "PCR من طحال/رئة/غدة زعترية للجنين",
        "IHC على الجلد أو عينة أذن",
        "Serology للجنين إذا تجاوز 120 يومًا"
      ]
    },
    {
      key: "neospora_caninum",
      name: "Neospora caninum",
      labelAr: "نيوسبورا",
      minDcc: 90,
      maxDcc: 180,
      zoonotic: false,
      regulatory: false,
      shortNote: "إجهاض متوسط؛ يرتبط بآفات في المخ والقلب مثل encephalitis و myocarditis.",
      tests: [
        "Histopathology لمخ الجنين",
        "IHC للمخ/القلب",
        "ELISA لمصل الأم كدليل تعرض"
      ]
    },
    {
      key: "bhv1_ibr",
      name: "BHV-1 / IBR",
      labelAr: "IBR / BHV-1",
      minDcc: 120,
      maxDcc: 260,
      zoonotic: false,
      regulatory: false,
      shortNote: "إجهاض متأخر غالبًا؛ قد يظهر autolysis وبؤر نخرية بيضاء بالكبد والطحال.",
      tests: [
        "FAT على كبد/كلية الجنين",
        "PCR أو عزل فيروسي من رئة/كبد الجنين",
        "Histopathology للمشيمة"
      ]
    },
    {
      key: "leptospira",
      name: "Leptospira spp.",
      labelAr: "ليبتوسبيرا",
      minDcc: 181,
      maxDcc: 260,
      zoonotic: true,
      regulatory: false,
      shortNote: "إجهاض متأخر؛ قد يصاحبه autolysis، يرقان، التهاب بريتوني، وتضخم كلى.",
      tests: [
        "PCR من بول الجنين أو نسيج الكلى",
        "FAT على الكلى",
        "MAT لمصل الأم"
      ]
    },
    {
      key: "brucella_abortus",
      name: "Brucella abortus",
      labelAr: "بروسيلا",
      minDcc: 180,
      maxDcc: 260,
      zoonotic: true,
      regulatory: true,
      shortNote: "إجهاض متأخر؛ خطر حيواني-إنساني عالٍ، مع آفات مشيمية جلدية/سميكة وقد يظهر التهاب رئوي جنيني.",
      tests: [
        "Culture/PCR من محتوى معدة الجنين أو الرئة أو سوائل الرحم",
        "RBPT لمصل الأم",
        "Milk Ring Test عند الحاجة"
      ]
    },
    {
      key: "mycotic_abortion",
      name: "Mycotic abortion",
      labelAr: "إجهاض فطري",
      minDcc: 180,
      maxDcc: 999,
      zoonotic: false,
      regulatory: false,
      shortNote: "غالبًا متأخر إلى قرب الولادة؛ يرتبط بأعلاف/سيلاج متعفن، ومشيمة جلدية سميكة وآفات جلدية فطرية بالجنين.",
      tests: [
        "فحص ميكروسكوبي مباشر لمسحات cotyledons",
        "Histopathology للمشيمة لإظهار hyphae",
        "Culture من محتوى معدة الجنين"
      ]
    }
  ];

  const matches = matrix.filter(x => gDays >= x.minDcc && gDays <= x.maxDcc);

  const probableCauses = matches.map(x => x.labelAr);

let stageLabel = "إجهاض";
let stageShort = "إجهاض";

if (gDays < 90) {
  stageLabel = "إجهاض مبكر";
  stageShort = "مبكر";
} else if (gDays < 180) {
  stageLabel = "إجهاض متوسط";
  stageShort = "متوسط";
} else {
  stageLabel = "إجهاض متأخر";
  stageShort = "متأخر";
}

let probableCause = "";

if (matches.length) {
  const causeNamesShort = matches
    .map(x => String(x.labelAr || x.name || "").trim())
    .filter(Boolean)
    .join("، ");

  const hasSafetyRisk = matches.some(x => x.zoonotic === true || x.regulatory === true);
  const safetySuffix = hasSafetyRisk ? " — حذر" : "";

  probableCause =
    `${stageShort}: ${causeNamesShort} — تأكيد معملي${safetySuffix}`;

} else {
  probableCause =
    `${stageShort}: لا توجد مطابقة واضحة — تقييم معملي`;
}
  const zoonoticHits = matches.filter(x => x.zoonotic).map(x => x.labelAr);
const regulatoryHits = matches.filter(x => x.regulatory).map(x => x.labelAr);

  const abortionDiagnosticNote = [
    "النتيجة احتمالية حسب DCC وليست تشخيصًا نهائيًا.",
    zoonoticHits.length ? `⚠️ احتمال مرض مشترك: ${zoonoticHits.join(" / ")}.` : "",
    regulatoryHits.length ? `🚨 احتمال مرض واجب الإبلاغ/التعامل الرسمي: ${regulatoryHits.join(" / ")}.` : ""
  ].filter(Boolean).join(" ");

  return {
    gestationDays: gDays,
    abortionAgeMonths: months,
    probableCause,
    probableCauses,
    abortionDiagnosticMatrix: matches,
    abortionDiagnosticNote
  };
}
// ============================================================
//                 CALVING CALF UNIQUE CHECK — moved from form-rules.js
//                 نقل كما هو من uniqueCalfNumbers
// ============================================================

async function uniqueCalfNumbersSrv(ctx) {
  const userId = String(ctx.userId || "").trim();
  const nums = Array.isArray(ctx.calfNumbers) ? ctx.calfNumbers : [];

  const cleaned = nums
    .map(calvingNormDigitsOnlySrv)
    .filter(Boolean);

  if (!userId || cleaned.length === 0) return { ok: true };

  // منع تكرار داخل نفس الطلب
  const s = new Set();
  for (const n of cleaned){
    if (s.has(n)) return { ok:false, msg:`⚠️ رقم العجل "${n}" مكرر داخل نفس الولادة.` };
    s.add(n);
  }

  // شيك قاعدة البيانات
  for (const n of cleaned){
    const snap = await db.collection("calves")
      .where("userId", "==", userId)
      .where("calfNumber", "==", n)
      .limit(1)
      .get();

    if (!snap.empty){
      return { ok:false, msg:`⚠️ رقم العجل "${n}" موجود بالفعل في حسابك — اختر رقمًا آخر.` };
    }
  }

  return { ok:true };
}
// ============================================================
//                 API: CALVING GATE — moved from forms-init.js
//                 نقل Gate الولادة كما هو: تحقق فقط بدون حفظ
// ============================================================

async function fetchAnimalByNumberForCalvingGateSrv(uid, number) {
  const num = calvingNormDigitsOnlySrv(number);
  if (!uid || !num) return null;

  async function findInCollection(colName) {
    try {
      const key = `${uid}#${num}`;
      const s1 = await db.collection(colName)
        .where("userId_number", "==", key)
        .limit(1)
        .get();

      if (!s1.empty) {
        const d = s1.docs[0];
        return { id: d.id, data: d.data() || {}, _collection: colName };
      }
    } catch (_) {}

    const tries = [
      ["number", num],
      ["animalNumber", num],
      ["animalNumber", Number(num)],
      ["calfNumber", num],
      ["calfNumber", Number(num)]
    ].filter((t) => !(typeof t[1] === "number" && Number.isNaN(t[1])));

    for (const [field, val] of tries) {
      for (const ownerField of ["userId", "ownerUid"]) {
        try {
          const s2 = await db.collection(colName)
            .where(ownerField, "==", uid)
            .where(field, "==", val)
            .limit(1)
            .get();

          if (!s2.empty) {
            const d = s2.docs[0];
            return { id: d.id, data: d.data() || {}, _collection: colName };
          }
        } catch (_) {}
      }
    }

    return null;
  }

  const animalDoc = await findInCollection("animals");
  if (animalDoc) return animalDoc;

  const calfDoc = await findInCollection("calves");
  if (calfDoc) return calfDoc;

  return null;
}

app.post("/api/calving/gate", requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:"firestore_disabled" });

    const uid = req.userId;
    const body = req.body || {};

    const n = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
    const d = String(body.eventDate || body.date || "").trim().slice(0,10);

    if (!n || !d) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, n);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        allowed: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا."
      });
    }

    const doc = animal.data || {};

    const st = String(doc.status ?? "").trim().toLowerCase();
    if (st === "inactive") {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له."
      });
    }

    const sig = await fetchCalvingSignalsFromEventsSrv(uid, n);

    const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

    let sp = String(body.species || "").trim() || docSpecies;
    if (/cow|بقر/i.test(sp)) sp = "أبقار";
    if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

    const reproFromEvents = String(sig.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();
    const repro = reproFromEvents || reproFromDoc || "";

    const lastAI = String(doc.lastInseminationDate || "").trim();

    const gateData = {
      animalNumber: n,
      eventDate: d,
      animalId: animal.id || "",
      species: sp,
      documentData: doc,
      reproductiveStatus: repro,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate: lastAI,
      lastBoundary: String(sig.lastBoundary || "").trim(),
      lastBoundaryType: String(sig.lastBoundaryType || "").trim()
    };

    const g = calvingDecisionSrv(gateData);

if (g) {
  const raw = String(g || "");
  const hasAbortHint = raw.startsWith("OFFER_ABORT|");

  let cleaned = raw.replace(/^OFFER_ABORT\|/, "");

  if (hasAbortHint) {
    const ageMatch = cleaned.match(/عمر الحمل\s+(\d+)\s+يوم/);
    const ageText = ageMatch ? ` — عمر الحمل ${ageMatch[1]} يوم فقط` : "";

    cleaned = `❌ التاريخ مبكر للولادة${ageText}.\nعدّل التاريخ أو سجّل الحالة كإجهاض.`;
  }

  return res.status(400).json({
    ok: false,
    allowed: false,
    message: cleaned,
    guardError: raw,
    offerAbort: hasAbortHint,
    actions: hasAbortHint ? [
      {
        key: "focus_date",
        label: "تعديل التاريخ",
        focus: "eventDate"
      },
      {
        key: "open_abortion",
        label: "تسجيل إجهاض",
        primary: true,
        url: `/abortion.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`
      }
    ] : []
  });
}
    return res.json({
      ok: true,
      allowed: true,
      message: "✅ تم التحقق — أكمل تسجيل الولادة.",
      animalId: animal.id || "",
      species: sp,
      lastInseminationDate: lastAI,
      signals: sig
    });

  } catch (e) {
    console.error("calving-gate", e);
    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "calving_gate_failed",
      message: "❌ تعذّر التحقق من أهلية الولادة الآن."
    });
  }
});
// ============================================================
//                 CALVING SAME-DAY CHECK — moved from calving.html
//                 نقل كما هو من existsCalvingSameDay
// ============================================================

async function existsCalvingSameDaySrv(uid, number, dateISO) {
  const num = String(number || '').trim();

  const snap = await db.collection('events')
    .where('userId', '==', uid)
    .where('animalNumber', '==', num)
    .where('eventType', '==', 'ولادة')
    .where('eventDate', '==', dateISO)
    .limit(1)
    .get();

  return !snap.empty;
}
// ============================================================
//                 ABORTION SAME-DAY CHECK — server-side
//                 منع تكرار تسجيل إجهاض لنفس الحيوان في نفس اليوم
// ============================================================

async function existsAbortionSameDaySrv(uid, number, dateISO) {
  const num = String(calvingNormDigitsOnlySrv(number || "")).trim();

  const snap = await db.collection("events")
    .where("userId", "==", uid)
    .where("animalNumber", "==", num)
    .where("eventType", "==", "إجهاض")
    .where("eventDate", "==", dateISO)
    .limit(1)
    .get();

  return !snap.empty;
}
// ============================================================
//                 API: INSEMINATION OPTIONS
//                 جلب اختيارات التلقيح المحفوظة للمستخدم
// ============================================================

app.get("/api/insemination/options", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "تعذّر تحميل اختيارات التلقيح — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;

    const snap = await db.collection("user_event_options").doc(uid).get();
    const data = snap.exists ? (snap.data() || {}) : {};

    const semenCodes = Array.isArray(data.inseminationSemenCodes)
      ? data.inseminationSemenCodes
          .map(x => String(x || "").trim())
          .filter(Boolean)
      : [];

    const inseminators = Array.isArray(data.inseminators)
      ? data.inseminators
          .map(x => String(x || "").trim())
          .filter(Boolean)
      : [];

    return res.json({
      ok: true,
      semenCodes,
      inseminators
    });

  } catch (e) {
    console.error("insemination-options", e);

    return res.status(500).json({
      ok: false,
      message: "تعذّر تحميل اختيارات التلقيح الآن."
    });
  }
});
// ============================================================
//                 API: INSEMINATION GATE
//                 تحقق التلقيح من السيرفر فقط — فردي/جماعي — بدون حفظ
// ============================================================

app.post("/api/insemination/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        error: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      "";

    const numbers = typeof parsePregnancyBulkNumbersSrv === "function"
      ? parsePregnancyBulkNumbersSrv(rawNumbers)
      : [calvingNormDigitsOnlySrv(rawNumbers)].filter(Boolean);

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    if (!numbers.length || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_basic",
        message: "أدخل رقم الحيوان والتاريخ لبدء التحقق.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: "❌ تاريخ التلقيح غير صالح.",
        acceptedCount: 0,
        rejectedCount: numbers.length,
        accepted: [],
        rejected: numbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ التلقيح غير صالح."
        }))
      });
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      try {
        const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

        if (!animal) {
          rejected.push({
            animalNumber,
            reason: "الحيوان غير موجود في حسابك."
          });
          continue;
        }

        const doc = animal.data || {};
        const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

        let species = String(
          body.species ||
          doc.species ||
          doc.animalTypeAr ||
          doc.animalType ||
          doc.animaltype ||
          doc.type ||
          ""
        ).trim();

        if (/cow|بقر/i.test(species)) species = "أبقار";
        if (/buffalo|جاموس/i.test(species)) species = "جاموس";

        const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
        const reproFromDoc = String(doc.reproductiveStatus || "").trim();
        const reproStatus = reproFromEvents || reproFromDoc || "";

        const lastInseminationDate = String(
          signals.lastInseminationDateFromEvents ||
          doc.lastInseminationDate ||
          ""
        ).trim();

        const gateData = {
          animalNumber,
          eventDate,
          animalId: animal.id || "",
          species,
          documentData: doc,
          reproductiveStatus: reproStatus,
          reproStatusFromEvents: reproFromEvents,
          lastInseminationDate,
          lastBoundary: String(signals.lastBoundary || "").trim(),
          lastBoundaryType: String(signals.lastBoundaryType || "").trim()
        };

        const errMsg = inseminationDecisionSrv(gateData);

        if (errMsg) {
          const raw = String(errMsg || "");
          const isWarn = raw.startsWith("WARN|");
          const message = isWarn ? raw.replace(/^WARN\|/, "") : raw;

          if (!isWarn) {
            rejected.push({
              animalNumber,
              reason: message
            });
            continue;
          }

          accepted.push({
            animalNumber,
            animalId: animal.id || "",
            species,
            reproductiveStatus: reproStatus,
            warning: true,
            message,
            stage: "pre_gate"
          });
          continue;
        }

        accepted.push({
          animalNumber,
          animalId: animal.id || "",
          species,
          reproductiveStatus: reproStatus,
          lastInseminationDate,
          stage: "pre_gate"
        });

      } catch (oneErr) {
        console.error("insemination-gate-one", animalNumber, oneErr);

        rejected.push({
          animalNumber,
          reason: "تعذّر التحقق من هذا الحيوان الآن."
        });
      }
    }

    const acceptedCount = accepted.length;
    const rejectedCount = rejected.length;
    const isBulk = numbers.length > 1;

    if (!isBulk) {
      if (!acceptedCount) {
        const r0 = rejected[0] || {};
        return res.status(400).json({
          ok: false,
          allowed: false,
          stage: "pre_gate",
          message: r0.reason || "❌ لا يمكن تسجيل التلقيح لهذا الحيوان.",
          acceptedCount,
          rejectedCount,
          accepted,
          rejected
        });
      }

      const a0 = accepted[0];

      return res.json({
        ok: true,
        allowed: true,
        stage: "pre_gate",
        message: "✅ تم فحص الشروط الأساسية — الحيوان مؤهل للتلقيح.",
        animalId: a0.animalId || "",
        animalNumber: a0.animalNumber || "",
        species: a0.species || "",
        reproductiveStatus: a0.reproductiveStatus || "",
        lastInseminationDate: a0.lastInseminationDate || "",
        acceptedCount,
        rejectedCount,
        accepted,
        rejected
      });
    }

    return res.json({
      ok: true,
      allowed: acceptedCount > 0,
      stage: "pre_gate",
      message: acceptedCount
        ? `✅ تم فحص الشروط الأساسية للقائمة — المؤهل للتلقيح: ${acceptedCount}، المرفوض: ${rejectedCount}.`
        : "❌ لا يوجد أي رقم صالح لاستكمال تسجيل التلقيح.",
      acceptedCount,
      rejectedCount,
      accepted,
      rejected
    });

  } catch (e) {
    console.error("insemination-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "insemination_gate_failed",
      message: "❌ تعذّر التحقق من أهلية التلقيح الآن."
    });
  }
});
// ============================================================
//                 API: INSEMINATION SAVE
//                 حفظ التلقيح وتحديث الحيوان من السيرفر فقط
// ============================================================

app.post("/api/insemination/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ التلقيح – قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const formData = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(
      formData.animalNumber ||
      formData.number ||
      ""
    );

    const eventDate = String(
      formData.eventDate ||
      formData.date ||
      ""
    ).trim().slice(0, 10);

    if (!animalNumber || !eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان وتاريخ التلقيح مطلوبان.",
        fieldErrors: {
          animalNumber: !animalNumber ? "رقم الحيوان مطلوب." : undefined,
          eventDate: !eventDate ? "تاريخ التلقيح غير صالح." : undefined
        }
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا.",
        fieldErrors: {
          animalNumber: "تعذّر العثور على الحيوان."
        }
      });
    }

    const doc = animal.data || {};

    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

    let species = String(
      formData.species ||
      doc.species ||
      doc.animalTypeAr ||
      doc.animalType ||
      doc.animaltype ||
      doc.type ||
      ""
    ).trim();

    if (/cow|بقر/i.test(species)) species = "أبقار";
    if (/buffalo|جاموس/i.test(species)) species = "جاموس";

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();
    const reproStatus = reproFromEvents || reproFromDoc || "";

    const lastInseminationDate = String(
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      ""
    ).trim();

    const gateData = {
      ...formData,
      animalNumber,
      eventDate,
      animalId: animal.id || "",
      species,
      documentData: doc,
      reproductiveStatus: reproStatus,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate,
      lastBoundary: String(signals.lastBoundary || "").trim(),
      lastBoundaryType: String(signals.lastBoundaryType || "").trim()
    };

    const fieldErrors = validateInseminationFieldsSrv(gateData);

    const cleanFieldErrors = {};
    for (const [k, v] of Object.entries(fieldErrors || {})) {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        cleanFieldErrors[k] = v;
      }
    }

    if (Object.keys(cleanFieldErrors).length) {
      return res.status(400).json({
        ok: false,
        message: "❌ راجع بيانات التلقيح المطلوبة.",
        fieldErrors: cleanFieldErrors
      });
    }

    const decision = inseminationDecisionSrv(gateData);

    if (decision) {
      const raw = String(decision || "");
      const isWarn = raw.startsWith("WARN|");
      const message = isWarn ? raw.replace(/^WARN\|/, "") : raw;

      if (!isWarn) {
        return res.status(400).json({
          ok: false,
          message
        });
      }

      // التحذير لا يمنع الحفظ — مطابق للمنطق القديم
    }

    const payload = {
      userId: uid,
      animalId: animal.id || "",
      animalNumber,
      eventDate,

      eventType: "insemination",
      type: "insemination",
      eventTypeNorm: "insemination",

      inseminationMethod: String(formData.inseminationMethod || "").trim(),
      semenCode: String(formData.semenCode || "").trim(),
      inseminator: String(formData.inseminator || "").trim(),
      inseminationTime: String(formData.inseminationTime || "").trim(),
      heatStatus: String(formData.heatStatus || "").trim(),
      notes: String(formData.notes || "").trim() || null,

      species,
      source: "server:/api/insemination/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

const prevServices = Number(doc.servicesCount || 0);
const nextServices = Number.isFinite(prevServices) ? prevServices + 1 : 1;

const animalCol = animal._collection || "animals";
const eventRef = db.collection("events").doc();
const animalRef = db.collection(animalCol).doc(animal.id);

const batch = db.batch();

batch.set(eventRef, payload);

batch.set(animalRef, {
  reproductiveStatus: "ملقحة",
  lastInseminationDate: eventDate,
  servicesCount: nextServices,
  updatedAt: admin.firestore.FieldValue.serverTimestamp()
}, { merge: true });

// ✅ حفظ اختيارات التلقيح المستخدمة داخل حساب المستخدم
// تُستخدم لاحقًا في صفحة التلقيح للاختيار بدل الكتابة كل مرة
const semenOption = String(formData.semenCode || "").trim();
const inseminatorOption = String(formData.inseminator || "").trim();

if (semenOption || inseminatorOption) {
  const optionsRef = db.collection("user_event_options").doc(uid);

  const optionsPatch = {
    userId: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (semenOption) {
    optionsPatch.inseminationSemenCodes =
      admin.firestore.FieldValue.arrayUnion(semenOption);
  }

  if (inseminatorOption) {
    optionsPatch.inseminators =
      admin.firestore.FieldValue.arrayUnion(inseminatorOption);
  }

  batch.set(optionsRef, optionsPatch, { merge: true });
}

await batch.commit();
    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "insemination_save");
    }

    return res.json({
      ok: true,
      message: "✅ تم حفظ التلقيح بنجاح",
      id: eventRef.id,
      eventId: eventRef.id,
      optionsSaved: !!(semenOption || inseminatorOption),
      optionsPath: `user_event_options/${uid}`,
      savedSemenOption: semenOption || null,
      savedInseminatorOption: inseminatorOption || null,
      animalId: animal.id || "",
      animalNumber,
      eventDate,
      reproductiveStatus: "ملقحة",
      lastInseminationDate: eventDate,
      servicesCount: nextServices,
      actions: [
        {
          key: "event_list",
          label: "فتح قائمة الأحداث",
          primary: true,
          url: `/event-list.html?number=${encodeURIComponent(animalNumber)}`
        },
        {
          key: "cow_card",
          label: "فتح بطاقة الحيوان",
          url: `/cow-card.html?number=${encodeURIComponent(animalNumber)}`
        }
      ]
    });

  } catch (e) {
    console.error("insemination-save", e);

    return res.status(500).json({
      ok: false,
      error: "insemination_save_failed",
      message: "❌ تعذّر حفظ التلقيح الآن."
    });
  }
});
// ============================================================
//                 API: INSEMINATION BULK SAVE
//                 حفظ التلقيح الجماعي من السيرفر فقط
// ============================================================

app.post("/api/insemination/bulk-save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ التلقيح الجماعي – قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const formData = req.body || {};

    const rawNumbers =
      formData.animalNumbers ||
      formData.numbers ||
      formData.selectedNumbers ||
      formData.groupNumbers ||
      formData.animals ||
      formData.animalNumber ||
      formData.number ||
      "";

    const animalNumbers = typeof parsePregnancyBulkNumbersSrv === "function"
      ? parsePregnancyBulkNumbersSrv(rawNumbers)
      : [calvingNormDigitsOnlySrv(rawNumbers)].filter(Boolean);

    const eventDate = String(
      formData.eventDate ||
      formData.date ||
      ""
    ).trim().slice(0, 10);

    if (!animalNumbers.length || !eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان وتاريخ التلقيح مطلوبان.",
        savedCount: 0,
        rejectedCount: animalNumbers.length,
        saved: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التلقيح غير صالح.",
        savedCount: 0,
        rejectedCount: animalNumbers.length,
        saved: [],
        rejected: animalNumbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ التلقيح غير صالح."
        }))
      });
    }

    const saved = [];
    const rejected = [];

    let batch = db.batch();
    let ops = 0;

    async function commitIfNeeded(force = false) {
      if (ops > 0 && (force || ops >= 400)) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    for (const rawNum of animalNumbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      try {
        const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

        if (!animal) {
          rejected.push({
            animalNumber,
            reason: "الحيوان غير موجود في حسابك."
          });
          continue;
        }

        const doc = animal.data || {};
        const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

        let species = String(
          formData.species ||
          doc.species ||
          doc.animalTypeAr ||
          doc.animalType ||
          doc.animaltype ||
          doc.type ||
          ""
        ).trim();

        if (/cow|بقر/i.test(species)) species = "أبقار";
        if (/buffalo|جاموس/i.test(species)) species = "جاموس";

        const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
        const reproFromDoc = String(doc.reproductiveStatus || "").trim();
        const reproStatus = reproFromEvents || reproFromDoc || "";

        const lastInseminationDate = String(
          signals.lastInseminationDateFromEvents ||
          doc.lastInseminationDate ||
          ""
        ).trim();

        const gateData = {
          ...formData,
          animalNumber,
          eventDate,
          animalId: animal.id || "",
          species,
          documentData: doc,
          reproductiveStatus: reproStatus,
          reproStatusFromEvents: reproFromEvents,
          lastInseminationDate,
          lastBoundary: String(signals.lastBoundary || "").trim(),
          lastBoundaryType: String(signals.lastBoundaryType || "").trim()
        };

        const fieldErrors = validateInseminationFieldsSrv(gateData);

        const cleanFieldErrors = {};
        for (const [k, v] of Object.entries(fieldErrors || {})) {
          if (v !== undefined && v !== null && String(v).trim() !== "") {
            cleanFieldErrors[k] = v;
          }
        }

        if (Object.keys(cleanFieldErrors).length) {
          rejected.push({
            animalNumber,
            reason: "راجع بيانات التلقيح المطلوبة.",
            fieldErrors: cleanFieldErrors
          });
          continue;
        }

        const decision = inseminationDecisionSrv(gateData);
        let warningMessage = "";

        if (decision) {
          const raw = String(decision || "");
          const isWarn = raw.startsWith("WARN|");
          const message = isWarn ? raw.replace(/^WARN\|/, "") : raw;

          if (!isWarn) {
            rejected.push({
              animalNumber,
              reason: message
            });
            continue;
          }

          warningMessage = message;
        }

        const eventRef = db.collection("events").doc();

        const payload = {
          userId: uid,
          animalId: animal.id || "",
          animalNumber,
          eventDate,

          eventType: "insemination",
          type: "insemination",
          eventTypeNorm: "insemination",

          inseminationMethod: String(formData.inseminationMethod || "").trim(),
          semenCode: String(formData.semenCode || "").trim(),
          inseminator: String(formData.inseminator || "").trim(),
          inseminationTime: String(formData.inseminationTime || "").trim(),
          heatStatus: String(formData.heatStatus || "").trim(),
          notes: String(formData.notes || "").trim() || null,

          species,
          source: "server:/api/insemination/bulk-save",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const prevServices = Number(doc.servicesCount || 0);
        const nextServices = Number.isFinite(prevServices) ? prevServices + 1 : 1;

        const animalCol = animal._collection || "animals";
        const animalRef = db.collection(animalCol).doc(animal.id);

        batch.set(eventRef, payload);
        ops++;

        batch.set(animalRef, {
          reproductiveStatus: "ملقحة",
          lastInseminationDate: eventDate,
          servicesCount: nextServices,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        ops++;

        saved.push({
          animalNumber,
          eventId: eventRef.id,
          reproductiveStatus: "ملقحة",
          lastInseminationDate: eventDate,
          servicesCount: nextServices,
          warning: warningMessage || ""
        });

        await commitIfNeeded(false);

      } catch (oneErr) {
        console.error("insemination-bulk-save-one", animalNumber, oneErr);

        rejected.push({
          animalNumber,
          reason: "تعذّر حفظ التلقيح لهذا الحيوان الآن."
        });
      }
    }

    const semenOption = String(formData.semenCode || "").trim();
    const inseminatorOption = String(formData.inseminator || "").trim();

    if (semenOption || inseminatorOption) {
      const optionsRef = db.collection("user_event_options").doc(uid);

      const optionsPatch = {
        userId: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (semenOption) {
        optionsPatch.inseminationSemenCodes =
          admin.firestore.FieldValue.arrayUnion(semenOption);
      }

      if (inseminatorOption) {
        optionsPatch.inseminators =
          admin.firestore.FieldValue.arrayUnion(inseminatorOption);
      }

      batch.set(optionsRef, optionsPatch, { merge: true });
      ops++;
    }

    await commitIfNeeded(true);

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "insemination_bulk_save");
    }

   if (!saved.length) {
  return res.status(400).json({
    ok: false,
    message: "❌ لم يتم حفظ أي تلقيح — كل الأرقام غير مؤهلة أو بيانات التلقيح غير مكتملة.",
    redirectUrl: "",
    savedCount: 0,
    rejectedCount: rejected.length,
    saved,
    rejected
  });
}

return res.json({
  ok: true,
  message: `✅ تم حفظ التلقيح لعدد ${saved.length} حيوان.`,
  redirectUrl: "/event-list.html",
  savedCount: saved.length,
  rejectedCount: rejected.length,
  saved,
  rejected
});

  } catch (e) {
    console.error("insemination-bulk-save", e);

    return res.status(500).json({
      ok: false,
      error: "insemination_bulk_save_failed",
      message: "❌ تعذّر حفظ التلقيح الجماعي الآن."
    });
  }
});
// ============================================================
//                 PREGNANCY DIAGNOSIS — server-side only
//                 نقل قرار/حفظ تشخيص الحمل للسيرفر فقط
// ============================================================

function validatePregnancyDiagnosisFieldsSrv(fd = {}) {
  const fieldErrors = {};

  if (!String(fd.animalNumber || "").trim()) {
    fieldErrors.animalNumber = "رقم الحيوان مطلوب.";
  }

  if (!String(fd.eventDate || "").trim() || !calvingIsDateSrv(fd.eventDate)) {
    fieldErrors.eventDate = "تاريخ التشخيص غير صالح.";
  }

  if (!fd.documentData) {
    fieldErrors.documentData = "تعذّر العثور على الحيوان.";
  }

  if (!String(fd.method || "").trim()) {
    fieldErrors.method = "طريقة التشخيص مطلوبة.";
  }

  if (!String(fd.result || "").trim()) {
    fieldErrors.result = "نتيجة التشخيص مطلوبة.";
  }

  return fieldErrors;
}

function normalizePregnancyMethodSrv(v) {
  const s = String(v || "").trim();

  if (s === "ultrasound" || s === "سونار") return "سونار";
  if (s === "manual" || s === "جس يدوي" || s === "يدوي") return "جس يدوي";

  return s;
}

function normalizePregnancyResultSrv(v) {
  const s = String(v || "").trim();

  if (s.includes("عشار") || s.toLowerCase() === "positive" || s.toLowerCase() === "pregnant") {
    return "عشار";
  }

  if (s.includes("فارغة") || s.includes("فارغه") || s.toLowerCase() === "negative" || s.toLowerCase() === "open") {
    return "فارغة";
  }

  return s;
}

function pregnancyDiagnosisDecisionSrv(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return "❌ لا يمكن تسجيل تشخيص حمل — الحيوان خارج القطيع.";
  }

  // الحالة التناسلية: من الأحداث أولًا ثم الوثيقة
  const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  const rsNorm = calvingStripArSrv(rsRaw);
  const speciesRaw = String(
  fd.species ||
  doc.species ||
  doc.animalTypeAr ||
  doc.animalType ||
  doc.animaltype ||
  doc.type ||
  ""
).trim();

let species = speciesRaw;
if (/cow|بقر/i.test(species)) species = "أبقار";
if (/buffalo|جاموس/i.test(species)) species = "جاموس";

const animalLabel = species === "جاموس" ? "الجاموسة" : "البقرة";
  // لازم تكون ملقحة فقط
  if (!rsNorm.includes("ملقح")) {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ لا يمكن تشخيص الحمل — ${animalLabel} ${shown}.`;
  }

  const method = normalizePregnancyMethodSrv(fd.method);
  const isSono = method === "سونار";
  const isManual = method === "جس يدوي";

  if (!isSono && !isManual) {
    return "❌ طريقة التشخيص غير معروفة.";
  }

  const minDays = isSono ? 26 : 40;

  const lastAI = String(
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    ""
  ).trim();

  if (!calvingIsDateSrv(lastAI)) {
    return '❌ لا يمكن تشخيص الحمل — لا يوجد "آخر تلقيح" صحيح.';
  }

  if (!calvingIsDateSrv(fd.eventDate)) {
    return "❌ تاريخ التشخيص غير صالح.";
  }

  const diff = calvingDaysBetweenSrv(lastAI, fd.eventDate);
  if (!Number.isFinite(diff)) {
    return "❌ تعذّر حساب الأيام منذ آخر تلقيح.";
  }

  if (diff < minDays) {
return `❌ لا يمكن تشخيص الحمل — ${animalLabel} مرّ عليها ${diff} يوم فقط منذ آخر تلقيح.\nالحد الأدنى لتشخيص الحمل: 26 يوم للسونار و40 يوم لليدوي.`;
  }

  return null;
}

async function updateAnimalByPregnancyDiagnosisSrv(ev = {}) {
  const uid = String(ev.userId || "").trim();
  const animalNumber = calvingNormDigitsOnlySrv(
    ev.animalNumber ||
    ev.number ||
    ev.animalId ||
    ""
  );

  if (!uid || !animalNumber) {
    console.warn("⛔ updateAnimalByPregnancyDiagnosisSrv: missing uid/animalNumber", { uid, animalNumber, ev });
    return;
  }

  const animal = await findAnimalDocByNumberSrv(uid, animalNumber);

  if (!animal || !animal.id) {
    console.warn("⛔ animal not found for pregnancy diagnosis update:", { uid, animalNumber });
    return;
  }

  const result = normalizePregnancyResultSrv(ev.result);
  const eventDate = String(ev.eventDate || "").trim().slice(0, 10);

  const patch = {
    lastDiagnosis: "تشخيص حمل",
    lastDiagnosisDate: eventDate,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "active"
  };

  if (result === "عشار") {
    patch.reproductiveStatus = "عشار";
  }

  if (result === "فارغة") {
    patch.reproductiveStatus = "مفتوحة";
  }

  await db.collection("animals").doc(animal.id).set(patch, { merge: true });

  console.log("🔥 animal updated by pregnancy diagnosis:", animal.id, patch);
}

// ============================================================
//                 API: PREGNANCY DIAGNOSIS GATE
//                 تحقق تشخيص الحمل من السيرفر فقط — فردي/جماعي — بدون حفظ
// ============================================================

// ============================================================
//                 API: PREGNANCY DIAGNOSIS GATE
//                 تحقق تشخيص الحمل من السيرفر فقط — فردي/جماعي — بدون حفظ
//                 المرحلة الأولى: تنقية القائمة فور وصولها
//                 المرحلة الثانية: تطبيق حد الأيام بعد اختيار طريقة التشخيص
// ============================================================

app.post("/api/pregnancy-diagnosis/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        error: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      "";

    const numbers = typeof parsePregnancyBulkNumbersSrv === "function"
      ? parsePregnancyBulkNumbersSrv(rawNumbers)
      : [calvingNormDigitsOnlySrv(rawNumbers)].filter(Boolean);

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const method = normalizePregnancyMethodSrv(body.method);
    const hasMethod = !!String(method || "").trim();

    if (!numbers.length || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_basic",
        message: "أدخل رقم الحيوان والتاريخ لبدء التحقق.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: "❌ تاريخ التشخيص غير صالح.",
        acceptedCount: 0,
        rejectedCount: numbers.length,
        accepted: [],
        rejected: numbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ التشخيص غير صالح."
        }))
      });
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};
      const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

      let species = String(
        body.species ||
        doc.species ||
        doc.animalTypeAr ||
        doc.animalType ||
        doc.animaltype ||
        doc.type ||
        ""
      ).trim();

      if (/cow|بقر/i.test(species)) species = "أبقار";
      if (/buffalo|جاموس/i.test(species)) species = "جاموس";
      const animalLabel = species === "جاموس" ? "الجاموسة" : "البقرة";

      const st = String(doc.status ?? "").trim().toLowerCase();

      if (st === "inactive") {
        rejected.push({
          animalNumber,
          animalId: animal.id || "",
          reason: "❌ لا يمكن تسجيل تشخيص حمل — الحيوان خارج القطيع."
        });
        continue;
      }

      const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const reproStatus = reproFromEvents || reproFromDoc || "";
      const reproNorm = calvingStripArSrv(reproStatus);

      if (!reproNorm.includes("ملقح")) {
        const shown = reproStatus ? `«${reproStatus}»` : "غير معروفة";
        rejected.push({
          animalNumber,
          animalId: animal.id || "",
          reason: `❌ لا يمكن تشخيص الحمل — ${animalLabel} ${shown}.`
        });
        continue;
      }

      const lastInseminationDate = String(
        signals.lastInseminationDateFromEvents ||
        doc.lastInseminationDate ||
        doc.lastAI ||
        doc.lastInsemination ||
        ""
      ).trim();

      if (!calvingIsDateSrv(lastInseminationDate)) {
        rejected.push({
          animalNumber,
          animalId: animal.id || "",
          reason: '❌ لا يمكن تشخيص الحمل — لا يوجد "آخر تلقيح" صحيح.'
        });
        continue;
      }

      const diff = calvingDaysBetweenSrv(lastInseminationDate, eventDate);

      if (!Number.isFinite(diff)) {
        rejected.push({
          animalNumber,
          animalId: animal.id || "",
          reason: "❌ تعذّر حساب الأيام منذ آخر تلقيح."
        });
        continue;
      }
if (!hasMethod && diff < 26) {
  rejected.push({
    animalNumber,
    animalId: animal.id || "",
   reason: `❌ لا يمكن تشخيص الحمل — ${animalLabel} ملقحة منذ ${diff} يوم فقط.`
  });
  continue;
}
      // ✅ المرحلة الثانية فقط: لو المستخدم اختار الطريقة، نطبّق حد الأيام
      if (hasMethod) {
        const isSono = method === "سونار";
        const isManual = method === "جس يدوي";

        if (!isSono && !isManual) {
          rejected.push({
            animalNumber,
            animalId: animal.id || "",
            reason: "❌ طريقة التشخيص غير معروفة."
          });
          continue;
        }

        const minDays = isSono ? 26 : 40;

        if (diff < minDays) {
          rejected.push({
            animalNumber,
            animalId: animal.id || "",
            reason: `❌ لا يمكن تشخيص الحمل — ${animalLabel} ملقحة منذ ${diff} يوم فقط.`
          });
          continue;
        }
      }

      accepted.push({
        animalNumber,
        animalId: animal.id || "",
        species,
        reproductiveStatus: reproStatus || "",
        lastInseminationDate,
        daysSinceInsemination: diff,
        method: hasMethod ? method : "",
        stage: hasMethod ? "method_gate" : "pre_gate"
      });
    }

    const acceptedCount = accepted.length;
    const rejectedCount = rejected.length;
    const isBulk = numbers.length > 1;

    // ✅ رد فردي
    if (!isBulk) {
      if (!acceptedCount) {
        const r0 = rejected[0] || {};
        return res.status(400).json({
          ok: false,
          allowed: false,
          stage: hasMethod ? "method_gate" : "pre_gate",
          message: r0.reason || "❌ لا يمكن تسجيل تشخيص الحمل لهذا الحيوان.",
          acceptedCount,
          rejectedCount,
          accepted,
          rejected
        });
      }

      const a0 = accepted[0];

      return res.json({
        ok: true,
        allowed: true,
        stage: hasMethod ? "method_gate" : "pre_gate",
       message: hasMethod
         ? "✅ تم التحقق — الحيوان مؤهل للتسجيل."
         : "✅ تم فحص الشروط الأساسية — اختر طريقة التشخيص لاستكمال تحقق الأهلية.",
        animalId: a0.animalId || "",
        animalNumber: a0.animalNumber || "",
        species: a0.species || "",
        reproductiveStatus: a0.reproductiveStatus || "",
        lastInseminationDate: a0.lastInseminationDate || "",
        daysSinceInsemination: a0.daysSinceInsemination,
        method: a0.method || "",
        acceptedCount,
        rejectedCount,
        accepted,
        rejected
      });
    }

    // ✅ رد جماعي
    return res.json({
      ok: true,
      allowed: acceptedCount > 0,
      stage: hasMethod ? "method_gate" : "pre_gate",
     message: acceptedCount
  ? (
      hasMethod
        ? `✅ تم التحقق — المؤهل: ${acceptedCount}، غير المؤهل: ${rejectedCount}.`
        : `✅ تم فحص الشروط الأساسية للقائمة — المتبقي لاستكمال تحقق الأهلية: ${acceptedCount}، المرفوض: ${rejectedCount}.`
    )
  : "❌ لا يوجد أي رقم صالح لاستكمال تحقق تشخيص الحمل.",
      acceptedCount,
      rejectedCount,
      accepted,
      rejected
    });

  } catch (e) {
    console.error("pregnancy-diagnosis-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "pregnancy_diagnosis_gate_failed",
      message: "❌ تعذّر التحقق من أهلية تشخيص الحمل الآن."
    });
  }
});// ============================================================
//                 API: PREGNANCY DIAGNOSIS SAVE
//                 حفظ تشخيص الحمل وتحديث الحيوان من السيرفر فقط
// ============================================================

app.post("/api/pregnancy-diagnosis/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تشخيص الحمل – قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const formData = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(
      formData.animalNumber ||
      formData.number ||
      ""
    );

    const eventDate = String(
      formData.eventDate ||
      formData.date ||
      ""
    ).trim().slice(0, 10);

    const method = normalizePregnancyMethodSrv(formData.method);
    const result = normalizePregnancyResultSrv(formData.result);

    if (!animalNumber || !eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان وتاريخ التشخيص مطلوبان.",
        fieldErrors: {
          animalNumber: !animalNumber ? "رقم الحيوان مطلوب." : undefined,
          eventDate: !eventDate ? "تاريخ التشخيص غير صالح." : undefined
        }
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا.",
        fieldErrors: {
          animalNumber: "تعذّر العثور على الحيوان."
        }
      });
    }

    const doc = animal.data || {};
    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

    let species = String(
      formData.species ||
      doc.species ||
      doc.animalTypeAr ||
      doc.animalType ||
      doc.animaltype ||
      doc.type ||
      ""
    ).trim();

    if (/cow|بقر/i.test(species)) species = "أبقار";
    if (/buffalo|جاموس/i.test(species)) species = "جاموس";

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();
    const reproStatus = reproFromEvents || reproFromDoc || "";

    const lastInseminationDate = String(
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      ""
    ).trim();

    const gateData = {
      ...formData,
      animalNumber,
      eventDate,
      animalId: animal.id || "",
      species,
      documentData: doc,
      reproductiveStatus: reproStatus,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate,
      method,
      result,
      lastBoundary: String(signals.lastBoundary || "").trim(),
      lastBoundaryType: String(signals.lastBoundaryType || "").trim()
    };

    const fieldErrors = validatePregnancyDiagnosisFieldsSrv(gateData);

    const cleanFieldErrors = {};
    for (const [k, v] of Object.entries(fieldErrors || {})) {
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        cleanFieldErrors[k] = v;
      }
    }

    if (Object.keys(cleanFieldErrors).length) {
      return res.status(400).json({
        ok: false,
        message: "❌ راجع بيانات تشخيص الحمل المطلوبة.",
        fieldErrors: cleanFieldErrors
      });
    }

    const decision = pregnancyDiagnosisDecisionSrv(gateData);

    if (decision) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: String(decision)
      });
    }

    const eventRef = db.collection("events").doc();

    const payload = {
      userId: uid,

      animalId: animal.id || "",
      animalNumber,
      eventDate,

      type: "تشخيص حمل",
      eventType: "تشخيص حمل",
      eventTypeNorm: "pregnancy_diagnosis",

      method,
      result,
      vet: String(formData.vet || "").trim() || null,

      species,
      reproductiveStatusBefore: reproStatus || "",
      lastInseminationDate,

      source: "server:/api/pregnancy-diagnosis/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const batch = db.batch();

    batch.set(eventRef, payload);

    const animalPatch = {
      lastDiagnosis: "تشخيص حمل",
      lastDiagnosisDate: eventDate,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "active"
    };

    if (result === "عشار") {
      animalPatch.reproductiveStatus = "عشار";
    }

    if (result === "فارغة") {
      animalPatch.reproductiveStatus = "مفتوحة";
    }

    batch.set(db.collection("animals").doc(animal.id), animalPatch, { merge: true });

    await batch.commit();

    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "pregnancy_diagnosis_save");
    }

    return res.json({
      ok: true,
      message: "✅ تم حفظ تشخيص الحمل بنجاح",
      id: eventRef.id,
      eventId: eventRef.id,

      animalId: animal.id || "",
      animalNumber,
      eventDate,
      method,
      result,

      reproductiveStatus: animalPatch.reproductiveStatus || reproStatus || "",

      actions: [
        {
          key: "event_list",
          label: "فتح قائمة الأحداث",
          primary: true,
          url: `/event-list.html?number=${encodeURIComponent(animalNumber)}`
        },
        {
          key: "cow_card",
          label: "فتح بطاقة الحيوان",
          url: `/cow-card.html?number=${encodeURIComponent(animalNumber)}`
        }
      ]
    });

  } catch (e) {
    console.error("pregnancy-diagnosis-save", e);

    return res.status(500).json({
      ok: false,
      error: "pregnancy_diagnosis_save_failed",
      message: "❌ تعذّر حفظ تشخيص الحمل الآن."
    });
  }
});
// ============================================================
//                 API: PREGNANCY DIAGNOSIS BULK SAVE
//                 حفظ جماعي لتشخيص الحمل من السيرفر فقط
// ============================================================

function parsePregnancyBulkNumbersSrv(raw) {
  const map = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9"
  };

  const s = String(raw || "")
    .replace(/[٠-٩۰-۹]/g, d => map[d] || d);

  const arr = (s.match(/\d+/g) || [])
    .map(x => String(x || "").replace(/\D/g, "").trim())
    .filter(Boolean);

  return [...new Set(arr)];
}

app.post("/api/pregnancy-diagnosis/bulk-save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تشخيص الحمل الجماعي – قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const numbers = parsePregnancyBulkNumbersSrv(
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      ""
    );

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const method = normalizePregnancyMethodSrv(body.method);
    const result = normalizePregnancyResultSrv(body.result);
    const vet = String(body.vet || "").trim() || null;

    if (!numbers.length) {
      return res.status(400).json({
        ok: false,
        message: "❌ أدخل أرقام الحيوانات أولًا."
      });
    }

    if (!eventDate || !calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التشخيص غير صالح.",
        fieldErrors: {
          eventDate: "تاريخ التشخيص غير صالح."
        }
      });
    }

    if (!method) {
      return res.status(400).json({
        ok: false,
        message: "❌ طريقة التشخيص مطلوبة.",
        fieldErrors: {
          method: "طريقة التشخيص مطلوبة."
        }
      });
    }

    if (!result) {
      return res.status(400).json({
        ok: false,
        message: "❌ نتيجة التشخيص مطلوبة.",
        fieldErrors: {
          result: "نتيجة التشخيص مطلوبة."
        }
      });
    }

    const saved = [];
    const rejected = [];

    let batch = db.batch();
    let ops = 0;

    async function commitIfNeeded(force = false) {
      if (ops > 0 && (force || ops >= 400)) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: rawNum,
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};
      const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

      let species = String(
        body.species ||
        doc.species ||
        doc.animalTypeAr ||
        doc.animalType ||
        doc.animaltype ||
        doc.type ||
        ""
      ).trim();

      if (/cow|بقر/i.test(species)) species = "أبقار";
      if (/buffalo|جاموس/i.test(species)) species = "جاموس";

      const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const reproStatus = reproFromEvents || reproFromDoc || "";

      const lastInseminationDate = String(
        signals.lastInseminationDateFromEvents ||
        doc.lastInseminationDate ||
        ""
      ).trim();

      const gateData = {
        animalNumber,
        eventDate,
        animalId: animal.id || "",
        species,
        documentData: doc,
        reproductiveStatus: reproStatus,
        reproStatusFromEvents: reproFromEvents,
        lastInseminationDate,
        method,
        result,
        lastBoundary: String(signals.lastBoundary || "").trim(),
        lastBoundaryType: String(signals.lastBoundaryType || "").trim()
      };

      const fieldErrors = validatePregnancyDiagnosisFieldsSrv(gateData);
      const hasFieldErrors = Object.values(fieldErrors || {}).some(v => String(v || "").trim());

      if (hasFieldErrors) {
        rejected.push({
          animalNumber,
          reason: "بيانات التشخيص غير مكتملة لهذا الحيوان.",
          fieldErrors
        });
        continue;
      }

      const decision = pregnancyDiagnosisDecisionSrv(gateData);

      if (decision) {
        rejected.push({
          animalNumber,
          reason: String(decision)
        });
        continue;
      }

      const eventRef = db.collection("events").doc();

      const payload = {
        userId: uid,

        animalId: animal.id || "",
        animalNumber,
        eventDate,

        type: "تشخيص حمل",
        eventType: "تشخيص حمل",
        eventTypeNorm: "pregnancy_diagnosis",

        method,
        result,
        vet,

        species,
        reproductiveStatusBefore: reproStatus || "",
        lastInseminationDate,

        source: "server:/api/pregnancy-diagnosis/bulk-save",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const animalPatch = {
        lastDiagnosis: "تشخيص حمل",
        lastDiagnosisDate: eventDate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "active"
      };

      if (result === "عشار") {
        animalPatch.reproductiveStatus = "عشار";
      }

      if (result === "فارغة") {
        animalPatch.reproductiveStatus = "مفتوحة";
      }

      batch.set(eventRef, payload);
      ops++;

      batch.set(db.collection("animals").doc(animal.id), animalPatch, { merge: true });
      ops++;

      saved.push({
        animalNumber,
        eventId: eventRef.id,
        result,
        reproductiveStatus: animalPatch.reproductiveStatus || reproStatus || ""
      });

      await commitIfNeeded(false);
    }

    await commitIfNeeded(true);

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "pregnancy_diagnosis_bulk_save");
    }

    return res.json({
      ok: true,
      message: saved.length
        ? `✅ تم حفظ تشخيص الحمل لعدد ${saved.length} حيوان.`
        : "❌ لم يتم حفظ أي تشخيص حمل — كل الأرقام غير مؤهلة.",
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected
    });

  } catch (e) {
    console.error("pregnancy-diagnosis-bulk-save", e);

    return res.status(500).json({
      ok: false,
      error: "pregnancy_diagnosis_bulk_save_failed",
      message: "❌ تعذّر حفظ تشخيص الحمل الجماعي الآن."
    });
  }
});
// ============================================================
//                 OVSYNCH PROTOCOL DURATION HELPERS
//                 إنهاء/تجاهل البروتوكول النشط حسب مدة البرنامج
// ============================================================

function ovsynchProgramDurationDaysSrv(program) {
  const p = String(program || "").trim().toLowerCase();

  if (p === "ovsynch") return 10;
  if (p === "cosynch72") return 10;
  if (p === "presynch_ovsynch") return 38;

  // لو البرنامج القديم غير محفوظ في وثيقة الحيوان، نستخدم أطول مدة آمنة.
  return 38;
}

function addDaysToIsoDateSrv(iso, days) {
  if (!calvingIsDateSrv(iso)) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function resolveOvsynchProgramFromAnimalSrv(doc = {}) {
  return String(
    doc.currentProtocolProgram ||
    doc.protocolProgram ||
    doc.program ||
    ""
  ).trim();
}

function ovsynchActiveProtocolBlockMessageSrv(doc = {}, eventDate = "") {
  const curProto = String(doc.currentProtocol || "").trim().toLowerCase();
  const protoStatus = String(doc.protocolStatus || "").trim().toLowerCase();
  const protoStart = String(doc.protocolStartDate || "").trim().slice(0, 10);

  if (curProto !== "ovsynch" || protoStatus !== "active") {
    return null;
  }

  if (!calvingIsDateSrv(protoStart) || !calvingIsDateSrv(eventDate)) {
    return "❌ لا يمكن بدء بروتوكول جديد — الحيوان داخل بروتوكول تزامن نشط.";
  }

  const program = resolveOvsynchProgramFromAnimalSrv(doc);
  const durationDays = ovsynchProgramDurationDaysSrv(program);
  const activeDays = calvingDaysBetweenSrv(protoStart, eventDate);

  if (!Number.isFinite(activeDays)) {
    return "❌ لا يمكن بدء بروتوكول جديد — الحيوان داخل بروتوكول تزامن نشط.";
  }

  // لو لم تنته مدة البرنامج بعد، يمنع.
  if (activeDays >= 0 && activeDays <= durationDays) {
    return "❌ لا يمكن بدء بروتوكول جديد — الحيوان داخل بروتوكول تزامن نشط.";
  }

  // لو تعدى مدة البرنامج، لا يمنع؛ يعتبر منتهيًا منطقيًا.
  return null;
}
// ============================================================
//                 API: OVSYNCH GATE
//                 أهلية أرقام التزامن فقط — بدون حفظ وبدون Tasks
// ============================================================

app.post("/api/ovsynch/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        error: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

   const rawNumbers =
  body.animalNumbers ||
  body.numbers ||
  body.animalNumber ||
  body.number ||
  "";

function parseOvsynchNumbers(raw) {
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const txt = String(raw || "").trim();
    if (!txt) return [];

    try {
      const parsed = JSON.parse(txt);
      arr = Array.isArray(parsed) ? parsed : txt.split(/\n|,|;|،|\s+/g);
    } catch (_) {
      arr = txt.split(/\n|,|;|،|\s+/g);
    }
  }

  return [...new Set(
    arr
      .map(x => calvingNormDigitsOnlySrv(x))
      .filter(Boolean)
  )];
}

const numbers = parseOvsynchNumbers(rawNumbers);

    const eventDate = String(
      body.eventDate ||
      body.date ||
      body.startDate ||
      ""
    ).trim().slice(0, 10);

    if (!numbers.length || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_context",
        message: "سياق التزامن غير مكتمل من صفحة الأحداث.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: "❌ تاريخ بدء البروتوكول غير صالح.",
        acceptedCount: 0,
        rejectedCount: numbers.length,
        accepted: [],
        rejected: numbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ بدء البروتوكول غير صالح."
        }))
      });
    }

    function normalizeOvsynchSpecies(doc = {}, fallback = "") {
      let sp = String(
        fallback ||
        doc.species ||
        doc.animalTypeAr ||
        doc.animalType ||
        doc.animaltype ||
        doc.type ||
        ""
      ).trim();

      if (/cow|بقر/i.test(sp)) sp = "أبقار";
      if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

      return sp || "أبقار";
    }

    function ovsynchAnimalWord(sp) {
      return sp === "جاموس" ? "جاموسة" : "بقرة";
    }

    function ovsynchAnimalLabel(doc = {}) {
      return normalizeOvsynchSpecies(doc) === "جاموس" ? "الجاموسة" : "البقرة";
    }

    function ovsynchReproCategory(raw) {
      const n = calvingStripArSrv(raw);

      if (
        n.includes("لاتلقح") ||
        n.includes("لاتلقحمرةاخرى") ||
        n.includes("لاتلقحمرهاخرى") ||
        n.includes("لاتلقحمرةاخري")
      ) return "blocked";

      if (n.includes("عشار")) return "pregnant";

      if (
        n.includes("ملقح") ||
        n.includes("ملقحة") ||
        n.includes("ملقّحة")
      ) return "inseminated";

      if (
        n.includes("مفتوح") ||
        n.includes("فارغ") ||
        n.includes("فارغة")
      ) return "open";

      return "unknown";
    }

    function compactOvsynchReason(reason) {
      let s = String(reason || "").trim();

      s = s.replace(/^\s*❌\s*/, "");
      s = s.replace(/\s+/g, " ").trim();

      s = s.replace(/الحالة الحالية:\s*«?\s*حديث(?:ة)? الولادة\s*»?/g, "حديثة الولادة");
      s = s.replace(/الحالة الحالية:\s*«?\s*تحضير(?: لل)?ولادة\s*»?/g, "تحضير للولادة");
      s = s.replace(/الحالة الحالية:\s*«?\s*ملقح(?:ة)?\s*»?/g, "ملقحة");
      s = s.replace(/الحالة الحالية:\s*«?\s*عشار\s*»?/g, "عشار");
      s = s.replace(/الحالة الحالية:\s*«?\s*مفتوح(?:ة)?\s*»?/g, "مفتوحة");

      s = s.replace(/\s*—\s*المسموح.*$/, "").trim();

      return "❌ " + s;
    }

    function ovsynchEligibilityDecision(fd = {}) {
      const doc = fd.documentData;
      if (!doc) return "تعذّر قراءة بيانات الحيوان.";

      const st = String(doc.status ?? "").trim().toLowerCase();
      if (st === "inactive") return "❌ الحيوان خارج القطيع.";

      const reproDocRaw = String(doc.reproductiveStatus || "").trim();
      const reproDocCat = ovsynchReproCategory(reproDocRaw);

      if (doc.breedingBlocked === true || reproDocCat === "blocked") {
        return "❌ الحيوان مستبعد (لا تُلقّح مرة أخرى).";
      }

     const activeProtocolMsg = ovsynchActiveProtocolBlockMessageSrv(doc, fd.eventDate);
if (activeProtocolMsg) return activeProtocolMsg;

      const sp = normalizeOvsynchSpecies(doc, fd.species);
      const w = ovsynchAnimalWord(sp);

      const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
      const cat = ovsynchReproCategory(rsRaw);
      const shownStatus = rsRaw ? `«${rsRaw}»` : "غير معروفة";

      if (cat === "pregnant" || cat === "inseminated" || cat === "blocked") {
        return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — الحالة: ${shownStatus}.`;
      }

      if (cat !== "open") {
        return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — المسموح فقط للحيوانات المفتوحة.\nالحالة الحالية: ${shownStatus}.`;
      }

      if (!calvingIsDateSrv(fd.eventDate)) {
        return "❌ تاريخ بدء البروتوكول غير صالح.";
      }

      const lastCalving = String(doc.lastCalvingDate || "").trim();

      if (lastCalving && calvingIsDateSrv(lastCalving)) {
        const minAfterCalving = sp === "جاموس" ? 45 : 60;
        const sinceCalving = calvingDaysBetweenSrv(lastCalving, fd.eventDate);

        if (
          Number.isFinite(sinceCalving) &&
          sinceCalving >= 0 &&
          sinceCalving < minAfterCalving
        ) {
          return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — حديثة الولادة (منذ ${sinceCalving} يوم).`;
        }
      }

      return null;
    }

    async function getLastOvsynchEvent(animalNumber) {
      const num = calvingNormDigitsOnlySrv(animalNumber);
      if (!uid || !num) return null;

      try {
        const snap = await db.collection("events")
          .where("userId", "==", uid)
          .where("animalNumber", "==", num)
          .where("eventType", "==", "بروتوكول تزامن")
          .orderBy("eventDate", "desc")
          .limit(1)
          .get();

        if (snap.empty) return null;

        const d = snap.docs[0].data() || {};

        return {
          eventDate: String(d.eventDate || "").slice(0, 10),
          program: String(d.program || "").trim()
        };
      } catch (_) {
        return null;
      }
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};
      const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

      const species = normalizeOvsynchSpecies(doc, body.species);
      const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();

      const decision = ovsynchEligibilityDecision({
        animalNumber,
        eventDate,
        animalId: animal.id || "",
        species,
        documentData: doc,
        reproStatusFromEvents: reproFromEvents,
        lastBoundary: String(signals.lastBoundary || "").trim(),
        lastBoundaryType: String(signals.lastBoundaryType || "").trim()
      });

      if (decision) {
        rejected.push({
          animalNumber,
          reason: String(decision)
        });
        continue;
      }

      const last = await getLastOvsynchEvent(animalNumber);

      if (last?.eventDate && String(last.program || "").trim() === "ovsynch") {
        const g14 = calvingDaysBetweenSrv(last.eventDate, eventDate);

        if (Number.isFinite(g14) && g14 >= 0 && g14 < 14) {
          rejected.push({
            animalNumber,
            reason: `${ovsynchAnimalLabel(doc)} رقم ${animalNumber}: مسجّلة بالفعل في برنامج تزامن بدأ بتاريخ ${last.eventDate}.`
          });
          continue;
        }
      }

      accepted.push({
        animalNumber,
        animalId: animal.id || "",
        species,
        reproductiveStatus: reproFromEvents || String(doc.reproductiveStatus || "").trim() || ""
      });
    }

    const allowed = accepted.length > 0;

   const acceptedCount = accepted.length;
const rejectedCount = rejected.length;
const isBulk = numbers.length > 1;

if (!isBulk) {
  if (!acceptedCount) {
    const r0 = rejected[0] || {};
    return res.status(400).json({
      ok: false,
      allowed: false,
      stage: "no_eligible_animals",
      message: (() => {
  const n = String(r0.animalNumber || "").trim();
  const reason = compactOvsynchReason(r0.reason || "❌ الحيوان غير مؤهل لبدء برنامج التزامن.").replace(/^❌\s*/, "");
  return n ? `❌ الحيوان رقم ${n}: ${reason}` : `❌ ${reason}`;
})(),
      acceptedCount,
      rejectedCount,
      accepted,
      rejected
    });
  }

  return res.json({
    ok: true,
    allowed: true,
    stage: "eligible",
    message: "✅ الحيوان مؤهل لبدء برنامج التزامن.",
    acceptedCount,
    rejectedCount,
    accepted,
    rejected
  });
}

if (!acceptedCount) {
  return res.status(400).json({
    ok: false,
    allowed: false,
    stage: "no_eligible_animals",
message:
  "لا يوجد أرقام مؤهلة لبدء برنامج التزامن حاليًا.\n\n" +
  rejected.map(r => {
    const n = String(r.animalNumber || "").trim();
    const reason = compactOvsynchReason(r.reason).replace(/^❌\s*/, "");
    return n ? `❌ الحيوان رقم ${n}: ${reason}` : `❌ ${reason}`;
  }).join("\n"),
    acceptedCount,
    rejectedCount,
    accepted,
    rejected
  });
}

return res.json({
  ok: true,
  allowed: true,
  stage: "eligible",
message:
  `✅ مؤهل: ${acceptedCount}\n` +
  `🚫 غير مؤهل: ${rejectedCount}` +
  (
    rejectedCount
      ? "\n\n" + rejected.map(r => {
          const n = String(r.animalNumber || "").trim();
          const reason = compactOvsynchReason(r.reason).replace(/^❌\s*/, "");
          return n ? `❌ الحيوان رقم ${n}: ${reason}` : `❌ ${reason}`;
        }).join("\n")
      : ""
  ),
  acceptedCount,
  rejectedCount,
  accepted,
  rejected
});
  } catch (e) {
    console.error("ovsynch-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "ovsynch_gate_failed",
      message: "❌ تعذّر فحص أهلية أرقام التزامن الآن.",
      acceptedCount: 0,
      rejectedCount: 0,
      accepted: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: OVSYNCH SAVE
//                 حفظ بروتوكول التزامن + Tasks + تحديث الحيوان
// ============================================================

app.post("/api/ovsynch/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ بروتوكول التزامن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      "";

    function parseOvsynchNumbersForSave(raw) {
      let arr = [];

      if (Array.isArray(raw)) {
        arr = raw;
      } else {
        const txt = String(raw || "").trim();
        if (!txt) return [];

        try {
          const parsed = JSON.parse(txt);
          arr = Array.isArray(parsed) ? parsed : txt.split(/\n|,|;|،|\s+/g);
        } catch (_) {
          arr = txt.split(/\n|,|;|،|\s+/g);
        }
      }

      return [...new Set(
        arr
          .map(x => calvingNormDigitsOnlySrv(x))
          .filter(Boolean)
      )];
    }

    function parseOvsynchStepsForSave(raw) {
      if (Array.isArray(raw)) return raw;

      const txt = String(raw || "").trim();
      if (!txt) return [];

      try {
        const parsed = JSON.parse(txt);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    const numbers = parseOvsynchNumbersForSave(rawNumbers);

    const eventDate = String(
      body.eventDate ||
      body.date ||
      body.startDate ||
      ""
    ).trim().slice(0, 10);

    const program = String(body.program || "").trim();
    const steps = parseOvsynchStepsForSave(body.steps);

    // حماية طلب الحفظ فقط — لا كتابة قبل اكتمال هذه البيانات
    const missing = {};
    if (!numbers.length) missing.animalNumbers = "أرقام الحيوانات غير متاحة من صفحة الأحداث.";
    if (!eventDate || !calvingIsDateSrv(eventDate)) missing.eventDate = "تاريخ بدء البروتوكول غير متاح أو غير صالح.";
    if (!program) missing.program = "اختر نوع برنامج التزامن.";
    if (!steps.length) missing.steps = "اختر البرنامج ليظهر جدول الخطوات.";

    if (Object.keys(missing).length) {
      return res.status(400).json({
        ok: false,
        savedCount: 0,
        alreadyCount: 0,
        rejectedCount: 0,
        rejected: [],
        fieldErrors: missing,
        message: "❌ بيانات حفظ بروتوكول التزامن غير مكتملة."
      });
    }

    function normalizeOvsynchSpeciesForSave(doc = {}, fallback = "") {
      let sp = String(
        fallback ||
        doc.species ||
        doc.animalTypeAr ||
        doc.animalType ||
        doc.animaltype ||
        doc.type ||
        ""
      ).trim();

      if (/cow|بقر/i.test(sp)) sp = "أبقار";
      if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

      return sp || "أبقار";
    }

    function ovsynchAnimalWordForSave(sp) {
      return sp === "جاموس" ? "جاموسة" : "بقرة";
    }

    function ovsynchReproCategoryForSave(raw) {
      const n = calvingStripArSrv(raw);

      if (
        n.includes("لاتلقح") ||
        n.includes("لاتلقحمرةاخرى") ||
        n.includes("لاتلقحمرهاخرى") ||
        n.includes("لاتلقحمرةاخري")
      ) return "blocked";

      if (n.includes("عشار")) return "pregnant";

      if (
        n.includes("ملقح") ||
        n.includes("ملقحة") ||
        n.includes("ملقّحة")
      ) return "inseminated";

      if (
        n.includes("مفتوح") ||
        n.includes("فارغ") ||
        n.includes("فارغة")
      ) return "open";

      return "unknown";
    }

    function compactOvsynchReasonForSave(reason) {
      let s = String(reason || "").trim();

      s = s.replace(/^\s*❌\s*/, "");
      s = s.replace(/\s+/g, " ").trim();

      s = s.replace(/الحالة الحالية:\s*«?\s*حديث(?:ة)? الولادة\s*»?/g, "حديثة الولادة");
      s = s.replace(/الحالة الحالية:\s*«?\s*تحضير(?: لل)?ولادة\s*»?/g, "تحضير للولادة");
      s = s.replace(/الحالة الحالية:\s*«?\s*ملقح(?:ة)?\s*»?/g, "ملقحة");
      s = s.replace(/الحالة الحالية:\s*«?\s*عشار\s*»?/g, "عشار");
      s = s.replace(/الحالة الحالية:\s*«?\s*مفتوح(?:ة)?\s*»?/g, "مفتوحة");

      s = s.replace(/\s*—\s*المسموح.*$/, "").trim();

      return "❌ " + s;
    }

    function ovsynchEligibilityDecisionForSave(fd = {}) {
      const doc = fd.documentData;
      if (!doc) return "تعذّر قراءة بيانات الحيوان.";

      const st = String(doc.status ?? "").trim().toLowerCase();
    if (st === "inactive") return "❌ الحيوان غير موجود في القطيع/حسابك.";

      const reproDocRaw = String(doc.reproductiveStatus || "").trim();
      const reproDocCat = ovsynchReproCategoryForSave(reproDocRaw);

      if (doc.breedingBlocked === true || reproDocCat === "blocked") {
        return "❌ الحيوان مستبعد (لا تُلقّح مرة أخرى).";
      }

     const activeProtocolMsg = ovsynchActiveProtocolBlockMessageSrv(doc, fd.eventDate);
if (activeProtocolMsg) return activeProtocolMsg;

      const sp = normalizeOvsynchSpeciesForSave(doc, fd.species);
      const w = ovsynchAnimalWordForSave(sp);

      const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
      const cat = ovsynchReproCategoryForSave(rsRaw);
      const shownStatus = rsRaw ? `«${rsRaw}»` : "غير معروفة";

      if (cat === "pregnant" || cat === "inseminated" || cat === "blocked") {
        return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — الحالة: ${shownStatus}.`;
      }

      if (cat !== "open") {
        return `❌ لا يمكن بدء بروتوكول التزامن — الحالة التناسلية الحالية: ${shownStatus}.`;
      }

      if (!calvingIsDateSrv(fd.eventDate)) {
        return "❌ تاريخ بدء البروتوكول غير صالح.";
      }

      const lastCalving = String(doc.lastCalvingDate || "").trim();

      if (lastCalving && calvingIsDateSrv(lastCalving)) {
        const minAfterCalving = sp === "جاموس" ? 45 : 60;
        const sinceCalving = calvingDaysBetweenSrv(lastCalving, fd.eventDate);

        if (
          Number.isFinite(sinceCalving) &&
          sinceCalving >= 0 &&
          sinceCalving < minAfterCalving
        ) {
         return `❌ لا يمكن بدء بروتوكول التزامن لحيوان حديث الولادة منذ ${sinceCalving} يوم.`;
        }
      }

      return null;
    }

    async function getLastOvsynchEventForSave(animalNumber) {
      const num = calvingNormDigitsOnlySrv(animalNumber);
      if (!uid || !num) return null;

      try {
        const snap = await db.collection("events")
          .where("userId", "==", uid)
          .where("animalNumber", "==", num)
          .where("eventType", "==", "بروتوكول تزامن")
          .orderBy("eventDate", "desc")
          .limit(1)
          .get();

        if (snap.empty) return null;

        const d = snap.docs[0].data() || {};

        return {
          eventDate: String(d.eventDate || "").slice(0, 10),
          program: String(d.program || "").trim()
        };
      } catch (_) {
        return null;
      }
    }

    async function upsertOvsynchTasksForSave(batch, animalNumber, protocolStartISO, programKey, stepsArr) {
      if (!animalNumber || !protocolStartISO || !Array.isArray(stepsArr) || !stepsArr.length) return 0;

      const startDay = String(protocolStartISO).slice(0, 10);
      let ops = 0;

      for (let i = 0; i < stepsArr.length; i++) {
        const st = stepsArr[i] || {};
        const stepDay = (typeof st.day === "number") ? st.day : i;
        const stepName = st.name || `Step ${i}`;
        const stepDT = String(st.date || "");
        const dueDate = stepDT.slice(0, 10) || startDay;
        const taskId = `task__${animalNumber}__ovsynch__${startDay}__d${stepDay}`;
        const ref = db.collection("tasks").doc(taskId);

        const snap = await ref.get();

        if (snap.exists) {
          const cur = snap.data() || {};
          const stt = String(cur.status || "").toLowerCase();

          if (stt === "done" || stt === "cancelled") {
            continue;
          }
        }

        const isDone = !!st.done;
        const payload = {
          userId: uid,
          animalNumber: String(animalNumber),
          type: "protocol_step",
          taskType: "ovsynch_step",
          protocol: "ovsynch",
          program: programKey || "ovsynch",
          protocolStartDate: startDay,
          stepIndex: i,
          stepDay,
          stepKey: `ovsynch_d${stepDay}`,
          stepName,
          dueDate,
          plannedDate: dueDate,
          plannedTime: (stepDT && stepDT.length >= 16) ? stepDT.slice(11, 16) : "08:00",
          plannedDateTime: stepDT || (dueDate + "T08:00"),
          status: isDone ? "done" : "pending",
          done: isDone ? true : false,
          doneAt: isDone ? admin.firestore.FieldValue.serverTimestamp() : null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!snap.exists) {
          payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        }

        batch.set(ref, payload, { merge: true });
        ops++;
      }

      return ops;
    }

    const valid = [];
    const rejected = [];

    // إعادة فحص الأهلية داخل الحفظ قبل أي كتابة
    for (const animalNumber of numbers) {
      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: `❌ الحيوان رقم ${animalNumber}: غير موجود في القطيع/حسابك.`
        });
        continue;
      }

      // تم فحص الأهلية مسبقًا في /api/ovsynch/gate.
// الحفظ لا يعيد قرار الأهلية؛ يراجع فقط وجود الحيوان والتكرار القريب قبل الكتابة.
      const last = await getLastOvsynchEventForSave(animalNumber);

      if (last?.eventDate && String(last.program || "").trim() === "ovsynch") {
        const g14 = calvingDaysBetweenSrv(last.eventDate, eventDate);

        if (Number.isFinite(g14) && g14 >= 0 && g14 < 14) {
          rejected.push({
            animalNumber,
            reason: `❌ الحيوان رقم ${animalNumber}: مسجّل بالفعل في برنامج تزامن بدأ بتاريخ ${last.eventDate}.`
          });
          continue;
        }
      }

      valid.push({
        animalNumber,
        animal
      });
    }

    if (!valid.length) {
      return res.status(400).json({
        ok: false,
        savedCount: 0,
        alreadyCount: 0,
        rejectedCount: rejected.length,
        saved: [],
        rejected,
        message: rejected.length
  ? (
     numbers.length === 1
  ? (() => {
      const x = rejected[0] || {};
      const n = String(x.animalNumber || "").trim();
      const reason = compactOvsynchReasonForSave(
        x.reason || "❌ الحيوان غير مؤهل لتسجيل بروتوكول التزامن."
      ).replace(/^❌\s*/, "");

      return n ? `❌ الحيوان رقم ${n}: ${reason}` : `❌ ${reason}`;
    })()
  : rejected.slice(0, 8).map(x => {
      const n = String(x.animalNumber || "").trim();
      const reason = compactOvsynchReasonForSave(x.reason).replace(/^❌\s*/, "");

      return n ? `❌ الحيوان رقم ${n}: ${reason}` : `❌ ${reason}`;
    }).join("\n")
    )
  : (
      numbers.length === 1
        ? "❌ الحيوان غير مؤهل لتسجيل بروتوكول التزامن."
        : "❌ لا يوجد أي رقم مؤهل لتسجيل بروتوكول التزامن."
    )
      });
    }

    const batch = db.batch();
    let ops = 0;
    let savedCount = 0;
    let alreadyCount = 0;
    const saved = [];

    for (const item of valid) {
      const animalNumber = item.animalNumber;
      const animal = item.animal;

      const id = ["ovsynch", animalNumber, program, eventDate].join("__");
      const eventRef = db.collection("events").doc(id);

      const ex = await eventRef.get();

      if (ex.exists) {
        alreadyCount++;
        continue;
      }

      const eventPayload = {
        type: "ovsynch",
        eventType: "بروتوكول تزامن",
        eventTypeNorm: "ovsynch",
        eventDate,
        program,
        steps,
        userId: uid,
        ownerUid: uid,
        animalId: animal.id || "",
        animalNumber: String(animalNumber),
        source: "server:/api/ovsynch/save",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      batch.set(eventRef, eventPayload);
      ops++;

      ops += await upsertOvsynchTasksForSave(batch, animalNumber, eventDate, program, steps);

     const protocolDurationDays = ovsynchProgramDurationDaysSrv(program);

batch.set(db.collection(animal._collection || "animals").doc(animal.id), {
  currentProtocol: "ovsynch",
  currentProtocolProgram: program,
  protocolProgram: program,
  protocolStatus: "active",
  protocolStartDate: eventDate,
  protocolExpectedEndDate: addDaysToIsoDateSrv(eventDate, protocolDurationDays),
  status: "active",
  updatedAt: admin.firestore.FieldValue.serverTimestamp()
}, { merge: true });
      ops++;

      savedCount++;
      saved.push({
        animalNumber,
        eventId: id
      });
    }

    if (ops > 0) {
      await batch.commit();
    }
  if (savedCount && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "ovsynch_save");
    }

const savedNumbers = saved
  .map(x => String(x.animalNumber || "").trim())
  .filter(Boolean);

let message = "";

if (savedNumbers.length === 1) {
  message = `✅ تم تسجيل بروتوكول التزامن للحيوان رقم ${savedNumbers[0]}`;
} else if (savedNumbers.length > 1) {
  message = `✅ تم تسجيل بروتوكول التزامن للحيوانات أرقام: ${savedNumbers.join("، ")}`;
} else {
  message = "❌ لم يتم تسجيل بروتوكول التزامن.";
}
    return res.json({
      ok: true,
      message,
      savedCount,
      alreadyCount,
      rejectedCount: rejected.length,
      saved,
      rejected
    });

  } catch (e) {
    console.error("ovsynch-save", e);

    return res.status(500).json({
      ok: false,
      error: "ovsynch_save_failed",
      message: "❌ تعذّر حفظ بروتوكول التزامن الآن."
    });
  }
});
// ============================================================
//                 API: OVSYNCH DASHBOARD ALERTS
//                 تنبيهات الداشبورد الذكية من tasks — عرض فقط
// ============================================================

app.get("/api/ovsynch/dashboard-alerts", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        alerts: [],
        message: "تعذّر تحميل تنبيهات بروتوكول التزامن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;

    function addDaysISOForOvsynchAlerts(iso, days) {
      const s = String(iso || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
      return dt.toISOString().slice(0, 10);
    }

    function normTaskNumberForOvsynchAlerts(v) {
      if (typeof calvingNormDigitsOnlySrv === "function") {
        return calvingNormDigitsOnlySrv(v);
      }
      return String(v || "").replace(/[^\d]/g, "").trim();
    }

    const today = cairoTodayISO();
    const tomorrow = addDaysISOForOvsynchAlerts(today, 1);

    const snap = await db.collection("tasks")
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(500)
      .get();

    const groups = new Map();

    snap.forEach(docSnap => {
      const t = docSnap.data() || {};

      const isOvsynchTask =
        String(t.taskType || "").trim() === "ovsynch_step" ||
        String(t.type || "").trim() === "ovsynch_step" ||
        (
          String(t.type || "").trim() === "protocol_step" &&
          String(t.protocol || "").trim() === "ovsynch"
        );

      if (!isOvsynchTask) return;

      const dueDate = String(t.dueDate || t.plannedDate || "").trim().slice(0, 10);
      if (dueDate !== today && dueDate !== tomorrow) return;

      const animalNumber = normTaskNumberForOvsynchAlerts(t.animalNumber || t.number || "");
      if (!animalNumber) return;

      const stepIndex = Number(t.stepIndex ?? 0) || 0;
      const stepDay = Number(t.stepDay ?? 0) || 0;
      const stepName = String(t.stepName || t.title || "خطوة بروتوكول").trim();
      const plannedTime = String(t.plannedTime || "08:00").trim();
      const program = String(t.program || t.protocolProgram || "ovsynch").trim();
      const protocolStartDate = String(t.protocolStartDate || "").trim().slice(0, 10);

      const key = [
        dueDate,
        plannedTime,
        program,
        protocolStartDate,
        stepIndex,
        stepDay,
        stepName
      ].join("__");

      if (!groups.has(key)) {
        groups.set(key, {
          dueDate,
          plannedTime,
          program,
          protocolStartDate,
          stepIndex,
          stepDay,
          stepName,
          animalNumbers: []
        });
      }

      groups.get(key).animalNumbers.push(animalNumber);
    });

    const alerts = [];

    for (const g of groups.values()) {
      const nums = [...new Set(g.animalNumbers)].filter(Boolean).sort((a, b) => Number(a) - Number(b));
      if (!nums.length) continue;

      const isToday = g.dueDate === today;
      const title = isToday
        ? "خطوة بروتوكول التزامن اليوم"
        : "خطوة بروتوكول التزامن غدًا";

      const prefix = isToday ? "⏰ اليوم" : "📌 غدًا";

      const message =
        `${prefix} خطوة بروتوكول التزامن: ${g.stepName}\n` +
        `للحيوانات أرقام: ${nums.join("، ")}\n` +
        `الموعد: ${g.plannedTime}`;

      const actionUrl =
        `ovysynch.html?mode=step` +
        `&date=${encodeURIComponent(g.dueDate)}` +
        `&dueDate=${encodeURIComponent(g.dueDate)}` +
        `&stepIndex=${encodeURIComponent(g.stepIndex)}` +
        `&program=${encodeURIComponent(g.program)}` +
        `&protocolStartDate=${encodeURIComponent(g.protocolStartDate || "")}`;

      alerts.push({
        id: `ovsynch_${g.dueDate}_${g.stepIndex}_${g.protocolStartDate || "no_start"}`,
        source: "server:/api/ovsynch/dashboard-alerts",
        type: "ovsynch_step",
        level: isToday ? "warn" : "info",
        title,
        message,
        actionText: "فتح صفحة التزامن",
        actionUrl,
        dueDate: g.dueDate,
        plannedTime: g.plannedTime,
        program: g.program,
        protocolStartDate: g.protocolStartDate,
        stepIndex: g.stepIndex,
        stepDay: g.stepDay,
        stepName: g.stepName,
        animalNumbers: nums,
        count: nums.length
      });
    }

    alerts.sort((a, b) => {
      const da = String(a.dueDate || "");
      const dbb = String(b.dueDate || "");
      if (da !== dbb) return da.localeCompare(dbb);
      return String(a.plannedTime || "").localeCompare(String(b.plannedTime || ""));
    });

    return res.json({
      ok: true,
      today,
      tomorrow,
      count: alerts.length,
      alerts
    });

  } catch (e) {
    console.error("ovsynch-dashboard-alerts", e);

    return res.status(500).json({
      ok: false,
      alerts: [],
      message: "❌ تعذّر تحميل تنبيهات بروتوكول التزامن الآن."
    });
  }
});
// ============================================================
//                 API: OVSYNCH STEP TARGETS
//                 تحميل حيوانات خطوة اليوم من tasks — بدون حفظ وبدون تأكيد
// ============================================================

app.get("/api/ovsynch/step-targets", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "تعذّر تحميل مهام بروتوكول التزامن — قاعدة البيانات غير متاحة.",
        animalNumbers: [],
        count: 0,
        meta: null
      });
    }

    const uid = req.userId;

    const stepIndex = Math.max(
      0,
      parseInt(
        req.query.stepIndex ??
        req.query.step ??
        "0",
        10
      ) || 0
    );

    const dueDate = String(
      req.query.dueDate ||
      req.query.date ||
      cairoTodayISO()
    ).trim().slice(0, 10);

    const snap = await db.collection("tasks")
      .where("userId", "==", uid)
      .where("dueDate", "==", dueDate)
      .where("status", "==", "pending")
      .limit(500)
      .get();

    const nums = [];
    let meta = null;

    snap.forEach(docSnap => {
      const t = docSnap.data() || {};

      const isOvsynchTask =
        String(t.type || "").trim() === "ovsynch_step" ||
        (
          String(t.type || "").trim() === "protocol_step" &&
          String(t.protocol || "").trim() === "ovsynch"
        );

      if (!isOvsynchTask) return;
      if (Number(t.stepIndex) !== stepIndex) return;

      const n = calvingNormDigitsOnlySrv(t.animalNumber || "");
      if (!n) return;

      nums.push(n);

      if (!meta) {
        meta = {
          type: t.type || "",
          protocol: t.protocol || "ovsynch",
          program: t.program || t.protocolProgram || "",
          protocolProgram: t.protocolProgram || t.program || "",
          protocolStartDate: String(t.protocolStartDate || "").slice(0, 10),
          stepIndex: Number(t.stepIndex || 0),
          stepDay: Number(t.stepDay || 0),
          stepKey: String(t.stepKey || ""),
          stepName: String(t.stepName || ""),
          dueDate: String(t.dueDate || dueDate).slice(0, 10),
          plannedDate: String(t.plannedDate || t.dueDate || dueDate).slice(0, 10),
          plannedTime: String(t.plannedTime || "")
        };
      }
    });

    const animalNumbers = [...new Set(nums)].filter(Boolean);

    if (!animalNumbers.length) {
      return res.json({
        ok: true,
        message: "✅ لا يوجد حيوانات مطلوبة لهذه الخطوة اليوم.",
        dueDate,
        stepIndex,
        animalNumbers: [],
        count: 0,
        meta: null
      });
    }

    const stepName = String(meta?.stepName || ("الخطوة رقم " + stepIndex));
const message = animalNumbers.length === 1
  ? `اليوم خطوة بروتوكول: ${stepName} للحيوان رقم ${animalNumbers[0]}`
  : `اليوم خطوة بروتوكول: ${stepName} للحيوانات أرقام: ${animalNumbers.join("، ")}`;

    return res.json({
      ok: true,
      message,
      dueDate,
      stepIndex,
      animalNumbers,
      count: animalNumbers.length,
      meta
    });

  } catch (e) {
    console.error("ovsynch-step-targets", e);

    return res.status(500).json({
      ok: false,
      message: "❌ تعذّر تحميل مهام خطوة التزامن الآن.",
      animalNumbers: [],
      count: 0,
      meta: null
    });
  }
});
// ============================================================
//                 API: OVSYNCH CONFIRM STEP
//                 تأكيد تنفيذ خطوة التزامن + تحديث Task + Event
// ============================================================

app.post("/api/ovsynch/confirm-step", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "تعذّر تأكيد خطوة بروتوكول التزامن — قاعدة البيانات غير متاحة.",
        doneCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      "";

    function parseOvsynchNumbersForConfirm(raw) {
      let arr = [];

      if (Array.isArray(raw)) {
        arr = raw;
      } else {
        const txt = String(raw || "").trim();
        if (!txt) return [];

        try {
          const parsed = JSON.parse(txt);
          arr = Array.isArray(parsed) ? parsed : txt.split(/\n|,|;|،|\s+/g);
        } catch (_) {
          arr = txt.split(/\n|,|;|،|\s+/g);
        }
      }

      return [...new Set(
        arr
          .map(x => calvingNormDigitsOnlySrv(x))
          .filter(Boolean)
      )];
    }

    const numbers = parseOvsynchNumbersForConfirm(rawNumbers);

    const program = String(
      body.program ||
      body.protocolProgram ||
      "ovsynch"
    ).trim();

    const protocolStartDate = String(
      body.protocolStartDate ||
      body.startDate ||
      body.eventDate ||
      ""
    ).trim().slice(0, 10);

    const eventDate = String(
      body.confirmedOn ||
      body.doneDate ||
      body.date ||
      cairoTodayISO()
    ).trim().slice(0, 10);

    const stepIndex = Math.max(
      0,
      parseInt(body.stepIndex ?? body.step ?? "0", 10) || 0
    );

    const stepDay = Number(body.stepDay ?? 0);
    const stepName = String(body.stepName || "").trim();

    const missing = {};
    if (!numbers.length) missing.animalNumbers = "قائمة الحيوانات غير متاحة.";
    if (!program) missing.program = "برنامج التزامن غير متاح.";
    if (!protocolStartDate || !calvingIsDateSrv(protocolStartDate)) {
      missing.protocolStartDate = "تاريخ بداية البروتوكول غير متاح أو غير صالح.";
    }
    if (!eventDate || !calvingIsDateSrv(eventDate)) {
      missing.eventDate = "تاريخ تنفيذ الخطوة غير صالح.";
    }
    if (!stepName) missing.stepName = "اسم الخطوة غير متاح.";

    if (Object.keys(missing).length) {
      return res.status(400).json({
        ok: false,
        message: "❌ بيانات تأكيد خطوة التزامن غير مكتملة.",
        fieldErrors: missing,
        doneCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    const batch = db.batch();
    let ops = 0;
    let doneCount = 0;
    const saved = [];
    const rejected = [];

    for (const animalNumber of numbers) {
      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: `❌ الحيوان رقم ${animalNumber}: غير موجود في القطيع/حسابك.`
        });
        continue;
      }

      const baseId = ["ovsynch", animalNumber, program, protocolStartDate].join("__");
      const stepEventId = `${baseId}__step_event_${stepIndex}`;

      const eventRef = db.collection("events").doc(stepEventId);

      batch.set(eventRef, {
        type: "ovsynch_step",
        eventType: "خطوة تزامن",
        eventTypeNorm: "ovsynch_step",
        eventDate,
        userId: uid,
        ownerUid: uid,
        animalId: animal.id || "",
        animalNumber: String(animalNumber),
        protocolType: "ovsynch",
        protocolProgram: program,
        protocolStartDate,
        stepIndex,
        stepDay: Number.isFinite(stepDay) ? stepDay : 0,
        stepName,
        source: "server:/api/ovsynch/confirm-step",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      ops++;

      const primaryTaskId =
        `task__${animalNumber}__ovsynch__${protocolStartDate}__d${Number.isFinite(stepDay) ? stepDay : 0}`;

      const legacyTaskId =
        `${baseId}__step_${stepIndex}`;

      for (const taskId of [...new Set([primaryTaskId, legacyTaskId])]) {
        batch.set(db.collection("tasks").doc(taskId), {
          userId: uid,
          animalNumber: String(animalNumber),
          type: "protocol_step",
          protocol: "ovsynch",
          program,
          protocolStartDate,
          stepIndex,
          stepDay: Number.isFinite(stepDay) ? stepDay : 0,
          stepName,
          status: "done",
          done: true,
          doneAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        ops++;
      }

      if (stepName.includes("تلقيح") || stepName.includes("TAI")) {
        batch.set(db.collection(animal._collection || "animals").doc(animal.id), {
          currentProtocol: null,
          protocolStatus: "completed",
          protocolExitDate: eventDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        ops++;
      }

      doneCount++;
      saved.push({
        animalNumber,
        eventId: stepEventId
      });
    }

    if (ops > 0) {
      await batch.commit();
    }

    if (doneCount && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "ovsynch_confirm_step");
    }

    return res.json({
      ok: true,
      message: doneCount
  ? `✅ تم تأكيد تنفيذ الخطوة لـ ${doneCount} حيوان.`
  : "❌ لم يتم تأكيد أي خطوة.",
      doneCount,
      rejectedCount: rejected.length,
      saved,
      rejected
    });

  } catch (e) {
    console.error("ovsynch-confirm-step", e);

    return res.status(500).json({
      ok: false,
      message: "❌ تعذّر تأكيد خطوة بروتوكول التزامن الآن.",
      doneCount: 0,
      rejectedCount: 0,
      saved: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: VACCINATION GATE ONLY
//                 تحقق التحصين من السيرفر فقط — فردي/جماعي — بدون حفظ
// ============================================================

function vaccinationParseNumbersSrv(raw) {
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const txt = String(raw || "").trim();
    if (!txt) return [];
    arr = txt.split(/\n|,|;|،|\s+/g);
  }

  return [...new Set(
    arr
      .map(x => calvingNormDigitsOnlySrv(x))
      .filter(Boolean)
  )];
}

async function vaccinationHasSameDaySrv(uid, animalNumber, eventDate, vaccine) {
  const num = calvingNormDigitsOnlySrv(animalNumber);
  const dt = String(eventDate || "").trim().slice(0, 10);
  const vx = String(vaccine || "").trim();

  if (!db || !uid || !num || !dt || !vx) return false;

  const snap = await db.collection("events")
    .where("userId", "==", uid)
    .where("animalNumber", "==", num)
    .limit(80)
    .get();

  let found = false;

  snap.forEach(ds => {
    const ev = ds.data() || {};

    const t = String(ev.eventType || ev.type || ev.eventTypeNorm || "").trim();
    const ed = String(ev.eventDate || ev.date || "").trim().slice(0, 10);
    const v = String(ev.vaccine || ev.vaccineName || "").trim();

    const isVaccination =
      t === "تحصين" ||
      t === "vaccination" ||
      t.includes("تحصين") ||
      t.includes("vaccination");

    if (isVaccination && ed === dt && v === vx) {
      found = true;
    }
  });

  return found;
}

app.post("/api/vaccination/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        stage: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.selectedNumbers ||
      body.groupNumbers ||
      body.animals ||
      body.animalNumber ||
      body.number ||
      "";

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const vaccine = String(
      body.vaccine ||
      body.vaccineName ||
      ""
    ).trim();

    const numbers = vaccinationParseNumbersSrv(rawNumbers);

    if (!numbers.length || !eventDate || !vaccine) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_basic",
        message: "أدخل رقم الحيوان والتاريخ ونوع التحصين لبدء التحقق.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: "❌ تاريخ التحصين غير صالح.",
        acceptedCount: 0,
        rejectedCount: numbers.length,
        accepted: [],
        rejected: numbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ التحصين غير صالح."
        }))
      });
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};
      const status = String(doc.status || "active").trim().toLowerCase();

      if (status === "inactive" || status === "archived") {
        rejected.push({
          animalNumber,
          reason: "❌ لا يمكن تسجيل تحصين — الحيوان غير موجود بالقطيع."
        });
        continue;
      }

      const duplicated = await vaccinationHasSameDaySrv(
        uid,
        animalNumber,
        eventDate,
        vaccine
      );

      if (duplicated) {
        rejected.push({
          animalNumber,
          reason: "🚫 تم تسجيل نفس التحصين لهذا الحيوان في نفس اليوم."
        });
        continue;
      }

      accepted.push({
        animalNumber,
        animalId: animal.id || "",
        species: doc.species || doc.animalTypeAr || doc.animalType || "",
        status
      });
    }

const firstReason = rejected[0]?.reason || "";

return res.json({
  ok: true,
  allowed: accepted.length > 0,
  stage: "vaccination_gate",
  message: accepted.length
    ? `✅ تم التحقق — جاهز لتسجيل التحصين لعدد ${accepted.length}.`
    : (firstReason || "❌ لا يوجد أي رقم صالح لتسجيل التحصين."),
  acceptedCount: accepted.length,
  rejectedCount: rejected.length,
  accepted,
  rejected
});

  } catch (e) {
    console.error("vaccination-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      stage: "vaccination_gate_failed",
      message: "تعذّر التحقق من التحصين الآن — تحقّق من الاتصال والصلاحيات.",
      acceptedCount: 0,
      rejectedCount: 0,
      accepted: [],
      rejected: []
    });
  }
});
// ============================================================
//                 VACCINATION TASKS ENGINE ONLY
//                 مولّد متابعة التحصين من السيرفر — بدون Route وبدون حفظ حدث
// ============================================================

function vaccinationYmdAddDaysSrv(ymd, days) {
  const s = String(ymd || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";

  const d = new Date(s + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";

  d.setDate(d.getDate() + Number(days || 0));
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());

  return d.toISOString().slice(0, 10);
}

function vaccinationMakeTaskSrv(vaccineKey, dueDate, meta = {}) {
  const dd = String(dueDate || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dd)) return null;

  return {
    taskType: "vaccination",
    vaccineKey: String(vaccineKey || "").trim(),
    dueDate: dd,
    windowStart: dd,
    windowEnd: vaccinationYmdAddDaysSrv(dd, 6),
    status: "pending",
    done: false,
    ...meta
  };
}

function vaccinationTasksFromEventSrv({ vaccine, doseType, eventDate, campaignId } = {}) {
  const v = String(vaccine || "").trim();

  const rawDose = String(doseType || "").trim();
  const normalizedDose =
    rawDose === "prime" ? "primary" :
    rawDose === "periodic" ? "booster" :
    rawDose;

  const dt = String(eventDate || "").trim().slice(0, 10);

  if (!v || !normalizedDose || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    return [];
  }

  const meta = campaignId ? { campaignId } : {};

  // جرعة تأسيس لأول مرة → Booster بعد 21 يوم فقط
  if (normalizedDose === "primary") {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, 21), {
        ...meta,
        doseType: "booster",
        basedOn: "primary+21"
      })
    ].filter(Boolean);
  }

  const SIX_MONTHS = 182;
  const ONE_YEAR = 365;

  // الحمى القلاعية — كل 6 شهور
  if (v.includes("FMD") || v.includes("الحمى القلاعية")) {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, SIX_MONTHS), {
        ...meta,
        doseType: "booster",
        cycle: "6m"
      })
    ].filter(Boolean);
  }

  // الباستريلا / HS — كل 6 شهور
  if (v.includes("Pasteurella") || v.includes("الباستريلا") || v.includes("HS")) {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, SIX_MONTHS), {
        ...meta,
        doseType: "booster",
        cycle: "6m"
      })
    ].filter(Boolean);
  }

  // التسمم المعوي / Clostridial — كل 6 شهور
  if (v.includes("Clostridial") || v.includes("التسمم المعوي")) {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, SIX_MONTHS), {
        ...meta,
        doseType: "booster",
        cycle: "6m"
      })
    ].filter(Boolean);
  }

  // الجلد العقدي — سنوي
  if (v.includes("LSD") || v.includes("الجلد العقدي")) {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, ONE_YEAR), {
        ...meta,
        doseType: "booster",
        cycle: "1y"
      })
    ].filter(Boolean);
  }

  // IBR / BVD / تنفسي — سنوي
  if (v === "IBR" || v === "BVD" || v.includes("تنفسي")) {
    return [
      vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, ONE_YEAR), {
        ...meta,
        doseType: "booster",
        cycle: "1y"
      })
    ].filter(Boolean);
  }

  // بروسيلا — مرة واحدة، لا متابعة لاحقة
  if (v.includes("Brucella") || v.includes("البروسيلا")) {
    return [];
  }

  // الافتراضي — سنوي
  return [
    vaccinationMakeTaskSrv(v, vaccinationYmdAddDaysSrv(dt, ONE_YEAR), {
      ...meta,
      doseType: "booster",
      cycle: "1y"
    })
  ].filter(Boolean);
}

async function vaccinationUpsertTasksForEventSrv({
  uid,
  animalNumber,
  eventDate,
  vaccine,
  doseType,
  campaignId,
  eventId
} = {}) {
  const num = calvingNormDigitsOnlySrv(animalNumber);
  const dt = String(eventDate || "").trim().slice(0, 10);
  const vx = String(vaccine || "").trim();

  if (!db || !uid || !num || !dt || !vx) return [];

  const tasks = vaccinationTasksFromEventSrv({
    vaccine: vx,
    doseType,
    eventDate: dt,
    campaignId
  });

  if (!tasks.length) return [];

  const written = [];

  for (const t of tasks) {
    const dueDate = String(t.dueDate || "").trim().slice(0, 10);
    if (!dueDate) continue;

    const keySafe = String(t.vaccineKey || vx).replace(/\s+/g, "_");
    const doseSafe = String(t.doseType || doseType || "").replace(/\s+/g, "_");

    const taskId = `vax__${num}__${keySafe}__${dueDate}__${doseSafe}`;
    const ref = db.collection("tasks").doc(taskId);

    const payload = {
      userId: uid,
      animalNumber: num,

      type: "task",
      taskType: "vaccination",

      vaccineKey: String(t.vaccineKey || vx),
      vaccine: vx,

      dueDate,
      windowStart: String(t.windowStart || dueDate).slice(0, 10),
      windowEnd: String(t.windowEnd || dueDate).slice(0, 10),

      doseType: String(t.doseType || doseType || ""),
      campaignId: campaignId || t.campaignId || "",
      basedOn: t.basedOn || "",
      cycle: t.cycle || "",

      status: "pending",
      done: false,

      sourceEventId: eventId || "",
      source: "server:/api/vaccination/save",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const snap = await ref.get();

    if (!snap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.set(payload, { merge: true });

    written.push({
      taskId,
      dueDate,
      vaccineKey: payload.vaccineKey,
      doseType: payload.doseType,
      cycle: payload.cycle
    });
  }

  return written;
}
// ============================================================
//                 API: VACCINATION SAVE ONLY
//                 حفظ التحصين من السيرفر فقط — فردي/جماعي + Tasks
// ============================================================

function vaccinationSaveRowsFromBodySrv(body = {}) {
  if (Array.isArray(body.accepted) && body.accepted.length) return body.accepted;
  if (Array.isArray(body.rows) && body.rows.length) return body.rows;

  const rawNumbers =
    body.animalNumbers ||
    body.numbers ||
    body.selectedNumbers ||
    body.groupNumbers ||
    body.animals ||
    body.animalNumber ||
    body.number ||
    "";

  return vaccinationParseNumbersSrv(rawNumbers).map(n => ({
    animalNumber: n,
    animalId: ""
  }));
}

function vaccinationRequiredSrv(v) {
  return !(v === undefined || v === null || String(v).trim() === "");
}

app.post("/api/vaccination/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "تعذّر حفظ التحصين — قاعدة البيانات غير متاحة.",
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const vaccine = String(
      body.vaccine ||
      body.vaccineName ||
      ""
    ).trim();

    const doseType = String(body.doseType || "").trim();
    const notes = String(body.notes || "").trim();
    const campaignId = String(body.campaignId || "").trim();

    const rows = vaccinationSaveRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان مطلوب.",
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التحصين غير صالح.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r.animalNumber || ""),
          reason: "تاريخ التحصين غير صالح."
        }))
      });
    }

    if (!vaccinationRequiredSrv(vaccine)) {
      return res.status(400).json({
        ok: false,
        message: "❌ نوع التحصين مطلوب.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r.animalNumber || ""),
          reason: "نوع التحصين مطلوب."
        }))
      });
    }

    if (!vaccinationRequiredSrv(doseType)) {
      return res.status(400).json({
        ok: false,
        message: "❌ نوع الجرعة مطلوب.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r.animalNumber || ""),
          reason: "نوع الجرعة مطلوب."
        }))
      });
    }

    const saved = [];
    const rejected = [];

    for (const row of rows) {
      const animalNumber = calvingNormDigitsOnlySrv(row.animalNumber || row.number || "");

      if (!animalNumber) {
        rejected.push({
          animalNumber: "",
          reason: "رقم غير صالح."
        });
        continue;
      }

      let animalId = String(row.animalId || "").trim();
      let animalDoc = null;

      if (animalId) {
        const snap = await db.collection("animals").doc(animalId).get();
        if (snap.exists) {
          animalDoc = snap.data() || {};
        }
      }

      if (!animalDoc) {
        const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);
        if (!animal) {
          rejected.push({
            animalNumber,
            reason: "الحيوان غير موجود في حسابك."
          });
          continue;
        }

        animalId = animal.id || "";
        animalDoc = animal.data || {};
      }

      const status = String(animalDoc.status || "active").trim().toLowerCase();

      if (status === "inactive" || status === "archived") {
        rejected.push({
          animalNumber,
          reason: "❌ لا يمكن تسجيل تحصين — الحيوان غير موجود بالقطيع."
        });
        continue;
      }

      const duplicated = await vaccinationHasSameDaySrv(
        uid,
        animalNumber,
        eventDate,
        vaccine
      );

      if (duplicated) {
        rejected.push({
          animalNumber,
          reason: "🚫 تم تسجيل نفس التحصين لهذا الحيوان في نفس اليوم."
        });
        continue;
      }

const payload = {
  userId: uid,

  animalId,
  animalNumber,

  createdAt: admin.firestore.FieldValue.serverTimestamp(),

  date: eventDate,
  doseType,
  eventDate,

  eventType: "تحصين",
  source: "server:/api/vaccination/save",
  type: "vaccination",
  vaccine
};

if (notes) {
  payload.notes = notes;
}

if (campaignId) {
  payload.campaignId = campaignId;
}

const vaccineKeyForDoc = String(vaccine || "")
  .trim()
  .replace(/[^\p{L}\p{N}]+/gu, "_")
  .replace(/^_+|_+$/g, "");

const vaccinationEventId = [
  "vaccination",
  uid,
  animalNumber,
  eventDate,
  vaccineKeyForDoc || "vaccine"
].join("__");

const eventRef = db.collection("events").doc(vaccinationEventId);

const existingEventSnap = await eventRef.get();

if (existingEventSnap.exists) {
  rejected.push({
    animalNumber,
    reason: "🚫 تم تسجيل نفس التحصين لهذا الحيوان في نفس اليوم."
  });
  continue;
}

await eventRef.set(payload);
      if (animalId) {
        await db.collection("animals").doc(animalId).set({
          lastVaccinationDate: eventDate,
          lastVaccine: vaccine,
          lastVaccinationDoseType: doseType,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      const tasks = await vaccinationUpsertTasksForEventSrv({
        uid,
        animalNumber,
        eventDate,
        vaccine,
        doseType,
        campaignId,
        eventId: eventRef.id
      });

      saved.push({
        animalNumber,
        animalId,
        eventId: eventRef.id,
        eventDate,
        vaccine,
        doseType,
        tasksCount: tasks.length,
        tasks
      });
    }

    return res.json({
      ok: saved.length > 0,
      message: saved.length
        ? `✅ تم حفظ التحصين بنجاح لعدد ${saved.length}.`
        : "❌ لم يتم حفظ أي تحصين.",
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected,
      redirectUrl: saved.length === 1
        ? `/event-list.html?number=${encodeURIComponent(saved[0].animalNumber)}`
        : ""
    });

  } catch (e) {
    console.error("vaccination-save", e);

    return res.status(500).json({
      ok: false,
      message: "تعذّر حفظ التحصين — تحقّق من الاتصال والصلاحيات.",
      savedCount: 0,
      rejectedCount: 0,
      saved: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: DAILY MILK HELPERS
//                 السيرفر يجهز القرار + العرض بالكامل
// ============================================================

function dailyMilkParseNumbersSrv(raw) {
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const txt = String(raw || "").trim();
    if (!txt) return [];
    arr = txt.split(/\n|,|;|،|\s+/g);
  }

  return [...new Set(
    arr
      .map(x => calvingNormDigitsOnlySrv(x))
      .filter(Boolean)
  )];
}

function dailyMilkSpeciesSrv(doc = {}) {
  const raw = String(
    doc.species ||
    doc.animalTypeAr ||
    doc.animalType ||
    doc.type ||
    ""
  ).trim();

  if (/buffalo|جاموس/i.test(raw)) return "جاموس";
  if (/cow|بقر|أبقار/i.test(raw)) return "أبقار";

  return raw || "أبقار";
}

function dailyMilkKindSrv(species) {
  return String(species || "").trim() === "جاموس" ? "buffalo" : "cow";
}

function dailyMilkIsOutOfHerdSrv(doc = {}) {
  const st = String(doc.status || "active").trim().toLowerCase();
  return st === "inactive" || st === "archived";
}

function dailyMilkNumStrictSrv(v) {
  if (v === undefined || v === null || String(v).trim() === "") return 0;

  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function dailyMilkRowsFromBodySrv(body = {}) {
  if (Array.isArray(body.rows) && body.rows.length) return body.rows;
  if (Array.isArray(body.items) && body.items.length) return body.items;

  const rawNumbers =
    body.animalNumbers ||
    body.numbers ||
    body.selectedNumbers ||
    body.groupNumbers ||
    body.animals ||
    body.animalNumber ||
    body.number ||
    "";

  const nums = dailyMilkParseNumbersSrv(rawNumbers);

  return nums.map(n => ({
    animalNumber: n,
    animalId: "",
    milkS1: body.milkS1 ?? body.s1 ?? body.session1,
    milkS2: body.milkS2 ?? body.s2 ?? body.session2,
    milkS3: body.milkS3 ?? body.s3 ?? body.session3
  }));
}

async function dailyMilkHasSameDaySrv(uid, animalNumber, eventDate) {
  const num = calvingNormDigitsOnlySrv(animalNumber);
  const dt = String(eventDate || "").trim().slice(0, 10);

  if (!db || !uid || !num || !calvingIsDateSrv(dt)) return false;

  const fixedId = ["daily_milk", uid, num, dt].join("__");
  const fixedSnap = await db.collection("events").doc(fixedId).get();
  if (fixedSnap.exists) return true;

  const snap = await db.collection("events")
    .where("userId", "==", uid)
    .where("animalNumber", "==", num)
    .limit(120)
    .get();

  let found = false;

  snap.forEach(docSnap => {
    const ev = docSnap.data() || {};
    const d = String(ev.eventDate || ev.date || "").trim().slice(0, 10);

    const t = String(
      ev.eventTypeNorm ||
      ev.type ||
      ev.eventType ||
      ""
    ).trim().toLowerCase();

    const isDailyMilk =
      t === "daily_milk" ||
      t === "لبن يومي" ||
      t.includes("daily_milk");

    if (isDailyMilk && d === dt) {
      found = true;
    }
  });

  return found;
}

function dailyMilkSessionSpecSrv(kind) {
  if (kind === "buffalo") {
    return {
      sessionCount: 2,
      showThirdMilking: false,
      sessionLabels: ["حلبة صباح (كجم)", "حلبة مساء (كجم)"],
      inputs: [
        { key: "milkS1", label: "حلبة صباح (كجم)", visible: true, disabled: false },
        { key: "milkS2", label: "حلبة مساء (كجم)", visible: true, disabled: false },
        { key: "milkS3", label: "حلبة 3 (كجم)", visible: false, disabled: true }
      ]
    };
  }

  return {
    sessionCount: 3,
    showThirdMilking: true,
    sessionLabels: ["حلبة 1 (كجم)", "حلبة 2 (كجم)", "حلبة 3 (كجم)"],
    inputs: [
      { key: "milkS1", label: "حلبة 1 (كجم)", visible: true, disabled: false },
      { key: "milkS2", label: "حلبة 2 (كجم)", visible: true, disabled: false },
      { key: "milkS3", label: "حلبة 3 (كجم)", visible: true, disabled: false }
    ]
  };
}

function dailyMilkRejectedUiRowSrv(animalNumber, reason) {
  return {
    animalNumber: calvingNormDigitsOnlySrv(animalNumber || ""),
    number: calvingNormDigitsOnlySrv(animalNumber || ""),
    eligible: false,
    canEdit: false,
    canSave: false,
    reason: String(reason || "مرفوض"),
    species: "",
    speciesLabel: "مرفوض",
    kind: "",
    sessionCount: 0,
    showThirdMilking: false,
    sessionLabels: [],
    inputs: [
      { key: "milkS1", label: "حلبة 1", visible: true, disabled: true },
      { key: "milkS2", label: "حلبة 2", visible: true, disabled: true },
      { key: "milkS3", label: "حلبة 3", visible: true, disabled: true }
    ]
  };
}

function dailyMilkAcceptedUiRowSrv(item = {}) {
  const species = String(item.species || "").trim() || "أبقار";
  const kind = String(item.kind || dailyMilkKindSrv(species)).trim();
  const spec = dailyMilkSessionSpecSrv(kind);

  return {
    animalNumber: calvingNormDigitsOnlySrv(item.animalNumber || item.number || ""),
    number: calvingNormDigitsOnlySrv(item.animalNumber || item.number || ""),
    animalId: String(item.animalId || "").trim(),
    eligible: true,
    canEdit: true,
    canSave: true,
    reason: "",
    species,
    speciesLabel: species,
    kind,
    sessionCount: spec.sessionCount,
    showThirdMilking: spec.showThirdMilking,
    sessionLabels: spec.sessionLabels,
    inputs: spec.inputs
  };
}

function dailyMilkBuildGateUiSrv({ accepted = [], rejected = [], message = "", eventDate = "" } = {}) {
  const acceptedRows = accepted.map(dailyMilkAcceptedUiRowSrv);
  const rejectedRows = rejected.map(r => dailyMilkRejectedUiRowSrv(r.animalNumber || r.number, r.reason));

  const rows = [...acceptedRows, ...rejectedRows];
  const first = acceptedRows[0] || null;
  const canSave = acceptedRows.length > 0;

  return {
    screen: "daily_milk",
    mode: rows.length > 1 ? "bulk" : "single",
    eventDate: String(eventDate || "").slice(0, 10),
    status: canSave ? "success" : "error",
    message: message || (canSave ? "✅ تم التحقق — أكمل إدخال اللبن." : "❌ لا يوجد رقم مؤهل لتسجيل اللبن."),
    canSave,
    acceptedCount: acceptedRows.length,
    rejectedCount: rejectedRows.length,
    rows,

    single: first ? {
      animalNumber: first.animalNumber,
      animalId: first.animalId,
      species: first.species,
      speciesLabel: first.speciesLabel,
      kind: first.kind,
      sessionCount: first.sessionCount,
      showThirdMilking: first.showThirdMilking,
      sessionLabels: first.sessionLabels,
      inputs: first.inputs
    } : null,

    bulk: {
      rows,
      columns: [
        { key: "animalNumber", label: "رقم الحيوان", visible: true },
        { key: "speciesLabel", label: "النوع", visible: true },
        { key: "milkS1", label: "حلبة 1", visible: true },
        { key: "milkS2", label: "حلبة 2", visible: true },
        { key: "milkS3", label: "حلبة 3", visible: true },
        { key: "total", label: "الإجمالي", visible: true }
      ]
    }
  };
}

function dailyMilkBuildSaveUiSrv({ saved = [], rejected = [], message = "", eventDate = "" } = {}) {
  const savedCount = saved.length;
  const rejectedCount = rejected.length;
  const first = saved[0] || null;

  const redirectUrl = savedCount === 1
    ? `/event-list.html?number=${encodeURIComponent(first.animalNumber)}`
    : "/dashboard.html";

  return {
    screen: "daily_milk",
    status: savedCount ? "success" : "error",
    message: message || (savedCount ? "✅ تم حفظ اللبن اليومي بنجاح" : "❌ لم يتم حفظ أي سجل لبن."),
    savedCount,
    rejectedCount,
    canRedirect: savedCount > 0,
    redirectUrl,
    saved: saved.map(x => ({
      animalNumber: x.animalNumber,
      animalId: x.animalId,
      eventId: x.eventId,
      eventDate: x.eventDate,
      milkKg: x.milkKg
    })),
    rejected: rejected.map(x => ({
      animalNumber: x.animalNumber || "",
      reason: x.reason || "تعذّر الحفظ"
    })),
    eventDate: String(eventDate || "").slice(0, 10)
  };
}
function dailyMilkFormatTotalSrv(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function dailyMilkPreviewRowSrv(row = {}, kind = "cow") {
  const s1 = dailyMilkNumStrictSrv(row.milkS1 ?? row.s1 ?? row.session1);
  const s2 = dailyMilkNumStrictSrv(row.milkS2 ?? row.s2 ?? row.session2);
  const s3 = dailyMilkNumStrictSrv(row.milkS3 ?? row.s3 ?? row.session3);

  if (![s1, s2, s3].every(Number.isFinite)) {
    return {
      ok: false,
      milkKg: null,
      totalText: "—",
      reason: "كمية اللبن غير صالحة."
    };
  }

  if (s1 < 0 || s2 < 0 || s3 < 0) {
    return {
      ok: false,
      milkKg: null,
      totalText: "—",
      reason: "كمية اللبن لا يمكن أن تكون سالبة."
    };
  }

  const milkKg = kind === "buffalo"
    ? Number((s1 + s2).toFixed(1))
    : Number((s1 + s2 + s3).toFixed(1));

  return {
    ok: true,
    milkKg,
    totalText: dailyMilkFormatTotalSrv(milkKg),
    reason: ""
  };
}

function dailyMilkBuildPreviewUiSrv({ rows = [], message = "" } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];

  return {
    screen: "daily_milk",
    mode: safeRows.length > 1 ? "bulk" : "single",
    status: "info",
    message: message || "",
    rows: safeRows,
    single: safeRows[0] || null
  };
}
// ============================================================
//                 API: DAILY MILK GATE ONLY
//                 السيرفر يجهز أهلية + UI كامل
// ============================================================

app.post("/api/daily-milk/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      const ui = dailyMilkBuildGateUiSrv({
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة."
      });

      return res.status(503).json({
        ok: false,
        allowed: false,
        stage: "firestore_disabled",
        message: ui.message,
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        valid: [],
        rejected: [],
        ui
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.selectedNumbers ||
      body.groupNumbers ||
      body.animals ||
      body.animalNumber ||
      body.number ||
      "";

    const numbers = dailyMilkParseNumbersSrv(rawNumbers);

    if (!numbers.length || !eventDate) {
      const ui = dailyMilkBuildGateUiSrv({
        message: "أدخل رقم الحيوان والتاريخ لبدء التحقق.",
        eventDate
      });

      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_basic",
        message: ui.message,
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        valid: [],
        rejected: [],
        ui
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      const rejected = numbers.map(n => ({
        animalNumber: String(n || ""),
        reason: "تاريخ اللبن غير صالح."
      }));

      const ui = dailyMilkBuildGateUiSrv({
        rejected,
        message: "❌ تاريخ اللبن غير صالح.",
        eventDate
      });

      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: ui.message,
        acceptedCount: 0,
        rejectedCount: rejected.length,
        accepted: [],
        valid: [],
        rejected,
        ui
      });
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};

      if (dailyMilkIsOutOfHerdSrv(doc)) {
        rejected.push({
          animalNumber,
          reason: "❌ لا يمكن تسجيل لبن — الحيوان غير موجود بالقطيع."
        });
        continue;
      }

      const duplicated = await dailyMilkHasSameDaySrv(uid, animalNumber, eventDate);

      if (duplicated) {
        rejected.push({
          animalNumber,
          reason: "❌ تم تسجيل لبن اليوم لهذا الحيوان بالفعل."
        });
        continue;
      }

      const species = dailyMilkSpeciesSrv(doc);
      const kind = dailyMilkKindSrv(species);

      accepted.push({
        animalNumber,
        number: animalNumber,
        animalId: animal.id || "",
        species,
        kind
      });
    }

    const acceptedCount = accepted.length;
    const rejectedCount = rejected.length;
    const allowed = acceptedCount > 0;

    const message = allowed
      ? `✅ تم التحقق — جاهز لتسجيل اللبن لعدد ${acceptedCount}.`
      : (rejected[0]?.reason || "❌ لا يوجد أي رقم صالح لتسجيل اللبن.");

    const ui = dailyMilkBuildGateUiSrv({
      accepted,
      rejected,
      message,
      eventDate
    });

    return res.json({
      ok: true,
      allowed,
      stage: "daily_milk_gate",
      message,
      acceptedCount,
      rejectedCount,
      accepted,
      valid: accepted,
      rejected,

      animalNumber: accepted[0]?.animalNumber || "",
      animalId: accepted[0]?.animalId || "",
      species: accepted[0]?.species || "",
      kind: accepted[0]?.kind || "",

      ui
    });

  } catch (e) {
    console.error("daily-milk-gate", e);

    const ui = dailyMilkBuildGateUiSrv({
      message: "تعذّر التحقق من اللبن اليومي الآن — تحقّق من الاتصال والصلاحيات."
    });

    return res.status(500).json({
      ok: false,
      allowed: false,
      stage: "daily_milk_gate_failed",
      message: ui.message,
      acceptedCount: 0,
      rejectedCount: 0,
      accepted: [],
      valid: [],
      rejected: [],
      ui
    });
  }
});
// ============================================================
//                 API: DAILY MILK PREVIEW ONLY
//                 حساب إجمالي اللبن من السيرفر — بدون حفظ
// ============================================================

app.post("/api/daily-milk/preview", requireUserId, async (req, res) => {
  try {
    if (!db) {
      const ui = dailyMilkBuildPreviewUiSrv({
        message: "تعذّر حساب الإجمالي الآن — قاعدة البيانات غير متاحة.",
        rows: []
      });

      return res.status(503).json({
        ok: false,
        message: ui.message,
        ui
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const rows = dailyMilkRowsFromBodySrv(body);

    if (!rows.length) {
      const ui = dailyMilkBuildPreviewUiSrv({
        message: "",
        rows: []
      });

      return res.json({
        ok: true,
        message: "",
        ui
      });
    }

    const outRows = [];

    for (const row of rows) {
      const animalNumber = calvingNormDigitsOnlySrv(row.animalNumber || row.number || "");

      if (!animalNumber) {
        outRows.push({
          animalNumber: "",
          milkKg: null,
          totalText: "—",
          ok: false,
          reason: "رقم الحيوان مطلوب."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        outRows.push({
          animalNumber,
          milkKg: null,
          totalText: "—",
          ok: false,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const animalDoc = animal.data || {};
      const species = dailyMilkSpeciesSrv(animalDoc);
      const kind = dailyMilkKindSrv(species);

      const preview = dailyMilkPreviewRowSrv(row, kind);

      outRows.push({
        animalNumber,
        animalId: animal.id || "",
        species,
        kind,
        milkKg: preview.milkKg,
        totalText: preview.totalText,
        ok: preview.ok,
        reason: preview.reason || ""
      });
    }

    const ui = dailyMilkBuildPreviewUiSrv({
      rows: outRows,
      message: ""
    });

    return res.json({
      ok: true,
      message: "",
      rows: outRows,
      ui
    });

  } catch (e) {
    console.error("daily-milk-preview", e);

    const ui = dailyMilkBuildPreviewUiSrv({
      message: "تعذّر حساب إجمالي اللبن الآن.",
      rows: []
    });

    return res.status(500).json({
      ok: false,
      message: ui.message,
      ui
    });
  }
});
// ============================================================
//                 API: DAILY MILK IMPORT HELPERS
//                 الصفحة ترفع/ترسل فقط — السيرفر يقرأ ويعاين ويحفظ
// ============================================================

const dailyMilkImportRawParserSrv = express.raw({
  type: (req) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    return (
      ct.includes("multipart/form-data") ||
      ct.includes("text/plain") ||
      ct.includes("text/csv") ||
      ct.includes("application/octet-stream")
    );
  },
  limit: "15mb"
});

function dailyMilkImportLatinDigitsSrv(v) {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };

  return String(v ?? "").replace(/[٠-٩۰-۹]/g, d => map[d] || d);
}

function dailyMilkImportNormAnimalSrv(v) {
  return dailyMilkImportLatinDigitsSrv(v)
    .replace(/[^\d]/g, "")
    .trim();
}

function dailyMilkImportNumSrv(v) {
  const s = dailyMilkImportLatinDigitsSrv(v)
    .trim()
    .replace(",", ".");

  if (!s) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function dailyMilkImportParseMultipartSrv(req) {
  const ct = String(req.headers["content-type"] || "");
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = m ? (m[1] || m[2] || "").trim() : "";

  const out = {
    fields: {},
    file: null
  };

  if (!boundary || !Buffer.isBuffer(req.body)) return out;

  const raw = req.body.toString("binary");
  const parts = raw.split("--" + boundary);

  for (const part of parts) {
    const p = String(part || "");
    const cut = p.indexOf("\r\n\r\n");
    if (cut < 0) continue;

    const head = p.slice(0, cut);
    let body = p.slice(cut + 4);

    body = body.replace(/\r\n$/, "");
    body = body.replace(/--$/, "");

    const nameM = head.match(/name="([^"]+)"/i);
    const fileM = head.match(/filename="([^"]*)"/i);
    const typeM = head.match(/content-type:\s*([^\r\n]+)/i);

    const name = nameM ? nameM[1] : "";
    if (!name) continue;

    const buf = Buffer.from(body, "binary");

    if (fileM && fileM[1]) {
      out.file = {
        fieldname: name,
        originalname: fileM[1],
        mimetype: typeM ? typeM[1].trim() : "",
        buffer: buf
      };
    } else {
      out.fields[name] = buf.toString("utf8").trim();
    }
  }

  return out;
}

function dailyMilkImportNormalizeHeaderSrv(v) {
  return dailyMilkImportLatinDigitsSrv(v)
    .trim()
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[\/_-]+/g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/[ة]/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

function dailyMilkImportSplitLineSrv(line) {
  const raw = dailyMilkImportLatinDigitsSrv(String(line || "").trim());
  if (!raw) return [];

  if (raw.includes("\t")) return raw.split("\t").map(x => x.trim());
  if (raw.includes(";")) return raw.split(";").map(x => x.trim());

  return raw
    .replace(/[،]+/g, ",")
    .split(",")
    .map(x => x.trim());
}

function dailyMilkImportLooksLikeHeaderSrv(line) {
  const s = dailyMilkImportNormalizeHeaderSrv(line);
  if (!s) return false;

  return [
    "رقم الحيوان",
    "رقم",
    "الحيوان",
    "animal",
    "animal number",
    "animal no",
    "animal id",
    "cow id",
    "tag",
    "ear tag",
    "اجمالي",
    "اجمالي اللبن",
    "total",
    "total milk",
    "milk total",
    "yield",
    "حلبه 1",
    "حلبة 1",
    "session 1",
    "milking 1",
    "morning",
    "حلبه 2",
    "حلبة 2",
    "session 2",
    "milking 2",
    "evening",
    "حلبه 3",
    "حلبة 3",
    "session 3",
    "milking 3",
    "night"
  ].some(x => s.includes(x));
}

function dailyMilkImportDetectColumnsSrv(parts = []) {
  const cols = parts.map(dailyMilkImportNormalizeHeaderSrv);

  const out = {
    animalIdx: -1,
    totalIdx: -1,
    s1Idx: -1,
    s2Idx: -1,
    s3Idx: -1
  };

  function has(cell, arr) {
    return arr.some(x => cell === x || cell.includes(x));
  }

  cols.forEach((c, i) => {
    if (out.animalIdx < 0 && has(c, ["رقم الحيوان", "الحيوان", "animal number", "animal no", "animal id", "cow id", "tag", "ear tag", "animal"])) {
      out.animalIdx = i;
      return;
    }

    if (out.s1Idx < 0 && has(c, ["حلبه 1", "حلبة 1", "session 1", "milking 1", "morning", "milk 1"])) {
      out.s1Idx = i;
      return;
    }

    if (out.s2Idx < 0 && has(c, ["حلبه 2", "حلبة 2", "session 2", "milking 2", "evening", "milk 2"])) {
      out.s2Idx = i;
      return;
    }

    if (out.s3Idx < 0 && has(c, ["حلبه 3", "حلبة 3", "session 3", "milking 3", "night", "milk 3"])) {
      out.s3Idx = i;
      return;
    }

    if (out.totalIdx < 0 && has(c, ["اجمالي", "اجمالي اللبن", "total", "total milk", "milk total", "yield", "daily milk", "production"])) {
      out.totalIdx = i;
    }
  });

  return out;
}

function dailyMilkImportReadExcelSrv(file) {
  let XLSX_NODE = null;

  try {
    XLSX_NODE = require("xlsx");
  } catch (_) {
    const err = new Error("تعذّر قراءة ملف Excel على السيرفر.");
    err.code = "XLSX_UNAVAILABLE";
    throw err;
  }

  const workbook = XLSX_NODE.read(file.buffer, { type: "buffer" });
  const names = workbook.SheetNames || [];
  if (!names.length) return "";

  let bestRows = [];
  let bestScore = -1;

  for (const name of names) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;

    const rows = XLSX_NODE.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false
    });

    let score = 0;

    rows.slice(0, 50).forEach(r => {
      const line = (Array.isArray(r) ? r : []).join(",");
      if (dailyMilkImportLooksLikeHeaderSrv(line)) score += 30;

      const n = dailyMilkImportNormAnimalSrv(r?.[0]);
      const nums = (Array.isArray(r) ? r.slice(1) : [])
        .map(dailyMilkImportNumSrv)
        .filter(x => Number.isFinite(x));

      if (n) score += 2;
      score += nums.length;
    });

    if (score > bestScore) {
      bestScore = score;
      bestRows = rows;
    }
  }

  return bestRows
    .map(r => (Array.isArray(r) ? r : []).map(x => String(x ?? "").trim()).join(","))
    .filter(Boolean)
    .join("\n");
}

function dailyMilkImportTextFromReqSrv(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  if (ct.includes("multipart/form-data")) {
    const mp = dailyMilkImportParseMultipartSrv(req);
    if (mp.file) {
      const name = String(mp.file.originalname || "").toLowerCase();
      const mime = String(mp.file.mimetype || "").toLowerCase();

      const isExcel =
        name.endsWith(".xlsx") ||
        name.endsWith(".xls") ||
        mime.includes("spreadsheet") ||
        mime.includes("excel");

      if (isExcel) return dailyMilkImportReadExcelSrv(mp.file);

      return mp.file.buffer.toString("utf8");
    }

    return String(mp.fields.rawText || mp.fields.text || mp.fields.data || "").trim();
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8").trim();
  }

  return String(req.body?.rawText || req.body?.text || req.body?.data || "").trim();
}

function dailyMilkImportRowsFromReqSrv(req) {
  if (!Buffer.isBuffer(req.body) && Array.isArray(req.body?.rows)) {
    return req.body.rows;
  }

  const rawText = dailyMilkImportTextFromReqSrv(req);
  return dailyMilkImportParseTextSrv(rawText);
}

function dailyMilkImportParseTextSrv(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const rows = [];
  let colMap = null;

  for (const line of lines) {
    const parts = dailyMilkImportSplitLineSrv(line);
    if (!parts.length) continue;

    if (!colMap && dailyMilkImportLooksLikeHeaderSrv(line)) {
      colMap = dailyMilkImportDetectColumnsSrv(parts);
      continue;
    }

    let animalNumber = "";
    let milkS1 = 0;
    let milkS2 = 0;
    let milkS3 = 0;
    let importMode = "sessions";

    if (colMap && colMap.animalIdx >= 0) {
      animalNumber = dailyMilkImportNormAnimalSrv(parts[colMap.animalIdx]);

      const total =
        colMap.totalIdx >= 0
          ? dailyMilkImportNumSrv(parts[colMap.totalIdx])
          : null;

      const s1 =
        colMap.s1Idx >= 0
          ? dailyMilkImportNumSrv(parts[colMap.s1Idx])
          : null;

      const s2 =
        colMap.s2Idx >= 0
          ? dailyMilkImportNumSrv(parts[colMap.s2Idx])
          : null;

      const s3 =
        colMap.s3Idx >= 0
          ? dailyMilkImportNumSrv(parts[colMap.s3Idx])
          : null;

      if (Number.isFinite(total) && !Number.isFinite(s1) && !Number.isFinite(s2) && !Number.isFinite(s3)) {
        milkS1 = total;
        milkS2 = 0;
        milkS3 = 0;
        importMode = "total_only";
      } else {
        milkS1 = Number.isFinite(s1) ? s1 : 0;
        milkS2 = Number.isFinite(s2) ? s2 : 0;
        milkS3 = Number.isFinite(s3) ? s3 : 0;
      }
    } else {
      animalNumber = dailyMilkImportNormAnimalSrv(parts[0]);

      const nums = parts
        .slice(1)
        .map(dailyMilkImportNumSrv)
        .filter(x => Number.isFinite(x));

      if (nums.length === 1) {
        milkS1 = nums[0];
        milkS2 = 0;
        milkS3 = 0;
        importMode = "total_only";
      } else {
        milkS1 = nums[0] ?? 0;
        milkS2 = nums[1] ?? 0;
        milkS3 = nums[2] ?? 0;
        importMode = nums.length >= 3 ? "sessions_3" : "sessions_2";
      }
    }

    if (!animalNumber) continue;

    rows.push({
      animalNumber,
      milkS1,
      milkS2,
      milkS3,
      importMode
    });
  }

  return rows;
}

function dailyMilkImportCalcSrv(row = {}, kind = "cow") {
  const s1 = dailyMilkNumStrictSrv(row.milkS1);
  const s2 = dailyMilkNumStrictSrv(row.milkS2);
  const s3 = dailyMilkNumStrictSrv(row.milkS3);

  if (![s1, s2, s3].every(Number.isFinite)) {
    return { ok: false, milkKg: 0, totalText: "—", reason: "كمية اللبن غير صالحة." };
  }

  if (s1 < 0 || s2 < 0 || s3 < 0) {
    return { ok: false, milkKg: 0, totalText: "—", reason: "كمية اللبن لا يمكن أن تكون سالبة." };
  }

  const importMode = String(row.importMode || "").trim();

  const milkKg =
    importMode === "total_only"
      ? Number(s1.toFixed(1))
      : (
          kind === "buffalo"
            ? Number((s1 + s2).toFixed(1))
            : Number((s1 + s2 + s3).toFixed(1))
        );

  if (!Number.isFinite(milkKg) || milkKg <= 0) {
    return { ok: false, milkKg: 0, totalText: "—", reason: "إجمالي اللبن صفر." };
  }

  return {
    ok: true,
    milkKg,
    totalText: dailyMilkFormatTotalSrv(milkKg),
    reason: ""
  };
}

function dailyMilkImportBuildUiSrv({ rows = [], message = "" } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const validRows = safeRows.filter(r => r.valid === true);
  const invalidRows = safeRows.filter(r => r.valid !== true);

  const totalMilk = validRows.reduce((s, r) => s + Number(r.milkKg || 0), 0);

  return {
    screen: "daily_milk_import",
    status: validRows.length ? "success" : "warning",
    message: message || (validRows.length ? "✅ تمت المعاينة — راجع الصفوف ثم احفظ." : "لا توجد صفوف صالحة للحفظ."),
    canSave: validRows.length > 0,
    rows: safeRows,
    kpi: {
      totalRows: safeRows.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      totalMilk: Number(totalMilk.toFixed(1))
    }
  };
}

async function dailyMilkImportPreviewRowsSrv(uid, eventDate, inputRows = []) {
  const rows = [];

  for (const rawRow of inputRows) {
    const animalNumber = calvingNormDigitsOnlySrv(rawRow.animalNumber || rawRow.number || "");

    if (!animalNumber) {
      rows.push({ ...rawRow, animalNumber: "", valid: false, reason: "رقم الحيوان غير صالح.", totalText: "—" });
      continue;
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      rows.push({ ...rawRow, animalNumber, valid: false, reason: "الحيوان غير موجود في حسابك.", totalText: "—" });
      continue;
    }

    const animalDoc = animal.data || {};

    if (dailyMilkIsOutOfHerdSrv(animalDoc)) {
      rows.push({ ...rawRow, animalNumber, valid: false, reason: "الحيوان غير موجود بالقطيع.", totalText: "—" });
      continue;
    }

    const duplicated = await dailyMilkHasSameDaySrv(uid, animalNumber, eventDate);

    if (duplicated) {
      rows.push({ ...rawRow, animalNumber, valid: false, reason: "تم تسجيل لبن اليوم لهذا الحيوان بالفعل.", totalText: "—" });
      continue;
    }

    const species = dailyMilkSpeciesSrv(animalDoc);
    const kind = dailyMilkKindSrv(species);
    const calc = dailyMilkImportCalcSrv(rawRow, kind);

    rows.push({
      ...rawRow,
      animalNumber,
      animalId: animal.id || "",
      species,
      kind,
      milkKg: calc.milkKg,
      totalText: calc.totalText,
      valid: calc.ok,
      reason: calc.reason || "",
      eventDate
    });
  }

  return rows;
}

// ============================================================
//                 API: DAILY MILK IMPORT PREVIEW
// ============================================================

app.post("/api/daily-milk/import/preview", requireUserId, dailyMilkImportRawParserSrv, async (req, res) => {
  try {
    if (!db) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "تعذّر المعاينة — قاعدة البيانات غير متاحة."
      });

      return res.status(503).json({ ok: false, message: ui.message, ui });
    }

    const uid = req.userId;

    const bodyObj = Buffer.isBuffer(req.body) ? {} : (req.body || {});
    const mp = Buffer.isBuffer(req.body) ? dailyMilkImportParseMultipartSrv(req) : { fields: {} };

    const eventDate = String(
      bodyObj.eventDate ||
      bodyObj.date ||
      mp.fields.eventDate ||
      mp.fields.date ||
      ""
    ).trim().slice(0, 10);

    if (!calvingIsDateSrv(eventDate)) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "❌ تاريخ اللبن غير صالح."
      });

      return res.status(400).json({ ok: false, message: ui.message, ui });
    }

    const inputRows = dailyMilkImportRowsFromReqSrv(req);

    if (!inputRows.length) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "ألصق بيانات المحلب أو ارفع ملف المحلب أولًا."
      });

      return res.json({ ok: true, message: ui.message, ui });
    }

    const rows = await dailyMilkImportPreviewRowsSrv(uid, eventDate, inputRows);
    const ui = dailyMilkImportBuildUiSrv({ rows });

    return res.json({
      ok: true,
      message: ui.message,
      rows,
      ui
    });

  } catch (e) {
    console.error("daily-milk-import-preview", e);

    const ui = dailyMilkImportBuildUiSrv({
      rows: [],
      message: e?.message || "تعذّرت معاينة استيراد اللبن الآن."
    });

    return res.status(500).json({
      ok: false,
      message: ui.message,
      ui
    });
  }
});

// ============================================================
//                 API: DAILY MILK IMPORT SAVE
// ============================================================

app.post("/api/daily-milk/import/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "تعذّر الحفظ — قاعدة البيانات غير متاحة."
      });

      return res.status(503).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: [],
        ui
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);

    if (!calvingIsDateSrv(eventDate)) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "❌ تاريخ اللبن غير صالح."
      });

      return res.status(400).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: [],
        ui
      });
    }

    const inputRows = Array.isArray(body.rows) ? body.rows : [];

    if (!inputRows.length) {
      const ui = dailyMilkImportBuildUiSrv({
        rows: [],
        message: "لا توجد صفوف جاهزة للحفظ."
      });

      return res.status(400).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: [],
        ui
      });
    }

    const checkedRows = await dailyMilkImportPreviewRowsSrv(uid, eventDate, inputRows);

    const saved = [];
    const rejected = [];

    for (const row of checkedRows) {
      if (row.valid !== true) {
        rejected.push({
          animalNumber: row.animalNumber || "",
          reason: row.reason || "غير صالح للحفظ."
        });
        continue;
      }

      const animalNumber = calvingNormDigitsOnlySrv(row.animalNumber);
      const animalId = String(row.animalId || "").trim();
      const kind = String(row.kind || "").trim();
      const species = String(row.species || "").trim();

      const s1 = dailyMilkNumStrictSrv(row.milkS1);
      const s2 = dailyMilkNumStrictSrv(row.milkS2);
      const s3 = dailyMilkNumStrictSrv(row.milkS3);
      const calc = dailyMilkImportCalcSrv(row, kind);

      if (!calc.ok) {
        rejected.push({
          animalNumber,
          reason: calc.reason || "كمية اللبن غير صالحة."
        });
        continue;
      }

      const milkSessions =
        String(row.importMode || "") === "total_only"
          ? [{ n: 1, kg: calc.milkKg }]
          : (
              kind === "buffalo"
                ? [{ n: 1, kg: s1 }, { n: 2, kg: s2 }]
                : [{ n: 1, kg: s1 }, { n: 2, kg: s2 }, { n: 3, kg: s3 }]
            );

      const eventId = ["daily_milk", uid, animalNumber, eventDate].join("__");
      const eventRef = db.collection("events").doc(eventId);

      const existing = await eventRef.get();
      if (existing.exists) {
        rejected.push({
          animalNumber,
          reason: "تم تسجيل لبن اليوم لهذا الحيوان بالفعل."
        });
        continue;
      }

      const payload = {
        userId: uid,
        ownerUid: uid,

        animalId,
        animalNumber,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        date: eventDate,
        eventDate,

        eventType: "لبن يومي",
        eventTypeNorm: "daily_milk",
        type: "daily_milk",

        species,
        kind,
        importMode: String(row.importMode || "").trim() || "sessions",

        milkSessions,
        milkKg: calc.milkKg,
        dailyMilk: calc.milkKg,
        totalMilk: calc.milkKg,

        source: "server:/api/daily-milk/import/save"
      };

      const batch = db.batch();

      batch.set(eventRef, payload);

      if (animalId) {
        batch.set(db.collection("animals").doc(animalId), {
          dailyMilk: calc.milkKg,
          milkTodayKg: calc.milkKg,
          lastMilkKg: calc.milkKg,
          lastMilkDate: eventDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      await batch.commit();

      saved.push({
        animalNumber,
        animalId,
        eventId,
        eventDate,
        milkKg: calc.milkKg,
        species,
        kind,
        totalText: dailyMilkFormatTotalSrv(calc.milkKg),
        valid: true,
        reason: ""
      });
    }

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "daily_milk_import_save");
    }

    const rejectedRows = rejected.map(x => ({
      ...x,
      valid: false,
      totalText: "—"
    }));

    const ui = dailyMilkImportBuildUiSrv({
      rows: [...saved, ...rejectedRows],
      message: saved.length
        ? `✅ تم حفظ ${saved.length} سجل لبن بنجاح.`
        : "❌ لم يتم حفظ أي سجل لبن."
    });

    return res.json({
      ok: saved.length > 0,
      message: ui.message,
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected,
      ui
    });

  } catch (e) {
    console.error("daily-milk-import-save", e);

    const ui = dailyMilkImportBuildUiSrv({
      rows: [],
      message: "تعذّر حفظ استيراد اللبن الآن."
    });

    return res.status(500).json({
      ok: false,
      message: ui.message,
      savedCount: 0,
      rejectedCount: 0,
      saved: [],
      rejected: [],
      ui
    });
  }
});
// ============================================================
//                 API: DAILY MILK SAVE ONLY
//                 السيرفر يفحص ويحفظ ويجهز UI كامل
// ============================================================

app.post("/api/daily-milk/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      const ui = dailyMilkBuildSaveUiSrv({
        message: "تعذّر حفظ اللبن اليومي — قاعدة البيانات غير متاحة."
      });

      return res.status(503).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: [],
        ui
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const rows = dailyMilkRowsFromBodySrv(body);

    if (!rows.length) {
      const ui = dailyMilkBuildSaveUiSrv({
        message: "❌ رقم الحيوان مطلوب.",
        eventDate
      });

      return res.status(400).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: [],
        ui
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      const rejected = rows.map(r => ({
        animalNumber: calvingNormDigitsOnlySrv(r.animalNumber || r.number || ""),
        reason: "تاريخ اللبن غير صالح."
      }));

      const ui = dailyMilkBuildSaveUiSrv({
        rejected,
        message: "❌ تاريخ اللبن غير صالح.",
        eventDate
      });

      return res.status(400).json({
        ok: false,
        message: ui.message,
        savedCount: 0,
        rejectedCount: rejected.length,
        saved: [],
        rejected,
        ui
      });
    }

    const saved = [];
    const rejected = [];

    for (const row of rows) {
      const animalNumber = calvingNormDigitsOnlySrv(row.animalNumber || row.number || "");

      if (!animalNumber) {
        rejected.push({
          animalNumber: "",
          reason: "رقم الحيوان مطلوب."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const animalId = String(animal.id || row.animalId || "").trim();
      const animalDoc = animal.data || {};

      if (dailyMilkIsOutOfHerdSrv(animalDoc)) {
        rejected.push({
          animalNumber,
          reason: "❌ لا يمكن تسجيل لبن — الحيوان غير موجود بالقطيع."
        });
        continue;
      }

      const duplicated = await dailyMilkHasSameDaySrv(uid, animalNumber, eventDate);

      if (duplicated) {
        rejected.push({
          animalNumber,
          reason: "❌ تم تسجيل لبن اليوم لهذا الحيوان بالفعل."
        });
        continue;
      }

      const species = dailyMilkSpeciesSrv(animalDoc);
      const kind = dailyMilkKindSrv(species);

      const s1 = dailyMilkNumStrictSrv(row.milkS1 ?? row.s1 ?? row.session1);
      const s2 = dailyMilkNumStrictSrv(row.milkS2 ?? row.s2 ?? row.session2);
      const s3 = dailyMilkNumStrictSrv(row.milkS3 ?? row.s3 ?? row.session3);

      if (![s1, s2, s3].every(Number.isFinite)) {
        rejected.push({
          animalNumber,
          reason: "❌ كمية اللبن غير صالحة."
        });
        continue;
      }

      if (s1 < 0 || s2 < 0 || s3 < 0) {
        rejected.push({
          animalNumber,
          reason: "❌ كمية اللبن لا يمكن أن تكون سالبة."
        });
        continue;
      }

      const milkKg = kind === "buffalo"
        ? Number((s1 + s2).toFixed(1))
        : Number((s1 + s2 + s3).toFixed(1));

      if (!Number.isFinite(milkKg) || milkKg <= 0) {
        rejected.push({
          animalNumber,
          reason: "❌ أدخل كمية اللبن — لا يمكن الحفظ بإجمالي صفر."
        });
        continue;
      }

      const milkSessions = kind === "buffalo"
        ? [{ n: 1, kg: s1 }, { n: 2, kg: s2 }]
        : [{ n: 1, kg: s1 }, { n: 2, kg: s2 }, { n: 3, kg: s3 }];

      const dailyMilkEventId = [
        "daily_milk",
        uid,
        animalNumber,
        eventDate
      ].join("__");

      const eventRef = db.collection("events").doc(dailyMilkEventId);

      const existingEventSnap = await eventRef.get();
      if (existingEventSnap.exists) {
        rejected.push({
          animalNumber,
          reason: "❌ تم تسجيل لبن اليوم لهذا الحيوان بالفعل."
        });
        continue;
      }

      const payload = {
        userId: uid,
        ownerUid: uid,

        animalId,
        animalNumber,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        date: eventDate,
        eventDate,

        eventType: "لبن يومي",
        eventTypeNorm: "daily_milk",
        type: "daily_milk",

        species,
        kind,
        milkSessions,
        milkKg,
        dailyMilk: milkKg,
        totalMilk: milkKg,

        source: "server:/api/daily-milk/save"
      };

      const batch = db.batch();

      batch.set(eventRef, payload);

      if (animalId) {
        batch.set(db.collection("animals").doc(animalId), {
          dailyMilk: milkKg,
          milkTodayKg: milkKg,
          lastMilkKg: milkKg,
          lastMilkDate: eventDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      await batch.commit();

      saved.push({
        animalNumber,
        animalId,
        eventId: eventRef.id,
        eventDate,
        milkKg,
        species,
        kind
      });
    }

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "daily_milk_save");
    }

    const message = saved.length
      ? "✅ تم حفظ اللبن اليومي بنجاح"
      : "❌ لم يتم حفظ أي سجل لبن.";

    const ui = dailyMilkBuildSaveUiSrv({
      saved,
      rejected,
      message,
      eventDate
    });

    return res.json({
      ok: saved.length > 0,
      message,
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected,
      animalNumber: saved[0]?.animalNumber || "",
      eventDate,
      redirectUrl: ui.redirectUrl,
      ui
    });

  } catch (e) {
    console.error("daily-milk-save", e);

    const ui = dailyMilkBuildSaveUiSrv({
      message: "تعذّر حفظ اللبن اليومي — تحقّق من الاتصال والصلاحيات."
    });

    return res.status(500).json({
      ok: false,
      message: ui.message,
      savedCount: 0,
      rejectedCount: 0,
      saved: [],
      rejected: [],
      ui
    });
  }
});
// ============================================================
//                 API: VACCINATION DASHBOARD ALERTS ONLY
//                 تنبيهات التحصين من السيرفر فقط — للداشبورد
// ============================================================

app.get("/api/vaccination/dashboard-alerts", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        count: 0,
        alerts: [],
        message: "تعذّر تحميل تنبيهات التحصين — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;

    const today = cairoTodayISO();
    const tomorrow = vaccinationYmdAddDaysSrv(today, 1);

    const snap = await db.collection("tasks")
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(500)
      .get();

    const groups = new Map();

    snap.forEach(ds => {
      const t = ds.data() || {};

      if (String(t.taskType || "").trim() !== "vaccination") return;
      if (t.done === true) return;

      const dueDate = String(t.dueDate || "").trim().slice(0, 10);
      if (dueDate !== today && dueDate !== tomorrow) return;

      const animalNumber = calvingNormDigitsOnlySrv(t.animalNumber || "");
      if (!animalNumber) return;

      const vaccineKey = String(
        t.vaccineKey ||
        t.vaccine ||
        "تحصين"
      ).trim();

      const doseType = String(
        t.doseType ||
        "booster"
      ).trim();

      const key = `${dueDate}__${vaccineKey}__${doseType}`;

      if (!groups.has(key)) {
        groups.set(key, {
          dueDate,
          vaccineKey,
          doseType,
          animalNumbers: []
        });
      }

      groups.get(key).animalNumbers.push(animalNumber);
    });

    const alerts = [];

    for (const g of groups.values()) {
      const nums = [...new Set(g.animalNumbers)]
        .filter(Boolean)
        .sort((a, b) => Number(a) - Number(b));

      if (!nums.length) continue;

      const isToday = g.dueDate === today;

      const doseQuery =
        g.doseType === "booster" ? "periodic" :
        g.doseType === "primary" ? "prime" :
        g.doseType;

      alerts.push({
        id: `vaccination_${g.dueDate}_${g.vaccineKey}_${g.doseType}`.replace(/\s+/g, "_"),
        source: "server:/api/vaccination/dashboard-alerts",

        type: "vaccination",
        level: isToday ? "warn" : "info",

        title: isToday ? "تحصين مستحق اليوم" : "تحصين مستحق غدًا",

        message: `${isToday ? "⏰ اليوم" : "📌 غدًا"} ${g.vaccineKey}\nللحيوانات أرقام: ${nums.join("، ")}`,

        actionText: "فتح صفحة التحصين",
        actionUrl:
          `vaccination.html?entryMode=bulk` +
          `&date=${encodeURIComponent(g.dueDate)}` +
          `&vaccine=${encodeURIComponent(g.vaccineKey)}` +
          `&doseType=${encodeURIComponent(doseQuery)}` +
          `&numbers=${encodeURIComponent(nums.join(","))}`,

        dueDate: g.dueDate,
        vaccineKey: g.vaccineKey,
        doseType: g.doseType,
        animalNumbers: nums,
        count: nums.length
      });
    }

    alerts.sort((a, b) => {
      const d = String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
      if (d !== 0) return d;
      return String(a.vaccineKey || "").localeCompare(String(b.vaccineKey || ""));
    });

    return res.json({
      ok: true,
      today,
      tomorrow,
      count: alerts.length,
      alerts
    });

  } catch (e) {
    console.error("vaccination-dashboard-alerts", e);

    return res.status(500).json({
      ok: false,
      count: 0,
      alerts: [],
      message: "تعذّر تحميل تنبيهات التحصين."
    });
  }
});
// ============================================================
//                 API: DRY-OFF GATE ONLY
//                 أهلية + حساب + تعبئة فقط — بدون حفظ
// ============================================================

function dryOffParseNumbersSrv(raw) {
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const txt = String(raw || "").trim();
    if (!txt) return [];
    arr = txt.split(/\n|,|;|،|\s+/g);
  }

  return [...new Set(
    arr
      .map(x => calvingNormDigitsOnlySrv(x))
      .filter(Boolean)
  )];
}

function dryOffIsBlockedSrv(doc = {}) {
  const reproDoc = String(doc.reproductiveStatus || "").trim();
  const reproNorm = calvingStripArSrv(reproDoc);

  return (
    doc.breedingBlocked === true ||
    reproDoc.includes("لا تُلقّح") ||
    reproDoc.includes("لا تلقح") ||
    reproDoc.includes("مستبعد") ||
    reproNorm.includes("لاتلقح")
  );
}

function dryOffReasonFromDaysSrv({ doc = {}, gestationDays }) {
  if (dryOffIsBlockedSrv(doc)) {
    return "تجفيف للبيع";
  }

  const g = Number(gestationDays);
  const months = g / 30;

  if (months >= 6.5 && months <= 7.5) return "تجفيف طبيعي";
  if (months < 6.5) return "تجفيف اضطراري";
  return "تجفيف متأخر";
}

function dryOffGateEligibilitySrv(fd = {}) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  const eventDate = String(fd.eventDate || "").trim().slice(0, 10);
  if (!calvingIsDateSrv(eventDate)) {
    return "❌ تاريخ التجفيف غير صالح.";
  }

  // خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان خارج القطيع.";
  }

  // جاف بالفعل
  const ps = String(doc.productionStatus ?? "").trim().toLowerCase();
  if (ps === "dry" || ps === "جاف") {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان مُسجّل بالفعل كـ «جاف».";
  }

  // منع تكرار التجفيف قبل الولادة
  const lastDry = String(doc.lastDryOffDate ?? "").slice(0, 10);
  const lastCalv = String(doc.lastCalvingDate ?? "").slice(0, 10);

  if (calvingIsDateSrv(lastDry)) {
    if (!calvingIsDateSrv(lastCalv) || lastCalv <= lastDry) {
      return `❌ لا يمكن تسجيل تجفيف مرة أخرى قبل الولادة.\nآخر تجفيف مسجّل: ${lastDry}.`;
    }
  }

  // المستبعد التناسلي مسموح له بالتجفيف للبيع فقط
  if (dryOffIsBlockedSrv(doc)) {
    const reason = String(fd.reason || "").trim();
    if (reason !== "تجفيف للبيع") {
      return "❌ الحيوان مستبعد تناسليًا — مسموح فقط بـ «تجفيف للبيع» (يتحدد تلقائيًا).";
    }
    return null;
  }

  // غير المستبعد لازم يكون عشار
  const rsRaw = String(
    fd.reproStatusFromEvents ||
    doc.reproductiveStatus ||
    ""
  ).trim();

  const rsNorm = calvingStripArSrv(rsRaw);

  if (!rsNorm.includes("عشار")) {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان ليس «عِشار».";
  }

  const g = Number(fd.gestationDays);
  if (!Number.isFinite(g) || g < 0) {
    return "❌ تعذّر حساب أيام الحمل — راجع تاريخ التجفيف.";
  }

  const reason = String(fd.reason || "").trim();

  if (g < 198 && reason !== "تجفيف اضطراري") {
    return "❌ أقل من 6.5 شهر ⇒ «تجفيف اضطراري».";
  }

  if (g >= 198 && g <= 228 && reason !== "تجفيف طبيعي") {
    return "❌ من 6.5 إلى 7.5 شهر ⇒ «تجفيف طبيعي».";
  }

  if (g > 228 && reason !== "تجفيف متأخر") {
    return "❌ أكثر من 7.5 شهر ⇒ «تجفيف متأخر».";
  }

  return null;
}

app.post("/api/dry-off/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        stage: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const rawNumbers =
      body.animalNumbers ||
      body.numbers ||
      body.animalNumber ||
      body.number ||
      "";

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const numbers = dryOffParseNumbersSrv(rawNumbers);

    if (!numbers.length || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true,
        stage: "missing_basic",
        message: "أدخل رقم الحيوان وتاريخ التجفيف لبدء التحقق.",
        acceptedCount: 0,
        rejectedCount: 0,
        accepted: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        stage: "invalid_date",
        message: "❌ تاريخ التجفيف غير صالح.",
        acceptedCount: 0,
        rejectedCount: numbers.length,
        accepted: [],
        rejected: numbers.map(n => ({
          animalNumber: String(n || ""),
          reason: "تاريخ التجفيف غير صالح."
        }))
      });
    }

    const accepted = [];
    const rejected = [];

    for (const rawNum of numbers) {
      const animalNumber = calvingNormDigitsOnlySrv(rawNum);

      if (!animalNumber) {
        rejected.push({
          animalNumber: String(rawNum || ""),
          reason: "رقم غير صالح."
        });
        continue;
      }

      const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (!animal) {
        rejected.push({
          animalNumber,
          reason: "الحيوان غير موجود في حسابك."
        });
        continue;
      }

      const doc = animal.data || {};
      const animalStatus = String(doc.status || "active").trim().toLowerCase();

if (animalStatus !== "active") {
  rejected.push({
    animalNumber,
    reason: "❌ لا يمكن تسجيل تجفيف — الحيوان غير موجود بالقطيع."
  });
  continue;
}
      const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

      const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const blocked = dryOffIsBlockedSrv(doc);

      let lastInseminationDate = String(
        signals.lastInseminationDateFromEvents ||
        doc.lastInseminationDate ||
        doc.lastAI ||
        doc.lastInsemination ||
        doc.lastServiceDate ||
        ""
      ).trim();

      let gestationDays = null;

      if (blocked) {
        gestationDays = 0;
      } else {
        const reproStatus = reproFromEvents || reproFromDoc || "";
        const reproNorm = calvingStripArSrv(reproStatus);

        if (!reproNorm.includes("عشار")) {
          rejected.push({
            animalNumber,
            reason: "❌ لا يمكن تسجيل تجفيف — الحيوان ليس «عِشار»."
          });
          continue;
        }

        if (!lastInseminationDate) {
          rejected.push({
            animalNumber,
            reason: '❌ لا يمكن حساب أيام الحمل — لا يوجد "آخر تلقيح" لهذا الحيوان.'
          });
          continue;
        }

        gestationDays = calvingDaysBetweenSrv(lastInseminationDate, eventDate);

        if (!Number.isFinite(gestationDays) || gestationDays < 0) {
          rejected.push({
            animalNumber,
            reason: "❌ تعذّر حساب أيام الحمل — راجع تاريخ التجفيف."
          });
          continue;
        }
      }

      const reason = dryOffReasonFromDaysSrv({
        doc,
        gestationDays
      });

      const decision = dryOffGateEligibilitySrv({
        animalNumber,
        eventDate,
        animalId: animal.id || "",
        documentData: doc,
        reproStatusFromEvents: reproFromEvents,
        lastInseminationDate,
        gestationDays,
        reason
      });

      if (decision) {
        rejected.push({
          animalNumber,
          reason: String(decision)
        });
        continue;
      }

      accepted.push({
        animalNumber,
        animalId: animal.id || "",
        eventDate,
        gestationDays,
        reason,
        lastInseminationDate,
        reproductiveStatus: reproFromEvents || reproFromDoc || ""
      });
    }

    const allowed = accepted.length > 0;
    const acceptedCount = accepted.length;
    const rejectedCount = rejected.length;
    const isBulk = numbers.length > 1;

    if (!isBulk) {
      if (!acceptedCount) {
        const r0 = rejected[0] || {};
        return res.status(400).json({
          ok: false,
          allowed: false,
          stage: "not_eligible",
          message: r0.reason || "❌ الحيوان غير مؤهل لتسجيل التجفيف.",
          acceptedCount,
          rejectedCount,
          accepted,
          rejected
        });
      }

      const a0 = accepted[0] || {};
      return res.json({
        ok: true,
        allowed: true,
        stage: "eligible",
        message: "✅ الحيوان مؤهل لتسجيل التجفيف.",
        acceptedCount,
        rejectedCount,
        accepted,
        rejected,

        // توافق مع الصفحة الفردية
        animalNumber: a0.animalNumber || "",
        animalId: a0.animalId || "",
        eventDate: a0.eventDate || "",
        gestationDays: a0.gestationDays ?? "",
        reason: a0.reason || "",
        lastInseminationDate: a0.lastInseminationDate || "",
        reproductiveStatus: a0.reproductiveStatus || ""
      });
    }

    return res.json({
      ok: true,
      allowed,
      stage: allowed ? "bulk_has_eligible" : "bulk_no_eligible",
      message: allowed
        ? `✅ تم التحقق — المؤهل: ${acceptedCount}، غير المؤهل: ${rejectedCount}.`
        : "❌ لا يوجد أي رقم مؤهل لتسجيل التجفيف.",
      acceptedCount,
      rejectedCount,
      accepted,
      rejected
    });

  } catch (e) {
    console.error("dry-off-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      stage: "dry_off_gate_failed",
      error: "dry_off_gate_failed",
      message: "❌ تعذّر التحقق من أهلية التجفيف الآن.",
      acceptedCount: 0,
      rejectedCount: 0,
      accepted: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: DRY-OFF SAVE ONLY
//                 حفظ فقط — بدون إعادة فحص أهلية
// ============================================================

function dryOffSaveRowsFromBodySrv(body = {}) {
  if (Array.isArray(body.accepted) && body.accepted.length) return body.accepted;
  if (Array.isArray(body.rows) && body.rows.length) return body.rows;

  const animalNumber = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
  if (!animalNumber) return [];

  return [{
    animalNumber,
    animalId: body.animalId || "",
    eventDate: body.eventDate || body.date || "",
    reason: body.reason || "",
    gestationDays: body.gestationDays,
    lastInseminationDate: body.lastInseminationDate || "",
    reproductiveStatus: body.reproductiveStatus || ""
  }];
}

function dryOffSaveRequiredSrv(v) {
  return !(v === undefined || v === null || String(v).trim() === "");
}
// ============================================================
//                 CLOSE-UP / تحضير للولادة — SERVER SIDE
//                 نقل منطق التحضير من form-rules.js كما هو
// ============================================================

function closeupDecisionSrv(fd = {}) {
  const doc = fd.documentData || {};
  if (!doc || !Object.keys(doc).length) {
    return "❌ تعذّر العثور على الحيوان.";
  }

  // منع تكرار "تحضير للولادة" داخل نفس الموسم
  const lastCloseUp = String(doc.lastCloseUpDate || "").trim();
  const lastCalving = String(doc.lastCalvingDate || "").trim();

  if (calvingIsDateSrv(lastCloseUp)) {
    if (!calvingIsDateSrv(lastCalving)) {
      return `❌ تم تسجيل تحضير للولادة مسبقًا بتاريخ ${lastCloseUp} — لا يمكن تكراره في نفس الموسم.`;
    }

    const gapFromCalvingToCloseUp = calvingDaysBetweenSrv(lastCalving, lastCloseUp);
    if (Number.isFinite(gapFromCalvingToCloseUp) && gapFromCalvingToCloseUp >= 0) {
      return `❌ تم تسجيل تحضير للولادة مسبقًا في هذا الموسم بتاريخ ${lastCloseUp} — لا يمكن تكراره.`;
    }
  }

  // خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive" || st === "archived") {
    return "❌ لا يمكن تسجيل التحضير — الحيوان خارج القطيع.";
  }

  // آخر تلقيح
  const lf = String(
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    doc.lastServiceDate ||
    ""
  ).trim();

  // أحداث من وثيقة الحيوان نفسها تنهي الحمل الحالي
  const lastAbortion = String(doc.lastAbortionDate || "").trim();

  if (calvingIsDateSrv(lf) && calvingIsDateSrv(lastCalving)) {
    const calvingAfterService = calvingDaysBetweenSrv(lf, lastCalving);
    const eventAfterCalving = calvingDaysBetweenSrv(lastCalving, fd.eventDate);

    if (
      Number.isFinite(calvingAfterService) &&
      Number.isFinite(eventAfterCalving) &&
      calvingAfterService >= 0 &&
      eventAfterCalving >= 0
    ) {
      return `❌ لا يمكن تسجيل التحضير — آخر ولادة بتاريخ ${lastCalving} أنهت الحمل الحالي.`;
    }
  }

  if (calvingIsDateSrv(lf) && calvingIsDateSrv(lastAbortion)) {
    const abortionAfterService = calvingDaysBetweenSrv(lf, lastAbortion);
    const eventAfterAbortion = calvingDaysBetweenSrv(lastAbortion, fd.eventDate);

    if (
      Number.isFinite(abortionAfterService) &&
      Number.isFinite(eventAfterAbortion) &&
      abortionAfterService >= 0 &&
      eventAfterAbortion >= 0
    ) {
      return `❌ لا يمكن تسجيل التحضير — آخر إجهاض بتاريخ ${lastAbortion} أنهى الحمل الحالي.`;
    }
  }

  // الحالة الإنتاجية الحالية لو كانت حديثة الولادة تمنع التحضير مباشرة
  const psRaw = String(doc.productionStatus || "").trim();
  const psNorm = calvingStripArSrv(psRaw).toLowerCase();

  if (
    psNorm.includes("حديث") ||
    psNorm.includes("fresh") ||
    psNorm.includes("فريش")
  ) {
    const shown = psRaw ? `«${psRaw}»` : "حديث الولادة";
    return `❌ لا يمكن تسجيل التحضير — الحالة الحالية: ${shown}.`;
  }

  // الحالة التناسلية — وثيقة الحيوان الحالية أولًا
  const rsRaw = String(
    doc.reproductiveStatus ||
    doc.reproStatus ||
    fd.reproductiveStatus ||
    fd.reproStatusFromEvents ||
    ""
  ).trim();

  const rsNorm = calvingStripArSrv(rsRaw);

  if (!rsNorm.includes("عشار")) {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ لا يمكن تسجيل التحضير — الحالة التناسلية الحالية: ${shown}.`;
  }

  if (!calvingIsDateSrv(lf)) {
    return '❌ لا يمكن تسجيل التحضير — لا يوجد "آخر تلقيح مُخصِّب".';
  }

  if (!calvingIsDateSrv(fd.eventDate)) {
    return "❌ تاريخ التحضير غير صالح.";
  }

  // نوع الحيوان — بعد التأكد من الحالة والتلقيح
 const sp = calvingNormalizeSpeciesSrv(
  fd.species ||
  doc.species ||
  doc.animalTypeAr ||
  doc.animalType ||
  doc.animaltype ||
  doc.groupSpecies ||
  ""
);

  const th = CALVING_THRESHOLDS_SRV[sp]?.minGestationDays;
  if (!th) {
    return "❌ نوع القطيع غير معروف لحساب عمر الحمل.";
  }

  const gDays = calvingDaysBetweenSrv(lf, fd.eventDate);
  if (!Number.isFinite(gDays)) {
    return "❌ تعذّر حساب عمر الحمل.";
  }

  const remaining = th - gDays;

  if (remaining > 40) {
    return `❌ لا يمكن تسجيل التحضير — المتبقي على أقل موعد ولادة ${remaining} يوم (أكثر من 40 يوم).`;
  }

  return null;
}
async function updateAnimalAfterCloseupSaveSrv(ev = {}) {
  const uid = String(ev.userId || "").trim();
  const animalNumber = calvingNormDigitsOnlySrv(ev.animalNumber || ev.number || "");
  let animalId = String(ev.animalId || "").trim();

  if (!animalId) {
    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);
    animalId = String(animal?.id || "").trim();
  }

  if (!uid || !animalNumber || !animalId) {
    console.warn("⛔ close-up animal update skipped:", { uid, animalNumber, animalId });
    return;
  }

  const eventDate = String(ev.eventDate || "").trim().slice(0, 10);

  await db.collection("animals").doc(animalId).set({
    lastCloseUpDate: eventDate,
    productionStatus: "close_up",
    reproductiveStatus: "تحضير للولادة",
    closeUpRation: String(ev.ration || "").trim(),
    anionicSalts: String(ev.anionicSalts || "").trim(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}
app.post("/api/close-up/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        error: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);

    if (!animalNumber || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        allowed: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا."
      });
    }

    const doc = animal.data || {};
    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);
 const species = calvingNormalizeSpeciesSrv(
  body.species ||
  doc.species ||
  doc.animalTypeAr ||
  doc.animalType ||
  doc.animaltype ||
  doc.groupSpecies ||
  ""
);

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();

    const lastInseminationDate = String(
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      doc.lastAI ||
      doc.lastInsemination ||
      doc.lastServiceDate ||
      ""
    ).trim();

    const gateData = {
  animalNumber,
  eventDate,
  animalId: animal.id || "",
  species,
  documentData: doc,
  reproductiveStatus: reproFromDoc || reproFromEvents || "",
  reproStatusFromEvents: reproFromEvents,
  lastInseminationDate,
  
};

    const errMsg = closeupDecisionSrv(gateData);

    if (errMsg) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: String(errMsg)
      });
    }

    return res.json({
      ok: true,
      allowed: true,
      message: "✅ تم التحقق — أكمل تسجيل تحضير الولادة.",
      animalId: animal.id || "",
      animalNumber,
      eventDate,
      species,
      lastInseminationDate,
      reproductiveStatus: gateData.reproductiveStatus
    });

  } catch (e) {
    console.error("close-up-gate", e);
    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "close_up_gate_failed",
      message: "تعذّر التحقق من تحضير الولادة الآن."
    });
  }
});
app.post("/api/close-up/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تحضير الولادة — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);
    const ration = String(body.ration || "").trim();
    const anionicSalts = String(body.anionicSalts || "").trim();

    if (!animalNumber) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان مطلوب."
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التحضير غير صالح."
      });
    }

    if (!ration) {
      return res.status(400).json({
        ok: false,
        message: "❌ يجب تحديد هل تم تقديم عليقة التحضير."
      });
    }

    if (!anionicSalts) {
      return res.status(400).json({
        ok: false,
        message: "❌ يجب تحديد هل تم استخدام الأملاح الأنيونية."
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "❌ رقم الحيوان غير موجود في حسابك."
      });
    }

    const doc = animal.data || {};
    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

const species = calvingNormalizeSpeciesSrv(
  body.species ||
  doc.species ||
  doc.animalTypeAr ||
  doc.animalType ||
  doc.animaltype ||
  doc.groupSpecies ||
  ""
);

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();

    const lastInseminationDate = String(
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      doc.lastAI ||
      doc.lastInsemination ||
      doc.lastServiceDate ||
      ""
    ).trim();

    const decisionData = {
  animalNumber,
  eventDate,
  animalId: animal.id || "",
  species,
  documentData: doc,
  reproductiveStatus: reproFromDoc || reproFromEvents || "",
  reproStatusFromEvents: reproFromEvents,
  lastInseminationDate,
  
};

    const errMsg = closeupDecisionSrv(decisionData);

    if (errMsg) {
      return res.status(400).json({
        ok: false,
        message: String(errMsg)
      });
    }

    const payload = {
      userId: uid,

      animalId: animal.id || "",
      animalNumber,

      eventDate,

      ration,
      anionicSalts,

      lastInseminationDate,
      species,

      eventType: "تحضير للولادة",
      type: "closeup",
      eventTypeNorm: "close_up",

      source: "server:/api/close-up/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

   const eventRef = await db.collection("events").add(payload);
await updateAnimalAfterCloseupSaveSrv(payload);

if (typeof scheduleGroupsRebuildSrv === "function") {
  scheduleGroupsRebuildSrv(uid, "close_up_save");
}

return res.json({
      ok: true,
      message: "✅ تم حفظ تحضير الولادة بنجاح",
      eventId: eventRef.id,
      animalId: animal.id || "",
      animalNumber,
      eventDate,
      ration,
      anionicSalts,
      redirectUrl: `/event-list.html?number=${encodeURIComponent(animalNumber)}`
    });

  } catch (e) {
    console.error("close-up-save", e);
    return res.status(500).json({
      ok: false,
      error: "close_up_save_failed",
      message: "تعذّر حفظ تحضير الولادة — تحقّق من الاتصال والصلاحيات."
    });
  }
});
async function updateAnimalAfterDryOffSaveSrv(ev = {}) {
  const uid = String(ev.userId || "").trim();
  const animalNumber = calvingNormDigitsOnlySrv(ev.animalNumber || "");
  let animalId = String(ev.animalId || "").trim();

  if (!animalId) {
    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);
    animalId = String(animal?.id || "").trim();
  }

  if (!uid || !animalNumber || !animalId) {
    console.warn("⛔ dry-off animal update skipped:", { uid, animalNumber, animalId });
    return;
  }

  await db.collection("animals").doc(animalId).set({
  lastDryOffDate: String(ev.eventDate || ev.dryOffDate || "").slice(0, 10),
  dryOffDate: String(ev.eventDate || ev.dryOffDate || "").slice(0, 10),

  productionStatus: "جاف",
  inMilk: false,

  dailyMilk: null,
  milkTodayKg: null,
  daysInMilk: null,

  dryOffReason: String(ev.reason || "").trim(),
    lastDryOffReason: String(ev.reason || "").trim(),
    pregnancyStatusAtDryOff: String(ev.pregnancyStatus || "").trim(),
    usedDryingAntibiotics: String(ev.usedDryingAntibiotics || "").trim(),

    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

app.post("/api/dry-off/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ التجفيف – قاعدة البيانات غير متاحة.",
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);
    const pregnancyStatus = String(body.pregnancyStatus || "").trim();
    const usedDryingAntibiotics = String(body.usedDryingAntibiotics || "").trim();
    const notes = String(body.notes || "").trim();

    const rows = dryOffSaveRowsFromBodySrv(body);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان/الأرقام مطلوبة.",
        savedCount: 0,
        rejectedCount: 0,
        saved: [],
        rejected: []
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التجفيف غير صالح.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r?.animalNumber || r?.number || ""),
          reason: "❌ تاريخ التجفيف غير صالح."
        }))
      });
    }

    if (!dryOffSaveRequiredSrv(pregnancyStatus)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تأكيد الحمل مطلوب.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r?.animalNumber || r?.number || ""),
          reason: "❌ تأكيد الحمل مطلوب."
        }))
      });
    }

    if (!dryOffSaveRequiredSrv(usedDryingAntibiotics)) {
      return res.status(400).json({
        ok: false,
        message: "❌ حدد هل تم استخدام محاقن التجفيف.",
        savedCount: 0,
        rejectedCount: rows.length,
        saved: [],
        rejected: rows.map(r => ({
          animalNumber: calvingNormDigitsOnlySrv(r?.animalNumber || r?.number || ""),
          reason: "❌ حدد هل تم استخدام محاقن التجفيف."
        }))
      });
    }

    const saved = [];
    const rejected = [];

    for (const rawRow of rows) {
      const row = rawRow || {};

      const animalNumber = calvingNormDigitsOnlySrv(row.animalNumber || row.number || "");
      const animalId = String(row.animalId || body.animalId || "").trim();
      const reason = String(row.reason || body.reason || "").trim();
      const gestationDays = Number(row.gestationDays ?? body.gestationDays);
      const lastInseminationDate = String(row.lastInseminationDate || body.lastInseminationDate || "").trim();

      if (!animalNumber) {
        rejected.push({ animalNumber: "", reason: "❌ رقم الحيوان مطلوب." });
        continue;
      }

      if (!dryOffSaveRequiredSrv(reason)) {
        rejected.push({ animalNumber, reason: "❌ سبب التجفيف مطلوب." });
        continue;
      }

      if (!Number.isFinite(gestationDays)) {
        rejected.push({ animalNumber, reason: "❌ أيام الحمل مطلوبة." });
        continue;
      }

      const payload = {
        userId: uid,

        animalNumber,
        animalId,

        eventDate,
        dryOffDate: eventDate,

        reason,
        pregnancyStatus,
        usedDryingAntibiotics,
        gestationDays,

        lastInseminationDate,

        type: "تجفيف",
        eventType: "dry_off",
        eventTypeNorm: "dry_off",

        notes: notes || null,

        tz: String(body.tz || "").trim() || "UTC",
        source: "server:/api/dry-off/save",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const eventRef = await db.collection("events").add(payload);
      await updateAnimalAfterDryOffSaveSrv(payload);

      saved.push({
        animalNumber,
        animalId,
        eventId: eventRef.id,
        eventDate,
        reason,
        gestationDays
      });
       }

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "dry_off_save");
    }

    return res.json({
      ok: saved.length > 0,
      message: saved.length
        ? `✅ تم حفظ التجفيف بنجاح لعدد ${saved.length}.`
        : "❌ لم يتم حفظ أي تجفيف.",
      savedCount: saved.length,
      rejectedCount: rejected.length,
      saved,
      rejected,
      redirectUrl: saved.length === 1
        ? `/event-list.html?number=${encodeURIComponent(saved[0].animalNumber)}`
        : ""
    });

  } catch (e) {
    console.error("dry-off-save", e);

    return res.status(500).json({
      ok: false,
      error: "dry_off_save_failed",
      message: "تعذّر حفظ التجفيف – تحقّق من الاتصال والصلاحيات.",
      savedCount: 0,
      rejectedCount: 0,
      saved: [],
      rejected: []
    });
  }
});
// ============================================================
//                 API: ABORTION GATE
//                 تحقق الإجهاض من السيرفر فقط — بدون حفظ
// ============================================================

app.post("/api/abortion/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        error: "firestore_disabled",
        message: "تعذّر التحقق الآن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);

    if (!animalNumber || !eventDate) {
      return res.json({
        ok: true,
        allowed: false,
        silent: true
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        allowed: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا."
      });
    }

    const doc = animal.data || {};

    const st = String(doc.status ?? "").trim().toLowerCase();
    if (st === "inactive") {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له."
      });
    }

    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

    const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

    let species = String(body.species || "").trim() || docSpecies;
    if (/cow|بقر/i.test(species)) species = "أبقار";
    if (/buffalo|جاموس/i.test(species)) species = "جاموس";

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();
    const reproStatus = reproFromEvents || reproFromDoc || "";

    const lastInseminationDate = String(
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      ""
    ).trim();

    const gateData = {
      animalNumber,
      eventDate,
      animalId: animal.id || "",
      species,
      documentData: doc,
      reproductiveStatus: reproStatus,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate,
      lastBoundary: String(signals.lastBoundary || "").trim(),
      lastBoundaryType: String(signals.lastBoundaryType || "").trim()
    };

    const errMsg = abortionDecisionSrv(gateData);

    if (errMsg) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: String(errMsg)
      });
    }

    const derived = calcAbortionAgeAndCauseSrv(lastInseminationDate, eventDate);

    return res.json({
      ok: true,
      allowed: true,
      message: "✅ تم التحقق — أكمل تسجيل الإجهاض.",
      animalId: animal.id || "",
      animalNumber,
      species,
      lastInseminationDate,
      abortionAgeMonths: derived.abortionAgeMonths,
probableCause: derived.probableCause,
probableCauses: derived.probableCauses || [],
abortionDiagnosticMatrix: derived.abortionDiagnosticMatrix || [],
abortionDiagnosticNote: derived.abortionDiagnosticNote || "",
gestationDays: derived.gestationDays,
      signals
    });

  } catch (e) {
    console.error("abortion-gate", e);

    return res.status(500).json({
      ok: false,
      allowed: false,
      error: "abortion_gate_failed",
      message: "❌ تعذّر التحقق من أهلية الإجهاض الآن."
    });
  }
});
// ============================================================
//                 API: ABORTION SAVE
//                 حفظ الإجهاض وتحديث الحيوان من السيرفر فقط
// ============================================================

app.post("/api/abortion/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ الحدث – تحقّق من الاتصال والصلاحيات."
      });
    }

    const uid = req.userId;
    const formData = req.body || {};

    const animalNumber = calvingNormDigitsOnlySrv(
      formData.animalNumber ||
      formData.number ||
      ""
    );

    const eventDate = String(
      formData.eventDate ||
      formData.date ||
      ""
    ).trim().slice(0, 10);

    if (!animalNumber || !eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان وتاريخ الإجهاض مطلوبان."
      });
    }

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا."
      });
    }

    const doc = animal.data || {};

    const st = String(doc.status ?? "").trim().toLowerCase();
    if (st === "inactive") {
      return res.status(400).json({
        ok: false,
        message: "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له."
      });
    }

    const signals = await fetchCalvingSignalsFromEventsSrv(uid, animalNumber);

    const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

    let species = String(formData.species || "").trim() || docSpecies;
    if (/cow|بقر/i.test(species)) species = "أبقار";
    if (/buffalo|جاموس/i.test(species)) species = "جاموس";

    const reproFromEvents = String(signals.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();
    const reproStatus = reproFromEvents || reproFromDoc || "";

    const lastInseminationDate = String(
      formData.lastInseminationDate ||
      signals.lastInseminationDateFromEvents ||
      doc.lastInseminationDate ||
      ""
    ).trim();

    const gateData = {
      animalNumber,
      eventDate,
      animalId: animal.id || "",
      species,
      documentData: doc,
      reproductiveStatus: reproStatus,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate,
      lastBoundary: String(signals.lastBoundary || "").trim(),
      lastBoundaryType: String(signals.lastBoundaryType || "").trim()
    };

    const errMsg = abortionDecisionSrv(gateData);

    if (errMsg) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: String(errMsg)
      });
    }

    const duplicated = await existsAbortionSameDaySrv(uid, animalNumber, eventDate);

    if (duplicated) {
      return res.status(409).json({
        ok: false,
        message: `❌ تم تسجيل إجهاض لهذا الحيوان في نفس اليوم (${eventDate}) من قبل.`
      });
    }

    const derived = calcAbortionAgeAndCauseSrv(lastInseminationDate, eventDate);

    const payload = {
      userId: uid,

      type: "إجهاض",
      eventType: "إجهاض",
      eventTypeNorm: "abortion",

      eventDate,
      animalNumber,
      animalId: String(formData.animalId || animal.id || "").trim(),

      species: species || "",
      reproductiveStatusBefore: reproStatus || "",

      lastInseminationDate,
      lastFertileInseminationDate: lastInseminationDate,

      gestationDays: derived.gestationDays,
      abortionAgeMonths: derived.abortionAgeMonths,
      probableCause: derived.probableCause,
probableCauses: derived.probableCauses || [],
abortionDiagnosticMatrix: derived.abortionDiagnosticMatrix || [],
abortionDiagnosticNote: derived.abortionDiagnosticNote || "",

      notes: String(formData.notes || "").trim(),

      idempotencyKey: `${uid}|${animalNumber}|abortion|${eventDate}`,

      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "server-abortion-save"
    };

    const evRef = await db.collection("events").add(payload);

await updateAnimalByAbortionSrv(payload);

if (typeof scheduleGroupsRebuildSrv === "function") {
  scheduleGroupsRebuildSrv(uid, "abortion_save");
}

return res.json({
  ok: true,
  message: "✅ تم حفظ الإجهاض بنجاح",
  redirectUrl: `/event-list.html?number=${encodeURIComponent(animalNumber)}`,
  eventId: evRef.id,

  animalNumber,
  animalId: payload.animalId,
  eventDate,

  lastInseminationDate,
  gestationDays: derived.gestationDays,
  abortionAgeMonths: derived.abortionAgeMonths,
  probableCause: derived.probableCause,
  probableCauses: derived.probableCauses || [],
  abortionDiagnosticMatrix: derived.abortionDiagnosticMatrix || [],
  abortionDiagnosticNote: derived.abortionDiagnosticNote || ""
});
  } catch (e) {
    console.error("abortion-save", e);

    return res.status(500).json({
      ok: false,
      error: "abortion_save_failed",
      message: "تعذّر حفظ الإجهاض – تحقّق من الاتصال والصلاحيات."
    });
  }
});
// ============================================================
//                 CALVING ANIMAL UPDATE — moved from animal-update.js
//                 نقل جزء type === "calving" كما هو
// ============================================================

async function updateAnimalByCalvingSrv(ev) {
  const tenant = String(ev.userId || "").trim();
  const num = calvingNormDigitsOnlySrv(
    String(
      ev.animalNumber ||
      ev.number ||
      ev.animalId ||
      ""
    ).trim()
  );

  if (!tenant || !num) {
    console.warn("⛔ updateAnimalByCalvingSrv: missing tenant or number", { tenant, num, ev });
    return;
  }

  const date = String(ev.eventDate || "").trim();

  const upd = {
    lastCalvingDate: date,
    reproductiveStatus: "حديث الولادة",
    productionStatus: "fresh",
    daysInMilk: 0,
    status: "active"
  };

  let wantIncLactation = false;

  if (ev.lactationNumber != null) {
    upd.lactationNumber = Number(ev.lactationNumber) || undefined;
  } else {
    wantIncLactation = true;
  }

  // ------------------------------------------------------
  // البحث عن الحيوان — نفس منطق animal-update.js:
  // userId + number string ثم userId + animalNumber Number
  // ------------------------------------------------------
  let snap = await db.collection("animals")
    .where("userId", "==", tenant)
    .where("number", "==", String(num))
    .limit(5)
    .get();

  if (snap.empty) {
    snap = await db.collection("animals")
      .where("userId", "==", tenant)
      .where("animalNumber", "==", Number(num))
      .limit(5)
      .get();
  }

  if (snap.empty) {
    console.warn("⛔ animal not found for calving update:", { tenant, num, ev });
    return;
  }

  for (const d of snap.docs) {
    const cur = d.data() || {};
    const updFinal = { ...upd };

    if (wantIncLactation) {
      const curL = Number(cur.lactationNumber || 0);
      updFinal.lactationNumber = (Number.isFinite(curL) ? curL : 0) + 1;
    }

    await d.ref.set(updFinal, { merge: true });
    console.log("🔥 animal updated by calving:", d.id, updFinal);
  }
}
// ============================================================
//                 ABORTION ANIMAL UPDATE — moved from animal-update.js
//                 نقل تحديث الحيوان بعد الإجهاض للسيرفر فقط
// ============================================================

async function updateAnimalByAbortionSrv(ev) {
  const tenant = String(ev.userId || "").trim();
  const num = calvingNormDigitsOnlySrv(
    String(
      ev.animalNumber ||
      ev.number ||
      ev.animalId ||
      ""
    ).trim()
  );

  if (!tenant || !num) {
    console.warn("⛔ updateAnimalByAbortionSrv: missing tenant or number", { tenant, num, ev });
    return;
  }

  const date = String(ev.eventDate || "").trim();
  const m = Number(ev.abortionAgeMonths);

  const upd = {
    lastAbortionDate: date,
    abortionAgeMonths: Number.isFinite(m) ? Number(m) : null,
    reproductiveStatus: "مفتوحة",
    lastPregnancyLossClass: (Number.isFinite(m) && m >= 5) ? "late" : "early",
    status: "active"
  };

  const wantIncLactationFromAbortion = Number.isFinite(m) && m >= 5;

  // ------------------------------------------------------
  // البحث المركزي عن وثيقة الحيوان
  // يستخدم userId/ownerUid + number/animalNumber
  // ------------------------------------------------------
  const animal = await findAnimalDocByNumberSrv(tenant, num);

  if (!animal || !animal.id) {
    console.warn("⛔ animal not found for abortion update:", { tenant, num, ev });
    return;
  }

  const cur = animal || {};
  const updFinal = { ...upd };

  // ✅ زيادة lactationNumber عند الإجهاض المتأخر (>=5 شهور)
  if (wantIncLactationFromAbortion) {
    const curL = Number(cur.lactationNumber || 0);
    updFinal.lactationNumber = (Number.isFinite(curL) ? curL : 0) + 1;
  }

  await db.collection("animals").doc(animal.id).set(updFinal, { merge: true });
  console.log("🔥 animal updated by abortion:", animal.id, updFinal);
}
// ============================================================
//                 API: CALVING SAVE — moved from calving.html
//                 نقل حفظ الولادة كما هو إلى السيرفر
// ============================================================

app.post("/api/calving/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ الحدث – تحقّق من الاتصال والصلاحيات."
      });
    }

    const uid = req.userId;
    const formData = req.body || {};

    const _animalNumber = calvingNormDigitsOnlySrv(formData.animalNumber || formData.number || "");
    const _eventDate = String(formData.eventDate || formData.date || "").trim().slice(0, 10);

    const animal = await fetchAnimalByNumberForCalvingGateSrv(uid, _animalNumber);

    const doc = animal?.data || null;
    const sig = animal
      ? await fetchCalvingSignalsFromEventsSrv(uid, _animalNumber)
      : {
          reproStatusFromEvents: "",
          lastBoundary: "",
          lastBoundaryType: "",
          lastInseminationDateFromEvents: ""
        };

    const docSpecies = String(doc?.species || doc?.animalTypeAr || "").trim();

    let sp = String(formData.species || "").trim() || docSpecies;
    if (/cow|بقر/i.test(sp)) sp = "أبقار";
    if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

    const reproFromEvents = String(sig.reproStatusFromEvents || "").trim();
    const reproFromDoc = String(doc?.reproductiveStatus || "").trim();
    const repro = reproFromEvents || reproFromDoc || "";

    const lastAI = String(
      formData.lastInseminationDate ||
      sig.lastInseminationDateFromEvents ||
      doc?.lastInseminationDate ||
      ""
    ).trim();

    const payload = {
      userId: uid,
      type: "ولادة",
      eventType: "ولادة",
      eventDate: _eventDate,
      animalNumber: _animalNumber,
      animalId: String(formData.animalId || animal?.id || "").trim(),
      species: sp || "",
      reproStatus: String(formData.reproStatus || "عشار").trim(),
      lastInseminationDate: lastAI,
      lastFertileInseminationDate: lastAI, // توافق قديم

      calvingKind: formData.calvingKind || "",
      calfCount: formData.calfCount || "",
      calf1Sex: formData.calf1Sex || "",
      calfId: formData.calfId || "",
      calf2Sex: formData.calf2Sex || "",
      calf2Id: formData.calf2Id || "",
      calf3Sex: formData.calf3Sex || "",
      calf3Id: formData.calf3Id || "",

      calf1Fate: formData.calf1Fate || "",
      calf2Fate: formData.calf2Fate || "",
      calf3Fate: formData.calf3Fate || "",

      notes: formData.notes || "",
      idempotencyKey: `${_animalNumber}-ولادة-${_eventDate}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const gateData = {
      animalNumber: _animalNumber,
      eventDate: _eventDate,
      animalId: animal?.id || "",
      species: sp,
      documentData: doc,
      reproductiveStatus: repro,
      reproStatusFromEvents: reproFromEvents,
      lastInseminationDate: lastAI,
      lastBoundary: String(sig.lastBoundary || "").trim(),
      lastBoundaryType: String(sig.lastBoundaryType || "").trim()
    };

    const gateErr = calvingDecisionSrv(gateData);
if (gateErr) {
  const raw = String(gateErr || "");
  const hasAbortHint = raw.startsWith("OFFER_ABORT|");

  let cleaned = raw.replace(/^OFFER_ABORT\|/, "");

  if (hasAbortHint) {
    const ageMatch = cleaned.match(/عمر الحمل\s+(\d+)\s+يوم/);
    const ageText = ageMatch ? ` — عمر الحمل ${ageMatch[1]} يوم فقط` : "";

    cleaned = `❌ التاريخ مبكر للولادة${ageText}.\nعدّل التاريخ أو سجّل الحالة كإجهاض.`;
  }

  return res.status(400).json({
    ok: false,
    allowed: false,
    message: cleaned,
    guardError: raw,
    offerAbort: hasAbortHint,
    actions: hasAbortHint ? [
      {
        key: "focus_date",
        label: "تعديل التاريخ",
        focus: "eventDate"
      },
      {
        key: "open_abortion",
        label: "تسجيل إجهاض",
        primary: true,
        url: `/abortion.html?number=${encodeURIComponent(_animalNumber)}&date=${encodeURIComponent(_eventDate)}`
      }
    ] : []
  });
}

    const requiredErr = calvingRequiredFieldsSrv({
      ...payload,
      documentData: doc
    });

    if (requiredErr) {
      if (typeof requiredErr === "string") {
        return res.status(400).json({
          ok: false,
          message: requiredErr,
          errors: [requiredErr],
          fieldErrors: {}
        });
      }

      return res.status(400).json({
        ok: false,
        message: requiredErr.msg || "بيانات الولادة غير مكتملة.",
        errors: [requiredErr.msg || "بيانات الولادة غير مكتملة."],
        fieldErrors: requiredErr.field ? { [requiredErr.field]: requiredErr.msg } : {}
      });
    }

    const isDead = String(payload.calvingKind || "").trim() === "نافقة";

    if (!isDead) {
      const count = parseInt(payload.calfCount || "1", 10) || 1;

      const calfNums = [
        payload.calfId || "",
        count >= 2 ? payload.calf2Id || "" : "",
        count >= 3 ? payload.calf3Id || "" : ""
      ].filter(Boolean);

      const uniqueCheck = await uniqueCalfNumbersSrv({
        userId: uid,
        calfNumbers: calfNums
      });

      if (!uniqueCheck || uniqueCheck.ok === false) {
        return res.status(400).json({
          ok: false,
          message: uniqueCheck?.msg || "⚠️ رقم عجل مكرر في حسابك.",
          errors: [uniqueCheck?.msg || "⚠️ رقم عجل مكرر في حسابك."],
          fieldErrors: {}
        });
      }
    }

    const alreadyExists = await existsCalvingSameDaySrv(
      uid,
      payload.animalNumber,
      payload.eventDate
    );

    if (alreadyExists) {
      return res.status(400).json({
        ok: false,
        message: "⚠️ تم تسجيل ولادة لهذا الحيوان في نفس التاريخ من قبل.",
        errors: ["⚠️ تم تسجيل ولادة لهذا الحيوان في نفس التاريخ من قبل."],
        fieldErrors: {}
      });
    }

    // حفظ حدث الولادة
    const eventRef = await db.collection("events").add(payload);

    // تحديث وثيقة الحيوان
    await updateAnimalByCalvingSrv({
      ...payload,
      type: "calving",
      eventType: "calving"
    });

    // حفظ العجول في calves (لو مش نافقة)
    if (!isDead) {
      const damId = payload.animalId;
      const damNumber = payload.animalNumber;
      const birthDate = payload.eventDate;
      const species = payload.species;

      const calvesToSave = [];
      const count = parseInt(payload.calfCount || "1", 10) || 1;

      const pushCalf = (calfIdField, calfSexField, calfFateField) => {
        const id = String(formData[calfIdField] || "").trim();
        const sex = String(formData[calfSexField] || "").trim();
        const fate = String(formData[calfFateField] || "").trim();
        if (!id || !sex) return;

        calvesToSave.push({
          userId: uid,
          damId,
          damNumber,
          birthDate,
          calfNumber: id,
          sex,
          fate,
          species,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      };

      pushCalf("calfId", "calf1Sex", "calf1Fate");
      if (count >= 2) pushCalf("calf2Id", "calf2Sex", "calf2Fate");
      if (count >= 3) pushCalf("calf3Id", "calf3Sex", "calf3Fate");

      for (const calf of calvesToSave) {
        await db.collection("calves").add(calf);
      }
    }
        // ✅ بعد الولادة: أعد بناء الجروبات تلقائيًا
    // الولادة تنقل الحيوان من الجاف/انتظار الولادة إلى حديث الولادة Fresh
    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "calving_save");
    }
   
return res.json({
  ok: true,
  message: "✅ تم حفظ الولادة وتسجيل العجول بنجاح",
  redirectUrl: `/event-list.html?number=${encodeURIComponent(payload.animalNumber)}`,
  id: eventRef.id,
  eventId: eventRef.id,
  animalNumber: payload.animalNumber,
  animalId: payload.animalId,
  saved: {
    ...payload,
    createdAt: undefined
  }
});
  } catch (err) {
    console.error("calving-save", err);
    return res.status(500).json({
      ok: false,
      error: "calving_save_failed",
      message: "تعذّر حفظ الحدث – تحقّق من الاتصال والصلاحيات."
    });
  }
});
app.post('/api/events', requireUserId, async (req, res) => {
  try {
    const event = req.body || {};
    const tenant = req.userId;
    event.userId = tenant;
   

    if (!event.type || !event.animalId) {
      return res.status(400).json({ ok:false, error:'missing_fields' });
    }

    const events = readJson(eventsPath, []);
    event.id = events.length + 1;
    if (!event.ts) event.ts = Date.now();
    events.push(event);
    fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

      if (db) {
      const t = String(event.type || "").toLowerCase();
      const typeNorm =
        t.includes("insemin") || t.includes("تلقيح")
          ? "insemination"
          : t.includes("preg") || t.includes("حمل")
          ? "pregnancy"
          : t.includes("calv") || t.includes("ولادة")
          ? "birth"
          : t.includes("heat") || t.includes("شياع")
          ? "heat"
          : "event";

      const whenMs = Number(event.ts || Date.now());

      // -------- 1) حفظ الحدث في events --------
     const doc = {
  ...event,   // ← يحفظ كل البيانات القادمة من الصفحة

  userId: tenant,
  animalId: String(event.animalId || ""),
  type: typeNorm,
  date: toYYYYMMDD(whenMs),
  createdAt: admin.firestore.Timestamp.fromMillis(whenMs)
};

      doc.eventTypeNorm = normalizeEventType(event.type);

      try {
        await db.collection("events").add(doc);
      } catch (e) {
        console.error("events.save error:", e.message || e);
      }

      // -------- 2) تجهيز تحديث وثيقة الحيوان --------
      const update = {};
      const evDate = toYYYYMMDD(whenMs);
      const raw    = t;
      const result = String(event.result || event.status || "").toLowerCase();

      // ===== الحالة التناسلية =====
      if (/preg|حمل/.test(raw) && /(positive|ايجاب|عشار|حامل)/.test(result)) {
        update.reproductiveStatus = "pregnant";
        update.lastDiagnosisDate  = evDate;
      }
      else if (/preg|حمل/.test(raw) && /(neg|سلب|فارغ)/.test(result)) {
        update.reproductiveStatus = "open";
        update.lastDiagnosisDate  = evDate;
      }
      else if (/insemin|تلقيح/.test(raw)) {
        update.reproductiveStatus   = "inseminated";
        update.lastInseminationDate = evDate;
      }
      else if (/calv|birth|ولادة/.test(raw)) {
        update.reproductiveStatus = "fresh";
        update.lastCalvingDate    = evDate;
      }
      else if (/abortion|اجهاض/.test(raw)) {
        update.reproductiveStatus = "aborted";
        update.lastAbortionDate   = evDate;
      }

      // ===== الحالة الإنتاجية =====
      if (/milk|لبن/.test(raw)) {
        update.productionStatus = "milking";
      }

      if (/dry|تجفيف|جاف/.test(raw)) {
        update.productionStatus = "dry";
        update.lastDryOffDate   = evDate;
      }

      if (/calv|birth|ولادة/.test(raw)) {
        update.productionStatus = "milking";
      }

      if (/close|تحضير/.test(raw)) {
        update.productionStatus = "close_up";
        update.lastCloseUpDate  = evDate;
      }

      // -------- 3) تطبيق التحديث على animals --------
          // -------- 3) تطبيق التحديث على animals --------
      if (Object.keys(update).length > 0 && event.animalId) {
        try {
          const num = isNaN(Number(event.animalId))
            ? String(event.animalId)
            : Number(event.animalId);

          const snapAnimals = await db
            .collection("animals")
            .where("userId", "==", tenant)
            .where("number", "==", num)
            .limit(10)
            .get();

          for (const d of snapAnimals.docs) {
            await d.ref.set(update, { merge: true });
            console.log("🔥 animal updated:", d.id, update);
          }
        } catch (e) {
          console.error("animals.update error:", e.message || e);
        }
      }
    }

    if (typeof scheduleGroupsRebuildSrv === 'function' && isGroupRebuildEventSrv(event)) {
      scheduleGroupsRebuildSrv(tenant, 'group_affecting_event');
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

   let q = db.collection('alerts').where('userId','==', tenant);

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

// =============================================
//   /api/herd-stats  —  Murabbik Full Edition
// =============================================
app.get("/api/herd-stats", async (req, res) => {
  try {
    const uid = req.headers["x-user-id"];
    const herdType = String(req.query.type || '').trim().toLowerCase();
    if (!uid) return res.json({ ok:false, error:"NO_USER" });

    // --------------------------------------
    // 🔥 1) جلب الحيوانات
    // --------------------------------------
    const snap = await db
      .collection("animals")
      .where("userId", "==", uid)
      .get();

const rawAnimalsAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));

const normalizeAnimalNumberForStats = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, d => ({'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'}[d] || d))
  .replace(/[۰-۹]/g, d => ({'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'}[d] || d))
  .replace(/\s+/g, '')
  .trim();

const animalsSeenForStats = new Map();

for (const a of rawAnimalsAll) {
  const numKey = normalizeAnimalNumberForStats(
    a.animalNumber ??
    a.number ??
    a.calfNumber ??
    a.id
  );

  const key = numKey || String(a.id || '').trim();
  if (!key) continue;

  const patched = {
    ...a,
    animalNumber: numKey || a.animalNumber,
    number: numKey || a.number
  };

  const prev = animalsSeenForStats.get(key);

  // لو فيه تكرار بين رقم عربي/إنجليزي، نفضل السجل الأساسي/الأغنى
  if (!prev) {
    animalsSeenForStats.set(key, patched);
  } else {
    const prevScore =
      (prev.lastCalvingDate ? 3 : 0) +
      (prev.lactationNumber ? 2 : 0) +
      (prev.dailyMilk || prev.lastMilkKg ? 2 : 0) +
      (prev.animaltype || prev.animalTypeAr ? 1 : 0);

    const newScore =
      (patched.lastCalvingDate ? 3 : 0) +
      (patched.lactationNumber ? 2 : 0) +
      (patched.dailyMilk || patched.lastMilkKg ? 2 : 0) +
      (patched.animaltype || patched.animalTypeAr ? 1 : 0);

    if (newScore > prevScore) {
      animalsSeenForStats.set(key, patched);
    }
  }
}

const animalsAll = [...animalsSeenForStats.values()];

const hasCows = animalsAll.some(a => {
  const at = String(a.animaltype || '').trim().toLowerCase();
  const ar = String(a.animalTypeAr || '').trim();
  return at === 'cow' || ar.includes('بقار') || ar.includes('ابقار');
});

const hasBuffalo = animalsAll.some(a => {
  const at = String(a.animaltype || '').trim().toLowerCase();
  const ar = String(a.animalTypeAr || '').trim();
  return at === 'buffalo' || ar.includes('جاموس');
});

const availableTypes = [
  ...(hasCows ? ['cows'] : []),
  ...(hasBuffalo ? ['buffalo'] : [])
];

const singleHerdType =
  hasCows && !hasBuffalo ? 'cows' :
  hasBuffalo && !hasCows ? 'buffalo' :
  null;

const animalsByType = animalsAll.filter(a => {
  const at = String(a.animaltype || '').trim().toLowerCase();
  const ar = String(a.animalTypeAr || '').trim();

  if (herdType === 'cows') {
    return at === 'cow' || ar.includes('بقار') || ar.includes('ابقار');
  }
  if (herdType === 'buffalo') {
    return at === 'buffalo' || ar.includes('جاموس');
  }
  return true;
});

const active = animalsByType.filter(a => {
  const st = String(a.status || a.lifeStatus || "").toLowerCase();
  return !["dead","died","sold","archived","inactive","nafaq","نافق"].includes(st);
});

let total = active.length;
let officialInMilkCount = null;
let officialFeedBandCounts = null;

try {
  const groupPrefix = herdType === 'buffalo' ? 'buffalo_' : 'cow_';

  const getOfficialGroupCount = async (baseKey) => {
    const groupId = `${groupPrefix}${baseKey}`;
    const doc = await db.collection('groups').doc(`${uid}_${groupId}`).get();
    if (!doc.exists) return null;

    const data = doc.data() || {};

    if (Array.isArray(data.animalNumbers)) {
      return data.animalNumbers.map(x => String(x || '').trim()).filter(Boolean).length;
    }

    const n = Number(data.animalsCount ?? data.headCount ?? data.count);
    return Number.isFinite(n) ? n : null;
  };

  const allOfficial = await getOfficialGroupCount('all');
  const freshOfficial = await getOfficialGroupCount('fresh');
  const highOfficial = await getOfficialGroupCount('high');
  const medOfficial = await getOfficialGroupCount('med');
  const lowOfficial = await getOfficialGroupCount('low');

  if (Number.isFinite(Number(allOfficial))) {
    total = Number(allOfficial);
  }

  const milkParts = [freshOfficial, highOfficial, medOfficial, lowOfficial]
    .map(Number)
    .filter(Number.isFinite);

  if (milkParts.length) {
    officialInMilkCount = milkParts.reduce((a, b) => a + b, 0);
  }
  officialFeedBandCounts = {
  fresh: Number(freshOfficial) || 0,
  high: Number(highOfficial) || 0,
  medium: Number(medOfficial) || 0,
  low: Number(lowOfficial) || 0
};
} catch (e) {
  console.error('HERD-STATS official groups count failed:', e.message || e);
}

   // --------------------------------------
// 🔥 2) خصوبة + تعداد + صحة من الوثيقة
// --------------------------------------
let preg = 0,
    aborts = 0,
    servicesSum = 0,
    servicesN = 0,
    openDaysSum = 0,
    openDaysN = 0,
    inMilkCount = 0,
    dimSum = 0,
    dimN = 0,
    openCount = 0,
    bredCount = 0,
    mastitisCount = 0,
    lamenessCount = 0,
    breedIntervalSum = 0,
    breedIntervalN = 0;
    
for (const a of active) {
  const rep  = String(a.reproductiveStatus || a.reproStatus || "").toLowerCase();
  const diag = String(a.lastDiagnosisResult || "").toLowerCase();
  const prod = String(a.productionStatus || a.lactationStatus || "").toLowerCase();
  const health = String(a.healthStatus || a.lastDisease || a.disease || "").toLowerCase();

  const isPreg =
    rep.includes("عشار") ||
    rep.includes("preg") ||
    diag.includes("عشار");

  const isOpen =
    rep.includes("مفتوح") ||
    rep.includes("open");

  const isBred =
    rep.includes("ملقح") ||
    rep.includes("bred") ||
    rep.includes("inseminated");

  const isInMilkDoc =
    a.inMilk === true ||
    (
      a.inMilk !== false &&
      !prod.includes("dry") &&
      !prod.includes("جاف") &&
      (
        prod.includes("milk") ||
        prod.includes("lact") ||
        prod.includes("حلاب") ||
        prod.includes("محلب") ||
        prod.includes("منتج")
      )
    );

  if (isInMilkDoc) inMilkCount++;

  const dim = Number(a.daysInMilk || 0);
  if (Number.isFinite(dim) && dim >= 0) {
    dimSum += dim;
    dimN++;
  }

  if (isOpen) openCount++;
  if (isBred) bredCount++;

  if (health.includes("ضرع") || health.includes("mastitis")) mastitisCount++;
  if (health.includes("عرج") || health.includes("lameness")) lamenessCount++;

  if (isPreg) {
    preg++;

    const sc = Number(a.servicesCount || 0);
    if (sc > 0) {
      servicesSum += sc;
      servicesN++;
    }

    const calv = a.lastCalvingDate ? new Date(a.lastCalvingDate) : null;
    const ins  = a.lastInseminationDate ? new Date(a.lastInseminationDate) : null;

    if (calv && ins) {
      const d = Math.floor((ins - calv) / 86400000);
      if (d >= 0 && d < 400) {
        openDaysSum += d;
        openDaysN++;
      }
    }
  }

  if (a.lastAbortionDate) aborts++;
}
try {
  const evSnapBreed = await db.collection("events")
    .where("userId", "==", uid)
    .limit(5000)
    .get();

  const evBreed = evSnapBreed.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

const inseminationEvents = evBreed
  .map(e => {
    const normType = normalizeEventType(
      e.eventTypeNorm || e.eventType || e.type || ""
    );

    const evDate = computeEventDateFromDoc(e);

    return {
      ...e,
      _normType: normType,
      _eventDate: evDate
    };
  })
  .filter(e => e._normType === "insemination" && e._eventDate);

const byAnimal = new Map();

for (const e of inseminationEvents) {
  const animalKey = String(
    e.animalNumber ??
    e.number ??
    e.animalId ??
    ""
  ).trim();

  const ms = new Date(e._eventDate).getTime();

  if (!animalKey || !Number.isFinite(ms)) continue;

  if (!byAnimal.has(animalKey)) byAnimal.set(animalKey, []);
  byAnimal.get(animalKey).push(ms);
}
  for (const arr of byAnimal.values()) {
    arr.sort((a, b) => a - b);

    for (let i = 1; i < arr.length; i++) {
      const diffDays = Math.round((arr[i] - arr[i - 1]) / 86400000);
      if (diffDays >= 1 && diffDays <= 365) {
        breedIntervalSum += diffDays;
        breedIntervalN++;
      }
    }
  }
} catch (e) {
  console.error("BREED INTERVAL ERROR", e);
}
const pregPct = total ? Math.round((preg * 100) / total) : 0;
if (officialInMilkCount !== null) inMilkCount = officialInMilkCount;
const inMilkPct = total ? Math.round((inMilkCount * 100) / total) : 0;
const openPct = total ? Math.round((openCount * 100) / total) : 0;
const bredPct = total ? Math.round((bredCount * 100) / total) : 0;
const mastitisPct = inMilkCount ? Math.round((mastitisCount * 100) / inMilkCount) : 0;
const lamenessPct = total ? Math.round((lamenessCount * 100) / total) : 0;
const avgDIM = dimN ? Math.round(dimSum / dimN) : 0;

const servicesPerConception =
  servicesN ? +(servicesSum / servicesN).toFixed(2) : 0;
const conceptionPct =
  servicesPerConception ? Math.round(100 / servicesPerConception) : 0;
const openDaysAvg =
  openDaysN ? Math.round(openDaysSum / openDaysN) : 0;
const abortPct =
  (preg + aborts) ? Math.round((aborts * 100) / (preg + aborts)) : 0;

const avgBreedIntervalDays =
  breedIntervalN ? Math.round(breedIntervalSum / breedIntervalN) : 0;


    // --------------------------------------
    // 🔥 3) نفوق + استبعاد
    // --------------------------------------
let cullProd = 0, cullRepro = 0, cullHealth = 0;

try {
  const evSnap = await db.collection("events")
    .where("userId", "==", uid)
    .limit(5000)
    .get();

const ev = evSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

  const cullEvents = ev.filter(e => {
    const txt = String(e.eventType || e.type || e.eventTypeNorm || "").toLowerCase();
    return txt.includes("استبعاد") || txt.includes("cull");
  });

 for (const e of cullEvents) {
  const evAnimalNo = String(e.animalNumber || e.animalId || '').trim();

 const matchedAnimal = animalsByType.find(a =>
    String(a.animalNumber || a.number || a.id || '').trim() === evAnimalNo
  );

  if (!matchedAnimal) continue;

  const main = String(e.cullMain || e.reason || "").toLowerCase();

  if (main.includes("انتاج")) cullProd++;
  else if (main.includes("تناسل")) cullRepro++;
  else if (main.includes("صح")) cullHealth++;
}
} catch (e) {
  console.error("cull events error:", e.message || e);
}

const cullProdPct   = total ? Math.round((cullProd * 100) / total) : 0;
const cullReproPct  = total ? Math.round((cullRepro * 100) / total) : 0;
const cullHealthPct = total ? Math.round((cullHealth * 100) / total) : 0;
 
    // --------------------------------------
    // 🔥 4) كاميرا
    // --------------------------------------
    const bcsVals = active.map(a => Number(a.lastBCS || 0)).filter(x=>x>0);
    const fecesVals = active.map(a => Number(a.lastFecesScore || 0)).filter(x=>x>0);

    const bcsCamera   = bcsVals.length ? +(bcsVals.reduce((a,b)=>a+b,0)/bcsVals.length).toFixed(2) : 0;
    const fecesScore  = fecesVals.length ? +(fecesVals.reduce((a,b)=>a+b,0)/fecesVals.length).toFixed(2) : 0;
 // --------------------------------------
// 🔥 5) إنتاج اللبن من أحداث آخر 7 أيام + الشهر الحالي
// --------------------------------------
let dailyMilkTotal = 0;
let avgHeadToday = 0;
let avgHead7Days = 0;
let monthlyMilkTotal = 0;

let prevDailyMilkTotal = 0;
let prevAvgHeadToday = 0;
let dailyMilkDeltaPct = 0;
let avgHeadDeltaPct = 0;

    
try {
  const evSnapMilk = await db.collection("events")
    .where("userId", "==", uid)
    .limit(5000)
    .get();

  const evMilkAll = evSnapMilk.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

  const animalNosSet = new Set(
    animalsByType.map(a => String(a.animalNumber || a.number || a.id || '').trim())
  );

  const milkEvents = evMilkAll.filter(e => {
    const txt = String(e.eventTypeNorm || e.eventType || e.type || "").toLowerCase().trim();
    const no = String(e.animalNumber || e.number || e.animalId || '').trim();

    return (
      animalNosSet.has(no) &&
      (
        txt === "daily_milk" ||
        txt === "لبن يومي"
      )
    );
  });

 let latestMilkDay = null;
const dayMap = new Map();

for (const e of milkEvents) {
  const d = toDate(e.eventDate || e.date || e.createdAt || e.timestamp);
  if (!d || isNaN(d.getTime())) continue;

  const dayOnly = new Date(d);
  dayOnly.setHours(0,0,0,0);

  const milkVal = Number(
    e.totalMilk ??
    e.dailyMilk ??
    e.milkKg ??
    e.milk ??
    e.value ??
    0
  );

  if (!Number.isFinite(milkVal) || milkVal <= 0) continue;

  if (!latestMilkDay || dayOnly.getTime() > latestMilkDay.getTime()) {
    latestMilkDay = new Date(dayOnly);
  }

  const key = dayOnly.toISOString().slice(0,10);
  if (!dayMap.has(key)) {
    dayMap.set(key, { totalMilk: 0, heads: new Set() });
  }
  const rec = dayMap.get(key);
  rec.totalMilk += milkVal;
  rec.heads.add(String(e.animalNumber || e.number || e.animalId || '').trim());
}

if (latestMilkDay) {
  const start7 = new Date(latestMilkDay);
  start7.setDate(start7.getDate() - 6);

  const startMonth = new Date(latestMilkDay.getFullYear(), latestMilkDay.getMonth(), 1);

  let sumDailyHeadAvg = 0;
let daysWithMilk = 0;

  for (const [key, rec] of dayMap.entries()) {
    const d = new Date(key + 'T00:00:00');

    if (d.getTime() === latestMilkDay.getTime()) {
      dailyMilkTotal += rec.totalMilk;
    }

    if (d >= startMonth && d <= latestMilkDay) {
      monthlyMilkTotal += rec.totalMilk;
    }
  }

for (let i = 0; i < 7; i++) {
  const d = new Date(start7);
  d.setDate(start7.getDate() + i);
  const key = d.toISOString().slice(0,10);

  const rec = dayMap.get(key);
  if (!rec || !rec.heads.size) continue;

  sumDailyHeadAvg += rec.totalMilk / rec.heads.size;
  daysWithMilk++;
}

dailyMilkTotal = +dailyMilkTotal.toFixed(1);
avgHead7Days = daysWithMilk ? +(sumDailyHeadAvg / daysWithMilk).toFixed(1) : 0;
monthlyMilkTotal = +monthlyMilkTotal.toFixed(1);

const sortedKeys = [...dayMap.keys()].sort();
console.log("MILK sortedKeys =", sortedKeys);
console.log("MILK latestKey =", sortedKeys[sortedKeys.length - 1] || null);
console.log("MILK prevKey =", sortedKeys[sortedKeys.length - 2] || null);
const latestKey = sortedKeys.length ? sortedKeys[sortedKeys.length - 1] : null;
const prevKey   = sortedKeys.length > 1 ? sortedKeys[sortedKeys.length - 2] : null;

const latestRec = latestKey ? dayMap.get(latestKey) : null;
const prevRec   = prevKey ? dayMap.get(prevKey) : null;
console.log("MILK latestRec =", latestRec);
console.log("MILK prevRec =", prevRec);
avgHeadToday = (latestRec && latestRec.heads.size)
  ? +(latestRec.totalMilk / latestRec.heads.size).toFixed(1)
  : 0;

prevDailyMilkTotal = prevRec ? +Number(prevRec.totalMilk || 0).toFixed(1) : 0;
prevAvgHeadToday = (prevRec && prevRec.heads.size)
  ? +(prevRec.totalMilk / prevRec.heads.size).toFixed(1)
  : 0;

dailyMilkDeltaPct = prevDailyMilkTotal > 0
  ? +(((dailyMilkTotal - prevDailyMilkTotal) / prevDailyMilkTotal) * 100).toFixed(1)
  : 0;

avgHeadDeltaPct = prevAvgHeadToday > 0
  ? +(((avgHeadToday - prevAvgHeadToday) / prevAvgHeadToday) * 100).toFixed(1)
  : 0;
  console.log("MILK dailyMilkTotal =", dailyMilkTotal);
console.log("MILK prevDailyMilkTotal =", prevDailyMilkTotal);
console.log("MILK avgHeadToday =", avgHeadToday);
console.log("MILK prevAvgHeadToday =", prevAvgHeadToday);
console.log("MILK dailyMilkDeltaPct =", dailyMilkDeltaPct);
console.log("MILK avgHeadDeltaPct =", avgHeadDeltaPct);
}
} catch (e) {
  console.error("milk stats error:", e.message || e);
}
    // --------------------------------------
    // 🔥 5) خصوبة 21 يوم من الأحداث (FERTILITY EVENTS)
    // --------------------------------------
    let extraFertility = { scPlus:0, hdr21:0, cr21:0, pr21:0, firstServicePct:0 };

    try {
      const evSnap = await db.collection("events")
        .where("userId", "==", uid)
        .limit(5000)
        .get();

     const ev = evSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

      const heats = ev.filter(e => e.eventTypeNorm === "heat" && e.eventDate);
      const ins   = ev.filter(e => e.eventTypeNorm === "insemination" && e.eventDate);
      const pregP = ev.filter(e =>
        e.eventTypeNorm === "pregnancy_diagnosis" &&
        (String(e.result).includes("عشار") || String(e.result).includes("positive"))
      );

      heats.forEach(e => e.ms = new Date(e.eventDate).getTime());
      ins.forEach(e => e.ms = new Date(e.eventDate).getTime());
      pregP.forEach(e => e.ms = new Date(e.eventDate).getTime());
      const pregByAnimal = new Map();

for (const e of pregP) {
  const animalKey = String(
    e.animalNumber ??
    e.number ??
    e.animalId ??
    ""
  ).trim();

  if (!animalKey || !Number.isFinite(e.ms)) continue;

  if (!pregByAnimal.has(animalKey)) pregByAnimal.set(animalKey, []);
  pregByAnimal.get(animalKey).push(e.ms);
}

for (const arr of pregByAnimal.values()) {
  arr.sort((a, b) => a - b);
}
      // --- S/C+ ---
      let sc_total=0, sc_conc=0;
      for (const p of pregP) {
        const linked = ins.filter(i =>
          i.animalId === p.animalId &&
          i.ms <= p.ms &&
          (p.ms - i.ms) <= 90*86400000
        );
        if (linked.length) {
          sc_conc++;
          sc_total += linked.length;
        }
      }
      const scPlus = sc_conc ? +(sc_total / sc_conc).toFixed(2) : 0;

      // --- 21d window ---
      const now = Date.now();
      const win = now - 21*86400000;

      const heats21 = heats.filter(e=>e.ms >= win);
      const ins21   = ins.filter(e=>e.ms >= win);
      const preg21  = pregP.filter(e=>e.ms >= win);

      const eligible = active.filter(a=>{
        if (!a.lastCalvingDate) return false;
        const dim = (now - new Date(a.lastCalvingDate)) / 86400000;
        return dim>=40 && dim<=300 &&
               !String(a.reproductiveStatus).includes("عشار");
      }).length;

      const hdr21 = eligible ? Math.round((heats21.length*100)/eligible) : 0;
      const cr21  = ins21.length ? Math.round((preg21.length*100)/ins21.length) : 0;
     const pr21  = Math.round((hdr21/100) * cr21);

// --- First service conception ---
let firstServiceEligible = 0;
let firstServiceSuccess = 0;

for (const [animalKey, insArr] of byAnimal.entries()) {
  if (!insArr.length) continue;

  const firstInsMs = insArr[0];
  firstServiceEligible++;

  const pregArr = pregByAnimal.get(animalKey) || [];
  const hit = pregArr.some(ms => ms >= firstInsMs && ms <= (firstInsMs + 90*86400000));

  if (hit) firstServiceSuccess++;
}

const firstServicePct = firstServiceEligible
  ? Math.round((firstServiceSuccess * 100) / firstServiceEligible)
  : 0;

extraFertility = { scPlus, hdr21, cr21, pr21, firstServicePct };

    } catch(e){
      console.error("FERTILITY EVENT ERROR", e);
    }
    // --------------------------------------
    // 🔥 5.5) التغذية — إجمالي + عالي/متوسط/منخفض
    // --------------------------------------
let feedBands = {
  overall: emptyFeedBand(),
  high: emptyFeedBand(),
  medium: emptyFeedBand(),
  low: emptyFeedBand(),
  fresh: emptyFeedBand()
};

    try {
      const evSnapNut = await db.collection("events")
        .where("userId", "==", uid)
        .limit(5000)
        .get();

      const evNutAll = evSnapNut.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
const isLactatingNutritionEventForDashboard = (e = {}) => {
  const ctx = e?.nutrition?.context || {};
  const groupText = String(
    ctx.groupType ||
    ctx.groupName ||
    ctx.group ||
    ctx.groupLabel ||
    e.groupType ||
    e.groupName ||
    e.group ||
    ''
  ).toLowerCase();

  const isDryOrClose =
    ctx.earlyDry === true ||
    ctx.closeUp === true ||
    /جاف|dry|انتظار|تحضير|close/i.test(groupText) ||
    /جاف|dry|انتظار|تحضير|close/i.test(String(ctx.pregnancyStatus || ''));

  if (isDryOrClose) return false;

  const milkKg = Number(
    ctx.avgMilkKg ??
    ctx.observedAvgMilkKg ??
    e?.nutrition?.analysis?.economics?.milkRevenue ??
    0
  );

  const looksLactating =
    /حلاب|عالي|متوسط|منخفض|milk|lact/i.test(groupText) ||
    milkKg > 0;

  return looksLactating;
};
const nutritionEvents = evNutAll
  .map(e => {
    const txt = String(e.eventTypeNorm || e.eventType || e.type || '').toLowerCase().trim();
    const ms = getEventMsSrv(e);

    const ctxSpecies = String(
      e?.nutrition?.context?.species ||
      e?.species ||
      e?.animalTypeAr ||
      e?.animaltype ||
      ''
    ).trim().toLowerCase();

    const matchesType =
      herdType === 'cows'
        ? (ctxSpecies.includes('بقر') || ctxSpecies.includes('cow'))
        : herdType === 'buffalo'
          ? (ctxSpecies.includes('جاموس') || ctxSpecies.includes('buffalo'))
          : true;

    return { ...e, _txt: txt, _ms: ms, _matchesType: matchesType };
  })
.filter(e =>
  (
    e._txt === 'nutrition' ||
    e._txt === 'nutrition_group' ||
    e._txt.includes('nutrition') ||
    e._txt.includes('تغذية')
  ) &&
  e?.nutrition?.analysis &&
  e._matchesType &&
  isLactatingNutritionEventForDashboard(e)
);
      const latestByBand = new Map();

      for (const e of nutritionEvents) {
        const rawGroup =
          e?.nutrition?.context?.group ||
          e?.group ||
          e?.groupName ||
          '';

        const band =
          String(e.type || '').toLowerCase() === 'nutrition_group'
            ? feedBandKey(rawGroup)
            : (rawGroup ? feedBandKey(rawGroup) : 'overall');

        const prev = latestByBand.get(band);
        if (!prev || Number(e._ms || 0) > Number(prev._ms || 0)) {
          latestByBand.set(band, e);
        }
      }

      if (latestByBand.has('high')) {
        feedBands.high = buildFeedBandFromEvent(latestByBand.get('high'), officialFeedBandCounts?.high);
      }
      if (latestByBand.has('medium')) {
        feedBands.medium = buildFeedBandFromEvent(latestByBand.get('medium'), officialFeedBandCounts?.medium);
      }
      if (latestByBand.has('low')) {
        feedBands.low = buildFeedBandFromEvent(latestByBand.get('low'), officialFeedBandCounts?.low);
      }
      if (latestByBand.has('fresh')) {
        feedBands.fresh = buildFeedBandFromEvent(latestByBand.get('fresh'), officialFeedBandCounts?.fresh);
      }
feedBands.overall = weightedFeedBands([
  feedBands.high,
  feedBands.medium,
  feedBands.low,
  feedBands.fresh
]);
    } catch (e) {
      console.error("FEED BANDS ERROR:", e.message || e);
    }
    // --------------------------------------
    // 🔥 6) RETURN — النتيجة النهائية للداشبورد
    // --------------------------------------
return res.json({
  ok: true,

  totals: {
    totalActive: total,
    pregnant: { count: preg, pct: pregPct },
  },

fertility: {
  servicesPerConception,
  conceptionRatePct: conceptionPct,
  scPlus: extraFertility.scPlus,
  hdr21: extraFertility.hdr21,
  cr21: extraFertility.cr21,
  pr21: extraFertility.pr21,
  firstServicePct: extraFertility.firstServicePct
},
// ===== الحقول التي ينتظرها الداشبورد مباشرة =====
servicesPerConception,
conceptionRatePct: conceptionPct,
inMilkCount,
  inMilkPct,
  openCount,
  openPct,
  bredCount,
  bredPct,
  mastitisCount,
  mastitisPct,
  lamenessCount,
  lamenessPct,
  avgDIM,

openDaysAvg,
abortionCount: aborts,
abortionRatePct: abortPct,
avgBreedIntervalDays,
heatDetectionRatePct: extraFertility.hdr21,
pregRate21d: extraFertility.pr21,
firstServiceConceptionPct: extraFertility.firstServicePct,

  cullTotal: cullProd + cullRepro + cullHealth,
  cullTotalPct: total ? Math.round(((cullProd + cullRepro + cullHealth) * 100) / total) : 0,

  cullProdCount: cullProd,
  cullReproCount: cullRepro,
  cullHealthCount: cullHealth,

  cullProdPct,
  cullReproPct,
  cullHealthPct,

  culling: {
    productivity: cullProdPct,
    reproduction: cullReproPct,
    health: cullHealthPct
  },

// ===== التغذية: إجمالي + شرائح الإنتاج =====
feedCostPerLiter: feedBands.overall.feedCostPerLiter,
feedEfficiency: feedBands.overall.feedEfficiency,
feedCostPerHeadPerDay: feedBands.overall.feedCostPerHeadPerDay,
iofc: feedBands.overall.iofc,

totalFeedCostPerDay: feedBands.overall.totalFeedCostPerDay ?? feedBands.overall.totalFeedCost ?? 0,
totalMilkFeedMarginPerDay: feedBands.overall.totalMilkFeedMarginPerDay ?? feedBands.overall.totalMargin ?? 0,
totalIofcPerDay: feedBands.overall.totalIofc ?? feedBands.overall.totalMargin ?? 0,
iofcPctOfMilkIncome: feedBands.overall.iofcPctOfMilkIncome ?? 0,
feedCostPctOfMilkIncome: feedBands.overall.feedCostPctOfMilkIncome ?? 0,
feedAdvice: buildDashboardFeedAdviceSrv(feedBands.overall),
feedGaugeCards: buildDashboardFeedGaugeCardsSrv(feedBands.overall),

feedBands,

dailyMilkTotal,
avgHeadToday,
avgHead7Days,
monthlyMilkTotal,
dailyMilkDeltaPct,
avgHeadDeltaPct,
bcsCamera,
fecesScore,

hasCows,
hasBuffalo,
availableTypes,
singleHerdType
});
  } catch (e) {
    console.error("HERD-STATS ERROR:", e);
    return res.json({ ok:false, error:e.message });
  }
});
// ============================================================
//                 HEAT / شياع — SERVER DECISION HELPERS
// ============================================================

function heatStripArSrv(s){
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "");
}

function heatReproCategorySrv(raw){
  const n = heatStripArSrv(raw);

  if (n.includes("لاتلقح") || n.includes("لاتلقحمرةاخرى")) return "blocked";
  if (n.includes("عشار")) return "pregnant";
  if (n.includes("ملقح") || n.includes("ملقحة") || n.includes("ملقّحة")) return "inseminated";
  if (n.includes("مفتوح") || n.includes("فارغ") || n.includes("فارغة")) return "open";

  return "unknown";
}

function heatAnimalWordSrv(species){
  return normalizeSpeciesSrv(species) === "جاموس" ? "جاموسة" : "بقرة";
}

function heatPickSpeciesSrv(animal = {}, body = {}){
  return normalizeSpeciesSrv(
    body.species ||
    animal.species ||
    animal.animalTypeAr ||
    animal.animalType ||
    animal.animaltype ||
    animal.groupSpecies ||
    ""
  );
}

function heatCurrentReproStatusSrv(animal = {}, fallback = ""){
  return String(
    animal.reproductiveStatus ||
    animal.reproStatus ||
    animal.lastDiagnosis ||
    fallback ||
    ""
  ).trim();
}

function heatDecisionSrv({ animal = {}, species = "", reproductiveStatus = "" } = {}){
  if (!animal || !Object.keys(animal).length) {
    return "❌ تعذّر العثور على الحيوان.";
  }

  const st = String(animal.status ?? "").trim().toLowerCase();
  if (st === "inactive" || st === "archived") {
    return "❌ الحيوان خارج القطيع.";
  }

  const sp = heatPickSpeciesSrv(animal, { species });
  const aw = heatAnimalWordSrv(sp);

  const rsRaw = heatCurrentReproStatusSrv(animal, reproductiveStatus);
  const cat = heatReproCategorySrv(rsRaw);

  if (animal.breedingBlocked === true || cat === "blocked") {
    return `❌ هذه ${aw} مستبعدة تناسليًا — لا تُلقّح مرة أخرى.`;
  }

  if (cat === "pregnant") {
    return `❌ هذه ${aw} عِشار — لا يمكن تسجيل شياع.`;
  }

  return null;
}

async function heatDuplicateCheckSrv(uid, animalNumber, eventDate, windowDays = 3){
  const num = normalizeDigitsSrv(animalNumber || "");
  const dt = String(eventDate || "").slice(0,10);

  if (!uid || !num || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) return null;

  const candidates = [];
  const vals = findAnimalNumberMatches(num);

  for (const field of ["animalNumber", "number"]) {
    for (const v of vals) {
      try {
        const snap = await db.collection("events")
          .where("userId", "==", uid)
          .where(field, "==", v)
          .limit(120)
          .get();

        snap.docs.forEach(ds => candidates.push(ds.data() || {}));
      } catch (e) {
        console.error("heat duplicate check failed:", e.message || e);
        return "⚠️ تعذّر التحقق من تكرار الشياع الآن. أعد المحاولة بعد لحظات.";
      }
    }
  }

  const cur = new Date(dt + "T00:00:00");
  if (Number.isNaN(cur.getTime())) return null;

  let bestDate = "";
  let bestDiff = 999999;

  for (const ev of candidates) {
    const txt = eventTextSrv(ev);
    const isHeat =
      txt.includes("شياع") ||
      txt.includes("heat");

    if (!isHeat) continue;

    const d = computeEventDateFromDoc(ev);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) continue;

    const last = new Date(d + "T00:00:00");
    if (Number.isNaN(last.getTime())) continue;

    const diff = Math.floor((cur - last) / 86400000);

    if (diff >= 0 && diff <= Number(windowDays)) {
      if (diff < bestDiff) {
        bestDiff = diff;
        bestDate = d;
      }
    }
  }

  if (!bestDate) return null;

  if (bestDate === dt) {
    return `❌ تم تسجيل شياع للحيوان رقم ${num} في نفس اليوم (${dt}).`;
  }

  return `❌ تم تسجيل شياع للحيوان رقم ${num} بتاريخ ${bestDate}. لا يمكن تكرار التسجيل خلال ${windowDays} أيام.`;
}

async function buildHeatContextSrv(uid, animalNumber, eventDate){
  const num = normalizeDigitsSrv(animalNumber || "");
  const dt = String(eventDate || "").slice(0,10);

  if (!num) {
    return { ok:false, status:400, error:"animalNumber_required", message:"❌ رقم الحيوان مطلوب." };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    return { ok:false, status:400, error:"eventDate_required", message:"❌ تاريخ الشياع غير صالح." };
  }

  const animal = await findAnimalDocByNumberSrv(uid, num);
  if (!animal) {
    return { ok:false, status:404, error:"animal_not_found", message:"❌ رقم الحيوان غير موجود في حسابك." };
  }

  const species = heatPickSpeciesSrv(animal);
  const reproductiveStatus = heatCurrentReproStatusSrv(animal);

  let dimAtEvent = null;
  const lastCalvingDate = String(animal.lastCalvingDate || "").slice(0,10);

  if (/^\d{4}-\d{2}-\d{2}$/.test(lastCalvingDate)) {
    dimAtEvent = daysBetweenIsoSrv(lastCalvingDate, dt);
    if (dimAtEvent != null && dimAtEvent < 0) dimAtEvent = 0;
  }

  const lastEvent = await getLatestHeatOrInseminationSrv(uid, num, dt);

  let lastEventType = null;
  let lastEventDate = null;
  let daysSinceLastHeatOrAI = null;

  if (lastEvent?._eventDate) {
    lastEventDate = lastEvent._eventDate;
    lastEventType = lastEvent._typeNorm;
    daysSinceLastHeatOrAI = daysBetweenIsoSrv(lastEventDate, dt);
    if (daysSinceLastHeatOrAI != null && daysSinceLastHeatOrAI < 0) {
      daysSinceLastHeatOrAI = null;
    }
  }

  const decisionMsg = heatDecisionSrv({
    animal,
    species,
    reproductiveStatus
  });

  const duplicateMsg = await heatDuplicateCheckSrv(uid, num, dt, 3);

  return {
    ok: true,
    allowed: !decisionMsg && !duplicateMsg,
    message: decisionMsg || duplicateMsg || "✅ تم التحقق — يمكن تسجيل الشياع.",
    animal,
    animalId: String(animal.id || animal.animalId || num),
    animalNumber: String(animal.animalNumber || animal.number || num),
    species,
    reproductiveStatus,
    dimAtEvent,
    lastEventType,
    lastEventDate,
    daysSinceLastHeatOrAI
  };
}
// ============================================================
//                 API: HEAT CONTEXT (server-only)
// ============================================================
app.get('/api/heat/context', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const ctx = await buildHeatContextSrv(
      req.userId,
      req.query.animalNumber || "",
      req.query.eventDate || ""
    );

    if (!ctx.ok) {
      return res.status(ctx.status || 400).json(ctx);
    }

    return res.json({
      ok: true,
      allowed: ctx.allowed,
      message: ctx.message,
      animalId: ctx.animalId,
      animalNumber: ctx.animalNumber,
      species: ctx.species,
      reproductiveStatus: ctx.reproductiveStatus,
      dimAtEvent: ctx.dimAtEvent,
      lastEventType: ctx.lastEventType,
      lastEventDate: ctx.lastEventDate,
      daysSinceLastHeatOrAI: ctx.daysSinceLastHeatOrAI
    });

  } catch (e) {
    console.error('heat-context', e);
    return res.status(500).json({
      ok:false,
      error:'heat_context_failed',
      message:"تعذّر التحقق من الشياع الآن."
    });
  }
});
// ============================================================
//                 API: HEAT GATE (server-only)
// ============================================================
app.post('/api/heat/gate', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const body = req.body || {};
    const raw = String(body.animalNumber || body.animalNumbers || body.number || "").trim();
    const eventDate = String(body.eventDate || body.date || "").slice(0,10);

    const nums = raw
      .split(/[\s,،;]+/)
      .map(x => normalizeDigitsSrv(x))
      .filter(Boolean);

    if (!nums.length) {
      return res.status(400).json({
        ok:false,
        allowed:false,
        message:"❌ رقم الحيوان مطلوب."
      });
    }

    const results = [];

    for (const n of nums) {
      const ctx = await buildHeatContextSrv(req.userId, n, eventDate);

      results.push({
        animalNumber: n,
        ok: !!ctx.ok,
        allowed: !!ctx.allowed,
        message: ctx.message || ctx.error || "تعذّر التحقق.",
        animalId: ctx.animalId || "",
        species: ctx.species || "",
        reproductiveStatus: ctx.reproductiveStatus || "",
        dimAtEvent: ctx.dimAtEvent ?? null,
        lastEventType: ctx.lastEventType || null,
        lastEventDate: ctx.lastEventDate || null,
        daysSinceLastHeatOrAI: ctx.daysSinceLastHeatOrAI ?? null
      });
    }

    const allowedNumbers = results.filter(x => x.allowed).map(x => x.animalNumber);
    const rejected = results.filter(x => !x.allowed);

    return res.json({
      ok: true,
      allowed: allowedNumbers.length > 0,
      animalNumbers: allowedNumbers,
      rejected,
      results,
      message: rejected.length
        ? `تم التحقق — صالح: ${allowedNumbers.length} / مرفوض: ${rejected.length}`
        : "✅ تم التحقق — يمكن تسجيل الشياع."
    });

  } catch (e) {
    console.error('heat-gate', e);
    return res.status(500).json({
      ok:false,
      allowed:false,
      error:'heat_gate_failed',
      message:"تعذّر التحقق من الشياع الآن."
    });
  }
});
// ============================================================
//                 API: HEAT SAVE (server-only)
// ============================================================
app.post('/api/heat/save', requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok:false,
        error:'firestore_disabled',
        message:"قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const raw = String(
      body.animalNumber ||
      body.animalNumbers ||
      body.number ||
      ""
    ).trim();

    const eventDate = String(body.eventDate || body.date || '').slice(0,10);
    const heatTime = String(body.heatTime || '').trim();
    const notes = String(body.notes || '').trim() || null;

    const nums = [...new Set(
      raw
        .split(/[\s,،;]+/)
        .map(x => normalizeDigitsSrv(x))
        .filter(Boolean)
    )];

    if (!nums.length) {
      return res.status(400).json({
        ok:false,
        allowed:false,
        error:'animalNumber_required',
        message:"❌ رقم الحيوان مطلوب."
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({
        ok:false,
        allowed:false,
        error:'eventDate_required',
        message:"❌ تاريخ الشياع مطلوب."
      });
    }

    if (!heatTime) {
      return res.status(400).json({
        ok:false,
        allowed:false,
        error:'heatTime_required',
        message:"❌ وقت ملاحظة الشياع مطلوب."
      });
    }

    const saved = [];
    const rejected = [];

    for (const animalNumber of nums) {
      try {
        const ctx = await buildHeatContextSrv(uid, animalNumber, eventDate);

        if (!ctx?.ok || !ctx?.allowed) {
          rejected.push({
            animalNumber,
            message: ctx?.message || ctx?.error || "❌ الحيوان غير مؤهل لتسجيل الشياع."
          });
          continue;
        }

        const animal = ctx.animal || {};

        const payload = {
          animalNumber: String(ctx.animalNumber || animal.animalNumber || animal.number || animalNumber),
          animalId: String(ctx.animalId || animal.id || animal.animalId || animalNumber),

          type: "شياع",
          eventType: "شياع",
          eventTypeNorm: "heat",
          eventDate,
          heatTime,
          notes,

          reproductiveStatusSnapshot: ctx.reproductiveStatus || null,
          dimAtEvent: ctx.dimAtEvent ?? null,
          daysSinceLastHeatOrAI: ctx.daysSinceLastHeatOrAI ?? null,

          userId: uid,
          source: "server:/api/heat/save",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const evRef = await db.collection('events').add(payload);

        const animalRef = await findAnimalDocRefByNumberForTenant(uid, animalNumber);

        if (animalRef) {
          await animalRef.ref.set({
            lastHeatDate: eventDate,
            lastHeatTime: heatTime,
            lastHeatEventId: evRef.id,
            reproductiveStatus: "مفتوحة",
            status: "active",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge:true });
        }

        saved.push({
          animalNumber: payload.animalNumber,
          animalId: payload.animalId,
          eventId: evRef.id
        });

      } catch (oneErr) {
        console.error('heat-save-one', animalNumber, oneErr);

        rejected.push({
          animalNumber,
          message:"❌ تعذّر حفظ الشياع لهذا الرقم."
        });
      }
    }

    if (saved.length && typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "heat_save");
    }

    if (!saved.length) {
      return res.status(400).json({
        ok:false,
        allowed:false,
        savedCount:0,
        rejectedCount:rejected.length,
        saved,
        rejected,
        message: rejected.length
          ? rejected.slice(0,5).map(x => `${x.animalNumber}: ${x.message}`).join(" — ")
          : "❌ لا يوجد أي رقم مؤهل لتسجيل الشياع."
      });
    }

    return res.json({
      ok:true,
      allowed:true,
      savedCount:saved.length,
      rejectedCount:rejected.length,
      saved,
      rejected,
      animalNumbers:saved.map(x => x.animalNumber),
      message: rejected.length
        ? `✅ تم حفظ الشياع لـ ${saved.length} حيوان — وتعذّر حفظ ${rejected.length}.`
        : (saved.length === 1 ? "✅ تم حفظ شياع بنجاح" : `✅ تم حفظ الشياع لـ ${saved.length} حيوان.`),
      redirectUrl: saved.length === 1
        ? `event-list.html?number=${encodeURIComponent(saved[0].animalNumber)}`
        : ""
    });

  } catch (e) {
    console.error('heat-save', e);

    return res.status(500).json({
      ok:false,
      allowed:false,
      error:'heat_save_failed',
      message:"❌ حدث خطأ أثناء حفظ الشياع."
    });
  }
});
// ============================================================
//                 API: BCS SAVE (server-only)
//                 تقييم حالة الجسم — حفظ وتحديث الحيوان
// ============================================================

function bcsNormalizeKindSrv(v = "") {
  const s = String(v || "").trim().toLowerCase();
  if (/buffalo|جاموس/.test(s)) return "buffalo";
  return "cow";
}

function bcsKindArabicSrv(kind = "") {
  return bcsNormalizeKindSrv(kind) === "buffalo" ? "جاموس" : "أبقار";
}

function bcsLabelSrv(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "غير محدد";

  if (s < 1.75) return "نحيفة جدًا";
  if (s < 2.75) return "نحيفة";
  if (s <= 3.25) return "مثالية";
  if (s < 4.25) return "سمينة";
  return "سمينة جدًا";
}

function bcsBuildNoteSrv({ score, kind, animalType, userComment }) {
  const k = bcsNormalizeKindSrv(kind);
  const range = k === "buffalo" ? "1–5" : "2–5";
  const kindTx = bcsKindArabicSrv(k);
  const typeTx = animalType ? `، التصنيف: ${animalType}` : "";
  const label = bcsLabelSrv(score);
  const base = `BCS ${Number(score).toFixed(2)} (${label}) — النوع: ${kindTx}${typeTx} — النطاق ${range}؛ المثالي ≈ 3.`;
  const extra = String(userComment || "").trim();
  return extra ? `${base} — ملاحظة: ${extra}` : base;
}
// ============================================================
//                 API: BCS ANALYZE (server-only)
//                 تحليل حالة الجسم من الصور — لا تحليل في الواجهة
// ============================================================

let sharpSrv = null;

function getSharpSrv() {
  if (sharpSrv) return sharpSrv;

  try {
    sharpSrv = require("sharp");
    return sharpSrv;
  } catch (e) {
    return null;
  }
}

const BCS_REF_EXTS_SRV = ["jpg", "jpeg", "png", "webp", "JPG", "JPEG", "PNG", "WEBP"];

function bcsCowRefBasesSrv(score, angleCode) {
  return ["00", "01", "02", "03", "04", "05"].map(i => `bcs_${score}_${angleCode}_${i}`);
}

const BCS_MAP_COW_SRV = {
  rear: [
    { score: 2, bases: bcsCowRefBasesSrv("2", "r") },
    { score: 3, bases: bcsCowRefBasesSrv("3", "r") },
    { score: 4, bases: bcsCowRefBasesSrv("4", "r") },
    { score: 5, bases: bcsCowRefBasesSrv("5", "r") }
  ],
  side: [
    { score: 2, bases: bcsCowRefBasesSrv("2", "s") },
    { score: 3, bases: bcsCowRefBasesSrv("3", "s") },
    { score: 4, bases: bcsCowRefBasesSrv("4", "s") },
    { score: 5, bases: bcsCowRefBasesSrv("5", "s") }
  ]
};

const BCS_MAP_BUF_EGY_SRV = [
  { score: 1, bases: ["bcs_egybuf_1"] },
  { score: 2, bases: ["bcs_egybuf_2"] },
  { score: 3, bases: ["bcs_egybuf_3"] },
  { score: 4, bases: ["bcs_egybuf_4"] },
  { score: 5, bases: ["bcs_egybuf_5"] }
];

const BCS_MAP_BUF_HYP_SRV = [
  { score: 1, bases: ["bcs_hypbuf_1"] },
  { score: 2, bases: ["bcs_hypbuf_2"] },
  { score: 3, bases: ["bcs_hypbuf_3"] },
  { score: 4, bases: ["bcs_hypbuf_4"] },
  { score: 5, bases: ["bcs_hypbuf_5"] }
];

const bcsRefVecCacheSrv = new Map();

function bcsDataUrlToBufferSrv(dataUrl = "") {
  const s = String(dataUrl || "");
  const m = s.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!m) return null;
  return Buffer.from(m[1], "base64");
}

function bcsRefPathCandidatesSrv(baseName = "") {
  const out = [];

  for (const ext of BCS_REF_EXTS_SRV) {
    out.push(path.join(__dirname, "www", "images", `${baseName}.${ext}`));
    out.push(path.join(__dirname, "public", "images", `${baseName}.${ext}`));
    out.push(path.join(__dirname, "images", `${baseName}.${ext}`));
  }

  return out;
}

function bcsBuildRefListSrv(kind = "cow", angle = "rear", animalType = "") {
  const k = bcsNormalizeKindSrv(kind);

  if (k === "buffalo") {
    if (angle !== "rear") return [];

    const type = String(animalType || "").trim();
    const list = type === "هجين" ? BCS_MAP_BUF_HYP_SRV : BCS_MAP_BUF_EGY_SRV;

    return list.flatMap(x =>
      x.bases.map(base => ({
        score: x.score,
        base
      }))
    );
  }

  const list = BCS_MAP_COW_SRV[angle] || [];

  return list.flatMap(x =>
    x.bases.map(base => ({
      score: x.score,
      base
    }))
  );
}

async function bcsImageVectorSrv(inputBuffer) {
  const sharp = getSharpSrv();

  if (!sharp) {
    throw new Error("sharp_missing");
  }

  const raw = await sharp(inputBuffer)
    .rotate()
    .resize(64, 64, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  const vec = new Float32Array(raw.length);
  let sum = 0;

  for (let i = 0; i < raw.length; i++) {
    const v = Number(raw[i]) / 255;
    vec[i] = v;
    sum += v;
  }

  const mean = sum / raw.length;
  let norm = 0;

  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i] - mean;
    norm += vec[i] * vec[i];
  }

  norm = Math.sqrt(norm) || 1;

  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i] / norm;
  }

  return vec;
}

function bcsCosineSrv(a, b) {
  if (!a || !b || a.length !== b.length) return -1;

  let s = 0;

  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }

  return s;
}

async function bcsLoadRefVectorSrv(baseName) {
  if (bcsRefVecCacheSrv.has(baseName)) {
    return bcsRefVecCacheSrv.get(baseName);
  }

  for (const p of bcsRefPathCandidatesSrv(baseName)) {
    if (!fs.existsSync(p)) continue;

    const buf = fs.readFileSync(p);
    const vec = await bcsImageVectorSrv(buf);

    bcsRefVecCacheSrv.set(baseName, vec);
    return vec;
  }

  bcsRefVecCacheSrv.set(baseName, null);
  return null;
}

async function bcsScoreOneAngleSrv({ dataUrl, kind, angle, animalType }) {
  const buf = bcsDataUrlToBufferSrv(dataUrl);

  if (!buf) {
    return {
      ok: false,
      angle,
      message: "صورة غير صالحة."
    };
  }

  const inputVec = await bcsImageVectorSrv(buf);
  const refs = bcsBuildRefListSrv(kind, angle, animalType);

  const byScore = new Map();
  const allMatches = [];

  for (const ref of refs) {
    const refVec = await bcsLoadRefVectorSrv(ref.base);
    if (!refVec) continue;

    const similarity = bcsCosineSrv(inputVec, refVec);
    const score = Number(ref.score);

    const match = {
      score,
      similarity: Number(similarity.toFixed(4)),
      ref: ref.base
    };

    allMatches.push(match);

    if (!byScore.has(score)) byScore.set(score, []);
    byScore.get(score).push(match);
  }

  if (!allMatches.length) {
    return {
      ok: false,
      angle,
      message: "لم يتم العثور على مراجع مناسبة للتحليل."
    };
  }

  const scoreGroups = [];

  for (const [score, matches] of byScore.entries()) {
    const sorted = matches
      .filter(m => Number.isFinite(Number(m.similarity)))
      .sort((a, b) => Number(b.similarity) - Number(a.similarity));

    if (!sorted.length) continue;

    const top = sorted.slice(0, 3);
    const avgTop = top.reduce((sum, m) => sum + Number(m.similarity), 0) / top.length;
    const best = sorted[0];

    scoreGroups.push({
      score,
      groupSimilarity: Number(avgTop.toFixed(4)),
      bestSimilarity: Number(best.similarity.toFixed(4)),
      ref: best.ref,
      topRefs: top.map(m => ({
        ref: m.ref,
        similarity: m.similarity
      }))
    });
  }

  scoreGroups.sort((a, b) => {
    if (Number(b.groupSimilarity) !== Number(a.groupSimilarity)) {
      return Number(b.groupSimilarity) - Number(a.groupSimilarity);
    }
    return Number(b.bestSimilarity) - Number(a.bestSimilarity);
  });

  const bestGroup = scoreGroups[0];

  if (!bestGroup) {
    return {
      ok: false,
      angle,
      message: "لم يتم العثور على مراجع مناسبة للتحليل."
    };
  }

  return {
    ok: true,
    angle,
    score: Number(bestGroup.score),
    similarity: Number(bestGroup.groupSimilarity.toFixed(4)),
    ref: bestGroup.ref,
    bestSimilarity: bestGroup.bestSimilarity,
    topRefs: bestGroup.topRefs,
    scoreGroups: scoreGroups.map(g => ({
      score: g.score,
      groupSimilarity: g.groupSimilarity,
      bestSimilarity: g.bestSimilarity,
      ref: g.ref
    }))
  };
}

function bcsQualityLabelSrv(similarity) {
  const s = Number(similarity);

  if (!Number.isFinite(s)) return "غير محددة";

  if (s >= 0.45) return "ممتازة";
  if (s >= 0.35) return "جيدة";
  if (s >= 0.25) return "مقبولة";

  return "ضعيفة — يفضّل إعادة التصوير";
}
app.post("/api/bcs/analyze", async (req, res) => {
  try {
    const body = req.body || {};

    const kind = bcsNormalizeKindSrv(
      body.kind ||
      body.animalKind ||
      body.species
    );

    const animalType = String(
      body.animalType ||
      body.typeLabel ||
      ""
    ).trim();

    const captures = body.captures || {};

    const rearImage =
      captures.rear ||
      body.rearImage ||
      body.rear ||
      "";

    const sideImage =
      captures.side ||
      body.sideImage ||
      body.side ||
      "";

    if (!rearImage) {
      return res.status(400).json({
        ok: false,
        message: "❌ لقطة الخلفية مطلوبة لتحليل حالة الجسم."
      });
    }

    const rear = await bcsScoreOneAngleSrv({
      dataUrl: rearImage,
      kind,
      angle: "rear",
      animalType
    });

    if (!rear.ok) {
      return res.status(400).json({
        ok: false,
        message: rear.message || "تعذّر تحليل لقطة الخلفية."
      });
    }

    let side = null;

    if (kind === "cow") {
      if (!sideImage) {
        return res.status(400).json({
          ok: false,
          message: "❌ الأبقار تحتاج لقطة خلفية ولقطة جانبية."
        });
      }

      side = await bcsScoreOneAngleSrv({
        dataUrl: sideImage,
        kind,
        angle: "side",
        animalType
      });

      if (!side.ok) {
        return res.status(400).json({
          ok: false,
          message: side.message || "تعذّر تحليل اللقطة الجانبية."
        });
      }
    }

    const score = kind === "buffalo"
      ? Number(rear.score)
      : Number(
          (
            (Number(rear.score) * 0.6) +
            (Number(side.score) * 0.4)
          ).toFixed(2)
        );

    const roundedScore = Number(score.toFixed(2));
    const label = bcsLabelSrv(roundedScore);

    const similarity = kind === "buffalo"
      ? rear.similarity
      : Number(
          (
            (Number(rear.similarity) * 0.6) +
            (Number(side.similarity) * 0.4)
          ).toFixed(4)
        );

    const rangeText = kind === "buffalo" ? "1–5" : "2–5";

    return res.json({
      ok: true,
      score: roundedScore,
      label,
      kind,
      species: bcsKindArabicSrv(kind),
      animalType: animalType || null,
      rangeText,
      quality: {
        similarity,
        label: bcsQualityLabelSrv(similarity)
      },
      angles: {
        rear,
        side
      },
      message: `تم تحليل حالة الجسم — BCS ${roundedScore.toFixed(2)} (${label})`
    });

  } catch (e) {
    console.error("bcs-analyze", e);

    if (String(e.message || "") === "sharp_missing") {
      return res.status(500).json({
        ok: false,
        message: "تحليل الصور غير مفعّل على السيرفر — مكتبة sharp غير مثبتة."
      });
    }

    return res.status(500).json({
      ok: false,
      message: "تعذّر تحليل صورة حالة الجسم الآن."
    });
  }
});
app.post("/api/bcs/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "تعذّر حفظ تقييم حالة الجسم — قاعدة البيانات غير متاحة."
      });
    }

    const body = req.body || {};
    const uid = req.userId;

    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);
    const animalNumber = calvingNormDigitsOnlySrv(body.animalNumber || body.number || "");
    const animalIdFromPage = String(body.animalId || "").trim();

    const analysis = body.analysis && typeof body.analysis === "object" ? body.analysis : null;

const score = Number(
  analysis?.score ??
  body.score ??
  body.bcs ??
  body.value
);
    const kind = bcsNormalizeKindSrv(body.kind || body.animalKind || body.species);
    const animalType = String(body.animalType || body.typeLabel || "").trim();
    const userComment = String(body.comment || body.notes || "").trim();

    if (!animalNumber && !animalIdFromPage) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان مطلوب."
      });
    }

    if (!calvingIsDateSrv(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ التقييم غير صالح."
      });
    }

    if (!Number.isFinite(score)) {
      return res.status(400).json({
        ok: false,
        message: "❌ درجة الحالة الجثمانية غير صالحة."
      });
    }

    const minScore = kind === "buffalo" ? 1 : 2;
    const maxScore = 5;

    if (score < minScore || score > maxScore) {
      return res.status(400).json({
        ok: false,
        message: `❌ درجة الحالة الجثمانية خارج النطاق المسموح (${minScore}–${maxScore}).`
      });
    }

let animal = null;
let animalDoc = null;

if (animalIdFromPage) {
  const snap = await db.collection("animals").doc(animalIdFromPage).get();

  if (snap.exists) {
    const data = snap.data() || {};
    const owner = String(data.userId || data.ownerUid || "").trim();

    if (owner === uid) {
      animal = { id: snap.id, ...data };
      animalDoc = snap;
    }
  }
}

if (!animal && animalNumber) {
  const found = new Map();

  const snap1 = await db.collection("animals")
    .where("userId", "==", uid)
    .where("animalNumber", "==", animalNumber)
    .limit(3)
    .get();

  snap1.forEach(doc => found.set(doc.id, doc));

  const snap2 = await db.collection("animals")
    .where("userId", "==", uid)
    .where("number", "==", animalNumber)
    .limit(3)
    .get();

  snap2.forEach(doc => found.set(doc.id, doc));

  const docs = Array.from(found.values()).filter(doc => {
    const d = doc.data() || {};
    const st = String(d.status || "active").trim().toLowerCase();
    return st !== "inactive" && st !== "archived";
  });

  if (docs.length === 1) {
    const doc = docs[0];
    const data = doc.data() || {};
    animal = { id: doc.id, ...data };
    animalDoc = doc;
  }

  if (docs.length > 1) {
    return res.status(409).json({
      ok: false,
      message: "❌ رقم الحيوان مكرر داخل حسابك. افتح التقييم من بطاقة الحيوان أو مرّر animalId."
    });
  }
}
if (!animal || !animalDoc) {
  return res.status(404).json({
    ok: false,
    message: "❌ الحيوان غير موجود في حسابك."
  });
}

    const st = String(animal.status || "active").trim().toLowerCase();
    if (st === "inactive" || st === "archived") {
      return res.status(400).json({
        ok: false,
        message: "❌ لا يمكن تسجيل تقييم لحيوان خارج القطيع."
      });
    }

    const finalAnimalNumber = String(animal.animalNumber || animal.number || animalNumber || "").trim();
    const finalAnimalId = String(animal.id || animalDoc.id || animalIdFromPage || "").trim();

    const roundedScore = Number(score.toFixed(2));
    const label = bcsLabelSrv(roundedScore);
    const notes = bcsBuildNoteSrv({
      score: roundedScore,
      kind,
      animalType,
      userComment
    });

    const eventRef = db.collection("events").doc();

    const payload = {
      userId: uid,
      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,

      type: "تقييم حالة الجسم",
      eventType: "تقييم حالة الجسم",
      eventTypeNorm: "bcs_eval",

      date: eventDate,
      eventDate,

      score: roundedScore,
      value: roundedScore,
      bcs: roundedScore,
      label,
      kind,
      species: bcsKindArabicSrv(kind),
      animalType: animalType || null,
      analysis: analysis ? cleanObj({
     score: analysis.score,
     label: analysis.label,
     quality: analysis.quality || null,
     angles: analysis.angles || null,
     rangeText: analysis.rangeText || null,
     source: "server:/api/bcs/analyze"
  }) : null,
      notes,
      comment: userComment || null,

      source: "server:/api/bcs/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const batch = db.batch();

    batch.set(eventRef, payload);

    batch.set(animalDoc.ref, {
      lastBCS: roundedScore,
      lastBcs: roundedScore,
      lastBCSDate: eventDate,
      lastBcsDate: eventDate,
      lastBCSLabel: label,
      lastBcsLabel: label,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();

    return res.json({
      ok: true,
      message: "✅ تم حفظ تقييم حالة الجسم بنجاح",
      id: eventRef.id,
      eventId: eventRef.id,
      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,
      eventDate,
      score: roundedScore,
      label,
      saved: payload
    });

  } catch (e) {
    console.error("bcs-save", e);
    return res.status(500).json({
      ok: false,
      message: "تعذّر حفظ تقييم حالة الجسم الآن."
    });
  }
});
// ============================================================
//          API: BCS VISION ANALYZE (OpenAI Vision)
//          تحليل حالة الجسم برؤية حقيقية — السيرفر فقط
// ============================================================

function bcsClampScoreSrv(v, kind = "cow") {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  const min = 1;
  const max = 5;

  return Math.max(min, Math.min(max, Math.round(n * 4) / 4));
}

function bcsExtractJsonTextSrv(text = "") {
  const s = String(text || "").trim();

  try {
    return JSON.parse(s);
  } catch {}

  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;

  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function bcsOpenAIOutputTextSrv(j = {}) {
  if (typeof j.output_text === "string" && j.output_text.trim()) {
    return j.output_text.trim();
  }

  const parts = [];

  for (const item of (j.output || [])) {
    for (const c of (item.content || [])) {
      if (typeof c.text === "string") parts.push(c.text);
      if (typeof c.output_text === "string") parts.push(c.output_text);
    }
  }

  return parts.join("\n").trim();
}

app.post("/api/bcs/vision-analyze", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        message: "❌ مفتاح OpenAI غير موجود على السيرفر."
      });
    }

    const body = req.body || {};

    const kind = bcsNormalizeKindSrv(
      body.kind ||
      body.animalKind ||
      body.species
    );

    const animalType = String(
      body.animalType ||
      body.typeLabel ||
      ""
    ).trim();

    const captures = body.captures || {};

    const rearImage =
      captures.rear ||
      body.rearImage ||
      body.rear ||
      "";

    const sideImage =
      captures.side ||
      body.sideImage ||
      body.side ||
      "";

    if (!rearImage) {
      return res.status(400).json({
        ok: false,
        message: "❌ لقطة الخلفية مطلوبة لتحليل حالة الجسم."
      });
    }

    if (kind === "cow" && !sideImage) {
      return res.status(400).json({
        ok: false,
        message: "❌ الأبقار تحتاج لقطة خلفية ولقطة جانبية لتقييم نهائي دقيق."
      });
    }
const prompt = `
You are an expert evaluator of BODY CONDITION SCORE (BCS) for DAIRY COWS.

Task:
Evaluate the TARGET dairy cow from rear and side images and return one Body Condition Score.

BCS scale:
- Use the full BCS scale from 1.00 to 5.00.
- Allowed increments are 0.25 only.
- Valid scores are:
  1.00, 1.25, 1.50, 1.75,
  2.00, 2.25, 2.50, 2.75,
  3.00, 3.25, 3.50, 3.75,
  4.00, 4.25, 4.50, 4.75,
  5.00.
- Do not output ranges.
- Do not output scores outside this scale.

Reference images:
- The labeled BCS reference images are visual anchors.
- First compare the TARGET cow with the reference anchor groups.
- Then assign the closest BCS score using 0.25 increments.
- Do not ignore the anatomical signs in favor of a general impression.

Evaluate only these anatomical regions:
1) Short ribs
2) Loin
3) Backbone / topline
4) Hooks / hip bones
5) Pins / pin bones
6) Tailhead area
7) Pelvic area / rump
8) Fat cover and angularity

Do not use:
- coat color
- background
- image style
- udder size
- abdominal fill
- breed beauty
- general body size
- camera angle alone

BCS interpretation:
- BCS 1.00 = extremely thin / emaciated.
- BCS 2.00 = thin.
- BCS 3.00 = moderate / ideal.
- BCS 4.00 = fat / heavy.
- BCS 5.00 = extremely fat / obese.

Scoring rules:

BCS 1.00–1.75:
Use this range only for severe emaciation:
- very sharp skeletal landmarks,
- highly visible short ribs,
- very sharp hooks and pins,
- sharply angular loin/backbone,
- deeply sunken tailhead,
- almost no visible fat cover.

BCS 2.00–2.75:
Use this range for thin cows:
- short ribs clearly visible,
- hooks and pins obvious and angular,
- loin/backbone show angularity,
- tailhead has little fat cover,
- pelvis and loin lack smoothness.
Do not use this range for a moderate cow with visible but softened landmarks.

BCS 3.00–3.75:
Use this range for moderate to ideal cows:
- hooks and pins may be visible but are not sharp,
- short ribs may be visible but are not severe or dominant,
- loin and rump are not severely angular,
- tailhead is not deeply sunken,
- fat cover is moderate.
BCS 3 is not a thin cow.

BCS 4.00–4.75:
Use this range for fat/heavy cows:
- short ribs are difficult to distinguish,
- hooks and pins are rounded and covered,
- loin and rump are smooth,
- tailhead has clear fat cover,
- some skeletal landmarks may still be distinguishable with effort.

BCS 5.00:
Use BCS 5.00 for extremely fat / obese cows:
- short ribs are not visible,
- hooks are not visible or nearly hidden,
- pins are not visible or nearly hidden,
- rump and pelvic area are very smooth and rounded,
- heavy fat cover is evident around rump, pelvis, and tailhead,
- main skeletal landmarks are hidden or nearly hidden by fat.
Do not require the tailhead to be completely buried to score 5.00.

Quarter-score guidance:
- Use .00 when the cow clearly matches the main class.
- Use .25 when the cow is slightly above the lower class.
- Use .50 when the cow is clearly between two adjacent main classes.
- Use .75 when the cow is close to the next higher class but not fully there.
- The quarter score must be justified by visible anatomical signs, not by uncertainty.

Critical consistency rules:
- The final score must match the anatomical findings.
- Do not describe BCS 5 anatomy and output BCS 4.
- Do not describe BCS 3 anatomy and output BCS 2.
- If short ribs are not visible and hooks/pins are hidden or nearly hidden, the score must be in the BCS 5 range.
- If hooks/pins are visible but softened and the cow is not clearly thin, the score must be in the BCS 3 range or higher.
- If image quality is insufficient or key regions are obscured, return ok=false.

Return JSON only in this exact structure:

{
  "ok": true,
  "score": 3.25,
  "confidence": "high",
  "qualityLabel": "صالحة للتقييم",
  "reason": "سبب مختصر بالعربية يربط الدرجة بعلامات BCS التشريحية فقط.",
  "rearFindings": "وصف مختصر علمي لما يظهر في الخلفية: الحوض، قاعدة الذيل، hooks، pins.",
  "sideFindings": "وصف مختصر علمي لما يظهر في الجانبية: short ribs، loin، backbone، rump."
}

If the image is not adequate for valid scoring, return:

{
  "ok": false,
  "message": "الصورة غير صالحة لتقييم حالة الجسم بدقة. يرجى إظهار الحوض والـ loin والـ short ribs والـ tailhead بوضوح."
}
`.trim();
       const publicBase =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    const imgUrl = (name) => `${publicBase}/images/${name}`;

    const content = [
      { type: "input_text", text: prompt },

      {
        type: "input_text",
        text:
          "Calibration reference examples. These are labeled dairy cow BCS anchor images. Use them only to calibrate visual scoring, then score the TARGET cow images at the end."
      },

      { type: "input_text", text: "Reference BCS 2.00 rear view." },
      { type: "input_image", image_url: imgUrl("bcs_2_r_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 2.00 side view." },
      { type: "input_image", image_url: imgUrl("bcs_2_s_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 2.00 rear view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_2_r_02.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 2.00 side view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_2_s_02.jpeg"), detail: "high" },

      { type: "input_text", text: "Reference BCS 3.00 rear view." },
      { type: "input_image", image_url: imgUrl("bcs_3_r_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 3.00 side view." },
      { type: "input_image", image_url: imgUrl("bcs_3_s_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 3.00 rear view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_3_r_02.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 3.00 side view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_3_s_02.jpeg"), detail: "high" },

      { type: "input_text", text: "Reference BCS 4.00 rear view." },
      { type: "input_image", image_url: imgUrl("bcs_4_r_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 4.00 side view." },
      { type: "input_image", image_url: imgUrl("bcs_4_s_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 4.00 rear view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_4_r_02.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 4.00 side view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_4_s_02.jpeg"), detail: "high" },

      { type: "input_text", text: "Reference BCS 5.00 rear view." },
      { type: "input_image", image_url: imgUrl("bcs_5_r_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 5.00 side view." },
      { type: "input_image", image_url: imgUrl("bcs_5_s_01.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 5.00 rear view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_5_r_02.jpeg"), detail: "high" },
      { type: "input_text", text: "Reference BCS 5.00 side view - second example." },
      { type: "input_image", image_url: imgUrl("bcs_5_s_02.jpeg"), detail: "high" },

      {
        type: "input_text",
        text:
          `Now score the TARGET cow only. النوع: ${bcsKindArabicSrv(kind)}. التصنيف: ${animalType || "غير محدد"}.`
      },
      { type: "input_text", text: "TARGET rear view." },
      { type: "input_image", image_url: rearImage, detail: "high" }
    ];

    if (kind === "cow") {
      content.push(
        { type: "input_text", text: "TARGET side view." },
        { type: "input_image", image_url: sideImage, detail: "high" }
      );
    }
    const sentBcsImages = content
  .filter(x => x && x.type === "input_image")
  .map(x => String(x.image_url || "").split("/").pop());

console.log("BCS Vision images sent to OpenAI:", sentBcsImages);
console.log("BCS Vision image count:", sentBcsImages.length);
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_BCS_MODEL || "gpt-4.1",
        input: [
          {
            role: "user",
            content
          }
        ],
        temperature: 0,
        max_output_tokens: 700
      })
    });

    const j = await r.json().catch(() => ({}));

 if (!r.ok) {
  const openaiMessage =
    j?.error?.message ||
    j?.message ||
    `openai_http_${r.status}`;

  console.error("BCS OpenAI vision error:", {
    status: r.status,
    message: openaiMessage,
    type: j?.error?.type || null,
    code: j?.error?.code || null
  });

  return res.status(500).json({
    ok: false,
    message: "تعذّر تحليل حالة الجسم عبر نموذج الرؤية.",
    debug: {
      status: r.status,
      message: openaiMessage,
      type: j?.error?.type || null,
      code: j?.error?.code || null
    }
  });
}

    const outText = bcsOpenAIOutputTextSrv(j);
    const parsed = bcsExtractJsonTextSrv(outText);

    if (!parsed || parsed.ok === false) {
      return res.status(400).json({
        ok: false,
        message: parsed?.message || "الصورة غير صالحة لتقييم حالة الجسم بدقة."
      });
    }

    const score = bcsClampScoreSrv(parsed.score, kind);

    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({
        ok: false,
        message: "تعذّر استخراج درجة BCS صالحة من تحليل الرؤية."
      });
    }

    const label = bcsLabelSrv(score);
    const confidence = String(parsed.confidence || "medium").trim();

    const qualityLabel =
      parsed.qualityLabel ||
      (
        confidence === "high"
          ? "صالحة للتقييم"
          : confidence === "medium"
            ? "متوسطة وتحتاج حذر"
            : "غير صالحة للتقييم"
      );

    return res.json({
      ok: true,
      score,
      label,
      kind,
      species: bcsKindArabicSrv(kind),
      animalType,
      rangeText: "1–5",
      quality: {
        label: qualityLabel,
        confidence
      },
     reason: String(parsed.reason || parsed.visualFindings || "").trim(),
findings: {
  visual: String(parsed.visualFindings || "").trim()
},
note: "",
message: `تم تحليل الروث — الدرجة ${score} (${label})`
    });

  } catch (e) {
    console.error("bcs vision analyze error:", e);
    return res.status(500).json({
      ok: false,
      message: "حدث خطأ أثناء تحليل حالة الجسم بالرؤية."
    });
  }
});
// ============================================================
//          API: FECES VISION ANALYZE (OpenAI Vision)
//          تقييم الروث بالرؤية — السيرفر فقط
// ============================================================

function fecesClampScoreSrv(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function fecesLabelSrv(score) {
  const s = Number(score);

  if (s === 1) return "إسهال شديد";
  if (s === 2) return "لين زيادة";
  if (s === 3) return "نموذجي";
  if (s === 4) return "جاف زيادة";
  if (s === 5) return "جاف جدًا";

  return "غير محدد";
}

function fecesBuildNoteSrv(score) {
  const s = Number(score);

  if (s === 1) {
    return "روث مائي جدًا؛ مؤشر بصري لاحتمال إسهال أو سرعة مرور عالية. يحتاج ربطه بحالة الحيوان والعليقة.";
  }

  if (s === 2) {
    return "روث لين أكثر من المطلوب؛ قد يشير إلى سرعة مرور أعلى أو نقص ألياف فعالة أو زيادة تخمر سريع.";
  }

  if (s === 3) {
    return "قوام نموذجي؛ الروث متماسك بدرجة مناسبة ويكوّن كومة واضحة بدون جفاف أو سيولة زائدة.";
  }

  if (s === 4) {
    return "روث متماسك أو جاف زيادة؛ قد يرتبط بزيادة الألياف أو قلة الماء أو بطء المرور.";
  }

  if (s === 5) {
    return "روث جاف جدًا أو صلب؛ مؤشر بصري لاحتمال جفاف/إمساك أو خلل واضح في الاتزان الغذائي.";
  }

  return "";
}

app.post("/api/feces/vision-analyze", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        message: "❌ مفتاح OpenAI غير موجود على السيرفر."
      });
    }

    const body = req.body || {};
    const image =
      body.image ||
      body.imageData ||
      body.photo ||
      body.capture ||
      body.dataUrl ||
      "";

    if (!image) {
      return res.status(400).json({
        ok: false,
        message: "❌ صورة الروث مطلوبة للتحليل."
      });
    }

const prompt = `
You are an expert dairy cattle manure consistency evaluator.

Task:
Evaluate only the manure/feces visible in the TARGET image.
Return one integer feces score from 1 to 5.

Core scale:
1 = إسهال مائي شديد: الروث سائل جدًا مثل الماء، منتشر كبركة أو بقعة مائية، بلا كومة وبلا تماسك واضح.
2 = لين جدًا أو شبه سائل: الروث مفرود أو منخفض وواسع الانتشار، لكنه ليس ماءً خالصًا وما زال له قوام أو سطح واضح.
3 = نموذجي: قرص دائري منتظم، ارتفاع معتدل، قوام عصيدي/كريمي رطب، والحلقات أو التموجات تظهر أعلى سطح القرص.
4 = جاف أو متماسك أو ضخم أكثر من المثالي: كتلة كبيرة/voluminous، أو شكل غير منتظم، أو ارتفاع زائد، أو قوام أثقل/أجف من المثالي، حتى لو ظهرت حلقات.
5 = جاف جدًا/صلب أو غير طبيعي: كتل قاسية، تشققات، كرات جافة، أو روث جاف/متماسك مغطى بمخاط.

Strict decision rules:
- لا تعطِ الدرجة 1 إلا إذا كان الروث مائيًا بوضوح مثل الماء وبلا أي تماسك تقريبًا.
- إذا كان الروث لينًا أو مفرودًا أو منتشرًا لكنه ما زال له قوام واضح، فالدرجة 2 وليست 1.
- لا تعطِ الدرجة 3 إلا إذا اجتمعت العلامات المثالية معًا:
  1) شكل قرص دائري منتظم.
  2) ارتفاع معتدل، ليس مسطحًا جدًا وليس عاليًا جدًا.
  3) قوام عصيدي/كريمي رطب وناعم.
  4) حجم معتدل غير ضخم.
  5) حلقات أو تموجات ظاهرة أعلى سطح القرص نفسه.
- الحلقات وحدها لا تكفي للدرجة 3.
- إذا ظهرت حلقات لكن الروث ضخم، أو كبير الكتلة، أو غير منتظم، أو جاف، أو متماسك زيادة، أو عالي أكثر من المثالي، فالدرجة 4 وليست 3.
- إذا كان الروث bulky أو voluminous أو overly massive، لا تعطه الدرجة 3؛ اختر 4.
- إذا كان الروث جافًا جدًا، صلبًا، متشققًا، كرات، أو كتل قاسية، فالدرجة 5.
- المخاط مع الروث الجاف أو المتماسك ليس مثاليًا:
  - إذا ظهر مخاط مع روث جاف/متماسك، فالدرجة 5.
  - إذا ظهر مخاط مع روث متوسط التماسك، فالدرجة 4 على الأقل.
  - لا تعطِ الدرجة 3 أبدًا لروث مغطى بمخاط.

Visual priorities:
First judge the overall manure shape, volume, height, moisture, spread, and structure.
Then use central rings only as supporting evidence.
Never let rings override bulky, dry, stiff, irregular, or over-structured appearance.

Ignore:
- floor color
- grass/background
- shadows
- lighting differences
- animal breed or environment

Do not diagnose disease.
This is a visual manure consistency score only.

If the image does not clearly show manure, return ok:false.

Output rules:
- Return JSON only.
- Return an integer score only: 1, 2, 3, 4, or 5.
- Do not return decimals or ranges.
- All displayed text must be Arabic only.
- Do not write English words in visualFindings, reason, qualityLabel, or message.
- The reason must be educational, concise, and based only on visible consistency, shape, spread, moisture, pile height, volume, rings, dryness, mucus, and structure.

Return JSON only:
{
  "ok": true,
  "score": 4,
  "confidence": "high|medium|low",
  "qualityLabel": "صالحة للتقييم|متوسطة وتحتاج حذر|غير صالحة للتقييم",
  "visualFindings": "وصف عربي مختصر لما يظهر في الصورة",
  "reason": "سبب عربي تعليمي مختصر لاختيار الدرجة"
}
`.trim();

    const content = [
      { type: "input_text", text: prompt },
      { type: "input_text", text: "TARGET manure/feces image." },
      { type: "input_image", image_url: image, detail: "high" }
    ];

    console.log("Feces Vision image count:", 1);

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_FECES_MODEL || process.env.OPENAI_BCS_MODEL || "gpt-4.1",
        input: [
          {
            role: "user",
            content
          }
        ],
        temperature: 0,
        max_output_tokens: 500
      })
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      const openaiMessage =
        j?.error?.message ||
        j?.message ||
        `openai_http_${r.status}`;

      console.error("Feces OpenAI vision error:", {
        status: r.status,
        message: openaiMessage,
        type: j?.error?.type || null,
        code: j?.error?.code || null
      });

      return res.status(500).json({
        ok: false,
        message: "تعذّر تحليل الروث عبر نموذج الرؤية.",
        debug: {
          status: r.status,
          message: openaiMessage,
          type: j?.error?.type || null,
          code: j?.error?.code || null
        }
      });
    }

    const outText = bcsOpenAIOutputTextSrv(j);
    const parsed = bcsExtractJsonTextSrv(outText);

    if (!parsed || parsed.ok === false) {
      return res.status(400).json({
        ok: false,
        message: parsed?.message || "الصورة غير صالحة لتقييم الروث بدقة."
      });
    }

    const score = fecesClampScoreSrv(parsed.score);

    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({
        ok: false,
        message: "تعذّر استخراج درجة روث صالحة من تحليل الرؤية."
      });
    }

    const label = fecesLabelSrv(score);
    const confidence = String(parsed.confidence || "medium").trim();

    const qualityLabel =
      parsed.qualityLabel ||
      (
        confidence === "high"
          ? "صالحة للتقييم"
          : confidence === "medium"
            ? "متوسطة وتحتاج حذر"
            : "غير صالحة للتقييم"
      );

    return res.json({
      ok: true,
      score,
      label,
      rangeText: "1–5",
      quality: {
        label: qualityLabel,
        confidence
      },
      reason: String(parsed.reason || "").trim(),
      findings: {
        visual: String(parsed.visualFindings || "").trim()
      },
      note: fecesBuildNoteSrv(score),
      message: `تم تحليل الروث — الدرجة ${score} (${label})`
    });

  } catch (e) {
    console.error("feces vision analyze error:", e);
    return res.status(500).json({
      ok: false,
      message: "حدث خطأ أثناء تحليل الروث بالرؤية."
    });
  }
});
// ============================================================
//                 API: FECES SAVE (server-only)
//                 حفظ تقييم الروث وتحديث الحيوان من السيرفر فقط
// ============================================================

app.post("/api/feces/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تقييم الروث — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalIdFromPage = String(
      body.animalId ||
      body.id ||
      ""
    ).trim();

    const animalNumber = calvingNormDigitsOnlySrv(
      body.animalNumber ||
      body.number ||
      ""
    );

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const analysis = body.analysis || body.result || {};
    const score = fecesClampScoreSrv(
      body.score ??
      body.fecesScore ??
      analysis.score
    );

    const userComment = String(
      body.comment ||
      body.notes ||
      ""
    ).trim();

    if (!eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ تقييم الروث مطلوب."
      });
    }

    if (!animalIdFromPage && !animalNumber) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان مطلوب لحفظ تقييم الروث."
      });
    }

    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({
        ok: false,
        message: "❌ حلّل صورة الروث أولًا قبل الحفظ."
      });
    }

    let animal = null;
    let animalDocSnap = null;
    let animalCollection = "animals";

    if (animalIdFromPage) {
      const snap = await db.collection("animals").doc(animalIdFromPage).get();

      if (snap.exists) {
        const data = snap.data() || {};
        const owner = String(data.userId || data.ownerUid || "").trim();

        if (owner === uid) {
          animal = { id: snap.id, data, _collection: "animals" };
          animalDocSnap = snap;
          animalCollection = "animals";
        }
      }
    }

    if (!animal && animalNumber) {
      const found = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (found) {
        animal = found;
        animalCollection = found._collection || "animals";
        animalDocSnap = await db.collection(animalCollection).doc(found.id).get();
      }
    }

    if (!animal || !animalDocSnap || !animalDocSnap.exists) {
      return res.status(404).json({
        ok: false,
        message: "❌ الحيوان غير موجود في حسابك."
      });
    }

    const animalDoc = animal.data || animalDocSnap.data() || {};
    const st = String(animalDoc.status || "active").trim().toLowerCase();

    if (st === "inactive" || st === "archived") {
      return res.status(400).json({
        ok: false,
        message: "❌ لا يمكن حفظ تقييم الروث — الحيوان غير موجود بالقطيع."
      });
    }

    const finalAnimalId = animal.id || animalDocSnap.id;
    const finalAnimalNumber = calvingNormDigitsOnlySrv(
      animalNumber ||
      animalDoc.animalNumber ||
      animalDoc.number ||
      ""
    );

    const label = fecesLabelSrv(score);

    const payload = {
      userId: uid,
      ownerUid: uid,

      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,

      type: "تقييم الروث",
      eventType: "تقييم الروث",
      eventTypeNorm: "feces_eval",

      date: eventDate,
      eventDate,

      score,
      value: score,
      fecesScore: score,
      label,

      analysis: analysis ? cleanObj({
        score: analysis.score ?? score,
        label: analysis.label || label,
        quality: analysis.quality || null,
        reason: analysis.reason || null,
        findings: analysis.findings || null,
        note: analysis.note || null,
        rangeText: analysis.rangeText || "1–5",
        source: "server:/api/feces/vision-analyze"
      }) : null,

      notes: userComment || null,
      comment: userComment || null,

      source: "server:/api/feces/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const eventRef = db.collection("events").doc();
    const batch = db.batch();

    batch.set(eventRef, payload);

    batch.set(db.collection(animalCollection).doc(finalAnimalId), {
      lastFecesScore: score,
      lastFecesDate: eventDate,
      lastFecesLabel: label,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();

    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "feces_eval_save");
    }

    return res.json({
      ok: true,
      message: "✅ تم حفظ تقييم الروث بنجاح",
      id: eventRef.id,
      eventId: eventRef.id,
      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,
      eventDate,
      score,
      label,
      saved: payload
    });

  } catch (e) {
    console.error("feces-save", e);
    return res.status(500).json({
      ok: false,
      message: "تعذّر حفظ تقييم الروث الآن."
    });
  }
});
// ============================================================
//      API: DAIRY TRAITS VISION ANALYZE (OpenAI Vision)
//      تقييم سمات إنتاج اللبن — السيرفر فقط
// ============================================================

function dairyTraitsClampScoreSrv(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function dairyTraitsClampPartSrv(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Number(max) || 0, Math.round(n)));
}

function dairyTraitsGradeSrv(score) {
  const s = Number(score);

  if (s >= 90) return "ممتاز";
  if (s >= 85) return "جيد جدًا";
  if (s >= 80) return "جيد مرتفع";
  if (s >= 75) return "جيد";
  if (s >= 65) return "متوسط";
  if (s >= 50) return "ضعيف";

  return "ضعيف جدًا";
}

app.post("/api/dairy-traits/vision-analyze", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        message: "❌ مفتاح OpenAI غير موجود على السيرفر."
      });
    }

    const body = req.body || {};
    const captures = body.captures || {};

    const sideImage =
      captures.side ||
      body.sideImage ||
      body.side ||
      "";

    const rearImage =
      captures.rear ||
      captures.udderRear ||
      body.rearImage ||
      body.udderRearImage ||
      body.rear ||
      body.udderRear ||
      "";

  if (!sideImage || !rearImage) {
  return res.status(400).json({
    ok: false,
    message: "❌ تقييم سمات إنتاج اللبن يحتاج لقطتين كاملتين: جانبية وخلفية."
  });
}
const prompt = `
You are an expert dairy cattle conformation evaluator.

Task:
Evaluate the dairy-production conformation of the cow visible in the TARGET images.
Use ONLY the TARGET images:
1) complete side view
2) complete rear view

Return one final conformation score from 0 to 100.

This is NOT a milk yield prediction.
Do NOT estimate kilograms of milk.
Do NOT diagnose disease.
Do NOT give feeding advice.
Do NOT give photography advice.
Do NOT give generic management advice.
Explain only the visible conformation reasons for the score.

Use this scientific weighted score structure exactly:
- Udder = 40 points
- Feet and Legs = 20 points
- Dairy Strength = 20 points
- Front End and Body Capacity = 15 points
- Rump = 5 points
Total = 100 points.

The final score must be the sum of these five main categories.

Official classification meaning:
90–97 = Excellent
85–89 = Very Good
80–84 = Good Plus
75–79 = Good
65–74 = Fair
50–64 = Poor

Use the full score range honestly.
Do not compress excellent cows into 85–89.
If the cow is truly excellent in the visible traits, use the excellent range.

==================================================
1) UDDER = 40 POINTS
==================================================

Udder is the most important category.
Calculate udder score ONLY as the sum of these official udder subtraits:

- Udder Depth = 10 points
- Rear Udder = 9 points
- Teat Placement = 5 points
- Udder Cleft = 5 points
- Fore Udder = 5 points
- Teats = 3 points
- Udder Balance and Texture = 3 points
Total udder = 40 points.

Evaluate each udder subtrait separately:

A) Udder Depth = 0–10
Best: moderate depth relative to the hock, with adequate capacity and clearance.
Lose points if the udder is too deep, hanging low, close to the hock, below the hock, or pendulous.

B) Rear Udder = 0–9
Best: high, wide, firmly attached rear udder with uniform width from top to bottom.
Lose points if rear udder is low, narrow, weakly attached, uneven, or lacks width/height.

C) Teat Placement = 0–5
Best: teats placed squarely under each quarter, plumb, and properly spaced.
Lose points for teats too close, too wide, not under quarters, uneven, angled, or poorly distributed.

D) Udder Cleft = 0–5
Best: clearly defined halving showing a strong median suspensory ligament.
Lose points for weak cleft, shallow cleft, no clear division, or poor central support.

E) Fore Udder = 0–5
Best: firmly attached fore udder with moderate length and ample capacity.
Lose points for loose fore attachment, short attachment, broken attachment, or poor blending into the body wall.

F) Teats = 0–3
Best: cylindrical shape, uniform size, medium length and diameter.
Lose points for very long, very short, thick, uneven, malformed, or non-uniform teats.

G) Udder Balance and Texture = 0–3
Best: level udder floor from the side, evenly balanced quarters, soft and pliable appearance if visible.
Lose points for uneven floor, unbalanced quarters, asymmetry, hard-looking or coarse udder appearance.

Critical udder rule:
A pendulous udder is not a separate invented penalty.
It must be reflected through the official sub-scores:
low Udder Depth, weak Fore Udder, weak Rear Udder, weak Udder Cleft, poor Udder Balance, and possibly poor Teat Placement.
Do not give a high udder score to a pendulous, very deep, weakly attached, unbalanced, or poorly supported udder.
Do not give the same final score to a cow with an excellent udder and a cow with a pendulous udder.

==================================================
2) FEET AND LEGS = 20 POINTS
==================================================

Evaluate:
- rear legs from rear view: straight, wide apart, feet squarely placed
- rear legs from side view: moderate hock set
- feet angle and heel depth if visible
- clean hocks
- pastern strength
- functional support and stance

Score from 0 to 20.

==================================================
3) DAIRY STRENGTH = 20 POINTS
==================================================

Evaluate:
- angularity
- openness and dairy form
- width and strength of chest as visible
- spring and openness of ribs
- wide, flat, deep ribs slanting toward the rear
- lean thighs
- sharp withers
- long clean neck
- strength without beefiness or excess flesh

Do NOT reward fatness as dairy quality.
A fleshy or beefy cow should NOT score high just because it looks full.

Score from 0 to 20.

==================================================
4) FRONT END AND BODY CAPACITY = 15 POINTS
==================================================

Evaluate from visible side/rear posture:
- chest depth and width as visible
- front end strength as visible
- body depth
- barrel length, depth, and width
- abdominal capacity
- strength of back and loin
- overall proportional frame

Do not invent front-leg traits that are not visible.
Do not require a separate front view.

Score from 0 to 15.

==================================================
5) RUMP = 5 POINTS
==================================================

Evaluate:
- rump angle: pins slightly lower than hips
- rump width and pin width
- rump length
- thurls wide apart and centrally placed if visible
- tail head placement
- pelvic balance related to fertility, calving ease, mobility, and rear udder support

Score from 0 to 5.

==================================================
FINAL SCORE RULES
==================================================

Final score = udder + feetAndLegs + dairyStrength + frontEndAndCapacity + rump.

Important:
- The udder must heavily influence the final score because it is 40% of the total.
- A cow with an excellent udder must score meaningfully higher than a cow with a pendulous or weak udder.
- A cow with a pendulous, very deep, weakly attached, or unbalanced udder should lose points through the official udder subtraits.
- Do not use generic scoring.
- Do not average everything visually.
- Score each category, then sum.

==================================================
OUTPUT RULES
==================================================

All user-visible text must be Arabic only.
Do not write English words in returned values.
Do not include generic praise.
Do not include advice.
Do not mention feeding, ration, nutrition, management, follow-up, or photography.
Explain only the visible conformation reasons for the score.

Return JSON only:
{
  "ok": true,
  "score": 96,
  "grade": "ممتاز",
  "confidence": "high|medium|low",
  "breakdown": {
    "udder": 38,
    "feetAndLegs": 19,
    "dairyStrength": 19,
    "frontEndAndCapacity": 15,
    "rump": 5
  },
  "udderSubscores": {
    "udderDepth": 10,
    "rearUdder": 9,
    "teatPlacement": 5,
    "udderCleft": 5,
    "foreUdder": 4,
    "teats": 3,
    "udderBalanceTexture": 2
  },
  "strengths": [
    "نقطة قوة شكلية واضحة",
    "نقطة قوة شكلية واضحة"
  ],
  "weaknesses": [
    "نقطة ضعف شكلية إن وجدت",
    "نقطة ضعف شكلية إن وجدت"
  ],
  "reason": "سبب عربي مختصر ومهني يوضح الدرجة، مع التركيز على الضرع أولًا ثم الأرجل والطابع الحلاب والسعة والرامب."
}
`.trim();

    const content = [
      { type: "input_text", text: prompt },

      { type: "input_text", text: "TARGET side view." },
      { type: "input_image", image_url: sideImage, detail: "high" },

      { type: "input_text", text: "TARGET rear view." },
      { type: "input_image", image_url: rearImage, detail: "high" },

    ];

   console.log("Dairy Traits Vision image count:", 2);

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_DAIRY_TRAITS_MODEL || process.env.OPENAI_BCS_MODEL || "gpt-4.1",
        input: [
          {
            role: "user",
            content
          }
        ],
        temperature: 0,
        max_output_tokens: 900
      })
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok) {
      const openaiMessage =
        j?.error?.message ||
        j?.message ||
        `openai_http_${r.status}`;

      console.error("Dairy Traits OpenAI vision error:", {
        status: r.status,
        message: openaiMessage,
        type: j?.error?.type || null,
        code: j?.error?.code || null
      });

      return res.status(500).json({
        ok: false,
        message: "تعذّر تحليل سمات إنتاج اللبن عبر نموذج الرؤية.",
        debug: {
          status: r.status,
          message: openaiMessage,
          type: j?.error?.type || null,
          code: j?.error?.code || null
        }
      });
    }

    const outText = bcsOpenAIOutputTextSrv(j);
    const parsed = bcsExtractJsonTextSrv(outText);

    if (!parsed || parsed.ok === false) {
      return res.status(400).json({
        ok: false,
        message: parsed?.message || "الصورة غير صالحة لتقييم سمات إنتاج اللبن بدقة."
      });
    }

    const rawBreakdown = parsed.breakdown || {};
const rawUdderSub = parsed.udderSubscores || {};

const udderSubscores = {
  udderDepth: dairyTraitsClampPartSrv(rawUdderSub.udderDepth, 10),
  rearUdder: dairyTraitsClampPartSrv(rawUdderSub.rearUdder, 9),
  teatPlacement: dairyTraitsClampPartSrv(rawUdderSub.teatPlacement, 5),
  udderCleft: dairyTraitsClampPartSrv(rawUdderSub.udderCleft, 5),
  foreUdder: dairyTraitsClampPartSrv(rawUdderSub.foreUdder, 5),
  teats: dairyTraitsClampPartSrv(rawUdderSub.teats, 3),
  udderBalanceTexture: dairyTraitsClampPartSrv(rawUdderSub.udderBalanceTexture, 3)
};

const udderFromSubscores =
  udderSubscores.udderDepth +
  udderSubscores.rearUdder +
  udderSubscores.teatPlacement +
  udderSubscores.udderCleft +
  udderSubscores.foreUdder +
  udderSubscores.teats +
  udderSubscores.udderBalanceTexture;

const breakdown = {
  udder: udderFromSubscores > 0
    ? dairyTraitsClampPartSrv(udderFromSubscores, 40)
    : dairyTraitsClampPartSrv(rawBreakdown.udder, 40),
  feetAndLegs: dairyTraitsClampPartSrv(rawBreakdown.feetAndLegs, 20),
  dairyStrength: dairyTraitsClampPartSrv(rawBreakdown.dairyStrength, 20),
  frontEndAndCapacity: dairyTraitsClampPartSrv(rawBreakdown.frontEndAndCapacity, 15),
  rump: dairyTraitsClampPartSrv(rawBreakdown.rump, 5)
};

    const summedScore =
      breakdown.udder +
      breakdown.feetAndLegs +
      breakdown.dairyStrength +
      breakdown.frontEndAndCapacity +
      breakdown.rump;

    const score = dairyTraitsClampScoreSrv(
      Number.isFinite(Number(parsed.score)) ? parsed.score : summedScore
    );

    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({
        ok: false,
        message: "تعذّر استخراج درجة صالحة لسمات إنتاج اللبن."
      });
    }

    const grade = parsed.grade || dairyTraitsGradeSrv(score);
    const confidence = String(parsed.confidence || "medium").trim();

    return res.json({
      ok: true,
      score,
      grade,
      rangeText: "0–100",
      confidence,
      breakdown,
      udderSubscores,
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 4) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 4) : [],
      reason: String(parsed.reason || "").trim(),
      message: `تم تحليل سمات إنتاج اللبن — الدرجة ${score} (${grade})`
    });

  } catch (e) {
    console.error("dairy traits vision analyze error:", e);
    return res.status(500).json({
      ok: false,
      message: "حدث خطأ أثناء تحليل سمات إنتاج اللبن بالرؤية."
    });
  }
});
// ============================================================
//              API: DAIRY TRAITS SAVE (server-only)
//              حفظ تقييم سمات إنتاج اللبن من السيرفر فقط
// ============================================================

app.post("/api/dairy-traits/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "firestore_disabled",
        message: "تعذّر حفظ تقييم سمات إنتاج اللبن — قاعدة البيانات غير متاحة."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalIdFromPage = String(
      body.animalId ||
      body.id ||
      ""
    ).trim();

    const animalNumber = calvingNormDigitsOnlySrv(
      body.animalNumber ||
      body.number ||
      ""
    );

    const eventDate = String(
      body.eventDate ||
      body.date ||
      ""
    ).trim().slice(0, 10);

    const analysis = body.analysis || body.result || {};
    const score = dairyTraitsClampScoreSrv(
      body.score ??
      body.dairyTraitsScore ??
      analysis.score
    );

    const userComment = String(
      body.comment ||
      body.notes ||
      ""
    ).trim();

    if (!eventDate) {
      return res.status(400).json({
        ok: false,
        message: "❌ تاريخ تقييم سمات إنتاج اللبن مطلوب."
      });
    }

    if (!animalIdFromPage && !animalNumber) {
      return res.status(400).json({
        ok: false,
        message: "❌ رقم الحيوان مطلوب لحفظ تقييم سمات إنتاج اللبن."
      });
    }

    if (!Number.isFinite(Number(score))) {
      return res.status(400).json({
        ok: false,
        message: "❌ حلّل صور الحيوان أولًا قبل الحفظ."
      });
    }

    let animal = null;
    let animalDocSnap = null;
    let animalCollection = "animals";

    if (animalIdFromPage) {
      const snap = await db.collection("animals").doc(animalIdFromPage).get();

      if (snap.exists) {
        const data = snap.data() || {};
        const owner = String(data.userId || data.ownerUid || "").trim();

        if (owner === uid) {
          animal = { id: snap.id, data, _collection: "animals" };
          animalDocSnap = snap;
          animalCollection = "animals";
        }
      }
    }

    if (!animal && animalNumber) {
      const found = await fetchAnimalByNumberForCalvingGateSrv(uid, animalNumber);

      if (found) {
        animal = found;
        animalCollection = found._collection || "animals";
        animalDocSnap = await db.collection(animalCollection).doc(found.id).get();
      }
    }

    if (!animal || !animalDocSnap || !animalDocSnap.exists) {
      return res.status(404).json({
        ok: false,
        message: "❌ الحيوان غير موجود في حسابك."
      });
    }

    const animalDoc = animal.data || animalDocSnap.data() || {};
    const st = String(animalDoc.status || "active").trim().toLowerCase();

    if (st === "inactive" || st === "archived") {
      return res.status(400).json({
        ok: false,
        message: "❌ لا يمكن حفظ تقييم سمات إنتاج اللبن — الحيوان غير موجود بالقطيع."
      });
    }

    const finalAnimalId = animal.id || animalDocSnap.id;
    const finalAnimalNumber = calvingNormDigitsOnlySrv(
      animalNumber ||
      animalDoc.animalNumber ||
      animalDoc.number ||
      ""
    );

    const grade = analysis.grade || dairyTraitsGradeSrv(score);
    const breakdown = analysis.breakdown || {};

    const payload = {
      userId: uid,
      ownerUid: uid,

      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,

      type: "تقييم سمات إنتاج اللبن",
      eventType: "تقييم سمات إنتاج اللبن",
      eventTypeNorm: "dairy_traits_eval",

      date: eventDate,
      eventDate,

      score,
      value: score,
      dairyTraitsScore: score,
      grade,

      analysis: cleanObj({
        score: analysis.score ?? score,
        grade,
        rangeText: analysis.rangeText || "0–100",
        confidence: analysis.confidence || null,
        breakdown,
        udderSubscores: analysis.udderSubscores || null,
        strengths: analysis.strengths || [],
        weaknesses: analysis.weaknesses || [],
        reason: analysis.reason || null,
        source: "server:/api/dairy-traits/vision-analyze"
      }),

      notes: userComment || null,
      comment: userComment || null,

      source: "server:/api/dairy-traits/save",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const eventRef = db.collection("events").doc();
    const batch = db.batch();

    batch.set(eventRef, payload);

    batch.set(db.collection(animalCollection).doc(finalAnimalId), {
      lastDairyTraitsScore: score,
      lastDairyTraitsDate: eventDate,
      lastDairyTraitsGrade: grade,
      lastDairyTraitsBreakdown: cleanObj(breakdown),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();

    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "dairy_traits_eval_save");
    }

    return res.json({
      ok: true,
      message: "✅ تم حفظ تقييم سمات إنتاج اللبن بنجاح",
      id: eventRef.id,
      eventId: eventRef.id,
      animalId: finalAnimalId,
      animalNumber: finalAnimalNumber,
      eventDate,
      score,
      grade,
      saved: payload
    });

  } catch (e) {
    console.error("dairy-traits-save", e);
    return res.status(500).json({
      ok: false,
      message: "تعذّر حفظ تقييم سمات إنتاج اللبن الآن."
    });
  }
});
// ============================================================
//                       API: ANIMALS (robust)
// ============================================================

app.get('/api/animals', async (req, res) => {
  const tenant = resolveTenant(req);

  try {
    // لو Firestore متاح جرّب أولاً
    if (db) {
      try {
        const snap = await db.collection('animals')
          .where('userId', '==', tenant)
          .limit(2000)
          .get();

        const animals = snap.docs.map(d => ({
          id: d.id,
          ...(d.data() || {})
        }));

        // حتى لو فاضي → تظل استجابة ناجحة
        return res.json({ ok: true, animals });
      } catch (e) {
        // نطبع الخطأ في اللوج لكن ما نكسّرش الـ API
        console.error('animals firestore error:', e.code || e.message || e);
        // نكمل على الـ fallback المحلي
      }
    }

    // إما db=null أو Firestore فشل → fallback محلي
    const animalsLocal = readJson(animalsPath, []).filter(a => belongs(a, tenant));
    return res.json({ ok: true, animals: animalsLocal });

  } catch (e) {
    console.error('animals fatal error:', e);
    // الحالة دي نادرة جداً (كسر في السيرفر نفسه)
    return res.status(500).json({ ok: false, error: 'animals_fatal' });
  }
});

// ===== Helper: compute eventDate from any shape =====
function computeEventDateFromDoc(data = {}) {
  // 1) قيم جاهزة بصيغة YYYY-MM-DD
  if (typeof data.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.eventDate)) {
    return data.eventDate;
  }

  const dateFields = [
    'date',
    'event_date',
    'calvingDate',
    'dryOffDate',
    'abortionDate',
    'closeupDate'
  ];

  for (const f of dateFields) {
    const v = data[f];
    if (!v) continue;

    if (typeof v === 'string') {
      // لو فيها تاريخ كامل أو ISO → ناخد أول 10 حروف
      const m = v.match(/\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }
  }

  // 2) eventDateUtc
  if (typeof data.eventDateUtc === 'string') {
    const m = data.eventDateUtc.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
  }

  // 3) طوابع زمنية
  const ts = data.ts || data.createdAt;
  if (ts && typeof ts === 'object' && typeof ts._seconds === 'number') {
    return toYYYYMMDD(ts._seconds * 1000);
  }
  if (typeof ts === 'number') {
    return toYYYYMMDD(ts);
  }

  // مفيش تاريخ واضح
  return null;
}
function normalizeDigitsSrv(s){
  const map = {
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'
  };
  return String(s || '')
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, '')
    .replace(/[٠-٩۰-۹]/g, d => map[d] || d);
}

function daysBetweenIsoSrv(fromIso, toIso){
  const a = String(fromIso || '').slice(0,10);
  const b = String(toIso || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return Math.floor((d2 - d1) / 86400000);
}

function normalizeSpeciesSrv(v){
  const s = String(v || '').trim();
  if (/cow|بقر|أبقار/i.test(s)) return 'أبقار';
  if (/buffalo|جاموس/i.test(s)) return 'جاموس';
  return s || '';
}

function findAnimalNumberMatches(val){
  const raw = String(val || '').trim();
  const num = Number(raw);
  const out = [raw];
  if (!Number.isNaN(num)) out.push(num);
  return out;
}

async function findAnimalDocByNumberSrv(uid, animalNumber){
  const cand = findAnimalNumberMatches(animalNumber);

  for (const ownerField of ['userId', 'ownerUid']) {
    for (const field of ['animalNumber', 'number']) {
      for (const v of cand) {
        try {
          const snap = await db.collection('animals')
            .where(ownerField, '==', uid)
            .where(field, '==', v)
            .limit(1)
            .get();

          if (!snap.empty) {
            const d = snap.docs[0];
            return { id: d.id, ...(d.data() || {}) };
          }
        } catch(_) {}
      }
    }
  }

  return null;
}

async function getLatestHeatOrInseminationSrv(uid, animalNumber, eventDate){
  const raw = String(animalNumber || '').trim();
  const evDate = String(eventDate || '').slice(0,10);
  if (!uid || !raw || !evDate) return null;

  const candidates = [];
  const vals = findAnimalNumberMatches(raw);

  for (const field of ['animalNumber', 'number']) {
    for (const v of vals) {
      try {
        const snap = await db.collection('events')
          .where('userId', '==', uid)
          .where(field, '==', v)
          .limit(80)
          .get();

        snap.docs.forEach(doc => candidates.push(doc.data() || {}));
      } catch(_) {}
    }
  }

  const rows = candidates
    .map(ev => {
      const txt = eventTextSrv(ev);
      const typeNorm =
        (txt.includes('insemination') || txt.includes('تلقيح')) ? 'insemination' :
        (txt.includes('شياع') || txt.includes('heat')) ? 'heat' :
        '';
      return {
        ...ev,
        _typeNorm: typeNorm,
        _eventDate: computeEventDateFromDoc(ev)
      };
    })
    .filter(ev => ev._typeNorm && ev._eventDate && ev._eventDate < evDate)
    .sort((a,b) => String(b._eventDate).localeCompare(String(a._eventDate)));

  return rows[0] || null;
}
function eventTypeForCardSrv(e = {}) {
  const txt = eventTextSrv(e);

  if (/daily[_\s-]?milk|milk\s*daily|milk$|لبن|انتاج/.test(txt)) return 'milk';
  if (/calving|birth|ولادة/.test(txt)) return 'calving';
  if (/insemination|تلقيح|خدم|خدمة/.test(txt)) return 'insemination';
  if (/pregnancy|pregnan|تشخيص حمل|سونار|جس/.test(txt)) return 'pregnancy';
  if (/heat|estrus|شياع|شبق/.test(txt)) return 'heat';
  if (/dry\s*-?\s*off|^dry$|جاف|تجفيف/.test(txt)) return 'dry';
  if (/mastitis|lameness|disease|ill|مرض|التهاب|عرج/.test(txt)) return 'disease';

  return 'other';
}

function milkKgFromEventSrv(e = {}) {
  const directKeys = ['dailyMilk','daily_milk','milkKg','total','kg','milk','amount'];
  for (const k of directKeys) {
    const n = Number(e?.[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const milkPartKey =
    /(^(am|pm|morning|noon|evening|morn|mid|eve)$)|(^milk\d$)|(^milk_(am|pm|morning|noon|evening)$)|(^صباح$|^ظهر$|^مساء$|^حلبة\d$|^حلبه\d$)/i;

  let sum = 0;
  for (const [k, v] of Object.entries(e || {})) {
    if (milkPartKey.test(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) sum += n;
    }
  }
  return sum > 0 ? sum : 0;
}

function avgIntervalDaysSrv(arr = []) {
  const xs = [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))].sort();
  if (xs.length < 2) return null;

  let sum = 0;
  let n = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = daysBetweenIsoSrv(xs[i - 1], xs[i]);
    if (Number.isFinite(d) && d >= 0) {
      sum += d;
      n++;
    }
  }
  return n ? Math.round(sum / n) : null;
}

function lastOfSrv(arr = []) {
  const xs = [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))].sort();
  return xs.length ? xs[xs.length - 1] : null;
}

function positivePregnancyEventSrv(e = {}) {
  const txt = [
    e?.result,
    e?.status,
    e?.diagnosis,
    e?.pregnancyResult,
    e?.eventType,
    e?.type
  ].map(v => String(v || '').toLowerCase()).join(' ');

  return /(عشار|pregnant|positive|موجب|ايجابي)/i.test(txt);
}

function negativePregnancyEventSrv(e = {}) {
  const txt = [
    e?.result,
    e?.status,
    e?.diagnosis,
    e?.pregnancyResult,
    e?.eventType,
    e?.type
  ].map(v => String(v || '').toLowerCase()).join(' ');

  return /(فارغ|فارغة|open|empty|negative|سالب)/i.test(txt);
}

async function fetchAnimalEventsSrv(uid, animal = {}) {
  if (!db || !uid || !animal) return [];

  const rows = [];
  const seen = new Set();

  const pushDocs = (docs = []) => {
    for (const d of docs) {
      if (!d || !d.id || seen.has(d.id)) continue;
      seen.add(d.id);
      rows.push({ id: d.id, ...(d.data() || {}) });
    }
  };

  // 1) حسب animalId
  if (animal.id) {
    try {
      const s = await db.collection('events')
        .where('userId', '==', uid)
        .where('animalId', '==', String(animal.id))
        .limit(300)
        .get();
      pushDocs(s.docs);
    } catch (_) {}
  }

  // 2) حسب الرقم
  const vals = findAnimalNumberMatches(animal.animalNumber ?? animal.number ?? '');
  for (const field of ['animalNumber', 'number']) {
    for (const v of vals) {
      try {
        const s = await db.collection('events')
          .where('userId', '==', uid)
          .where(field, '==', v)
          .limit(300)
          .get();
        pushDocs(s.docs);
      } catch (_) {}
    }
  }

  return rows.sort((a, b) =>
    String(computeEventDateFromDoc(a) || '').localeCompare(String(computeEventDateFromDoc(b) || ''))
  );
}
async function findAnimalGroupNameSrv(uid, animal = {}) {
  if (!db || !uid || !animal) return null;

  const animalVals = findAnimalNumberMatches(
    animal.animalNumber ?? animal.number ?? ''
  ).map(v => String(v).trim()).filter(Boolean);

  if (!animalVals.length) return null;

  try {
    const memSnap = await db.collection('groups_members')
      .where('userId', '==', uid)
      .limit(2000)
      .get();

    if (memSnap.empty) return null;

    let member = null;

    for (const d of memSnap.docs) {
      const m = d.data() || {};
      const mAnimal = String(m.animalNumber ?? '').trim();
      if (animalVals.includes(mAnimal)) {
        member = m;
        break;
      }
    }

    if (!member) return null;

    const directName =
      String(
        member.groupName ||
        member.name ||
        member.group ||
        ''
      ).trim();

    if (directName) return directName;

    const groupId = String(member.groupId || '').trim();
    if (!groupId) return null;

    const groupDocId = `${uid}_${groupId}`;
    const gdoc = await db.collection('groups').doc(groupDocId).get();

    if (gdoc.exists) {
      const g = gdoc.data() || {};
      return String(g.groupName || g.name || groupId).trim() || null;
    }

    return groupId || null;
  } catch (e) {
    console.error('findAnimalGroupNameSrv', e);
    return null;
  }
}
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
       batch.set(ref, { userId: to }, { merge:true });

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
      if (can && !dry) await d.ref.set({ userId: tenant }, { merge:true });

    }

    res.json({ ok:true, dryRun:dry, tenant, found:plan.length,
      updated: dry ? 0 : plan.filter(p=>p.willUpdate).length, plan });
  } catch (e) {
    console.error('claim error', e);
    res.status(500).json({ ok:false, error:e?.message||'claim_failed' });
  }
});

// ============================================================
//                 DEBUG: SENSORS HEALTH (always safe)
// ============================================================
app.get('/api/sensors/health', async (_req, res) => {
  // لو مفيش Firestore أصلاً → نعتبر مفيش أجهزة ونرجّع 0
  if (!db) {
    return res.json({ ok: true, devices: 0 });
  }

  try {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const snap = await db.collection('devices')
      .where('lastSeen', '>=', tenMinAgo)
      .get();

    const count = snap.docs
      .map(d => (d.data().type || '').toLowerCase())
      .filter(t => t !== 'env' && t !== 'thi').length;

    return res.json({ ok: true, devices: count });
  } catch (e) {
    console.error('sensors/health error:', e.code || e.message || e);
    // لا نكسّر الداشبورد أبداً بسبب الحساسات
    return res.json({ ok: true, devices: 0 });
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
});// ============================================================
//  DEBUG: Dump animals with explicit error logging
// ============================================================
app.get('/api/debug/animals/all', async (req, res) => {
  if (!db) {
    return res.status(503).json({ ok:false, error:'firestore_disabled' });
  }

  try {
    const ref = db.collection('animals');
    const snap = await ref.limit(5000).get();

    const animals = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    return res.json({
      ok: true,
      count: animals.length,
      animals
    });

  } catch (e) {
    console.error("🔥 DUMP ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'dump_failed'
    });
  }
});
// =======================================================
// DEBUG — طباعة جميع الأحداث Events
// =======================================================
app.get('/api/debug/events/all', async (req, res) => {
  try {
    if (!db) {
      return res.json({ ok: false, error: "Firestore not initialized" });
    }

    const snap = await db.collection('events').limit(2000).get();
    const out  = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    res.json({ ok: true, count: out.length, events: out });
  } catch (e) {
    console.error("debug/events/all", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// =======================================================
// ADMIN: Normalize all events (eventType / eventTypeNorm / eventDate)
// =======================================================
app.post('/api/admin/events/normalize', ensureAdmin, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ ok: false, error: 'firestore_disabled' });
    }

    const adb   = db;
    const limit = parseInt(req.query.limit || '2000', 10);

    const snap = await adb.collection('events')
      .limit(limit)
      .get();

    let total   = 0;
    let touched = 0;

    let batch = adb.batch();
    let ops   = 0;

    for (const d of snap.docs) {
      total++;
      const data = d.data() || {};

      // -------- 1) تحديد النوع الخام --------
      const rawType =
        data.eventType ||
        data.type ||
        data.kind ||
        data.alertRule ||
        '';

      const norm = normalizeEventType(rawType);
      let   eventType = data.eventType || '';

      // -------- 2) ضبط eventType القياسي لو فاضي --------
      if (!eventType) {
        switch (norm) {
          case 'insemination':
            eventType = 'insemination';
            break;
          case 'pregnancy_diagnosis':
            eventType = 'pregnancy_diagnosis';
            break;
          case 'calving':
            eventType = 'calving';
            break;
          case 'dry_off':
            eventType = 'dry_off';
            break;
          case 'daily_milk':
            eventType = 'daily_milk';
            break;
          case 'lameness':
            eventType = 'lameness';
            break;
          case 'nutrition':
            eventType = 'nutrition';
            break;
          default:
            eventType = rawType || norm || 'event';
        }
      }

      // -------- 3) حساب eventDate --------
      const evDate = computeEventDateFromDoc(data);

      const update = {};

      if (norm && data.eventTypeNorm !== norm) {
        update.eventTypeNorm = norm;
      }
      if (eventType && data.eventType !== eventType) {
        update.eventType = eventType;
      }
      if (evDate && data.eventDate !== evDate) {
        update.eventDate = evDate;
      }

      if (Object.keys(update).length) {
        batch.set(d.ref, update, { merge: true });
        touched++;
        ops++;

        if (ops >= 400) {
          await batch.commit();
          batch = adb.batch();
          ops   = 0;
        }
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    return res.json({
      ok: true,
      total,
      normalized: touched
    });
  } catch (e) {
    console.error('admin/events/normalize', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'normalize_failed'
    });
  }
});
// ============================================================
//                 GROUPS AUTO REBUILD (SERVER-SIDE)
// ============================================================
const AUTO_GROUP_REBUILD_TIMERS = new Map();

const GROUP_DEFS_SRV = [
  { id:'cow_males',        species:'cow',     baseKey:'males',       label:'ذكور أبقار',               feedingEligible:true  },
  { id:'cow_all',          species:'cow',     baseKey:'all',         label:'كل الأبقار',               feedingEligible:false },
  { id:'cow_fresh',        species:'cow',     baseKey:'fresh',       label:'حديث الولادة أبقار',       feedingEligible:true  },
  { id:'cow_high',         species:'cow',     baseKey:'high',        label:'عالي الإدرار أبقار',       feedingEligible:true  },
  { id:'cow_med',          species:'cow',     baseKey:'med',         label:'متوسط الإدرار أبقار',      feedingEligible:true  },
  { id:'cow_low',          species:'cow',     baseKey:'low',         label:'منخفض الإدرار أبقار',      feedingEligible:true  },
  { id:'cow_dry',          species:'cow',     baseKey:'dry',         label:'جاف بعيد أبقار',           feedingEligible:true  },
  { id:'cow_closeup',      species:'cow',     baseKey:'closeup',     label:'انتظار ولادة أبقار',       feedingEligible:true  },
  { id:'cow_suckling',     species:'cow',     baseKey:'suckling',    label:'رضيع أبقار',               feedingEligible:true  },
  { id:'cow_weaned',       species:'cow',     baseKey:'weaned',      label:'فطام أبقار',               feedingEligible:true  },
  { id:'cow_growing',      species:'cow',     baseKey:'growing',     label:'نامي أبقار',               feedingEligible:true  },
  { id:'cow_heiferOpen',   species:'cow',     baseKey:'heiferOpen',  label:'تحت التلقيح أبقار',        feedingEligible:true  },
  { id:'cow_breeding',     species:'cow',     baseKey:'breeding',    label:'عجلات ملقحة أبقار',        feedingEligible:true  },
  { id:'cow_pregHeifers',  species:'cow',     baseKey:'pregHeifers', label:'عجلات عشار أبقار',         feedingEligible:true  },

  { id:'buffalo_males',       species:'buffalo', baseKey:'males',       label:'ذكور جاموس',              feedingEligible:true  },
  { id:'buffalo_all',         species:'buffalo', baseKey:'all',         label:'كل الجاموس',              feedingEligible:false },
  { id:'buffalo_fresh',       species:'buffalo', baseKey:'fresh',       label:'حديث الولادة جاموس',      feedingEligible:true  },
  { id:'buffalo_high',        species:'buffalo', baseKey:'high',        label:'عالي الإدرار جاموس',      feedingEligible:true  },
  { id:'buffalo_med',         species:'buffalo', baseKey:'med',         label:'متوسط الإدرار جاموس',     feedingEligible:true  },
  { id:'buffalo_low',         species:'buffalo', baseKey:'low',         label:'منخفض الإدرار جاموس',     feedingEligible:true  },
  { id:'buffalo_dry',         species:'buffalo', baseKey:'dry',         label:'جاف بعيد جاموس',          feedingEligible:true  },
  { id:'buffalo_closeup',     species:'buffalo', baseKey:'closeup',     label:'انتظار ولادة جاموس',      feedingEligible:true  },
  { id:'buffalo_suckling',    species:'buffalo', baseKey:'suckling',    label:'رضيع جاموس',              feedingEligible:true  },
  { id:'buffalo_weaned',      species:'buffalo', baseKey:'weaned',      label:'فطام جاموس',              feedingEligible:true  },
  { id:'buffalo_growing',     species:'buffalo', baseKey:'growing',     label:'نامي جاموس',              feedingEligible:true  },
  { id:'buffalo_heiferOpen',  species:'buffalo', baseKey:'heiferOpen',  label:'تحت التلقيح جاموس',       feedingEligible:true  },
  { id:'buffalo_breeding',    species:'buffalo', baseKey:'breeding',    label:'عجلات ملقحة جاموس',       feedingEligible:true  },
  { id:'buffalo_pregHeifers', species:'buffalo', baseKey:'pregHeifers', label:'عجلات عشار جاموس',        feedingEligible:true  }
];

const GROUP_DEF_BY_ID_SRV = Object.fromEntries(GROUP_DEFS_SRV.map(x => [x.id, x]));

function scheduleGroupsRebuildSrv(tenant, reason = 'auto') {
  const uid = String(tenant || '').trim();
  if (!uid || !db) return;

  const old = AUTO_GROUP_REBUILD_TIMERS.get(uid);
  if (old) clearTimeout(old);

  const timer = setTimeout(async () => {
    AUTO_GROUP_REBUILD_TIMERS.delete(uid);
    try {
      const r = await rebuildGroupsForTenantSrv(uid, { reason });
      console.log('✅ groups auto rebuild:', { uid, reason, groups: r?.groupsCount, members: r?.membersCount });
    } catch (e) {
      console.error('❌ groups auto rebuild failed:', uid, reason, e.message || e);
    }
  }, 1200);

  AUTO_GROUP_REBUILD_TIMERS.set(uid, timer);
}

function normGroupNumberSrv(v) {
  return normalizeDigitsSrv(String(v || '').trim()) || String(v || '').trim();
}

function isGroupRebuildEventSrv(e = {}) {
  const txt = eventTextSrv(e);

  // تحديث مجموعات مُرَبِّيك فقط عند حدث يغيّر انتماء الحيوان لمجموعة رسمية.
  // ملاحظة: التلقيح وتشخيص الحمل مؤثران في مجموعات العجلات
  // (تحت التلقيح → عجلات ملقحة → عجلات عشار)، لذلك يدخلان هنا.
  return (
    isMilkEventSrv(e) ||
    isWeaningEventSrv(e) ||
    isCloseUpEventSrv(e) ||

    // ولادة / حديث الولادة
    txt.includes('calv') ||
    txt.includes('birth') ||
    txt.includes('ولادة') ||

    // تلقيح / عجلات ملقحة
    txt.includes('insemin') ||
    txt.includes('تلقيح') ||

    // تشخيص حمل / عجلات عشار
    txt.includes('pregnancy') ||
    txt.includes('pregnancy_diagnosis') ||
    txt.includes('تشخيص حمل') ||
    txt.includes('سونار') ||
    txt.includes('جس') ||

    // جفاف بعيد
    txt.includes('dry') ||
    txt.includes('تجفيف') ||
    txt.includes('جاف') ||

    // خروج من القطيع
    txt.includes('sold') ||
    txt.includes('sale') ||
    txt.includes('بيع') ||
    txt.includes('death') ||
    txt.includes('dead') ||
    txt.includes('نفوق') ||
    txt.includes('cull') ||
    txt.includes('استبعاد') ||
    txt.includes('inactive')
  );
}

function shouldAppearInGroupsSrv(a = {}) {
  const txt = [
    a?.status,
    a?.animalStatus,
    a?.statusAr,
    a?.saleStatus,
    a?.lifeStatus,
    a?.fate,
    a?.exitReason
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');

  if (a?.active === false) return false;
  if (a?.isActive === false) return false;
  if (a?.inactive === true) return false;

  if (txt.includes('inactive')) return false;
  if (txt.includes('dead')) return false;
  if (txt.includes('sold')) return false;
  if (txt.includes('نافق')) return false;
  if (txt.includes('نفوق')) return false;
  if (txt.includes('مباع')) return false;
  if (txt.includes('بيع')) return false;
  if (txt.includes('غير نشط')) return false;
  if (txt.includes('خارج القطيع')) return false;

  return true;
}

function speciesOfSrv(an = {}) {
  const txt = [
    an?.animaltype, an?.animalType, an?.animalTypeAr,
    an?.kind, an?.type, an?.breed
  ].map(v => String(v || '').toLowerCase()).join(' ');
  if (txt.includes('buff') || txt.includes('جاموس')) return 'buffalo';
  return 'cow';
}

function getSexTextSrv(an = {}) {
  const parts = [
    an?.sex,
    an?.gender,
    an?.animalSex,
    an?.sexAr,
    an?.genderAr
  ].map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean);

  const raw = parts.join(' ');

  if (
    parts.includes('f') ||
    raw.includes('female') ||
    raw.includes('heifer') ||
    raw.includes('انث') ||
    raw.includes('أنث') ||
    raw.includes('نتاي')
  ) {
    return 'أنثى';
  }

  if (
    parts.includes('m') ||
    raw.includes('male') ||
    raw.includes('bull') ||
    raw.includes('ذكر')
  ) {
    return 'ذكر';
  }

  return 'غير محدد';
}

function isMaleSrv(an = {}) {
  return getSexTextSrv(an) === 'ذكر';
}

function getAgeMonthsSrv(an = {}) {
  const birth = toDate(an?.birthDate);
  if (!birth || Number.isNaN(birth.getTime())) return 0;
  return Math.max(0, Math.floor((new Date() - birth) / (30.4375 * 24 * 3600 * 1000)));
}

function getDimSrv(an = {}) {
  const explicitDim = Number(an?.daysInMilk);

  // بعد الحفظ السيرفري للولادة نكتب daysInMilk = 0 صراحة.
  // لذلك نحترمه فورًا بدل إعادة الحساب من التاريخ وتداخل التوقيت.
  if (Number.isFinite(explicitDim) && explicitDim >= 0) {
    return Math.floor(explicitDim);
  }

  const calv = toDate(an?.lastCalvingDate) || toDate(an?.calvingDate) || toDate(an?.calvedAt);
  if (!calv || Number.isNaN(calv.getTime())) return 0;

  return Math.max(0, Math.floor((new Date() - calv) / 86400000));
}

function getMilkKgSrv(an = {}) {
  return numSrv(
    an?.dailyMilk ?? an?.daily_milk ?? an?.milkDaily ?? an?.milk_per_day ??
    an?.milkPerDay ?? an?.lastMilkKg ?? an?.production?.milkKg ?? an?.avgMilkKg ??
    an?.milk_today ?? an?.milkToday ?? an?.milk ?? an?.milkKg ?? an?.milk_kg ??
    an?.yield ?? an?.yieldToday ?? 0
  );
}

function reproTextSrv(an = {}) {
  return [
    an?.reproductiveStatus, an?.pregStatus, an?.statusRepro, an?.lastDiagnosis,
    an?.['الحالة_التناسلية'], an?.['الحالة التناسلية']
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');
}

function isPregnantGroupSrv(an = {}) {
  const joined = reproTextSrv(an);
  return an?.pregnant === true || joined.includes('عشار') || joined.includes('preg');
}

function isBreedingStatusGroupSrv(an = {}) {
  const joined = reproTextSrv(an);
  return joined.includes('ملقح') || joined.includes('تحت التلقيح') || joined.includes('breeding') || joined.includes('insemin');
}

function hasCalvedBeforeGroupSrv(an = {}) {
  return Number(an?.lactationNumber || 0) > 0 || !!toDate(an?.lastCalvingDate) || getDimSrv(an) > 0;
}

function isDryGroupSrv(an = {}) {
  const joined = [
    an?.lactationStatus,
    an?.productionStatus,
    an?.status,
    an?.['الحالةُ_اللبنية'] ?? an?.['الحالة_اللبنية']
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');

  const milkToday = getMilkKgSrv(an);
  const latest = an._latestMilkDate ? new Date(an._latestMilkDate) : null;
  const recentMilk = milkToday > 0 && (!latest || (Date.now() - +latest) < 3 * 86400000);
  if (recentMilk) return false;

  return an?.inMilk === false || an?.dry === true || joined.includes('جاف') || joined.includes('dry');
}

function hasWeaningEventGroupSrv(an = {}) {
  return an?._hasWeaningEvent === true;
}

function isInfantGroupSrv(an = {}) {
  return !hasCalvedBeforeGroupSrv(an) && !hasWeaningEventGroupSrv(an);
}

function isCloseUpGroupSrv(an = {}) {
  return an?._hasCloseUpEvent === true;
}

function isFreshGroupSrv(an = {}) {
  const dim = getDimSrv(an);
  return dim >= 0 && dim <= 21 && !isDryGroupSrv(an) && hasCalvedBeforeGroupSrv(an);
}

function ageCfgGroupSrv(sp, thresholds = {}) {
  if (sp === 'buffalo') {
    return {
      weanedMax:  Number(thresholds.bufWeanedMax || 5),
      growingMax: Number(thresholds.bufGrowingMax || 12)
    };
  }
  return {
    weanedMax:  Number(thresholds.cowWeanedMax || 5),
    growingMax: Number(thresholds.cowGrowingMax || 12)
  };
}

function milkBandGroupSrv(an = {}, milk = 0, thresholds = {}) {
  const v = Number(milk || 0);
  if (v <= 0) return null;

  if (speciesOfSrv(an) === 'buffalo') {
    const lowMin  = Number(thresholds.bufLowMin  || 0.1);
    const lowMax  = Number(thresholds.bufLowMax  || 7.9);
    const medMin  = Number(thresholds.bufMedMin  || 8);
    const medMax  = Number(thresholds.bufMedMax  || 11.9);
    const highMin = Number(thresholds.bufHighMin || 12);

    if (v >= highMin) return 'high';
    if (v >= medMin && v <= medMax) return 'med';
    if (v >= lowMin && v <= lowMax) return 'low';
    return null;
  }

  const lowMin  = Number(thresholds.cowLowMin  || 0.1);
  const lowMax  = Number(thresholds.cowLowMax  || 19.9);
  const medMin  = Number(thresholds.cowMedMin  || 20);
  const medMax  = Number(thresholds.cowMedMax  || 24.9);
  const highMin = Number(thresholds.cowHighMin || 25);

  if (v >= highMin) return 'high';
  if (v >= medMin && v <= medMax) return 'med';
  if (v >= lowMin && v <= lowMax) return 'low';
  return null;
}

function isWeanedGroupSrv(an = {}, sp = 'cow', thresholds = {}) {
  const m = getAgeMonthsSrv(an), c = ageCfgGroupSrv(sp, thresholds);
  return !hasCalvedBeforeGroupSrv(an) && hasWeaningEventGroupSrv(an) && m <= c.weanedMax;
}

function isGrowingGroupSrv(an = {}, sp = 'cow', thresholds = {}) {
  const m = getAgeMonthsSrv(an), c = ageCfgGroupSrv(sp, thresholds);
  return !hasCalvedBeforeGroupSrv(an) && hasWeaningEventGroupSrv(an) && m > c.weanedMax && m <= c.growingMax;
}
function groupMilkMetricAllowedSrv(groupId, def = {}) {
  const key = String(def?.baseKey || def?.groupKey || groupId || "").trim();
  const id = String(groupId || "").trim();

  return (
    key === "fresh" ||
    key === "high" ||
    key === "med" ||
    key === "low" ||
    /_(fresh|high|med|low)$/.test(id)
  );
}
function buildServerGroupDocSrv(tenant, groupId, list, thresholds = {}) {
 const def = GROUP_DEF_BY_ID_SRV[groupId];
const count = list.length || 0;

const milkMetricAllowed = groupMilkMetricAllowedSrv(groupId, def);

const milkVals = milkMetricAllowed
  ? list.map(getMilkKgSrv).filter(v => Number.isFinite(v))
  : [];

const dimVals  = list.map(getDimSrv).filter(v => Number.isFinite(v));

const avgMilkKg = milkVals.length
  ? +(milkVals.reduce((a, b) => a + b, 0) / milkVals.length).toFixed(2)
  : 0;

  const avgDim = dimVals.length
    ? Math.round(dimVals.reduce((a, b) => a + b, 0) / dimVals.length)
    : 0;

  return {
    userId: tenant,
    groupId,
    species: def?.species || 'cow',
    groupKey: def?.baseKey || groupId,
    groupName: def?.label || groupId,
    feedingEligible: !!def?.feedingEligible,
    animalsCount: count,
    animalNumbers: list
      .map(an => normGroupNumberSrv(an?.animalNumber || an?.number || an?.id || ''))
      .filter(Boolean)
      .slice(0, 500),
    avgMilkKg,
    avgDim,
    thresholds: { ...thresholds },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'server_auto_groups'
  };
}

function buildServerGroupMemberDocSrv(tenant, groupId, an = {}) {
  const def = GROUP_DEF_BY_ID_SRV[groupId];
  const animalNumber = normGroupNumberSrv(an?.animalNumber ?? an?.number ?? an?.calfNumber ?? an?.id ?? '');
  return {
    userId: tenant,
    groupId,
    species: def?.species || speciesOfSrv(an),
    groupKey: def?.baseKey || groupId,
    groupName: def?.label || groupId,
    groupDocId: `${tenant}_${groupId}`,
    animalId: String(an?.id ?? an?.animalId ?? animalNumber),
    animalNumber,
    animalType: an?.animaltype || an?.kind || an?.type || '',
    animalTypeAr: an?.animalTypeAr || '',
    breed: an?.breed || '',
    milkKg: getMilkKgSrv(an),
    daysInMilk: getDimSrv(an),
    reproductiveStatus: an?.reproductiveStatus || '',
    status: an?.status || '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'server_auto_groups'
  };
}

function splitGroupsServerSrv(list = [], thresholds = {}) {
  const g = Object.fromEntries(GROUP_DEFS_SRV.map(def => [def.id, []]));

  for (const an of list) {
    const sp = speciesOfSrv(an);
    const pref = sp === 'buffalo' ? 'buffalo_' : 'cow_';
    const m = getAgeMonthsSrv(an);
    const milk = getMilkKgSrv(an);
    const c = ageCfgGroupSrv(sp, thresholds);

    g[pref + 'all'].push(an);

    if (isMaleSrv(an)) {
      g[pref + 'males'].push(an);
      continue;
    }

    if (isFreshGroupSrv(an)) {
      g[pref + 'fresh'].push(an);
      continue;
    }

    if (!isDryGroupSrv(an) && hasCalvedBeforeGroupSrv(an)) {
      const band = milkBandGroupSrv(an, milk, thresholds);
      if (band === 'high') { g[pref + 'high'].push(an); continue; }
      if (band === 'med')  { g[pref + 'med'].push(an);  continue; }
      if (band === 'low')  { g[pref + 'low'].push(an);  continue; }
      continue;
    }

    if (isInfantGroupSrv(an)) { g[pref + 'suckling'].push(an); continue; }

   if (isPregnantGroupSrv(an)) {
  if (isCloseUpGroupSrv(an)) {
    g[pref + 'closeup'].push(an);
    continue;
  }

  if (hasCalvedBeforeGroupSrv(an)) {
    g[pref + 'dry'].push(an);
    continue;
  }

  // العجلات لا تدخل ملقحة/عشار إلا بعد سن التلقيح.
  // افتراضيًا: نهاية النامي 12 شهر، إذن بداية تحت التلقيح من 13 شهر.
  if (hasWeaningEventGroupSrv(an) && m > c.growingMax) {
    g[pref + 'pregHeifers'].push(an);
    continue;
  }

  // لو داتا شاذة: عجلة صغيرة مكتوب عليها عشار
  // لا نصدق الحالة التناسلية قبل سن التلقيح، ونتركها تكمل لمسار العمر الطبيعي.
}

if (isWeanedGroupSrv(an, sp, thresholds))  { g[pref + 'weaned'].push(an); continue; }
if (isGrowingGroupSrv(an, sp, thresholds)) { g[pref + 'growing'].push(an); continue; }

if (
  !hasCalvedBeforeGroupSrv(an) &&
  hasWeaningEventGroupSrv(an) &&
  !isPregnantGroupSrv(an) &&
  isBreedingStatusGroupSrv(an) &&
  m > c.growingMax
) {
  g[pref + 'breeding'].push(an);
  continue;
}

if (!hasCalvedBeforeGroupSrv(an) && hasWeaningEventGroupSrv(an) && !isPregnantGroupSrv(an) && m > c.growingMax) {
  g[pref + 'heiferOpen'].push(an);
  continue;
}

    if (isDryGroupSrv(an) && hasCalvedBeforeGroupSrv(an)) {
      g[pref + 'dry'].push(an);
    }
  }

  return g;
}

async function loadGroupThresholdsSrv(tenant) {
  const d = {
    cowLowMin:0.1,  cowLowMax:19.9,
    cowMedMin:20,   cowMedMax:24.9,
    cowHighMin:25,
    bufLowMin:0.1,  bufLowMax:7.9,
    bufMedMin:8,    bufMedMax:11.9,
    bufHighMin:12,
    cowWeanedMax:5,
    cowGrowingMax:12,
    bufWeanedMax:5,
    bufGrowingMax:12,
    species:'cow'
  };

  try {
    const ds = await db.collection('users').doc(tenant).collection('settings').doc('groups').get();
    if (ds.exists) return { ...d, ...(ds.data()?.thresholds || {}) };
  } catch (_) {}

  return d;
}

async function loadAnimalsForGroupsSrv(tenant) {
  const rows = [];

  try {
    const snap = await db.collection('animals').where('userId', '==', tenant).limit(5000).get();
    snap.forEach(d => rows.push({ id:d.id, _source:'animals', _sourceRank:1, ...(d.data() || {}) }));
  } catch (e) {
    console.error('groups.auto animals load failed:', e.message || e);
  }

  try {
    const snap = await db.collection('calves').where('userId', '==', tenant).limit(5000).get();
    snap.forEach(d => rows.push({
      id:d.id,
      _source:'calves',
      _sourceRank:2,
      ...(d.data() || {}),
      animalNumber: d.data()?.calfNumber || d.data()?.animalNumber || d.id,
      isCalf: true
    }));
  } catch (_) {}

   const clean = rows.filter(shouldAppearInGroupsSrv);
  const byNumber = new Map();

  for (const r of clean) {
    const n = normGroupNumberSrv(r?.animalNumber ?? r?.number ?? r?.calfNumber ?? r?.id ?? '');
    if (!n) continue;

    const row = { ...r, animalNumber: n, number: n };
    const old = byNumber.get(n);

    if (!old) {
      byNumber.set(n, row);
      continue;
    }

    // نفس فكرة الصفحة: عند تكرار الرقم بين animals و calves
    // نحافظ على بيانات الطرفين، مع تفضيل سجل animals عند وجوده.
    if (old._source === 'calves' && row._source === 'animals') {
      byNumber.set(n, { ...old, ...row, animalNumber: n, number: n });
    } else if (old._source === 'animals' && row._source === 'calves') {
      byNumber.set(n, { ...row, ...old, animalNumber: n, number: n });
    } else {
      byNumber.set(n, { ...old, ...row, animalNumber: n, number: n });
    }
  }

  return [...byNumber.values()];
}

async function enrichAnimalsForGroupsSrv(tenant, list = []) {
  if (!Array.isArray(list) || !list.length) return list;

  const wanted = new Set(list.map(an => normGroupNumberSrv(an?.animalNumber ?? an?.number ?? '')).filter(Boolean));
  const byNum = new Map(list.map(an => [normGroupNumberSrv(an?.animalNumber ?? an?.number ?? ''), an]));

  let snap;
  try {
    snap = await db.collection('events').where('userId', '==', tenant).orderBy('eventDate', 'desc').limit(5000).get();
  } catch (_) {
    snap = await db.collection('events').where('userId', '==', tenant).limit(5000).get();
  }

  snap.forEach(ds => {
    const e = ds.data() || {};
    const key = normGroupNumberSrv(eventAnimalKeySrv(e));
    if (!key || !wanted.has(key)) return;

    const an = byNum.get(key);
    if (!an) return;

    const ms = getEventMsSrv(e);

    if (isWeaningEventSrv(e)) {
      const curr = an._firstWeaningDate ? new Date(an._firstWeaningDate).getTime() : null;
      if (!curr || (ms && ms < curr)) {
        an._hasWeaningEvent = true;
        an._firstWeaningDate = ms ? new Date(ms).toISOString() : an._firstWeaningDate;
      }
    }

    const normType = normalizeEventType(e?.eventType || e?.type || e?.kind || '');
    const evDateIso = computeEventDateFromDoc(e) || (ms ? new Date(ms).toISOString().slice(0,10) : null);

    if (normType === 'calving' && evDateIso) {
      const curr = an.lastCalvingDate ? new Date(String(an.lastCalvingDate).slice(0,10)).getTime() : null;
      if (!curr || (ms && ms > curr)) {
        an.lastCalvingDate = evDateIso;
        an.productionStatus = 'milking';
        an.reproductiveStatus = 'fresh';
        an.inMilk = true;
      }
    }

    if (normType === 'dry_off' && evDateIso) {
      const curr = an.lastDryOffDate ? new Date(String(an.lastDryOffDate).slice(0,10)).getTime() : null;
      if (!curr || (ms && ms > curr)) {
        an.lastDryOffDate = evDateIso;
        an.productionStatus = 'dry';
        an.inMilk = false;
      }
    }

    if (isCloseUpEventSrv(e)) {
      const curr = an._lastCloseUpDate ? new Date(an._lastCloseUpDate).getTime() : null;
      if (!curr || (ms && ms > curr)) {
        an._hasCloseUpEvent = true;
        an._lastCloseUpDate = ms ? new Date(ms).toISOString() : an._lastCloseUpDate;
        an.productionStatus = 'close_up';
      }
    }

    if (isMilkEventSrv(e)) {
      const milkKg = numSrv(
        e?.milkKg ?? e?.dailyMilk ?? e?.milk ?? e?.yield ?? e?.kg ??
        (Array.isArray(e?.milkSessions) ? e.milkSessions.reduce((s, x) => s + numSrv(x?.kg), 0) : 0)
      );
      const curr = an._latestMilkDate ? new Date(an._latestMilkDate).getTime() : null;
      if (!curr || (ms && ms > curr)) {
        an.lastMilkKg = milkKg;
        if (!Number(getMilkKgSrv(an))) an.dailyMilk = milkKg;
        an._latestMilkDate = ms ? new Date(ms).toISOString() : an._latestMilkDate;
      }
    }
  });

  return list;
}

async function persistGroupsSnapshotSrv(tenant, groupsMap, thresholds = {}, reason = 'auto') {
  const groups = GROUP_DEFS_SRV.map(def => buildServerGroupDocSrv(tenant, def.id, groupsMap[def.id] || [], thresholds));
  const members = [];

  for (const def of GROUP_DEFS_SRV) {
    for (const an of (groupsMap[def.id] || [])) {
      members.push(buildServerGroupMemberDocSrv(tenant, def.id, an));
    }
  }

  let batch = db.batch();
  let ops = 0;

  for (const g of groups) {
    const ref = db.collection('groups').doc(`${tenant}_${g.groupId}`);
    batch.set(ref, { ...g, rebuildReason: reason }, { merge:true });
    ops++;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }

  const desiredIds = new Set();

  for (const m of members) {
    const memberId = `${tenant}_${m.groupId}_${m.animalNumber}`;
    desiredIds.add(memberId);
    const ref = db.collection('groups_members').doc(memberId);
    batch.set(ref, { ...m, rebuildReason: reason }, { merge:true });
    ops++;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }

  if (ops > 0) await batch.commit();

  const oldSnap = await db.collection('groups_members').where('userId', '==', tenant).get();
  if (!oldSnap.empty) {
    let delBatch = db.batch();
    let delOps = 0;
    for (const ds of oldSnap.docs) {
      if (!desiredIds.has(ds.id)) {
        delBatch.delete(ds.ref);
        delOps++;
        if (delOps >= 400) { await delBatch.commit(); delBatch = db.batch(); delOps = 0; }
      }
    }
    if (delOps > 0) await delBatch.commit();
  }

  await syncAnimalGroupFieldsSrv(tenant, groups);

  return { groups, members };
}

async function rebuildGroupsForTenantSrv(tenant, opts = {}) {
  if (!db) return { ok:false, error:'firestore_disabled' };
  const uid = String(tenant || '').trim();
  if (!uid) return { ok:false, error:'userId_required' };

  const reason = String(opts?.reason || 'auto').trim() || 'auto';
  const thresholds = await loadGroupThresholdsSrv(uid);
  const animals = await loadAnimalsForGroupsSrv(uid);
  await enrichAnimalsForGroupsSrv(uid, animals);
  const groupsMap = splitGroupsServerSrv(animals, thresholds);
  const saved = await persistGroupsSnapshotSrv(uid, groupsMap, thresholds, reason);

  const counts = {};
  for (const def of GROUP_DEFS_SRV) counts[def.id] = (groupsMap[def.id] || []).length;

  return {
    ok:true,
    reason,
    animalsCount: animals.length,
    groupsCount: saved.groups.length,
    membersCount: saved.members.length,
    counts
  };
}
function groupPageDateIsoSrv(v) {
  const d = toDate(v);
  if (d && !Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  const s = String(v || '').trim();
  return s ? s.slice(0, 10) : null;
}

function groupAnimalForPageSrv(an = {}) {
  const sp = speciesOfSrv(an);

  const animalNumber = normGroupNumberSrv(
    an?.animalNumber ??
    an?.number ??
    an?.calfNumber ??
    an?.id ??
    ''
  );

  const milkKg = getMilkKgSrv(an);
  const dim = getDimSrv(an);

  return {
    id: String(an?.id ?? an?.animalId ?? animalNumber),
    animalId: String(an?.animalId ?? an?.id ?? animalNumber),

    animalNumber,
    number: animalNumber,
    calfNumber: an?.calfNumber
      ? normGroupNumberSrv(an.calfNumber)
      : (an?.isCalf ? animalNumber : ''),

    isCalf: an?.isCalf === true,
    source: an?._source || '',

    species: sp,
    animaltype: an?.animaltype || sp,
    animalType: an?.animalType || an?.type || '',
    animalTypeAr: an?.animalTypeAr || '',
    breed: an?.breed || '',

    sex: an?.sex || an?.gender || an?.animalSex || '',
    gender: an?.gender || an?.sex || '',

    birthDate: groupPageDateIsoSrv(an?.birthDate),
    lastCalvingDate: groupPageDateIsoSrv(an?.lastCalvingDate || an?.calvingDate || an?.calvedAt),
    lastInseminationDate: groupPageDateIsoSrv(an?.lastInseminationDate || an?.lastServiceDate || an?.conceptionDate),
    lastDryOffDate: groupPageDateIsoSrv(an?.lastDryOffDate),
    expectedCalvingDate: groupPageDateIsoSrv(an?.expectedCalvingDate || an?.expectedDateOfCalving || an?.ecd),

    dailyMilk: milkKg,
    milkKg,
    lastMilkKg: milkKg,
    daysInMilk: dim,
    lactationNumber: Number(an?.lactationNumber || 0),
    ageMonths: getAgeMonthsSrv(an),

    reproductiveStatus: an?.reproductiveStatus || '',
    productionStatus: an?.productionStatus || '',
    lactationStatus: an?.lactationStatus || '',
    status: an?.status || '',

    pregnant: isPregnantGroupSrv(an),
    dry: isDryGroupSrv(an),
    inMilk: an?.inMilk === false ? false : (isDryGroupSrv(an) ? false : undefined),

    _hasWeaningEvent: an?._hasWeaningEvent === true,
    _firstWeaningDate: groupPageDateIsoSrv(an?._firstWeaningDate),
    _hasCloseUpEvent: an?._hasCloseUpEvent === true,
    _lastCloseUpDate: groupPageDateIsoSrv(an?._lastCloseUpDate),
    _latestMilkDate: groupPageDateIsoSrv(an?._latestMilkDate)
  };
}

function buildGroupsPagePayloadSrv(tenant, groupsMap = {}, thresholds = {}, animalsCount = 0) {
  const groups = [];
  const pageGroupsMap = {};
  const counts = {};

  for (const def of GROUP_DEFS_SRV) {
    const rawList = groupsMap[def.id] || [];
    const animals = rawList.map(groupAnimalForPageSrv);

    counts[def.id] = animals.length;
    pageGroupsMap[def.id] = animals;

    groups.push({
      userId: tenant,
      groupId: def.id,
      id: def.id,
      species: def.species,
      groupKey: def.baseKey,
      baseKey: def.baseKey,
      groupName: def.label,
      label: def.label,
      feedingEligible: !!def.feedingEligible,
      animalsCount: animals.length,
      animalNumbers: animals.map(x => x.animalNumber).filter(Boolean).slice(0, 500),
      animals
    });
  }

  return {
    ok: true,
    source: 'server_groups_page',
    readOnly: true,
    thresholds,
    animalsCount,
    groupsCount: groups.length,
    counts,
    groups,
    groupsMap: pageGroupsMap
  };
}

async function buildGroupsPageForTenantSrv(tenant) {
  if (!db) return { ok: false, error: 'firestore_disabled' };

  const uid = String(tenant || '').trim();
  if (!uid) return { ok: false, error: 'userId_required' };

  const thresholds = await loadGroupThresholdsSrv(uid);
  const animals = await loadAnimalsForGroupsSrv(uid);

  await enrichAnimalsForGroupsSrv(uid, animals);

  const groupsMap = splitGroupsServerSrv(animals, thresholds);

  return buildGroupsPagePayloadSrv(uid, groupsMap, thresholds, animals.length);
}

app.get('/api/groups/page', requireUserId, async (req, res) => {
  try {
    const result = await buildGroupsPageForTenantSrv(req.userId);
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (e) {
    console.error('groups.page', e);
    return res.status(500).json({
      ok: false,
      error: 'groups_page_failed',
      message: e.message || String(e)
    });
  }
});
app.post('/api/groups/rebuild', requireUserId, async (req, res) => {
  try {
    const result = await rebuildGroupsForTenantSrv(req.userId, { reason:'manual_api_rebuild' });
    return res.json(result);
  } catch (e) {
    console.error('groups.rebuild', e);
    return res.status(500).json({ ok:false, error:'groups_rebuild_failed', message:e.message || String(e) });
  }
});

// ============================================================
//                 API: GROUPS EVENTS ENRICH
// ============================================================
app.post('/api/groups/events-enrich', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const tenant = req.userId;
    const animalNumbers = Array.isArray(req.body?.animalNumbers)
      ? req.body.animalNumbers.map(x => String(x).trim()).filter(Boolean)
      : [];

    if (!animalNumbers.length) {
      return res.json({ ok:true, enrichments:{} });
    }

    const wanted = new Set(animalNumbers);
    const enrichments = {};

    let snap;
    try {
      snap = await db.collection('events')
        .where('userId', '==', tenant)
        .orderBy('eventDate', 'desc')
        .limit(3000)
        .get();
    } catch (_) {
      snap = await db.collection('events')
        .where('userId', '==', tenant)
        .limit(3000)
        .get();
    }

    snap.forEach(ds => {
      const e = ds.data() || {};
      const key = eventAnimalKeySrv(e);
      if (!key || !wanted.has(key)) return;

      if (!enrichments[key]) {
        enrichments[key] = {
          hasWeaningEvent: false,
          firstWeaningDate: null,
          hasCloseUpEvent: false,
          lastCloseUpDate: null,
          lastMilkKg: null,
          latestMilkDate: null
        };
      }

      const row = enrichments[key];
      const ms = getEventMsSrv(e);

      if (isWeaningEventSrv(e)) {
        const curr = row.firstWeaningDate ? new Date(row.firstWeaningDate).getTime() : null;
        if (!curr || (ms && ms < curr)) {
          row.hasWeaningEvent = true;
          row.firstWeaningDate = ms ? new Date(ms).toISOString() : row.firstWeaningDate;
        }
      }

      if (isCloseUpEventSrv(e)) {
        const curr = row.lastCloseUpDate ? new Date(row.lastCloseUpDate).getTime() : null;
        if (!curr || (ms && ms > curr)) {
          row.hasCloseUpEvent = true;
          row.lastCloseUpDate = ms ? new Date(ms).toISOString() : row.lastCloseUpDate;
        }
      }

      if (isMilkEventSrv(e)) {
        const milkKg = numSrv(
          e?.milkKg ??
          e?.dailyMilk ??
          e?.milk ??
          e?.yield ??
          e?.kg
        );

        const curr = row.latestMilkDate ? new Date(row.latestMilkDate).getTime() : null;
        if (!curr || (ms && ms > curr)) {
          row.lastMilkKg = milkKg;
          row.latestMilkDate = ms ? new Date(ms).toISOString() : row.latestMilkDate;
        }
      }
    });

    return res.json({ ok:true, enrichments });
  } catch (e) {
    console.error('groups.events-enrich', e);
    return res.status(500).json({ ok:false, error:'groups_events_enrich_failed' });
  }
});
// ============================================================
//                       API: GROUPS SETTINGS
// ============================================================
app.get('/api/groups/settings', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const tenant = req.userId;
    const ds = await db.collection('users').doc(tenant).collection('settings').doc('groups').get();

    return res.json({
      ok: true,
      thresholds: ds.exists ? (ds.data()?.thresholds || ds.data()) : null
    });
  } catch (e) {
    console.error('groups.settings.get', e);
    return res.status(500).json({ ok:false, error:'groups_settings_get_failed' });
  }
});

app.post('/api/groups/settings', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const tenant = req.userId;
    const thresholds = req.body?.thresholds || {};

    await db.collection('users').doc(tenant).collection('settings').doc('groups').set({
      userId: tenant,
      thresholds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge:true });

    if (typeof rebuildGroupsForTenantSrv === 'function') {
      await rebuildGroupsForTenantSrv(tenant, { reason:'groups_settings' });
    }

    return res.json({ ok:true, saved:true });
  } catch (e) {
    console.error('groups.settings.save', e);
    return res.status(500).json({ ok:false, error:'groups_settings_save_failed' });
  }
});

// ============================================================
//                       API: GROUPS SYNC
// ============================================================
app.post('/api/groups/sync', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

const tenant = req.userId;
const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
const members = Array.isArray(req.body?.members) ? req.body.members : [];

const partial = req.body?.partial === true;
const finalize = req.body?.finalize === true;
const desiredMemberIds = Array.isArray(req.body?.desiredMemberIds)
  ? req.body.desiredMemberIds.map(x => String(x || '').trim()).filter(Boolean)
  : null;

    let batch = db.batch();
    let ops = 0;

    for (const g of groups) {
      const groupId = String(g?.groupId || '').trim();
      if (!groupId) continue;

      const ref = db.collection('groups').doc(`${tenant}_${groupId}`);
      batch.set(ref, {
        ...g,
        userId: tenant,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge:true });

      ops++;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    const desiredIds = new Set(desiredMemberIds || []);

    for (const m of members) {
      const groupId = String(m?.groupId || '').trim();
      const animalNumber = String(m?.animalNumber || '').trim();
      if (!groupId || !animalNumber) continue;

      const memberId = `${tenant}_${groupId}_${animalNumber}`;
      if (!desiredMemberIds) desiredIds.add(memberId);

      const ref = db.collection('groups_members').doc(memberId);
      batch.set(ref, {
        ...m,
        userId: tenant,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge:true });

      ops++;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

if (!partial && (finalize || desiredIds.size > 0)) {
  const oldSnap = await db.collection('groups_members').where('userId', '==', tenant).get();

  if (!oldSnap.empty) {
    let delBatch = db.batch();
    let delOps = 0;

    for (const ds of oldSnap.docs) {
      if (!desiredIds.has(ds.id)) {
        delBatch.delete(ds.ref);
        delOps++;
        if (delOps >= 400) {
          await delBatch.commit();
          delBatch = db.batch();
          delOps = 0;
        }
      }
    }

    if (delOps > 0) {
      await delBatch.commit();
    }
  }
}

 if (groups.length) {
  await syncAnimalGroupFieldsSrv(tenant, groups);
}

return res.json({
  ok: true,
  savedGroups: groups.length,
  savedMembers: members.length,
  animalsSynced: true
});
  } catch (e) {
    console.error('groups.sync', e);
    return res.status(500).json({ ok:false, error:'groups_sync_failed' });
  }
});
function dimFromDatesSrv(calvingISO, eventISO){
  const a = String(calvingISO || '').slice(0,10);
  const b = String(eventISO || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const d = diffDaysISO(a, b);
  return Number.isFinite(d) && d >= 1 ? d : null;
}

function solveLinear3x3Srv(A, b){
  const m = A.map((row,i)=>[...row, b[i]]);
  const n = 3;

  for(let col=0; col<n; col++){
    let pivot = col;
    for(let r=col+1; r<n; r++){
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];

    const div = m[col][col];
    for(let c=col; c<=n; c++) m[col][c] /= div;

    for(let r=0; r<n; r++){
      if (r === col) continue;
      const f = m[r][col];
      for(let c=col; c<=n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

function aliSchaefferBasisSrv(dim){
  const t = Number(dim);
  if (!Number.isFinite(t) || t < 1) return null;
  const x = t / 305;
  if (x <= 0) return null;
  return [1, x, x*x, Math.log(1/x), Math.log(1/x)*Math.log(1/x)];
}

function breedClassSrv(species, breed = ''){
  const s = String(species || '').toLowerCase();
  const b = String(breed || '').toLowerCase();

  if (/buffalo|جاموس/.test(s)) return 'buffalo';
  if (/holstein|هولشتاين|هولستين/.test(b)) return 'holstein';
  if (/montbeliarde|مونتبليارد/.test(b)) return 'montbeliarde';
  if (/simmental|سيمنتال/.test(b)) return 'simmental';
  return 'cow';
}

function prior305Srv({ species, breed, parity } = {}){
  const cls = breedClassSrv(species, breed);
  const p = Number(parity || 0);

  const table = {
    buffalo:      { p1: 1800, p2: 2200, p3: 2400 },
    holstein:     { p1: 7500, p2: 9200, p3: 9800 },
    montbeliarde: { p1: 6200, p2: 7600, p3: 8200 },
    simmental:    { p1: 5600, p2: 7000, p3: 7600 },
    cow:          { p1: 6000, p2: 7600, p3: 8200 }
  };

  const row = table[cls] || table.cow;
  if (p <= 1) return row.p1;
  if (p === 2) return row.p2;
  return row.p3;
}

function projectLactation305AliSchaefferSrv({
  milkSeries = [],
  lastCalvingDate,
  species,
  breed,
  parity
} = {}){
  const pts = (Array.isArray(milkSeries) ? milkSeries : [])
    .map(p => {
      const dim = p.dim ?? dimFromDatesSrv(lastCalvingDate, p.date);
      const y = Number(p.kg);
      return { dim: Number(dim), y };
    })
    .filter(p => Number.isFinite(p.dim) && p.dim >= 5 && p.dim <= 305 && Number.isFinite(p.y) && p.y > 0)
    .sort((a,b) => a.dim - b.dim);

// شروط صلاحية مرنة لمُرَبِّيك:
// 1) لازم على الأقل 5 نقاط فعلية
// 2) لازم يكون فيها تنوع حقيقي في DIM
const uniqDims = [...new Set(pts.map(p => p.dim))];
if (uniqDims.length < 5) return null;

const dimSpan = Math.max(...uniqDims) - Math.min(...uniqDims);
const fitQuality =
  dimSpan >= 60 ? 'high' :
  dimSpan >= 25 ? 'medium' :
  'low';
  // y = β0 + β1*x + β2*x² + β3*ln(1/x) + β4*ln²(1/x)
  // نثبّت β3, β4 على priors بسيطة حسب النوع/الموسم، ونحل 3x3 للباقي
  const prior305 = prior305Srv({ species, breed, parity });
  const peakScale =
    /buffalo|جاموس/i.test(String(species || '')) ? 0.55 :
    Number(parity || 0) <= 1 ? 0.82 : 1.0;

  const beta3 = 7.5 * peakScale;
  const beta4 = -1.25 * peakScale;

  let s00=0,s01=0,s02=0,s11=0,s12=0,s22=0;
  let t0=0,t1=0,t2=0;

  for (const p of pts){
    const basis = aliSchaefferBasisSrv(p.dim);
    if (!basis) continue;
    const [b0,b1,b2,b3v,b4v] = basis;
    const yy = p.y - (beta3 * b3v + beta4 * b4v);

    s00 += b0*b0; s01 += b0*b1; s02 += b0*b2;
    s11 += b1*b1; s12 += b1*b2; s22 += b2*b2;

    t0 += b0*yy; t1 += b1*yy; t2 += b2*yy;
  }

  // regularization خفيفة باتجاه prior معقول
  const ridge = 0.25;
  const A = [
    [s00 + ridge, s01,         s02],
    [s01,         s11 + ridge, s12],
    [s02,         s12,         s22 + ridge]
  ];

  const avgDailyPrior = prior305 / 305;
  const b = [
    t0 + ridge * avgDailyPrior,
    t1 + ridge * 0,
    t2 + ridge * 0
  ];

  const sol = solveLinear3x3Srv(A, b);
  if (!sol) return null;
  const [beta0, beta1, beta2] = sol;

  let total305 = 0;
  for(let d=1; d<=305; d++){
    const basis = aliSchaefferBasisSrv(d);
    if (!basis) continue;
    const [b0,b1,b2,b3v,b4v] = basis;
    const yhat = beta0*b0 + beta1*b1 + beta2*b2 + beta3*b3v + beta4*b4v;
    total305 += Math.max(0, yhat);
  }

  if (!Number.isFinite(total305) || total305 <= 0) return null;

return {
  m305Kg: Math.round(total305),
  model: 'ali_schaeffer',
  pointsUsed: uniqDims.length,
  dimMin: Math.min(...uniqDims),
  dimMax: Math.max(...uniqDims),
  fitQuality
};
}
// ============================================================
//                 API: ANIMAL CARD (server-only)
// ============================================================
app.get('/api/animal-card', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const uid = req.userId;
    const number = normalizeDigitsSrv(req.query.number || req.query.animalNumber || '');

    if (!number) {
      return res.status(400).json({ ok:false, error:'animalNumber_required' });
    }

    const animal = await findAnimalDocByNumberSrv(uid, number);
    if (!animal) {
      return res.status(404).json({ ok:false, error:'animal_not_found' });
    }

    const events = await fetchAnimalEventsSrv(uid, animal);
    const groupNameFromMembership = await findAnimalGroupNameSrv(uid, animal);
    const state = {
      number: animal.animalNumber ?? animal.number ?? number,

kind: animal.animalType || animal.kind || animal.type || animal.animalTypeAr || null,
breed:
  animal.breed ||
  animal.breedName ||
  animal.breedAr ||
  animal.animalBreed ||
  animal.animalBreedAr ||
  animal.strain ||
  animal.line ||
  null,
group:
  animal.group ||
  animal.groupName ||
  animal.currentGroup ||
  animal.pen ||
  animal.lot ||
  animal.section ||
  groupNameFromMembership ||
  null,
      birthDate: animal.birthDate || animal.birth_date || animal.dob || null,
      lastCalvingDate: animal.lastCalvingDate || animal.lastCalving || animal.calvingDate || null,
      lactationNumber: animal.lactationNumber ?? animal.lactNo ?? null,
      daysInMilk: Number.isFinite(Number(animal.daysInMilk)) ? Number(animal.daysInMilk) : null,

      reproductiveStatus: String(animal.reproductiveStatus || animal.reproStatus || '').trim() || null,
      productionStatus: String(animal.productionStatus || animal.prodStatus || '').trim() || null,
      healthStatus: String(animal.healthStatus || animal.lastDisease || animal.disease || 'سليم').trim(),

      pregnancyDate: animal.pregnancyDate || animal.pregnantFrom || null,
      lastInseminationDate: animal.lastInseminationDate || null,
      servicesCount: Number.isFinite(Number(animal.servicesCount)) ? Number(animal.servicesCount) : null,
      serviceIntervalDays: Number.isFinite(Number(animal.serviceIntervalDays)) ? Number(animal.serviceIntervalDays) : null,
      heatIntervalDays: Number.isFinite(Number(animal.heatIntervalDays)) ? Number(animal.heatIntervalDays) : null,

      milkTraitsScore: Number(animal.milkTraitsScore || animal.milk_score || 0) || 0,
      ovsynch: animal.ovsynch || null,

      milkTodayKg: Number.isFinite(Number(animal.milkTodayKg)) ? Number(animal.milkTodayKg) : null,
      seasonTotalKg: Number.isFinite(Number(animal.seasonTotalKg)) ? Number(animal.seasonTotalKg) : null,
      m305Kg: Number.isFinite(Number(animal.m305Kg)) ? Number(animal.m305Kg) : null,

      lastCheckDate: animal.lastCheckDate || animal.healthCheckDate || null,

      inseminations: [],
      estrusDates: Array.isArray(animal.estrusDates) ? [...animal.estrusDates] : [],
      healthHistory: [],
      milkSeries: []
    };

    let seasonMilk = 0;

    for (const e of events) {
      const t = eventTypeForCardSrv(e);
      const d = computeEventDateFromDoc(e);

      if (t === 'calving' && d) {
        state.lastCalvingDate = d;
      }

      if (t === 'dry') {
        state.productionStatus = 'جاف';
      }

      if (t === 'insemination' && d) {
        state.inseminations.push(d);
      }

      if (t === 'heat' && d) {
        state.estrusDates.push(d);
      }

      if (t === 'pregnancy') {
        if (positivePregnancyEventSrv(e)) {
          if (d) state.pregnancyDate = state.pregnancyDate || d;
          state.reproductiveStatus = 'عِشار';
        } else if (negativePregnancyEventSrv(e)) {
          if (!state.pregnancyDate) state.reproductiveStatus = 'مفتوحة';
        }
      }

      if (t === 'disease') {
        state.healthHistory.push({
          date: d || null,
          name: e.diseaseName || e.eventType || e.type || 'حالة صحية',
          note: e.notes || e.note || ''
        });
        if (d && !state.lastCheckDate) state.lastCheckDate = d;
      }

      if (t === 'milk' && d) {
        const kg = milkKgFromEventSrv(e);
        if (kg > 0) {
          state.milkSeries.push({ date: d, kg });
          seasonMilk += kg;
        }
      }
    }

    state.inseminations = [...new Set(state.inseminations.filter(Boolean))].sort();
    state.estrusDates = [...new Set(state.estrusDates.filter(Boolean))].sort();
    state.milkSeries = state.milkSeries.sort((a,b)=> String(a.date).localeCompare(String(b.date)));

    state.lastInseminationDate = state.lastInseminationDate || lastOfSrv(state.inseminations);
state.servicesCount =
  Number.isFinite(Number(state.servicesCount)) && Number(state.servicesCount) > 0
    ? Number(state.servicesCount)
    : (state.inseminations.length || null);

state.serviceIntervalDays =
  Number.isFinite(Number(state.serviceIntervalDays)) && Number(state.serviceIntervalDays) > 0
    ? Number(state.serviceIntervalDays)
    : avgIntervalDaysSrv(state.inseminations);
const lastHeatDate = lastOfSrv(state.estrusDates);
state.lastHeatDate = state.lastHeatDate || lastHeatDate || null;

state.heatIntervalDays =
  Number.isFinite(Number(state.heatIntervalDays)) && Number(state.heatIntervalDays) > 0
    ? Number(state.heatIntervalDays)
    : avgIntervalDaysSrv(state.estrusDates);

    // ✅ عمر الحمل: لا يُحسب من آخر تلقيح إطلاقًا
    let gestationDays = null;
    if (state.reproductiveStatus && /عشار|preg/i.test(String(state.reproductiveStatus))) {
      if (state.pregnancyDate) {
        gestationDays = daysBetweenIsoSrv(String(state.pregnancyDate).slice(0,10), cairoTodayISO());
        if (Number.isFinite(gestationDays) && gestationDays < 0) gestationDays = null;
      }
    }
    state.gestationDays = gestationDays;

    if (!Number.isFinite(Number(state.daysInMilk)) && state.lastCalvingDate) {
      const dim = daysBetweenIsoSrv(String(state.lastCalvingDate).slice(0,10), cairoTodayISO());
      state.daysInMilk = Number.isFinite(dim) && dim >= 0 ? dim : null;
    }

if (state.milkSeries.length) {
  const lastMilk = state.milkSeries[state.milkSeries.length - 1];

  state.milkTodayKg =
    Number.isFinite(Number(state.milkTodayKg)) && Number(state.milkTodayKg) > 0
      ? Number(state.milkTodayKg)
      : Number(lastMilk.kg || 0);

  state.seasonTotalKg =
    Number.isFinite(Number(state.seasonTotalKg)) && Number(state.seasonTotalKg) > 0
      ? Number(state.seasonTotalKg)
      : Math.round(seasonMilk * 100) / 100;

  const proj = projectLactation305AliSchaefferSrv({
    milkSeries: state.milkSeries,
    lastCalvingDate: state.lastCalvingDate,
    species: state.kind,
    breed: state.breed,
    parity: state.lactationNumber
  });

  state.m305Kg = proj?.m305Kg ?? null;
}
    return res.json({
      ok: true,
      animal: {
        id: animal.id,
        animalNumber: state.number,
        kind: state.kind,
        breed: state.breed,
        group: state.group,
        birthDate: state.birthDate,
        lastCalvingDate: state.lastCalvingDate,
        lactationNumber: state.lactationNumber,
        daysInMilk: state.daysInMilk,

        reproductiveStatus: state.reproductiveStatus,
        pregnancyDate: state.pregnancyDate,
        gestationDays: state.gestationDays,
        lastInseminationDate: state.lastInseminationDate,
        servicesCount: state.servicesCount,
        serviceIntervalDays: state.serviceIntervalDays,
        lastHeatDate: state.lastHeatDate,
        heatIntervalDays: state.heatIntervalDays,

        productionStatus: state.productionStatus,
        milkTodayKg: state.milkTodayKg,
        seasonTotalKg: state.seasonTotalKg,
        m305Kg: state.m305Kg,
        milkTraitsScore: state.milkTraitsScore,

        healthStatus: state.healthStatus,
        lastCheckDate: state.lastCheckDate,
        ovsynch: state.ovsynch
      },
      milkSeries: state.milkSeries,
      healthHistory: state.healthHistory.slice(-20).reverse(),
      events: events.slice(-80)
    });
  } catch (e) {
    console.error('animal-card', e);
    return res.status(500).json({ ok:false, error:'animal_card_failed' });
  }
});
app.get('/api/calves', requireUserId, async (req, res) => {
  try {
    const tenant = req.userId;

    if (db) {
      const snap = await db.collection('calves')
        .where('userId', '==', tenant)
        .limit(2000)
        .get();

      const calves = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      return res.json({ ok: true, calves });
    }

    return res.json({ ok: true, calves: [] });
  } catch (e) {
    console.error('calves api error:', e);
    return res.status(500).json({ ok:false, error:'calves_failed' });
  }
});
// ============================================================
//                 API: ARCHIVE ANIMAL
//                 animals -> archived_animals
//                 events  -> archived_events
// ============================================================

function archiveNormNumberSrv(v) {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };

  return String(v || "")
    .trim()
    .replace(/[٠-٩۰-۹]/g, d => map[d] || d)
    .replace(/[^\d]/g, "");
}

async function archiveFindAnimalSrv(uid, animalNumber) {
  const n = archiveNormNumberSrv(animalNumber);
  if (!db || !uid || !n) return null;

  const vals = [n];
  const nNum = Number(n);
  if (Number.isFinite(nNum)) vals.push(nNum);

  const found = new Map();

  for (const val of vals) {
    for (const ownerField of ["userId", "ownerUid"]) {
      for (const numField of ["number", "animalNumber"]) {
        try {
          const snap = await db.collection("animals")
            .where(ownerField, "==", uid)
            .where(numField, "==", val)
            .limit(3)
            .get();

          snap.forEach(d => found.set(d.id, d));
        } catch (_) {}
      }
    }
  }

  if (!found.size) return null;

  const d = [...found.values()][0];

  return {
    id: d.id,
    ref: d.ref,
    data: d.data() || {}
  };
}

async function archiveFetchEventsSrv(uid, animalNumber, animalDocId) {
  const n = archiveNormNumberSrv(animalNumber);
  const keys = [...new Set([
    n,
    String(animalNumber || "").trim(),
    String(animalDocId || "").trim()
  ].filter(Boolean))];

  const found = new Map();

  for (const key of keys) {
    for (const field of ["animalNumber", "animalId", "number"]) {
      try {
        const snap = await db.collection("events")
          .where("userId", "==", uid)
          .where(field, "==", key)
          .limit(5000)
          .get();

        snap.forEach(d => found.set(d.id, d));
      } catch (_) {}
    }
  }

  return [...found.values()];
}

async function archiveCommitOpsSrv(ops = []) {
  let batch = db.batch();
  let n = 0;

  for (const op of ops) {
    if (op.type === "set") batch.set(op.ref, op.data, op.options || {});
    if (op.type === "delete") batch.delete(op.ref);

    n++;

    if (n >= 450) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }

  if (n > 0) await batch.commit();
}
// ============================================================
//                 API: DEATH REASONS OPTIONS
//                 تحميل/حفظ أسباب النفوق من السيرفر فقط
// ============================================================

function archiveDeathReasonKeySrv(uid, label) {
  const clean = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[\/\\#?\[\]]/g, "_")
    .slice(0, 100);

  return `${uid}__${clean}`;
}

async function archiveSaveDeathReasonOptionSrv(uid, label) {
  try {
    const clean = String(label || "").trim();
    if (!db || !uid || !clean) return false;

    const key = archiveDeathReasonKeySrv(uid, clean);

    await db.collection("death_reasons").doc(key).set({
      userId: uid,
      label: clean,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return true;
  } catch (e) {
    console.error("death-reason option save failed", e);
    return false;
  }
}

app.get("/api/death-reasons/options", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        reasons: [],
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;

    const snap = await db.collection("death_reasons")
      .where("userId", "==", uid)
      .limit(200)
      .get();

    const defaultReasons = [
  "التهاب ضرع حاد / تسمم دموي",
  "نفاخ حاد",
  "تسمم غذائي",
  "حمى لبن / نقص كالسيوم حاد",
  "تعسر ولادة ومضاعفاته",
  "نزيف داخلي",
  "التهاب رحم حاد / تسمم رحمي",
  "إصابة أو حادث",
  "إجهاد حراري حاد",
  "مرض وبائي مشتبه"
];

const reasons = [...defaultReasons];

    snap.forEach(d => {
      const x = d.data() || {};
      const label = String(x.label || "").trim();
      if (label && !reasons.includes(label)) reasons.push(label);
    });

    reasons.sort((a, b) => a.localeCompare(b, "ar"));

    return res.json({
      ok: true,
      reasons
    });

  } catch (e) {
    console.error("death-reasons options", e);
    return res.status(500).json({
      ok: false,
      reasons: [],
      message: "تعذّر تحميل أسباب النفوق الآن."
    });
  }
});
// ============================================================
//                 API: ARCHIVE GATE — SALE / DEATH
//                 تحقق فتح صفحة البيع/النفوق فقط
// ============================================================

app.post("/api/animals/archive/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = archiveNormNumberSrv(body.animalNumber || body.number || "");
    const archiveReason = String(body.archiveReason || "").trim();

    if (!animalNumber) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "رقم الحيوان مطلوب."
      });
    }

    if (!["sale", "death"].includes(archiveReason)) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "سبب الأرشفة غير صالح."
      });
    }

    const animal = await archiveFindAnimalSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        allowed: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    const doc = animal.data || {};
    const st = String(doc.status || "active").trim().toLowerCase();

    if (st !== "active") {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    return res.json({
      ok: true,
      allowed: true,
      message: archiveReason === "sale"
        ? "✅ الحيوان مؤهل لتسجيل البيع."
        : "✅ الحيوان مؤهل لتسجيل النفوق.",
      animal: {
        id: animal.id,
        animalNumber,
        number: String(doc.number || animalNumber),
        lactationNumber: Number(doc.lactationNumber || 0) || null,
        animalType: doc.animalType || doc.animaltype || null,
        animalTypeAr: doc.animalTypeAr || null,
        species: doc.species || doc.animalTypeAr || doc.animalType || doc.animaltype || null,
        breed: doc.breed || null,
        productionStatus: doc.productionStatus || null,
        reproductiveStatus: doc.reproductiveStatus || null
      }
    });

  } catch (e) {
    console.error("animals.archive.gate", e);
    return res.status(500).json({
      ok: false,
      allowed: false,
      message: "فشل التحقق من الحيوان."
    });
  }
});
app.post("/api/animals/archive", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = archiveNormNumberSrv(body.animalNumber || body.number || "");
    const archiveReason = String(body.archiveReason || "").trim();

    if (!animalNumber) {
      return res.status(400).json({
        ok: false,
        message: "رقم الحيوان مطلوب."
      });
    }

    if (!["sale", "death"].includes(archiveReason)) {
      return res.status(400).json({
        ok: false,
        message: "سبب الأرشفة غير صالح."
      });
    }
const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
  return res.status(400).json({
    ok: false,
    message: archiveReason === "sale"
      ? "تاريخ البيع غير صالح."
      : "تاريخ النفوق غير صالح."
  });
}

if (archiveReason === "sale") {
  const saleReason = String(body.saleReason || "").trim();

  if (!saleReason) {
    return res.status(400).json({
      ok: false,
      message: "سبب البيع مطلوب."
    });
  }
}
    if (archiveReason === "death") {
  const deathReason = String(body.reason || body.deathReason || "").trim();

  if (!deathReason) {
    return res.status(400).json({
      ok: false,
      message: "سبب النفوق مطلوب."
    });
  }
}
    const animal = await archiveFindAnimalSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "تعذّر العثور على الحيوان في القطيع."
      });
    }

   
    const archiveId = `${uid}__${animalNumber}__${archiveReason}__${Date.now()}`;
    const archivedAt = admin.firestore.FieldValue.serverTimestamp();

    const events = await archiveFetchEventsSrv(uid, animalNumber, animal.id);

    const ops = [];
    const archivedAnimalRef = db.collection("archived_animals").doc(archiveId);

    ops.push({
      type: "set",
      ref: archivedAnimalRef,
      data: {
        ...animal.data,

        userId: uid,
        animalNumber,
        number: String(animal.data?.number || animalNumber),

        archivedAt,
        archiveDate: eventDate || null,
        archiveReason,
        archiveReasonLabel: archiveReason === "sale" ? "بيع" : "نفوق",

        originalAnimalDocId: animal.id,
        originalAnimalPath: animal.ref.path,

        salePrice: archiveReason === "sale" ? (Number(body.price) || null) : null,
        saleReason: archiveReason === "sale" ? String(body.saleReason || "").trim() : null,

        deathReason: archiveReason === "death"
  ? String(body.reason || body.deathReason || "").trim()
  : null,

        season: Number(body.season) || null,
        notes: String(body.notes || "").trim() || null
      },
      options: { merge: true }
    });

    for (const evDoc of events) {
      const ev = evDoc.data() || {};

      ops.push({
        type: "set",
        ref: db.collection("archived_events").doc(evDoc.id),
        data: {
          ...ev,
          userId: uid,
          animalNumber,

          archivedAt,
          archiveDate: eventDate || null,
          archiveReason,
          archiveReasonLabel: archiveReason === "sale" ? "بيع" : "نفوق",

          originalEventId: evDoc.id,
          originalEventPath: evDoc.ref.path,
          originalAnimalDocId: animal.id,
          archivedAnimalId: archiveId
        },
        options: { merge: true }
      });
    }

    for (const evDoc of events) {
      ops.push({ type: "delete", ref: evDoc.ref });
    }

    ops.push({ type: "delete", ref: animal.ref });

await archiveCommitOpsSrv(ops);

if (archiveReason === "death") {
  await archiveSaveDeathReasonOptionSrv(
    uid,
    String(body.reason || body.deathReason || "").trim()
  );
}

if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "animal_archived");
    }

    return res.json({
      ok: true,
      animalNumber,
      archivedAnimalId: archiveId,
      archivedEventsCount: events.length,
      message: archiveReason === "sale"
        ? "✅ تم أرشفة الحيوان وأحداثه بعد البيع."
        : "✅ تم أرشفة الحيوان وأحداثه بعد النفوق."
    });

  } catch (e) {
    console.error("animals.archive", e);
    return res.status(500).json({
      ok: false,
      message: "فشل أرشفة الحيوان وأحداثه."
    });
  }
});
// ============================================================
//                 API: CULL — SERVER SIDE
//                 الاستبعاد لا يؤرشف الحيوان
// ============================================================

const CULL_OPTIONS_SRV = {
  "انتاجي": [
    "انخفاض إنتاج اللبن",
    "موسم ضعيف متكرر",
    "جودة لبن ضعيفة / SCC مرتفع",
    "عمر إنتاجي كبير",
    "مشاكل حليب متكررة"
  ],
  "تناسلي": [
    "تكرار تلقيح بدون حمل",
    "تأخر عشار / طول فترة مفتوحة",
    "التهاب رحم مزمن",
    "تكرار إجهاض",
    "مشاكل ولادة متكررة"
  ],
  "صحي": [
    "التهاب ضرع مزمن",
    "عرج مزمن",
    "هزال شديد / BCS منخفض",
    "أمراض متكررة",
    "إصابة / كسر",
    "اضطرابات أيضية متكررة"
  ]
};

app.get("/api/cull/options", requireUserId, async (req, res) => {
  return res.json({
    ok: true,
    options: CULL_OPTIONS_SRV
  });
});

app.post("/api/cull/gate", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        allowed: false,
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};
    const animalNumber = archiveNormNumberSrv(body.animalNumber || body.number || "");

    if (!animalNumber) {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "رقم الحيوان مطلوب."
      });
    }

    const animal = await archiveFindAnimalSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        allowed: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    const doc = animal.data || {};
    const st = String(doc.status || "active").trim().toLowerCase();

    if (st !== "active") {
      return res.status(400).json({
        ok: false,
        allowed: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    return res.json({
      ok: true,
      allowed: true,
      message: "✅ الحيوان مؤهل لتسجيل الاستبعاد.",
      animal: {
        id: animal.id,
        animalNumber,
        number: String(doc.number || animalNumber),
        reproductiveStatus: doc.reproductiveStatus || null,
        productionStatus: doc.productionStatus || null,
        breedingBlocked: doc.breedingBlocked === true
      }
    });

  } catch (e) {
    console.error("cull.gate", e);
    return res.status(500).json({
      ok: false,
      allowed: false,
      message: "فشل التحقق من الحيوان."
    });
  }
});

app.post("/api/cull/save", requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        message: "قاعدة البيانات غير متاحة الآن."
      });
    }

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = archiveNormNumberSrv(body.animalNumber || body.number || "");
    const eventDate = String(body.eventDate || body.date || "").trim().slice(0, 10);
    const cullMain = String(body.cullMain || "").trim();
    const cullDetail = String(body.cullDetail || "").trim();
    const notes = String(body.notes || "").trim();

    if (!animalNumber) {
      return res.status(400).json({
        ok: false,
        message: "رقم الحيوان مطلوب."
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({
        ok: false,
        message: "تاريخ الاستبعاد غير صالح."
      });
    }

    if (!cullMain || !CULL_OPTIONS_SRV[cullMain]) {
      return res.status(400).json({
        ok: false,
        message: "سبب الاستبعاد الرئيسي مطلوب."
      });
    }

    if (!cullDetail || !CULL_OPTIONS_SRV[cullMain].includes(cullDetail)) {
      return res.status(400).json({
        ok: false,
        message: "تفصيل سبب الاستبعاد مطلوب."
      });
    }

    const animal = await archiveFindAnimalSrv(uid, animalNumber);

    if (!animal) {
      return res.status(404).json({
        ok: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    const doc = animal.data || {};
    const st = String(doc.status || "active").trim().toLowerCase();

    if (st !== "active") {
      return res.status(400).json({
        ok: false,
        message: "❌ الحيوان غير موجود في القطيع."
      });
    }

    const reason = `${cullMain} — ${cullDetail}`;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const eventRef = db.collection("events").doc();

    await db.runTransaction(async (tx) => {
      tx.set(eventRef, {
        animalNumber,
        animalId: animalNumber,
        type: "استبعاد",
        eventType: "استبعاد",
        eventTypeNorm: "cull",
        eventDate,
        cullMain,
        cullDetail,
        reason,
        notes,
        userId: uid,
        source: "/cull.html",
        createdAt: now
      });

      tx.set(animal.ref, {
        breedingBlocked: true,
        cullStatus: "excluded",
        lastCullDate: eventDate,
        cullMain,
        cullDetail,
        cullReason: reason,
        reproductiveStatus: "لا تلقح مرة أخرى",
        updatedAt: now
      }, { merge: true });
    });

    if (typeof scheduleGroupsRebuildSrv === "function") {
      scheduleGroupsRebuildSrv(uid, "cull_saved");
    }

    return res.json({
      ok: true,
      message: "✅ تم حفظ الاستبعاد بنجاح",
      eventId: eventRef.id,
      animalNumber,
      redirectUrl: `cow-card.html?number=${encodeURIComponent(animalNumber)}`
    });

  } catch (e) {
    console.error("cull.save", e);
    return res.status(500).json({
      ok: false,
      message: "فشل حفظ الاستبعاد."
    });
  }
});
// Static last
app.use(express.static(path.join(__dirname, 'www')));
// ✅ DIM job
startDailyDimJob();
// (اختياري ومفيد) تشغيل مرة واحدة فورًا بعد كل Deploy:
updateAllDIM();
// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
