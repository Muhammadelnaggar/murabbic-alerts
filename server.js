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
  rumenStatus: a?.nutrition?.rumenStatus || null,
  rumenNote: a?.nutrition?.rumenNote || null
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
      peNDFMin: toNumOrNull(a?.targets?.peNDFMin)
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
ndfPct: toNumOrNull(r?.ndfPct ?? r?.ndf),
fatPct: toNumOrNull(r?.fatPct ?? r?.fat),
starchPct: toNumOrNull(r?.starchPct ?? r?.starch),
mpGPerKgDM: toNumOrNull(r?.mpGPerKgDM ?? r?.mp)
  }));
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

function getThiDmiFactor(thi) {
  const n = Number(thi);
  if (!Number.isFinite(n)) return 1;
  if (n >= 79) return 0.90;
  if (n >= 73) return 0.94;
  if (n >= 68) return 0.97;
  return 1;
}

function getGrowthFactor(lactationNumber) {
  const n = Number(lactationNumber);
  if (!Number.isFinite(n)) return 1;
  if (n === 1) return 1.10;
  if (n === 2) return 1.05;
  return 1;
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
function getBcsNelFactor(bcs) {
  const n = Number(bcs);
  if (!Number.isFinite(n)) return 1;
  if (n < 2.75) return 1.03;
  if (n > 3.75) return 0.98;
  return 1;
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
  thi: runtimeCtx.thiUsed,
  bcs: runtimeCtx.bcsUsed
});

  targetsCore = applyBuffaloNutritionRules(targetsCore, context);

  const refBw = Number(runtimeCtx.breedDefaults?.bodyWeightKg || runtimeCtx.bodyWeightKgUsed || 0);
  const actualBw = Number(runtimeCtx.bodyWeightKgUsed || refBw || 0);

  const bwFactor = (refBw > 0 && actualBw > 0)
    ? Math.pow(actualBw / refBw, 0.75)
    : 1;

  const milkEnergyRef =
    (0.0929 * 3.7) +
    (0.0547 * 3.2) +
    (0.0395 * 4.8);

  const milkEnergyActual =
    (0.0929 * Number(runtimeCtx.milkFatPctUsed || 3.7)) +
    (0.0547 * Number(runtimeCtx.milkProteinPctUsed || 3.2)) +
    (0.0395 * 4.8);

  const milkEnergyFactorBase = milkEnergyRef > 0 ? (milkEnergyActual / milkEnergyRef) : 1;
  const buffaloMilkEnergyFactor = getBuffaloMilkEnergyFactor(context.species, context.breed);
  const buffaloDmiFactor = getBuffaloDmiFactor(context.species, context.breed);

  const thiDmiFactor = getThiDmiFactor(runtimeCtx.thiUsed);
  const growthFactor = getGrowthFactor(runtimeCtx.lactationNumberUsed);
  const bcsNelFactor = getBcsNelFactor(runtimeCtx.bcsUsed);
  const proteinFactor = Number(runtimeCtx.milkProteinPctUsed || 3.2) / 3.2;

  if (Number.isFinite(Number(targetsCore?.dmi))) {
    targetsCore.dmi = round2(
      Number(targetsCore.dmi) *
      bwFactor *
      thiDmiFactor *
      buffaloDmiFactor
    );
  }

  if (Number.isFinite(Number(targetsCore?.nel))) {
    targetsCore.nel = round2(
      Number(targetsCore.nel) *
      bwFactor *
      milkEnergyFactorBase *
      buffaloMilkEnergyFactor *
      growthFactor *
      bcsNelFactor
    );
  }

  if (Number.isFinite(Number(targetsCore?.cpTarget))) {
    const cpAfterProtein = Number(targetsCore.cpTarget) * proteinFactor;
    targetsCore.cpTarget = round2(
      isBuffaloSpecies(context.species)
        ? cpAfterProtein
        : cpAfterProtein * growthFactor
    );
  }
