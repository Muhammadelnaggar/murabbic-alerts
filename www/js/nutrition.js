// مُرَبِّيك — صفحة التغذية (Cloud-only)
// ✅ لا LocalStorage / لا API
// ✅ تحميل سياق الحيوان/المجموعة من Firestore فقط
// ✅ حفظ حدث التغذية إلى Firestore فقط (events)

import { onNutritionSave } from '/js/track-nutrition.js';
const NUTRITION_BUILD_ID = 'nutrition-2026-03-05-B';

let targetsCache = null;
let targetsCacheKey = '';
let currentWeatherTHI = null;
let currentWeatherTempC = null;
let currentWeatherHumidity = null;
let weatherThiLoadedAt = 0;

async function getDeviceWeatherPath(){
  let path = '/api/weather/thi';

  try {
    if (navigator.geolocation) {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 6000,
          maximumAge: 10 * 60 * 1000
        });
      });

      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      path = `/api/weather/thi?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    }
  } catch (_) {}

  return path;
}

async function loadNutritionWeatherTHI(){
  const now = Date.now();

  if (currentWeatherTHI != null && (now - weatherThiLoadedAt) < 5 * 60 * 1000) {
    return currentWeatherTHI;
  }

  try {
    const API_BASE = window.API_BASE || '';
    const path = await getDeviceWeatherPath();

    const res = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store'
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    const thi = Number(data.thi);
    const tempC = Number(data.tempC);
    const humidity = Number(data.humidity);

    currentWeatherTHI = Number.isFinite(thi) ? thi : null;
    currentWeatherTempC = Number.isFinite(tempC) ? tempC : null;
    currentWeatherHumidity = Number.isFinite(humidity) ? humidity : null;
    weatherThiLoadedAt = now;

    window.mbkNutrition = window.mbkNutrition || {};
    window.mbkNutrition.weather = {
      thi: currentWeatherTHI,
      tempC: currentWeatherTempC,
      humidity: currentWeatherHumidity,
      status: data.status || null,
      source: data.source || 'api-weather-thi',
      updatedAt: data.updatedAt || null
    };

    return currentWeatherTHI;
  } catch (e) {
    console.warn('nutrition weather THI failed:', e.message || e);
    return currentWeatherTHI;
  }
}
function isDryNutritionContext(ctx = null){
  const c = ctx || {};
  const earlyDry =
    !!c.earlyDry ||
    !!document.getElementById('ctxEarlyDry')?.checked;

  const closeUp =
    !!c.closeUp ||
    !!document.getElementById('ctxCloseUp')?.checked;

  const pregText = String(
    c.pregnancyStatus ||
    document.getElementById('ctxPreg')?.value ||
    ''
  ).trim().toLowerCase();

  return (
    earlyDry ||
    closeUp ||
    pregText.includes('جاف') ||
    pregText.includes('dry') ||
    pregText.includes('تحضير') ||
    pregText.includes('انتظار الولادة') ||
    pregText.includes('close')
  );
}

function applyDryMilkVisibility(){
  const earlyDry = !!document.getElementById('ctxEarlyDry')?.checked;
  const closeUp  = !!document.getElementById('ctxCloseUp')?.checked;

  const pregText = String(document.getElementById('ctxPreg')?.value || '')
    .trim()
    .toLowerCase();

  const isDry =
    earlyDry ||
    closeUp ||
    pregText.includes('جاف') ||
    pregText.includes('dry') ||
    pregText.includes('تحضير') ||
    pregText.includes('انتظار الولادة') ||
    pregText.includes('close');

  [
    'ctxAvgMilk_txt',
    'ctxMilkFat_txt',
    'ctxMilkProtein_txt',
    'ctxMilkPrice_txt'
  ].forEach(id => {
    const el = document.getElementById(id);
    const item = el?.closest?.('.strip-item');
    if (item) item.style.display = isDry ? 'none' : '';
  });

  const milkInputsCard =
    document.getElementById('milkInputsCard') ||
    document.querySelector('.milk-inline-row')?.closest?.('.mbk-card') ||
    document.querySelector('.milk-inline-row')?.closest?.('.card') ||
    document.querySelector('.milk-inline-row');

  if (milkInputsCard) {
    milkInputsCard.style.display = isDry ? 'none' : '';
  }

  const avg = document.getElementById('ctxAvgMilk');
  const fat = document.getElementById('ctxMilkFat');
  const protein = document.getElementById('ctxMilkProtein');
  const price = document.getElementById('ctxMilkPrice');

  if (isDry) {
    if (avg) avg.value = '0';
    if (fat) fat.value = '';
    if (protein) protein.value = '';
    if (price) price.value = '';
  }

  ['milkFatInput', 'milkProteinInput', 'milkPriceInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    el.required = !isDry;
    el.disabled = isDry;

    if (isDry) el.value = '';
  });
}
function getFrameGainKgDayInput(){
  const fromWindow =
    window.mbkNutrition?.testFrameGainKgDay ??
    window.mbkNutrition?.frameGainKgDay ??
    null;

  const fromDom =
    document.getElementById('ctxFrameGainKgDay')?.value ??
    document.getElementById('ctxFrameGain')?.value ??
    null;

  const p = qp();
  const fromUrl =
    p.get('frameGainKgDay') ||
    p.get('frameGain') ||
    p.get('targetFrameGainKgDay') ||
    p.get('frmGainTarget');

  const n = Number(fromWindow ?? fromDom ?? fromUrl);

  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildNutritionContextForRequest(){
  const ctx = readContext();

  return {
    ...ctx,
    frameGainKgDay:
      Number.isFinite(Number(ctx?.frameGainKgDay)) && Number(ctx.frameGainKgDay) > 0
        ? Number(ctx.frameGainKgDay)
        : getFrameGainKgDayInput()
  };
}
async function fetchTargets(ctx) {
const _ctxRaw = ctx || buildNutritionContextForRequest();
const _isDry = isDryNutritionContext(_ctxRaw);
const _ctx = _isDry
  ? {
      ..._ctxRaw,
      avgMilkKg: 0,
      milkFatPct: null,
      milkProteinPct: null,
      milkPrice: null
    }
  : _ctxRaw;

const payload = {
  context: {
    species: _ctx?.species,
    breed: _ctx?.breed || window.currentAnimal?.breed || null,
    bodyWeight: _ctx?.bodyWeight,
    bcs: _ctx?.bcs,
parity: _ctx?.parity,
frameGainKgDay: _ctx?.frameGainKgDay,
dietNDFPct: _ctx?.dietNDFPct,
daysInMilk: _ctx?.daysInMilk,
avgMilkKg: _ctx?.avgMilkKg,
pregnancyDays: _ctx?.pregnancyDays,
pregnancyStatus: _ctx?.pregnancyStatus,
daysToCalving: _ctx?.daysToCalving,
earlyDry: _ctx?.earlyDry,
closeUp: _ctx?.closeUp,
milkFatPct: _ctx?.milkFatPct,
milkProteinPct: _ctx?.milkProteinPct,
milkPrice: _ctx?.milkPrice,
thi: _ctx?.thi
  }
};

  const { auth } = await import('/js/firebase-config.js');
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new Error('NO_AUTH');

  const API_BASE = window.API_BASE || '';
  const res = await fetch(`${API_BASE}/api/nutrition/targets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': uid
    },
    body: JSON.stringify(payload)
  });

 const rawText = await res.text().catch(() => '');
let data = {};
try { data = rawText ? JSON.parse(rawText) : {}; } catch {}

if (!res.ok || data?.ok === false) {
  console.error('nutrition/targets failed:', {
    status: res.status,
    responseText: rawText,
    payload
  });
  throw new Error(data?.error || rawText || `HTTP ${res.status}`);
}

  targetsCache = data.targets || null;
  return targetsCache;
}

async function refreshTargets() {
  await loadNutritionWeatherTHI();
  const ctx = buildNutritionContextForRequest();
  const key = JSON.stringify({
  species: ctx?.species || '',
  breed: ctx?.breed || window.currentAnimal?.breed || '',
  bodyWeight: ctx?.bodyWeight ?? '',
  bcs: ctx?.bcs ?? '',
  parity: ctx?.parity ?? '',
  frameGainKgDay: ctx?.frameGainKgDay ?? '',
  dietNDFPct: ctx?.dietNDFPct ?? '',
  daysInMilk: ctx?.daysInMilk ?? '',
  avgMilkKg: ctx?.avgMilkKg ?? '',
  pregnancyDays: ctx?.pregnancyDays ?? '',
  pregnancyStatus: ctx?.pregnancyStatus || '',
  daysToCalving: ctx?.daysToCalving ?? '',
  earlyDry: !!ctx?.earlyDry,
  closeUp: !!ctx?.closeUp,
  milkFatPct: ctx?.milkFatPct ?? '',
  milkProteinPct: ctx?.milkProteinPct ?? '',
  milkPrice: ctx?.milkPrice ?? '',
  thi: ctx?.thi ?? ''
});

  if (key === targetsCacheKey && targetsCache) {
    return targetsCache;
  }

  targetsCacheKey = key;
  const out = await fetchTargets(ctx);
window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.targets = out || null;
return out;
}

let rationAnalysisCache = null;
let rationAnalysisCacheKey = '';

async function fetchRationAnalysis(rows) {
  await loadNutritionWeatherTHI();
  const list = Array.isArray(rows) ? rows : [];
  const ctx = buildNutritionContextForRequest();
  if (!list.length) {
    rationAnalysisCache = null;
    return null;
  }

  const { auth } = await import('/js/firebase-config.js');
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new Error('NO_AUTH');

  const API_BASE = window.API_BASE || '';
  const res = await fetch(`${API_BASE}/api/nutrition/analyze-ration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': uid
    },
  body: JSON.stringify({
  mode: document.getElementById('mode')?.value || 'tmr_asfed',
  rows: list,
  concKg: parseUiNumber(document.getElementById('concKgInput')?.value || null),
  milkPrice: isDryNutritionContext(ctx)
    ? null
    : parseUiNumber(document.getElementById('ctxMilkPrice')?.value || null),
  context: {
    ...ctx,
    frameGainKgDay:
      Number.isFinite(Number(ctx?.frameGainKgDay)) && Number(ctx.frameGainKgDay) > 0
        ? Number(ctx.frameGainKgDay)
        : (
            Number.isFinite(Number(window.mbkNutrition?.testFrameGainKgDay)) &&
            Number(window.mbkNutrition?.testFrameGainKgDay) > 0
              ? Number(window.mbkNutrition.testFrameGainKgDay)
              : null
          )
  }
})
  });

const data = await res.json().catch(() => ({}));
if (!res.ok || data?.ok === false) {
  throw new Error(data?.error || `HTTP ${res.status}`);
}

rationAnalysisCache = data.analysis || null;

window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.panels = data.panels || null;

return rationAnalysisCache;
}

async function refreshRationAnalysis(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ctx = buildNutritionContextForRequest();
  if (!list.length) {
    rationAnalysisCache = null;
    rationAnalysisCacheKey = '';
    return null;
  }

 const key = JSON.stringify({
  rows: list,
  mode: document.getElementById('mode')?.value || 'tmr_asfed',
  concKg: parseUiNumber(document.getElementById('concKgInput')?.value || null),
milkPrice: isDryNutritionContext(ctx)
  ? null
  : parseUiNumber(document.getElementById('ctxMilkPrice')?.value || null),
context: ctx
});

  if (key === rationAnalysisCacheKey && rationAnalysisCache) {
    return rationAnalysisCache;
  }

  rationAnalysisCacheKey = key;
  const out = await fetchRationAnalysis(list);
window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.rationAnalysis = out || null;
applyServerAnalysisToDom(out, window.mbkNutrition.targets || null);
return out;
}

function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function qp(){ return new URLSearchParams(location.search); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function setElText(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = (val===null || val===undefined || val==='') ? '—' : String(val);
}
function getCentralBar(){
  return (
    document.getElementById('sysbar') ||
    document.querySelector('.infobar') ||
    document.getElementById('warn') ||
    null
  );
}

function showCentralMsg(text, type = 'info'){
  const bar = getCentralBar();

  if (bar && typeof window.showMsg === 'function') {
    window.showMsg(bar, text, type);
    return;
  }

  msgWarn(text);
}
function renderNutritionHeatStressAlert(){
  const card = document.getElementById('nutritionAnalysisCard');
  const grid = document.getElementById('nutritionKPIs');
  if (!card || !grid) return;

  let box = document.getElementById('nutritionHeatStressAlert');
  if (!box) {
    box = document.createElement('div');
    box.id = 'nutritionHeatStressAlert';
    grid.parentNode.insertBefore(box, grid);
  }

  const w = window.mbkNutrition?.weather || {};
  const thi = Number(w.thi);
  const tempC = Number(w.tempC);
  const humidity = Number(w.humidity);

  if (!Number.isFinite(thi)) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  let label = 'راحة حرارية';
  let icon = '✅';
  let bg = '#ecfdf3';
  let border = '#bbf7d0';
  let color = '#166534';
  let note = 'الجو مناسب حاليًا ولا يوجد تأثير حراري واضح على المأكول.';

 if (thi >= 88) {
  label = 'إجهاد حراري عالي';
  icon = '⛔';
  bg = '#fff1f2';
  border = '#fecdd3';
  color = '#b91c1c';
  note = 'خطر واضح لانخفاض المأكول والطاقة الداخلة للحيوان. فعّل التبريد، وفّر مياه كافية، وقدّم العليقة في الأوقات الأبرد قبل الحكم على كفاية التركيبة.';
} else if (thi >= 82) {
  label = 'إجهاد حراري متوسط';
  icon = '🌡️';
  bg = '#fff7ed';
  border = '#fed7aa';
  color = '#c2410c';
  note = 'قد يقل المأكول الفعلي قبل أن يظهر النقص في اللبن. راقب استهلاك العليقة والمياه، ويفضّل تقديم جزء أكبر من العليقة في الأوقات الأبرد.';
} else if (thi >= 77) {
  label = 'بداية إجهاد حراري';
  icon = '⚠️';
  bg = '#fefce8';
  border = '#fde68a';
  color = '#854d0e';
  note = 'بداية ضغط حراري مؤثر. راقب الحيوانات عالية الإنتاج، خاصة وقت الظهيرة ومع ضعف التهوية.';
} else if (thi >= 72) {
  label = 'مراقبة حرارية';
  icon = '👀';
  bg = '#f8fafc';
  border = '#dbe3ea';
  color = '#334155';
  note = 'الجو ليس إجهادًا حراريًا واضحًا، لكن يفضّل متابعة المأكول والمياه مع الأبقار عالية الإنتاج.';
}
  box.style.display = 'block';
  box.style.margin = '0 0 10px';
  box.style.padding = '10px 12px';
  box.style.borderRadius = '16px';
  box.style.background = bg;
  box.style.border = `1px solid ${border}`;
  box.style.color = color;
  box.style.boxShadow = '0 4px 12px rgba(15,23,42,.04)';

  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="font-weight:900;font-size:14px">
        ${icon} ${label}
      </div>
      <div style="font-weight:900;font-size:13px">
        THI ${Math.round(thi)}
      </div>
    </div>
    <div style="font-size:12px;font-weight:800;line-height:1.5;margin-top:5px">
      ${note}
    </div>
    <div style="font-size:11px;font-weight:700;opacity:.8;margin-top:4px">
      الحرارة ${Number.isFinite(tempC) ? Math.round(tempC) : '—'}°C — الرطوبة ${Number.isFinite(humidity) ? Math.round(humidity) : '—'}%
    </div>
  `;
}
function applyServerAnalysisToDom(analysis, targets){
  const a = analysis || {};
  const t = targets || {};
  const P = window.mbkNutrition?.panels || {};
const panelByKey = (arr, key) =>
  (Array.isArray(arr) ? arr.find(x => x?.key === key) : null) || null;
  const setNum = (id, v, suffix = '', d = 2) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      el.textContent = '—';
      return;
    }
    const n = Number(v);
    el.textContent = (Number.isInteger(n) ? String(n) : n.toFixed(d)) + suffix;
  };

  setNum('totDM', a?.totals?.dmKg, '', 2);
  setNum('totAsFed', a?.totals?.asFedKg, '', 2);
  setNum('totCost', a?.totals?.totCost, '', 2);
  setNum('mixPriceDM', a?.totals?.mixPriceDM, '', 2);
  setNum('mixPriceAsFed', a?.totals?.mixPriceAsFed, '', 2);
  setNum('mpSupplyG', a?.nutrition?.mpSupplyG, '', 0);
  setNum('mpDensityGkgDM', a?.nutrition?.mpDensityGkgDM, '', 0);

