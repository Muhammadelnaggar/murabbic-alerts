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
// SOURCE: NASEM_2021_CH6_EAA_FRAMEWORK
// Essential amino acids handled as absorbed supplies, g/day.
// No AA is calculated unless feed AA profile exists.
const EAA_KEYS = ['Arg', 'His', 'Ile', 'Leu', 'Lys', 'Met', 'Phe', 'Thr', 'Trp', 'Val'];

function makeEaaZeroMap(){
  const out = {};
  for (const k of EAA_KEYS) out[k] = 0;
  return out;
}

function normalizeAaProfile(profile){
  if (!profile || typeof profile !== 'object') return null;

  const out = {};
  let hasAny = false;

  for (const k of EAA_KEYS){
    const v = Number(
      profile[k] ??
      profile[k.toLowerCase()] ??
      profile[k.toUpperCase()]
    );

    if (Number.isFinite(v) && v >= 0){
      out[k] = v;
      hasAny = true;
    } else {
      out[k] = null;
    }
  }

  return hasAny ? out : null;
}
// MURABBIK_EAA_BALANCE
// Compares ration modeled EAA supply against NASEM target-side EAA requirements.
// Requirement source is expected from nutrition-engine:
// targets.proteinRequirementModel.eaaRequirementModel.requiredEaaG
function resolveRequiredEaaG(targets = {}, context = {}){
  const req =
    targets?.proteinRequirementModel?.eaaRequirementModel?.requiredEaaG ||
    targets?.eaaRequirementModel?.requiredEaaG ||
    targets?.requiredEaaG ||
    context?.proteinRequirementModel?.eaaRequirementModel?.requiredEaaG ||
    context?.eaaRequirementModel?.requiredEaaG ||
    context?.requiredEaaG ||
    null;

  return req && typeof req === 'object' ? req : null;
}

function buildEaaBalanceModel({ targets = {}, context = {}, supplyEaaG = {} }){
  const requiredEaaG = resolveRequiredEaaG(targets, context);

 if (!requiredEaaG) {
  return {
    model: 'MURABBIK_EAA_BALANCE_USING_NASEM_TARGETS',
    applied: true,
    status: 'watch',
    limitingAA: null,
    limitingSupplyPct: null,
    balance: {},
    note: 'تقييم الأحماض الأمينية يحتاج متابعة احترازية ضمن نموذج البروتين'
  };
}

const keys = Object.keys(requiredEaaG)
  .filter(k => Number.isFinite(Number(requiredEaaG[k])) && Number(requiredEaaG[k]) > 0);

if (!keys.length) {
  return {
    model: 'MURABBIK_EAA_BALANCE_USING_NASEM_TARGETS',
    applied: true,
    status: 'watch',
    limitingAA: null,
    limitingSupplyPct: null,
    balance: {},
    note: 'تقييم الأحماض الأمينية يحتاج متابعة احترازية ضمن نموذج البروتين'
  };
}

  const balance = {};
  let limitingAA = null;
  let minRatio = Infinity;

  for (const aa of keys) {
    const required = Number(requiredEaaG[aa]);
    const supplied = Number(supplyEaaG?.[aa] || 0);
    const diff = supplied - required;
    const ratio = required > 0 ? supplied / required : 0;

    if (ratio < minRatio) {
      minRatio = ratio;
      limitingAA = aa;
    }

    let status = 'ok';
    if (ratio < 0.95) status = 'deficit';
    else if (ratio < 1.00) status = 'watch';

    balance[aa] = {
      requiredG: round(required, 2),
      suppliedG: round(supplied, 2),
      balanceG: round(diff, 2),
      supplyPctOfRequirement: round(ratio * 100, 1),
      status
    };
  }

  const hasDeficit = Object.values(balance).some(x => x.status === 'deficit');
  const hasWatch = Object.values(balance).some(x => x.status === 'watch');

  return {
    model: 'MURABBIK_EAA_BALANCE_USING_NASEM_TARGETS',
    applied: true,
    status: hasDeficit ? 'deficit' : (hasWatch ? 'watch' : 'ok'),
    limitingAA,
    limitingSupplyPct: Number.isFinite(minRatio) ? round(minRatio * 100, 1) : null,
    balance,
    note: hasDeficit
      ? 'يوجد عجز في حمض أميني أساسي واحد أو أكثر مقارنة باحتياجات NASEM target-side'
      : (hasWatch
          ? 'بعض الأحماض الأمينية قريبة من حد الاحتياج وتحتاج متابعة'
          : 'إمداد الأحماض الأمينية يغطي الاحتياج المحسوب')
  };
}
// MURABBIK_MINERAL_SUPPLY
// Macro-mineral supply from feed library.
// Units:
// - Feed mineral fields are expected as % of DM.
// - Output totalMineralG = g/day.
// - absorbedMineralG is calculated only when an explicit absorption coefficient exists.
const MACRO_MINERAL_KEYS = ['Ca', 'P', 'Mg', 'Na', 'K', 'Cl', 'S'];

const MINERAL_FIELD_MAP = {
  Ca: ['caPct', 'calciumPct', 'CaPct'],
  P:  ['pPct', 'phosphorusPct', 'PPct'],
  Mg: ['mgPct', 'magnesiumPct', 'MgPct'],
  Na: ['naPct', 'sodiumPct', 'NaPct'],
  K:  ['kPct', 'potassiumPct', 'KPct'],
  Cl: ['clPct', 'chloridePct', 'ClPct'],
  S:  ['sPct', 'sulfurPct', 'sulphurPct', 'SPct']
};

