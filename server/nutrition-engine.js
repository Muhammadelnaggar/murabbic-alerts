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

// Operationalized NASEM-style lactating DMI
// Chapter 2 emphasizes Equation 2-1 as primary animal-factor DMI predictor.
// The official model needs specific fitted inputs; هنا نحافظ على نفس البنية العلمية بدل المعادلة المبسطة القديمة.
function predictCowLactatingDMI({ bodyWeight, milkKg, fatPct, proteinPct, dim, bcs, parity }){
  const bw    = num(bodyWeight);
 const milkE = milkEnergyMcalDay(milkKg, fatPct, proteinPct); // Mcal/day
  const DIM   = Math.max(1, num(dim, 1));
  const BCS   = clamp(num(bcs, 3.0), 2.0, 4.5);

  // NASEM Eq 2-1 parity term:
  // primiparous = 0, multiparous = 1
  const PAR = (num(parity, 2) > 1) ? 1 : 0;

  // DMI (kg/d) =
  // [3.7 + 5.7*Parity + 0.305*MilkE + 0.022*BW + (-0.689 - 1.87*Parity)*BCS]
  // × [1 - (0.212 + 0.136*Parity) * e^(-0.053*DIM)]
  let dmi =
    (
      3.7 +
      (5.7 * PAR) +
      (0.305 * milkE) +
      (0.022 * bw) +
      ((-0.689 - (1.87 * PAR)) * BCS)
    ) *
    (
      1 - ((0.212 + (0.136 * PAR)) * Math.exp(-0.053 * DIM))
    );

  const minDmi = Math.max(8.5, bw * 0.0175);
  const maxDmi = Math.max(26, bw * 0.042);

  return clamp(dmi, minDmi, maxDmi);
}
// Heifer DMI
function predictHeiferDMI({ bodyWeight, matureBodyWeight, dietNDFPct }){
  const bw = num(bodyWeight);

  // NASEM Eq 2-3 / 2-4 requires MatBW
  // fallback operational mature BW if not provided
  const matBW = num(matureBodyWeight || 0) || Math.max(700, bw * 1.35);
  const bwRatio = bw / matBW;
  const ndf = Number(dietNDFPct);

  // Equation 2-4 when NDF is known
  if (Number.isFinite(ndf) && ndf > 0){
    const expectedNDF =
      23.1 + (56 * bwRatio) - (30.6 * Math.pow(bwRatio, 2));

    const dmi =
      (0.0226 * matBW * (1 - Math.exp(-1.47 * bwRatio))) -
      (0.082 * (ndf - expectedNDF));

    return clamp(dmi, bw * 0.018, bw * 0.030);
  }

  // Equation 2-3 when NDF is not known
  const dmi =
    0.022 * matBW * (1 - Math.exp(-1.54 * bwRatio));

  return clamp(dmi, bw * 0.018, bw * 0.030);
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

  dmi = clamp(dmi * f.dmiFactor, Math.max(8.5, bw * 0.0175), Math.max(26, bw * 0.042));

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
  note: mpReq.note
}, 
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
  matureBodyWeight: Math.max(700, bw * 1.35),
  dietNDFPct
});
  dmi *= f.dmiFactor;

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
  note: mpReq.note
},
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
