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



const CUSTOM_FEED_TYPES = new Set([
  'mineral_vitamin_premix',
  'mineral_premix',
  'vitamin_premix',
  'rumen_support_additive',
  'full_custom_additive'
]);

const CUSTOM_FEED_NUMERIC_FIELDS = [
  'dmPct','cpPct','ndfPct','adfPct','starchPct','wscPct','fatPct','crudeFatPct','faPct','ashPct','ligninPct',
  'baseDEMcalPerKgDM','nelMcalPerKgDM','mpGPerKgDM',
  'caPct','pPct','mgPct','naPct','kPct','clPct','sPct',
  'znMgKgDM','cuMgKgDM','mnMgKgDM','seMgKgDM','iMgKgDM','coMgKgDM','feMgKgDM',
  'vitAIUPerKgDM','vitDIUPerKgDM','vitEIUPerKgDM','biotinMgKgDM','niacinMgKgDM','cholineMgKgDM',
  'caAbsorptionCoeff','pAbsorptionCoeff','mgAbsorptionCoeff','naAbsorptionCoeff','kAbsorptionCoeff','clAbsorptionCoeff','sAbsorptionCoeff',
  'znAbsorptionCoeff','cuAbsorptionCoeff','mnAbsorptionCoeff','seAbsorptionCoeff','iAbsorptionCoeff','coAbsorptionCoeff','feAbsorptionCoeff'
];