const MINERAL_ABS_FIELD_MAP = {
  Ca: ['caAbsCoeff', 'calciumAbsCoeff', 'CaAbsCoeff'],
  P:  ['pAbsCoeff', 'phosphorusAbsCoeff', 'PAbsCoeff'],
  Mg: ['mgAbsCoeff', 'magnesiumAbsCoeff', 'MgAbsCoeff'],
  Na: ['naAbsCoeff', 'sodiumAbsCoeff', 'NaAbsCoeff'],
  K:  ['kAbsCoeff', 'potassiumAbsCoeff', 'KAbsCoeff'],
  Cl: ['clAbsCoeff', 'chlorideAbsCoeff', 'ClAbsCoeff'],
  S:  ['sAbsCoeff', 'sulfurAbsCoeff', 'sulphurAbsCoeff', 'SAbsCoeff']
};

function firstFiniteField(row, names){
  for (const name of names){
    const v = Number(row?.[name]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function makeMineralZeroMap(){
  const out = {};
  for (const k of MACRO_MINERAL_KEYS) out[k] = 0;
  return out;
}

function makeMineralMissingMap(){
  const out = {};
  for (const k of MACRO_MINERAL_KEYS) out[k] = 0;
  return out;
}
// MURABBIK_MINERAL_BALANCE
// Final macro-mineral balance.
// Feed library is treated as complete.
// Output statuses only: ok | watch | deficit.
function resolveRequiredMinerals(targets = {}, context = {}){
  const req =
    targets?.mineralRequirementModel?.requiredMinerals ||
    targets?.requiredMinerals ||
    context?.mineralRequirementModel?.requiredMinerals ||
    context?.requiredMinerals ||
    null;

  return req && typeof req === 'object' ? req : {};
}

function buildMineralBalanceModel({
  targets = {},
  context = {},
  totalMineralG = {},
  absorbedMineralG = {}
}){
  const requiredMinerals = resolveRequiredMinerals(targets, context);

  const balance = {};
  let overallStatus = 'ok';
  let limitingMineral = null;
  let minPct = Infinity;

  for (const mineral of MACRO_MINERAL_KEYS){
    const req = requiredMinerals[mineral] || {};

    const requiredAbsorbed = Number(req.requiredAbsorbedG);
    const requiredDietary = Number(req.dietaryRequiredG);

    const suppliedTotal = Number(totalMineralG?.[mineral] || 0);
    const suppliedAbsorbed = Number(absorbedMineralG?.[mineral] || 0);

    let requirementBasis = 'absorbed';
    let requiredG = requiredAbsorbed;
    let suppliedG = suppliedAbsorbed;

    // Sulfur in NASEM is dietary total S.
    if (mineral === 'S'){
      requirementBasis = 'dietary';
      requiredG = requiredDietary;
      suppliedG = suppliedTotal;
    }

    // If nutrition-engine gives dietary requirement instead of absorbed, use dietary.
    if (!(Number.isFinite(requiredG) && requiredG > 0) && Number.isFinite(requiredDietary) && requiredDietary > 0){
      requirementBasis = 'dietary';
      requiredG = requiredDietary;
      suppliedG = suppliedTotal;
    }

    const pct = requiredG > 0 ? (suppliedG / requiredG) * 100 : 100;
    const diff = suppliedG - requiredG;

    let status = 'ok';
    if (pct < 95) status = 'deficit';
    else if (pct < 100) status = 'watch';

    if (status === 'deficit') overallStatus = 'deficit';
    else if (status === 'watch' && overallStatus === 'ok') overallStatus = 'watch';

    if (pct < minPct){
      minPct = pct;
      limitingMineral = mineral;
    }

    balance[mineral] = {
      status,
      requirementBasis,
      requiredG: round(requiredG, 2),
      suppliedG: round(suppliedG, 2),
      balanceG: round(diff, 2),
      supplyPctOfRequirement: round(pct, 1),
      source: req.source || null
    };
  }

  return {
    model: 'MURABBIK_MINERAL_BALANCE_NASEM_2021',
    applied: true,
    status: overallStatus,
    limitingMineral,
    limitingSupplyPct: Number.isFinite(minPct) ? round(minPct, 1) : null,
    balance,
    note:
      overallStatus === 'deficit'
        ? 'يوجد عجز في معدن واحد أو أكثر'
        : overallStatus === 'watch'
          ? 'بعض المعادن قريبة من حد الاحتياج'
          : 'إمداد المعادن يغطي الاحتياج'
  };
}
// SOURCE: NASEM_2021_EQ_20_74_TO_20_79
// Ruminal microbial protein model.
// Requires rumen-digested NDF and rumen-digested starch inputs.
// No fallback is used for ruminal digestibility.
const NASEM_MICROBIAL = {
  MiN_Vm_int: 100.8,
  MiN_Vm_RDPslp: 81.56,
  MiN_Km_rdNDF: 0.0939,
  MiN_Km_rdSt: 0.0274,
  microbialCpPerNG: 6.25,
  microbialTpPerCp: 0.824,
  rdpCapPctDM: 12
};

// SOURCE: NASEM_2021_TABLE_6_2
// Microbial AA composition, g AA_corr / 100 g TP.
// Adapted in NASEM from Sok et al. (2017) with correction factors from Lapierre et al. (2019).
function defaultMicrobialAaProfilePctTP(){
  return {
    Arg: 5.47,
    His: 2.21,
    Ile: 6.99,
    Leu: 9.23,
    Lys: 9.44,
    Met: 2.63,
    Phe: 6.30,
    Thr: 6.23,
    Trp: 1.37,
    Val: 6.88
  };
}

function predictMicrobialProteinNasem({
  rdpKg,
  dmKg,
  rumDigNdfKg,
  rumDigStarchKg,
  microbialAaProfilePctTP
}){
  const An_RDPIn = num(rdpKg);              // kg/d
  const Dt_DMIn = num(dmKg);                // kg/d
  const Rum_DigNDFIn = num(rumDigNdfKg);    // kg/d
  const Rum_DigStIn = num(rumDigStarchKg);  // kg/d

 if (!An_RDPIn || !Dt_DMIn || !Rum_DigNDFIn || !Rum_DigStIn) {
  return {
    model: 'NASEM_2021_EQ_20_74_TO_20_79',
    applied: true,
    status: 'watch',
    microbialNG: 0,
    microbialCPKg: 0,
    microbialTPKg: 0,
    rdpBalanceKg: null,
    microbialEaaG: makeEaaZeroMap(),
    note: 'تقييم البروتين الميكروبي يحتاج متابعة احترازية ضمن نموذج البروتين'
  };
}

  // NASEM text: RDP effect capped above 12% dietary RDP.
  const rdpCapKg = Dt_DMIn * (NASEM_MICROBIAL.rdpCapPctDM / 100);
  const cappedRDPKg = Math.min(An_RDPIn, rdpCapKg);

  const MiN_Vm =
    NASEM_MICROBIAL.MiN_Vm_int +
    (NASEM_MICROBIAL.MiN_Vm_RDPslp * cappedRDPKg);

  const microbialNG =
    MiN_Vm /
    (
      1 +
      (NASEM_MICROBIAL.MiN_Km_rdNDF / Rum_DigNDFIn) +
      (NASEM_MICROBIAL.MiN_Km_rdSt / Rum_DigStIn)
    );

  let microbialCPKg =
    (microbialNG * NASEM_MICROBIAL.microbialCpPerNG) / 1000;

  // NASEM text: maximum microbial CP set at RDP intake.
  microbialCPKg = Math.min(microbialCPKg, An_RDPIn);

  const microbialTPKg =
    microbialCPKg * NASEM_MICROBIAL.microbialTpPerCp;

  const rdpBalanceKg = An_RDPIn - microbialCPKg;

  const profile = normalizeAaProfile(microbialAaProfilePctTP);
  const microbialEaaG = makeEaaZeroMap();

  if (profile) {
    for (const aa of EAA_KEYS) {
      const aaPctTP = profile[aa];
      if (aaPctTP == null) continue;
      microbialEaaG[aa] = microbialTPKg * 1000 * (aaPctTP / 100);
    }
  }

  return {
    model: 'NASEM_2021_EQ_20_74_TO_20_79',
    applied: true,
    status: 'calculated',
    microbialNG: round(microbialNG, 0),
    microbialCPKg: round(microbialCPKg, 3),
    microbialTPKg: round(microbialTPKg, 3),
    rdpBalanceKg: round(rdpBalanceKg, 3),
    cappedRDPKg: round(cappedRDPKg, 3),
    rdpCapPctDM: NASEM_MICROBIAL.rdpCapPctDM,
    inputs: {
      rdpKg: round(An_RDPIn, 3),
      dmKg: round(Dt_DMIn, 3),
      rumDigNdfKg: round(Rum_DigNDFIn, 3),
      rumDigStarchKg: round(Rum_DigStIn, 3)
    },
    microbialEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(microbialEaaG[k], 0)])),
    hasMicrobialAaProfile: !!profile,
    note: profile
      ? 'تم حساب microbial protein و microbial EAA حسب NASEM 2021'
      : 'تم حساب microbial protein و microbial EAA حسب نموذج مُرَبِّيك الغذائي'
  };
}

