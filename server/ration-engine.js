function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, d = 2){
  const p = 10 ** d;
  return Math.round((Number(v) || 0) * p) / p;
}

function clamp(x, a, b){
  x = Number(x);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function safeDiv(a, b){
  a = Number(a); b = Number(b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}
// SOURCE: NASEM_2021_EQ_2_2
// Diet/ration effect DMI equation for lactating cows.
// Applies only when ration forage-NDF, ADF/NDF, fNDFD, and milk yield are available.
function predictCowLactatingDMIRationEffect({ fNDFPct, adfPct, ndfPct, fNDFDPct, milkKg }){
  const fNDF = num(fNDFPct);
  const ADF_NDF = safeDiv(num(adfPct), num(ndfPct));
  const rawFNDFD = Number(fNDFDPct);
  const fNDFD = Number.isFinite(rawFNDFD) && rawFNDFD > 0 ? rawFNDFD : 52.0;
  const MY = num(milkKg);

  if (!fNDF || !ADF_NDF || !MY) return null;

  const dmi =
    12.0
    - (0.107 * fNDF)
    + (8.17 * ADF_NDF)
    + (0.0253 * fNDFD)
    - (0.328 * (ADF_NDF - 0.602) * (fNDFD - 48.3))
    + (0.225 * MY)
    + (0.00390 * (fNDFD - 48.3) * (MY - 33.1));

  return {
    model: 'NASEM_2021_EQ_2_2',
    dmi: round(dmi),
    inputs: {
      fNDFPct: round(fNDF),
      adfNdfRatio: round(ADF_NDF, 3),
      fNDFDPct: round(fNDFD),
      milkKg: round(MY)
    },
    usedFNDFDFallback: !(Number.isFinite(rawFNDFD) && rawFNDFD > 0)
  };
}
function inferPef(row = {}){
  const explicit = Number(row.pef);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const cat = String(row.cat || '').trim().toLowerCase();
  const name = String(row.name || row.feedName || '').trim().toLowerCase();

  // المركزات والإضافات لا تُحسب كألياف مؤثرة
  if (cat === 'conc' || cat === 'add') return 0;

  // افتراض مُرَبِّيك القياسي:
  // تم احتساب peNDF على أساس أن طول تقطيع الخشن 3–5 سم
  if (/تبن|قش|straw/.test(name)) return 1.00;
  if (/hay|دريس/.test(name)) return 0.95;
  if (/سيلاج|silage/.test(name)) return 0.85;
  if (/برسيم|green|fresh/.test(name)) return 0.80;
  if (/pulp|لب بنجر|بنجر/.test(name)) return 0.45;

  // أي خشن غير محدد النوع → افتراض خشن مقطع 3–5 سم
  if (cat === 'rough') return 0.85;

  return 0;
}
function estimateRumenState({
  starchPct,
  ndfPctActual,
  roughPctDM,
  peNDFPctActual,
  starchMax,
  ndfTarget,
  roughageMin,
  peNDFMin
}){
  const starch = num(starchPct);
  const ndf = num(ndfPctActual);
  const rough = num(roughPctDM);
  const peNDF = num(peNDFPctActual);

  const starchCeiling = num(starchMax) || 28;
  const ndfFloor = num(ndfTarget) || 30;
  const roughFloor = num(roughageMin) || 40;
  const peNDFFloor = num(peNDFMin) || 18;

  let status = 'good';
  let note = 'توازن الكرش جيد';

  if (
    rough < roughFloor - 3 ||
    starch > starchCeiling ||
    peNDF < peNDFFloor - 2
  ){
    status = 'danger';
    note = 'خطر على توازن الكرش: الخشن أو الألياف المؤثرة غير كافيين أو النشا مرتفع';
  } else if (
    rough < roughFloor ||
    ndf < ndfFloor ||
    peNDF < peNDFFloor
  ){
    status = 'warn';
    note = 'توازن الكرش قريب من الحد ويحتاج مراجعة الخشن والألياف المؤثرة';
  }

  return {
    status,
    note
  };
}
function calcFpcmKg(milkKg, milkFatPct){
  const milk = num(milkKg);
  const fat = num(milkFatPct);
  if (!milk) return 0;
  return milk * (0.337 + 0.116 * fat);
}

function calcEcmKg(milkKg, milkFatPct, milkProteinPct){
  const milk = num(milkKg);
  const fat = num(milkFatPct);
  const protein = num(milkProteinPct);
  if (!milk) return 0;
  return milk * ((0.383 * fat) + (0.242 * protein) + 0.7832) / 3.1138;
}

function analyzeRation(rows, targets = {}, context = {}){
  const list = Array.isArray(rows) ? rows : [];

  let asFedKg = 0;
  let dmKg = 0;
  let cpKg = 0;
  let mpSupplyG = 0;
  let nelMcal = 0;
 let ndfKg = 0;
let adfKg = 0;
let peNdfKg = 0;
let fatKg = 0;
let starchKg = 0;

let forageNdfKg = 0;
let forageNdfdWeightedSum = 0;
let forageNdfdWeightKg = 0;

  let forageDmKg = 0;
  let concDmKg = 0;

  let totalCost = 0;
  let missingMpRows = 0;
  let missingNelRows = 0;
  let missingNdfRows = 0;
  let missingStarchRows = 0;
  for (const r of list){
    const kg = num(r.kg ?? r.asFedKg);
    const dm = num(r.dm ?? r.dmPct);
    const cp = num(r.cp ?? r.cpPct);
    const mp = num(r.mp ?? r.mpGPerKgDM);
    const nel = num(r.nel ?? r.nelMcalPerKgDM);
const ndf = num(r.ndf ?? r.ndfPct);
const adf = num(r.adf ?? r.adfPct);
const fat = num(r.fat ?? r.fatPct);
const starch = num(r.starchPct ?? r.starch);
const fNDFD = Number(r.fNDFD ?? r.forageNdfDigestibilityPct ?? r.ndfd ?? r.ndfDigestibilityPct);
    const cat = String(r.cat || '').trim();
    const pef = inferPef(r);
   
    if (!Number.isFinite(Number(r.nel ?? r.nelMcalPerKgDM))) missingNelRows++;
    if (!Number.isFinite(Number(r.ndf ?? r.ndfPct))) missingNdfRows++;
    if (!Number.isFinite(Number(r.starchPct ?? r.starch))) missingStarchRows++;
    const priceKg =
      num(r.priceKg) ||
      (
        num(r.price ?? r.pTon ?? r.pricePerTonAsFed)
          ? (num(r.price ?? r.pTon ?? r.pricePerTonAsFed) / 1000)
          : 0
      );

    const dmItemKg = kg * (dm / 100);

    asFedKg += kg;
    dmKg += dmItemKg;
    cpKg += dmItemKg * (cp / 100);
    if (mp > 0) {
  mpSupplyG += dmItemKg * mp;
} else {
  missingMpRows++;
}
    nelMcal += dmItemKg * nel;
    ndfKg += dmItemKg * (ndf / 100);
adfKg += dmItemKg * (adf / 100);
peNdfKg += dmItemKg * (ndf / 100) * pef;
fatKg += dmItemKg * (fat / 100);
    starchKg += dmItemKg * (starch / 100);
    totalCost += kg * priceKg;

    if (cat === 'rough') {
  forageDmKg += dmItemKg;

  const forageNdfItemKg = dmItemKg * (ndf / 100);
  forageNdfKg += forageNdfItemKg;

  if (Number.isFinite(fNDFD) && fNDFD > 0 && forageNdfItemKg > 0) {
    forageNdfdWeightedSum += forageNdfItemKg * fNDFD;
    forageNdfdWeightKg += forageNdfItemKg;
  }
}

if (cat === 'conc' || cat === 'add') concDmKg += dmItemKg;
  }

  const cpPctTotal = dmKg > 0 ? (cpKg / dmKg) * 100 : 0;
  const mpDensityGkgDM = dmKg > 0 ? (mpSupplyG / dmKg) : 0;
  const nelTotalMcalDay = nelMcal;
  const nelDensityMcalKgDM = dmKg > 0 ? (nelMcal / dmKg) : 0;
  const ndfPctActual = dmKg > 0 ? (ndfKg / dmKg) * 100 : 0;
const adfPctActual = dmKg > 0 ? (adfKg / dmKg) * 100 : 0;
const forageNdfPctDiet = dmKg > 0 ? (forageNdfKg / dmKg) * 100 : 0;
const weightedForageNdfDigestibilityPct =
  forageNdfdWeightKg > 0 ? (forageNdfdWeightedSum / forageNdfdWeightKg) : null;

const peNDFPctActual = dmKg > 0 ? (peNdfKg / dmKg) * 100 : 0;
const fatPctActual = dmKg > 0 ? (fatKg / dmKg) * 100 : 0;
const starchPct = dmKg > 0 ? (starchKg / dmKg) * 100 : 0;

  const roughPctDM = dmKg > 0 ? (forageDmKg / dmKg) * 100 : 0;
  const concPctDM = dmKg > 0 ? (concDmKg / dmKg) * 100 : 0;
  const fcRatio = concDmKg > 0 ? (forageDmKg / concDmKg) : null;

  const dmiTarget = num(targets?.dmi ?? targets?.dmiTarget);
  const nelTarget = num(targets?.nel ?? targets?.nelTarget);
  const mpTargetG = num(targets?.mpTargetG);
  const ndfTarget = num(targets?.ndfTarget);
  const starchMax = num(targets?.starchMax);
  const roughageMin = num(targets?.roughageMin);
  const peNDFMin = num(targets?.peNDFMin);
  const dmBalanceKg = dmiTarget ? (dmKg - dmiTarget) : 0;
  const mpBalanceG = mpTargetG ? (mpSupplyG - mpTargetG) : 0;
  let mpNote = 'تقييم البروتين الممثل جيد';

if (missingMpRows > 0) {
  mpNote = 'تقييم البروتين الممثل يحتوي خامات بدون قيم MP كاملة';
}

if (mpTargetG && mpSupplyG < mpTargetG) {
  mpNote = missingMpRows > 0
    ? 'يوجد عجز MP مع نقص في بعض بيانات الخامات'
    : 'يوجد عجز في البروتين الممثل عن الاحتياج';
}
  const mixPriceAsFed = asFedKg > 0 ? (totalCost / asFedKg) : 0;
  const mixPriceDM = dmKg > 0 ? (totalCost / dmKg) : 0;

  const avgMilkKg = num(context?.avgMilkKg);
  const milkPrice = num(context?.milkPrice);
  const milkFatPct = num(context?.milkFatPct);
  const milkProteinPct = num(context?.milkProteinPct);

  const milkRevenue = avgMilkKg > 0 ? (avgMilkKg * milkPrice) : 0;
  const costPerKgMilk = avgMilkKg > 0 ? (totalCost / avgMilkKg) : 0;
  const dmPerKgMilk = avgMilkKg > 0 ? (dmKg / avgMilkKg) : 0;
  const milkMargin = milkRevenue - totalCost;

 const fpcmKg = calcFpcmKg(avgMilkKg, milkFatPct);
const ecmKg = calcEcmKg(avgMilkKg, milkFatPct, milkProteinPct);

const speciesText = String(context?.species || '').trim().toLowerCase();
const isBuffalo = /جاموس|buffalo/.test(speciesText);
const dim = num(context?.daysInMilk ?? context?.dim);
const canApplyNasemRationDmi =
  !isBuffalo &&
  avgMilkKg > 0 &&
  dim > 60 &&
  forageNdfPctDiet > 0 &&
  adfPctActual > 0 &&
  ndfPctActual > 0;

const rationDmiCalc = canApplyNasemRationDmi
  ? predictCowLactatingDMIRationEffect({
      fNDFPct: forageNdfPctDiet,
      adfPct: adfPctActual,
      ndfPct: ndfPctActual,
      fNDFDPct: weightedForageNdfDigestibilityPct,
      milkKg: avgMilkKg
    })
  : null;

const dmiRationEffect = rationDmiCalc
  ? {
      model: 'NASEM_2021_EQ_2_2',
      applied: true,
      rationDmiKg: rationDmiCalc.dmi,
      animalDmiTargetKg: round(dmiTarget),
      constraintKg: round(rationDmiCalc.dmi - dmiTarget),
      status: dmiTarget && rationDmiCalc.dmi < dmiTarget - 1 ? 'limited_by_ration' : 'not_limited',
      usedFNDFDFallback: rationDmiCalc.usedFNDFDFallback,
      inputs: rationDmiCalc.inputs,
      note: dmiTarget && rationDmiCalc.dmi < dmiTarget - 1
        ? 'العليقة قد تحدّ استهلاك المادة الجافة بسبب تأثير الألياف أو هضم الخشن'
        : 'العليقة لا تبدو محددة لاستهلاك المادة الجافة حسب نموذج NASEM 2021 Eq. 2-2'
    }
  : {
      model: 'NASEM_2021_EQ_2_2',
      applied: false,
      rationDmiKg: null,
      animalDmiTargetKg: round(dmiTarget),
      constraintKg: null,
      status: 'not_applied',
      usedFNDFDFallback: false,
      inputs: {
        fNDFPct: round(forageNdfPctDiet),
        adfPct: round(adfPctActual),
        ndfPct: round(ndfPctActual),
        fNDFDPct: weightedForageNdfDigestibilityPct == null ? null : round(weightedForageNdfDigestibilityPct),
        milkKg: round(avgMilkKg),
        dim: round(dim, 0)
      },
      note: 'لم يتم تطبيق Eq. 2-2 لأن شروط التطبيق أو بيانات العليقة غير مكتملة'
    };

const rumenState = estimateRumenState({
  starchPct,
  ndfPctActual,
  roughPctDM,
  peNDFPctActual,
  starchMax,
  ndfTarget,
  roughageMin,
  peNDFMin
});

  return {
    totals: {
      asFedKg: round(asFedKg),
      dmKg: round(dmKg),
      cpKg: round(cpKg),
      mpSupplyG: round(mpSupplyG, 0),
      nelMcal: round(nelMcal),
      ndfKg: round(ndfKg),
      peNdfKg: round(peNdfKg),
      fatKg: round(fatKg),
      starchKg: round(starchKg),
      forageDmKg: round(forageDmKg),
      concDmKg: round(concDmKg),
      totCost: round(totalCost),
      mixPriceDM: round(mixPriceDM),
      mixPriceAsFed: round(mixPriceAsFed)
    },
    nutrition: {
      cpPctTotal: round(cpPctTotal),
      mpSupplyG: round(mpSupplyG, 0),
      mpDensityGkgDM: round(mpDensityGkgDM, 0),
      mpBalanceG: round(mpBalanceG, 0),
      mpNote,
      inputQuality: {
        missingMpRows,
        missingNelRows,
        missingNdfRows,
        missingStarchRows
},
     nelActual: round(nelTotalMcalDay),
      nelDensity: round(nelDensityMcalKgDM),
      nelBalanceMcal: round(nelMcal - nelTarget),
      ndfPctActual: round(ndfPctActual),
adfPctActual: round(adfPctActual),
forageNdfPctDiet: round(forageNdfPctDiet),
forageNdfDigestibilityPct: weightedForageNdfDigestibilityPct == null ? null : round(weightedForageNdfDigestibilityPct),
peNDFPctActual: round(peNDFPctActual),
fatPctActual: round(fatPctActual),
      starchPct: round(starchPct),
      roughPctDM: round(roughPctDM),
      concPctDM: round(concPctDM),
      fcRatio: fcRatio == null ? null : round(fcRatio),
      rumenNote: rumenState.note,
      rumenSync: {
        status: rumenState.status,
        note: rumenState.note
      },
     dmBalanceKg: round(dmBalanceKg),
dmiRationEffect
    },
    economics: {
      costPerKgMilk: round(costPerKgMilk),
      dmPerKgMilk: round(dmPerKgMilk),
      milkRevenue: round(milkRevenue),
      milkMargin: round(milkMargin),
      ecmKg: round(ecmKg),
      fpcmKg: round(fpcmKg)
    },
    targets: {
      dmiTarget: round(dmiTarget),
      nelTarget: round(nelTarget),
      mpTargetG: round(mpTargetG, 0),
      ndfTarget: round(ndfTarget),
      starchMax: round(starchMax),
      roughageMin: round(roughageMin),
      peNDFMin: round(peNDFMin)
    }
  };
}

module.exports = {
  analyzeRation
};
