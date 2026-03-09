// مُرَبِّيك — Nutrition Engine (Unified)
// يعتمد على وزن قياسي حسب النوع والسلالة
// Cow = NASEM-lite (DMI/DIM curve + NEL)
// Buffalo = Cow base + Adjustment Layer

function computeTargets(ctx){

  const species  = String(ctx?.species || '').trim();
  const breed    = String(ctx?.breed || '').trim();
  const milkKg   = Number(ctx?.avgMilkKg || 0);
  const pregDays = Number(ctx?.pregnancyDays || 0);
  const closeUp  = !!ctx?.closeUp;

  // DIM (أيام الحليب) — مهم جدًا لتأثير مرحلة الإدرار على الاستهلاك
  const dim = Number(ctx?.daysInMilk ?? ctx?.dim ?? 0);

  const bodyWeight = getStandardWeight(species, breed);

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

  // 1) DMI (NASEM-lite)
  // Base practical intake (field-robust)
  const baseDmi = (0.025 * bodyWeight) + (0.10 * milkKg);

  // DIM / lactation stage curve (Weeks of Lactation)
  const wol = Number.isFinite(dim) && dim > 0 ? (dim / 7) : 0;
  const lactFactor = 1 - Math.exp(-0.192 * (wol + 3.67)); // 0→1 smoothly

  const f = cowBreedFactors(breed);

  let dmi = baseDmi * (wol ? lactFactor : 1);
  dmi = dmi * f.dmiFactor;

  // 2) NEL Requirement (Mcal/day) — lite
  const bw075 = Math.pow(bodyWeight, 0.75);
  const nelMaintenance = 0.08 * bw075;
  const nelMilk = (0.74 * milkKg) * f.nelMilkFactor;

  let nelPreg = 0;
  if(pregDays > 190){
    nelPreg = 0.00318 * pregDays;
  }
  if(closeUp){
    nelPreg += 2.0;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

  // 3) CP target (dynamic, user-facing)
  let cpTarget = clamp(13 + (0.10 * milkKg), 13, 18);
 cpTarget = clamp(cpTarget + f.cpBonusPct, 13, 20);;

  return {
    species: 'cow',
    bodyWeight,
    dim: Number.isFinite(dim) ? Math.round(dim) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: round(cpTarget),
    ndfTarget: f.ndfTarget,
starchMax: f.starchMax
  };
}


/* ============================= */
/*        BUFFALO ENGINE         */
/* ============================= */

function computeBuffalo({ bodyWeight, milkKg, pregDays, closeUp, dim }){

  // Buffalo adjustment layer (قابل للضبط لاحقًا)
  const baseDmiCow = (0.025 * bodyWeight) + (0.10 * milkKg);
  const wol = Number.isFinite(dim) && dim > 0 ? (dim / 7) : 0;
  const lactFactor = 1 - Math.exp(-0.192 * (wol + 3.67));
  const baseDmi = baseDmiCow * (wol ? lactFactor : 1);

  // Buffalo DM intake أقل ~5%
  const dmi = baseDmi * 0.95;

  const bw075 = Math.pow(bodyWeight, 0.75);
  const nelMaintenance = 0.075 * bw075;
  const nelMilk = 1.0 * milkKg;

  let nelPreg = 0;
  if(pregDays > 200){
    nelPreg = 0.0035 * pregDays;
  }
  if(closeUp){
    nelPreg += 2.5;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

 let cpTarget = 12 + (0.18 * milkKg);
cpTarget = clamp(cpTarget, 12, 15);

  return {
    species: 'buffalo',
    bodyWeight,
    dim: Number.isFinite(dim) ? Math.round(dim) : null,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: round(cpTarget),
    ndfTarget: 34,
    starchMax: 26,
    roughageMin: 50
  };
}


/* ============================= */

function round(n){
  return Math.round(n * 100) / 100;
}

function clamp(x, a, b){
  x = Number(x);
  if(!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}
module.exports = {
  computeTargets
};