// SOURCE: NASEM_2021_TABLE_5_1
// Carbohydrate safety guide for lactating cow TMR diets.
// Uses forage NDF, total NDF, and starch.
// No extrapolation below fNDF 15% DM.
function evaluateCarbohydrateSafety({ forageNdfPctDiet, ndfPctActual, starchPct }){
  const fNDF = num(forageNdfPctDiet);
  const totalNDF = num(ndfPctActual);
  const starch = num(starchPct);
 if (!fNDF || !totalNDF) {
  return {
    model: 'NASEM_2021_TABLE_5_1',
    applied: true,
    status: 'watch',
    fNDFPctDM: round(fNDF),
    totalNDFPctDM: round(totalNDF),
    starchPctDM: round(starch),
    minTotalNDFPctDM: 30,
    maxStarchPctDM: 28,
    note: 'توازن الكربوهيدرات يحتاج متابعة احترازية حسب حدود الأمان'
  };
}

  if (fNDF < 15) {
    return {
      model: 'NASEM_2021_TABLE_5_1',
      applied: true,
      status: 'danger',
      fNDFPctDM: round(fNDF),
      totalNDFPctDM: round(totalNDF),
      starchPctDM: round(starch),
      minTotalNDFPctDM: 33,
      maxStarchPctDM: 22,
      note: 'fNDF أقل من نطاق جدول NASEM 2021؛ العليقة عالية الخطورة ولا يتم عمل extrapolation'
    };
  }

  const fNDFForTable = Math.min(fNDF, 19);
  const deficitFrom19 = 19 - fNDFForTable;

  const minTotalNDF = 25 + (2 * deficitFrom19);
  const maxStarch = 30 - (2 * deficitFrom19);

  let status = 'good';
  let note = 'توازن الكربوهيدرات مناسب حسب NASEM 2021 Table 5-1';

  if (totalNDF < minTotalNDF || starch > maxStarch) {
    status = 'danger';
    note = 'خطر كربوهيدرات: total NDF أقل من المطلوب أو starch أعلى من الحد حسب NASEM 2021 Table 5-1';
  } else if (totalNDF < minTotalNDF + 1 || starch > maxStarch - 1) {
    status = 'warn';
    note = 'الكربوهيدرات قريبة من حدود الأمان حسب NASEM 2021 Table 5-1';
  }

  return {
    model: 'NASEM_2021_TABLE_5_1',
    applied: true,
    status,
    fNDFPctDM: round(fNDF),
    totalNDFPctDM: round(totalNDF),
    starchPctDM: round(starch),
    minTotalNDFPctDM: round(minTotalNDF),
    maxStarchPctDM: round(maxStarch),
    note
  };
}
// SOURCE: NASEM_2021_TABLE_4_1
// Total-tract digestibility coefficients of fatty acids by explicit feed-library class.
// No name-based guessing. Feed library must provide either:
// - faDigestibilityCoeff
// - or faSourceClass / fatSourceClass / fatClass
const NASEM_FA_DIGESTIBILITY_BY_CLASS = {
  common_feeds: 0.73,
  oil_seeds: 0.73,
  oil: 0.70,
  blended_triglyceride: 0.63,
  tallow_triglyceride: 0.68,
  saturated_fa_enriched_triglycerides: 0.61,
  extensively_saturated_triglycerides: 0.44,
  calcium_salts_palm_fatty_acid: 0.76,
  saturated_fa_enriched_nonesterified_fa: 0.69,
  palmitic_acid_85: 0.73,
  palmitic_or_stearic_gt_90: 0.31
};