const dmCard = panelByKey(P.analysisCards, 'dm');
if (dmCard?.actual != null) {
  setNum('totDM', dmCard.actual, '', 2);
}
if (dmCard?.target != null) {
  setNum('dmiTarget', dmCard.target, '', 2);
}

const asFedCard = panelByKey(P.analysisCards, 'asFed');
if (asFedCard?.actual != null) {
  setNum('totAsFed', asFedCard.actual, '', 2);
}

const mpCard = panelByKey(P.analysisCards, 'mp');
if (mpCard?.actual != null) {
  setNum('mpSupplyG', mpCard.actual, '', 0);
}
if (mpCard?.target != null) {
  setNum('mpTargetG', mpCard.target, '', 0);
}
if (mpCard?.balance != null) {
  setNum('mpBalanceG', mpCard.balance, '', 0);
}

 {
  const advNelActual = panelByKey(P.advancedCards, 'nelActual');
  if (advNelActual?.value) {
    const n = parseFloat(String(advNelActual.value).replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(n)) setNum('nelActual', n, '', 2);
    else setNum('nelActual', a?.nutrition?.nelActual, '', 2);
  } else {
    setNum('nelActual', a?.nutrition?.nelActual, '', 2);
  }
}
  setNum('ndfPctActual', a?.nutrition?.ndfPctActual, '%', 1);
  setNum('fatPctActual', a?.nutrition?.fatPctActual, '%', 1);
  setNum('dmiTarget', t?.dmi ?? a?.targets?.dmiTarget, '', 2);
  setNum('targetAsFedKg', t?.targetAsFedKg ?? a?.targets?.targetAsFedKg, '', 2);
  {
  const advNelTarget = panelByKey(P.advancedCards, 'nelTarget');
  if (advNelTarget?.value) {
    const n = parseFloat(String(advNelTarget.value).replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(n)) setNum('nelTarget', n, '', 2);
    else setNum('nelTarget', t?.nel ?? a?.targets?.nelTarget, '', 2);
  } else {
    setNum('nelTarget', t?.nel ?? a?.targets?.nelTarget, '', 2);
  }
}
 setNum('mpTargetG', t?.mpTargetG ?? a?.targets?.mpTargetG, '', 0);
setNum('mpBalanceG', a?.nutrition?.mpBalanceG ?? a?.targets?.mpBalanceG, '', 0);
  setNum('ndfTarget', t?.ndfTarget ?? a?.targets?.ndfTarget, '', 0);
  setNum('starchMax', t?.starchMax ?? a?.targets?.starchMax, '', 0);

 {
  const ecoCostMilk = panelByKey(P.economicsCards, 'costPerKgMilk');
  if (ecoCostMilk?.value) {
    const n = parseFloat(String(ecoCostMilk.value).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n)) setNum('costPerKgMilk', n, '', 2);
    else setNum('costPerKgMilk', a?.economics?.costPerKgMilk, '', 2);
  } else {
    setNum('costPerKgMilk', a?.economics?.costPerKgMilk, '', 2);
  }
}

{
  const ecoDmMilk = panelByKey(P.economicsCards, 'dmPerKgMilk');
  if (ecoDmMilk?.value) {
    const s = String(ecoDmMilk.value);

    // نأخذ رقم اللبن بعد السهم إن وجد
    const afterArrow = s.split('→')[1] || s.split('->')[1] || '';
    const n = parseFloat(String(afterArrow).replace(/[^\d.]/g, ''));

    if (Number.isFinite(n)) {
      setNum('dmPerKgMilk', n, '', 2);
    } else {
      setNum('dmPerKgMilk', a?.economics?.dmPerKgMilk, '', 2);
    }
  } else {
    setNum('dmPerKgMilk', a?.economics?.dmPerKgMilk, '', 2);
  }
}

setNum('milkRevenue', a?.economics?.milkRevenue, '', 2);
setNum('ecmKg', a?.economics?.ecmKg, '', 2);
setNum('fpcmKg', a?.economics?.fpcmKg, '', 2);
{
  const ecoMargin = panelByKey(P.economicsCards, 'milkMargin');
  if (ecoMargin?.value) {
    const n = parseFloat(String(ecoMargin.value).replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(n)) setNum('milkMargin', n, '', 2);
    else setNum('milkMargin', a?.economics?.milkMargin, '', 2);
  } else {
    setNum('milkMargin', a?.economics?.milkMargin, '', 2);
  }
}

{
  const ecoMixAsFed = panelByKey(P.economicsCards, 'mixPriceAsFed');
  if (ecoMixAsFed?.value) {
    const n = parseFloat(String(ecoMixAsFed.value).replace(/[^\d.\-]/g, ''));
    if (Number.isFinite(n)) setNum('mixPriceAsFed', n, '', 2);
    else setNum('mixPriceAsFed', a?.totals?.mixPriceAsFed, '', 2);
  } else {
    setNum('mixPriceAsFed', a?.totals?.mixPriceAsFed, '', 2);
  }
}
  const fcEl = document.getElementById('fcRatio');
if (fcEl) {
  const rumenCard = panelByKey(P.analysisCards, 'rumen');

  if (rumenCard?.value) {
    fcEl.textContent = String(rumenCard.value);
  } else {
    const rough = Number(a?.nutrition?.roughPctDM);
    const conc  = Number(a?.nutrition?.concPctDM);

    if (Number.isFinite(rough) && Number.isFinite(conc)) {
      fcEl.textContent = `خشن ${rough.toFixed(0)}% / مركز ${conc.toFixed(0)}%`;
    } else {
      fcEl.textContent = '—';
    }
  }

  fcEl.dataset.rumenNote =
    rumenCard?.targetText ||
    a?.nutrition?.rumenNote ||
    '';
}
   const fcEl2 = document.getElementById('fcRatio');
const rumenHintEl = document.getElementById('rumenHint');
if (rumenHintEl) {
  const note = String(fcEl2?.dataset?.rumenNote || '').trim();
  const fixedAdvice = 'لصحة الكرش والاجترار وإفراز اللعاب: يجب ألا يقل طول تقطيع الخشن عن 3–5 سم.';

  rumenHintEl.innerHTML = `
    ${note ? `<div>${note}</div>` : ''}
    <div style="margin-top:6px;color:#475569;">${fixedAdvice}</div>
  `;
}

window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.serverViewModel = {
  analysis: a,
  targets: t,
  panels: P
};
renderNutritionHeatStressAlert();
try { window.renderNutritionPanels?.(); } catch(_) {}
}
function msgWarn(text){
  const w = document.getElementById('warn');
  if(!w) return;
  const s = String(text||'');
  w.textContent = s;
  w.style.display = s ? 'block' : 'none';
  // ✅ نجاح = أخضر، ⚠️/⛔ = أحمر (بدون تغيير CSS العام)
  if(!s){ w.style.color=''; return; }
  if(s.trim().startsWith('✅')){ w.style.color = '#2e7d32'; }
  else if(s.trim().startsWith('⚠️') || s.trim().startsWith('⛔')){ w.style.color = '#c62828'; }
  else { w.style.color=''; }
}

function disableSave(disabled){
  const btn = document.getElementById('saveEvent') || document.querySelector('[data-action="save-event"]');
  if(btn) btn.disabled = !!disabled;
}

function setHiddenCtxFromQuery(){
  const p = qp();
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== null && v !== undefined && v !== '') el.value = v; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = (v === '1' || v === 'true' || v === 'yes'); };

  setVal('ctxDIM', p.get('dim') || p.get('DIM'));
  setVal('ctxSpecies', p.get('species'));
  setVal('ctxAvgMilk', p.get('avgMilk'));
  setVal('ctxDCC', p.get('dcc'));
  setVal('ctxPreg', p.get('preg'));

  setVal('ctxMilkFat', p.get('milkFat'));
  setVal('ctxMilkProtein', p.get('milkProtein'));
  setVal('ctxMilkPrice', p.get('milkPrice'));
  setVal('ctxBreed', p.get('breed'));

  setVal('ctxBodyWeight', p.get('bodyWeight'));
  setVal('ctxBCS', p.get('bcs'));
  setVal('ctxParity', p.get('parity'));
  setVal('ctxDietNDFPct', p.get('dietNDFPct'));

  setChk('ctxEarlyDry', p.get('earlyDry'));
  setChk('ctxCloseUp', p.get('closeUp'));
}
function normalizeSpecies(raw){
  const s = String(raw || '').trim();
  if(!s) return '';
  const low = s.toLowerCase();

  if (s.includes('جاموس') || low.includes('buffalo')) return 'جاموس';
  if (s.includes('بقر') || s.includes('بقرة') || s.includes('أبقار') || low.includes('cow')) return 'بقر';

  return '';
}

function displaySpeciesLabel(v){
  if (v === 'بقر') return 'بقرة';
  if (v === 'جاموس') return 'جاموس';
  return v || '—';
}
function updateCtxView(){
 const species = document.getElementById('ctxSpecies')?.value || '';
const dim = document.getElementById('ctxDIM')?.value || '';
const avgMilk = document.getElementById('ctxAvgMilk')?.value || '';
const dcc = document.getElementById('ctxDCC')?.value || '';
const preg = document.getElementById('ctxPreg')?.value || '';
const earlyDry = !!document.getElementById('ctxEarlyDry')?.checked;
const closeUp = !!document.getElementById('ctxCloseUp')?.checked;
const isDry = earlyDry || closeUp;
const milkFat = document.getElementById('ctxMilkFat')?.value || '';
const milkProtein = document.getElementById('ctxMilkProtein')?.value || '';
const milkPrice = document.getElementById('ctxMilkPrice')?.value || '';
const breed = document.getElementById('ctxBreed')?.value || '';

const bodyWeight = document.getElementById('ctxBodyWeight')?.value || '';
const bcs = document.getElementById('ctxBCS')?.value || '';
const parity = document.getElementById('ctxParity')?.value || '';
const dietNDFPct = document.getElementById('ctxDietNDFPct')?.value || '';
  setElText('ctxSpecies_txt', displaySpeciesLabel(species));
  setElText('ctxDIM_txt', dim || '—');
  setElText('ctxAvgMilk_txt', isDry ? '0' : (avgMilk ? Number(avgMilk).toFixed(1) : '—'));
  setElText('ctxDCC_txt', dcc || '0');
  setElText('ctxPreg_txt', preg || 'فارغة');
  setElText('ctxEarlyDry_txt', earlyDry ? 'نعم' : 'لا');
  setElText('ctxMilkFat_txt', isDry ? '' : (milkFat ? Number(milkFat).toFixed(2) : '—'));
  setElText('ctxMilkProtein_txt', isDry ? '' : (milkProtein ? Number(milkProtein).toFixed(2) : '—'));
  setElText('ctxMilkPrice_txt', isDry ? '' : (milkPrice ? Number(milkPrice).toFixed(2) : '—'));
  setElText('ctxBreed_txt', breed || '—');
  setElText('ctxBodyWeight_txt', bodyWeight ? Number(bodyWeight).toFixed(0) : '—');
  setElText('ctxBCS_txt', bcs ? Number(bcs).toFixed(2) : '—');
  setElText('ctxParity_txt', parity || '—');
  setElText('ctxDietNDFPct_txt', dietNDFPct ? Number(dietNDFPct).toFixed(1) : '—');
  setElText('ctxCloseUp_txt', closeUp ? 'نعم' : 'لا');

  // متبقي للولادة
  const dccNum = dcc!=='' ? Number(dcc) : NaN;
  const gest = (species==='جاموس') ? 310 : 280;
  const dtc = Number.isFinite(dccNum) ? (gest - dccNum) : null;
  setElText('dtcVal', (dtc===null ? '—' : dtc));
  try { applyDryMilkVisibility(); } catch(_) {}
}

