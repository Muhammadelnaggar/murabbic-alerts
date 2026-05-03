// مُرَبِّيك — Nutrition Engine
// نسخة أقوى للاقتراب من NASEM 2021 داخل حدود هذا الملف
// ملاحظات:
// نسخة محسّنة أقرب إلى NASEM 2021 داخل حدود target-side فقط
// DMI: قريب جدًا من المعادلات الموصى بها
// MP: target-side improved approximation
// المضاهاة الكاملة للبروتين/AA تتطلب supply-side في analyze-ration
function num(v, d = 0){
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(n, d = 2){
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
}

function clamp(x, a, b){
  x = Number(x);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function normArabic(s){
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه');
}

/* ============================= */
/*        FEEDING CATEGORY       */
/* ============================= */

function resolveFeedingCategory(ctx){
  const milkKg   = num(ctx?.avgMilkKg ?? ctx?.milkKg ?? 0);
  const pregDays = num(ctx?.pregnancyDays || 0);
  const closeUp  = !!ctx?.closeUp;

  if (milkKg > 0) return 'lactating';
  if (closeUp) return 'close_up';
  if (pregDays > 0) return 'dry_pregnant';
  return 'heifer';
}

/* ============================= */
/*      STANDARD WEIGHT TABLE    */
/* ============================= */

function getStandardWeight(species, breed){
  const sp = normArabic(species);
  const b  = normArabic(breed);

  if (sp === 'جاموس' || sp === 'جاموسه' || sp === 'buffalo'){
    if (b.includes('مصري')) return 600;
    if (b.includes('هجين') && (b.includes('ايطالي') || b.includes('ايطالى') || b.includes('ايتالي') || b.includes('ايتالى'))) return 700;
    if (b.includes('هجين') && b.includes('مورا')) return 750;
    if (b.includes('ايطالي') || b.includes('ايطالى')) return 720;
    if (b.includes('مورا')) return 800;
    if (b.includes('خليط')) return 650;
    return 650;
  }

  if (b.includes('هولشتاين')) return 650;
  if (b.includes('مونبليار') || b.includes('مونبيليار') || b.includes('montb')) return 700;
  if (b.includes('فريزيان')) return 620;
  if (b.includes('سيمينتال') || b.includes('simmental')) return 720;
  if (b.includes('براون') || b.includes('سويس') || b.includes('brown swiss')) return 680;
  if (b.includes('جيرسي') || b.includes('jersey')) return 450;
  if (b.includes('خليط')) return 600;

  return 630;
}

/* ============================= */
/*       BREED ADJUSTMENTS       */
/* ============================= */

function isDualPurposeBreed(breed){
  const b = normArabic(breed);
  return (
    b.includes('مونبليار') ||
    b.includes('مونبيليار') ||
    b.includes('montb') ||
    b.includes('سيمينتال') ||
    b.includes('simmental')
  );
}

function cowBreedFactors(breed){
  if (isDualPurposeBreed(breed)){
    return {
      cpBonusPct: 2.0,   // business rule محفوظ لمُرَبِّيك
      dmiFactor: 0.97,
      nelMilkFactor: 1.02
    };
  }
  return {
    cpBonusPct: 0.0,
    dmiFactor: 1.0,
    nelMilkFactor: 1.0
  };
}

/* ============================= */
/*       NASEM CORE HELPERS      */
/* ============================= */

// SOURCE: NASEM_2021_EQ_2_1_INPUT
// MilkE = milk energy output, Mcal/day
function milkEnergyMcalDay(milkKg, fatPct, proteinPct){
  const milk = num(milkKg);
  const fat  = num(fatPct, 3.7);
  const prot = num(proteinPct, 3.2);

  const fatKg  = milk * (fat / 100);
  const protKg = milk * (prot / 100);

  return (0.327 * milk) + (12.95 * fatKg) + (7.20 * protKg);
}

// Backward-compatible alias.
// الاسم القديم كان مضللًا لأنه لا يرجع kg بل Mcal/day.
function milkEnergyCorrectedKg(milkKg, fatPct, proteinPct){
  return milkEnergyMcalDay(milkKg, fatPct, proteinPct);
}

// SOURCE: NASEM_2021_EQ_2_1
// Lactating cow DMI, kg/day.
// Applies to lactating dairy cows using animal factors only.
function predictCowLactatingDMI({ bodyWeight, milkKg, fatPct, proteinPct, dim, bcs, parity }){
  const bw = num(bodyWeight);
  const milkE = milkEnergyMcalDay(milkKg, fatPct, proteinPct); // Mcal/day
  const DIM = Math.max(1, num(dim, 1));
  const BCS = clamp(num(bcs, 3.0), 1.0, 5.0);

  // NASEM Eq 2-1 parity adjustment:
  // 0 = primiparous, 1 = multiparous
  const PAR = (num(parity, 2) > 1) ? 1 : 0;

  return (
    3.7 +
    (5.7 * PAR) +
    (0.305 * milkE) +
    (0.022 * bw) +
    ((-0.689 - (1.87 * PAR)) * BCS)
  ) *
  (
    1 - ((0.212 + (0.136 * PAR)) * Math.exp(-0.053 * DIM))
  );
}
// SOURCE: NASEM_2021_EQ_2_3_AND_2_4
// Heifer DMI, kg/day.
// Eq 2-4 is used when diet NDF is known; Eq 2-3 is used when diet NDF is not known.
function predictHeiferDMI({ bodyWeight, matureBodyWeight, dietNDFPct }){
  const bw = num(bodyWeight);
  const matBW = num(matureBodyWeight);

  if (!(matBW > 0)) {
    throw new Error('NASEM_DMI_HEIFER_REQUIRES_MATURE_BODY_WEIGHT');
  }

  const bwRatio = bw / matBW;
  const ndf = Number(dietNDFPct);

  if (Number.isFinite(ndf) && ndf > 0){
    const expectedNDF =
      23.1 + (56 * bwRatio) - (30.6 * Math.pow(bwRatio, 2));

    return (
      0.0226 * matBW * (1 - Math.exp(-1.47 * bwRatio))
    ) -
    (
      0.082 * (ndf - expectedNDF)
    );
  }

  return 0.022 * matBW * (1 - Math.exp(-1.54 * bwRatio));
}

function nelMaintenanceMcal(bodyWeight){
  return 0.10 * Math.pow(num(bodyWeight), 0.75);
}

// SOURCE: NASEM_2021_EQ_3_14A
// Milk NEL when milk crude protein is known.
// lactosePct default = 4.85% when not measured.
function nelLactationMilkMcal(milkKg, fatPct, proteinPct, f, lactosePct = 4.85){
  const milk = num(milkKg);
  const fatKgPerKgMilk = num(fatPct, 3.7) / 100;
  const cpKgPerKgMilk = num(proteinPct, 3.2) / 100;
  const lactoseKgPerKgMilk = num(lactosePct, 4.85) / 100;

  const mcalPerKgMilk =
    (9.29 * fatKgPerKgMilk) +
    (5.5 * cpKgPerKgMilk) +
    (3.95 * lactoseKgPerKgMilk);

  return milk * mcalPerKgMilk * num(f?.nelMilkFactor, 1);
}
// SOURCE: NASEM_2021_EQ_3_15_TO_3_18
// Gestation NEL for adult dairy cattle.
// calfBirthWeightKg: if not provided, estimate from mature body weight.
function gestationConceptusNE(bodyWeight, pregDays, calfBirthWeightKg = null, matureBodyWeight = null, isHeifer = false){
  const dayGest = clamp(num(pregDays), 0, 280);
  if (dayGest < 12) return 0;

  const matBW = num(matureBodyWeight) || num(bodyWeight);
  const calfBW =
    num(calfBirthWeightKg) ||
    (matBW * (isHeifer ? 0.058 : 0.063));

  const grUterAtParturition = calfBW * 1.825;

  const grUterWt =
    grUterAtParturition *
    Math.exp(-1 * (0.0243 - (0.0000245 * dayGest)) * (280 - dayGest));

  const grUterWtGain =
    (0.0243 - (0.0000245 * dayGest)) * grUterWt;

  const gestNEL = grUterWtGain * 4.16;

  return Math.max(0, gestNEL);
}
// SOURCE: NASEM_2021_EQ_3_15_TO_3_18_HELPER
// Daily gravid uterus gain, kg/day, used by protein Eq. 6-11a.
function gravidUterusGainKgDay(bodyWeight, pregDays, calfBirthWeightKg = null, matureBodyWeight = null, isHeifer = false){
  const dayGest = clamp(num(pregDays), 0, 280);
  if (dayGest < 12) return 0;

  const matBW = num(matureBodyWeight) || num(bodyWeight);
  const calfBW =
    num(calfBirthWeightKg) ||
    (matBW * (isHeifer ? 0.058 : 0.063));

  const grUterAtParturition = calfBW * 1.825;

  const grUterWt =
    grUterAtParturition *
    Math.exp(-1 * (0.0243 - (0.0000245 * dayGest)) * (280 - dayGest));

  const grUterWtGain =
    (0.0243 - (0.0000245 * dayGest)) * grUterWt;

  return Math.max(0, grUterWtGain);
}
function closeUpExtraNEL(closeUp){
  return closeUp ? 0.8 : 0;
}

function heiferTargetADG(bodyWeight){
  const bw = num(bodyWeight);
  if (bw <= 250) return 0.80;
  if (bw <= 350) return 0.90;
  if (bw <= 450) return 0.85;
  return 0.75;
}

function heiferGrowthNEL(bodyWeight, species){
  const bw = num(bodyWeight);
  const adg = heiferTargetADG(bw);

  let nelGrowth = 2.2 + (adg * 1.4) + (bw / 500);
  if (normArabic(species).includes('جاموس')) {
    nelGrowth *= 0.95;
  }
  return nelGrowth;
}

// MP operational approximation
// NASEM 2021 evaluates protein on MP / absorbed AA basis, not crude protein alone.
// SOURCE: NASEM_2021_EQ_6_7A_TO_6_14A
// MP recommendation, target-side only.
// Eq. 6-14a for lactating cows.
// Eq. 6-14c for late-gestation / heifers when milk = 0.
function computeNasemMPRequirement({
  bodyWeight,
  milkKg,
  proteinPct,
  pregDays,
  closeUp,
  growth,
  dmi,
  ndfPct,
  parity,
  species,
  matureBodyWeight
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const protPct = num(proteinPct, 3.2) / 100;
  const DMI = Math.max(0, num(dmi));
  const ndf = num(ndfPct, 30);
  const preg = num(pregDays);
  const par = num(parity, 2);

  const targetEffMP = 0.69;

  // Eq. 6-7a: NP-scurf = 0.17 × BW^0.60
  const npScurfG = 0.17 * Math.pow(bw, 0.60);

  // Eq. 6-8a: NP-endogenous urinary = 53 × 6.25 × BW × 0.001
  const npEndogenousUrinaryG = 53 * 6.25 * bw * 0.001;

  // Eq. 6-9a,b: CP-MFP = (11.62 + 0.134 × NDF%DM) × DMI; NP-MFP = CP-MFP × 0.73
  const cpMfpG = (11.62 + (0.134 * ndf)) * DMI;
  const npMfpG = cpMfpG * 0.73;

  // Milk TP. If TP/CP is not known, NASEM uses 0.951.
  const npMilkG = milk * protPct * 1000 * 0.951;

  // Eq. 6-11a: NP-Gestation = Gain_GrUter × 125
  const isHeifer = !!growth || milk <= 0;
  const grUterGainKg = gravidUterusGainKgDay(
    bw,
    preg,
    null,
    matureBodyWeight || bw,
    isHeifer
  );
  const npGestationG = grUterGainKg * 125;

  // Eq. 6-12a: NP-growth = Frame weight gain(g/d) × 0.11 × 0.86
  let frameGainKgDay = 0;
  if (growth) {
    frameGainKgDay = heiferTargetADG(bw);
  } else if (milk > 0 && par === 1) {
    frameGainKgDay = 0.19;
  } else if (milk > 0 && par === 2) {
    frameGainKgDay = 0.15;
  }

  const npGrowthG = (frameGainKgDay * 1000) * 0.11 * 0.86;

  let recommendedMPG;

  if (milk > 0) {
    // Eq. 6-14a
    recommendedMPG =
      ((npScurfG + npMfpG + npMilkG + npGrowthG) / targetEffMP) +
      (npGestationG / 0.33) +
      npEndogenousUrinaryG;
  } else {
    // Eq. 6-14c for late-gestation cows/heifers
    recommendedMPG =
      ((npScurfG + npMfpG) / targetEffMP) +
      (npGestationG / 0.33) +
      (npGrowthG / 0.40) +
      npEndogenousUrinaryG;
  }

  return {
    mpTargetG: recommendedMPG,
    model: milk > 0 ? 'NASEM_2021_EQ_6_14A' : 'NASEM_2021_EQ_6_14C',
    targetEffMP,
    components: {
      npScurfG,
      npMfpG,
      npMilkG,
      npGrowthG,
      npGestationG,
      npEndogenousUrinaryG,
      cpMfpG,
      grUterGainKgDay: grUterGainKg,
      frameGainKgDay
    },
    note: 'MP target computed from NASEM 2021 factorial NP components; EAA targets are handled separately by Eq. 6-14b/6-14d.'
  };
}
// SOURCE: NASEM_2021_TABLE_6_2_AND_TABLE_6_4
// EAA requirement keys: Table 6-4 target efficiencies.
// Arg is not included because Table 6-4 does not provide a target efficiency for Arg.
const NASEM_EAA_KEYS = ['His', 'Ile', 'Leu', 'Lys', 'Met', 'Phe', 'Thr', 'Trp', 'Val'];

const NASEM_EAA_TARGET_EFF = {
  His: 0.75,
  Ile: 0.71,
  Leu: 0.73,
  Lys: 0.72,
  Met: 0.73,
  Phe: 0.60,
  Thr: 0.64,
  Trp: 0.86,
  Val: 0.74
};

// SOURCE: NASEM_2021_TABLE_6_2
// g AA / 100 g TP
const NASEM_AA_PROFILE = {
  scurf: {
    His: 1.75,
    Ile: 2.96,
    Leu: 6.93,
    Lys: 5.64,
    Met: 1.40,
    Phe: 3.61,
    Thr: 4.01,
    Trp: 0.73,
    Val: 4.66
  },
  wholeEmptyBody: {
    His: 3.04,
    Ile: 3.69,
    Leu: 8.27,
    Lys: 7.90,
    Met: 2.37,
    Phe: 4.41,
    Thr: 4.84,
    Trp: 1.05,
    Val: 5.15
  },
  metabolicFecal: {
    His: 3.54,
    Ile: 5.39,
    Leu: 9.19,
    Lys: 7.61,
    Met: 1.73,
    Phe: 5.28,
    Thr: 7.36,
    Trp: 1.79,
    Val: 7.01
  },
  milk: {
    His: 2.92,
    Ile: 6.18,
    Leu: 10.56,
    Lys: 8.82,
    Met: 3.03,
    Phe: 5.26,
    Thr: 4.62,
    Trp: 1.65,
    Val: 6.90
  }
};

function aaFromProteinG(proteinG, profile){
  const out = {};
  for (const aa of NASEM_EAA_KEYS){
    out[aa] = num(proteinG) * (num(profile?.[aa]) / 100);
  }
  return out;
}

function endogenousUrinaryEaaG(bodyWeight){
  const bw = num(bodyWeight);
  const out = {};

  for (const aa of NASEM_EAA_KEYS){
    // Eq. 6-8b: for all EAA except His
    out[aa] = (0.010 * 6.25 * bw) * (NASEM_AA_PROFILE.wholeEmptyBody[aa] / 100);
  }

  // Eq. 6-8c: add urinary 3-methyl His
  out.His += (7.82 + (0.55 * bw)) / 1000;

  return out;
}

// SOURCE: NASEM_2021_EQ_6_7B_TO_6_14B_AND_6_14D
// Target-side digestible EAA flow requirement.
function computeNasemEAARequirements({
  bodyWeight,
  milkKg,
  mpReq
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const c = mpReq?.components || {};

  const netScurf = aaFromProteinG(c.npScurfG, NASEM_AA_PROFILE.scurf);
  const netMfp = aaFromProteinG(c.npMfpG, NASEM_AA_PROFILE.metabolicFecal);
  const netMilk = aaFromProteinG(c.npMilkG, NASEM_AA_PROFILE.milk);
  const netGrowth = aaFromProteinG(c.npGrowthG, NASEM_AA_PROFILE.wholeEmptyBody);
  const netGestation = aaFromProteinG(c.npGestationG, NASEM_AA_PROFILE.wholeEmptyBody);
  const endoUrinary = endogenousUrinaryEaaG(bw);

  const requiredEaaG = {};

  for (const aa of NASEM_EAA_KEYS){
    const eff = NASEM_EAA_TARGET_EFF[aa];

    if (milk > 0){
      // Eq. 6-14b
      requiredEaaG[aa] =
        ((netScurf[aa] + netMfp[aa] + netMilk[aa] + netGrowth[aa]) / eff) +
        (netGestation[aa] / 0.33) +
        endoUrinary[aa];
    } else {
      // Eq. 6-14d
      requiredEaaG[aa] =
        ((netScurf[aa] + netMfp[aa]) / eff) +
        (netGestation[aa] / 0.33) +
        (netGrowth[aa] / 0.40) +
        endoUrinary[aa];
    }
  }

  return {
    model: milk > 0 ? 'NASEM_2021_EQ_6_14B' : 'NASEM_2021_EQ_6_14D',
    status: 'verified_eaa_target',
    targetType: 'digestible_EAA_flow',
    requiredEaaG: Object.fromEntries(
      NASEM_EAA_KEYS.map(k => [k, round(requiredEaaG[k], 2)])
    ),
    targetEfficiencies: NASEM_EAA_TARGET_EFF,
    components: {
      netScurfG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(netScurf[k], 3)])),
      netMfpG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(netMfp[k], 3)])),
      netMilkG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(netMilk[k], 3)])),
      netGrowthG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(netGrowth[k], 3)])),
      netGestationG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(netGestation[k], 3)])),
      endogenousUrinaryG: Object.fromEntries(NASEM_EAA_KEYS.map(k => [k, round(endoUrinary[k], 3)]))
    },
    note: 'EAA target computed from NASEM 2021 factorial NetAA components and Table 6-4 target efficiencies.'
  };
}
// SOURCE: NASEM_2021_CH7_MINERALS_FRAMEWORK
// Macro-mineral requirement model skeleton.
// Values are intentionally null until each official equation is implemented.
// Cows only; buffalo remains MURABBIK_OPERATIONAL_RULE.
const MACRO_MINERAL_REQUIREMENT_KEYS = ['Ca', 'P', 'Mg', 'Na', 'K', 'Cl', 'S'];