function normalizeFaSourceClass(v){
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

function resolveFaDigestibilityCoeff(row = {}){
  const explicit = Number(row.faDigestibilityCoeff ?? row.faDigestibility ?? row.faDigCoeff);

  if (Number.isFinite(explicit) && explicit > 0 && explicit <= 1) {
    return {
      coeff: explicit,
      sourceClass: 'explicit_feed_value',
      source: 'FEED_LIBRARY'
    };
  }

  const sourceClass = normalizeFaSourceClass(
    row.faSourceClass ??
    row.fatSourceClass ??
    row.fatClass
  );

  if (sourceClass && Object.prototype.hasOwnProperty.call(NASEM_FA_DIGESTIBILITY_BY_CLASS, sourceClass)) {
    return {
      coeff: NASEM_FA_DIGESTIBILITY_BY_CLASS[sourceClass],
      sourceClass,
      source: 'NASEM_2021_TABLE_4_1'
    };
  }

  return {
  coeff: NASEM_FA_DIGESTIBILITY_BY_CLASS.common_feeds,
  sourceClass: 'common_feeds',
  source: 'NASEM_2021_TABLE_4_1'
};
}

// SOURCE: NASEM_2021_EQ_2_2
// Diet/ration effect DMI equation for lactating cows.
// Applies only when ration forage-NDF, ADF/NDF, fNDFD, and milk yield are available.
function predictCowLactatingDMIRationEffect({ fNDFPct, adfPct, ndfPct, fNDFDPct, milkKg }){
  const fNDF = num(fNDFPct);
  const ADF_NDF = safeDiv(num(adfPct), num(ndfPct));
const fNDFD = Number(fNDFDPct);
const MY = num(milkKg);

if (!fNDF || !ADF_NDF || !(Number.isFinite(fNDFD) && fNDFD > 0) || !MY) {
  return null;
}

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
    }
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
let rdpKg = 0;
let rupKg = 0;
let digestibleRupKg = 0;
let mpSupplyG = 0;

let missingRdpRows = 0;
let missingRupRows = 0;
let missingRupDigestibilityRows = 0;
let missingAaProfileRows = 0;
  let rupEaaG = makeEaaZeroMap();
let digestibleRupEaaG = makeEaaZeroMap();
let missingAaDetailRows = 0;

  let nelMcal = 0;
 let ndfKg = 0;
let adfKg = 0;
let peNdfKg = 0;
let fatKg = 0;
let faKg = 0;
let digestibleFaKg = 0;
let faCoeffWeightedSum = 0;
let faCoeffWeightKg = 0;

let fatSupplementFaKg = 0;
let starchKg = 0;
let wscKg = 0;
let ndsfKg = 0;
let ndscKg = 0;
let nonForageNdfKg = 0;
let missingWscRows = 0;
let missingNdsfRows = 0;

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
 let rumDigNdfKg = 0;
let rumDigStarchKg = 0;
let missingRumDigNdfRows = 0;
let missingRumDigStarchRows = 0;

let mineralG = makeMineralZeroMap();
let absorbedMineralG = makeMineralZeroMap();
let mineralAbsCoeffWeightedSum = makeMineralZeroMap();
let mineralAbsCoeffWeightG = makeMineralZeroMap();
let missingMineralRows = makeMineralMissingMap();
let missingMineralAbsCoeffRows = makeMineralMissingMap();

  for (const r of list){
    const kg = num(r.kg ?? r.asFedKg);
    const dm = num(r.dm ?? r.dmPct);
  const cp = num(r.cp ?? r.cpPct);

const rawRdpPctCP = Number(r.rdpPctCP ?? r.rdpPctOfCP ?? r.rdp);
const hasRdp = Number.isFinite(rawRdpPctCP) && rawRdpPctCP >= 0;
const rdpPctCP = hasRdp ? rawRdpPctCP : 0;

const rawRupPctCP = Number(r.rupPctCP ?? r.rupPctOfCP ?? r.rup);
const hasRup = Number.isFinite(rawRupPctCP) && rawRupPctCP >= 0;
const rupPctCP = hasRup ? rawRupPctCP : 0;

const rawRupDig = Number(r.rupDigestibilityPct ?? r.digestibleRupPct ?? r.dRUPPct);
const hasRupDig = Number.isFinite(rawRupDig) && rawRupDig >= 0;
const rupDigestibilityPct = hasRupDig ? rawRupDig : 0;

const aaProfileRaw = r.aaProfilePctTP || r.aaProfile || null;
const aaProfile = normalizeAaProfile(aaProfileRaw);
const hasAaProfile = !!aaProfile;

const mp = num(r.mp ?? r.mpGPerKgDM);
    const nel = num(r.nel ?? r.nelMcalPerKgDM);
const ndf = num(r.ndf ?? r.ndfPct);
const adf = num(r.adf ?? r.adfPct);
const fat = num(r.fat ?? r.fatPct);
const rawFA = Number(r.faPct ?? r.fattyAcidsPct ?? r.totalFaPct ?? r.totalFAPct);
const hasExplicitFA = Number.isFinite(rawFA) && rawFA >= 0;

const fa = hasExplicitFA ? rawFA : fat;
const faDig = resolveFaDigestibilityCoeff(r);
const starch = num(r.starchPct ?? r.starch);

const rawWSC = Number(r.wscPct ?? r.waterSolubleCarbsPct ?? r.waterSolubleCarbohydratesPct);
const hasWSC = Number.isFinite(rawWSC) && rawWSC >= 0;
const wsc = hasWSC ? rawWSC : 0;
const rawRumNdfDig = Number(
  r.rumDigNdfPctOfNdf ??
  r.rumenDigestedNdfPctOfNdf ??
  r.ruminalNdfDigestibilityPct ??
  r.rumenNdfDigestibilityPct
);
const hasRumNdfDig = Number.isFinite(rawRumNdfDig) && rawRumNdfDig >= 0;

const rawRumStarchDig = Number(
  r.rumDigStarchPctOfStarch ??
  r.rumenDigestedStarchPctOfStarch ??
  r.ruminalStarchDigestibilityPct ??
  r.rumenStarchDigestibilityPct
);
const hasRumStarchDig = Number.isFinite(rawRumStarchDig) && rawRumStarchDig >= 0;
const rawNDSF = Number(r.ndsfPct ?? r.neutralDetergentSolubleFiberPct);
const hasNDSF = Number.isFinite(rawNDSF) && rawNDSF >= 0;
const ndsf = hasNDSF ? rawNDSF : 0;

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
for (const mineral of MACRO_MINERAL_KEYS) {
  const pct = firstFiniteField(r, MINERAL_FIELD_MAP[mineral]);
  const absCoeff = firstFiniteField(r, MINERAL_ABS_FIELD_MAP[mineral]);

  if (pct != null && pct >= 0) {
    const mineralItemG = dmItemKg * 1000 * (pct / 100);
    mineralG[mineral] += mineralItemG;

    if (absCoeff != null && absCoeff >= 0 && absCoeff <= 1) {
      absorbedMineralG[mineral] += mineralItemG * absCoeff;
      mineralAbsCoeffWeightedSum[mineral] += mineralItemG * absCoeff;
      mineralAbsCoeffWeightG[mineral] += mineralItemG;
    } else if (mineralItemG > 0) {
      missingMineralAbsCoeffRows[mineral]++;
    }
  } else if (dmItemKg > 0) {
    missingMineralRows[mineral]++;
  }
}
    asFedKg += kg;
    dmKg += dmItemKg;
const cpItemKg = dmItemKg * (cp / 100);
cpKg += cpItemKg;

if (hasRdp) {
  rdpKg += cpItemKg * (rdpPctCP / 100);
} else if (cp > 0) {
  missingRdpRows++;
}

if (hasRup) {
  const rupItemKg = cpItemKg * (rupPctCP / 100);
  rupKg += rupItemKg;

  const digestibleRupItemKg = hasRupDig
    ? rupItemKg * (rupDigestibilityPct / 100)
    : 0;

  if (hasRupDig) {
    digestibleRupKg += digestibleRupItemKg;
  } else {
    missingRupDigestibilityRows++;
  }

  if (hasAaProfile) {
    for (const aa of EAA_KEYS){
      const aaPctTP = aaProfile[aa];

      if (aaPctTP == null) {
        missingAaDetailRows++;
        continue;
      }

      // aaProfilePctTP = g AA / 100 g true protein.
      // Here RUP is treated as kg protein equivalent from feed library fields.
      const aaInRupG = rupItemKg * 1000 * (aaPctTP / 100);
      const aaDigestibleG = hasRupDig
        ? digestibleRupItemKg * 1000 * (aaPctTP / 100)
        : 0;

      rupEaaG[aa] += aaInRupG;
      digestibleRupEaaG[aa] += aaDigestibleG;
    }
  }
} else if (cp > 0) {
  missingRupRows++;
}

if (!hasAaProfile && cp > 0) {
  missingAaProfileRows++;
}

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

const faItemKg = dmItemKg * (fa / 100);
faKg += faItemKg;
digestibleFaKg += faItemKg * faDig.coeff;

if (faItemKg > 0) {
  faCoeffWeightedSum += faItemKg * faDig.coeff;
  faCoeffWeightKg += faItemKg;
}


if (String(r.cat || '').trim().toLowerCase() === 'add' && faItemKg > 0) {
  fatSupplementFaKg += faItemKg;
}

const starchItemKg = dmItemKg * (starch / 100);
const ndfItemKg = dmItemKg * (ndf / 100);

starchKg += starchItemKg;

if (hasRumNdfDig) {
  rumDigNdfKg += ndfItemKg * (rawRumNdfDig / 100);
} else if (ndfItemKg > 0) {
  missingRumDigNdfRows++;
}

if (hasRumStarchDig) {
  rumDigStarchKg += starchItemKg * (rawRumStarchDig / 100);
} else if (starchItemKg > 0) {
  missingRumDigStarchRows++;
}
wscKg += dmItemKg * (wsc / 100);
ndsfKg += dmItemKg * (ndsf / 100);
ndscKg += dmItemKg * ((starch + wsc + ndsf) / 100);

if (!hasWSC) missingWscRows++;
if (!hasNDSF) missingNdsfRows++;

totalCost += kg * priceKg;

if (cat === 'rough') {
  forageDmKg += dmItemKg;

  const forageNdfItemKg = dmItemKg * (ndf / 100);
  forageNdfKg += forageNdfItemKg;

  if (Number.isFinite(fNDFD) && fNDFD > 0 && forageNdfItemKg > 0) {
    forageNdfdWeightedSum += forageNdfItemKg * fNDFD;
    forageNdfdWeightKg += forageNdfItemKg;
  }
} else {
  nonForageNdfKg += dmItemKg * (ndf / 100);
}

if (cat === 'conc' || cat === 'add') concDmKg += dmItemKg;
  }

  const cpPctTotal = dmKg > 0 ? (cpKg / dmKg) * 100 : 0;
const rdpPctDM = dmKg > 0 ? (rdpKg / dmKg) * 100 : 0;
const rupPctDM = dmKg > 0 ? (rupKg / dmKg) * 100 : 0;
const digestibleRupPctDM = dmKg > 0 ? (digestibleRupKg / dmKg) * 100 : 0;
const rdpPctCPActual = cpKg > 0 ? (rdpKg / cpKg) * 100 : 0;
const rupPctCPActual = cpKg > 0 ? (rupKg / cpKg) * 100 : 0;
const mpDensityGkgDM = dmKg > 0 ? (mpSupplyG / dmKg) : 0;
  const digestibleRupEaaDensityGkgDM = {};
for (const aa of EAA_KEYS){
  digestibleRupEaaDensityGkgDM[aa] =
    dmKg > 0 ? (digestibleRupEaaG[aa] / dmKg) : 0;
}

  const nelTotalMcalDay = nelMcal;
  const nelDensityMcalKgDM = dmKg > 0 ? (nelMcal / dmKg) : 0;
  const ndfPctActual = dmKg > 0 ? (ndfKg / dmKg) * 100 : 0;
const adfPctActual = dmKg > 0 ? (adfKg / dmKg) * 100 : 0;
const forageNdfPctDiet = dmKg > 0 ? (forageNdfKg / dmKg) * 100 : 0;
const weightedForageNdfDigestibilityPct =
  forageNdfdWeightKg > 0 ? (forageNdfdWeightedSum / forageNdfdWeightKg) : null;

const peNDFPctActual = dmKg > 0 ? (peNdfKg / dmKg) * 100 : 0;
const fatPctActual = dmKg > 0 ? (fatKg / dmKg) * 100 : 0;
const faPctActual = dmKg > 0 ? (faKg / dmKg) * 100 : 0;
const digestibleFaPctActual = dmKg > 0 ? (digestibleFaKg / dmKg) * 100 : 0;
const faDigestibilityCoeffWeighted =
  faCoeffWeightKg > 0 ? (faCoeffWeightedSum / faCoeffWeightKg) : 0;
const fatSupplementFAPctDM = dmKg > 0 ? (fatSupplementFaKg / dmKg) * 100 : 0;
const starchPct = dmKg > 0 ? (starchKg / dmKg) * 100 : 0;
const wscPctActual = dmKg > 0 ? (wscKg / dmKg) * 100 : 0;
const ndsfPctActual = dmKg > 0 ? (ndsfKg / dmKg) * 100 : 0;
const ndscPctActual = dmKg > 0 ? (ndscKg / dmKg) * 100 : 0;
const nonForageNdfPctDiet = dmKg > 0 ? (nonForageNdfKg / dmKg) * 100 : 0;

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

if (mpTargetG && mpSupplyG < mpTargetG) {
  mpNote = 'يوجد عجز في البروتين الممثل عن الاحتياج';
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
  ndfPctActual > 0 &&
  weightedForageNdfDigestibilityPct != null &&
  weightedForageNdfDigestibilityPct > 0;

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
      inputs: rationDmiCalc.inputs,
      note: dmiTarget && rationDmiCalc.dmi < dmiTarget - 1
        ? 'العليقة قد تحدّ استهلاك المادة الجافة بسبب تأثير الألياف أو هضم الخشن'
        : 'العليقة لا تبدو محددة لاستهلاك المادة الجافة حسب نموذج NASEM 2021 Eq. 2-2'
    }
  : null;
const fatModel = {
  model: 'NASEM_2021_TABLE_4_1_FA_DIGESTIBILITY',
  totalFatKg: round(fatKg),
  totalFatPctDM: round(fatPctActual),
  totalFAKg: round(faKg),
  totalFAPctDM: round(faPctActual),
  digestibleFAKg: round(digestibleFaKg),
  digestibleFAPctDM: round(digestibleFaPctActual),
  faDigestibilityCoeffWeighted: round(faDigestibilityCoeffWeighted, 3),
  fatSupplementFAPctDM: round(fatSupplementFAPctDM),
  faValueSource: 'feed_library_fa_values',
  status:
    fatSupplementFAPctDM >= 3
      ? 'watch'
      : 'ok',
  note:
    fatSupplementFAPctDM >= 3
      ? 'إضافات الدهون مرتفعة؛ راجع مستوى الإضافة لأن NASEM 2021 يحذر من احتمال المبالغة في تقدير هضم FA وطاقة العليقة عند مستويات الإضافة العالية'
      : 'تم حساب FA digestibility من مكتبة الخامات حسب NASEM 2021 Table 4-1'
};
 const carbohydrateSafetyModel = evaluateCarbohydrateSafety({
  forageNdfPctDiet,
  ndfPctActual,
  starchPct
});

const carbohydrateModel = {
  model: 'NASEM_2021_CH5_CARBOHYDRATE_FRACTIONS',
  nfcUsedForFormulation: false,

  ndfPctDM: round(ndfPctActual),
  forageNdfPctDM: round(forageNdfPctDiet),
  nonForageNdfPctDM: round(nonForageNdfPctDiet),

  starchPctDM: round(starchPct),
  wscPctDM: round(wscPctActual),
  ndsfPctDM: round(ndsfPctActual),
  ndscPctDM: round(ndscPctActual),

  status: 'calculated',
  note: 'تم حساب تقسيم الكربوهيدرات حسب NASEM 2021: NDF و NDSC fractions'
};
 const microbialAaProfilePctTP =
  context?.microbialAaProfilePctTP ||
  context?.microbialAaProfile ||
  defaultMicrobialAaProfilePctTP();

const microbialProteinModel = predictMicrobialProteinNasem({
  rdpKg,
  dmKg,
  rumDigNdfKg,
  rumDigStarchKg,
  microbialAaProfilePctTP
});

const totalModeledEaaG = {};
for (const aa of EAA_KEYS) {
  totalModeledEaaG[aa] =
    digestibleRupEaaG[aa] +
    (microbialProteinModel.microbialEaaG?.[aa] || 0);
}
 const eaaBalanceModel = buildEaaBalanceModel({
  targets,
  context,
  supplyEaaG: totalModeledEaaG
});

const mineralSupplyModel = {
  model: 'MURABBIK_MACRO_MINERAL_SUPPLY',
  source: 'FEED_LIBRARY_VALUES',
  unit: 'g_day',
  totalMineralG: Object.fromEntries(
    MACRO_MINERAL_KEYS.map(k => [k, round(mineralG[k], 2)])
  ),
  absorbedMineralG: Object.fromEntries(
    MACRO_MINERAL_KEYS.map(k => [k, round(absorbedMineralG[k], 2)])
  ),
  absorptionCoeffWeighted: Object.fromEntries(
    MACRO_MINERAL_KEYS.map(k => [
      k,
      mineralAbsCoeffWeightG[k] > 0
        ? round(mineralAbsCoeffWeightedSum[k] / mineralAbsCoeffWeightG[k], 3)
        : null
    ])
  ),
   note: 'تم حساب إمداد المعادن الكبرى من مكتبة الخامات'
};
const mineralBalanceModel = buildMineralBalanceModel({
  targets,
  context,
  totalMineralG: mineralG,
  absorbedMineralG
});

mineralSupplyModel.mineralBalanceModel = mineralBalanceModel;
 const proteinModel = {
  model: 'NASEM_2021_CH6_PROTEIN_AA_FRAMEWORK',
  mpSupplyMode: 'feed_library_protein_values',
  cpPctDM: round(cpPctTotal),
  rdpPctDM: round(rdpPctDM),
  rupPctDM: round(rupPctDM),
  digestibleRupPctDM: round(digestibleRupPctDM),
  rdpPctCP: round(rdpPctCPActual),
  rupPctCP: round(rupPctCPActual),
  mpSupplyG: round(mpSupplyG, 0),
  mpDensityGkgDM: round(mpDensityGkgDM, 0),
 
eaaModel: {
  model: 'NASEM_2021_CH6_EAA_SUPPLY_FRAMEWORK',
  supplyMode: 'digestible_RUP_EAA_from_feed_library_only',
 includesMicrobialEAA: !!microbialProteinModel.hasMicrobialAaProfile,
includesEndogenousEAA: false,
  rupEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(rupEaaG[k], 0)])),
  digestibleRupEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(digestibleRupEaaG[k], 0)])),
  digestibleRupEaaDensityGkgDM: Object.fromEntries(EAA_KEYS.map(k => [k, round(digestibleRupEaaDensityGkgDM[k], 2)])),
 microbialProteinModel,
