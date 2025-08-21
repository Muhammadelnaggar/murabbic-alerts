// منطق الحفظ + إطلاق التتبّع (لا يغيّر واجهتك)
const Q = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));

// 1) قراءة سياق animalId/date من الـURL ثم التخزين المحلي
function deriveCtx(){
  const p = new URLSearchParams(location.search);
  const pick = (...keys)=>{ for(const k of keys){ const v=p.get(k); if(v) return v; } return ''; };
  const animalId = pick('animalId','number','animalNumber','id') || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
  let eventDate  = pick('eventDate','date','dt','Date') || localStorage.getItem('eventDate') || localStorage.getItem('lastEventDate') || '';
  if(!eventDate){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); eventDate=d.toISOString().slice(0,10); }
  try{
    if(animalId) ['lastAnimalId','currentAnimalId','ctxAnimalId'].forEach(k=>localStorage.setItem(k,animalId));
    if(eventDate) ['lastEventDate','eventDate','Date','dt'].forEach(k=>localStorage.setItem(k,eventDate));
  }catch{}
  return { animalId, eventDate };
}

// 2) تجميع الصفوف + مؤشرات الـKPIs من الـDOM الحالي (لا نغيّر حساباتك)
function collectRows(){
  return $$('#tbl tbody tr').map(tr=>({
    name : tr.querySelector('.name')?.value?.trim() || '',
    cat  : tr.querySelector('.cat')?.value || 'conc',
    dm   : parseFloat(tr.querySelector('.dm')?.value) || 0,
    price: parseFloat(tr.querySelector('.pTon')?.value) || 0,
    pct  : parseFloat(tr.querySelector('.pct')?.value) || 0,
    kg   : parseFloat(tr.querySelector('.kg')?.value)  || 0,
  })).filter(r=>r.name);
}
function textNum(id){ const v=Q('#'+id)?.textContent?.replace(/[^\d.,-]/g,''); return v? parseFloat(v.replace(',','.')): null; }
function collectKPIs(mode){
  return {
    mode,
    mixPriceDM: textNum('mixPriceDM'),
    totDM     : textNum('totDM'),
    totCost   : textNum('totCost'),
    split: {
      roughDM     : textNum('roughDM'),
      roughCost   : textNum('roughCost'),
      concDMpct   : Q('#concDMpct')?.textContent || null,
      concPriceDM : textNum('concPriceDM'),
      concKgAf    : Q('#concKgInput')?.value || '',
      concKgDM    : textNum('concKgDM'),
      concCost    : textNum('concCost'),
      totalCostAll: textNum('totalCostAll')
    }
  };
}

// 3) إرسال للـAPI مع fallback إلى Firestore لو لزم
async function postToAPI(payload){
  const API_BASE=(localStorage.getItem('API_BASE')||'').replace(/\/$/,'');
  const url=(API_BASE?API_BASE:'')+'/api/events';
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error('API failed: '+r.status);
  return r.json().catch(()=>({}));
}
async function saveToFirestoreFallback(payload){
  const cfg=await import('/js/firebase-config.js');
  const firebaseConfig=cfg.default||cfg.firebaseConfig||cfg.config;
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
  const { getFirestore, collection, addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
  const app=initializeApp(firebaseConfig); const db=getFirestore(app);
  await addDoc(collection(db,'events'),{...payload,createdAt:serverTimestamp()});
}

// 4) تتبّع
import { onNutritionPrefill, onNutritionSave } from '/js/track-nutrition.js';

// 5) تهيئة الصفحة + ربط زر/فورم الحفظ
(function init(){
  const ctx = deriveCtx();

  // prefill للتتبّع الذكي
  try{ onNutritionPrefill({ animalId: ctx.animalId, date: ctx.eventDate, source: location.pathname.slice(1) }); }catch{}

  // اربط الحفظ (الفورم عندك اسمه #nutritionForm وفيه data-event="nutrition")
  const form = Q('form[data-event="nutrition"]') || Q('#nutritionForm') || Q('form');
  if(form){
    form.addEventListener('submit', onSave);
  }
  const btn = Q('#saveEvent') || Q('[data-action="save-event"]');
  if(btn && form){
    btn.addEventListener('click', (e)=>{ e.preventDefault(); form.requestSubmit(); });
  }
})();

async function onSave(e){
  e?.preventDefault?.();
  const ctx = deriveCtx();

  if(!localStorage.getItem('userId')){
    alert('⚠️ يجب تسجيل الدخول أولًا.');
    location.href = 'login.html';
    return;
  }

  const mode = (Q('#mode')?.value || 'TMR').toUpperCase();
  const rows = collectRows();
  const kpis = collectKPIs(mode);
  const context = {
    species: Q('#ctxSpecies')?.value || null,
    daysInMilk: Q('#ctxDIM')?.value ? parseInt(Q('#ctxDIM').value) : null,
    avgMilkKg: Q('#ctxAvgMilk')?.value ? parseFloat(Q('#ctxAvgMilk').value) : null,
    pregnancyStatus: Q('#ctxPreg')?.value || null,
    pregnancyDays: Q('#ctxDCC')?.value ? parseInt(Q('#ctxDCC').value) : null,
    earlyDry: !!Q('#ctxEarlyDry')?.checked,
    closeUp: !!Q('#ctxCloseUp')?.checked
  };

  const payload = {
    type:'تغذية', eventType:'تغذية',
    userId: localStorage.getItem('userId'),
    tenantId: localStorage.getItem('tenantId') || 'default',
    animalId: ctx.animalId,
    animalNumber: ctx.animalId,
    eventDate: ctx.eventDate,
    nutritionMode: mode,
    nutritionRows: rows,
    nutritionKPIs: kpis,
    nutritionContext: context,
    source: 'nutrition.html'
  };

  let savedMode='api';
  try{ await postToAPI(payload); }
  catch(err){ console.warn('API error; fallback to Firestore', err); await saveToFirestoreFallback(payload); savedMode='firestore'; }

  try{ onNutritionSave({ animalId: payload.animalId, date: payload.eventDate, rows: rows.length, mode: savedMode, source: payload.source }); }catch{}
  document.dispatchEvent(new CustomEvent('event:saved', { detail:{ ok:true, mode:savedMode, payload } }));
  const to = (document.querySelector('form[data-redirect]')?.dataset?.redirect) || '/dashboard.html';
  setTimeout(()=>location.href = to, 1200);
}
