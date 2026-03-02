// مُرَبِّيك — Nutrition Engine (Unified)
// يعتمد على وزن قياسي حسب النوع والسلالة
// Cow = NASEM 2021
// Buffalo = Cow base + Adjustment Layer

export function computeTargets(ctx){

  const species = String(ctx?.species || '').trim();
  const breed   = String(ctx?.breed || '').trim();
  const milkKg  = Number(ctx?.avgMilkKg || 0);
  const pregDays = Number(ctx?.pregnancyDays || 0);
  const closeUp = !!ctx?.closeUp;

  const bodyWeight = getStandardWeight(species, breed);

  if(species === 'جاموس'){
    return computeBuffalo({
      bodyWeight,
      milkKg,
      pregDays,
      closeUp
    });
  }

  return computeCow({
    bodyWeight,
    milkKg,
    pregDays,
    closeUp
  });
}


/* ============================= */
/*      STANDARD WEIGHT TABLE    */
/* ============================= */

function getStandardWeight(species, breed){

  if(species === 'جاموس'){
    if(breed.includes('مصري')) return 550;
    if(breed.includes('خليط')) return 520;
    return 540;
  }

  // أبقار
  if(breed.includes('هولشتاين')) return 650;
  if(breed.includes('مونبليار')) return 650;
  if(breed.includes('فريزيان')) return 620;
  if(breed.includes('خليط')) return 600;

  return 630;
}


/* ============================= */
/*          COW ENGINE           */
/* ============================= */

function computeCow({ bodyWeight, milkKg, pregDays, closeUp }){

  // DMI (NASEM approximation)
  const dmi = (0.372 * milkKg) + (0.0968 * Math.pow(bodyWeight, 0.75));

  // NEL Requirement (Mcal/day)
  const nelMaintenance = 0.08 * Math.pow(bodyWeight, 0.75);
  const nelMilk = 0.74 * milkKg;

  let nelPreg = 0;
  if(pregDays > 190){
    nelPreg = 0.00318 * pregDays;
  }

  if(closeUp){
    nelPreg += 2.0;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

  return {
    species: 'cow',
    bodyWeight,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: 16,
    ndfTarget: 30,
    starchMax: 26
  };
}


/* ============================= */
/*        BUFFALO ENGINE         */
/* ============================= */

function computeBuffalo({ bodyWeight, milkKg, pregDays, closeUp }){

  // Buffalo DM intake أقل 5%
  const baseDmi = (0.372 * milkKg) + (0.0968 * Math.pow(bodyWeight, 0.75));
  const dmi = baseDmi * 0.95;

  const nelMaintenance = 0.075 * Math.pow(bodyWeight, 0.75);
  const nelMilk = 0.80 * milkKg;

  let nelPreg = 0;
  if(pregDays > 200){
    nelPreg = 0.0035 * pregDays;
  }

  if(closeUp){
    nelPreg += 2.5;
  }

  const nelTotal = nelMaintenance + nelMilk + nelPreg;

  return {
    species: 'buffalo',
    bodyWeight,
    dmi: round(dmi),
    nel: round(nelTotal),
    cpTarget: 15,
    ndfTarget: 32,
    starchMax: 24
  };
}


/* ============================= */

function round(n){
  return Math.round(n * 100) / 100;
}