microbialEaaG: microbialProteinModel.microbialEaaG || makeEaaZeroMap(),
totalModeledEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(totalModeledEaaG[k], 0)])),
eaaBalanceModel,
note: microbialProteinModel.hasMicrobialAaProfile
  ? 'تم حساب EAA من dRUP و microbial true protein ضمن نموذج البروتين'
  : 'تم حساب EAA من dRUP و microbial true protein ضمن نموذج البروتين'
},
note: 'تم تجهيز نموذج البروتين حسب إطار NASEM 2021: CP → RDP/RUP/dRUP → MP/AA'
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
rdpKg: round(rdpKg),
rupKg: round(rupKg),
digestibleRupKg: round(digestibleRupKg),
     microbialNG: round(microbialProteinModel.microbialNG || 0, 0),
     microbialCPKg: round(microbialProteinModel.microbialCPKg || 0, 3),
     microbialTPKg: round(microbialProteinModel.microbialTPKg || 0, 3),
     rdpBalanceKg: microbialProteinModel.rdpBalanceKg == null ? null : round(microbialProteinModel.rdpBalanceKg, 3),
     rupEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(rupEaaG[k], 0)])),
     digestibleRupEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(digestibleRupEaaG[k], 0)])),
     microbialEaaG: microbialProteinModel.microbialEaaG || makeEaaZeroMap(),
     totalModeledEaaG: Object.fromEntries(EAA_KEYS.map(k => [k, round(totalModeledEaaG[k], 0)])),
   
      mpSupplyG: round(mpSupplyG, 0),
      nelMcal: round(nelMcal),
      ndfKg: round(ndfKg),
      peNdfKg: round(peNdfKg),
      fatKg: round(fatKg),
      faKg: round(faKg),
     digestibleFaKg: round(digestibleFaKg),
