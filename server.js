// server.js — stable build, tenant-aware
// ----------------------------------------------
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const { computeTargets } = require('./server/nutrition-engine.js');
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));



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
      updated++;
      ops++;

      if (ops >= 400){
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    console.log("✅ DIM updated:", { todayISO, scanned, updated });
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

    const lat = Number(req.query.lat || WEATHER_DEFAULT_LAT);
    const lon = Number(req.query.lon || WEATHER_DEFAULT_LON);

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m&timezone=auto`;

    const r = await fetch(url, { cache: 'no-store' });

    if (!r.ok) {
      throw new Error(`open_meteo_${r.status}`);
    }

    const j = await r.json();

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
    console.error('weather.thi error:', e.message || e);

    return res.status(500).json({
      ok: false,
      error: 'weather_thi_failed',
      message: e.message || String(e)
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

  return cleanObj({
    group: ctx.group || null,
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
    groupBcs: toNumOrNull(ctx.groupBcs ?? ctx.representativeBcs)
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
  cpTarget: toNumOrNull(a?.targets?.cpTarget),
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
      milkMargin: toNumOrNull(a?.economics?.milkMargin)
    },
       inputs: {
      bodyWeightKgUsed: toNumOrNull(a?.inputs?.bodyWeightKgUsed),
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
    feedCostPerLiter: 0,
    feedEfficiency: 0,
    feedCostPerHeadPerDay: 0,
    iofc: 0,
    eventDate: null
  };
}

function feedBandKey(raw = '') {
  const s = String(raw || '').trim().toLowerCase();

  if (/high|عالي/.test(s)) return 'high';
  if (/medium|med|متوسط/.test(s)) return 'medium';
  if (/low|منخفض/.test(s)) return 'low';

  return 'overall';
}

function buildFeedBandFromEvent(e = {}) {
  const a = e?.nutrition?.analysis || {};
  const ctx = e?.nutrition?.context || {};
  const economics = a?.economics || {};
  const totals = a?.totals || {};

  const dmPerKgMilk = Number(economics?.dmPerKgMilk || 0);
  const feedEfficiency =
    dmPerKgMilk > 0 ? +(1 / dmPerKgMilk).toFixed(2) : 0;

  return {
    headCount: Number(e?.groupSize || 1) || 1,
    avgMilkKg: Number(ctx?.avgMilkKg || 0) || 0,
    feedCostPerLiter: Number(economics?.costPerKgMilk || 0) || 0,
    feedEfficiency,
    feedCostPerHeadPerDay: Number(totals?.totCost || 0) || 0,
   iofc: Number.isFinite(Number(economics?.milkMargin))
  ? Number(economics.milkMargin)
  : (
      Number.isFinite(Number(economics?.milkRevenue)) &&
      Number.isFinite(Number(totals?.totCost))
        ? +(Number(economics.milkRevenue) - Number(totals.totCost)).toFixed(2)
        : 0
    ),
    eventDate: e?.eventDate || e?.date || null
  };
}

function weightedFeedBands(cards = []) {
  const valid = cards.filter(x => x && Number(x.headCount) > 0);
  if (!valid.length) return emptyFeedBand();

  const totalHeads = valid.reduce((s, x) => s + Number(x.headCount || 0), 0) || 0;
  if (!totalHeads) return emptyFeedBand();

  const wavg = (key) => {
    const sum = valid.reduce((s, x) => s + (Number(x[key] || 0) * Number(x.headCount || 0)), 0);
    return +(sum / totalHeads).toFixed(2);
  };

  return {
    headCount: totalHeads,
    avgMilkKg: wavg('avgMilkKg'),
    feedCostPerLiter: wavg('feedCostPerLiter'),
    feedEfficiency: wavg('feedEfficiency'),
    feedCostPerHeadPerDay: wavg('feedCostPerHeadPerDay'),
    iofc: wavg('iofc'),
    eventDate: null
  };
}
function normalizeFatTypeSrv(v = '') {
  const s = String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/\s+/g, ' ');

  if (!s) return null;

  if (
    /protected|bypass|calcium\s*salt|prilled|rumen\s*protected|محم|محمي|محميه|محمية|دهون محميه|دهون محمية/.test(s)
  ) {
    return 'protected';
  }

  if (
    /free|unprotected|oil|زيت|زيوت|دهن حر|دهون حره|دهون حرة|شحم/.test(s)
  ) {
    return 'free';
  }

  return null;
}

function classifyFatTypeFromRowSrv(r = {}) {
  const explicit = normalizeFatTypeSrv(
    r?.fatType ??
    r?.fatKind ??
    r?.lipidType ??
    r?.fatProtection ??
    r?.protectedFatType ??
    r?.fatSourceClass ??
    r?.faSourceClass
  );

  if (explicit === 'protected') return 'protected';

  const byName = normalizeFatTypeSrv(
    r?.name ||
    r?.nameAr ||
    r?.feedName ||
    r?.sourceFeedName ||
    r?.id ||
    ''
  );

  if (byName === 'protected') return 'protected';

  // القاعدة المعتمدة في مُرَبِّيك:
  // أي دهن غير محمي صراحةً يُعامل كدهون حرة.
  return 'free';
}

function buildFatPartitionModel(rows = []) {
  const list = Array.isArray(rows) ? rows : [];

  let totalDmKg = 0;
  let totalFatKg = 0;
  let freeFatKg = 0;
  let protectedFatKg = 0;

  for (const r of list) {
    const asFedKg = Number(r?.asFedKg || 0);
    const dmPct = Number(r?.dmPct || 0);
    const fatPct = Number(
      r?.fatPct ??
      r?.crudeFatPct ??
      r?.faPct ??
      0
    );

    if (!(asFedKg > 0) || !(dmPct > 0) || !(fatPct > 0)) continue;

    const dmKg = asFedKg * (dmPct / 100);
    const fatKg = dmKg * (fatPct / 100);
    const fatType = classifyFatTypeFromRowSrv(r);

    totalDmKg += dmKg;
    totalFatKg += fatKg;

    if (fatType === 'protected') {
      protectedFatKg += fatKg;
    } else {
      freeFatKg += fatKg;
    }
  }

  if (!(totalDmKg > 0)) return null;

  const pct = (kg) => round2((kg / totalDmKg) * 100) || 0;

  const totalFatPct = pct(totalFatKg);
  const freeFatPct = pct(freeFatKg);
  const protectedFatPct = pct(protectedFatKg);

  const totalFatCeilingPctDM = 7;
  const freeFatCeilingPctDM = 5;

  const totalHigh =
    Number.isFinite(Number(totalFatPct)) &&
    totalFatPct > totalFatCeilingPctDM;

  const freeHigh =
  totalHigh &&
  Number.isFinite(Number(freeFatPct)) &&
  freeFatPct > freeFatCeilingPctDM;

  let status = 'good';
  let title = 'الدهون داخل الحد';
  let reason = 'مستوى الدهون لا يظهر ضغطًا واضحًا على العليقة.';
  let instruction = 'لا ترفعها إلا لهدف طاقة واضح.';

  if (freeHigh) {
    status = 'watch';
    title = 'الدهون الحرة مرتفعة';
    reason = 'الدهون غير المحمية قد تضغط على هضم الألياف في الكرش.';
    instruction = 'قلّل الدهون غير المحمية لحماية هضم الألياف.';
  } else if (totalHigh && protectedFatPct > freeFatPct) {
    status = 'watch';
    title = 'الدهن مرتفع من مصدر محمي';
    reason = 'الدهون المحمية لا تُعامل كخطر مباشر على هضم الألياف مثل الدهون الحرة.';
    instruction = 'راقب الطاقة والتكلفة.';
  } else if (totalHigh) {
    status = 'watch';
    title = 'الدهن الكلي مرتفع';
    reason = 'إجمالي دهن العليقة أعلى من الحد، ومعظمه غير محمي.';
    instruction = 'راجع مصدر الدهون قبل اعتماد العليقة.';
  }

  return {
    model: 'MURABBIK_FAT_FREE_PROTECTED_V1',
    status,
    title,
    reason,
    instruction,
    uiText: `${title}. ${instruction}`,

    totalFatPct,
    freeFatPct,
    protectedFatPct,

    totalFatCeilingPctDM,
    freeFatCeilingPctDM,

    fatKg: {
      total: round2(totalFatKg),
      free: round2(freeFatKg),
      protected: round2(protectedFatKg)
    }
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
fatType: classifyFatTypeFromRowSrv(r),
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
fatType: classifyFatTypeFromRowSrv(r),    
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

  const bodyWeightKgUsed = pickFirstFinite(
    context.bodyWeightKg,
    context.cameraWeightKg,
    context.groupBodyWeightKg,
    breedDefaults.bodyWeightKg
  );

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

  const bcsUsed = pickFirstFinite(
    context.bcs,
    context.groupBcs
  );

  return {
    breedDefaults,
    bodyWeightKgUsed,
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
const fatPartitionModel = buildFatPartitionModel(cleanRows);
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
  ndfTarget: targetsCore?.ndfTarget,
  peNDFActual,
  peNDFMin: targetsCore?.peNDFMin,
  roughageMin: targetsCore?.roughageMin,
  forageNDFMin: forageNDFMinForRumen,
  carbohydrateSafetyModel: rationCore?.nutrition?.carbohydrateSafetyModel || null
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
  fatPctActual: fatPartitionModel?.totalFatPct ?? rationCore?.nutrition?.fatPctActual ?? null,
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
fatModel: fatPartitionModel || rationCore?.nutrition?.fatModel || null,
carbohydrateModel: rationCore?.nutrition?.carbohydrateModel || null,
carbohydrateSafetyModel: rationCore?.nutrition?.carbohydrateSafetyModel || null,
dmiRationEffect: rationCore?.nutrition?.dmiRationEffect || null
},

  targets: {
  dmiTarget: targetsCore?.dmi ?? null,
  nelTarget: targetsCore?.nel ?? null,
  cpTarget: targetsCore?.cpTarget ?? null,
  mpTargetG: targetsCore?.mpTargetG ?? null,
  ndfTarget: targetsCore?.ndfTarget ?? null,
  fatTarget: null,
  starchMax: targetsCore?.starchMax ?? null,
  roughageMin: targetsCore?.roughageMin ?? null,
  peNDFMin: targetsCore?.peNDFMin ?? null,
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
      milkMargin
    },
       inputs: {
      bodyWeightKgUsed: runtimeCtx.bodyWeightKgUsed,
      milkFatPctUsed: runtimeCtx.milkFatPctUsed,
      milkProteinPctUsed: runtimeCtx.milkProteinPctUsed,
      lactationNumberUsed: runtimeCtx.lactationNumberUsed,
      thiUsed: runtimeCtx.thiUsed,
      bcsUsed: runtimeCtx.bcsUsed,
      
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
  ndfTarget,
  peNDFActual,
  peNDFMin,
  roughageMin,
  forageNDFMin,
  carbohydrateSafetyModel = null
}) {
  const rough = Number(roughPctDM);
  const conc = Number(concPctDM);
  const forageNDF = Number(forageNDFPctDM);
  const forageNDFShare = Number(forageNDFShareOfTotalNDF);
  const starch = Number(starchActual);
  const starchLimit = Number(starchMax);
  const ndf = Number(ndfActual);
  const ndfLimit = Number(ndfTarget);

  const pendf = Number(peNDFActual);
  const pendfFloor = Number.isFinite(Number(peNDFMin)) ? Number(peNDFMin) : 18;
  const roughFloor = Number.isFinite(Number(roughageMin)) ? Number(roughageMin) : 40;
  const forageNDFFloor = Number.isFinite(Number(forageNDFMin)) ? Number(forageNDFMin) : 19;

  const safePct = (v) =>
    Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null;

  const gap = (target, actual) =>
    Number.isFinite(Number(target)) && Number.isFinite(Number(actual))
      ? Number(target) - Number(actual)
      : 0;

  const starchHigh =
    Number.isFinite(starch) &&
    Number.isFinite(starchLimit) &&
    starch > starchLimit;

  const starchVeryHigh =
    Number.isFinite(starch) &&
    Number.isFinite(starchLimit) &&
    starch >= starchLimit + 8;

  const ndfGap = gap(ndfLimit, ndf);
  const pendfGap = gap(pendfFloor, pendf);
  const forageNDFGap = gap(forageNDFFloor, forageNDF);

  const ndfOK = Number.isFinite(ndf) && Number.isFinite(ndfLimit) && ndf >= ndfLimit;
  const ndfMarginal = Number.isFinite(ndfGap) && ndfGap > 0 && ndfGap <= 2;
  const ndfLow = Number.isFinite(ndfGap) && ndfGap > 2;
  const ndfSevereLow = Number.isFinite(ndfGap) && ndfGap > 4;

  const peNDFOK = Number.isFinite(pendf) && Number.isFinite(pendfFloor) && pendf >= pendfFloor;
  const peNDFMarginal = Number.isFinite(pendfGap) && pendfGap > 0 && pendfGap <= 2;
  const peNDFLow = Number.isFinite(pendfGap) && pendfGap > 2;
  const peNDFSevereLow = Number.isFinite(pendfGap) && pendfGap > 4;

  const forageNDFOK =
    Number.isFinite(forageNDF) &&
    Number.isFinite(forageNDFFloor) &&
    forageNDF >= forageNDFFloor;

  const forageNDFMarginal =
    Number.isFinite(forageNDFGap) &&
    forageNDFGap > 0 &&
    forageNDFGap <= 2;

  const forageNDFLow =
    Number.isFinite(forageNDFGap) &&
    forageNDFGap > 2;

  const forageNDFSevereLow =
    Number.isFinite(forageNDFGap) &&
    forageNDFGap > 4;

  const roughOK =
    Number.isFinite(rough) &&
    Number.isFinite(roughFloor) &&
    rough >= roughFloor;

  const roughLow =
    Number.isFinite(rough) &&
    Number.isFinite(roughFloor) &&
    rough < roughFloor;

  const concHigh =
    Number.isFinite(conc) &&
    conc >= 60;

  const concVeryHigh =
    Number.isFinite(conc) &&
    conc >= 70;

  const noEffectiveRoughage =
    Number.isFinite(rough) &&
    Number.isFinite(conc) &&
    (rough <= 0 || conc >= 100);

  const indicators = {
    starch: {
      label: 'النشا',
      actual: safePct(starch),
      target: safePct(starchLimit),
      status: starchHigh ? 'watch' : 'ok'
    },
    ndf: {
      label: 'NDF الكلي',
      actual: safePct(ndf),
      target: safePct(ndfLimit),
      status: ndfLow ? 'watch' : 'ok'
    },
    peNDF: {
      label: 'peNDF',
      actual: safePct(pendf),
      target: safePct(pendfFloor),
      status: peNDFLow ? 'watch' : 'ok',
      rule: 'minimum_only'
    },
    forageNDF: {
      label: 'Forage NDF',
      actual: safePct(forageNDF),
      target: safePct(forageNDFFloor),
      shareOfTotalNDF: safePct(forageNDFShare),
      status: forageNDFLow ? 'watch' : 'ok'
    },
    roughage: {
      label: 'الخشن',
      actual: safePct(rough),
      target: safePct(roughFloor),
      status: roughLow ? 'watch' : 'ok'
    },
    concentrate: {
      label: 'المركزات',
      actual: safePct(conc),
      target: 60,
      status: concHigh ? 'watch' : 'ok'
    }
  };

  let score = 100;

  if (starchHigh) score -= starchVeryHigh ? 18 : 10;
  if (ndfMarginal) score -= 5;
  if (ndfLow) score -= ndfSevereLow ? 20 : 12;
  if (peNDFMarginal) score -= 6;
  if (peNDFLow) score -= peNDFSevereLow ? 28 : 18;
  if (forageNDFMarginal) score -= 6;
  if (forageNDFLow) score -= forageNDFSevereLow ? 28 : 18;
  if (roughLow) score -= 16;
  if (concHigh) score -= concVeryHigh ? 25 : 14;
  if (noEffectiveRoughage) score = 20;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let status = 'good';
  let title = 'صحة الكرش آمنة';
  let reason = 'النشا والألياف الكلية وNDF الخشن والألياف المؤثرة في توازن مناسب.';
  let instruction = 'استمر على نفس جودة الخلط، وحافظ على طول تقطيع الخشن 3–5 سم، مع متابعة الروث والاجترار ودسم اللبن.';

  const strongFiberProtection =
    (ndfOK || ndfMarginal) &&
    (peNDFOK || peNDFMarginal) &&
    (forageNDFOK || forageNDFMarginal) &&
    roughOK &&
    !concHigh;

  if (noEffectiveRoughage) {
    status = 'danger';
    score = Math.min(score, 20);
    title = 'خطر اضطراب كرش مرتفع';
    reason = 'العليقة تعتمد على المركزات بدون خشن فعّال كافٍ، وهذا يضعف الاجترار واللعاب ويرفع خطر انخفاض pH الكرش.';
    instruction = 'أدخل مصدر خشن فعّال قبل اعتماد التركيبة، وتأكد أن الخشن مقطع 3–5 سم وأن الخلطة لا تُفرز.';
  } else if (
    starchHigh &&
    (
      peNDFLow ||
      forageNDFLow ||
      ndfLow ||
      roughLow ||
      concHigh
    )
  ) {
    status = 'danger';
    score = Math.min(score, 55);
    title = forageNDFLow
      ? 'خطر نقص حماية الخشن'
      : 'خطر حموضة واضح';

    reason = forageNDFLow
      ? 'النشا مرتفع وNDF القادم من الخشن أقل من المطلوب، لذلك حماية الكرش لا تكفي حتى لو NDF الكلي قريبًا من الهدف.'
      : 'النشا مرتفع ومعه حماية الكرش من الخشن أو الألياف الفعّالة غير كافية، وهذا يرفع خطر انخفاض pH وضعف الاجترار.';

    instruction = forageNDFLow
      ? 'زِد سيلاج/دريس/تبن فعّال بدل الاعتماد على NDF من المركزات أو النواتج، وراجع جودة الخشن والخلط.'
      : 'قلّل الحبوب/النشا السريع أو وزّعها على وجبات، وارفع Forage NDF من سيلاج/دريس/تبن فعّال بطول 3–5 سم.';
  } else if (
    concVeryHigh ||
    (peNDFLow && forageNDFLow) ||
    (peNDFLow && ndfLow) ||
    (forageNDFLow && roughLow)
  ) {
    status = 'danger';
    score = Math.min(score, 58);
    title = concVeryHigh ? 'المركزات مرتفعة على الكرش' : 'حماية الكرش ضعيفة';
    reason = concVeryHigh
      ? 'نسبة المركزات عالية جدًا، وهذا يزيد سرعة التخمر ويضعف استقرار بيئة الكرش إذا لم تقابلها ألياف فعّالة كافية.'
      : 'الألياف الفعّالة أو NDF القادم من الخشن غير كافيين لدعم الاجترار وإفراز اللعاب.';
    instruction = concVeryHigh
      ? 'قلّل المركزات تدريجيًا أو ارفع الخشن الفعّال، وتجنب أي تغيير مفاجئ في الحبوب.'
      : 'ارفع مصدر خشن فعّال، وراجع نسبة السيلاج/الدريس/التبن، وتأكد من طول التقطيع وعدم فرز الخلطة.';
  } else if (starchHigh && strongFiberProtection) {
    status = 'watch';
    score = Math.max(score, 68);
    title = 'النشا مرتفع مع حماية ألياف كافية';
    reason = 'النشا أعلى من الهدف، لكن الخشن وForage NDF وpeNDF كافية حاليًا لحماية الكرش.';
    instruction = 'لا تعدّل بقسوة. راقب الروث والاجترار ودسم اللبن. لو ظهرت علامات حموضة، خفّض النشا أو ارفع الخشن الفعّال.';
  } else if (starchHigh) {
    status = 'watch';
    score = Math.max(score, 62);
    title = 'النشا مرتفع ويحتاج متابعة';
    reason = 'النشا أعلى من الهدف، لكن مؤشرات الألياف لا تشير إلى خطر حموضة واضح.';
    instruction = 'راجع مصدر النشا، وراقب الروث والاجترار ودسم اللبن، وتأكد من طول تقطيع الخشن ومنع فرز الخلطة.';
  } else if (ndfMarginal) {
    status = 'watch';
    score = Math.max(score, 72);
    title = 'الألياف الكلية قريبة من الحد';
    reason = 'NDF قريب من الحد الأدنى، لكن باقي مؤشرات حماية الكرش لا تشير لخطر واضح.';
    instruction = 'حافظ على الخشن ولا ترفع الحبوب الآن. راقب الروث والاجترار، وارفع الخشن قليلًا لو ظهرت علامات اضطراب.';
  } else if (forageNDFMarginal) {
    status = 'watch';
    score = Math.max(score, 72);
    title = 'NDF الخشن قريب من الحد';
    reason = 'جزء الألياف القادم من الخشن قريب من الحد، وقد لا يكفي إذا زاد النشا أو ساء التقطيع.';
    instruction = 'راجع نسبة السيلاج/الدريس/التبن، وتأكد أن الخشن فعّال وغير ناعم جدًا.';
  } else if (peNDFMarginal) {
    status = 'watch';
    score = Math.max(score, 72);
    title = 'الألياف المؤثرة قريبة من الحد';
    reason = 'peNDF قريب من الحد الأدنى اللازم للمضغ والاجترار، لكنه ليس خطرًا واضحًا حاليًا.';
    instruction = 'حافظ على طول تقطيع الخشن 3–5 سم، وراقب الروث والاجترار خاصة بعد أي زيادة في الحبوب.';
  } else if (peNDFLow) {
    status = 'watch';
    title = 'الألياف المؤثرة أقل من المطلوب';
    reason = 'peNDF أقل من الحد الأدنى اللازم لدعم المضغ واللعاب وثبات pH الكرش.';
    instruction = 'حسّن طول تقطيع الخشن إلى 3–5 سم أو ارفع مصدر الألياف الفعّالة.';
  } else if (forageNDFLow) {
    status = 'watch';
    title = 'NDF الخشن أقل من المطلوب';
    reason = 'NDF القادم من الخشن أقل من الحد الداعم لصحة الكرش حتى لو بعض NDF يأتي من المركزات.';
    instruction = 'ارفع سيلاج/دريس/تبن فعّال، ولا تعتمد على NDF المركزات كبديل كامل لحماية الكرش.';
  } else if (ndfLow) {
    status = 'watch';
    title = 'الألياف الكلية منخفضة';
    reason = 'NDF الكلي أقل من المستوى المناسب لهذه المرحلة، وهذا يقلل هامش أمان الكرش.';
    instruction = 'راجع نسبة وجودة الخشن قبل زيادة مصادر الطاقة أو الحبوب.';
  } else if (roughLow) {
    status = 'watch';
    title = 'الخشن أقل من المطلوب';
    reason = 'نسبة الخشن أقل من الحد الأدنى الداعم للمضغ والاجترار.';
    instruction = 'ارفع مصدر الخشن أو حسّن فعالية الألياف قبل اعتماد العليقة.';
  } else if (concHigh) {
    status = 'watch';
    title = 'المركزات مرتفعة';
    reason = 'نسبة المركزات عالية وتحتاج متابعة حتى مع كفاية الألياف.';
    instruction = 'راقب الروث والاجترار ودسم اللبن، وتجنب التغيير المفاجئ في المركزات.';
  }

  return {
    model: 'MURABBIK_RUMEN_HEALTH_FORAGE_NDF_V1',
    status,
    score,
    title,
    reason,
    instruction,
    indicators,
    displayText: title,
    noteText: reason,
    adviceText: instruction,
    sourceBasis: [
      'RUMEN_HEALTH_ONLY',
      'STARCH_PLUS_FIBER_PROTECTION',
      'FORAGE_NDF_AS_CORE_PROTECTION',
      'PENDF_AS_PHYSICAL_EFFECTIVENESS',
      'NO_DMI_OR_ENERGY_JUDGMENT_INSIDE_RUMEN_CARD'
    ]
  };
}
function buildNutritionPanels(analysis = {}, context = {}) {
  const totals = analysis?.totals || {};
  const nutrition = analysis?.nutrition || {};
  const targets = analysis?.targets || {};
  const economics = analysis?.economics || {};

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

  const stateFromBalance = (actual, target, tolerancePct = 5) => {
    const a = Number(actual);
    const t = Number(target);
    if (!Number.isFinite(a) || !Number.isFinite(t) || t <= 0) return 'warn';

    const diffPct = ((a - t) / t) * 100;
    if (Math.abs(diffPct) <= tolerancePct) return 'good';
    if (diffPct < 0) return 'warn';
    return 'watch';
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

  const starchActual = num(nutrition.starchPctActual, 1);
  const starchMax = num(targets.starchMax, 1);

  const fatActual = num(nutrition.fatModel?.totalFatPct ?? nutrition.fatPctActual, 1);
  const fatMax = num(nutrition.fatModel?.totalFatCeilingPctDM ?? 7, 1);
  const fatModel = nutrition.fatModel || null;

  const rough = num(nutrition.roughPctDM, 0);
  const conc = num(nutrition.concPctDM, 0);

  const rumenModel = nutrition.rumenHealthModel || null;
  const rumenState =
    rumenModel?.status === 'danger'
      ? 'danger'
      : rumenModel?.status === 'watch'
        ? 'warn'
        : 'good';

  const dmState = stateFromBalance(dmActual, dmTarget, 5);
  const nelState = stateFromBalance(nelActual, nelTarget, 5);
  const mpState = stateFromBalance(mpActual, mpTarget, 5);

  const starchHigh =
    Number.isFinite(Number(starchActual)) &&
    Number.isFinite(Number(starchMax)) &&
    Number(starchActual) > Number(starchMax);

const fatHigh =
  Number.isFinite(Number(fatActual)) &&
  Number.isFinite(Number(fatMax)) &&
  Number(fatActual) > Number(fatMax);

const fatNeedsAttention =
  (fatModel?.status && fatModel.status !== 'good') ||
  fatHigh;

  const dmHint =
    dmState === 'good'
      ? 'المأكول قريب من الاحتياج. حافظ على انتظام التوزيع.'
      : Number(dmActual) < Number(dmTarget)
        ? 'المادة الجافة ناقصة. ارفع الكمية تدريجيًا وراجع المتبقي.'
        : 'المادة الجافة مرتفعة. تأكد أنها مأكولة وليست هدرًا.';

  const nelHint =
    nelState === 'good'
      ? 'الطاقة تغطي الاحتياج الحالي. راقب الإنتاج وBCS.'
      : Number(nelActual) < Number(nelTarget)
        ? 'الطاقة ناقصة. راجع المادة الجافة أولًا ثم كثافة الطاقة.'
        : 'الطاقة مرتفعة. راجع مصدر الطاقة قبل زيادة الحبوب.';

  const mpHint =
    mpState === 'good'
      ? 'MP يغطي الاحتياج. حافظ على جودة مصدر البروتين.'
      : Number(mpActual) < Number(mpTarget)
        ? 'MP ناقص. حسّن مصدر البروتين قبل رفع CP عشوائيًا.'
        : 'MP أعلى من الاحتياج. راجع التكلفة والهدر البروتيني.';

  const starchHint =
    starchHigh
      ? 'النشا مرتفع عن الحد الآمن. راجع كارت صحة الكرش قبل تعديل الحبوب.'
      : 'النشا داخل الحد. حافظ على توازن الحبوب والخشن.';

  const fatHint =
  fatModel?.uiText ||
  (
    fatHigh
      ? 'الدهن الكلي مرتفع. راجع نوع مصدر الدهون قبل اعتماد العليقة.'
      : 'الدهون داخل الحد. لا ترفعها إلا لهدف طاقة واضح.'
  );

  const economyHint =
    Number.isFinite(Number(economics.milkMargin))
      ? (
          Number(economics.milkMargin) >= 0
            ? 'الهامش موجب. راجع أغلى خامتين قبل أي تعديل.'
            : 'الهامش ضعيف. راجع السعر والإنتاج وأغلى الخامات.'
        )
      : (
          Number.isFinite(Number(economics.costPerKgMilk))
            ? 'راجع تكلفة كجم اللبن مع الإنتاج وسعر اللبن.'
            : 'أدخل سعر اللبن والخامات لقرار اقتصادي أدق.'
        );

  const priorityText = (() => {
    if (rumenModel?.status === 'danger') {
      return 'الأولوية: أصلح صحة الكرش قبل رفع الطاقة أو الحبوب.';
    }

    if (dmState !== 'good' && Number(dmActual) < Number(dmTarget)) {
      return 'الأولوية: ارفع المادة الجافة تدريجيًا قبل تغيير التركيبة.';
    }

    if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      return 'الأولوية: حسّن MP قبل رفع البروتين الخام عشوائيًا.';
    }

    if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      return 'الأولوية: حسّن الطاقة بدون كسر أمان الكرش.';
    }

if (fatNeedsAttention) {
  return 'الأولوية: راجع الدهون الحرة/المحمية قبل اعتماد العليقة.';
}

    if (starchHigh) {
      return 'الأولوية: راجع صحة الكرش قبل تعديل الحبوب.';
    }

    return 'الأولوية: العليقة مقبولة؛ تابع الإنتاج والروث والمتبقي.';
  })();

  const decisionText = (() => {
    if (rumenModel?.status === 'danger') {
      return 'العليقة تحتاج ضبط صحة الكرش أولًا.';
    }

    if (dmState !== 'good' && Number(dmActual) < Number(dmTarget)) {
      return 'العليقة آمنة للكرش لكنها لا تغطي المادة الجافة.';
    }

    if (mpState !== 'good' && Number(mpActual) < Number(mpTarget)) {
      return 'العليقة تحتاج تحسين البروتين الممثل MP.';
    }

    if (nelState !== 'good' && Number(nelActual) < Number(nelTarget)) {
      return 'العليقة تحتاج دعم طاقة محسوب.';
    }

if (fatNeedsAttention || starchHigh) {
  return 'العليقة تحتاج مراقبة النشا/الدهون مع صحة الكرش.';
}

    return 'العليقة متوازنة تشغيليًا حسب المدخلات الحالية.';
  })();

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
              dmState !== 'good' ||
              nelState !== 'good' ||
              mpState !== 'good' ||
              starchHigh ||
              fatNeedsAttention
            )
              ? 'warn'
              : 'good'
    },

    {
      key: 'dm',
      title: 'المادة الجافة',
      value: txt(dmActual, 'كجم', 2),
      actual: dmActual,
      target: dmTarget,
      targetText: `${txt(dmActual, 'كجم', 2)} / ${txt(dmTarget, 'كجم', 2)} — ${dmHint}`,
      status: uiStatus(dmState)
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
      title: 'MP / CP',
      value: `${txt(mpActual, 'جم', 0)} / CP ${pctTxt(cpActual, 1)}`,
      actual: mpActual,
      target: mpTarget,
      targetText: `${txt(mpActual, 'جم', 0)} / ${txt(mpTarget, 'جم', 0)} — ${mpHint}`,
      status: uiStatus(mpState)
    },

    {
      key: 'starch',
      title: 'النشا',
      value: pctTxt(starchActual, 1),
      actual: starchActual,
      target: starchMax,
      targetText: `${pctTxt(starchActual, 1)} / ${pctTxt(starchMax, 1)} — ${starchHint}`,
      status: starchHigh ? 'warn' : 'good'
    },

    {
      key: 'fat',
      title: 'الدهون',
      value: pctTxt(fatActual, 1),
      actual: fatActual,
      target: fatMax,
      targetText: `${pctTxt(fatActual, 1)} / ${pctTxt(fatMax, 1)} — ${fatHint}`,
      status:
  fatModel?.status === 'danger'
    ? 'danger'
    : (fatNeedsAttention ? 'warn' : 'good')
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
              dmState !== 'good' ||
              nelState !== 'good' ||
              mpState !== 'good' ||
              starchHigh ||
              fatNeedsAttention
            )
              ? 'warn'
              : 'good'
    }
  ];

  const economicsCards = [
    {
      key: 'totCost',
      title: 'التكلفة/رأس',
      value: Number.isFinite(Number(totals.totCost))
        ? `${num(totals.totCost, 2)} ج`
        : '—',
      targetText: economyHint
    },
    {
      key: 'costPerKgMilk',
      title: 'تكلفة كجم لبن',
      value: Number.isFinite(Number(economics.costPerKgMilk))
        ? `${num(economics.costPerKgMilk, 2)} ج/كجم`
        : '—',
      targetText: economyHint
    },
    {
      key: 'dmPerKgMilk',
      title: 'كفاءة تحويل العلف',
      value: Number.isFinite(Number(economics.dmPerKgMilk)) && Number(economics.dmPerKgMilk) > 0
        ? `1 كجم مادة جافة → ${num(1 / Number(economics.dmPerKgMilk), 2)} كجم لبن`
        : '—',
      targetText: 'راقب الكفاءة مع اللبن والمادة الجافة.'
    },
    {
      key: 'mixPriceAsFed',
      title: 'سعر طن العليقة',
      value: Number.isFinite(Number(totals.mixPriceAsFed))
        ? `${num(totals.mixPriceAsFed, 2)} ج/طن as-fed`
        : '—',
      targetText: 'راجع أغلى خامتين قبل تغيير التركيبة.'
    },
    {
      key: 'milkMargin',
      title: 'هامش لبن-علف',
      value: Number.isFinite(Number(economics.milkMargin))
        ? `${num(economics.milkMargin, 2)} ج`
        : '—',
      targetText: economyHint
    }
  ];

  const advancedCards = [
    {
      key: 'dmiTarget',
      title: 'احتياجات المادة الجافة',
      value: txt(targets.dmiTarget, 'كجم', 2)
    },
    {
      key: 'totDM',
      title: 'العليقة الحالية — مادة جافة',
      value: txt(totals.dmKg, 'كجم', 2)
    },

    {
      key: 'cpTarget',
      title: 'احتياجات البروتين الخام',
      value: txt(targets.cpTarget, '%', 1)
    },
    {
      key: 'cpPctTotal',
      title: 'العليقة الحالية — بروتين خام',
      value: txt(nutrition.cpPctTotal, '%', 1)
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

    return res.json({
      ok: true,
      targets: cleanObj({
        ...built.targetsCore,
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

if (missingPriceRows.length) {
  return res.status(400).json({
    ok: false,
    error: 'feed_price_required',
    message: 'سعر كل خامة داخل التركيبة إجباري لحساب التحليل الاقتصادي بدقة',
    missingRows: missingPriceRows.map(r => r.name).slice(0, 10)
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
//                  API: NUTRITION SAVE (CENTRAL)
// ============================================================
app.post('/api/nutrition/save', requireUserId, async (req, res) => {
  try {
    const tenant = req.userId;
    const body = req.body || {};

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
    ok:false,
    error:'feed_price_required',
    message:'سعر كل خامة داخل التركيبة إجباري قبل حفظ حدث التغذية',
    missingRows: missingPriceRows.map(r => r.name || r.nameAr || r.feedName || r.id).slice(0, 10)
  });
}


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

const centralAnalysis = buildNutritionCentralAnalysis({
  rows,
  context,
  mode,
  concKg,
  milkPrice
});
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
    analysis: centralAnalysis
  }
});

    const localEvents = readJson(eventsPath, []);
    localEvents.push({ id: localEvents.length + 1, ...doc });
    fs.writeFileSync(eventsPath, JSON.stringify(localEvents, null, 2));

    let firestoreId = null;

    if (db) {
      const fireDoc = {
        ...doc,
        createdAt: admin.firestore.Timestamp.fromMillis(nowMs)
      };

      const ref = await db.collection('events').add(fireDoc);
      firestoreId = ref.id;
    }

    return res.json({
      ok: true,
      saved: true,
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

const animalsAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));

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

const total = active.length;

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
      low: emptyFeedBand()
    };

    try {
      const evSnapNut = await db.collection("events")
        .where("userId", "==", uid)
        .limit(5000)
        .get();

      const evNutAll = evSnapNut.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

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
    e._matchesType
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
        feedBands.high = buildFeedBandFromEvent(latestByBand.get('high'));
      }
      if (latestByBand.has('medium')) {
        feedBands.medium = buildFeedBandFromEvent(latestByBand.get('medium'));
      }
      if (latestByBand.has('low')) {
        feedBands.low = buildFeedBandFromEvent(latestByBand.get('low'));
      }

if (latestByBand.has('overall')) {
  feedBands.overall = buildFeedBandFromEvent(latestByBand.get('overall'));
} else {
  feedBands.overall = weightedFeedBands([
    feedBands.high,
    feedBands.medium,
    feedBands.low
  ]);
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

    const desiredIds = new Set();

    for (const m of members) {
      const groupId = String(m?.groupId || '').trim();
      const animalNumber = String(m?.animalNumber || '').trim();
      if (!groupId || !animalNumber) continue;

      const memberId = `${tenant}_${groupId}_${animalNumber}`;
      desiredIds.add(memberId);

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

  await syncAnimalGroupFieldsSrv(tenant, groups);

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
