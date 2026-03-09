function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, d=2){
  const p = 10 ** d;
  return Math.round((Number(v) || 0) * p) / p;
}
function estimateRumenSync(starchPct, cpPct){

  const starch = num(starchPct);
  const cp = num(cpPct);

  const rdp = cp * 0.65;

  const syncIndex = rdp > 0 ? starch / rdp : 0;

  let status = "good";
  let note = "تزامن جيد بين الطاقة والبروتين في الكرش";

  if (syncIndex > 1.6){
    status = "warn";
    note = "النشا مرتفع مقارنة بالبروتين المتحلل";
  }

  if (syncIndex < 0.8){
    status = "warn";
    note = "البروتين المتحلل مرتفع مقارنة بالطاقة";
  }

  return {
    syncIndex: round(syncIndex),
    status,
    note
  };
}
function analyzeRation(rows){
  const list = Array.isArray(rows) ? rows : [];

  let asFedKg = 0;
  let dmKg = 0;
  let cpKg = 0;
  let nelMcal = 0;
  let ndfKg = 0;
  let fatKg = 0;
  let starchKg = 0;

  let forageDmKg = 0;
  let concDmKg = 0;

  for (const r of list){
    const kg   = num(r.kg ?? r.asFedKg);
    const dm   = num(r.dm ?? r.dmPct);
    const cp   = num(r.cp ?? r.cpPct);
    const nel  = num(r.nel);
    const ndf  = num(r.ndf);
    const fat  = num(r.fat);
    const starch = num(r.starchPct ?? r.starch);
    const cat  = String(r.cat || '').trim();

    const dmItemKg = kg * (dm / 100);

    asFedKg += kg;
    dmKg += dmItemKg;
    cpKg += dmItemKg * (cp / 100);
    nelMcal += dmItemKg * nel;
    ndfKg += dmItemKg * (ndf / 100);
    fatKg += dmItemKg * (fat / 100);
    starchKg += dmItemKg * (starch / 100);
    if (cat === 'rough') forageDmKg += dmItemKg;
    if (cat === 'conc')  concDmKg += dmItemKg;
  }

  const cpPctTotal   = dmKg > 0 ? (cpKg / dmKg) * 100 : 0;
  const nelActual    = dmKg > 0 ? (nelMcal / dmKg) : 0;
  const ndfPctActual = dmKg > 0 ? (ndfKg / dmKg) * 100 : 0;
  const fatPctActual = dmKg > 0 ? (fatKg / dmKg) * 100 : 0;
  const starchPct = dmKg > 0 ? (starchKg / dmKg) * 100 : 0;
  const rumenSync = estimateRumenSync(starchPct, cpPctTotal);
  const fcRatio      = concDmKg > 0 ? (forageDmKg / concDmKg) : null;

  return {
    totals: {
      asFedKg: round(asFedKg),
      dmKg: round(dmKg),
      cpKg: round(cpKg),
      nelMcal: round(nelMcal),
      ndfKg: round(ndfKg),
      fatKg: round(fatKg),
      forageDmKg: round(forageDmKg),
      concDmKg: round(concDmKg)
    },
   nutrition: {
  cpPctTotal: round(cpPctTotal),
  nelActual: round(nelActual),
  ndfPctActual: round(ndfPctActual),
  fatPctActual: round(fatPctActual),
  starchPct: round(starchPct),
  fcRatio: fcRatio == null ? null : round(fcRatio),
  rumenSync
}
  };
}

module.exports = {
  analyzeRation
};