if (!Number.isFinite(Number(targetsCore?.cpTarget))) {
  const cpRef = Number(targetsCore?.cpReferencePct);
  if (Number.isFinite(cpRef)) {
    targetsCore.cpTarget = round2(cpRef);
  }
}
  return {
    targetsCore,
    runtimeCtx,
    buffaloMilkEnergyFactor: isBuffaloSpecies(context.species) ? buffaloMilkEnergyFactor : 1,
    buffaloDmiFactor: isBuffaloSpecies(context.species) ? buffaloDmiFactor : 1
  };
}
function deriveFiberStarchTargets({
  species,
  roughPctDM,
  baseNdfTarget,
  baseStarchMax,
  baseRoughageMin,
   basePeNDFMin
}) {
  const isBuffalo = isBuffaloSpecies(species);

  const rough = Number(roughPctDM || 0);
  let ndfTarget = Number(baseNdfTarget || (isBuffalo ? 34 : 30));
  let starchMax = Number(baseStarchMax || (isBuffalo ? 22 : 28));
  let roughageMin = Number(baseRoughageMin || (isBuffalo ? 50 : 40));
  let peNDFMin = Number(basePeNDFMin || (isBuffalo ? 21 : 18));
  // جاموس
  if (isBuffalo) {
    if (rough < 45) {
      ndfTarget = 36;
      starchMax = 20;
      roughageMin = 50;
      peNDFMin = 23;
    } else if (rough < 50) {
      ndfTarget = 35;
      starchMax = 21;
      roughageMin = 50;
      peNDFMin = 22;
    } else if (rough <= 65) {
      ndfTarget = 34;
      starchMax = 22;
      roughageMin = 50;
      peNDFMin = 21;
    } else {
      ndfTarget = 33;
      starchMax = 20;
      roughageMin = 55;
    }
  } else {
    // أبقار
    if (rough < 35) {
      ndfTarget = 32;
      starchMax = 24;
      roughageMin = 40;
      peNDFMin = 20;
    } else if (rough < 40) {
      ndfTarget = 31;
      starchMax = 26;
      roughageMin = 40;
      peNDFMin = 19;
    } else if (rough <= 60) {
      ndfTarget = 30;
      starchMax = 28;
      roughageMin = 40;
      peNDFMin = 18;
    } else {
      ndfTarget = 31;
      starchMax = 24;
      roughageMin = 50;
      peNDFMin = 19;
    }
  }

  return {
    ndfTarget,
    starchMax,
    roughageMin,
     peNDFMin
  };
}
function buildNutritionCentralAnalysis({ rows = [], context = {}, mode = 'tmr_asfed', concKg = null, milkPrice = null }) {
  const cleanRows = Array.isArray(rows) ? rows : [];
const modeNorm = String(mode || 'tmr_asfed').trim();

const builtTargets = buildNutritionCentralTargets(context);
const runtimeCtx = builtTargets.runtimeCtx;
const targetsCore = builtTargets.targetsCore;
const buffaloMilkEnergyFactor = builtTargets.buffaloMilkEnergyFactor;
const buffaloDmiFactor = builtTargets.buffaloDmiFactor;

const rationCore = analyzeRation(
  cleanRows.map(r => ({
    kg: r.asFedKg,
    dm: r.dmPct,
    cp: r.cpPct,
    mp: r.mpGPerKgDM,
    nel: r.nelMcalPerKgDM,
    ndf: r.ndfPct,
    fat: r.fatPct,
    starch: r.starchPct,
    cat: r.cat,
    pricePerTonAsFed: r.pricePerTon
  })),
 {
  dmi: targetsCore?.dmi,
  nel: targetsCore?.nel,
  mpTargetG: targetsCore?.mpTargetG,
  ndfTarget: targetsCore?.ndfTarget,
  starchMax: targetsCore?.starchMax,
  roughageMin: targetsCore?.roughageMin,
  peNDFMin: targetsCore?.peNDFMin
},
  {
    avgMilkKg: context?.avgMilkKg,
    milkFatPct: runtimeCtx?.milkFatPctUsed,
    milkProteinPct: runtimeCtx?.milkProteinPctUsed,
    milkPrice: milkPrice
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

// ===== صحة الكرش: نسبة خشن/مركز على أساس DM =====
let forageDm = 0;
let concDm = 0;

for (const r of cleanRows) {
  const kg = Number(r.asFedKg || 0);
  const dmPct = Number(r.dmPct || 0);
  const dmKg = kg * (dmPct / 100);
  const cat = String(r.cat || '').trim();

  if (cat === 'rough') forageDm += dmKg;
  if (cat === 'conc') concDm += dmKg;
}

forageDm = round2(forageDm) || 0;
concDm = round2(concDm) || 0;

const totalDmForRumen = forageDm + concDm;

const roughPctDM = totalDmForRumen > 0 ? round2((forageDm / totalDmForRumen) * 100) : 0;
const concPctDM  = totalDmForRumen > 0 ? round2((concDm / totalDmForRumen) * 100) : 0;

let rumenStatus = null;
let rumenNote = null;
const dynamicFiberTargets = deriveFiberStarchTargets({
  species: context?.species,
  roughPctDM,
  baseNdfTarget: targetsCore?.ndfTarget,
  baseStarchMax: targetsCore?.starchMax,
  baseRoughageMin: targetsCore?.roughageMin,
   basePeNDFMin: targetsCore?.peNDFMin
});

targetsCore.ndfTarget = dynamicFiberTargets.ndfTarget;
targetsCore.starchMax = dynamicFiberTargets.starchMax;
targetsCore.roughageMin = dynamicFiberTargets.roughageMin;
targetsCore.peNDFMin = dynamicFiberTargets.peNDFMin; 
if (totalDmForRumen <= 0) {
  rumenStatus = 'warn';
  rumenNote = 'لا توجد بيانات كافية لتقييم صحة الكرش';
} else {
  const starchActual = Number(rationCore?.nutrition?.starchPct || 0);
  const ndfActual = Number(rationCore?.nutrition?.ndfPctActual || 0);
   const peNDFActual = Number(rationCore?.nutrition?.peNDFPctActual || 0);
  if (roughPctDM === 0 || concPctDM === 100) {
    rumenStatus = 'danger';
    rumenNote = 'العليقة 100% مركزات وخطر الحموضة وقلة دسم الحليب مرتفع';
  } else if (roughPctDM < Number(targetsCore?.roughageMin || 0)) {
    rumenStatus = 'danger';
    rumenNote = 'الخشن أقل من الحد الأدنى المناسب لهذه العليقة';
} else if (
  starchActual > Number(targetsCore?.starchMax || 0) &&
  peNDFActual < Number(targetsCore?.peNDFMin || 0)
) {
  rumenStatus = 'danger';
  rumenNote = 'النشا مرتفع والألياف المؤثرة ميكانيكيًا غير كافية لصحة الكرش';
} else if (starchActual > Number(targetsCore?.starchMax || 0)) {
  rumenStatus = 'danger';
  rumenNote = 'النشا أعلى من الحد الآمن مقارنة بنسبة الخشن الحالية';
} else if (peNDFActual < Number(targetsCore?.peNDFMin || 0)) {
  rumenStatus = 'warn';
  rumenNote = 'الألياف المؤثرة ميكانيكيًا أقل من المطلوب لصحة الكرش';
} else if (ndfActual < Number(targetsCore?.ndfTarget || 0)) {
  rumenStatus = 'warn';
  rumenNote = 'الألياف أقل من المطلوب بالنسبة لتكوين العليقة الحالي';
  } else if (roughPctDM > (Number(targetsCore?.roughageMin || 0) + 20)) {
    rumenStatus = 'warn';
    rumenNote = 'الخشن مرتفع وقد يحد من المأكول والطاقة';
  } else {
    rumenStatus = 'good';
    rumenNote = 'توازن الخشن والنشا والألياف مناسب لصحة الكرش';
  }
}
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
  fatPctActual: rationCore?.nutrition?.fatPctActual ?? null,
  starchPctActual: rationCore?.nutrition?.starchPct ?? null,
  roughPctDM,
  concPctDM,
  rumenStatus,
  rumenNote,
 rumenAdvice: "تم احتساب الألياف المؤثرة وصحة الكرش على افتراض أن طول تقطيع الخشن 3–5 سم. إذا كان التقطيع أقصر أو أطول من ذلك قد تختلف دقة التقييم."
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
peNDFMin: targetsCore?.peNDFMin ?? null
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
      buffaloMilkEnergyFactor: isBuffaloSpecies(context.species) ? buffaloMilkEnergyFactor : 1,
      buffaloDmiFactor: isBuffaloSpecies(context.species) ? buffaloDmiFactor : 1
    }
  });
}
function pctOrNull(v){
  return Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null;
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

  const rough = num(nutrition.roughPctDM, 0);
  const conc = num(nutrition.concPctDM, 0);

  const analysisCards = [
    {
      key: 'dm',
      title: 'المادة الجافة',
      value: txt(totals.dmKg, 'كجم', 2),
      actual: num(totals.dmKg, 2),
      target: num(targets.dmiTarget, 2),
      targetText: txt(targets.dmiTarget, 'كجم', 2)
    },
    {
      key: 'asFed',
      title: 'المأكول الكلي',
      value: txt(totals.asFedKg, 'كجم', 2),
      actual: num(totals.asFedKg, 2),
      target: null,
      targetText: '—'
    },
    {
      key: 'cp',
      title: 'البروتين الخام',
      value: txt(nutrition.cpPctTotal, '%', 1),
      actual: num(nutrition.cpPctTotal, 1),
      target: num(targets.cpTarget, 1),
      targetText: txt(targets.cpTarget, '%', 1)
    },
{
  key: 'rumen',
  title: 'صحة الكرش',
  value:
    Number.isFinite(rough) && Number.isFinite(conc)
      ? `خشن ${rough}% / مركز ${conc}%`
      : '—',
  actual: null,
  target: null,
  targetText: nutrition.rumenNote || '—',
  status: nutrition.rumenStatus || null
}
  ];

  const economicsCards = [
    {
      key: 'totCost',
      title: 'التكلفة/رأس',
      value: Number.isFinite(Number(totals.totCost))
        ? `${num(totals.totCost, 2)} ج`
        : '—'
    },
    {
      key: 'costPerKgMilk',
      title: 'تكلفة كجم لبن',
      value: Number.isFinite(Number(economics.costPerKgMilk))
        ? `${num(economics.costPerKgMilk, 2)} ج/كجم`
        : '—'
    },
    {
  key: 'dmPerKgMilk',
  title: 'كفاءة تحويل العلف',
  value: Number.isFinite(Number(economics.dmPerKgMilk)) && Number(economics.dmPerKgMilk) > 0
    ? `1 كجم مادة جافة → ${num(1 / Number(economics.dmPerKgMilk), 2)} كجم لبن`
    : '—'
},
    {
      key: 'mixPriceAsFed',
      title: 'سعر طن العليقة',
      value: Number.isFinite(Number(totals.mixPriceAsFed))
        ? `${num(totals.mixPriceAsFed, 2)} ج/طن as-fed`
        : '—'
    },
    {
      key: 'milkMargin',
      title: 'هامش لبن-علف',
      value: Number.isFinite(Number(economics.milkMargin))
        ? `${num(economics.milkMargin, 2)} ج`
        : '—'
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
          buffaloMilkEnergyFactor: built.buffaloMilkEnergyFactor,
          buffaloDmiFactor: built.buffaloDmiFactor
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

const analysis = buildNutritionCentralAnalysis({
  rows: normalizeNutritionRows(rows),
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
const rows = normalizeNutritionRows(rawRows);
const context = normalizeNutritionContext(nutrition.context || {});

console.log('NUTRITION SAVE rawRows.length =', rawRows.length);
console.log('NUTRITION SAVE rawRows[0] =', rawRows[0] || null);
console.log('NUTRITION SAVE normalizedRows.length =', rows.length);
console.log('NUTRITION SAVE normalizedRows[0] =', rows[0] || null);
console.log('NUTRITION SAVE normalizedContext =', context);

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
const milkPrice = toNumOrNull(nutrition.milkPrice);

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
    lamenessCount = 0;

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

const latestKey = latestMilkDay
  ? latestMilkDay.toISOString().slice(0,10)
  : null;

const latestRec = latestKey ? dayMap.get(latestKey) : null;

avgHeadToday = (latestRec && latestRec.heads.size)
  ? +(latestRec.totalMilk / latestRec.heads.size).toFixed(1)
  : 0;

if (latestMilkDay) {
  const prevDay = new Date(latestMilkDay);
  prevDay.setDate(prevDay.getDate() - 1);
  const prevKey = prevDay.toISOString().slice(0,10);
  const prevRec = dayMap.get(prevKey);

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
}
}
} catch (e) {
  console.error("milk stats error:", e.message || e);
}
    // --------------------------------------
    // 🔥 5) خصوبة 21 يوم من الأحداث (FERTILITY EVENTS)
    // --------------------------------------
    let extraFertility = { scPlus:0, hdr21:0, cr21:0, pr21:0 };

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

      extraFertility = { scPlus, hdr21, cr21, pr21 };

    } catch(e){
      console.error("FERTILITY EVENT ERROR", e);
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
    pr21: extraFertility.pr21
  },

  // ===== الحقول التي ينتظرها الداشبورد مباشرة =====
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
  abortionRatePct: abortPct,

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

  // ===== التغذية: مؤقتًا صفر صريح =====
  feedCostPerLiter: 0,
  feedEfficiency: 0,
  feedCostPerHeadPerDay: 0,
  iofc: 0,

  dailyMilkTotal,
  avgHeadToday,
  avgHead7Days,
  monthlyMilkTotal,
  dailyMilkDeltaPct,
  avgHeadDeltaPct,
  bcsCamera,
  fecesScore
});
  } catch (e) {
    console.error("HERD-STATS ERROR:", e);
    return res.json({ ok:false, error:e.message });
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

    return res.json({
      ok: true,
      savedGroups: groups.length,
      savedMembers: members.length
    });
  } catch (e) {
    console.error('groups.sync', e);
    return res.status(500).json({ ok:false, error:'groups_sync_failed' });
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
