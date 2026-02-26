// /js/engine-buffalo.js
// Buffalo Engine (Standalone) — Murabbik
// Standards:
// - DMI lactating = 3.2% BW
// - Milk fat default = 7%
// - BW default by buffalo breed:
//   Egyptian=580, Italian-Egyptian=700, Murrah=800 (range 700-900)

function bw075(bw){ return Math.pow(Math.max(1, bw), 0.75); }
function n(v, fb){ const x = Number(v); return Number.isFinite(x) ? x : fb; }
function s(v){ return String(v ?? '').trim(); }

function detectBuffBreed(ctx){
  const b = s(ctx?.buffBreed || ctx?.breed || ctx?.buffaloBreed).toLowerCase();
  if(!b) return 'egyptian';
  if(b.includes('ital') || b.includes('ايط') || b.includes('italian')) return 'italian_egyptian';
  if(b.includes('mur') || b.includes('مورا') || b.includes('murrah')) return 'murrah';
  if(b.includes('egy') || b.includes('مص')) return 'egyptian';
  return 'egyptian';
}

function defaultBWByBreed(breedKey){
  if(breedKey === 'italian_egyptian') return 700;
  if(breedKey === 'murrah') return 800;     // default داخل رينج 700–900
  return 580;                                // egyptian
}

function defaultMilkFat(){
  return 7.0;
}

// DMI standard: lactating = 3.2% BW
function computeDMIkg(ctx, BW){
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';

  if(stage === 'dry')     return 0.020 * BW; // ثابتة عملية للجاف
  if(stage === 'closeup') return 0.022 * BW; // تحضير ولادة
  return 0.032 * BW;                         // الحلاب (قياسي حسب طلبك)
}

// Milk energy (NEL) per kg milk based on fat% (protein/lactose fixed defaults)
function nelMilkPerKg(fatPct, proteinPct=4.5, lactosePct=4.8){
  const fat = Math.min(10, Math.max(3.5, n(fatPct, 7)));
  const prot = Math.min(5.5, Math.max(2.8, n(proteinPct, 4.5)));
  const lac  = Math.min(5.4, Math.max(3.8, n(lactosePct, 4.8)));
  return (0.0929*fat) + (0.0547*prot) + (0.0395*lac);
}

// Maintenance NEL
function nelMaintenance(BW){
  return 0.08 * bw075(BW);
}

// Pregnancy add-on (keep aligned with your page logic: gestLen 310 there)
function nelPregnancy(pregDays, gestLen=310){
  const d = n(pregDays, null);
  if(d == null) return 0;
  const daysToCalving = gestLen - d;
  if(daysToCalving > 90) return 0;
  if(daysToCalving <= 21) return 3.0;
  if(daysToCalving <= 45) return 2.0;
  if(daysToCalving <= 70) return 1.2;
  return 0.6;
}

// CP target ranges (buffalo practical)
function cpTargetRange(ctx){
  let stage = 'lactating';
  if(ctx?.earlyDry) stage = 'dry';
  if(ctx?.closeUp) stage = 'closeup';

  const milk = Math.max(0, n(ctx?.avgMilkKg, 0));
  if(stage === 'dry') return { cpMin: 12.0, cpMax: 13.5 };
  if(stage === 'closeup') return { cpMin: 13.0, cpMax: 14.5 };

  // Lactating buffalo
  if(milk >= 12) return { cpMin: 15.0, cpMax: 16.0 };
  return { cpMin: 14.0, cpMax: 15.0 };
}

export function computeBuffalo(ctx){
  const breedKey = detectBuffBreed(ctx);
  const BW = n(ctx?.bodyWeightKg, defaultBWByBreed(breedKey));
  const fatPct = n(ctx?.milkFatPct, defaultMilkFat());
  const milkKg = Math.max(0, n(ctx?.avgMilkKg, 0));
  const pregDays = n(ctx?.pregnancyDays, null);

  const dmiKg = computeDMIkg(ctx, BW);

  const nem = nelMaintenance(BW);
  const nMilkKg = nelMilkPerKg(fatPct);
  const nelMilk = nMilkKg * milkKg;
  const nelPreg = nelPregnancy(pregDays, 310);
  const nelTotal = nem + nelMilk + nelPreg;

  const cp = cpTargetRange(ctx);

  const alerts = [];
  if(breedKey === 'murrah'){
    alerts.push('ℹ️ موراه: الوزن القياسي داخل رينج 700–900 (الافتراضي 800). يمكنك تمرير BW من الإعدادات لو تحب.');
  }

  return {
    engine: 'buffalo-standards-v1',
    breedKey,
    inputs: { BW, fatPct, milkKg, dmiPct: (ctx?.earlyDry ? 2.0 : (ctx?.closeUp ? 2.2 : 3.2)) },
    dmiKg: Number(dmiKg.toFixed(2)),
    nel: {
      maintenance: Number(nem.toFixed(2)),
      milk: Number(nelMilk.toFixed(2)),
      pregnancy: Number(nelPreg.toFixed(2)),
      total: Number(nelTotal.toFixed(2)),
      milkPerKg: Number(nMilkKg.toFixed(3)),
    },
    cpTarget: cp,
    alerts
  };
}