function cleanCustomFeedPayload(body = {}, tenant = '') {
  // يدعم وصول البيانات مباشرة أو مغلفة من الواجهة
  // الملكية لا تؤخذ من body أبدًا، فقط من req.userId القادم من X-User-Id
  const src =
    (body && typeof body.feed === 'object' && body.feed) ||
    (body && typeof body.customFeed === 'object' && body.customFeed) ||
    (body && typeof body.payload === 'object' && body.payload) ||
    body ||
    {};

  const customTypeRaw = String(src.customType || src.typeKey || '').trim();

  const customType = CUSTOM_FEED_TYPES.has(customTypeRaw)
    ? customTypeRaw
    : 'mineral_vitamin_premix';

  const typeLabelMap = {
    mineral_vitamin_premix: 'بريمكس معادن وفيتامينات',
    mineral_premix: 'بريمكس معادن',
    vitamin_premix: 'بريمكس فيتامينات',
    rumen_support_additive: 'إضافة داعمة للكرش',
    full_custom_additive: 'إضافة مخصصة'
  };

  const defaultName = `${typeLabelMap[customType] || 'بريمكس'} — مزرعتي`;

  const nameAr = String(src.nameAr || src.displayName || src.name || '').trim() || defaultName;
  const userLabel = String(src.userLabel || '').trim() || null;

  const out = {
    // ✅ ملكية خاصة بالمستخدم الحالي فقط
    ownerUserId: tenant,
    userId: tenant,

    // farmId اختياري للتوسع، لكنه لا يحدد الملكية
    farmId: String(src.farmId || '').trim() || null,

    scope: 'farm_private',
    source: 'user_custom',
    customType,
    userLabel,

    id: null,
    feedId: null,

    nameAr,
    name: nameAr,
    nameEn: String(src.nameEn || '').trim() || null,

    cat: 'add',
    category: 'Vitamin/Mineral',
    type: 'Concentrate',
    enabled: true,

    // البريمكس/الإضافة المخصصة مادة جافة عمليًا
    dmPct: 100,

    // لا يلوّث الطاقة أو البروتين أو الألياف
    cpPct: 0,
    ndfPct: 0,
    adfPct: 0,
    starchPct: 0,
    wscPct: 0,
    fatPct: 0,
    crudeFatPct: 0,
    faPct: 0,
    ashPct: 0,
    ligninPct: 0,
    baseDEMcalPerKgDM: 0,
    nelMcalPerKgDM: 0,
    mpGPerKgDM: 0,

    // معاملات امتصاص افتراضية مثل لغة مكتبة مُرَبِّيك
    caAbsorptionCoeff: 0.5,
    pAbsorptionCoeff: 0.68,
    mgAbsorptionCoeff: 0.23,
    naAbsorptionCoeff: 1,
    kAbsorptionCoeff: 1,
    clAbsorptionCoeff: 0.92,
    sAbsorptionCoeff: 0,

    znAbsorptionCoeff: 0.2,
    cuAbsorptionCoeff: 0.05,
    mnAbsorptionCoeff: 0.005,
    seAbsorptionCoeff: 0,
    iAbsorptionCoeff: 0,
    coAbsorptionCoeff: 0,
    feAbsorptionCoeff: 0.1
  };

  for (const k of CUSTOM_FEED_NUMERIC_FIELDS) {
    if (src[k] === '' || src[k] === null || src[k] === undefined) continue;

    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= 0) {
      out[k] = n;
    }
  }

  // تثبيت نهائي
  out.dmPct = 100;

  return cleanObj(out);
}
async function enrichNutritionRowsFromFeedItems(tenant, rawRows = []) {
  if (!db || !Array.isArray(rawRows) || !rawRows.length) return rawRows;

  try {
    const snap = await db.collection('feed_items').get();

    const byId = new Map();
    const byName = new Map();

    snap.forEach(doc => {
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
        d.sourceFeedName,
        doc.id
      ].forEach(x => {
        const k = feedKeySrv(x);
        if (k && !byName.has(k)) byName.set(k, feed);
      });
    });



    const customSnap = await db.collection('custom_feed_items')
      .where('ownerUserId', '==', tenant)
      .where('enabled', '==', true)
      .get();

    customSnap.forEach(doc => {
      const d = doc.data() || {};
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
        doc.id
      ].forEach(x => {
        const k = feedKeySrv(x);
        if (k && !byName.has(k)) byName.set(k, feed);
      });
    });

    return rawRows.map(r => {
      const row = r || {};
      const explicitId = pickFeedIdFromRowSrv(row);

      const feed =
        (explicitId && byId.get(explicitId)) ||
        byName.get(feedKeySrv(row.name || row.feedName || row.nameAr)) ||
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
        name: row.name || feed.nameAr || feed.name || null,
        nameAr: feed.nameAr || row.nameAr || row.name || null,
        cat: row.cat || feed.cat || feed.category || null,

        ...amountPatch,

        _feedLibraryMerged: true,
        _feedLibrarySource: feed.source || null
      });
    });
  } catch (e) {
    console.error('nutrition feed_items merge failed:', e.message || e);
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
      desired.set(String(n), {
        group: groupName || null,
        groupId: groupId || null,
        groupKey: groupKey || null,
        feedingEligible,
        groupSpecies: species,
        groupAvgMilkKg: avgMilkKg,
        groupAvgDim: avgDim,
        groupUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
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


// ============================================================
//             API: NUTRITION CUSTOM FEEDS / PREMIX
// ============================================================
app.get('/api/nutrition/custom-feeds', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const snap = await db.collection('custom_feed_items')
      .where('ownerUserId', '==', req.userId)
      .where('enabled', '==', true)
      .get();

    const feeds = [];
    snap.forEach(doc => {
      feeds.push(cleanObj({ id: doc.id, feedId: doc.id, ...(doc.data() || {}) }));
    });

    feeds.sort((a, b) => String(a.nameAr || '').localeCompare(String(b.nameAr || ''), 'ar'));

    return res.json({ ok:true, feeds });
  } catch (e) {
    console.error('nutrition.custom-feeds error:', e.message || e);
    return res.status(500).json({ ok:false, error:'custom_feeds_failed', message:e.message || String(e) });
  }
});

app.post('/api/nutrition/custom-feed', requireUserId, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: 'firestore_disabled'
      });
    }

    // الملكية من req.userId فقط، وreq.userId جاي من requireUserId
    const tenant = req.userId;
    const rawBody = req.body || {};

    const payload = cleanCustomFeedPayload(rawBody, tenant);

    const numericKeys = [
      'caPct','pPct','mgPct','naPct','kPct','clPct','sPct',
      'znMgKgDM','cuMgKgDM','mnMgKgDM','seMgKgDM','iMgKgDM','coMgKgDM','feMgKgDM',
      'vitAIUPerKgDM','vitDIUPerKgDM','vitEIUPerKgDM',
      'biotinMgKgDM','niacinMgKgDM','cholineMgKgDM'
    ];

    const hasAnyValue = numericKeys.some(k => Number(payload[k] || 0) > 0);

    if (!hasAnyValue) {
      console.warn('NUTRITION CUSTOM FEED rejected: empty analysis', {
        userId: tenant,
        bodyKeys: Object.keys(rawBody || {}),
        nestedFeedKeys: rawBody?.feed && typeof rawBody.feed === 'object' ? Object.keys(rawBody.feed) : [],
        nestedPayloadKeys: rawBody?.payload && typeof rawBody.payload === 'object' ? Object.keys(rawBody.payload) : [],
        nestedCustomFeedKeys: rawBody?.customFeed && typeof rawBody.customFeed === 'object' ? Object.keys(rawBody.customFeed) : []
      });

      return res.status(400).json({
        ok: false,
        error: 'custom_feed_empty',
        message: 'أدخل قيمة واحدة على الأقل من تحليل البريمكس.',
        debug: {
          bodyKeys: Object.keys(rawBody || {}),
          nestedFeedKeys: rawBody?.feed && typeof rawBody.feed === 'object' ? Object.keys(rawBody.feed) : [],
          nestedPayloadKeys: rawBody?.payload && typeof rawBody.payload === 'object' ? Object.keys(rawBody.payload) : [],
          nestedCustomFeedKeys: rawBody?.customFeed && typeof rawBody.customFeed === 'object' ? Object.keys(rawBody.customFeed) : []
        }
      });
    }

    console.log('NUTRITION CUSTOM FEED save request', {
      userId: tenant,
      nameAr: payload.nameAr,
      customType: payload.customType
    });

    const ref = await db.collection('custom_feed_items').add({
      ...payload,
      id: null,
      feedId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await ref.set({
      id: ref.id,
      feedId: ref.id
    }, { merge: true });

const saved = {
  ...payload,
  id: ref.id,
  feedId: ref.id
};

    console.log('NUTRITION CUSTOM FEED saved', {
      userId: tenant,
      id: ref.id,
      nameAr: saved.nameAr
    });

    return res.json({
      ok: true,
      id: ref.id,
      feed: saved
    });

  } catch (e) {
    console.error('nutrition.custom-feed save error:', e);
    return res.status(500).json({
      ok: false,
      error: 'custom_feed_save_failed',
      message: e.message || String(e)
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

      // ✅ لو فيه عليقة عامة محفوظة بدون تقسيم عالي/متوسط/منخفض
      // لا نمسحها بصفر
      if (latestByBand.has('overall')) {
        feedBands.overall = buildFeedBandFromEvent(latestByBand.get('overall'));
      }

      // ✅ نجمع الشرائح فقط لو فيه شرائح فعلًا
      const feedSegmentCards = [
        feedBands.high,
        feedBands.medium,
        feedBands.low,
        feedBands.fresh
      ].filter(x => x && Number(x.headCount || 0) > 0);

      if (feedSegmentCards.length) {
        feedBands.overall = weightedFeedBands(feedSegmentCards);
      }
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
//                 API: HEAT CONTEXT (server-only)
// ============================================================
app.get('/api/heat/context', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const uid = req.userId;
    const animalNumber = normalizeDigitsSrv(req.query.animalNumber || '');
    const eventDate = String(req.query.eventDate || '').slice(0,10);

    if (!animalNumber) {
      return res.status(400).json({ ok:false, error:'animalNumber_required' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ ok:false, error:'eventDate_required' });
    }

    const animal = await findAnimalDocByNumberSrv(uid, animalNumber);
    if (!animal) {
      return res.status(404).json({ ok:false, error:'animal_not_found' });
    }

    const reproductiveStatus =
      String(
        animal.reproductiveStatus ||
        animal.reproStatus ||
        animal.lastDiagnosis ||
        ''
      ).trim();

    let dimAtEvent = null;
    const lastCalvingDate = String(animal.lastCalvingDate || '').slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastCalvingDate)) {
      dimAtEvent = daysBetweenIsoSrv(lastCalvingDate, eventDate);
      if (dimAtEvent != null && dimAtEvent < 0) dimAtEvent = 0;
    }

    const lastEvent = await getLatestHeatOrInseminationSrv(uid, animalNumber, eventDate);

    let lastEventType = null;
    let lastEventDate = null;
    let daysSinceLastHeatOrAI = null;

    if (lastEvent?._eventDate) {
      lastEventDate = lastEvent._eventDate;
      lastEventType = lastEvent._typeNorm;
      daysSinceLastHeatOrAI = daysBetweenIsoSrv(lastEventDate, eventDate);
      if (daysSinceLastHeatOrAI != null && daysSinceLastHeatOrAI < 0) {
        daysSinceLastHeatOrAI = null;
      }
    }

    return res.json({
      ok: true,
      animalId: String(animal.id || animal.animalId || animalNumber),
      animalNumber: String(animal.animalNumber || animal.number || animalNumber),
      species: normalizeSpeciesSrv(animal.species || animal.animalTypeAr || animal.animalType || animal.animaltype),
      reproductiveStatus,
      dimAtEvent,
      lastEventType,
      lastEventDate,
      daysSinceLastHeatOrAI
    });
  } catch (e) {
    console.error('heat-context', e);
    return res.status(500).json({ ok:false, error:'heat_context_failed' });
  }
});
// ============================================================
//                 API: HEAT SAVE (server-only)
// ============================================================
app.post('/api/heat/save', requireUserId, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok:false, error:'firestore_disabled' });

    const uid = req.userId;
    const body = req.body || {};

    const animalNumber = normalizeDigitsSrv(body.animalNumber || '');
    const eventDate = String(body.eventDate || '').slice(0,10);
    const heatTime = String(body.heatTime || '').trim() || null;
    const notes = String(body.notes || '').trim() || null;

    if (!animalNumber) {
      return res.status(400).json({ ok:false, error:'animalNumber_required' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ ok:false, error:'eventDate_required' });
    }

    const animal = await findAnimalDocByNumberSrv(uid, animalNumber);
    if (!animal) {
      return res.status(404).json({ ok:false, error:'animal_not_found' });
    }

    const ctx = await (async () => {
      const reproductiveStatus =
        String(
          animal.reproductiveStatus ||
          animal.reproStatus ||
          animal.lastDiagnosis ||
          ''
        ).trim();

      let dimAtEvent = null;
      const lastCalvingDate = String(animal.lastCalvingDate || '').slice(0,10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(lastCalvingDate)) {
        dimAtEvent = daysBetweenIsoSrv(lastCalvingDate, eventDate);
        if (dimAtEvent != null && dimAtEvent < 0) dimAtEvent = 0;
      }

      const lastEvent = await getLatestHeatOrInseminationSrv(uid, animalNumber, eventDate);

      let daysSinceLastHeatOrAI = null;
      if (lastEvent?._eventDate) {
        daysSinceLastHeatOrAI = daysBetweenIsoSrv(lastEvent._eventDate, eventDate);
        if (daysSinceLastHeatOrAI != null && daysSinceLastHeatOrAI < 0) {
          daysSinceLastHeatOrAI = null;
        }
      }

      return { reproductiveStatus, dimAtEvent, daysSinceLastHeatOrAI };
    })();

    const payload = {
      animalNumber: String(animal.animalNumber || animal.number || animalNumber),
      animalId: String(animal.id || animal.animalId || animalNumber),
      type: "شياع",
      eventType: "شياع",
      eventDate,
      heatTime,
      notes,
      reproductiveStatusSnapshot: ctx.reproductiveStatus || null,
      dimAtEvent: ctx.dimAtEvent ?? null,
      daysSinceLastHeatOrAI: ctx.daysSinceLastHeatOrAI ?? null,
      userId: uid,
      source: "/heat.html",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const evRef = await db.collection('events').add(payload);

    const animalRef = await findAnimalDocRefByNumberForTenant(uid, animalNumber);
    if (animalRef) {
      await animalRef.ref.set({
        lastHeatDate: eventDate
      }, { merge:true });
    }

    return res.json({
      ok: true,
      id: evRef.id,
      animalNumber: payload.animalNumber,
      animalId: payload.animalId,
      saved: payload
    });
  } catch (e) {
    console.error('heat-save', e);
    return res.status(500).json({ ok:false, error:'heat_save_failed' });
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
  const raw = [
    an?.sex, an?.gender, an?.animalSex, an?.sexAr, an?.genderAr
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');

  if (raw.includes('female') || raw.includes('انث') || raw.includes('أنث') || raw.includes('نتاي')) return 'أنثى';
  if (raw.includes('male') || raw === 'm' || raw.includes('ذكر')) return 'ذكر';
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
  const calv = toDate(an?.lastCalvingDate) || toDate(an?.calvingDate) || toDate(an?.calvedAt);
  if (!calv || Number.isNaN(calv.getTime())) return Number(an?.daysInMilk) || 0;
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

function buildServerGroupDocSrv(tenant, groupId, list, thresholds = {}) {
  const def = GROUP_DEF_BY_ID_SRV[groupId];
  const count = list.length || 0;
  const milkVals = list.map(getMilkKgSrv).filter(v => Number.isFinite(v));
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
      } else if (hasCalvedBeforeGroupSrv(an)) {
        g[pref + 'dry'].push(an);
      } else {
        g[pref + 'pregHeifers'].push(an);
      }
      continue;
    }

    if (isWeanedGroupSrv(an, sp, thresholds))  { g[pref + 'weaned'].push(an); continue; }
    if (isGrowingGroupSrv(an, sp, thresholds)) { g[pref + 'growing'].push(an); continue; }

    if (!hasCalvedBeforeGroupSrv(an) && hasWeaningEventGroupSrv(an) && !isPregnantGroupSrv(an) && isBreedingStatusGroupSrv(an)) {
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
    const row = { ...r, animalNumber:n, number:n };
    const old = byNumber.get(n);
    if (!old || Number(row._sourceRank || 99) < Number(old._sourceRank || 99)) {
      byNumber.set(n, row);
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