// =====================
// Firestore helpers (سياق)
// =====================
function isMilkEvent(ev){
  const t = String(
    ev?.eventTypeNorm ||
    ev?.type ||
    ev?.eventType ||
    ''
  ).trim();

  return (
    t === 'daily_milk' ||
    t === 'daily-milk' ||
    t === 'dailyMilk' ||
    t === 'لبن' ||
    t === 'لبن يومي' ||
    t === 'تسجيل اللبن اليومي'
  );
}
function getEventDay(ev){
  const d = ev?.eventDate || ev?.date || ev?.day || '';
  return String(d || '').slice(0,10);
}
function getMilkKg(ev){
  const v = ev?.milkKg ?? ev?.milk ?? ev?.value ?? ev?.kg ?? ev?.amount ?? ev?.dailyMilk;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function evTime(ev){
  const ca = ev?.createdAt;
  try{ if(ca && typeof ca.toDate === 'function') return ca.toDate().getTime(); }catch(_){}
  const s = ev?.createdAt?.seconds;
  if(Number.isFinite(s)) return s * 1000;
  const d = new Date(ev?.createdAt);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

async function findAnimalDocByNumber(db, fs, uid, nStr){
  const { collection, query, where, limit, getDocs } = fs;

  const tries = [];
  const nNum = Number(String(nStr).trim());
  if(Number.isFinite(nNum)) tries.push(nNum);
  tries.push(String(nStr).trim());

  for(const ownerField of ['userId','ownerUid']){
    for(const v of tries){
      try{
        const qy = query(
          collection(db,'animals'),
          where(ownerField,'==', uid),
          where('animalNumber','==', v),
          limit(1)
        );
        const snap = await getDocs(qy);
        if(!snap.empty) return snap.docs[0].data();
      }catch(_){}
    }
  }
  return null;
}

async function fetchAvgMilkKgFor(fs, db, uid, animalVal, endDateStr, days=7){
  const { collection, query, where, limit, getDocs, orderBy } = fs;

  const end = new Date(endDateStr || todayLocal());
  if(isNaN(end.getTime())) return { avg:null, days:0 };

  const start = new Date(end);
  start.setDate(start.getDate() - days);

  const candidates = [];

  async function pull(ownerField){
    try{
      const q = query(
        collection(db,'events'),
        where(ownerField,'==', uid),
        where('animalNumber','==', animalVal),
        orderBy('createdAt','desc'),
        limit(160)
      );
      const snap = await getDocs(q);
      snap.forEach(d=>candidates.push(d.data()));
    }catch(_){
      try{
        const q = query(
          collection(db,'events'),
          where(ownerField,'==', uid),
          where('animalNumber','==', animalVal),
          limit(160)
        );
        const snap = await getDocs(q);
        snap.forEach(d=>candidates.push(d.data()));
      }catch(__){}
    }
  }

  await pull('userId');
  await pull('ownerUid');

  const byDay = new Map();

  for(const ev of candidates){
    if(!isMilkEvent(ev)) continue;

    const day = getEventDay(ev);
    if(!day) continue;

    const d = new Date(day);
    if(isNaN(d.getTime())) continue;
    if(d < start || d > end) continue;

    const kg = getMilkKg(ev);
    if(!Number.isFinite(kg) || kg <= 0) continue;

    const prev = byDay.get(day);
    const t = evTime(ev);
    if(!prev || t > prev.t){
      byDay.set(day, { kg, t });
    }
  }

  const vals = [...byDay.values()].map(x => x.kg);
  if(!vals.length) return { avg:null, days:0 };

  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return { avg, days: vals.length };
}
async function fetchGroupAvgMilkKg(fs, db, uid, numbers, endDateStr, days = 7){
  const { collection, query, where, limit, getDocs } = fs;

  const nums = (Array.isArray(numbers) ? numbers : [])
    .map(x => String(x).trim())
    .filter(Boolean);

  if (!nums.length) return { avg:null, days:0 };

  const wanted = new Set(nums.map(String));
  const wantedNum = new Set(
    nums.map(x => Number(x)).filter(n => Number.isFinite(n)).map(String)
  );

  const candidates = [];

  async function pull(ownerField){
    try{
      const q = query(
        collection(db, 'events'),
        where(ownerField, '==', uid),
        limit(4000)
      );
      const snap = await getDocs(q);
      snap.forEach(d => candidates.push(d.data()));
    }catch(_){}
  }

  await pull('userId');
  await pull('ownerUid');

  const byAnimalDay = new Map();

  for (const ev of candidates){
    if (!isMilkEvent(ev)) continue;

    const rawNo = String(ev?.animalNumber ?? ev?.number ?? ev?.animalId ?? '').trim();
    if (!rawNo) continue;

    const rawNoNum = Number(rawNo);
    const keyNo = String(rawNo);
    const keyNoNum = Number.isFinite(rawNoNum) ? String(rawNoNum) : '';

    if (
      !wanted.has(keyNo) &&
      !wantedNum.has(keyNo) &&
      !wanted.has(keyNoNum) &&
      !wantedNum.has(keyNoNum)
    ) continue;

    const day = getEventDay(ev);
    if (!day) continue;

    const kg = getMilkKg(ev);
    if (!Number.isFinite(kg) || kg <= 0) continue;

    const animalKey = keyNoNum || keyNo;
    const k = `${animalKey}__${day}`;
    const prev = byAnimalDay.get(k);
    const t = evTime(ev);

    if (!prev || t > prev.t){
      byAnimalDay.set(k, { kg, t, animal: animalKey, day });
    }
  }

  const perAnimal = new Map();

  for (const rec of byAnimalDay.values()){
    if (!perAnimal.has(rec.animal)) perAnimal.set(rec.animal, []);
    perAnimal.get(rec.animal).push(rec);
  }

  const animalAverages = [];
  let usedDays = 0;

  for (const arr of perAnimal.values()){
    arr.sort((a,b) => String(b.day).localeCompare(String(a.day)));
    const lastRecorded = arr.slice(0, days);

    if (lastRecorded.length){
      usedDays = Math.max(usedDays, lastRecorded.length);
      animalAverages.push(
        lastRecorded.reduce((s, x) => s + x.kg, 0) / lastRecorded.length
      );
    }
  }

  if (!animalAverages.length) return { avg:null, days:0 };

  const avg = animalAverages.reduce((a,b)=>a+b,0) / animalAverages.length;
  return { avg, days: usedDays };
}
function parseNumbersList(){
  const p = qp();
  const raw = (
    p.get('bulk') ||
    p.get('numbers') ||
    p.get('groupNumbers') ||
    p.get('animalIds') ||
    p.get('animalNumber') ||
    p.get('number') ||
    p.get('animalId') ||
    ''
  ).toString();

  const list = raw
    .split(/[,،;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  return [...new Set(list)];
}

function readUrlCtx(){
  const p = qp();
  const rawNumber =
    p.get('bulk') ||
    p.get('animalNumber') ||
    p.get('number') ||
    p.get('animalId') ||
    p.get('numbers') ||
    p.get('groupNumbers') ||
    '';

  const rawDate = p.get('eventDate') || p.get('date') || '';
  const eventDate = DATE_RE.test(String(rawDate||'')) ? String(rawDate) : todayLocal();

  const nums = parseNumbersList();
  return { rawNumber: String(rawNumber||'').trim(), nums, eventDate };
}

async function loadCtxFromAnimal(numberStr, eventDate){
  if(!numberStr) return { ok:false, reason:'no_number' };

  const { db, auth } = await import('/js/firebase-config.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const uid = auth?.currentUser?.uid;
  if(!uid) return { ok:false, reason:'no_uid' };

  const animal = await findAnimalDocByNumber(db, fs, uid, numberStr);
  if(!animal) return { ok:false, reason:'not_found' };

  // ✅ تخزين الحيوان الحالي ليُستخدم في الاحتياجات (breed/weight)
  window.currentAnimal = animal;

  const dim = Number.isFinite(Number(animal?.daysInMilk)) ? Number(animal.daysInMilk) : null;

  const speciesRaw =
  (animal?.animalTypeAr) ||
  (animal?.animaltype === 'buffalo' ? 'جاموس' : (animal?.animaltype === 'cow' ? 'بقر' : '')) ||
  '';

const species = normalizeSpecies(speciesRaw);

  const preg = (animal?.reproductiveStatus || animal?.lastDiagnosis || animal?.pregStatus || '') || '';

  // breed (لرفع دقة الاحتياجات حسب السلالة)
 // breed + bodyWeight + bcs + parity
try{
  const br = String(animal?.breed || '').trim();
  const breedEl = document.getElementById('ctxBreed');
  if (breedEl && br) breedEl.value = br;

  const bw =
    animal?.bodyWeight ??
    animal?.weight ??
    null;

  const bcs =
    animal?.bcs ??
    null;

  const parity =
    animal?.parity ??
    animal?.lactationNumber ??
    null;

  const bwEl = document.getElementById('ctxBodyWeight');
  const bcsEl = document.getElementById('ctxBCS');
  const parityEl = document.getElementById('ctxParity');

  if (bwEl && bw != null) bwEl.value = bw;
  if (bcsEl && bcs != null) bcsEl.value = bcs;
  if (parityEl && parity != null) parityEl.value = parity;
}catch(_){ }


  // DCC من lastInseminationDate (فقط لو عشار)
  let dcc = null;
  if(preg === 'عشار' && animal?.lastInseminationDate){
    const a = new Date(animal.lastInseminationDate);
    const b = new Date(eventDate || todayLocal());
    if(!isNaN(a.getTime()) && !isNaN(b.getTime())){
      const diff = Math.floor((b.getTime()-a.getTime())/86400000);
      if(diff >= 0) dcc = diff;
    }
  }
const productionStatusRaw = String(animal?.productionStatus || '')
  .trim()
  .toLowerCase();

const isDryFromAnimal =
  productionStatusRaw === 'dry' ||
  productionStatusRaw === 'جاف' ||
  productionStatusRaw.includes('dry') ||
  productionStatusRaw.includes('جاف');

const gestLen = (species === 'جاموس') ? 310 : 280;

const daysToCalvingCalc =
  Number.isFinite(Number(dcc)) ? (gestLen - Number(dcc)) : null;

const isCloseUpFromAnimal =
  isDryFromAnimal &&
  Number.isFinite(daysToCalvingCalc) &&
  daysToCalvingCalc < 30;

const isEarlyDryFromAnimal =
  isDryFromAnimal && !isCloseUpFromAnimal;

const earlyDryEl = document.getElementById('ctxEarlyDry');
const closeUpEl = document.getElementById('ctxCloseUp');

if (earlyDryEl) {
  earlyDryEl.checked = isEarlyDryFromAnimal;
  earlyDryEl.value = isEarlyDryFromAnimal ? '1' : '';
}

if (closeUpEl) {
  closeUpEl.checked = isCloseUpFromAnimal;
  closeUpEl.value = isCloseUpFromAnimal ? '1' : '';
}

setElText('ctxEarlyDry_txt', isEarlyDryFromAnimal ? 'نعم' : 'لا');
setElText('ctxCloseUp_txt', isCloseUpFromAnimal ? 'نعم' : 'لا');
// متوسط اللبن (آخر 7 أيام) — جرّب string ثم number (لأن animalNumber قد يُخزن كنص أو رقم)
  let avgRes = await fetchAvgMilkKgFor(fs, db, uid, String(numberStr), eventDate, 7);
  if((avgRes?.avg==null) && String(numberStr).trim()!==''){
    const nNum = Number(numberStr);
    if(Number.isFinite(nNum)){
      const alt = await fetchAvgMilkKgFor(fs, db, uid, nNum, eventDate, 7);
      if(alt?.avg!=null) avgRes = alt;
    }
  }
  const avgMilk = (avgRes?.avg!=null) ? Number(avgRes.avg) : null;

  // اكتب القيم في الحقول المخفية
 if (species) document.getElementById('ctxSpecies').value = species;
  if(dim!=null) document.getElementById('ctxDIM').value = Math.round(dim);
  document.getElementById('ctxAvgMilk').value = (avgMilk!=null ? avgMilk.toFixed(1) : '');
  if(dcc!=null) document.getElementById('ctxDCC').value = Math.round(dcc);
  if(preg) document.getElementById('ctxPreg').value = preg;

  const animalInfo = document.getElementById('animalInfo');
  if(animalInfo) animalInfo.textContent = String(animal?.animalNumber ?? numberStr);

  updateCtxView();
  return { ok:true, animal, dim, avgMilk, species, dcc, preg };
}

async function loadCtxFromGroup(numbers, eventDate){
    const nums = (Array.isArray(numbers) ? numbers : [])
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isFinite(n));
  if(!numbers?.length) return { ok:false, reason:'no_number' };

  const { db, auth } = await import('/js/firebase-config.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const uid = auth?.currentUser?.uid;
  if(!uid) return { ok:false, reason:'no_uid' };

 const foundDocs = await Promise.all(
  numbers.map(n => findAnimalDocByNumber(db, fs, uid, n))
);
const docs = foundDocs.filter(Boolean);
  if(!docs.length) return { ok:false, reason:'not_found' };

  const dims = docs.map(d=>Number(d.daysInMilk)).filter(x=>Number.isFinite(x));
  const avgDIM = dims.length ? (dims.reduce((a,b)=>a+b,0)/dims.length) : null;

const first = docs[0] || {};
const species = normalizeSpecies(
  first?.animalTypeAr ||
  (first?.animaltype === 'buffalo' ? 'جاموس' : (first?.animaltype === 'cow' ? 'بقر' : '')) ||
  ''
);

const avgMilkRes = await fetchGroupAvgMilkKg(fs, db, uid, numbers, eventDate, 7);
const avgMilk = (avgMilkRes?.avg != null) ? Number(avgMilkRes.avg) : null;
const pregStates = docs.map(d => String(
  d.reproductiveStatus ||
  d.lastDiagnosis ||
  d.pregStatus ||
  ''
).trim()).filter(Boolean);

const pregNorm = pregStates.map(s => {
  if (s === 'عشار') return 'عشار';
  if (s === 'فارغة') return 'فارغة';
  if (s === 'ملقح') return 'ملقح';
  return '';
}).filter(Boolean);

let groupPreg = '';
if (pregNorm.length) {
  const uniq = [...new Set(pregNorm)];
  groupPreg = (uniq.length === 1) ? uniq[0] : 'مختلط';
}

const dccs = [];
for(const d of docs){
  const repro = String(
    d.reproductiveStatus ||
    d.lastDiagnosis ||
    d.pregStatus ||
    ''
  ).trim();

  if(repro !== 'عشار') continue;

  const lastIns = d.lastInseminationDate;
  if(!lastIns) continue;

  const a = new Date(lastIns);
  const b = new Date(eventDate);

  if(isNaN(a.getTime()) || isNaN(b.getTime())) continue;

  const diff = Math.floor((b.getTime()-a.getTime())/86400000);
  if(diff >= 0) dccs.push(diff);
}
const avgDCC = dccs.length ? (dccs.reduce((a,b)=>a+b,0)/dccs.length) : null;

if (species) document.getElementById('ctxSpecies').value = species;
if (avgDIM != null) document.getElementById('ctxDIM').value = Math.round(avgDIM);
document.getElementById('ctxAvgMilk').value = (avgMilk != null ? avgMilk.toFixed(1) : '');
document.getElementById('ctxDCC').value = (avgDCC != null ? Math.round(avgDCC) : '');
document.getElementById('ctxPreg').value = groupPreg || '';

// breed ممثلة للمجموعة: أول سلالة متاحة
const groupBreed =
  String(docs.find(d => String(d?.breed || '').trim())?.breed || '').trim();
const breedEl = document.getElementById('ctxBreed');
if (breedEl && groupBreed) breedEl.value = groupBreed;

// parity ممثلة للمجموعة: متوسط lactationNumber/parity إن وُجد
const parityVals = docs
  .map(d => Number(d?.parity ?? d?.lactationNumber))
  .filter(v => Number.isFinite(v));
const avgParity = parityVals.length
  ? (parityVals.reduce((a,b)=>a+b,0) / parityVals.length)
  : null;
const parityEl = document.getElementById('ctxParity');
if (parityEl && avgParity != null) parityEl.value = Math.round(avgParity);

// في تغذية المجموعة لا نملأ وزن الجسم ولا BCS من متوسطات الحيوانات.
// لو المستخدم أدخلهم نستخدمهم، ولو تركهم فارغين readContext سيحسبهم تلقائيًا.
const bwEl = document.getElementById('ctxBodyWeight');
const bcsEl = document.getElementById('ctxBCS');

if (bwEl && !bwEl.dataset.userEdited) bwEl.value = '';
if (bcsEl && !bcsEl.dataset.userEdited) bcsEl.value = '';

  const animalInfo = document.getElementById('animalInfo');
  const groupLabel =
  String(qp().get('group') || qp().get('groupName') || '').trim();

if (animalInfo) {
  animalInfo.textContent =
    groupLabel || `مجموعة (${docs.length} رأس)`;
}

  updateCtxView();
  return { ok:true, count: docs.length };
}

async function loadCtxAuto(){
  const { rawNumber, nums, eventDate } = readUrlCtx();
const mode = (qp().get('mbkMode') || '').toString().trim().toLowerCase();

let res = null;

if (mode === 'group' && nums.length){
  res = await loadCtxFromGroup(nums, eventDate);
} else {
  // لازم رقم (فردي أو قائمة) من الـURL
  if(!rawNumber){
    disableSave(true);
  showCentralMsg('⚠️ افتح صفحة التغذية من داخل مُرَبِّيك (لازم رقم الحيوان/المجموعة في الرابط).', 'error');
    return { ok:false, reason:'no_number' };
  }

  // فردي/جماعي
 res = (nums.length > 1)
  ? await loadCtxFromGroup(nums, eventDate)
  : await loadCtxFromAnimal(nums[0] || rawNumber, eventDate);
}

 if(res?.ok){
 const numEl  = document.getElementById('animalNumber');
const dateEl = document.getElementById('eventDate');
const idEl   = document.getElementById('animalId');

  const currentNum = String(nums[0] || rawNumber || '').trim();
  const currentDate = String(eventDate || '').trim();

  if (numEl) {
    numEl.value = currentNum;
    numEl.disabled = false;
  }

  if (dateEl) {
    dateEl.value = currentDate;
    dateEl.disabled = false;
  }

  if (idEl) {
    idEl.value = currentNum;
    idEl.disabled = false;
  }

 disableSave(false);

const btn =
  document.getElementById('saveEvent') ||
  document.querySelector('[data-action="save-event"]');

if (btn) {
  btn.disabled = false;
  btn.removeAttribute('disabled');
}
try { applyDryMilkVisibility(); } catch(_) {}
showCentralMsg('✅ تم تحميل بيانات السياق تلقائيًا.', 'success');
}else if(res?.reason==='no_uid'){
    disableSave(true);
   showCentralMsg('⚠️ يلزم تسجيل الدخول أولاً.', 'error');
  }else if(res?.reason==='not_found'){
    disableSave(true);
   showCentralMsg('⚠️ لم يتم العثور على الحيوان/المجموعة في القطيع.', 'error');
  }else{
    disableSave(true);
   showCentralMsg('⚠️ تعذر تحميل البيانات تلقائيًا.', 'error');
  }
  return res;
}


let __nutritionUiStarted = false;
async function initNutritionUI(){
  if(__nutritionUiStarted) return;
  __nutritionUiStarted = true;
 
  const warn = document.getElementById('warn');
  const modeSel = document.getElementById('mode');
  const ctxDIM = document.getElementById('ctxDIM');
  const ctxSpecies = document.getElementById('ctxSpecies');
  const ctxAvgMilk = document.getElementById('ctxAvgMilk');
  const ctxDCC = document.getElementById('ctxDCC');
  const dtcVal = document.getElementById('dtcVal');
  const ctxEarlyDry = document.getElementById('ctxEarlyDry');
  const ctxCloseUp = document.getElementById('ctxCloseUp');
  const ctxPreg = document.getElementById('ctxPreg');
  const presetSel = document.getElementById('preset');
  const milkFatInput = document.getElementById('milkFatInput');
const milkProteinInput = document.getElementById('milkProteinInput');
const milkPriceInput = document.getElementById('milkPriceInput');

const ctxMilkFat = document.getElementById('ctxMilkFat');
const ctxMilkProtein = document.getElementById('ctxMilkProtein');
const ctxMilkPrice = document.getElementById('ctxMilkPrice');
const ctxBodyWeight = document.getElementById('ctxBodyWeight');
const ctxBCS = document.getElementById('ctxBCS');
  [ctxBodyWeight, ctxBCS].forEach(el => {
  if (!el || el.dataset.userEditBound === '1') return;
  el.dataset.userEditBound = '1';

  el.addEventListener('input', () => {
    el.dataset.userEdited = '1';
  });

  el.addEventListener('change', () => {
    el.dataset.userEdited = '1';
  });
});
const feedInputBox = document.getElementById('feedInputBox');
const feedSummaryBox = document.getElementById('feedSummaryBox');
const advancedBtn = document.getElementById('toggleAdvancedBtn');
const advancedBox = document.getElementById('advancedKPIs');

  function bindAdvancedToggle(){
    if (!advancedBtn || !advancedBox || advancedBtn.dataset.bound === '1') return;
    advancedBtn.dataset.bound = '1';
    advancedBtn.addEventListener('click', ()=>{
    const open = (advancedBox.style.display === 'block');
      advancedBox.style.display = open ? 'none' : 'block';
      advancedBtn.textContent = open ? 'عرض متقدم' : 'إخفاء العرض المتقدم';
      try { if (typeof render === 'function') render(); } catch(_){ }
    });
  }

  initNutritionPanels();
  bindMilkInputs();
  bindAdvancedToggle();
  if (milkFatInput && ctxMilkFat) milkFatInput.value = ctxMilkFat.value || '';
if (milkProteinInput && ctxMilkProtein) milkProteinInput.value = ctxMilkProtein.value || '';
if (milkPriceInput && ctxMilkPrice) milkPriceInput.value = ctxMilkPrice.value || '';
  // ✅ Helpers (لا تعتمد على jQuery)
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root=document) => root.querySelector(sel);
  const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
function bindMilkInputs(){
  const syncAndRefresh = async () => {
    if (ctxMilkFat && milkFatInput) ctxMilkFat.value = milkFatInput.value || '';
    if (ctxMilkProtein && milkProteinInput) ctxMilkProtein.value = milkProteinInput.value || '';
    if (ctxMilkPrice && milkPriceInput) ctxMilkPrice.value = milkPriceInput.value || '';

    updateCtxView();

  try { recalc(); } catch(_) {}
  };

 [milkFatInput, milkProteinInput, milkPriceInput, ctxBodyWeight, ctxBCS].forEach(el => {
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('input', syncAndRefresh);
    el.addEventListener('change', syncAndRefresh);
  });
}
  // ✅ تحويل السعر: لو المستخدم كتب "سعر/كجم" (مثلاً 13.5) نحوله تلقائياً إلى "سعر/طن" (×1000)
  function normalizeKgPrice(v){
    const n = Number(v);
    if(!isFinite(n) || n<=0) return 0;
    // ✅ مدخل السعر في نموذج الخامات = سعر/كجم (as-fed)
    // لو المستخدم كتب رقم كبير (غالبًا سعر/طن) هنحوّله تلقائيًا إلى سعر/كجم
    return (n > 200) ? (n / 1000) : n;
  }


  // ✅ ثابت: tbody للجدول (لا تستخدمه قبل تعريفه)
  const tbody = document.querySelector('#tbl tbody');


const rationActions = document.getElementById('rationActions');
const btnRationEdit = document.getElementById('rationEdit');
const btnRationRemove = document.getElementById('rationRemove');

let selectedRation = new Set(); // indices

function updateRationActionsUI(){
  const any = selectedRation.size > 0;
  if(rationActions) rationActions.style.display = any ? 'flex' : 'none';
  if(btnRationEdit) btnRationEdit.disabled = (selectedRation.size !== 1);
  if(btnRationRemove) btnRationRemove.disabled = !any;
}
function renderRationSummary(){
  if(!feedSummaryBox) return;

  if(rationItems.length===0){
    feedSummaryBox.innerHTML = '<div style="opacity:.75">لم يتم إدخال خامات بعد.</div>';
    selectedRation.clear();
    updateRationActionsUI();
    return;
  }

  feedSummaryBox.innerHTML = rationItems.map((it, i)=>{
    const left = it.pct ? (nf(it.pct)+'%') : (nf(it.kg)+' كجم');
    const checked = selectedRation.has(i) ? 'checked' : '';
    return `
      <div class="feed-item" data-idx="${i}">
        <label>
          <input class="rationPick" type="checkbox" data-idx="${i}" ${checked}>
          <span class="a">${escapeHtml(it.name)}</span>
        </label>
        <span class="b">${escapeHtml(left)}</span>
      </div>
    `;
  }).join('');

  updateRationActionsUI();
}


// اختيار خامات التركيبة (Checkbox)
feedSummaryBox?.addEventListener('change', (e)=>{
  const cb = e.target?.closest?.('.rationPick');
  if(!cb) return;
  const i = Number(cb.dataset.idx);
  if(!Number.isFinite(i)) return;
  if(cb.checked) selectedRation.add(i);
  else selectedRation.delete(i);
  updateRationActionsUI();
});

// إزالة المختار
btnRationRemove?.addEventListener('click', ()=>{
  if(!selectedRation.size) return;
  const arr = Array.from(selectedRation).sort((a,b)=>b-a);
  arr.forEach(i=>{
    if(i>=0 && i<rationItems.length) rationItems.splice(i,1);
  });
  selectedRation.clear();
  renderRationSummary();
  recalc();

  
});

// تعديل المختار (خامة واحدة فقط)
btnRationEdit?.addEventListener('click', ()=>{
  if(selectedRation.size !== 1) return;
  const i = Array.from(selectedRation)[0];
  const it = rationItems[i];
  if(!it) return;

 fillCurrentRowWithFeed(it, it.cat);

  const tr = tbody.querySelector('tr:last-child');
  if(tr){
    const dmEl = tr.querySelector('.dm');
    const kgEl = tr.querySelector('.kg');
    const pctEl = tr.querySelector('.pct');
    if(dmEl && it.dm!=null && it.dm!==0) dmEl.value = it.dm;
    if(kgEl) kgEl.value = it.kg ? it.kg : '';
    if(pctEl) pctEl.value = it.pct ? it.pct : '';
    setRowState(tr);
    focusEditable(tr);
  }

  selectedRation.clear();
  renderRationSummary();
  recalc();
  recalc();
});


const miniActions = document.getElementById('miniActions');

function showFeedUI(){
  if(feedInputBox) feedInputBox.style.display = 'block';
  if(feedSummaryBox) feedSummaryBox.style.display = 'block';
  if(miniActions) miniActions.style.display = 'flex';
   if(tbody && tbody.querySelectorAll('tr').length === 0){
    addEmptyRow();
  }
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

  const clearBtn = document.getElementById('clearAll');
  const tplSel = document.getElementById('tpl');

 window.rationItems = window.rationItems || [];
let rationItems = window.rationItems;
  const splitBox = document.getElementById('splitBox');
  const concKgInput = document.getElementById('concKgInput');

  function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
  const qp = new URLSearchParams(location.search);
 const animalId =
  qp.get('animalNumber') ||
  qp.get('number') ||
  qp.get('animalId') ||
  '';
  const groupName = qp.get('group') || '';
  const eventDate= qp.get('date') || todayLocal();

  document.getElementById('animalInfo').textContent = (groupName || animalId || 'غير محدد');
  try{ document.getElementById('dateInfo').textContent = new Date(eventDate).toLocaleDateString('ar-EG'); }catch{ document.getElementById('dateInfo').textContent = eventDate; }

  // تعبئة سياق من الرابط كـ fallback فقط (لا تمسح سياق المجموعة بعد تحميله)
  if (ctxDIM && !ctxDIM.value) ctxDIM.value = qp.get('dim') || '';
  if (ctxSpecies && !ctxSpecies.value) ctxSpecies.value = qp.get('species') || '';
  if (ctxAvgMilk && !ctxAvgMilk.value) ctxAvgMilk.value = qp.get('avgMilk') || '';
  if (ctxDCC && !ctxDCC.value) ctxDCC.value = qp.get('dcc') || '';
  if (ctxPreg && !ctxPreg.value) ctxPreg.value = qp.get('preg') || qp.get('pregnancy') || '';
  // ===== تحميل نوع الحيوان تلقائياً من animals =====
async function loadSpeciesFromAnimals(){
  try{
    if(!animalId) return;

    const { db, auth } = await import('/js/firebase-config.js');
    const { collection, query, where, getDocs } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

    const uid = auth?.currentUser?.uid;

    // جرّب animalNumber رقم
    let snap = await getDocs(query(
      collection(db,'animals'),
      where('animalNumber','==', Number(animalId))
    ));

    // لو فاضي جرّب كنص
    if(snap.empty){
      snap = await getDocs(query(
        collection(db,'animals'),
        where('animalNumber','==', animalId)
      ));
    }

    if(snap.empty) return;

    let data = snap.docs[0].data();

    let typeAr =
      data.animalTypeAr ||
      (data.animaltype==='buffalo' ? 'جاموسة' :
       data.animaltype==='cow' ? 'بقرة' : '');

    if(!typeAr) return;

    // للعرض في الشريط
    document.getElementById('ctxSpecies_txt').textContent = typeAr;

    // للقيمة الداخلية (لازم تكون بقر أو جاموس للحسابات)
    ctxSpecies.value =
      typeAr.includes('جاموس') ? 'جاموس' : 'بقر';

  }catch(e){
    console.warn(e);
  }
}
  if ((qp.get('earlyDry')||'') === '1') ctxEarlyDry.checked = true;
  if ((qp.get('closeUp') ||'') === '1') ctxCloseUp.checked  = true;

  // ===== مكتبة خامات مصر من Firestore (لا علاقة ببقر/جاموس) =====
 const { db, auth } = await import('/js/firebase-config.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
 const { collection, query, where, getDocs, doc, getDoc } = fs;

  let FEEDS = [];                 // [{id,name,dm}]
  const FEEDS_BY_ID = new Map();  // id -> feed
  const normName = (s)=> String(s||'').trim().replace(/\s+/g,' ');
  function findFeedByName(name){
    const key = normName(name);
    if(!key) return null;
    // exact match first
    let f = FEEDS.find(x=> normName(x.name)===key);
    if(f) return f;
    // fallback: startsWith/contains (يحمي من اختلاف بسيط)
    f = FEEDS.find(x=> normName(x.name).includes(key) || key.includes(normName(x.name)));
    return f || null;
  }

  const FEEDS_BY_NAME = new Map(); // nameAr -> feed (for analysis)

  function rebuildFeedUI(){
    // 1) rebuild preset select
    presetSel.innerHTML = '<option value="">— اختر —</option>';
    FEEDS.forEach(f=>{
      const o = document.createElement('option');
      o.value = f.id;           // ✅ docId بدل index
      o.textContent = f.name;
      presetSel.appendChild(o);
    });

    // 2) rebuild datalist feedlist
    const old = document.getElementById('feedlist');
    if(old) old.remove();
    const dl = document.createElement('datalist');
    dl.id = 'feedlist';
    FEEDS.forEach(f=>{
      const o = document.createElement('option');
      o.value = f.name;
      dl.appendChild(o);
    });
    document.body.appendChild(dl);
  }

  async function loadFeedLibrary(){
    FEEDS = [];
    FEEDS_BY_ID.clear();

   // ✅ حمّل كل الخامات (حتى لو enabled غير موجود) ثم فلترها داخل الكود
const snap = await getDocs(collection(db, 'feed_items'));

    const list = [];
    const pickNum = (obj, keys) => {
  // ✅ يدعم القيم سواء في جذر الوثيقة أو داخل nrc2021 / patch / patch.nrc2021
  const pools = [
    obj,
    obj?.nrc2021,
    obj?.patch,
    obj?.patch?.nrc2021,
    obj?.patch?.NRC2021,
    obj?.NRC2021,
  ].filter(Boolean);

  for (const k of keys) {
    for (const src of pools) {
      let v = src?.[k];
      if (v === null || v === undefined || v === "") continue;

      // لو String (مثلاً "33%" أو "33.5")
      if (typeof v === "string") {
        v = v.replace(/[^\d.\-]/g, ""); // يشيل % وأي رموز
      }

      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
};
    snap.forEach(docSnap=>{
      const d = docSnap.data() || {};
      // لو الخامة متعطلة صراحةً
if (d.enabled === false) return;
      const name = String(d.nameAr || '').trim();
      if(!name) return;
     
   list.push({
  id: docSnap.id,
  name,
  cat: String(d.cat || d.category || d.type || '').trim() || null,

  dm: pickNum(d, ['dmPct','dm','DM','dm_percent','dryMatterPct','dryMatter','dmP']),
cp: pickNum(d, ['cpPct','cp','CP','proteinPct','protein','crudeProteinPct','cp_percent','cpP']),
nel: pickNum(d, ['nelMcalPerKgDM','nel','NEL']),
ndf: pickNum(d, ['ndfPct','ndf','NDF']),
fat: pickNum(d, ['fatPct','fat','Fat','EE','etherExtractPct','fat_percent']),
starch: pickNum(d, ['starchPct','starch','Starch']),
mp:  pickNum(d, ['mpGPerKgDM','mp','MP']),
});
    });
// ===== دمج تعديلات المستخدم (Overrides) فوق قيم NRC =====
const uid = auth?.currentUser?.uid;

if (uid) {
  for (const f of list) {
    const oid = `${uid}__${f.id}`; // docId ثابت: userId__feedId
    try {
      const od = await getDoc(doc(db, 'feed_overrides', oid));
      if (!od.exists()) continue;

      const o = od.data() || {};

      // لو المستخدم أخفى خامة
      if (o.enabled === false) { f._hiddenByUser = true; continue; }

      // Override لأي قيمة فقط إذا كانت موجودة
    if (o.dmPct != null) f.dm = Number(o.dmPct);
if (o.cpPct != null) f.cp = Number(o.cpPct);
if (o.nelMcalPerKgDM != null) f.nel = Number(o.nelMcalPerKgDM);
if (o.ndfPct != null) f.ndf = Number(o.ndfPct);
if (o.fatPct != null) f.fat = Number(o.fatPct);
if (o.starchPct != null) f.starch = Number(o.starchPct);
if (o.mpGPerKgDM != null) f.mp = Number(o.mpGPerKgDM);
    } catch (e) {
      console.warn('override read failed for', f.id, e);
    }
  }
}
   // شيل الخامات اللي المستخدم مخفيها
// ترتيب عربي
const list2 = list.filter(x => !x._hiddenByUser);
list2.sort((a,b)=> a.name.localeCompare(b.name, 'ar'));

// ✅ المصدر النهائي
FEEDS = list2;

// ✅ خرائط سريعة
FEEDS_BY_ID.clear();
FEEDS_BY_NAME.clear();

FEEDS.forEach(f=>{
  FEEDS_BY_ID.set(f.id, f);
  FEEDS_BY_NAME.set(normName(f.name), f); // ✅ بالاسم المُنظَّف
});

// ✅ تحديث UI
rebuildFeedUI();
  }
  const TEMPLATES = [
    { key: 'tmr_asfed_high_cow', name: 'TMR as-fed — حلابة مرتفعة (بقر)', mode: 'tmr_asfed', items: [
      { name:'سيلاج ذرة', cat:'rough', dm:33, kg:22 },
      { name:'دريس برسيم', cat:'rough', dm:90, kg:1.5 },
      { name:'ذرة صفراء مجروشة', cat:'conc', dm:88, kg:6 },
      { name:'كسب فول صويا 48%', cat:'conc', dm:89, kg:2.5 },
      { name:'مولاس', cat:'conc', dm:75, kg:0.5 },
      { name:'مخلوط معادن/فيتامينات', cat:'conc', dm:95, kg:0.15 },
      { name:'حجر جيري (كالسيوم)', cat:'conc', dm:100, kg:0.10 },
      { name:'ملح طعام', cat:'conc', dm:100, kg:0.05 },
      { name:'بيكربونات صوديوم', cat:'conc', dm:100, kg:0.10 },
      { name:'دهون محمية', cat:'conc', dm:99, kg:0.30 },
    ]},
    { key: 'tmr_percent_mid_cow', name: 'TMR نسب as-fed — حلابة متوسطة (بقر)', mode: 'tmr_percent', items: [
      { name:'سيلاج ذرة', cat:'rough', dm:33, pct:40 },
      { name:'دريس برسيم', cat:'rough', dm:90, pct:5 },
      { name:'ذرة صفراء مجروشة', cat:'conc', dm:88, pct:23 },
      { name:'ردة قمح (نخالة)', cat:'conc', dm:89, pct:10 },
      { name:'كسب فول صويا 48%', cat:'conc', dm:89, pct:12 },
      { name:'مولاس', cat:'conc', dm:75, pct:3 },
      { name:'مخلوط معادن/فيتامينات', cat:'conc', dm:95, pct:2 },
      { name:'حجر جيري (كالسيوم)', cat:'conc', dm:100, pct:2 },
      { name:'ملح طعام', cat:'conc', dm:100, pct:1 },
      { name:'بيكربونات صوديوم', cat:'conc', dm:100, pct:2 },
    ]},
    { key: 'split_conc6', name: 'منفصل — مركز 6 كجم + خشن as-fed', mode: 'split', concKg: 6, items: [
      { name:'سيلاج ذرة', cat:'rough', dm:33, kg:20 },
      { name:'دريس برسيم', cat:'rough', dm:90, kg:1 },
      { name:'ذرة صفراء مجروشة', cat:'conc', dm:88, pct:45 },
      { name:'ردة قمح (نخالة)', cat:'conc', dm:89, pct:15 },
      { name:'كسب فول صويا 48%', cat:'conc', dm:89, pct:20 },
      { name:'جلوتين فيد (CGF)', cat:'conc', dm:90, pct:5 },
      { name:'مولاس', cat:'conc', dm:75, pct:5 },
      { name:'مخلوط معادن/فيتامينات', cat:'conc', dm:95, pct:2 },
      { name:'حجر جيري (كالسيوم)', cat:'conc', dm:100, pct:2 },
      { name:'ملح طعام', cat:'conc', dm:100, pct:2 },
      { name:'بيكربونات صوديوم', cat:'conc', dm:100, pct:4 },
    ]},
  ];
 if (tplSel) {
  TEMPLATES.forEach(t=>{
    const o=document.createElement('option');
    o.value=t.key; 
    o.textContent=t.name; 
    tplSel.appendChild(o);
  });
}

  const ROUGH_HINTS = ['سيلاج','برسيم','دريس','قش','تبن','pulp','hay','silage','straw','fresh','green'];
  function guessCat(name){ const s=(name||'').toLowerCase(); return ROUGH_HINTS.some(k=> s.includes(k) ) ? 'rough':'conc'; }

  function td(label, inner, col){ const td=document.createElement('td'); if(col) td.dataset.col = col; td.setAttribute('data-label', label); td.innerHTML=inner; return td; }
  function addRow(feed={}){
    const tr = document.createElement('tr');
    const catVal = feed?.cat || guessCat(feed?.name);
    tr.appendChild(td('الخامة', `<input class="name" value="${feed?.name||''}" list="feedlist" placeholder="اكتب اسم الخامة" style="width:200px">`, 'name'));
    tr.appendChild(td('الفئة', `<select class="cat">
  <option value="rough" ${catVal==='rough'?'selected':''}>خشن</option>
  <option value="conc" ${catVal==='conc'?'selected':''}>مركز</option>
  <option value="add" ${catVal==='add'?'selected':''}>إضافات</option>
</select>`, 'cat'));
    tr.appendChild(td('المادة الجافة %', `<input class="dm" type="number" inputmode="decimal" step="0.1" value="${feed?.dm ?? ''}" placeholder="%" style="width:100px">`, 'dm'));
    tr.appendChild(td('البروتين %', `<input class="cp" type="number" inputmode="decimal" step="0.1" value="${feed?.cp ?? ''}" placeholder="%" style="width:100px">`, 'cp'));
    tr.appendChild(td('سعر الطن (as-fed)', `<input class="pTon" type="number" inputmode="decimal" step="0.01" value="${feed?.price||''}" placeholder="جنيه/طن" style="width:140px">`, 'pTon'));
    tr.appendChild(td('سعر/طن DM', `<span class="pTonDM">—</span>`, 'pTonDM'));
    tr.appendChild(td('نسبة as-fed %', `<input class="pct" type="number" inputmode="decimal" step="0.01" value="${feed?.pct||''}" placeholder="%" style="width:100px">`, 'pct'));
    tr.appendChild(td('كجم as-fed/رأس', `<input class="kg" type="number" inputmode="decimal" step="0.01" value="${feed?.kg||''}" placeholder="كجم" style="width:120px">`, 'kg'));
    tr.appendChild(td('كجم DM/رأس', `<span class="kgDM">—</span>`, 'kgDM'));
    tr.appendChild(td('تكلفة/رأس/يوم', `<span class="cost">—</span>`, 'cost'));
tbody.appendChild(tr);
    hookRow(tr);
  }

  function nf(x){ return new Intl.NumberFormat('ar-EG',{maximumFractionDigits:2}).format(x||0); }

// سعر الكيلو = سعر الطن ÷ 1000 (as-fed). لو المستخدم أدخل سعر/كجم بالخطأ (رقم صغير)، نسيبه كما هو.
function priceKgFromTon(pTon){
  const p = Number(pTon);
  if(!Number.isFinite(p) || p<=0) return 0;
  // heuristic: لو أقل من 100 غالبًا ده سعر/كجم بالفعل
  if(p < 100) return p;
  return p / 1000;
}


  function setRowState(tr){
    const mode = modeSel.value;
    const cat  = (tr.querySelector('.cat')?.value)||'conc';
    const kgEl  = tr.querySelector('.kg');
    const pctEl = tr.querySelector('.pct');
    if (mode!== 'split'){
      kgEl.disabled = (mode==='tmr_percent');
      pctEl.disabled= (mode==='tmr_asfed');
    } else {
      if (cat==='rough'){ kgEl.disabled=false; pctEl.disabled=true; }
      else { kgEl.disabled=true; pctEl.disabled=false; }
    }
    kgEl.style.opacity  = kgEl.disabled? .5 : 1;
    pctEl.style.opacity = pctEl.disabled? .5 : 1;
  }

  function isRowEmpty(tr){
    if (!tr) return true;
    const name = tr.querySelector('.name')?.value?.trim();
  // ✅ لو المستخدم اختار من datalist وضغط إضافة بسرعة قبل blur
  // املى DM/CP/السعر تلقائياً لو فاضية
  if(name){
    const f = findFeedByName(name);
    if(f){
      const dmEl = tr.querySelector('.dm');
      const cpEl = tr.querySelector('.cp');
      const pEl  = tr.querySelector('.pTon');
     if(dmEl && (dmEl.value==='' || dmEl.value==null)) dmEl.value = (f.dm ?? '');
if(cpEl && (cpEl.value==='' || cpEl.value==null)) cpEl.value = (f.cp ?? '');
      if(pEl  && (pEl.value==='' ||pEl.value==null) && (f.price!=null)) pEl.value = f.price;
    }
  }
    const kg   = tr.querySelector('.kg')?.value;
    const pct  = tr.querySelector('.pct')?.value;
    return (!name && !kg && !pct);
  }
  function focusEditable(tr){
    const mode = modeSel.value;
    const cat  = (tr.querySelector('.cat')?.value)||'conc';
    const kgEl = tr.querySelector('.kg');
    const pctEl= tr.querySelector('.pct');
    setRowState(tr);
    setTimeout(()=>{
      if (mode==='tmr_asfed'){ kgEl?.focus(); kgEl?.select?.(); }
      else if (mode==='tmr_percent'){ pctEl?.focus(); pctEl?.select?.(); }
      else { if (cat==='rough'){ kgEl?.focus(); kgEl?.select?.(); } else { pctEl?.focus(); pctEl?.select?.(); } }
    }, 0);
  }
 function fillCurrentRowWithFeed(feed, cat){
  let tr = tbody.querySelector('tr:last-child');         // السطر الوحيد
  if(!tr){
    addEmptyRow();
    tr = tbody.querySelector('tr');
  }

  // اكتب اسم الخامة
  const nameEl = tr.querySelector('.name');
  if(nameEl) nameEl.value = (feed?.name || '') || '';

  // اكتب النوع
  const catEl = tr.querySelector('.cat');
  if(catEl) catEl.value = cat || 'conc';

  // حمّل القيم الافتراضية من فايرستور (وقابلة للتعديل)
  const dmEl = tr.querySelector('.dm');
  const cpEl = tr.querySelector('.cp');
 if(dmEl) dmEl.value = (feed && feed.dm != null) ? feed.dm : '';
if(cpEl) cpEl.value = (feed && feed.cp != null) ? feed.cp : '';

  // فضّي الكمية/النسبة عشان المستخدم يدخل
  const kgEl = tr.querySelector('.kg');
  const pctEl = tr.querySelector('.pct');
  if(kgEl) kgEl.value = '';
  if(pctEl) pctEl.value = '';

  // خلّي السطر جاهز للإدخال
  setRowState(tr);
  focusEditable(tr);
}
 function ensureEditableForMode(){
  const tr = tbody.querySelector('tr:last-child');
  if(!tr) return;   // 🔥 مهم جدًا

  if (modeSel.value==='split'){
    const catEl = tr.querySelector('.cat');
    if (catEl && catEl.value!=='rough' && isRowEmpty(tr)){
      catEl.value='rough';
    }
  }

  focusEditable(tr);
}

function recalc(){
  const mode = modeSel.value;
  const concKg = parseFloat(concKgInput?.value) || 0;

  // 1) تحديث حسابات الصفوف فقط (UI row-level only)
  Array.from(tbody.querySelectorAll('tr')).forEach(tr=>{
    const dm   = parseFloat(tr.querySelector('.dm')?.value) || 0;
    const pRaw = parseFloat(tr.querySelector('.pTon')?.value) || 0;
    const pKg  = normalizeKgPrice(pRaw);
    const pTon = pKg * 1000;
    const kg   = parseFloat(tr.querySelector('.kg')?.value) || 0;

    const pDM  = (dm > 0) ? (pTon / (dm / 100)) : 0;
    const kgDM = kg * (dm / 100);
    const cost = kg * pKg;

    const pTonDMEl = tr.querySelector('.pTonDM');
    const kgDMEl   = tr.querySelector('.kgDM');
    const costEl   = tr.querySelector('.cost');

    if (pTonDMEl) pTonDMEl.textContent = pDM ? nf(pDM) : '—';
    if (kgDMEl)   kgDMEl.textContent   = kgDM ? nf(kgDM) : '—';
    if (costEl)   costEl.textContent   = cost ? nf(cost) : '—';

    setRowState(tr);
  });

  // 2) تحذيرات الإدخال فقط
  let w = '';

  if (mode === 'tmr_percent') {
    const sumPct = (window.rationItems || []).reduce((s, it) => s + (Number(it?.pct) || 0), 0);
    if (sumPct > 0 && (sumPct < 99 || sumPct > 101)) {
      w = `⚠️ مجموع نسب as-fed = ${nf(sumPct)}% (المثالي 100%)`;
    }
  }

  if (mode === 'split') {
    const concItems = (window.rationItems || []).filter(it => String(it?.cat || '') === 'conc');
    const concSumPct = concItems.reduce((s, it) => s + (Number(it?.pct) || 0), 0);
    if (concSumPct > 0 && (concSumPct < 99 || concSumPct > 101)) {
      w = `⚠️ نسب المركز = ${nf(concSumPct)}% (المثالي 100%)`;
    }
  }

  const dmMissing = Array.from(tbody.querySelectorAll('tr')).some(tr=>{
    const dm = parseFloat(tr.querySelector('.dm')?.value);
    const hasVal =
      (parseFloat(tr.querySelector('.kg')?.value) || 0) > 0 ||
      (parseFloat(tr.querySelector('.pct')?.value) || 0) > 0;
    return !dm && hasVal;
  });

  if (!w && dmMissing) {
    w = '⚠️ أدخل %DM لكل خامة لحساب التحليل بدقة.';
  }

  // 3) لا نكتب أي totals/analysis محليًا — السيرفر فقط
  Promise.resolve()
    .then(() => window.mbkNutrition?.refreshTargets?.())
    .then(() => window.mbkNutrition?.refreshRationAnalysis?.(window.rationItems || []))
    .catch(() => {})
    .finally(() => {
      warn.textContent = w;
      try { render(); } catch(e) {}
      try { renderRationSummary(); } catch(e) {}
    });
}
function hookRow(tr){
  const nameEl = tr.querySelector('.name');
  const dmEl   = tr.querySelector('.dm');
  const cpEl   = tr.querySelector('.cp');
  const pEl    = tr.querySelector('.pTon');
  const kgEl   = tr.querySelector('.kg');
  const pctEl  = tr.querySelector('.pct');
  const catEl  = tr.querySelector('.cat');

  const rmBtn = tr.querySelector('.rm');
  if(rmBtn) rmBtn.onclick = ()=>{
    tr.remove();
    recalc();
  };

  // datalist يطلق input عند الاختيار، فبنسمع input + change
  nameEl.addEventListener('input', ()=>{ applyFeedDefaults(); setRowState(tr); recalc(); });
function applyFeedDefaults(){
  const key = String(nameEl.value || '').trim();
  if(!key) return;

  const f = findFeedByName(key);
  if(!f) return;

  // المادة الجافة
  if(dmEl){
    dmEl.value = (f.dm != null) ? f.dm : '';
  }

  // البروتين
  if(cpEl){
    cpEl.value = (f.cp != null) ? f.cp : '';
  }

  // السعر
  if(pEl && (pEl.value==='' || pEl.value==null) && f.price!=null){
    pEl.value = f.price;
  }
}
nameEl.addEventListener('change', ()=>{
  applyFeedDefaults();
  setRowState(tr);
  recalc();
  ensureEditableForMode();
});
[dmEl,cpEl,pEl,kgEl,pctEl,catEl].filter(Boolean).forEach(el=>{
    el.addEventListener('input', ()=>{
      setRowState(tr);
      recalc();
    });
  });

  setRowState(tr);
}

function addEmptyRow(){
  const mode = modeSel.value;
  const cat  = (mode==='split') ? 'rough' : 'conc';
  addRow({ cat });
}
  // init
  ensureEditableForMode();
  recalc();
  // ✅ تحميل مكتبة الخامات من Firestore
  loadSpeciesFromAnimals();
 loadFeedLibrary()
  .then(()=>{ 
    try{ filterFeeds(); }catch(e){} 
  })
  .catch(err=>{
    console.error(err);
    warn.textContent = '⚠️ تعذر تحميل مكتبة الخامات من السحابة.';
  });
  document.getElementById('applyTpl')?.addEventListener('click', ()=>{
    const key = document.getElementById('tpl')?.value || '';
    const tpl = TEMPLATES.find(t=> t.key===key); if(!tpl) return;
    modeSel.value = tpl.mode;
    if (tpl.mode==='split' && typeof tpl.concKg === 'number') concKgInput.value = tpl.concKg;
    document.querySelector('#tbl tbody').innerHTML='';
    (tpl.items||[]).forEach(it=>{
      const def = FEEDS.find(x=> x.name === it.name);
      const dm  = (it.dm ?? def?.dm ?? '');
      addRow({ name:it.name, dm, cat:it.cat || (def?guessCat(def.name):'conc'), kg:it.kg, pct:it.pct });
    });
    updateModeUI(); recalc();
  });

document.getElementById('addPreset')?.addEventListener('click', ()=>{
  const tr = tbody.querySelector('tr');
  if(!tr) return;

  const name = tr.querySelector('.name')?.value?.trim();
  // ✅ لو المستخدم اختار من القائمة وضغط "إضافة" بسرعة قبل blur
if(name){
  const f0 = findFeedByName(name);
  if(f0){
    const dmEl0 = tr.querySelector('.dm');
    const cpEl0 = tr.querySelector('.cp');
    if(dmEl0 && (dmEl0.value==='' || dmEl0.value==null)) dmEl0.value = (f0.dm ?? '');
    if(cpEl0 && (cpEl0.value==='' || cpEl0.value==null)) cpEl0.value = (f0.cp ?? '');
  }
}
  const cat  = tr.querySelector('.cat')?.value || 'conc';
  const dm   = parseFloat(tr.querySelector('.dm')?.value)||0;
  const cp   = parseFloat(tr.querySelector('.cp')?.value)||0;
  const kg   = parseFloat(tr.querySelector('.kg')?.value)||0;
  const pct  = parseFloat(tr.querySelector('.pct')?.value)||0;

  if(!name){
    alert('اختر خامة أولاً');
    return;
  }

  // لو Split أو Percent لازم نسبة، لو TMR Kg لازم كجم
  const mode = modeSel.value;
  const needPct = (mode==='tmr_percent' || (mode==='split' && cat!=='rough'));
  if(needPct && !pct){ alert('ادخل نسبة as-fed'); return; }
  if(!needPct && !kg){ alert('ادخل كجم as-fed'); return; }

  // أضف/حدّث الخامة في القائمة
const idx = rationItems.findIndex(x=>x.name===name && x.cat===cat);
const pTonRaw = parseFloat(tr.querySelector('.pTon')?.value)||0;

const feedMeta = FEEDS_BY_NAME.get(normName(name)) || null;

const item = {
  name,
  cat,
  dm,
  cp,
  kg,
  pct,
  pTonRaw,

  nel:    (feedMeta && Number.isFinite(Number(feedMeta.nel)))    ? Number(feedMeta.nel)    : null,
  ndf:    (feedMeta && Number.isFinite(Number(feedMeta.ndf)))    ? Number(feedMeta.ndf)    : null,
  fat:    (feedMeta && Number.isFinite(Number(feedMeta.fat)))    ? Number(feedMeta.fat)    : null,
  starch: (feedMeta && Number.isFinite(Number(feedMeta.starch))) ? Number(feedMeta.starch) : null,
  mp:     (feedMeta && Number.isFinite(Number(feedMeta.mp)))     ? Number(feedMeta.mp)     : null
};

if(idx>=0) rationItems[idx]=item; else rationItems.push(item);
  // نظّف سطر الإدخال لخامة جديدة
  tr.querySelector('.name').value='';
  tr.querySelector('.kg').value='';
  tr.querySelector('.pct').value='';
  tr.querySelector('.dm').value='';
  tr.querySelector('.cp').value='';
  renderRationSummary();
  recalc();

try{
  document.querySelector('.controls-box')?.scrollIntoView({ behavior:'smooth', block:'start' });
  setTimeout(()=>{
    document.getElementById('feedTypeFilter')?.focus();
  }, 250);
}catch(e){}

});
  document.getElementById('clearAll')?.addEventListener('click', ()=>{
   if(confirm('مسح كل الصفوف؟')){
  tbody.innerHTML='';
  rationItems.length = 0;
  selectedRation.clear();
  renderRationSummary();
  recalc();
  document.getElementById('feedInputBox').style.display='none';
  document.getElementById('feedSummaryBox').style.display='none';
  document.getElementById('miniActions').style.display='none';
}
  
  });

  function updateModeUI(){
    const mode = modeSel.value;
    splitBox.style.display = (mode==='split')? '' : 'none';
    const showCols = new Set(
      mode==='tmr_asfed'  ? ['name','cat','dm','cp','pTon','pTonDM','kg','kgDM','cost','rm'] :
      mode==='tmr_percent'? ['name','cat','dm','cp','pTon','pTonDM','pct','rm'] :
                            ['name','cat','dm','cp','pTon','pTonDM','pct','kg','kgDM','cost','rm']
    );
    document.querySelectorAll('th').forEach(th=>{ const c=th.dataset.col; if(!c)return; th.style.display = showCols.has(c)? '':'none'; });
    document.querySelectorAll('#tbl tbody tr').forEach(tr=>{
      tr.querySelectorAll('td').forEach(td=>{ const c=td.dataset.col; if(!c)return; td.style.display = showCols.has(c)? '':'none'; });
      setRowState(tr);
    });
    document.getElementById('totalsBase').style.display  = (mode!=='split')? '' : 'none';
    document.getElementById('totalsSplit').style.display = (mode==='split')? '' : 'none';
    recalc();
  }

  modeSel.addEventListener('change', updateModeUI);
  modeSel.addEventListener('change', ensureEditableForMode);
  concKgInput.addEventListener('input', recalc);

  function getGestLen(){ return (ctxSpecies?.value==='جاموس' ? 310 : 280); }
  function applyDCCRules(){
    const dcc = parseInt(ctxDCC?.value);
    const GL = getGestLen();
    if (!isNaN(dcc)){
      const dtc = GL - dcc;
      if (dtcVal) dtcVal.textContent = isFinite(dtc)? String(dtc) : '—';
      ctxEarlyDry.checked = (dcc >= (GL - 60));
      ctxCloseUp.checked  = (dcc >= (GL - 21));
    } else {
      if (dtcVal) dtcVal.textContent = '—';
    }
  }
  ctxDCC?.addEventListener('input', applyDCCRules);
  ctxSpecies?.addEventListener('change', applyDCCRules);
  applyDCCRules();

  updateModeUI();
 const feedTypeFilter = document.getElementById('feedTypeFilter');

function classifyFeed3(f){
  const n = (f.name || '').toLowerCase();

  // إضافات
  if(n.includes('فيتامين') || n.includes('ماغنسيوم') || n.includes('بيكربونات') || n.includes('ملح') || n.includes('يوريا') || n.includes('دهون')) return 'add';

  // خشن
  if(n.includes('سيلاج') || n.includes('برسيم') || n.includes('دريس') || n.includes('قش') || n.includes('تبن')) return 'rough';

  // الباقي مركزات (حبوب/بروتين/مخلفات…)
  return 'conc';
}

function filterFeeds(){
  const type = feedTypeFilter.value || 'all';

  const filtered = FEEDS.filter(f=>{
    if(type === 'all') return true;
    return (f.cat || classifyFeed3(f)) === type;
  });

  presetSel.innerHTML = '<option value="" selected disabled>اختر خامة</option>';
  filtered.forEach(f=>{
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.name;
    presetSel.appendChild(o);
  });
}

feedTypeFilter.addEventListener('change', filterFeeds); 
// ✅ عند اختيار خامة: افتح نموذج الإدخال فورًا
presetSel.addEventListener('change', ()=>{
  const selectedType = (feedTypeFilter.value || '').trim();
  if(!selectedType || selectedType === 'all'){
    alert("اختر نوع الخامه أولاً (مركزات/خشن/إضافات)");
    presetSel.value = '';
    return;
  }

  const id = (presetSel.value || '').trim();
  if(!id) return;

  const f = FEEDS_BY_ID.get(id);
  if(!f) return;

  // ✅ بدل addRow: املأ السطر الحالي فقط
  fillCurrentRowWithFeed(f, (f.cat || selectedType));

  showFeedUI();
  recalc();
  try{ document.getElementById('feedInputBox')?.scrollIntoView({behavior:'smooth', block:'start'}); }catch(e){}

  presetSel.value = '';
});
}

// =====================
// جمع البيانات + حفظ Firestore فقط
// =====================
function collectRows(){
  const rows = [];
  document.querySelectorAll('#tbl tbody tr').forEach(tr=>{
    const get = sel => (tr.querySelector(sel)?.value ?? '').toString().trim();
    const name = get('.name'); if (!name) return;
    rows.push({
      name,
      cat : (tr.querySelector('.cat')?.value)||'conc',
      dm  : parseFloat(get('.dm'))||0,
      price: parseFloat(get('.pTon'))||0,
      kg  : parseFloat(get('.kg'))||0,
      pct : parseFloat(get('.pct'))||0,
    });
  });
  return rows;
}

function readKPIs(){
  const txt = id => (document.getElementById(id)?.textContent||'').trim();
  return {
    mode: document.getElementById('mode')?.value || 'tmr_asfed',
    mixPriceDM: txt('mixPriceDM'),
    totDM: txt('totDM'),
    totCost: txt('totCost'),
    split: {
      roughDM : txt('roughDM'),
      roughCost: txt('roughCost'),
      concDMpct: txt('concDMpct'),
      concPriceDM: txt('concPriceDM'),
      concKgAf: document.getElementById('concKgInput')?.value || '',
      concKgDM: txt('concKgDM'),
      concCost: txt('concCost'),
      totalCostAll: txt('totalCostAll'),
    }
  };
}

let __nutritionPanelsStarted = false;
function initNutritionPanels(){
  if(__nutritionPanelsStarted) return;
  __nutritionPanelsStarted = true;

  const $ = (id)=>document.getElementById(id);
  const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

  const fmt = (v, suf="")=>{
    if(v==null) return "—";
    const s=String(v).trim();
    if(!s || s==="—") return "—";
    return s + suf;
  };

  const numFromText = (t)=>{
    if(!t) return NaN;
    const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9','٫':'.','،':'.'};
    t = String(t).trim().replace(/[٠-٩٫،]/g, ch => map[ch] ?? ch);
    t = t.replace(/[^0-9.\-]/g,'');
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : NaN;
  };
  function parseMetricNumber(v){
  const s = String(v ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function titleHas(card, text){
  return String(card?.title || '').includes(text);
}

function findCard(cards, text){
  return (Array.isArray(cards) ? cards.find(c => titleHas(c, text)) : null) || null;
}

function gaugeStatus(kind, current, target, low = 0.92, high = 1.08){
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
    return { key:'na', label:'غير متاح', color:'#94a3b8', note:'لا توجد بيانات كافية' };
  }

 if (kind === 'ceiling') {
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
    return { label:'معلومة', color:'#64748b', tone:'info' };
  }

  if (current < target) {
    return { label:'آمن', color:'#16a34a', tone:'good' };
  }

  return { label:'خطر', color:'#dc2626', tone:'danger' };
}

  const ratio = current / target;
  if (ratio < low)  return { key:'danger', label:'ناقص', color:'#dc2626', note:'أقل من المطلوب بوضوح' };
  if (ratio <= high) return { key:'good', label:'مناسب', color:'#16a34a', note:'داخل النطاق المناسب' };
  if (ratio <= high * 1.12) return { key:'warn', label:'زيادة', color:'#d97706', note:'أعلى من المطلوب قليلًا' };
  return { key:'highDanger', label:'زيادة', color:'#dc2626', note:'أعلى من المطلوب بوضوح' };
}

function metricComment(key, state){
  const k = String(key || '');
  const s = String(state?.key || '');

  const map = {
    dm: {
      danger: 'إنذار: المأكول أقل من الاحتياج وقد يضغط مباشرة على إنتاج اللبن وحالة الجسم.',
      good: 'المأكول مناسب ويغطي الاحتياج بدون ضغط واضح على الأداء.',
      warn: 'المأكول أعلى قليلًا من الاحتياج؛ راجع الهدر وبواقي العليقة.',
      highDanger: 'المأكول أعلى من المطلوب بوضوح؛ غالبًا هدر اقتصادي أو خطأ في تقدير الكميات.'
    },

    nel: {
      danger: 'إنذار طاقة: العليقة لا تغطي احتياج الطاقة، وقد ينخفض اللبن أو يسحب الحيوان من جسمه.',
      good: 'الطاقة مناسبة لاحتياج الحيوان والإنتاج الحالي.',
      warn: 'الطاقة أعلى قليلًا من الاحتياج؛ راجع التكلفة قبل رفع المركزات.',
      highDanger: 'الطاقة أعلى من الاحتياج بوضوح؛ غالبًا هدر اقتصادي وقد يزيد خطر السمنة في بعض الحالات.'
    },

    cp: {
      danger: 'إنذار بروتين: البروتين الخام أقل من الاحتياج وقد يحد من الإنتاج ونشاط ميكروبات الكرش.',
      good: 'البروتين الخام مناسب لاحتياج العليقة.',
      warn: 'البروتين الخام أعلى من الاحتياج؛ غالبًا تكلفة زائدة بدون عائد إنتاجي واضح.',
      highDanger: 'البروتين الخام مرتفع بوضوح؛ هدر اقتصادي وقد يرفع حمل النيتروجين بدون فائدة إنتاجية.'
    },

    mp: {
      danger: 'إنذار مهم: البروتين الممثل أقل من الاحتياج، وهذا قد يحد من اللبن وبروتين اللبن حتى لو البروتين الخام يبدو عاليًا.',
      good: 'البروتين الممثل مناسب لاحتياج الحيوان.',
      warn: 'البروتين الممثل أعلى من المطلوب؛ راجع تكلفة مصادر البروتين المحمية أو عالية الجودة.',
      highDanger: 'البروتين الممثل أعلى من الاحتياج بوضوح؛ غالبًا هدر اقتصادي في مصادر بروتين مرتفعة الثمن.'
    },

    ndf: {
      danger: 'إنذار كرش: الألياف غير كافية، وخطر الحموضة واضطراب الاجترار وانخفاض دهن اللبن يرتفع.',
      good: 'الألياف متزنة وتدعم الكرش والاجترار.',
      warn: 'الألياف أعلى من المطلوب؛ قد تقلل استهلاك الطاقة وتضغط على الإنتاج.',
      highDanger: 'الألياف مرتفعة بوضوح؛ قد تخفض كثافة الطاقة وتحد من إنتاج اللبن.'
    },

    starch: {
      danger: 'إنذار حموضة: النشا أعلى من الحد الآمن وقد يرفع خطر الحموضة وانخفاض دهن اللبن والعرج.',
      good: 'النشا ضمن الحد الآمن للعليقة.',
      warn: 'النشا قريب من الحد؛ راقب الخشن والألياف المؤثرة وطول التقطيع.',
      highDanger: 'إنذار حاد: النشا مرتفع بوضوح، وخطر الحموضة واضطراب الكرش أعلى.'
    },

    fat: {
      danger: 'إنذار دهن: دهن العليقة أعلى من الحد وقد يثبط تخمر الكرش ويقلل هضم الألياف.',
      good: 'دهن العليقة ضمن الحد الآمن.',
      warn: 'الدهن قريب من الحد؛ راجع مصادر الدهون ونسبة الإضافات.',
      highDanger: 'إنذار حاد: الدهن مرتفع بوضوح وقد يضر تخمر الكرش وهضم الألياف.'
    }
  };

  return (map[k] && map[k][s]) || state?.note || '';
}

function gaugeScaleMax(kind, current, target){
  const c = Number.isFinite(current) ? current : 0;
  const t = Number.isFinite(target) ? target : 0;
  if (kind === 'ceiling') return Math.max(t * 1.25, c * 1.10, 1);
  return Math.max(t * 1.35, c * 1.10, 1);
}

function gaugePos(value, max){
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

function gaugePoint(cx, cy, r, pos){
  const p = Math.max(0, Math.min(1, Number(pos) || 0));
  const a = Math.PI * (1 - p); // 0 = يسار ، 1 = يمين على نصف الدائرة العلوي
  return {
    x: cx + r * Math.cos(a),
    y: cy - r * Math.sin(a)
  };
}

function arcPath(cx, cy, r, fromPos, toPos){
  const s = gaugePoint(cx, cy, r, fromPos);
  const e = gaugePoint(cx, cy, r, toPos);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 0 1 ${e.x} ${e.y}`;
}

function buildGaugeSvg(kind, current, target, state){
  const max = gaugeScaleMax(kind, current, target);
  const pos = gaugePos(current, max);

  const cx = 80, cy = 84, r = 58;
  const stroke = 22;

  // تقسيم واضح جدًا مثل عداد الساعة
 const redTo = 0.33;
const yellowTo = 0.66;

let arc1 = '';
let arc2 = '';
let arc3 = '';

if (kind === 'ceiling') {
  const limitPos = gaugePos(target, max);

  arc1 = `<path d="${arcPath(cx, cy, r, 0, limitPos)}" fill="none" stroke="#84d983" stroke-width="${stroke}" stroke-linecap="butt"></path>`;
  arc2 = `<path d="${arcPath(cx, cy, r, limitPos, 1)}" fill="none" stroke="#ff1a12" stroke-width="${stroke}" stroke-linecap="butt"></path>`;
  arc3 = '';
} else {
  // في مؤشرات الاحتياج: منخفض = خطر، وسط = تحذير، يمين = جيد
  arc1 = `<path d="${arcPath(cx, cy, r, 0, redTo)}" fill="none" stroke="#ff1a12" stroke-width="${stroke}" stroke-linecap="butt"></path>`;
  arc2 = `<path d="${arcPath(cx, cy, r, redTo, yellowTo)}" fill="none" stroke="#f3c754" stroke-width="${stroke}" stroke-linecap="butt"></path>`;
  arc3 = `<path d="${arcPath(cx, cy, r, yellowTo, 1)}" fill="none" stroke="#84d983" stroke-width="${stroke}" stroke-linecap="butt"></path>`;
}
  const tip = gaugePoint(cx, cy, r - 8, pos);

  // قاعدة الإبرة أسمك وتعطي شكل عداد محترم
  const baseLeft = { x: cx - 5, y: cy + 1 };
  const baseRight = { x: cx + 5, y: cy + 1 };

  return `
    <svg viewBox="0 0 160 108" width="160" height="108" aria-hidden="true">
     ${arc1}
${arc2}
${arc3}

      <circle cx="${cx}" cy="${cy}" r="35" fill="#ffffff"></circle>

      <path d="M ${baseLeft.x} ${baseLeft.y} L ${tip.x} ${tip.y} L ${baseRight.x} ${baseRight.y} Z"
            fill="#111111"></path>

      <circle cx="${cx}" cy="${cy}" r="6.5" fill="#111111"></circle>
      <circle cx="${cx}" cy="${cy}" r="2.6" fill="#ffffff"></circle>
    </svg>
  `;
}
function renderGaugeRows(cards){
  const defs = [
    { key:'dm',     label:'المادة الجافة',           current:'العليقة الحالية — مادة جافة',        target:'احتياجات المادة الجافة',           unit:'كجم',     kind:'target'  },
    { key:'nel',    label:'الطاقة',                  current:'العليقة الحالية — طاقة',            target:'احتياجات الطاقة',                  unit:'ميجاكال', kind:'target'  },
    { key:'cp',     label:'البروتين الخام',          current:'العليقة الحالية — بروتين خام',       target:'احتياجات البروتين الخام',          unit:'%',       kind:'target'  },
    { key:'mp',     label:'البروتين الممثل',         current:'العليقة الحالية — البروتين الممثل',  target:'احتياجات البروتين الممثل',         unit:'جم/يوم',  kind:'target'  },
    { key:'ndf',    label:'الألياف NDF',            current:'العليقة الحالية — ألياف NDF',       target:'احتياجات الألياف NDF',            unit:'%',       kind:'target'  },
    { key:'starch', label:'النشا',                  current:'العليقة الحالية — نشا',              target:'الحد الأقصى للنشا',                unit:'%',       kind:'ceiling' },
    { key:'fat',    label:'دهن العليقة',            current:'العليقة الحالية — دهن',              target:'الحد المسموح به لدهن العليقة',     unit:'%',       kind:'ceiling' }
  ];

  const rows = defs.map(def => {
    const currentCard = findCard(cards, def.current);
    const targetCard = findCard(cards, def.target);

    if (!currentCard || !targetCard) return '';

    const current = parseMetricNumber(currentCard.value);
    const target = parseMetricNumber(targetCard.value);
    const state = gaugeStatus(def.kind, current, target);
    const comment = metricComment(def.key, state);

    return `
      <div class="mbk-gauge-row" style="background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:12px 12px 10px;margin:0 0 12px 0;box-shadow:0 2px 10px rgba(15,23,42,.05)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
          <div style="font-weight:800;font-size:15px;color:#0f172a">${def.label}</div>
          <span style="font-size:12px;font-weight:800;color:${state.color};background:#f8fafc;border:1px solid #e5e7eb;border-radius:999px;padding:4px 10px">${state.label}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 160px 1fr;align-items:center;gap:8px">
          <div style="text-align:right">
            <div style="font-size:11px;color:#64748b">العليقة الحالية</div>
            <div style="font-size:15px;font-weight:800;color:#0f172a">${currentCard.value || '—'}</div>
          </div>

          <div style="display:flex;justify-content:center">${buildGaugeSvg(def.kind, current, target, state)}</div>

          <div style="text-align:left">
            <div style="font-size:11px;color:#64748b">${def.kind === 'ceiling' ? 'الحد' : 'الاحتياج'}</div>
            <div style="font-size:15px;font-weight:800;color:#0f172a">${targetCard.value || '—'}</div>
          </div>
        </div>

        <div style="margin-top:6px;font-size:12px;line-height:1.45;color:#475569">${comment}</div>
      </div>
    `;
  }).filter(Boolean);

  return rows.join('');
}
window.renderNutritionPanels = function renderNutritionPanels(){
    const vm = window.mbkNutrition?.serverViewModel || {};
  const P  = vm.panels || {};
  const panelByKey = (arr, key) =>
    (Array.isArray(arr) ? arr.find(x => x?.key === key) : null) || null;
  const sec = document.getElementById("analysisSection");
  if(sec) sec.style.display = "block";

  const toNum = (txt)=>{
    const s=String(txt||"").replace(/[^\d.\-]/g,"");
    const n=parseFloat(s);
    return isFinite(n)?n:null;
  };

  const kpiState = (actual, target, tol)=>{
    if(actual==null || target==null) return {sym:"—", color:"#64748b"};
    const a=Number(actual), t=Number(target);
    if(!isFinite(a) || !isFinite(t)) return {sym:"—", color:"#64748b"};
    const d = a - t;
    const band = (tol!=null?Number(tol):0);
    if(Math.abs(d) <= band) return {sym:"●", color:"#0b7f47"};
    if(d < -band) return {sym:"▼", color:"#c62828"};
    return {sym:"▲", color:"#f57c00"};
  };

const n = $("nutritionKPIs");
if(n){
  const items = [
    ["المادة الجافة", fmt($("totDM")?.textContent, " كجم")],
    ["المأكول الكلي", fmt($("totAsFed")?.textContent, " كجم")],
    ["البروتين الخام CP", fmt($("cpPctTotal")?.textContent, "%")],
    ["البروتين الممثل MP", fmt($("mpSupplyG")?.textContent, " جم/يوم")],
    ["صحة الكرش", fmt($("fcRatio")?.textContent, "")]
  ];
  n.innerHTML = items.map(([k,v])=>{
    let st = {sym:"—", color:"#64748b"};

    if(k==="المادة الجافة"){
      st = kpiState(toNum($("totDM")?.textContent), toNum($("dmiTarget")?.textContent), 0.5);

    }else if(k==="البروتين الخام CP"){
      const cpTargetEl = document.getElementById("cpTarget");
      const cpTarget = cpTargetEl ? toNum(cpTargetEl.textContent) : NaN;
      st = Number.isFinite(cpTarget)
        ? kpiState(toNum($("cpPctTotal")?.textContent), cpTarget, 1.0)
        : {sym:"—", color:"#64748b"};

    }else if(k==="البروتين الممثل MP"){
      st = kpiState(toNum($("mpSupplyG")?.textContent), toNum($("mpTargetG")?.textContent), 50);

    }else if(k==="صحة الكرش"){
      st = {sym:"●", color:"#0b7f47"};
    }

    return '<div class="kpi"><div class="k">'+k+'</div><div class="vrow"><div class="v">'+v+'</div><div class="arr" style="color:'+st.color+'">'+st.sym+'</div></div></div>';
  }).join("");
}
  const e = $("economicKPIs");
  if(e){
    const items = [
      ["التكلفة/رأس", fmt($("totCost")?.textContent, "") !== "—" ? (fmt($("totCost")?.textContent, "") + " ج") : "—"],
      ["تكلفة كجم لبن", fmt($("costPerKgMilk")?.textContent, "") !== "—" ? (fmt($("costPerKgMilk")?.textContent, "") + " ج/كجم") : "—"],
      ["كفاءة تحويل العلف", fmt($("dmPerKgMilk")?.textContent, "") !== "—" ? ("1 كجم مادة جافة → " + fmt($("dmPerKgMilk")?.textContent, "") + " كجم لبن") : "—"],
      ["سعر طن العليقة", fmt($("mixPriceAsFed")?.textContent, "") !== "—" ? (fmt($("mixPriceAsFed")?.textContent, "") + " ج/طن as-fed") : "—"],
      ["هامش لبن-علف", fmt($("milkMargin")?.textContent, "") !== "—" ? (fmt($("milkMargin")?.textContent, "") + " ج") : "—"],
    ];
    e.innerHTML = items.map(([k,v])=>('<div class="kpi"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>')).join("");
  }

  const adv = $("advancedKPIs");
if (adv && adv.style.display === "block") {
  const cards = Array.isArray(window.mbkNutrition?.serverViewModel?.panels?.advancedCards)
    ? window.mbkNutrition.serverViewModel.panels.advancedCards
    : [];

  adv.innerHTML = renderGaugeRows(cards);
}

  try { window.enhanceNutritionPanels?.(); } catch(_) {}
};
  window.render = window.renderNutritionPanels;
  window.renderNutritionPanels = window.render;

  window.enhanceNutritionPanels = function enhanceNutritionPanels(){
    const root = $('#analysisSection') || document;
    const cards = $$('.kpi', root);
    if(!cards.length) return;

    const ensureBadge = (card)=>{
      let b = card.querySelector('.kpi-badge');
      if(!b){
        b = document.createElement('span');
        b.className = 'kpi-badge';
        b.innerHTML = '<span class="dot"></span><span class="txt">—</span>';
        const k = card.querySelector('.k');
        if(k) k.appendChild(b);
        else card.prepend(b);
      }
      let m = card.querySelector('.kpi-meter');
      if(!m){
        m = document.createElement('div');
        m.className = 'kpi-meter';
        m.innerHTML = '<span></span>';
        card.appendChild(m);
      }
      let h = card.querySelector('.kpi-hint');
      if(!h){
        h = document.createElement('div');
        h.className = 'kpi-hint';
        h.textContent = '';
        card.appendChild(h);
      }
      return b;
    };

    const setStatus = (card, status, badgeText, hintText, meterPct)=>{
      card.classList.remove('ok','warn','bad');
      if(status) card.classList.add(status);
      const b = ensureBadge(card);
      const txt = b.querySelector('.txt');
      if(txt) txt.textContent = badgeText || '—';
      const hint = card.querySelector('.kpi-hint');
      if(hint) hint.textContent = hintText || '';
      const bar = card.querySelector('.kpi-meter > span');
      if(bar && Number.isFinite(meterPct)){
        const p = Math.max(0, Math.min(100, meterPct));
        bar.style.width = p.toFixed(0) + '%';
      }
    };

    const labelOf = (card)=>{
      const k = card.querySelector('.k');
      return (k ? k.textContent : card.textContent).trim();
    };
    const valueOf = (card)=>{
      const v = card.querySelector('.v');
      return numFromText(v ? v.textContent : '');
    };
    const findCardByLabelIncludes = (root, includes)=>{
      const arr = $$('.kpi', root);
      for(const c of arr){
        const lab = labelOf(c);
        if(includes.every(x => lab.includes(x))) return c;
      }
      return null;
    };

    const fcCard = findCardByLabelIncludes(root, ['صحة الكرش']);
    const fcRatioEl = document.getElementById("fcRatio");
  
if(fcCard){
  const rumenCard =
    (Array.isArray(window.mbkNutrition?.serverViewModel?.panels?.analysisCards)
      ? window.mbkNutrition.serverViewModel.panels.analysisCards.find(x => x?.key === 'rumen')
      : null) || null;

  const serverNote = String(fcRatioEl?.dataset?.rumenNote || "").trim();
  const txt = String(fcRatioEl?.textContent || "").trim();
  const m = txt.match(/خشن\s+(\d+(?:\.\d+)?)%\s*\/\s*مركز\s+(\d+(?:\.\d+)?)%/);
  const roughPct = m ? Number(m[1]) : NaN;
  const concPct  = m ? Number(m[2]) : NaN;
  const detail = (Number.isFinite(roughPct) && Number.isFinite(concPct))
    ? `خشن ${Math.round(roughPct)}% / مركز ${Math.round(concPct)}%`
    : txt;

  const status = String(rumenCard?.status || '').trim();

  if (status === 'danger') {
    setStatus(fcCard, 'bad', 'خطر', serverNote || detail, 25);
  } else if (status === 'warn') {
    setStatus(fcCard, 'warn', 'تحذير', serverNote || detail, 45);
  } else if (status === 'good') {
    setStatus(fcCard, 'ok', 'مناسب', serverNote || detail, 85);
  } else {
    setStatus(fcCard, '', 'معلومة', serverNote || detail, 0);
  }
}

 const pairConfigs = [
  [['العليقة الحالية','مادة جافة'], ['احتياجات','المادة الجافة'], 'كجم', 0.92, 1.05],
  [['العليقة الحالية','بروتين خام'], ['احتياجات','البروتين الخام'], '%', null, null],
  [['العليقة الحالية','البروتين الممثل'], ['احتياجات','البروتين الممثل'], 'جم', 0.92, 1.08],
  [['العليقة الحالية','ألياف NDF'], ['احتياجات','الألياف NDF'], '%', null, null],
  [['العليقة الحالية','دهن'], ['الحد المسموح','دهن'], '%', null, null],
  [['العليقة الحالية','طاقة'], ['احتياجات','الطاقة'], '', 0.95, 1.06],
];

    for(const [actualKeys, targetKeys, unit, lowOk, highOk] of pairConfigs){
      const aCard = findCardByLabelIncludes(root, actualKeys);
      const tCard = findCardByLabelIncludes(root, targetKeys);
      if(!aCard || !tCard) continue;
      const a = valueOf(aCard), t = valueOf(tCard);
      if(!Number.isFinite(a) || !Number.isFinite(t) || t===0) continue;
      const diff = a - t;
      const ratio = a/(t||1);
      const meter = 100*Math.min(1.2, Math.max(0, ratio));
      if(unit==='%' && Math.abs(diff) <= (actualKeys[1].includes('بروتين') ? 0.3 : actualKeys[1].includes('دهن') ? 0.4 : 2.0)) setStatus(aCard,'ok','مناسب', `فرق ${diff.toFixed(1)}${unit}`, meter);
      else if(unit==='%' && Math.abs(diff) <= (actualKeys[1].includes('بروتين') ? 0.8 : actualKeys[1].includes('دهن') ? 0.8 : 4.0)) setStatus(aCard,'warn', diff<0?'ناقص':'زيادة', `فرق ${diff.toFixed(1)}${unit}`, meter);
      else if(lowOk!=null && highOk!=null){
        if(ratio >= lowOk && ratio <= highOk) setStatus(aCard,'ok','مناسب', `فرق ${diff.toFixed(unit==='كجم'?2:1)} ${unit}`.trim(), meter);
        else if(ratio < lowOk) setStatus(aCard,'warn','ناقص', `نقص ${Math.abs(diff).toFixed(unit==='كجم'?2:1)} ${unit}`.trim(), meter);
        else if(ratio <= (highOk + 0.07)) setStatus(aCard,'warn','زيادة', `زيادة ${Math.abs(diff).toFixed(unit==='كجم'?2:1)} ${unit}`.trim(), meter);
        else setStatus(aCard,'bad', ratio<1 ? 'ناقص جدًا':'زيادة كبيرة', `فرق ${diff.toFixed(unit==='كجم'?2:1)} ${unit}`.trim(), meter);
      }else{
        setStatus(aCard,'bad', diff<0?'ناقص جدًا':'زيادة كبيرة', `فرق ${diff.toFixed(1)}${unit}`, meter);
      }
      setStatus(tCard,'', 'هدف', '', 100);
    }

    for(const c of cards){
      if(!c.classList.contains('ok') && !c.classList.contains('warn') && !c.classList.contains('bad')){
        const b = ensureBadge(c);
        const txt = b.querySelector('.txt');
        if(txt && (txt.textContent==='—' || txt.textContent.trim()==='')) txt.textContent = 'معلومة';
        const hint = c.querySelector('.kpi-hint'); if(hint) hint.textContent = '';
        const bar = c.querySelector('.kpi-meter > span'); if(bar) bar.style.width = '0%';
      }
    }
  };

  window.render();
}
function parseUiNumber(v){
  if(v===null || v===undefined) return null;
  let s = String(v).trim();
  if(!s || s==='—') return null;

  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9','٫':'.','،':'.'};
  s = s.replace(/[٠-٩٫،]/g, ch => map[ch] ?? ch);
  s = s.replace(/[^\d.\-]/g,'');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanDeep(obj){
  if(Array.isArray(obj)){
    return obj
      .map(cleanDeep)
      .filter(v => v !== undefined);
  }

  if(obj && typeof obj === 'object'){
    const out = {};
    Object.entries(obj).forEach(([k,v])=>{
      const vv = cleanDeep(v);
      if(vv === undefined) return;
      if(typeof vv === 'object' && !Array.isArray(vv) && vv && Object.keys(vv).length === 0) return;
      if(Array.isArray(vv) && vv.length === 0) return;
      out[k] = vv;
    });
    return out;
  }

  if(obj === '' || obj === '—' || obj === null || obj === undefined) return undefined;
  return obj;
}

function estimateBodyWeightFromContext(ctx = {}){
  const species = String(ctx.species || '').trim();
  const breed = String(ctx.breed || '').toLowerCase();
  const dim = Number(ctx.daysInMilk);
  const milk = Number(ctx.avgMilkKg);
  const closeUp = !!ctx.closeUp;
  const earlyDry = !!ctx.earlyDry;

  const isBuffalo =
    species.includes('جاموس') ||
    breed.includes('buffalo') ||
    breed.includes('murrah') ||
    breed.includes('مورا');

  if (isBuffalo) {
    let bw = 580;

    if (
      breed.includes('murrah') ||
      breed.includes('مورا') ||
      breed.includes('ايطالي') ||
      breed.includes('إيطالي') ||
      breed.includes('italian')
    ) {
      bw = 650;
    }

    if (earlyDry || closeUp) bw += 25;
    if (Number.isFinite(milk) && milk >= 14) bw += 20;

    return Math.round(bw);
  }

  let bw = 600;

  if (
    breed.includes('holstein') ||
    breed.includes('هولشتاين') ||
    breed.includes('فريزيان') ||
    breed.includes('friesian')
  ) {
    bw = 620;
  } else if (
    breed.includes('بلدي') ||
    breed.includes('local') ||
    breed.includes('native')
  ) {
    bw = 450;
  } else if (
    breed.includes('خليط') ||
    breed.includes('cross')
  ) {
    bw = 550;
  }

  if (earlyDry || closeUp) bw += 20;
  if (Number.isFinite(dim) && dim > 0 && dim <= 45) bw -= 20;
  if (Number.isFinite(milk) && milk >= 35) bw += 20;

  return Math.round(bw);
}

function estimateBCSFromContext(ctx = {}){
  const dim = Number(ctx.daysInMilk);
  const closeUp = !!ctx.closeUp;
  const earlyDry = !!ctx.earlyDry;

  if (closeUp) return 3.50;
  if (earlyDry) return 3.25;
  if (Number.isFinite(dim) && dim > 0 && dim <= 45) return 2.75;

  return 3.00;
}
function readContext(){
  const getNum = (id) => {
    const v = document.getElementById(id)?.value;
    const n = parseUiNumber(v);
    return Number.isFinite(n) ? n : null;
  };

  const getSel = (id) => String(document.getElementById(id)?.value || '').trim();

  const species = getSel('ctxSpecies');
  const breed = getSel('ctxBreed') || String(window.currentAnimal?.breed || '').trim();

  const dcc = getNum('ctxDCC');
  const gest = (species === 'جاموس') ? 310 : 280;
  const daysToCalving = Number.isFinite(dcc) ? (gest - dcc) : null;
  const earlyDry = !!(document.getElementById('ctxEarlyDry')?.checked);
  const closeUp = !!(document.getElementById('ctxCloseUp')?.checked);
  const isDry = earlyDry || closeUp;
  const manualBodyWeight = parseUiNumber(document.getElementById('ctxBodyWeight')?.value || null);
  const animalBodyWeight = parseUiNumber(window.currentAnimal?.bodyWeight ?? window.currentAnimal?.weight ?? null);

  const manualBCS = parseUiNumber(document.getElementById('ctxBCS')?.value || null);
  const animalBCS = parseUiNumber(window.currentAnimal?.bcs ?? null);

  const baseCtx = {
    species,
    breed,

    parity: parseUiNumber(
      document.getElementById('ctxParity')?.value ||
      window.currentAnimal?.parity ||
      window.currentAnimal?.lactationNumber ||
      null
    ),

    dietNDFPct: parseUiNumber(
      document.getElementById('ctxDietNDFPct')?.value || null
    ),

    daysInMilk: getNum('ctxDIM'),
    avgMilkKg: isDry ? 0 : getNum('ctxAvgMilk'),
    milkFatPct: isDry ? null : parseUiNumber(document.getElementById('ctxMilkFat')?.value || null),
    milkProteinPct: isDry ? null : parseUiNumber(document.getElementById('ctxMilkProtein')?.value || null),
    milkPrice: isDry ? null : parseUiNumber(document.getElementById('ctxMilkPrice')?.value || null),

    earlyDry,
    closeUp,
    pregnancyStatus: getSel('ctxPreg'),
    pregnancyDays: dcc,
    daysToCalving,
    thi: currentWeatherTHI,
    tempC: currentWeatherTempC,
    humidity: currentWeatherHumidity
  };

  const bodyWeight =
    Number.isFinite(manualBodyWeight) ? manualBodyWeight :
    Number.isFinite(animalBodyWeight) ? animalBodyWeight :
    estimateBodyWeightFromContext(baseCtx);

  const bcs =
    Number.isFinite(manualBCS) ? manualBCS :
    Number.isFinite(animalBCS) ? animalBCS :
    estimateBCSFromContext(baseCtx);

  return {
    ...baseCtx,

    bodyWeight,
    bcs,

    bodyWeightSource:
      Number.isFinite(manualBodyWeight) ? 'manual' :
      Number.isFinite(animalBodyWeight) ? 'animal_doc' :
      'estimated',

    bcsSource:
      Number.isFinite(manualBCS) ? 'manual' :
      Number.isFinite(animalBCS) ? 'animal_doc' :
      'estimated',

    bodyWeightEstimated: !Number.isFinite(manualBodyWeight) && !Number.isFinite(animalBodyWeight),
    bcsEstimated: !Number.isFinite(manualBCS) && !Number.isFinite(animalBCS)
  };
}
async function saveToServer(payload){
  const { auth } = await import('/js/firebase-config.js');

  const uid = auth?.currentUser?.uid;
  if(!uid) throw new Error('NO_AUTH');

  const API_BASE = window.API_BASE || '';
  const res = await fetch(`${API_BASE}/api/nutrition/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': uid
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if(!res.ok || data?.ok === false){
    throw new Error(data?.error || `HTTP ${res.status}`);
  }

  return data;
}
window.readContext = readContext;
function redirectSmart(delay = 250){
  const to = (document.querySelector('form[data-redirect]')?.dataset?.redirect) || '/dashboard.html';
  setTimeout(()=>{ location.href = to; }, delay);
}

async function saveEvent(e){
  e?.preventDefault?.();

  const { rawNumber, nums, eventDate } = readUrlCtx();
  const mode = (qp().get('mbkMode') || '').toString().trim().toLowerCase();
  const isGroupMode = (mode === 'group' && Array.isArray(nums) && nums.length > 0);

  const animalId = String(rawNumber || '').trim();

  if(!animalId && !isGroupMode){
   showCentralMsg('⚠️ لا يمكن الحفظ بدون رقم الحيوان/المجموعة في الرابط.', 'error');
    return;
  }

  if(
    (document.getElementById('ctxSpecies')?.value || '') === '' &&
    (document.getElementById('ctxDIM')?.value || '') === '' &&
    (document.getElementById('ctxAvgMilk')?.value || '') === ''
  ){
   showCentralMsg('⚠️ تم منع الحفظ: لم يتم تحميل بيانات السياق.', 'error');
    return;
  }

  let rows = [];
  if (Array.isArray(window.rationItems) && window.rationItems.length) {
    rows = window.rationItems;
  } else {
    rows = collectRows();
  }

  if (!rows.length) {
   showCentralMsg('⚠️ لا يمكن الحفظ بدون خامات في العليقة.', 'error');
    return;
  }

  const payload = cleanDeep({
    animalNumber: isGroupMode ? null : animalId,
    eventDate,
    isGroup: isGroupMode,
    eventType: isGroupMode ? 'تغذية مجموعة' : 'تغذية',
    type: isGroupMode ? 'nutrition_group' : 'nutrition',

    groupNumbers: isGroupMode ? nums.map(x => String(x).trim()).filter(Boolean) : null,
    groupSize: isGroupMode ? nums.length : null,

    nutrition: {
      mode: (document.getElementById('mode')?.value || 'tmr_asfed'),
      rows,
      context: readContext(),
      concKg: parseUiNumber(document.getElementById('concKgInput')?.value || null),
     milkPrice: parseUiNumber(document.getElementById('ctxMilkPrice')?.value || null)
    }
  });

  disableSave(true);
  showCentralMsg('⏳ جارٍ الحفظ...', 'info');

  try{
    
   await saveToServer(payload);

const ctx = readContext();
const groupName = String(ctx?.group || '').trim();

const successMsg = isGroupMode
  ? `✅ تم حفظ تغذية مجموعة "${groupName || 'بدون اسم'}"`
  : `✅ تم حفظ تغذية الحيوان رقم ${animalId}`;

showCentralMsg(successMsg, 'success');
window.dispatchEvent(
  new CustomEvent('mbk:success', {
    detail: { message: successMsg }
  })
);
redirectSmart(900);
  }catch(err){
    console.error(err);
    disableSave(false);
   showCentralMsg('❌ فشل الحفظ على السحابة.', 'error');
  }
}
async function waitForAuthReady(timeoutMs = 5000){
  const { auth } = await import('/js/firebase-config.js');
  const fa = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const { onAuthStateChanged } = fa;

  return await new Promise(resolve=>{
    let done = false;
    const t = setTimeout(()=>{
      if(done) return;
      done = true;
      resolve(auth?.currentUser || null);
    }, timeoutMs);

    const unsub = onAuthStateChanged(auth, (user)=>{
      if(done) return;
      done = true;
      clearTimeout(t);
      try{ unsub(); }catch(_){}
      resolve(user || null);
    });
  });
}
// =====================
// Bind
// =====================
(function bind(){
 const form = document.getElementById('nutritionForm');
if (form) {
  form.addEventListener('mbk:valid', saveEvent);
 
}

 const btn = document.getElementById('saveEvent');
if (btn) {
  btn.type = 'submit';
}
try{
  setHiddenCtxFromQuery();
  updateCtxView();
  disableSave(true);

const formNumEl  = document.getElementById('animalNumber');
const formDateEl = document.getElementById('eventDate');
const formIdEl   = document.getElementById('animalId');

  const p = new URLSearchParams(location.search);
  const initialNum =
    String(
      p.get('animalNumber') ||
      p.get('number') ||
      p.get('animalId') ||
      ''
    ).trim();

  const initialDate =
    String(
      p.get('eventDate') ||
      p.get('date') ||
      ''
    ).trim();

  if (formNumEl) {
    formNumEl.value = initialNum;
    formNumEl.disabled = false;
  }

  if (formDateEl) {
    formDateEl.value = initialDate;
    formDateEl.disabled = false;
  }

  if (formIdEl) {
    formIdEl.value = initialNum;
    formIdEl.disabled = false;
  }

  waitForAuthReady().then(user=>{
    if(!user){
      disableSave(true);
      msgWarn('⚠️ يلزم تسجيل الدخول أولاً.');
      return;
    }
    Promise.resolve(loadCtxAuto())
      .then(() => refreshTargets())
      .then(() => initNutritionUI())
      .catch(err => {
        console.error(err);
        disableSave(true);
        showCentralMsg('⚠️ تعذر تهيئة صفحة التغذية.', 'error');
      });
  });
}catch(e){
    console.error(e);
    disableSave(true);
    msgWarn('⚠️ تعذر تهيئة الصفحة.');
  }
})();
window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.refreshTargets = refreshTargets;
window.mbkNutrition.refreshRationAnalysis = refreshRationAnalysis;
window.mbkNutrition.readContext = readContext;

window.mbkNutrition.initNutritionUI = initNutritionUI;