function makeEmptyMacroMineralRequirement(){
  const out = {};
  for (const mineral of MACRO_MINERAL_REQUIREMENT_KEYS){
    out[mineral] = {
      requiredAbsorbedG: null,
      dietaryRequiredG: null,
      absorptionCoeff: null,
      status: 'not_implemented',
      source: null,
      note: 'لم يتم تطبيق معادلة هذا المعدن بعد'
    };
  }
  return out;
}

function computeNasemMacroMineralRequirements({
  bodyWeight,
  milkKg,
  milkProteinPct,
  pregDays,
  dmi,
  growth,
  category,
  matureBodyWeight
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const DMI = Math.max(0, num(dmi));
  const preg = num(pregDays);
  const proteinPct = num(milkProteinPct, 3.2);
  const isLactating = milk > 0 || category === 'lactating';
  const isGrowing = !!growth;
  const matBW = num(matureBodyWeight) || Math.max(700, bw * 1.35);
  const adg = isGrowing ? heiferTargetADG(bw) : 0;

  const requiredMinerals = makeEmptyMacroMineralRequirement();

  function gestAfter190(value){
    return preg > 190 ? value : 0;
  }

  function makeMineral({
    key,
    source,
    requiredAbsorbedG,
    absorptionCoeff,
    components,
    status = 'verified',
    note = ''
  }){
    requiredMinerals[key] = {
      requiredAbsorbedG: round(requiredAbsorbedG, 2),
      dietaryRequiredG:
        absorptionCoeff && absorptionCoeff > 0
          ? round(requiredAbsorbedG / absorptionCoeff, 2)
          : null,
      absorptionCoeff: absorptionCoeff ?? null,
      status,
      source,
      components: Object.fromEntries(
        Object.entries(components || {}).map(([k, v]) => [k, round(v, 3)])
      ),
      note
    };
  }

  // Calcium — NASEM 2021 Chapter 7
  const caMaintenanceG = 0.90 * DMI;
  const caGrowthG = isGrowing
    ? ((9.83 * Math.pow(matBW, 0.22)) * Math.pow(bw, -0.22)) * adg
    : 0;
  const caGestationG = gestAfter190(
    (
      (0.02456 * Math.exp((0.05581 - (0.00007 * preg)) * preg)) -
      (0.02456 * Math.exp((0.05581 - (0.00007 * (preg - 1))) * (preg - 1)))
    ) * (bw / 715)
  );
  const caMilkGPerKg = 0.295 + (0.239 * proteinPct);
  const caLactationG = milk * caMilkGPerKg;

  makeMineral({
    key: 'Ca',
    source: 'NASEM_2021_CH7_CA_EQ_7_1_TO_7_4',
    requiredAbsorbedG: caMaintenanceG + caGrowthG + caGestationG + caLactationG,
    absorptionCoeff: null,
    status: 'verified_absorbed_requirement',
    components: {
      maintenanceG: caMaintenanceG,
      growthG: caGrowthG,
      gestationG: caGestationG,
      lactationG: caLactationG,
      milkCaGPerKg: caMilkGPerKg,
      adgKgDay: adg
    },
    note: 'Ca absorbed requirement calculated from NASEM 2021; dietary Ca requires feed/source-specific Ca absorption coefficients.'
  });

  // Phosphorus — NASEM 2021 Chapter 7
  const pMaintenanceG = (isGrowing ? 0.8 : 1.0) * DMI + (0.0006 * bw);
  const pGrowthG = isGrowing
    ? (1.2 + ((4.635 * Math.pow(matBW, 0.22)) * Math.pow(bw, -0.22))) * adg
    : 0;
  const pGestationG = gestAfter190(
    (
      (0.02743 * Math.exp((0.05527 - (0.000075 * preg)) * preg)) -
      (0.02743 * Math.exp((0.05527 - (0.000075 * (preg - 1))) * (preg - 1)))
    ) * (bw / 715)
  );
  const pLactationG = 0.90 * milk;

  makeMineral({
    key: 'P',
    source: 'NASEM_2021_CH7_P_EQ_7_5_TO_7_7',
    requiredAbsorbedG: pMaintenanceG + pGrowthG + pGestationG + pLactationG,
    absorptionCoeff: null,
    status: 'verified_absorbed_requirement',
    components: {
      maintenanceG: pMaintenanceG,
      growthG: pGrowthG,
      gestationG: pGestationG,
      lactationG: pLactationG,
      adgKgDay: adg
    },
    note: 'P absorbed requirement calculated from NASEM 2021; dietary conversion should use feed/source-specific P absorption from ration-engine.'
  });

  // Magnesium — NASEM 2021 Chapter 7
  const mgMaintenanceG = (0.3 * DMI) + (0.0007 * bw);
  const mgGrowthG = isGrowing ? 0.45 * adg : 0;
  const mgGestationG = gestAfter190(0.3 * (bw / 715));
  const mgLactationG = 0.11 * milk;

  makeMineral({
    key: 'Mg',
    source: 'NASEM_2021_CH7_MG_EQ_7_9_TO_7_12',
    requiredAbsorbedG: mgMaintenanceG + mgGrowthG + mgGestationG + mgLactationG,
    absorptionCoeff: null,
    status: 'verified_absorbed_requirement',
    components: {
      maintenanceG: mgMaintenanceG,
      growthG: mgGrowthG,
      gestationG: mgGestationG,
      lactationG: mgLactationG,
      adgKgDay: adg
    },
    note: 'Mg absorbed requirement calculated from NASEM 2021; absorption is affected by diet K and should be handled in ration-engine.'
  });

  // Sodium — NASEM 2021 Chapter 7
  const naMaintenanceG = 1.45 * DMI;
  const naGrowthG = isGrowing ? 1.4 * adg : 0;
  const naGestationG = gestAfter190(1.4 * (bw / 715));
  const naLactationG = 0.4 * milk;

  makeMineral({
    key: 'Na',
    source: 'NASEM_2021_CH7_NA_EQ_7_14_TO_7_17',
    requiredAbsorbedG: naMaintenanceG + naGrowthG + naGestationG + naLactationG,
    absorptionCoeff: 1.0,
    status: 'verified',
    components: {
      maintenanceG: naMaintenanceG,
      growthG: naGrowthG,
      gestationG: naGestationG,
      lactationG: naLactationG,
      adgKgDay: adg
    },
    note: 'Na requirement and dietary requirement calculated with AC = 1.00 as assigned by NASEM 2021.'
  });

  // Potassium — NASEM 2021 Chapter 7
  const kMaintenanceG = (2.5 * DMI) + ((isLactating ? 0.2 : 0.07) * bw);
  const kGrowthG = isGrowing ? 2.5 * adg : 0;
  const kGestationG = gestAfter190(1.03 * (bw / 715));
  const kLactationG = 1.5 * milk;

  makeMineral({
    key: 'K',
    source: 'NASEM_2021_CH7_K_EQ_7_22_TO_7_25',
    requiredAbsorbedG: kMaintenanceG + kGrowthG + kGestationG + kLactationG,
    absorptionCoeff: 1.0,
    status: 'verified',
    components: {
      maintenanceG: kMaintenanceG,
      growthG: kGrowthG,
      gestationG: kGestationG,
      lactationG: kLactationG,
      adgKgDay: adg
    },
    note: 'K requirement and dietary requirement calculated with AC = 1.00 as assigned by NASEM 2021.'
  });

  // Chloride — NASEM 2021 Chapter 7
  const clMaintenanceG = 1.11 * DMI;
  const clGrowthG = isGrowing ? 1.0 * adg : 0;
  const clGestationG = gestAfter190(1.0 * (bw / 715));
  const clLactationG = 1.0 * milk;

  makeMineral({
    key: 'Cl',
    source: 'NASEM_2021_CH7_CL_EQ_7_18_TO_7_21',
    requiredAbsorbedG: clMaintenanceG + clGrowthG + clGestationG + clLactationG,
    absorptionCoeff: 0.92,
    status: 'verified',
    components: {
      maintenanceG: clMaintenanceG,
      growthG: clGrowthG,
      gestationG: clGestationG,
      lactationG: clLactationG,
      adgKgDay: adg
    },
    note: 'Cl requirement and dietary requirement calculated with AC = 0.92 as assigned by NASEM 2021.'
  });

  // Sulfur — NASEM 2021 Chapter 7
  const sDietaryG = DMI * 2.0;

  requiredMinerals.S = {
    requiredAbsorbedG: null,
    dietaryRequiredG: round(sDietaryG, 2),
    absorptionCoeff: null,
    status: 'verified_dietary_requirement',
    source: 'NASEM_2021_CH7_S_EQ_7_26',
    components: {
      dietaryG: round(sDietaryG, 3)
    },
    note: 'S requirement is dietary total S, not absorbed: Total S g/d = DMI × 2.0.'
  };

  return {
    model: 'NASEM_2021_CH7_MACRO_MINERAL_REQUIREMENT_FRAMEWORK',
    status: 'verified_macro_minerals',
    species: 'cow',
    targetType: 'absorbed_and_dietary_macro_minerals',
    inputs: {
      bodyWeight: round(bw, 2),
      milkKg: round(milk, 2),
      milkProteinPct: round(proteinPct, 2),
      pregDays: round(preg, 0),
      dmi: round(DMI, 2),
      growth: isGrowing,
      category: category || null,
      matureBodyWeight: round(matBW, 2),
      adgKgDay: round(adg, 3)
    },
    requiredMinerals,
    note: 'Macro-mineral requirements calculated from NASEM 2021 Chapter 7. Ca/P/Mg are absorbed requirements; Na/K/Cl include dietary conversion using NASEM AC where assigned; S is dietary total S.'
  };
}
// Backward-compatible wrapper.
// لا نستخدمه كـ operational approximation بعد الآن.
function computeOperationalMPTarget(args){
  return computeNasemMPRequirement(args).mpTargetG;
}

// MURABBIK_OPERATIONAL_RULE
// Buffalo MP target is NOT labeled as NASEM 2021.
// Kept separate to avoid applying dairy-cattle NASEM equations to buffalo.
function computeBuffaloOperationalMPTarget({
  bodyWeight,
  milkKg,
  proteinPct,
  pregDays,
  closeUp,
  growth
}){
  const bw075 = Math.pow(num(bodyWeight), 0.75);
  const milk  = num(milkKg);
  const milkProtPct = num(proteinPct, 4.2) / 100;

  const mpMaintenance = 3.8 * bw075;

  const milkTrueProteinG = milk * milkProtPct * 1000;
  const mpLactation = milkTrueProteinG / 0.67;

  let mpPreg = 0;
  if (pregDays >= 190){
    const late = pregDays - 190;
    mpPreg = 70 + (1.8 * late) + (0.01 * late * late);
  }

  const mpGrowth = growth ? 140 : 0;
  const mpCloseUp = closeUp ? 45 : 0;

  return mpMaintenance + mpLactation + mpPreg + mpGrowth + mpCloseUp;
}
// Operational CP reference only
function computeCPReferencePct({ species, milkKg, breed, stage }){
  const sp = normArabic(species);
  const milk = num(milkKg);
  const dual = isDualPurposeBreed(breed);

  let cp = 0;

  if (sp === 'جاموس' || sp === 'جاموسه' || sp === 'buffalo'){
    if (stage === 'heifer') cp = 14.0;
    else cp = 12.5 + (0.13 * milk);
    return clamp(cp, 12.5, 15.5);
  }

  if (stage === 'heifer') cp = 15.0;
  else cp = 14.0 + (0.055 * milk);

  if (dual) cp += 2.0;

  return clamp(cp, 14.0, stage === 'heifer' ? 17.0 : 18.5);
}

/* ============================= */
/*          COW ENGINE           */
/* ============================= */

function computeCow({
  bodyWeight,
  milkKg,
  pregDays,
  closeUp,
  dim,
  breed,
  milkFatPct,
  milkProteinPct,
  bcs,
  parity
}){
  const f = cowBreedFactors(breed);
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const days = num(dim);
  const fatPct = num(milkFatPct, 3.7);
  const proteinPct = num(milkProteinPct, 3.2);

  let dmi = predictCowLactatingDMI({
    bodyWeight: bw,
    milkKg: milk,
    fatPct,
    proteinPct,
    dim: days,
    bcs: num(bcs, 3.0),
    parity: num(parity, 2)
  });

  dmi = Math.max(0, dmi);

  const nelMaintenance = nelMaintenanceMcal(bw);
  const nelMilk = nelLactationMilkMcal(milk, fatPct, proteinPct, f);
  const nelPreg = gestationConceptusNE(bw, pregDays) + closeUpExtraNEL(closeUp);
  const nelTotal = nelMaintenance + nelMilk + nelPreg;

const mpReq = computeNasemMPRequirement({
  bodyWeight: bw,
  milkKg: milk,
  proteinPct,
  pregDays,
  closeUp,
  growth: false,
  dmi,
  ndfPct: 30,
  parity: num(parity, 2),
  species: 'cow',
  matureBodyWeight: getStandardWeight('cow', breed)
});

const mpTargetG = mpReq.mpTargetG;

const eaaReq = computeNasemEAARequirements({
  bodyWeight: bw,
  milkKg: milk,
  mpReq
});

const mineralReq = computeNasemMacroMineralRequirements({
  bodyWeight: bw,
  milkKg: milk,
  milkProteinPct: proteinPct,
  pregDays,
  dmi,
  growth: false,
  category: 'lactating',
  matureBodyWeight: getStandardWeight('cow', breed)
});
  const cpReferencePct = computeCPReferencePct({
    species: 'cow',
    milkKg: milk,
    breed,
    stage: 'lactating'
  });

  return {
    species: 'cow',
    category: 'lactating',
    dmiModel: {
  animalSide: 'NASEM_2021_EQ_2_1',
  status: 'verified',
  milkEUnit: 'Mcal/day'
},
    energyModel: {
  maintenance: 'NASEM_2021_EQ_3_13',
  lactation: 'NASEM_2021_EQ_3_14A',
  gestation: 'NASEM_2021_EQ_3_15_TO_3_18',
  unit: 'NEL_Mcal_day'
},
   proteinRequirementModel: {
  model: mpReq.model,
  status: 'verified_mp_target',
  targetType: 'MP',
  targetEffMP: mpReq.targetEffMP,
  components: Object.fromEntries(
    Object.entries(mpReq.components).map(([k, v]) => [k, round(v, 3)])
  ),
  note: mpReq.note,
  eaaRequirementModel: eaaReq
},  
mineralRequirementModel: mineralReq,
bodyWeight: bw,
  
   
    dim: Number.isFinite(days) ? Math.round(days) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    proteinSystem: 'MP',
    ndfTarget: 30,
    starchMax: 28,
    roughageMin: 40
  };
}

function computeCowHeifer({
  bodyWeight,
  pregDays,
  closeUp,
  breed,
  dietNDFPct
}){
  const f = cowBreedFactors(breed);
  const bw = num(bodyWeight);
  const bw075 = Math.pow(bw, 0.75);

let dmi = predictHeiferDMI({
  bodyWeight: bw,
  matureBodyWeight: getStandardWeight('cow', breed),
  dietNDFPct
});

  const nelMaintenance = 0.08 * bw075;
  const nelGrowth = heiferGrowthNEL(bw, 'cow');
  const nelPreg = gestationConceptusNE(bw, pregDays) + (closeUp ? 0.6 : 0);
  const nelTotal = nelMaintenance + nelGrowth + nelPreg;

const mpReq = computeNasemMPRequirement({
  bodyWeight: bw,
  milkKg: 0,
  proteinPct: 0,
  pregDays,
  closeUp,
  growth: true,
  dmi,
  ndfPct: 32,
  parity: 0,
  species: 'cow',
  matureBodyWeight: Math.max(700, bw * 1.35)
});

const mpTargetG = mpReq.mpTargetG;

const eaaReq = computeNasemEAARequirements({
  bodyWeight: bw,
  milkKg: 0,
  mpReq
});
const mineralReq = computeNasemMacroMineralRequirements({
  bodyWeight: bw,
  milkKg: 0,
  milkProteinPct: 0,
  pregDays,
  dmi,
  growth: true,
  category: 'heifer_or_dry',
  matureBodyWeight: Math.max(700, bw * 1.35)
});
  const cpReferencePct = computeCPReferencePct({
    species: 'cow',
    milkKg: 0,
    breed,
    stage: 'heifer'
  });

  return {
    species: 'cow',
    category: 'heifer',
    proteinRequirementModel: {
  model: mpReq.model,
  status: 'verified_mp_target',
  targetType: 'MP',
  targetEffMP: mpReq.targetEffMP,
  components: Object.fromEntries(
    Object.entries(mpReq.components).map(([k, v]) => [k, round(v, 3)])
  ),
   note: mpReq.note,
    eaaRequirementModel: eaaReq
},
mineralRequirementModel: mineralReq,
    bodyWeight: bw,
    dim: null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    proteinSystem: 'MP',
    ndfTarget: 32,
    starchMax: 24,
    roughageMin: 45
  };
}

/* ============================= */
/*        BUFFALO ENGINE         */
/* ============================= */
function buffaloFCM6(milkKg, fatPct){
  const milk = num(milkKg);
  const fat = num(fatPct, 6.5);

  // 6% FCM للجاموس:
  // FCM = 0.308 * milk + 11.54 * fatKg
  // حيث fatKg = milk * fat%
  const fatKg = milk * (fat / 100);
  return (0.308 * milk) + (11.54 * fatKg);
}
function buffaloECM(milkKg, fatPct, proteinPct){
  const milk = num(milkKg);
  const fat = num(fatPct, 6.5);
  const protein = num(proteinPct, 4.2);

  if (!milk) return 0;

  // ECM operational form
  return milk * ((0.383 * fat) + (0.242 * protein) + 0.7832) / 3.1138;
}

function buffaloNelMilkMcal(milkKg, fatPct, proteinPct){
  const ecm = buffaloECM(milkKg, fatPct, proteinPct);

  // Buffalo-specific lactation NE:
  // 3.56 MJ NE / kg ECM  → 0.85086 Mcal NE / kg ECM
  const mcalPerKgECM = 3.56 / 4.184;

  return ecm * mcalPerKgECM;
}
function buffaloCpPctLactating({ bodyWeight, milkKg, fatPct, dmi }){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const fat = num(fatPct, 6.5);
  const dmiKg = Math.max(0.1, num(dmi));

  const fcm6 = buffaloFCM6(milk, fat);

  // Paul et al.:
  // CP maintenance = 5.43 g / kg BW^0.75 / day
  // CP milk        = 90.3 g / kg 6% FCM
  const cpMaintG = 5.43 * Math.pow(bw, 0.75);
  const cpMilkG = 90.3 * fcm6;

  const cpPct = (cpMaintG + cpMilkG) / (dmiKg * 10);
  return round(cpPct, 2);
}

function buffaloCpPctHeifer({ bodyWeight, pregDays, closeUp }){
  const bw = num(bodyWeight);
  const dp = num(pregDays);

  // الحمل المتأخر
  if (dp >= 270 || closeUp) return 14.0;
  if (dp >= 240) return 12.0;

  // عجلات الجاموس
  if (bw < 400) return 15.5;
  if (bw <= 500) return 13.0;

  return 13.0;
}
function computeBuffalo({
  bodyWeight,
  milkKg,
  pregDays,
  closeUp,
  dim,
  breed,
  milkFatPct,
  milkProteinPct,
  bcs,
  parity
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const days = num(dim);
  const fatPct = num(milkFatPct, 6.5);
  const proteinPct = num(milkProteinPct, 4.2);
 const BCS = clamp(num(bcs, 3.0), 2.0, 4.5);
const PAR = num(parity, 2);
void BCS;
void PAR;

// Buffalo DMI based on metabolic BW + 6% FCM
const fcm6 = buffaloFCM6(milk, fatPct);

// DMI (kg/d) = 0.0599 * BW^0.75 + 0.688 * FCM6
let dmi =
  (0.0599 * Math.pow(bw, 0.75)) +
  (0.688 * fcm6);

// حدود تشغيلية آمنة للجاموس الحلاب
dmi = clamp(dmi, Math.max(9, bw * 0.0175), Math.max(24, bw * 0.036));

  const nelMaintenance = 0.095 * Math.pow(bw, 0.75);
 const nelMilk = buffaloNelMilkMcal(milk, fatPct, proteinPct);
  const nelPreg = (pregDays > 200 ? gestationConceptusNE(bw, pregDays) : 0) + (closeUp ? 1.0 : 0);
  const nelTotal = nelMaintenance + nelMilk + nelPreg;

const mpTargetG = computeBuffaloOperationalMPTarget({
  bodyWeight: bw,
  milkKg: milk,
  proteinPct,
  pregDays,
  closeUp,
  growth: false
});
const cpReferencePct = buffaloCpPctLactating({
  bodyWeight: bw,
  milkKg: milk,
  fatPct,
  dmi
});

  return {
    species: 'buffalo',
    category: 'lactating',
    bodyWeight: bw,
    dim: Number.isFinite(days) ? Math.round(days) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    proteinSystem: 'MP',
    ndfTarget: 34,
    starchMax: 22,
    roughageMin: 50
  };
}

function computeBuffaloHeifer({ bodyWeight, pregDays, closeUp, breed, dietNDFPct }){
  const bw = num(bodyWeight);
  const bw075 = Math.pow(bw, 0.75);

  const nelMaintenance = 0.075 * bw075;
  const nelGrowth = heiferGrowthNEL(bw, 'جاموس');
  const nelPreg = (pregDays > 200 ? gestationConceptusNE(bw, pregDays) * 0.95 : 0) + (closeUp ? 0.8 : 0);
  const nelTotal = nelMaintenance + nelGrowth + nelPreg;

const matureBw = getStandardWeight('جاموس', breed);

const dmi = predictHeiferDMI({
  bodyWeight: bw,
  matureBodyWeight: matureBw,
  dietNDFPct
});

 const mpTargetG = computeBuffaloOperationalMPTarget({
  bodyWeight: bw,
  milkKg: 0,
  proteinPct: 0,
  pregDays,
  closeUp,
  growth: true
});

const cpReferencePct = buffaloCpPctHeifer({
  bodyWeight: bw,
  pregDays,
  closeUp
});

  return {
    species: 'buffalo',
    category: 'heifer',
    bodyWeight: bw,
    dim: null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    proteinSystem: 'MP',
    ndfTarget: 34,
    starchMax: 22,
    roughageMin: 50
  };
}

/* ============================= */
/*         MAIN DISPATCH         */
/* ============================= */

function computeTargets(ctx){
  const species    = String(ctx?.species || '').trim();
  const breed      = String(ctx?.breed || '').trim();
  const milkKg     = num(ctx?.avgMilkKg ?? ctx?.milkKg ?? 0);
  const pregDays   = num(ctx?.pregnancyDays || 0);
  const closeUp    = !!ctx?.closeUp;
  const category   = resolveFeedingCategory(ctx);
  const dim        = num(ctx?.daysInMilk ?? ctx?.dim ?? 0);
  const bodyWeight = num(ctx?.bodyWeight || 0) || getStandardWeight(species, breed);

  const common = {
    bodyWeight,
    milkKg,
    pregDays,
    closeUp,
    dim,
    breed,
    milkFatPct: ctx?.milkFatPct,
    milkProteinPct: ctx?.milkProteinPct,
    bcs: num(ctx?.bcs, 3.0),
    parity: num(ctx?.parity, 2),
    dietNDFPct: ctx?.dietNDFPct
  };

  const sp = normArabic(species);
  const isBuffalo = (sp === 'جاموس' || sp === 'جاموسه' || sp === 'buffalo');

  if (isBuffalo){
    if (category === 'heifer' || category === 'dry_pregnant' || category === 'close_up'){
      return computeBuffaloHeifer(common);
    }
    return computeBuffalo(common);
  }

  if (category === 'heifer' || category === 'dry_pregnant' || category === 'close_up'){
    return computeCowHeifer(common);
  }

  return computeCow(common);
}

module.exports = {
  computeTargets
};
