// /js/nutrition.js
import { initEventPage, Q } from '/js/events-core.js';
import { onNutritionPrefill, onNutritionSave } from '/js/track-nutrition.js';

// helpers to read UI values (لا نعيد الحسابات هنا — بنقرا فقط من الـDOM)
function readRows() {
  const rows = [];
  document.querySelectorAll('#tbl tbody tr').forEach(tr=>{
    const name = tr.querySelector('.name')?.value?.trim();
    if (!name) return;
    rows.push({
      name,
      cat  : (tr.querySelector('.cat')?.value)||'conc',
      dm   : parseFloat(tr.querySelector('.dm')?.value||0) || 0,
      price: parseFloat(tr.querySelector('.pTon')?.value||0) || 0,
      kg   : parseFloat(tr.querySelector('.kg')?.value||0) || 0,
      pct  : parseFloat(tr.querySelector('.pct')?.value||0) || 0,
    });
  });
  return rows;
}

function readKPIs() {
  const txt = id => document.getElementById(id)?.textContent || '—';
  return {
    mixPriceDM: txt('mixPriceDM'),
    totDM     : txt('totDM'),
    totCost   : txt('totCost'),
    split: {
      roughDM      : txt('roughDM'),
      roughCost    : txt('roughCost'),
      concDMpct    : txt('concDMpct'),
      concPriceDM  : txt('concPriceDM'),
      concKgAf     : document.getElementById('concKgInput')?.value || '',
      concKgDM     : txt('concKgDM'),
      concCost     : txt('concCost'),
      totalCostAll : txt('totalCostAll'),
    }
  };
}

function readContext() {
  const v = id => document.getElementById(id)?.value;
  const b = id => !!document.getElementById(id)?.checked;
  const species = v('ctxSpecies') || null;
  const dccVal  = v('ctxDCC') ? parseInt(v('ctxDCC')) : null;
  const gestLen = (species==='جاموس' ? 310 : 280);
  return {
    group          : new URLSearchParams(location.search).get('group') || null,
    species        : species || null,
    daysInMilk     : v('ctxDIM') ? parseInt(v('ctxDIM')) : null,
    avgMilkKg      : v('ctxAvgMilk') ? parseFloat(v('ctxAvgMilk')) : null,
    earlyDry       : b('ctxEarlyDry'),
    closeUp        : b('ctxCloseUp'),
    pregnancyStatus: v('ctxPreg') || null,
    pregnancyDays  : dccVal,
    daysToCalving  : (dccVal!=null ? (gestLen - dccVal) : null)
  };
}

initEventPage({
  eventType  : 'تغذية',
  formSelector: '#nutritionForm, form[data-event="nutrition"], form',
  // لا نحتاج dateSel لأن التاريخ يأتي من الـCTX (URL/localStorage)
  onPrefill: (ctx) => onNutritionPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) }),
  buildDetails: () => ({
    nutritionMode   : document.getElementById('mode')?.value || 'tmr_asfed',
    nutritionRows   : readRows(),
    nutritionKPIs   : readKPIs(),
    nutritionContext: readContext(),
    sourcePage      : 'nutrition.html'
  }),
  onSaved: ({ payload, mode }) => {
    const rowsLen = Array.isArray(payload?.nutritionRows) ? payload.nutritionRows.length : 0;
    onNutritionSave({ animalId: payload.animalId, date: payload.eventDate, rows: rowsLen, mode, source: payload.source });
    // إشعار داخلي يمكن لصفحتك التقاطه لإظهار ✅
    document.dispatchEvent(new CustomEvent('nutrition:saved-ui', { detail:{ ok:true, rows: rowsLen, mode } }));
  }
});
