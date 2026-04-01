// مُرَبِّيك — Nutrition Engine (Unified)
// يعتمد على وزن قياسي حسب النوع والسلالة
// Cow = NASEM-lite (DMI/DIM curve + NEL)
// Buffalo = Cow base + Adjustment Layer
function resolveFeedingCategory(ctx){

  const milkKg   = Number(ctx?.avgMilkKg || 0);
  const pregDays = Number(ctx?.pregnancyDays || 0);
  const closeUp  = !!ctx?.closeUp;

  if (milkKg > 0) return 'lactating';

  if (closeUp) return 'close_up';

  if (pregDays > 0) return 'dry_pregnant';

  return 'heifer';
}
function computeTargets(ctx){

  const species  = String(ctx?.species || '').trim();
  const breed    = String(ctx?.breed || '').trim();
  const milkKg   = Number(ctx?.avgMilkKg || 0);
  const pregDays = Number(ctx?.pregnancyDays || 0);
  const closeUp  = !!ctx?.closeUp;
  const category = resolveFeedingCategory(ctx);
  // DIM (أيام الحليب) — مهم جدًا لتأثير مرحلة الإدرار على الاستهلاك
  const dim = Number(ctx?.daysInMilk ?? ctx?.dim ?? 0);

  const bodyWeight = getStandardWeight(species, breed);
if (category === 'heifer') {
  if (species === 'جاموس') {
    return computeBuffaloHeifer({
      bodyWeight,
      pregDays,
      closeUp,
      breed
    });
  }

 return computeCowHeiferNASEM({
    bodyWeight,
    pregDays,
    closeUp,
    breed
  });
}

if(species === 'جاموس'){
  return computeBuffalo({
    bodyWeight,
    milkKg,
    pregDays,
    closeUp,
    dim
  });
}

return computeCow({
  bodyWeight,
  milkKg,
  pregDays,
  closeUp,
  dim,
  breed
});
}


/* ============================= */
/*      STANDARD WEIGHT TABLE    */
/* ============================= */

function getStandardWeight(species, breed){

  const b = String(breed || '').trim();

if(
  species === 'جاموس' ||
  species === 'جاموسة' ||
  species === 'buffalo'
){
  if (b.includes('مصري')) return 600;
  if (b.includes('هجين') && (b.includes('ايطالي') || b.includes('إيطالي'))) return 700;
  if (b.includes('هجين') && b.includes('مورا')) return 750;
  if (b.includes('ايطالي') || b.includes('إيطالي')) return 720;
  if (b.includes('مورا')) return 800;
  if (b.includes('خليط')) return 650;
  return 650;
}

  // أبقار
  if(b.includes('هولشتاين')) return 650;
  if(b.includes('مونبليار') || b.includes('مونبيليار')) return 700; // ✅ ثنائي الغرض أثقل
  if(b.includes('فريزيان')) return 620;
  if(b.includes('سيمينتال')) return 720;
  if(b.includes('براون') || b.includes('سويس')) return 680;
  if(b.includes('جيرسي')) return 450;
  if(b.includes('خليط')) return 600;

  return 630;
}


/* ============================= */
/*          COW ENGINE           */
/* ============================= */


function isDualPurposeBreed(breed){
  const b = String(breed || '').trim().toLowerCase()
    .replace(/[أإآ]/g,'ا')
    .replace(/ة/g,'ه');
  return (
    b.includes('مونبليار') || b.includes('مونبيليار') || b.includes('montb') || b.includes('montbeli') ||
    b.includes('سيمينتال') || b.includes('simmental')
  );
}

function cowBreedFactors(breed){
  // افتراضات مُرَبِّيك الميدانية للسلالات ثنائية الغرض
  if(isDualPurposeBreed(breed)){
    return {
      cpBonusPct: 2.0,
      dmiFactor: 0.96,
      nelMilkFactor: 1.03,
      ndfTarget: 33,
      starchMax: 25
    };
  }

  // السلالات العادية
  return {
    cpBonusPct: 0.0,
    dmiFactor: 1.0,
    nelMilkFactor: 1.0,
    ndfTarget: 30,
    starchMax: 28
  };
}

