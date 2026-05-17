// مُرَبِّيك — Nutrition Engine
// Target-side nutrition requirements engine.
// Cows: DMI, Energy, MP/EAA, Macro minerals, Trace minerals, and Vitamins
// are calculated using implemented NASEM 2021 equation pathways.
// Buffalo remains separated under MURABBIK_OPERATIONAL_RULE unless explicitly documented.
// Supply-side ration analysis is handled in server/ration-engine.js.
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
// SOURCE: NASEM_2021_CH12_STAGE_DEFINITION
// Chapter 12 defines transition as the last 3 weeks of gestation
// and the first 3 weeks of lactation.
// This model classifies stage only; it does not invent nutrient requirements.
function resolveChapter12Stage(ctx = {}){
  const milkKg = num(ctx?.avgMilkKg ?? ctx?.milkKg ?? 0);
  const pregDays = num(ctx?.pregnancyDays || 0);
  const dim = num(ctx?.daysInMilk ?? ctx?.dim ?? 0);
  const closeUp = !!ctx?.closeUp;

  const gestationLength = 280;
  const daysPrepartum =
    pregDays > 0
      ? Math.max(0, gestationLength - Math.min(pregDays, gestationLength))
      : null;

  if (milkKg > 0 && dim > 0 && dim <= 21) {
    return {
      model: 'NASEM_2021_CH12_STAGE_DEFINITION',
      stage: 'fresh_postpartum',
      transitionPhase: 'postpartum',
      isTransition: true,
      daysInMilk: Math.round(dim),
      daysPrepartum: null,
      note: 'Fresh cow within first 3 weeks of lactation according to NASEM 2021 Chapter 12.'
    };
  }

  if (closeUp || (daysPrepartum != null && daysPrepartum <= 21)) {
    return {
      model: 'NASEM_2021_CH12_STAGE_DEFINITION',
      stage: 'close_up_prepartum',
      transitionPhase: 'prepartum',
      isTransition: true,
      daysInMilk: null,
      daysPrepartum: daysPrepartum == null ? null : Math.round(daysPrepartum),
      note: 'Close-up cow within last 3 weeks of gestation according to NASEM 2021 Chapter 12.'
    };
  }

  if (daysPrepartum != null && daysPrepartum > 21) {
    return {
      model: 'NASEM_2021_CH12_STAGE_DEFINITION',
      stage: 'far_off_dry',
      transitionPhase: 'dry_far_off',
      isTransition: false,
      daysInMilk: null,
      daysPrepartum: Math.round(daysPrepartum),
      note: 'Far-off dry cow before the last 3 weeks prepartum; DMI is set from week 3 value per NASEM 2021 Chapter 12.'
    };
  }

  return {
    model: 'NASEM_2021_CH12_STAGE_DEFINITION',
    stage: 'not_chapter12_target',
    transitionPhase: null,
    isTransition: false,
    daysInMilk: dim > 0 ? Math.round(dim) : null,
    daysPrepartum,
    note: 'Animal is not currently classified as dry or transition cow by Chapter 12 stage rules.'
  };
}
// SOURCE: NASEM_2021_CH12_ENERGY_CONTEXT
// Chapter 12 classifies dry/transition stage.
// Adult cow energy requirements remain expressed as NEL components:
// maintenance, pregnancy, lactation when milk exists, and no growth for mature dry cows.
function buildChapter12EnergyModel({
  chapter12StageModel,
  nelMaintenance,
  nelPreg,
  nelMilk = 0,
  nelGrowth = 0
}){
  const stage = chapter12StageModel?.stage || 'not_chapter12_target';
  const isDryOrPrepartum =
    stage === 'far_off_dry' ||
    stage === 'close_up_prepartum';

  const components = {
    maintenanceMcal: round(nelMaintenance),
    pregnancyMcal: round(nelPreg),
    lactationMcal: round(nelMilk),
    growthMcal: round(nelGrowth)
  };

  const hasGrowth = num(nelGrowth) > 0;

  return {
    model: 'NASEM_2021_CH12_ENERGY_CONTEXT',
    stage,
    source: 'NASEM_2021_CH12_PLUS_CH3_ENERGY',
    unit: 'NEL_Mcal_day',
    status: 'verified',
    components,
    totalNELMcal: round(
      num(nelMaintenance) +
      num(nelPreg) +
      num(nelMilk) +
      num(nelGrowth)
    ),
    rule: isDryOrPrepartum
      ? (
          hasGrowth
            ? 'mature_dry_or_close_up_cow_uses_maintenance_plus_pregnancy_plus_frame_growth_no_lactation'
            : 'mature_dry_or_close_up_cow_uses_maintenance_plus_pregnancy_no_lactation_no_growth'
        )
      : 'fresh_or_lactating_cow_uses_lactation_energy_when_milk_exists',
    note: isDryOrPrepartum
      ? (
          hasGrowth
            ? 'Dry/close-up mature cow energy is calculated from maintenance plus pregnancy plus target frame gain; lactation is not used.'
            : 'Dry/close-up mature cow energy is calculated from maintenance plus pregnancy only; lactation and growth are not used.'
        )
      : 'Fresh postpartum/lactating cow energy includes milk energy when milk production exists.'
  };
}
// SOURCE: NASEM_2021_CH12_PROTEIN_CONTEXT
// Chapter 12 classifies dry/transition stage.
// Protein requirements for mature dry/close-up cows are evaluated using Chapter 6 MP/EAA components,
// with no lactation protein and no growth protein for mature dry cows.
function buildChapter12ProteinModel({
  chapter12StageModel,
  mpReq,
  eaaReq
}){
  const stage = chapter12StageModel?.stage || 'not_chapter12_target';

  const c = mpReq?.components || {};

  const isDryOrPrepartum =
    stage === 'far_off_dry' ||
    stage === 'close_up_prepartum';

  const hasGrowthProtein =
    num(c.npGrowthG) > 0 || num(c.frameGainKgDay) > 0;

  return {
    model: 'NASEM_2021_CH12_PROTEIN_CONTEXT',
    stage,
    source: 'NASEM_2021_CH12_PLUS_CH6_PROTEIN',
    status: 'verified_context',
    targetType: 'MP_and_digestible_EAA_flow',
    mpModel: mpReq?.model || null,
    eaaModel: eaaReq?.model || null,
    rule: isDryOrPrepartum
      ? (
          hasGrowthProtein
            ? 'mature_dry_or_close_up_cow_uses_no_lactation_protein_plus_frame_growth_protein'
            : 'mature_dry_or_close_up_cow_uses_no_lactation_protein_no_growth_protein'
        )
      : 'fresh_or_lactating_cow_uses_lactation_protein_when_milk_exists',
    components: {
      npScurfG: round(c.npScurfG, 3),
      npMfpG: round(c.npMfpG, 3),
      npMilkG: round(c.npMilkG, 3),
      npGrowthG: round(c.npGrowthG, 3),
      npGestationG: round(c.npGestationG, 3),
      npEndogenousUrinaryG: round(c.npEndogenousUrinaryG, 3),
      cpMfpG: round(c.cpMfpG, 3),
      grUterGainKgDay: round(c.grUterGainKgDay, 4),
      frameGainKgDay: round(c.frameGainKgDay, 4)
    },
     note: isDryOrPrepartum
      ? (
          hasGrowthProtein
            ? 'Dry/close-up mature cow protein is calculated from maintenance/metabolic fecal/endogenous, gestation, and target frame gain components; milk protein is not used.'
            : 'Dry/close-up mature cow protein is calculated from maintenance/metabolic fecal/endogenous and gestation components; milk and growth components are zero.'
        )
      : 'Fresh/lactating cow protein includes milk protein when milk production exists.'
  };
}
// SOURCE: NASEM_2021_CH12_MINERAL_REQUIREMENTS
// Chapter 12 defines dry/transition stage.
// Mineral requirements are calculated from NASEM Chapter 7 according to the animal state.
// For mature dry/close-up cows: no lactation minerals and no growth minerals.
function buildChapter12MineralModel({
  chapter12StageModel,
  mineralReq
}){
  const stage = chapter12StageModel?.stage || 'not_chapter12_target';

  const isDryOrPrepartum =
    stage === 'far_off_dry' ||
    stage === 'close_up_prepartum';

  return {
    model: 'NASEM_2021_DRY_TRANSITION_MINERAL_REQUIREMENTS',
    stage,
    source: 'NASEM_2021_CH12_STAGE_PLUS_CH7_MINERALS',
    status: 'verified',
    targetType: 'macro_and_trace_mineral_requirements',
    rule: isDryOrPrepartum
      ? 'mature_dry_or_close_up_cow_uses_no_lactation_minerals_no_growth_minerals'
      : 'fresh_or_lactating_cow_uses_lactation_minerals_when_milk_exists',
    macroMineralModel: mineralReq?.model || null,
    traceMineralModel: mineralReq?.traceMineralRequirementModel?.model || null,
    macroMinerals: mineralReq?.requiredMinerals || null,
    traceMinerals: mineralReq?.traceMineralRequirementModel?.traceMinerals || null,
    note: isDryOrPrepartum
      ? 'Dry/close-up mature cow mineral requirements are calculated from maintenance and gestation components; milk and growth mineral components are zero.'
      : 'Fresh/lactating cow mineral requirements include milk mineral components when milk production exists.'
  };
}
// SOURCE: NASEM_2021_CH12_VITAMIN_REQUIREMENTS
// Chapter 12 defines dry/transition stage.
// Vitamin requirements are calculated from NASEM Chapter 8 according to the animal state.
function buildChapter12VitaminModel({
  chapter12StageModel,
  vitaminReq
}){
  const stage = chapter12StageModel?.stage || 'not_chapter12_target';

  const isDryOrPrepartum =
    stage === 'far_off_dry' ||
    stage === 'close_up_prepartum';

  return {
    model: 'NASEM_2021_DRY_TRANSITION_VITAMIN_REQUIREMENTS',
    stage,
    source: 'NASEM_2021_CH12_STAGE_PLUS_CH8_VITAMINS',
    status: 'verified',
    targetType: 'supplemental_vitamin_AI',
    rule: isDryOrPrepartum
      ? 'mature_dry_or_close_up_cow_uses_dry_or_prepartum_vitamin_ai'
      : 'fresh_or_lactating_cow_uses_lactating_vitamin_ai',
    vitaminModel: vitaminReq?.model || null,
    vitamins: vitaminReq?.vitamins || null,
    note: isDryOrPrepartum
      ? 'Dry/close-up mature cow vitamin AI is calculated from NASEM Chapter 8 according to dry or prepartum state.'
      : 'Fresh/lactating cow vitamin AI is calculated according to lactating state.'
  };
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
  return 0.022 * bw;
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
// SOURCE: NASEM_2021_CH12_EQ_12_1
// Dry and transition mature cow DMI.
// Daily DMI, kg/100 kg BW = 1.47 − [(0.365 − 0.0028 × NDF) × Week] − 0.035 × Week²
// NDF is limited to 30–55% DM.
// Week is weeks before calving as a negative value; if >3 wk prepartum, Week = -3.
// If BCS > 4, estimated DMI is reduced by 8%.
function predictCowDryTransitionDMI({ bodyWeight, pregDays, dietNDFPct, bcs, gestationLength = 280 }){
const bw = num(bodyWeight);
const preg = clamp(num(pregDays), 0, gestationLength);
const rawNdf = Number(dietNDFPct);

if (!(Number.isFinite(rawNdf) && rawNdf > 0)) {
  return {
    dmi: null,
    model: 'NASEM_2021_CH12_EQ_12_1',
    applied: false,
    status: 'requires_diet_ndf_from_ration',
    inputs: {
      bodyWeight: round(bw, 2),
      pregDays: round(preg, 0),
      bcs: round(num(bcs, 3), 2),
      gestationLength
    }
  };
}

const ndf = clamp(rawNdf, 30, 55);
 
  const daysPrepartum = Math.max(0, gestationLength - preg);

  let week = -Math.min(3, daysPrepartum / 7);

  const dmiKgPer100KgBW =
    1.47 -
    ((0.365 - (0.0028 * ndf)) * week) -
    (0.035 * week * week);

  let dmi = bw * (dmiKgPer100KgBW / 100);

  if (num(bcs, 3) > 4) {
    dmi *= 0.92;
  }

return {
  dmi: Math.max(0, dmi),
  model: 'NASEM_2021_CH12_EQ_12_1',
  applied: true,
  status: 'verified',
  inputs: {
      bodyWeight: round(bw, 2),
      pregDays: round(preg, 0),
      daysPrepartum: round(daysPrepartum, 0),
      weekPrepartum: round(week, 3),
      dietNDFPct: round(ndf, 2),
      bcs: round(num(bcs, 3), 2),
      gestationLength
    }
  };
}
function nelMaintenanceMcal(bodyWeight){
  return 0.10 * Math.pow(num(bodyWeight), 0.75);
}

// SOURCE: NASEM_2021_EQ_3_14A
// Milk NEL when milk crude protein is known.
// lactosePct default = 4.85% when not measured.
function nelLactationMilkMcal(milkKg, fatPct, proteinPct, lactosePct = 4.85){
  const milk = num(milkKg);
  const fatKgPerKgMilk = num(fatPct, 3.7) / 100;
  const cpKgPerKgMilk = num(proteinPct, 3.2) / 100;
  const lactoseKgPerKgMilk = num(lactosePct, 4.85) / 100;

  const mcalPerKgMilk =
    (9.29 * fatKgPerKgMilk) +
    (5.5 * cpKgPerKgMilk) +
    (3.95 * lactoseKgPerKgMilk);

  return milk * mcalPerKgMilk;
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


function heiferTargetADG(bodyWeight){
  const bw = num(bodyWeight);
  if (bw <= 250) return 0.80;
  if (bw <= 350) return 0.90;
  if (bw <= 450) return 0.85;
  return 0.75;
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
  matureBodyWeight,
  frameGainKgDay
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

  // SOURCE: NASEM_2021_EQ_6_11A
  // NP-Gestation (g/d) = Gain_GrUter (kg/d) × 125
  const isHeifer = !!growth && par < 1;
  const grUterGainKg = gravidUterusGainKgDay(
    bw,
    preg,
    null,
    matureBodyWeight || bw,
    isHeifer
  );
  const npGestationG = grUterGainKg * 125;
  

 // Eq. 6-12a: NP-growth = Frame weight gain(g/d) × 0.11 × 0.86
// NASEM: Frame gain is an independent model input.
let frameGainForProteinKgDay = 0;

if (Number.isFinite(Number(frameGainKgDay)) && Number(frameGainKgDay) > 0) {
  frameGainForProteinKgDay = Number(frameGainKgDay);
} else if (growth) {
  frameGainForProteinKgDay = heiferTargetADG(bw);
}

const frameGainGDay = frameGainForProteinKgDay * 1000;

const npGrowthG = frameGainGDay * 0.11 * 0.86;
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
  frameGainKgDay: frameGainForProteinKgDay
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
  dmi: mineralDmiUsed,
  growth,
  category,
  matureBodyWeight
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const DMI = Math.max(0, num(mineralDmiUsed));
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
// SOURCE: NASEM_2021_CH7_TRACE_MINERALS
// Trace mineral target-side requirements / adequate intakes.
// Units: mg/day.
// Launch rule: no missing / no stop / no user-facing complexity.
const TRACE_MINERAL_REQUIREMENT_KEYS = ['Co', 'Cu', 'I', 'Fe', 'Mn', 'Se', 'Zn'];

function computeNasemTraceMineralRequirements({
  bodyWeight,
  milkKg,
  pregDays,
  dmi: mineralDmiUsed,
  growth,
  matureBodyWeight
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const preg = num(pregDays);
  const DMI = Math.max(0, num(mineralDmiUsed));
  const matBW = num(matureBodyWeight) || Math.max(700, bw * 1.35);
  const adg = growth ? heiferTargetADG(bw) : 0;

  function gestAfter190(value){
    return preg > 190 ? value : 0;
  }

  function gestCu(){
    if (preg > 190) return 0.0023 * bw;
    if (preg >= 90) return 0.0003 * bw;
    return 0;
  }

  const traceMinerals = {};

  // Cobalt — Eq. 7-27: dietary AI
  const coDietaryMg = 0.2 * DMI;
  traceMinerals.Co = {
    type: 'AI',
    basis: 'dietary',
    requiredMg: round(coDietaryMg, 3),
    dietaryRequiredMg: round(coDietaryMg, 3),
    absorbedRequiredMg: null,
    absorptionCoeff: null,
    source: 'NASEM_2021_CH7_CO_EQ_7_27',
    status: 'verified',
    components: {
      dmiKgDay: round(DMI, 3),
      aiMgPerKgDM: 0.2
    },
    note: 'Co dietary AI calculated from NASEM 2021 Chapter 7.'
  };

  // Copper — Eq. 7-29 to 7-33: absorbed requirement
  const cuMaintenanceMg = 0.0145 * bw;
  const cuGrowthMg = 2.0 * adg;
  const cuGestationMg = gestCu();
  const cuLactationMg = 0.04 * milk;
  const cuAbsMg = cuMaintenanceMg + cuGrowthMg + cuGestationMg + cuLactationMg;

  traceMinerals.Cu = {
    type: 'requirement',
    basis: 'absorbed',
    requiredMg: round(cuAbsMg, 3),
    absorbedRequiredMg: round(cuAbsMg, 3),
    dietaryRequiredMg: null,
    absorptionCoeff: null,
    source: 'NASEM_2021_CH7_CU_EQ_7_29_TO_7_33',
    status: 'verified_absorbed_requirement',
    components: {
      maintenanceMg: round(cuMaintenanceMg, 3),
      growthMg: round(cuGrowthMg, 3),
      gestationMg: round(cuGestationMg, 3),
      lactationMg: round(cuLactationMg, 3),
      adgKgDay: round(adg, 3)
    },
    note: 'Cu absorbed requirement calculated from NASEM 2021 Chapter 7.'
  };

  // Iodine — Eq. 7-34: dietary AI
  const iodineDietaryMg = (0.216 * Math.pow(bw, 0.528)) + (0.1 * milk);

  traceMinerals.I = {
    type: 'AI',
    basis: 'dietary',
    requiredMg: round(iodineDietaryMg, 3),
    dietaryRequiredMg: round(iodineDietaryMg, 3),
    absorbedRequiredMg: null,
    absorptionCoeff: null,
    source: 'NASEM_2021_CH7_I_EQ_7_34',
    status: 'verified',
    components: {
      bodyWeightTermMg: round(0.216 * Math.pow(bw, 0.528), 3),
      lactationMg: round(0.1 * milk, 3)
    },
    note: 'I dietary AI calculated from NASEM 2021 Chapter 7.'
  };

  // Iron — Eq. 7-35 to 7-38: absorbed requirement; basal AC retained at 0.10
  const feMaintenanceMg = 0;
  const feGrowthMg = 34 * adg;
  const feGestationMg = gestAfter190(0.025 * bw);
  const feLactationMg = 1.0 * milk;
  const feAbsMg = feMaintenanceMg + feGrowthMg + feGestationMg + feLactationMg;
  const feAC = 0.10;

  traceMinerals.Fe = {
    type: 'AI',
    basis: 'dietary',
    requiredMg: round(feAbsMg / feAC, 3),
    absorbedRequiredMg: round(feAbsMg, 3),
    dietaryRequiredMg: round(feAbsMg / feAC, 3),
    absorptionCoeff: feAC,
    source: 'NASEM_2021_CH7_FE_EQ_7_35_TO_7_38',
    status: 'verified',
    components: {
      maintenanceMg: round(feMaintenanceMg, 3),
      growthMg: round(feGrowthMg, 3),
      gestationMg: round(feGestationMg, 3),
      lactationMg: round(feLactationMg, 3),
      adgKgDay: round(adg, 3)
    },
    note: 'Fe requirement calculated from NASEM 2021 Chapter 7.'
  };

  // Manganese — Eq. 7-39 to 7-42: absorbed AI; practical dietary conversion with AC 0.0042
  const mnMaintenanceMg = 0.0026 * bw;
  const mnGrowthMg = 2.0 * adg;
  const mnGestationMg = gestAfter190(0.00042 * bw);
  const mnLactationMg = 0.03 * milk;
  const mnAbsMg = mnMaintenanceMg + mnGrowthMg + mnGestationMg + mnLactationMg;
  const mnAC = 0.0042;

  traceMinerals.Mn = {
    type: 'AI',
    basis: 'dietary',
    requiredMg: round(mnAbsMg / mnAC, 3),
    absorbedRequiredMg: round(mnAbsMg, 3),
    dietaryRequiredMg: round(mnAbsMg / mnAC, 3),
    absorptionCoeff: mnAC,
    source: 'NASEM_2021_CH7_MN_EQ_7_39_TO_7_42',
    status: 'verified',
    components: {
      maintenanceMg: round(mnMaintenanceMg, 3),
      growthMg: round(mnGrowthMg, 3),
      gestationMg: round(mnGestationMg, 3),
      lactationMg: round(mnLactationMg, 3),
      adgKgDay: round(adg, 3)
    },
    note: 'Mn AI calculated from NASEM 2021 Chapter 7.'
  };

  // Selenium — dietary AI: 0.3 mg/kg DM
  const seDietaryMg = 0.3 * DMI;

  traceMinerals.Se = {
    type: 'AI',
    basis: 'dietary',
    requiredMg: round(seDietaryMg, 3),
    dietaryRequiredMg: round(seDietaryMg, 3),
    absorbedRequiredMg: null,
    absorptionCoeff: null,
    source: 'NASEM_2021_CH7_SE_AI',
    status: 'verified',
    components: {
      dmiKgDay: round(DMI, 3),
      aiMgPerKgDM: 0.3
    },
    note: 'Se dietary AI calculated from NASEM 2021 Chapter 7.'
  };

  // Zinc — Eq. 7-44 to 7-47: absorbed requirement; AC 0.20
  const znMaintenanceMg = 5.0 * DMI;
  const znGrowthMg = 24 * adg;
  const znGestationMg = gestAfter190(0.017 * bw);
  const znLactationMg = 4.0 * milk;
  const znAbsMg = znMaintenanceMg + znGrowthMg + znGestationMg + znLactationMg;
  const znAC = 0.20;

  traceMinerals.Zn = {
    type: 'requirement',
    basis: 'dietary',
    requiredMg: round(znAbsMg / znAC, 3),
    absorbedRequiredMg: round(znAbsMg, 3),
    dietaryRequiredMg: round(znAbsMg / znAC, 3),
    absorptionCoeff: znAC,
    source: 'NASEM_2021_CH7_ZN_EQ_7_44_TO_7_47',
    status: 'verified',
    components: {
      maintenanceMg: round(znMaintenanceMg, 3),
      growthMg: round(znGrowthMg, 3),
      gestationMg: round(znGestationMg, 3),
      lactationMg: round(znLactationMg, 3),
      adgKgDay: round(adg, 3)
    },
    note: 'Zn requirement calculated from NASEM 2021 Chapter 7.'
  };

  return {
    model: 'NASEM_2021_CH7_TRACE_MINERAL_REQUIREMENTS',
    status: 'verified_trace_minerals',
    species: 'cow',
    targetType: 'trace_mineral_requirements_and_ai',
    unit: 'mg_day',
    inputs: {
      bodyWeight: round(bw, 2),
      matureBodyWeight: round(matBW, 2),
      milkKg: round(milk, 2),
      pregDays: round(preg, 0),
      dmi: round(DMI, 2),
      growth: !!growth,
      adgKgDay: round(adg, 3)
    },
    traceMinerals,
    note: 'Trace mineral targets calculated from NASEM 2021 Chapter 7.'
  };
}
// SOURCE: NASEM_2021_CH8_VITAMINS
// Supplemental vitamin AI targets for dairy cattle.
// Units: IU/day.
// Launch rule: no missing / no stop / no user-facing complexity.
// Applies to cows only; buffalo remains MURABBIK_OPERATIONAL_RULE.
const VITAMIN_REQUIREMENT_KEYS = ['A', 'D', 'E'];

function computeNasemVitaminRequirements({
  bodyWeight,
  milkKg,
  category,
  closeUp,
  freshPastureDMKg = 0
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const pastureDM = Math.max(0, num(freshPastureDMKg));
  const cat = String(category || '').trim();

  const isLactating = milk > 0 || cat === 'lactating';
  const isPrepartum = !!closeUp || cat === 'close_up';
  const isDry = !isLactating && !isPrepartum;

  // Vitamin A — NASEM 2021 Eq. 8-1a,b
  const vitaminAIU =
    milk > 35
      ? (110 * bw) + (1000 * (milk - 35))
      : (110 * bw);

  // Vitamin D — NASEM 2021 Eq. 8-2a,b
  const vitaminDIU =
    isLactating
      ? (40 * bw)
      : (30 * bw);

  // Vitamin E — NASEM 2021 Eq. 8-3a,b,c
  let vitaminEIU;
  let vitaminEEquation;

  if (isPrepartum) {
    vitaminEIU = 3.0 * bw;
    vitaminEEquation = 'NASEM_2021_CH8_EQ_8_3B';
  } else if (isDry) {
    vitaminEIU = 1.6 * bw;
    vitaminEEquation = 'NASEM_2021_CH8_EQ_8_3A';
  } else {
    vitaminEIU = 0.8 * bw;
    vitaminEEquation = 'NASEM_2021_CH8_EQ_8_3C';
  }

  // NASEM: reduce supplemental vitamin E by 50 IU/d for each kg fresh pasture DM.
  const vitaminEPastureCreditIU = 50 * pastureDM;
  const vitaminEFinalIU = Math.max(0, vitaminEIU - vitaminEPastureCreditIU);

  const vitamins = {
    A: {
      type: 'AI',
      basis: 'supplemental',
      unit: 'IU_day',
      requiredIU: round(vitaminAIU, 0),
      source: milk > 35 ? 'NASEM_2021_CH8_EQ_8_1B' : 'NASEM_2021_CH8_EQ_8_1A',
      status: 'verified',
      components: {
        bodyWeightKg: round(bw, 2),
        milkKg: round(milk, 2),
        baseIUPerKgBW: 110,
        extraMilkIU: round(milk > 35 ? 1000 * (milk - 35) : 0, 0)
      },
      note: 'Vitamin A supplemental AI calculated from NASEM 2021 Chapter 8.'
    },

    D: {
      type: 'AI',
      basis: 'supplemental_D3',
      unit: 'IU_day',
      requiredIU: round(vitaminDIU, 0),
      source: isLactating ? 'NASEM_2021_CH8_EQ_8_2B' : 'NASEM_2021_CH8_EQ_8_2A',
      status: 'verified',
      components: {
        bodyWeightKg: round(bw, 2),
        iuPerKgBW: isLactating ? 40 : 30
      },
      note: 'Vitamin D supplemental AI calculated from NASEM 2021 Chapter 8.'
    },

    E: {
      type: 'AI',
      basis: 'supplemental',
      unit: 'IU_day',
      requiredIU: round(vitaminEFinalIU, 0),
      source: vitaminEEquation,
      status: 'verified',
      components: {
        bodyWeightKg: round(bw, 2),
        baseRequiredIU: round(vitaminEIU, 0),
        freshPastureDMKg: round(pastureDM, 2),
        pastureCreditIU: round(vitaminEPastureCreditIU, 0)
      },
      note: 'Vitamin E supplemental AI calculated from NASEM 2021 Chapter 8.'
    }
  };

  return {
    model: 'NASEM_2021_CH8_VITAMIN_AI',
    status: 'verified_vitamin_ai',
    species: 'cow',
    targetType: 'supplemental_vitamin_AI',
    unit: 'IU_day',
    inputs: {
      bodyWeight: round(bw, 2),
      milkKg: round(milk, 2),
      category: cat || null,
      closeUp: !!closeUp,
      freshPastureDMKg: round(pastureDM, 2)
    },
    vitamins,
    note: 'Vitamin A, D, and E supplemental AI targets calculated from NASEM 2021 Chapter 8.'
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

   // SOURCE: BOVERA_2002_LACTATING_BUFFALO_MP_EFFICIENCY
  // Italian Mediterranean buffalo: efficiency of converting MP into milk protein = 50%
  // compared with 70% commonly used for dairy cows in CNCPS.
  const buffaloMilkProteinMPEfficiency = milk > 0 ? 0.50 : 0.67;

  const milkTrueProteinG = milk * milkProtPct * 1000;
  const mpLactation =
    milk > 0
      ? (milkTrueProteinG / buffaloMilkProteinMPEfficiency)
      : 0;

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
function nasemFrameGainKgDay({
  bodyWeight,
  matureBodyWeight,
  parity,
  explicitFrameGainKgDay = null
}){
  // لو جاءت قيمة صريحة من السياق/الموديول/المستخدم، تُستخدم كما هي.
  if (Number.isFinite(Number(explicitFrameGainKgDay)) && Number(explicitFrameGainKgDay) > 0) {
    return Number(explicitFrameGainKgDay);
  }

  const bw = num(bodyWeight);
  const matBW = num(matureBodyWeight);
  const par = num(parity, 2);

  if (!(bw > 0 && matBW > 0)) return 0;
  if (bw >= matBW) return 0;
  if (par >= 3) return 0;

  const targetGain =
    par === 1 ? 0.19 :
    par === 2 ? 0.15 :
    0;

  if (targetGain <= 0) return 0;

  const remainingKg = matBW - bw;
  return Math.max(0, Math.min(targetGain, remainingKg));
}

function lactatingFrameGainKgDay(args){
  return nasemFrameGainKgDay(args);
}

function nelFrameGainMcal(frameGainKgDay){
  const gain = num(frameGainKgDay);
  if (gain <= 0) return 0;

  // NASEM module check:
  // 0.10 kg/d frame gain -> 0.61 Mcal/d NEL
  // 0.15 kg/d frame gain -> 0.92 Mcal/d NEL
  // ≈ 6.1 Mcal NEL per kg frame gain.
  return gain * 6.1;
}
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
  parity,
  mineralDmi,
  frameGainKgDay
}){
  const bw = num(bodyWeight);
  const milk = num(milkKg);
  const days = num(dim);
  const fatPct = num(milkFatPct, 3.7);
  const proteinPct = num(milkProteinPct, 3.2);
  const chapter12StageModel = resolveChapter12Stage({
  avgMilkKg: milk,
  pregnancyDays: pregDays,
  closeUp,
  daysInMilk: days
});
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
const mineralDmiUsed =
  Number.isFinite(Number(mineralDmi)) && Number(mineralDmi) > 0
    ? Number(mineralDmi)
    : dmi;
const nelMaintenance = nelMaintenanceMcal(bw);
const nelMilk = nelLactationMilkMcal(milk, fatPct, proteinPct);
const nelPreg = gestationConceptusNE(bw, pregDays);

const matureBodyWeight = getStandardWeight('cow', breed);

const frameGainForEnergyKgDay = lactatingFrameGainKgDay({
  bodyWeight: bw,
  matureBodyWeight,
  parity: num(parity, 2),
  explicitFrameGainKgDay: frameGainKgDay
});

const nelGrowth = nelFrameGainMcal(frameGainForEnergyKgDay);

const nelTotal = nelMaintenance + nelMilk + nelPreg + nelGrowth;

const chapter12EnergyModel = buildChapter12EnergyModel({
  chapter12StageModel,
  nelMaintenance,
  nelPreg,
  nelMilk,
  nelGrowth
});
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
 matureBodyWeight,
frameGainKgDay: frameGainKgDay
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
  dmi: mineralDmiUsed,
  growth: false,
  category: 'lactating',
  matureBodyWeight
});

mineralReq.traceMineralRequirementModel = computeNasemTraceMineralRequirements({
  bodyWeight: bw,
  milkKg: milk,
  pregDays,
  dmi: mineralDmiUsed,
  growth: false,
  matureBodyWeight: getStandardWeight('cow', breed)
});

  const vitaminReq = computeNasemVitaminRequirements({
  bodyWeight: bw,
  milkKg: milk,
  category: 'lactating',
  closeUp,
  freshPastureDMKg: 0
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
chapter12StageModel,
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
    chapter12EnergyModel,
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
vitaminRequirementModel: vitaminReq,
bodyWeight: bw,
  
   
    dim: Number.isFinite(days) ? Math.round(days) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    cpTarget: round(cpReferencePct),
    proteinSystem: 'MP',
    ndfTarget: 30,
    starchMax: 28,
    roughageMin: 40
  };
}
function computeCowDryMother({
  bodyWeight,
  pregDays,
  closeUp,
  breed,
  dietNDFPct,
  bcs,
  parity,
  mineralDmi,
  frameGainKgDay
}){
  const bw = num(bodyWeight);
  const preg = num(pregDays);
  const matBW = getStandardWeight('cow', breed);
  const isCloseUp = !!closeUp;
  const chapter12StageModel = resolveChapter12Stage({
  avgMilkKg: 0,
  pregnancyDays: preg,
  closeUp: isCloseUp,
  daysInMilk: 0
});
  const dmiCalc = predictCowDryTransitionDMI({
    bodyWeight: bw,
    pregDays: preg,
    dietNDFPct,
    bcs,
    gestationLength: 280
  });

  if (!dmiCalc || dmiCalc.applied === false) {
  return {
    species: 'cow',
    category: isCloseUp ? 'close_up_mature_cow' : 'dry_mature_cow',
    chapter12StageModel,
    dmiModel: dmiCalc,
    bodyWeight: bw,
    dim: null,
    dmi: null,
    nel: null,
    mpTargetG: null,
    cpReferencePct: null,
    proteinSystem: 'MP',
    ndfTarget: null,
    starchMax: null,
    roughageMin: null,
    internalStatus: 'WAITING_FOR_RATION_NDF_TO_APPLY_NASEM_CH12'
  };
}

const dmi = Math.max(0, dmiCalc.dmi);
const mineralDmiUsed =
  Number.isFinite(Number(mineralDmi)) && Number(mineralDmi) > 0
    ? Number(mineralDmi)
    : dmi;
const nelMaintenance = nelMaintenanceMcal(bw);
const nelPreg = gestationConceptusNE(bw, preg, null, matBW, false);

const frameGainForEnergyKgDay = 0;

const nelGrowth = 0;

const nelTotal = nelMaintenance + nelPreg + nelGrowth;

const chapter12EnergyModel = buildChapter12EnergyModel({
  chapter12StageModel,
  nelMaintenance,
  nelPreg,
  nelMilk: 0,
  nelGrowth
});
  const mpReq = computeNasemMPRequirement({
    bodyWeight: bw,
    milkKg: 0,
    proteinPct: 0,
    pregDays: preg,
    closeUp: isCloseUp,
    growth: false,
    dmi: mineralDmiUsed,
    ndfPct: dmiCalc.inputs.dietNDFPct,
    parity: num(parity, 2),
    species: 'cow',
    matureBodyWeight: matBW,
    frameGainKgDay: 0
});
  

  const mpTargetG = mpReq.mpTargetG;

  const eaaReq = computeNasemEAARequirements({
    bodyWeight: bw,
    milkKg: 0,
    mpReq
  });
  const chapter12ProteinModel = buildChapter12ProteinModel({
  chapter12StageModel,
  mpReq,
  eaaReq
});
  const mineralReq = computeNasemMacroMineralRequirements({
    bodyWeight: bw,
    milkKg: 0,
    milkProteinPct: 0,
    pregDays: preg,
    dmi: mineralDmiUsed,
    growth: false,
    category: isCloseUp ? 'close_up_mature_cow' : 'dry_mature_cow',
    matureBodyWeight: matBW
  });

  mineralReq.traceMineralRequirementModel = computeNasemTraceMineralRequirements({
    bodyWeight: bw,
    milkKg: 0,
    pregDays: preg,
    dmi: mineralDmiUsed,
    growth: false,
    matureBodyWeight: matBW
  });
const chapter12MineralModel = buildChapter12MineralModel({
  chapter12StageModel,
  mineralReq
});
  const vitaminReq = computeNasemVitaminRequirements({
    bodyWeight: bw,
    milkKg: 0,
    category: isCloseUp ? 'close_up' : 'dry_pregnant',
    closeUp: isCloseUp,
    freshPastureDMKg: 0
  });
const chapter12VitaminModel = buildChapter12VitaminModel({
  chapter12StageModel,
  vitaminReq
});
  const cpReferencePct = isCloseUp ? 12.5 : 12.0;

  return {
    species: 'cow',
    category: isCloseUp ? 'close_up_mature_cow' : 'dry_mature_cow',
    chapter12StageModel,

    dmiModel: {
      animalSide: dmiCalc.model,
      status: 'verified',
      inputs: dmiCalc.inputs,
      note: 'Dry and transition mature cow DMI calculated from NASEM 2021 Chapter 12 Eq. 12-1.'
    },

    energyModel: {
      maintenance: 'NASEM_2021_EQ_3_13',
      gestation: 'NASEM_2021_EQ_3_15_TO_3_18',
      growth: 'not_used_for_mature_dry_cow',
      unit: 'NEL_Mcal_day'
    },
      chapter12EnergyModel,
      chapter12ProteinModel,
      chapter12MineralModel,
      chapter12VitaminModel,
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
    vitaminRequirementModel: vitaminReq,

    bodyWeight: bw,
    dim: null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
   cpReferencePct: round(cpReferencePct),
cpTarget: round(cpReferencePct),
    proteinSystem: 'MP',

    ndfTarget: isCloseUp ? 34 : 36,
    starchMax: isCloseUp ? 18 : 16,
    roughageMin: isCloseUp ? 55 : 60
  };
}
function computeCowHeifer({
  bodyWeight,
  pregDays,
  closeUp,
  breed,
  dietNDFPct,
  mineralDmi
}){

  const bw = num(bodyWeight);
 

let dmi = predictHeiferDMI({
  bodyWeight: bw,
  matureBodyWeight: getStandardWeight('cow', breed),
  dietNDFPct
});
const mineralDmiUsed =
  Number.isFinite(Number(mineralDmi)) && Number(mineralDmi) > 0
    ? Number(mineralDmi)
    : dmi;
 const nelMaintenance = nelMaintenanceMcal(bw);
const nelGrowth = 0;
const nelPreg = gestationConceptusNE(bw, pregDays);
const nelTotal = nelMaintenance + nelPreg;

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
  dmi: mineralDmiUsed,
  growth: true,
  category: 'heifer_or_dry',
  matureBodyWeight: Math.max(700, bw * 1.35)
});

mineralReq.traceMineralRequirementModel = computeNasemTraceMineralRequirements({
  bodyWeight: bw,
  milkKg: 0,
  pregDays,
  dmi: mineralDmiUsed,
  growth: true,
  matureBodyWeight: Math.max(700, bw * 1.35)
});
  const vitaminReq = computeNasemVitaminRequirements({
  bodyWeight: bw,
  milkKg: 0,
  category: closeUp ? 'close_up' : (pregDays > 0 ? 'dry_pregnant' : 'heifer'),
  closeUp,
  freshPastureDMKg: 0
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
    vitaminRequirementModel: vitaminReq,
    bodyWeight: bw,
    dim: null,
    dmi: round(dmi),
    nel: round(nelTotal),
    mpTargetG: round(mpTargetG, 0),
    cpReferencePct: round(cpReferencePct),
    cpTarget: round(cpReferencePct),
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
// SOURCE: BUFFALO_NUTRIENT_REQUIREMENTS_BULBUL_2010_TABLE_4
// Lactating buffalo NDF% and NSC% targets by milk yield.
// These are buffalo targets, not cow fallbacks.
function buffaloNdfTargetByMilk(milkKg){
  const m = num(milkKg);

  if (m < 6) return 52;
  if (m < 7) return 47;
  if (m < 8) return 46;
  if (m < 9) return 44;
  if (m < 10) return 43;
  if (m < 11) return 42;
  if (m < 12) return 40;
  return 39;
}

function buffaloNscReferenceByMilk(milkKg){
  const m = num(milkKg);

  if (m < 6) return 25;
  if (m < 7) return 27;
  if (m < 8) return 28;
  if (m < 9) return 29;
  if (m < 11) return 30;
  if (m < 12) return 31;
  return 32;
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
const bw075 = Math.pow(bw, 0.75);

// SOURCE: PAUL_MANDAL_PATHAK_2002_LACTATING_RIVERINE_BUFFALO
// TDN kg/day = (35.3 × BW^0.75 + 406 × FCM6) / 1000
const tdnTargetKg =
  ((35.3 * bw075) + (406 * fcm6)) / 1000;

// SOURCE: PAUL_MANDAL_PATHAK_2002_LACTATING_RIVERINE_BUFFALO
// CP g/day = 5.43 × BW^0.75 + 90.3 × FCM6
const cpTargetG =
  (5.43 * bw075) + (90.3 * fcm6);

// SOURCE: PAUL_MANDAL_PATHAK_2002_LACTATING_RIVERINE_BUFFALO
// DCP g/day = 3.14 × BW^0.75 + 55.2 × FCM6
const dcpTargetG =
  (3.14 * bw075) + (55.2 * fcm6);

const ndfTarget = buffaloNdfTargetByMilk(milk);
const nscReferencePct = buffaloNscReferenceByMilk(milk);

// Lactating buffalo forage-NDF safety range
// 33–40% DM = comfort/safety range for rumen protection in Murabbik buffalo layer.
const forageNDFMin = 33;
const forageNDFComfort = 36.5;
const forageNDFMaxComfort = 40;

// Saturated fat support level observed in lactating buffalo study.
// This is not a fat target; fatLimit remains the safety ceiling.
const saturatedFatSupportPct = 2;

const pathakDmiKg =
  (0.02 * bw) + (milk / 3);

const concentrateKgDM =
  1.25 + (0.5 * milk);

const roughageKgDM =
  Math.max(0, pathakDmiKg - concentrateKgDM);

const roughageMin =
  pathakDmiKg > 0
    ? clamp((roughageKgDM / pathakDmiKg) * 100, 40, 75)
    : null;

return {
  species: 'buffalo',
  category: 'lactating',

buffaloRequirementModel: {
  model: 'MURABBIK_BUFFALO_ENGINE_V1',
  status: 'active',
  targetType: 'buffalo_lactating_requirements',
  note: 'Murabbik buffalo engine outputs final buffalo targets for ration evaluation.'
},
  bodyWeight: bw,
  dim: Number.isFinite(days) ? Math.round(days) : null,

  dmi: round(dmi),
  dmiTarget: round(dmi),

  nel: round(nelTotal),
  nelTarget: round(nelTotal),

  tdnTargetKg: round(tdnTargetKg, 2),

  mpTargetG: round(mpTargetG, 0),

  cpReferencePct: round(cpReferencePct),
  cpTarget: round(cpReferencePct),
  cpTargetG: round(cpTargetG, 0),
  dcpTargetG: round(dcpTargetG, 0),

  proteinSystem: 'MP',

ndfTarget,
nscReferencePct,

forageNDFMin,
forageNDFComfort,
forageNDFMaxComfort,

starchMax: 24,

fatMax: 7,
fatLimit: 7,
fatTarget: null,
saturatedFatSupportPct,

roughageMin: round(roughageMin)
};
}
function computeBuffaloDryFromCowBase(args = {}){
  const buffaloGestationLength = 308;
  const cowGestationLength = 280;

  const bw = num(args.bodyWeight);
  const bw075 = Math.pow(bw, 0.75);
  const breed = args.breed || '';

  const preg = clamp(num(args.pregDays), 0, buffaloGestationLength);

  const buffaloDaysPrepartum =
    preg > 0
      ? Math.max(0, buffaloGestationLength - preg)
      : null;

  const isCloseUp =
    !!args.closeUp ||
    (
      buffaloDaysPrepartum !== null &&
      buffaloDaysPrepartum < 30
    );

  const cowEquivalentPregDays =
    buffaloDaysPrepartum !== null
      ? clamp(cowGestationLength - buffaloDaysPrepartum, 0, cowGestationLength)
      : 0;

  const base = computeCowDryMother({
    ...args,
    pregDays: cowEquivalentPregDays,
    closeUp: isCloseUp,
    breed
  });

  const buffaloDmi =
    isCloseUp
      ? bw * 0.018
      : 0.068 * bw075;

  const buffaloMaintenanceNEL = nelMaintenanceMcal(bw);

  const buffaloMatureBW = getStandardWeight('جاموس', breed);

  const buffaloPregNEL =
    cowEquivalentPregDays > 0
      ? gestationConceptusNE(
          bw,
          cowEquivalentPregDays,
          null,
          buffaloMatureBW,
          false
        )
      : 0;

  const buffaloNEL =
    buffaloMaintenanceNEL + buffaloPregNEL;

  const mpTargetG = computeBuffaloOperationalMPTarget({
    bodyWeight: bw,
    milkKg: 0,
    proteinPct: 0,
    pregDays: preg,
    closeUp: isCloseUp,
    growth: false
  });

  const cpTarget = isCloseUp ? 14.0 : 10.5;
  const cpTargetG = buffaloDmi * (cpTarget / 100) * 1000;

  const ndfTarget = isCloseUp ? 52 : 60;
  const roughageMin = isCloseUp ? 55 : 60;
  const starchMax = isCloseUp ? 10 : 9;

  const stageLabel =
    isCloseUp
      ? 'close_up_buffalo'
      : 'dry_pregnant_buffalo';

  const buffaloStageModel = {
    model: 'MURABBIK_BUFFALO_STAGE_MODEL_V1',
    species: 'buffalo',
    category: stageLabel,
    status: 'active',
    gestationLengthDays: buffaloGestationLength,
    pregnancyDays: round(preg, 0),
    daysPrepartum:
      buffaloDaysPrepartum === null ? null : round(buffaloDaysPrepartum, 0),
    cowEquivalentPregnancyDays: round(cowEquivalentPregDays, 0),
    rule: 'Buffalo dry and close-up stage is determined using buffalo gestation length, then mapped to Murabbik dry/transition base structure.'
  };

  return {
    ...base,

    species: 'buffalo',
    category: stageLabel,
    chapter12StageModel: buffaloStageModel,

    buffaloRequirementModel: {
      model: 'MURABBIK_BUFFALO_DRY_CLOSEUP_LAYER_V1',
      status: 'active_documented_layer',
      baseEngine: base?.chapter12EnergyModel?.source || 'MURABBIK_COW_DRY_CLOSEUP_BASE',
      adjustmentStage: stageLabel,
      buffaloGestationLength,
      cowGestationLength,
      originalBuffaloPregnancyDays: round(preg, 0),
      buffaloDaysPrepartum:
        buffaloDaysPrepartum === null ? null : round(buffaloDaysPrepartum, 0),
      cowEquivalentPregnancyDays: round(cowEquivalentPregDays, 0),
      rule: 'Cow dry/transition engine remains the structured base; documented buffalo differences are applied to final Murabbik target fields only.',
      outputFields: [
        'dmi',
        'nel',
        'mpTargetG',
        'cpTarget',
        'cpTargetG',
        'ndfTarget',
        'roughageMin',
        'starchMax',
        'fatLimit'
      ],
      sources: [
        'BULBUL_2010_BUFFALO_DRY_PREGNANT_REQUIREMENTS',
        'FRANZOLIN_1994_BUFFALO_FORAGE_UTILIZATION'
      ]
    },

    baseCowCategory: base?.category || null,

    dmiModel: {
      model: 'MURABBIK_BUFFALO_DMI_DRY_CLOSEUP_LAYER_V1',
      status: 'active_documented_layer',
      species: 'buffalo',
      stage: stageLabel,
      basis: isCloseUp
        ? 'late_pregnancy_buffalo_DMI_from_BW_pct'
        : 'dry_buffalo_DMI_from_BW075',
      valueKgDay: round(buffaloDmi),
      note: 'Final DMI target is adjusted by buffalo dry/late-pregnancy layer and returned in Murabbik standard field dmi.'
    },

    energyModel: {
      model: 'MURABBIK_BUFFALO_ENERGY_DRY_CLOSEUP_LAYER_V1',
      status: 'active_layer_on_murabbik_energy_field',
      species: 'buffalo',
      stage: stageLabel,
      unit: 'NEL_Mcal_day',
      components: {
        maintenanceMcal: round(buffaloMaintenanceNEL),
        pregnancyMcal: round(buffaloPregNEL),
        lactationMcal: 0,
        growthMcal: 0
      },
      totalNELMcal: round(buffaloNEL),
      note: 'Final energy target remains in Murabbik standard field nel; no parallel ME/TDN output is exposed.'
    },

    proteinRequirementModel: {
      model: 'MURABBIK_BUFFALO_PROTEIN_DRY_CLOSEUP_LAYER_V1',
      status: 'active_documented_layer',
      species: 'buffalo',
      stage: stageLabel,
      targetType: 'MP_and_CP_reference',
      mpTargetG: round(mpTargetG, 0),
      cpTargetPct: round(cpTarget, 1),
      cpTargetG: round(cpTargetG, 0),
      note: 'Final protein targets are returned through Murabbik standard fields mpTargetG, cpTarget, and cpTargetG.'
    },

    dim: null,

    dmi: round(buffaloDmi),
    dmiTarget: round(buffaloDmi),

    nel: round(buffaloNEL),
    nelTarget: round(buffaloNEL),

    mpTargetG: round(mpTargetG, 0),

    cpReferencePct: round(cpTarget, 1),
    cpTarget: round(cpTarget, 1),
    cpTargetG: round(cpTargetG, 0),

    proteinSystem: 'MP_CP',

    ndfTarget,
    roughageMin,

    starchMax,

    fatTarget: null,
    fatLimit: 7,
    fatMax: 7,

    internalStatus: 'BUFFALO_DRY_CLOSEUP_LAYER_APPLIED'
  };
}
function computeBuffaloHeifer({ bodyWeight, pregDays, closeUp, breed, dietNDFPct }){
  const bw = num(bodyWeight);
const bw075 = Math.pow(bw, 0.75);

const nelMaintenance = 0.075 * bw075;
const nelGrowth = 0;
const nelPreg = (pregDays > 200 ? gestationConceptusNE(bw, pregDays) * 0.95 : 0) + (closeUp ? 0.8 : 0);
const nelTotal = nelMaintenance + nelPreg;

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
    dietNDFPct: ctx?.dietNDFPct,
    mineralDmi: ctx?.mineralDmi ?? ctx?.rationDmiKg ?? ctx?.actualDmiKg ?? ctx?.dmKg,
    frameGainKgDay: ctx?.frameGainKgDay ?? ctx?.frameGain ?? ctx?.targetFrameGainKgDay ?? ctx?.frmGainTarget
  };

  const sp = normArabic(species);
  const isBuffalo = (sp === 'جاموس' || sp === 'جاموسه' || sp === 'buffalo');

if (isBuffalo){
  if (category === 'lactating'){
    return computeBuffalo(common);
  }

  if (category === 'dry_pregnant' || category === 'close_up'){
    return computeBuffaloDryFromCowBase(common);
  }

  if (category === 'heifer'){
    return computeBuffaloHeifer(common);
  }

  return computeBuffalo(common);
}

if (category === 'dry_pregnant' || category === 'close_up'){
  return computeCowDryMother(common);
}

if (category === 'heifer'){
  return computeCowHeifer(common);
}

return computeCow(common);
}

module.exports = {
  computeTargets
};
