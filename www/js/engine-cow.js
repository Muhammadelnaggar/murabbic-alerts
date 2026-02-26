// /js/engine-cow.js
// Cow Engine (NASEM/NRC-style, practical v1) — Murabbik
// الهدف: Targets واضحة للمستخدم: DMI + NEL + CP (+ MP تقديري) + NDF + Fat
// ملاحظة: MP هنا "تقديري" من CP (قابل للتعديل لاحقًا) لأن MP الكامل يحتاج مدخلات إضافية (RUP/RDP/Digestibility).

function bw075(bw){ return Math.pow(Math.max(1, bw), 0.75); }
function n(v, fb){ const x = Number(v); return Number.isFinite(x) ? x : fb; }

// قيم DMI كنسبة من BW للأبقار الجافة (إرشادات عملية)
function computeDMIkg(ctx, BW){
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';

  // Dry: ~1.8% BW, Close-up: ~1.65% BW
  if(stage === 'dry')     return 0.018 * BW;
  if(stage === 'closeup') return 0.0165 * BW;

  // Lactating: احسب DMI من الاحتياج الطاقي / كثافة NEL المفترضة للعليقة
  const assumedDietNEL = Math.max(0.9, n(ctx?.assumedDietNelMcalPerKgDM, 1.60));
  const nelTotal = estimateNelTotal(ctx, BW);
  let dmi = nelTotal / assumedDietNEL;

  // حدود منطقية
  const minDmi = 0.020 * BW;
  const maxDmi = 0.040 * BW;
  if(!Number.isFinite(dmi)) dmi = 0.030 * BW;
  dmi = Math.max(minDmi, Math.min(maxDmi, dmi));
  return dmi;
}

// NEL/kg milk حسب fat% (مع قيم افتراضية لباقي المكونات)
function nelMilkPerKg(fatPct, proteinPct=3.2, lactosePct=4.8){
  const fat = Math.min(6.0, Math.max(3.2, n(fatPct, 3.8)));
  const prot = Math.min(4.5, Math.max(2.8, n(proteinPct, 3.2)));
  const lac  = Math.min(5.4, Math.max(3.8, n(lactosePct, 4.8)));
  return (0.0929*fat) + (0.0547*prot) + (0.0395*lac);
}

// Maintenance NEL (NASEM 2021-style)
function nelMaintenance(BW){
  // 0.10 Mcal per kg metabolic BW (BW^0.75)
  return 0.10 * bw075(BW);
}

// Pregnancy add-on (خطوات عملية — تتوافق مع منطق صفحتك: gestLen 280 للأبقار)
function nelPregnancy(pregDays, gestLen=280){
  const d = n(pregDays, null);
  if(d == null) return 0;
  const daysToCalving = gestLen - d;
  if(daysToCalving > 90) return 0;
  if(daysToCalving <= 21) return 2.8;
  if(daysToCalving <= 45) return 1.8;
  if(daysToCalving <= 70) return 1.0;
  return 0.5;
}

function estimateNelTotal(ctx, BW){
  const fatPct = n(ctx?.milkFatPct, 3.8);
  const milkKg = Math.max(0, n(ctx?.avgMilkKg, 0));
  const pregDays = n(ctx?.pregnancyDays, null);

  const nem = nelMaintenance(BW);
  const nMilkKg = nelMilkPerKg(fatPct);
  const nelMilk = nMilkKg * milkKg;
  const nelPreg = nelPregnancy(pregDays, 280);
  return nem + nelMilk + nelPreg;
}

function cpTargetRange(ctx){
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';

  const milk = Math.max(0, n(ctx?.avgMilkKg, 0));
  if(stage === 'dry') return { cpMin: 12.0, cpMax: 13.0 };
  if(stage === 'closeup') return { cpMin: 13.0, cpMax: 15.0 };

  // Lactating cow (إرشادي)
  if(milk >= 35) return { cpMin: 17.0, cpMax: 18.5 };
  if(milk >= 25) return { cpMin: 16.0, cpMax: 17.5 };
  return { cpMin: 15.0, cpMax: 16.5 };
}

function ndfTargetRange(ctx){
  // إرشادي: حد أدنى NDF أعلى في الجاف
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';
  if(stage === 'dry') return { ndfMin: 38, ndfMax: 50 };
  if(stage === 'closeup') return { ndfMin: 32, ndfMax: 42 };
  return { ndfMin: 28, ndfMax: 38 };
}

function fatTargetRange(ctx){
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';
  if(stage !== 'lactating') return { fatMin: 2.0, fatMax: 4.0 };
  return { fatMin: 2.5, fatMax: 6.0 };
}

export function computeCow(ctx){
  // BW الافتراضي: لو لم يُمرر من الحيوان
  const BW = n(ctx?.bodyWeightKg, 620);
  const fatPct = n(ctx?.milkFatPct, 3.8);
  const milkKg = Math.max(0, n(ctx?.avgMilkKg, 0));
  const pregDays = n(ctx?.pregnancyDays, null);

  const dmiKg = computeDMIkg(ctx, BW);

  const nem = nelMaintenance(BW);
  const milkPerKg = nelMilkPerKg(fatPct);
  const nelMilk = milkPerKg * milkKg;
  const nelPreg = nelPregnancy(pregDays, 280);
  const nelTotal = nem + nelMilk + nelPreg;

  const cp = cpTargetRange(ctx);
  const ndf = ndfTargetRange(ctx);
  const fat = fatTargetRange(ctx);

  // MP تقديري (اختياري) من CP + DMI
  // افتراض تحويل CP إلى MP بمعامل 0.64 (قابل للتعديل لاحقًا)
  const cpMid = (cp.cpMin + cp.cpMax) / 2;
  const cpKgPerDay = (cpMid/100) * dmiKg;
  const mpEstGPerDay = cpKgPerDay * 1000 * 0.64;

  const alerts = [];
  if(!Number.isFinite(ctx?.assumedDietNelMcalPerKgDM)){
    alerts.push('ℹ️ تم حساب DMI للحلاب من NEL ÷ (NEL كثافة العليقة الافتراضية 1.60). لو عايز دقة أعلى: هنخليها تتاخد من قيم العليقة الفعلية.');
  }
  alerts.push('ℹ️ MP هنا تقديري من CP (قابل للتطوير لاحقًا إلى MP كامل).');

  return {
    engine: 'cow-nasem2021-practical-v1',
    inputs: {
      BW,
      fatPct,
      milkKg,
      dmiKg: Number(dmiKg.toFixed(2)),
      assumedDietNEL: Number(Math.max(0.9, n(ctx?.assumedDietNelMcalPerKgDM, 1.60)).toFixed(2))
    },
    dmiKg: Number(dmiKg.toFixed(2)),
    nel: {
      maintenance: Number(nem.toFixed(2)),
      milk: Number(nelMilk.toFixed(2)),
      pregnancy: Number(nelPreg.toFixed(2)),
      total: Number(nelTotal.toFixed(2)),
      milkPerKg: Number(milkPerKg.toFixed(3)),
    },
    cpTarget: cp,
    mpEstGPerDay: Number(mpEstGPerDay.toFixed(0)),
    ndfTarget: ndf,
    fatTarget: fat,
    alerts
  };
}