mineralsG: Object.fromEntries(
  MACRO_MINERAL_KEYS.map(k => [k, round(mineralG[k], 2)])
),
absorbedMineralsG: Object.fromEntries(
  MACRO_MINERAL_KEYS.map(k => [k, round(absorbedMineralG[k], 2)])
),
starchKg: round(starchKg),
      wscKg: round(wscKg),
      ndsfKg: round(ndsfKg),
      ndscKg: round(ndscKg),
      nonForageNdfKg: round(nonForageNdfKg),
      forageDmKg: round(forageDmKg),
      concDmKg: round(concDmKg),
      totCost: round(totalCost),
      mixPriceDM: round(mixPriceDM),
      mixPriceAsFed: round(mixPriceAsFed)
    },
    nutrition: {
      cpPctTotal: round(cpPctTotal),
      rdpPctDM: round(rdpPctDM),
rupPctDM: round(rupPctDM),
digestibleRupPctDM: round(digestibleRupPctDM),
rdpPctCP: round(rdpPctCPActual),
rupPctCP: round(rupPctCPActual),
proteinModel,
mineralSupplyModel,
      mpSupplyG: round(mpSupplyG, 0),
      mpDensityGkgDM: round(mpDensityGkgDM, 0),
      mpBalanceG: round(mpBalanceG, 0),
      mpNote,

     nelActual: round(nelTotalMcalDay),
      nelDensity: round(nelDensityMcalKgDM),
      nelBalanceMcal: round(nelMcal - nelTarget),
      ndfPctActual: round(ndfPctActual),
adfPctActual: round(adfPctActual),
forageNdfPctDiet: round(forageNdfPctDiet),
forageNdfDigestibilityPct: weightedForageNdfDigestibilityPct == null ? null : round(weightedForageNdfDigestibilityPct),
peNDFPctActual: round(peNDFPctActual),
fatPctActual: round(fatPctActual),
faPctActual: round(faPctActual),
digestibleFaPctActual: round(digestibleFaPctActual),
fatModel,
starchPct: round(starchPct),
wscPctActual: round(wscPctActual),
ndsfPctActual: round(ndsfPctActual),
ndscPctActual: round(ndscPctActual),
nonForageNdfPctDiet: round(nonForageNdfPctDiet),
carbohydrateModel,
carbohydrateSafetyModel,
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
