// /js/nutrition.js
import { initEventPage, Q } from '/js/events-core.js';
import { track } from '/js/track-core.js';

// رسالة مدمجة داخل الصفحة (تستخدم #inlineMsg الموجود في HTML)
function showInlineNotice(message){
  const box = document.getElementById('inlineMsg');
  const text = box?.querySelector('.text');
  const yes  = box?.querySelector('#msgYes');
  const no   = box?.querySelector('#msgNo');
  if (!box || !text || !yes || !no) return Promise.resolve(false);

  text.textContent = message;
  box.style.display = 'block';

  return new Promise(resolve=>{
    const onYes = ()=>{ cleanup(); resolve(true); };
    const onNo  = ()=>{ cleanup(); resolve(false); };
    yes.addEventListener('click', onYes, { once:true });
    no .addEventListener('click', onNo , { once:true });
    function cleanup(){ box.style.display='none'; }
  });
}

initEventPage({
  eventType: 'تغذية',
  formSelector: 'form[data-event="nutrition"], #nutritionForm, form',
  dateSel: ['#eventDate','[name="eventDate"]'],
  onPrefill: (ctx) => track('nutrition_prefill', { animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) }),

  buildDetails: () => ({
    mode: (document.getElementById('mode')?.value || 'TMR').toUpperCase(),
    rationName: document.getElementById('rationName')?.value?.trim()
                || document.querySelector('[name="dietName"]')?.value?.trim()
                || undefined,
    dmiKg: parseFloat(document.getElementById('dmi')?.value
           || document.getElementById('dmiKg')?.value || '') || undefined,
    milkKgPerDay: parseFloat(document.getElementById('milkKg')?.value
                 || document.getElementById('milkKgPerDay')?.value || '') || undefined,
    milkPricePerKg: parseFloat(document.getElementById('milkPrice')?.value
                  || document.getElementById('milkPricePerKg')?.value || '') || undefined,
    feedCostPerHeadPerDay: parseFloat(document.getElementById('feedCost')?.value
                           || document.getElementById('feedCostPerHead')?.value || '') || undefined,
    costPerKgMilk: parseFloat(document.getElementById('costPerKgMilk')?.value || '') || undefined,
    asFedPct: document.getElementById('asFedPct')?.value || undefined,
    foragePct: document.getElementById('foragePct')?.value || undefined,
    concentratePct: document.getElementById('concentratePct')?.value || undefined,
    notes: document.getElementById('notes')?.value?.trim()
           || document.querySelector('[name="notes"]')?.value?.trim() || undefined,
  }),

  // لا تحويل تلقائي — هنقرر حسب اختيارك
  redirectTo: false,

  onSaved: async ({ payload, mode }) => {
    try { track('nutrition_save', { animalId: payload.animalId, date: payload.eventDate, mode, source: payload.source, modeName: payload?.details?.mode }); } catch(e){}
    const again = await showInlineNotice(`✅ تم حفظ تركيبة التغذية للحيوان ${payload.animalId}`);
    if (!again) location.href = 'dashboard.html';
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