function computeCow({ bodyWeight, milkKg, pregDays, closeUp, dim, breed }){
  const f = cowBreedFactors(breed);

  const bw = Number(bodyWeight || 0);
  const milk = Number(milkKg || 0);
  const days = Number(dim || 0);
  const bw075 = Math.pow(bw, 0.75);

  // 1) DMI — عملي ومحترم مرحليًا
  // أساس استهلاك + أثر DIM + ضبط بسيط للسلالة
  const baseDmi = (0.022 * bw) + (0.12 * milk);
  const wol = days > 0 ? (days / 7) : 0;
  const lactFactor = wol > 0 ? (1 - Math.exp(-0.22 * (wol + 2.5))) : 1;

  let dmi = baseDmi * lactFactor;

  // early lactation cap / mid-lactation ceiling
  const minDmi = Math.max(10, bw * 0.018);
  const maxDmi = (milk > 0) ? Math.max(bw * 0.040, 26) : (bw * 0.028);

  dmi = clamp(dmi * f.dmiFactor, minDmi, maxDmi);

  // 2) NEL requirement (still practical, but more defensible)
  // maintenance
  const nelMaintenance = 0.10 * bw075;

  // milk energy
  const nelMilk = (0.74 * milk) * f.nelMilkFactor;

  // pregnancy
  let nelPreg = 0;
  if (pregDays > 190) {
    nelPreg = 0.0038 * pregDays;
  }
  if (closeUp) {
    nelPreg += 2.3;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

  // 3) CP target — كمرجع فقط وليس أساس الحكم النهائي
  // نستخدمه كواجهة عامة initial reference
  let cpTarget = 14.0 + (0.07 * milk);
  cpTarget = clamp(cpTarget + f.cpBonusPct, 14.0, 18.5);

  // 4) MP target — نجعله أكثر تحفظًا ومنطقيًا من المعادلة القديمة
  // maintenance + milk + pregnancy adjustment
  let mpTargetG = (3.8 * bw075) + (43 * milk);
  if (pregDays > 190) mpTargetG += 80;
  if (closeUp) mpTargetG += 60;

  return {
    species: 'cow',
    bodyWeight: bw,
    dim: Number.isFinite(days) ? Math.round(days) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: round(cpTarget),
    mpTargetG: round(mpTargetG, 0),
    ndfTarget: milk >= 32 ? 30 : milk >= 22 ? 31 : 32,
    starchMax: milk >= 32 ? 28 : 26
  };
}
function resolveHeiferTargetGain(bodyWeight){
  const bw = Number(bodyWeight || 0);

  if (bw <= 250) return 0.80;
  if (bw <= 350) return 0.90;
  if (bw <= 450) return 0.85;
  return 0.75;
}

function estimateHeiferGrowthNEL(bodyWeight, species){
  const bw = Number(bodyWeight || 0);
  const adg = resolveHeiferTargetGain(bw);

  // معادلة تشغيلية متدرجة بدل رقم ثابت
  // أساس Cow heifer ثم نخفض قليلًا للجاموس
  let nelGrowth = 2.2 + (adg * 1.4) + (bw / 500);

  if (String(species || '').includes('جاموس')) {
    nelGrowth = nelGrowth * 0.95;
  }

  return round(nelGrowth);
}
function computeCowHeiferNASEM({ bodyWeight, pregDays, closeUp, breed }){

  const f = cowBreedFactors(breed);
  const bw075 = Math.pow(bodyWeight, 0.75);

  // صيانة
  const nelMaintenance = 0.08 * bw075;

  // نمو مبدئي عملي لعجلات الأبقار
  const nelGrowth = estimateHeiferGrowthNEL(bodyWeight, 'cow');

  // حمل
  let nelPreg = 0;
  if (pregDays > 190) {
    nelPreg = 0.00318 * pregDays;
  }
  if (closeUp) {
    nelPreg += 2.0;
  }

  const nelTotal = nelMaintenance + nelGrowth + nelPreg;

  // DMI تشغيلي لعجلات الأبقار
 let dmi = bodyWeight * (bodyWeight < 300 ? 0.024 : 0.022);
  dmi = dmi * f.dmiFactor;

  // CP دعم نمو
 let cpTarget = 15.0 + f.cpBonusPct;
cpTarget = clamp(cpTarget, 14.5, 17.0);

const mpTargetG = (3.6 * bw075) + 120;

return {
  species: 'cow',
  category: 'heifer',
  bodyWeight,
  dim: null,
  dmi: round(dmi),
  nel: round(nelTotal),
  cpTarget: round(cpTarget),
  mpTargetG: round(mpTargetG, 0),
  ndfTarget: 32,
  starchMax: 24
};
}

/* ============================= */
/*        BUFFALO ENGINE         */
/* ============================= */

function computeBuffalo({ bodyWeight, milkKg, pregDays, closeUp, dim }){
  const bw = Number(bodyWeight || 0);
  const milk = Number(milkKg || 0);
  const days = Number(dim || 0);
  const bw075 = Math.pow(bw, 0.75);

  // 1) DMI — أقل من الأبقار قليلًا لكن ليس بشكل مبالغ
  const baseDmi = (0.0215 * bw) + (0.115 * milk);
  const wol = days > 0 ? (days / 7) : 0;
  const lactFactor = wol > 0 ? (1 - Math.exp(-0.20 * (wol + 2.5))) : 1;

  let dmi = baseDmi * lactFactor;
  dmi = clamp(dmi, Math.max(9, bw * 0.0175), Math.max(24, bw * 0.036));

  // 2) NEL
  const nelMaintenance = 0.095 * bw075;
  const nelMilk = 0.90 * milk;

  let nelPreg = 0;
  if (pregDays > 200) {
    nelPreg = 0.0038 * pregDays;
  }
  if (closeUp) {
    nelPreg += 2.5;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

  // 3) CP reference only
  let cpTarget = 12.5 + (0.16 * milk);
  cpTarget = clamp(cpTarget, 12.5, 15.5);

  // 4) MP target — مرجع عملي
  let mpTargetG = (3.6 * bw075) + (40 * milk);
  if (pregDays > 200) mpTargetG += 80;
  if (closeUp) mpTargetG += 60;

  return {
    species: 'buffalo',
    bodyWeight: bw,
    dim: Number.isFinite(days) ? Math.round(days) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: round(cpTarget),
    mpTargetG: round(mpTargetG, 0),
    ndfTarget: 34,
    starchMax: 22,
    roughageMin: 50
  };
}
function computeBuffaloHeifer({ bodyWeight, pregDays, closeUp }){

  const bw075 = Math.pow(bodyWeight, 0.75);

  // صيانة
  const nelMaintenance = 0.075 * bw075;

  // نمو مبدئي لعجلات الجاموس
const nelGrowth = estimateHeiferGrowthNEL(bodyWeight, 'جاموس');

  // حمل
  let nelPreg = 0;
  if (pregDays > 200) {
    nelPreg = 0.0035 * pregDays;
  }
  if (closeUp) {
    nelPreg += 2.5;
  }

  const nelTotal = nelMaintenance + nelGrowth + nelPreg;

  // DMI أقل قليلًا من الأبقار
 const dmi = bodyWeight * (bodyWeight < 300 ? 0.023 : 0.021);

let cpTarget = 14.0;
cpTarget = clamp(cpTarget, 13.5, 15.0);

const mpTargetG = (3.5 * bw075) + 120;

return {
  species: 'buffalo',
  category: 'heifer',
  bodyWeight,
  dim: null,
  dmi: round(dmi),
  nel: round(nelTotal),
  cpTarget: round(cpTarget),
  mpTargetG: round(mpTargetG, 0),
  ndfTarget: 34,
  starchMax: 22,
  roughageMin: 50
};
}
/* ============================= */

function round(n, d = 2){
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
}

function clamp(x, a, b){
  x = Number(x);
  if(!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}
module.exports = {
  computeTargets
};
