// حفظ حدث التغذية إلى /api/events + Fallback Firestore — بدون أي تغيير بصري
import { onNutritionSave } from '/js/track-nutrition.js';

function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function qp(){ return new URLSearchParams(location.search); }

function deriveCtx(){
  const p = qp();
  const animalId = p.get('animalId') || p.get('number') || p.get('animalNumber') || localStorage.getItem('lastAnimalId') || '';
  let eventDate  = p.get('eventDate') || p.get('date') || p.get('dt') || p.get('Date') || localStorage.getItem('eventDate') || localStorage.getItem('lastEventDate') || todayLocal();
  try{
    if(animalId){ localStorage.setItem('currentAnimalId', animalId); localStorage.setItem('lastAnimalId', animalId); }
    if(eventDate){ localStorage.setItem('eventDate', eventDate); localStorage.setItem('lastEventDate', eventDate); }
  }catch{}
  return { animalId, eventDate };
}

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

function readContext(){
  const getNum = id => { const v = document.getElementById(id)?.value; return v? Number(v) : null; };
  const getSel = id => document.getElementById(id)?.value || null;
  const species = getSel('ctxSpecies');
  const dcc = getNum('ctxDCC');
  const gest = (species==='جاموس') ? 310 : 280;
  const daysToCalving = Number.isFinite(dcc) ? (gest - dcc) : null;

  return {
    group: qp().get('group') || null,
    species,
    daysInMilk: getNum('ctxDIM'),
    avgMilkKg: (document.getElementById('ctxAvgMilk')?.value ? parseFloat(document.getElementById('ctxAvgMilk').value) : null),
    earlyDry: !!(document.getElementById('ctxEarlyDry')?.checked),
    closeUp: !!(document.getElementById('ctxCloseUp')?.checked),
    pregnancyStatus: getSel('ctxPreg'),
    pregnancyDays: dcc,
    daysToCalving
  };
}

async function postAPI(payload){
  const API_BASE = (localStorage.getItem('API_BASE') || '').replace(/\/$/, '');
  const url = (API_BASE ? API_BASE : '') + '/api/events';
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('API failed: '+r.status);
  return r.json().catch(()=>({}));
}

async function saveFirestore(payload){
  const cfgMod = await import('/js/firebase-config.js');
  const firebaseConfig = cfgMod.default || cfgMod.firebaseConfig || cfgMod.config;
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
  const { getFirestore, collection, addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  await addDoc(collection(db, 'events'), { ...payload, createdAt: serverTimestamp() });
}

function redirectSmart(){
  const to = (document.querySelector('form[data-redirect]')?.dataset?.redirect) || '/dashboard.html';
  setTimeout(()=>{ location.href = to; }, 250);
}

async function saveEvent(e){
  e?.preventDefault?.();
  const { animalId, eventDate } = deriveCtx();
  if (!animalId || !eventDate){ alert('⚠️ يرجى التأكد من رقم الحيوان والتاريخ.'); return; }

  const rows = collectRows();
  const payload = {
    type: 'تغذية',
    eventType: 'تغذية',
    userId: localStorage.getItem('userId'),
    tenantId: localStorage.getItem('tenantId') || 'default',
    animalId, animalNumber: animalId,
    eventDate,
    nutritionMode: (document.getElementById('mode')?.value || 'tmr_asfed'),
    nutritionRows: rows,
    nutritionKPIs: readKPIs(),
    nutritionContext: readContext(),
    source: 'nutrition.html'
  };

  let modeSaved = 'api';
  try{ await postAPI(payload); }
  catch(err){ console.warn('API error; fallback to Firestore', err); await saveFirestore(payload); modeSaved = 'firestore'; }

  try{ onNutritionSave({ animalId, date: eventDate, rows: rows.length, mode: modeSaved, source: 'nutrition.html' }); }catch(e){}
  redirectSmart();
}

(function bind(){
  const form = document.getElementById('nutritionForm') || document.querySelector('form[data-event="nutrition"]');
  if (form) form.addEventListener('submit', saveEvent);
  const btn  = document.getElementById('saveEvent') || document.querySelector('[data-action="save-event"]');
  if (btn) btn.addEventListener('click', (e)=>{ e.preventDefault(); form?.requestSubmit?.(); });
})();
