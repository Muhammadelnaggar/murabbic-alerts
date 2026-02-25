// حفظ حدث التغذية إلى /api/events + Fallback Firestore — بدون أي تغيير بصري
import { onNutritionSave } from '/js/track-nutrition.js';

function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function qp(){ return new URLSearchParams(location.search); }


function setElText(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = (val===null || val===undefined || val==='') ? '—' : String(val);
}
function setHiddenCtxFromQuery(){
  const p = qp();
  const setVal = (id, v) => { const el=document.getElementById(id); if(el && v!==null && v!==undefined && v!=='') el.value = v; };
  const setChk = (id, v) => { const el=document.getElementById(id); if(el) el.checked = (v==='1' || v==='true' || v==='yes'); };
  setVal('ctxDIM', p.get('dim') || p.get('DIM'));
  setVal('ctxSpecies', p.get('species'));
  setVal('ctxAvgMilk', p.get('avgMilk'));
  setVal('ctxDCC', p.get('dcc'));
  setVal('ctxPreg', p.get('preg'));
  setChk('ctxEarlyDry', p.get('earlyDry'));
  setChk('ctxCloseUp', p.get('closeUp'));
}
function updateCtxView(){
  const species = document.getElementById('ctxSpecies')?.value || '';
  const dim = document.getElementById('ctxDIM')?.value || '';
  const avgMilk = document.getElementById('ctxAvgMilk')?.value || '';
  const dcc = document.getElementById('ctxDCC')?.value || '';
  const preg = document.getElementById('ctxPreg')?.value || '';
  const earlyDry = !!document.getElementById('ctxEarlyDry')?.checked;
  const closeUp = !!document.getElementById('ctxCloseUp')?.checked;

  setElText('ctxSpecies_txt', species || '—');
  setElText('ctxDIM_txt', dim || '—');
  setElText('ctxAvgMilk_txt', avgMilk ? Number(avgMilk).toFixed(1) : '—');
  setElText('ctxDCC_txt', dcc || '—');
  setElText('ctxPreg_txt', preg || '—');
  setElText('ctxEarlyDry_txt', earlyDry ? 'نعم' : 'لا');
  setElText('ctxCloseUp_txt', closeUp ? 'نعم' : 'لا');

  // متبقي للولادة
  const dccNum = dcc!=='' ? Number(dcc) : NaN;
  const gest = (species==='جاموس') ? 310 : 280;
  const dtc = Number.isFinite(dccNum) ? (gest - dccNum) : null;
  setElText('dtcVal', (dtc===null ? '—' : dtc));
}
async function loadCtxFromAnimal(animalNumberOrId, eventDate){
  try{
    const { db, auth } = await import('/js/firebase-config.js');
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { collection, query, where, limit, getDocs } = fs;

    const uid = auth?.currentUser?.uid;
    if(!uid) return { ok:false, reason:'no_uid' };

    const nStr = String(animalNumberOrId||'').trim();
    if(!nStr) return { ok:false, reason:'no_number' };
    const nNum = Number(nStr);

    async function tryQuery(ownerField, val){
      const q = query(collection(db,'animals'),
        where(ownerField,'==', uid),
        where('animalNumber','==', val),
        limit(1)
      );
      const snap = await getDocs(q);
      if(!snap.empty) return snap.docs[0].data();
      return null;
    }

    let doc = null;
    if(Number.isFinite(nNum)){
      doc = await tryQuery('userId', nNum) || await tryQuery('ownerUid', nNum);
    }
    if(!doc){
      doc = await tryQuery('userId', nStr) || await tryQuery('ownerUid', nStr);
    }
    if(!doc) return { ok:false, reason:'not_found' };

    // نوع
    const typeAr = doc.animalTypeAr || (doc.animaltype==='buffalo' ? 'جاموس' : (doc.animaltype==='cow' ? 'بقر' : ''));
    if(typeAr==='جاموس' || typeAr==='بقر') document.getElementById('ctxSpecies').value = typeAr;

    // DIM/لبن
    if(doc.daysInMilk!=null) document.getElementById('ctxDIM').value = Number(doc.daysInMilk);
    if(doc.dailyMilk!=null) document.getElementById('ctxAvgMilk').value = Number(doc.dailyMilk);

    // حالة تناسلية -> حالة حمل
    const repro = doc.reproductiveStatus || '';
    if(repro==='عشار' || repro==='فارغة') document.getElementById('ctxPreg').value = repro;

    // DCC من آخر تلقيح مُخصّب لو موجود
    const lastIns = doc.lastInseminationDate;
    const ed = eventDate || todayLocal();
    if(lastIns && (repro==='عشار')){
      const a = new Date(lastIns);
      const b = new Date(ed);
      if(!isNaN(a.getTime()) && !isNaN(b.getTime())){
        const diff = Math.floor((b.getTime()-a.getTime())/86400000);
        if(diff>=0) document.getElementById('ctxDCC').value = diff;
      }
    }

    updateCtxView();
    return { ok:true, doc };
  }catch(e){
    return { ok:false, reason:'error', error:String(e?.message||e) };
  }
}

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
try {
  await window.updateAnimalByEvent(payload);
} catch (e) {
  console.warn('updateAnimalByEvent failed', e);
}

  try{ onNutritionSave({ animalId, date: eventDate, rows: rows.length, mode: modeSaved, source: 'nutrition.html' }); }catch(e){}
  redirectSmart();
}

(function bind(){
  const form = document.getElementById('nutritionForm') || document.querySelector('form[data-event="nutrition"]');
  if (form) form.addEventListener('submit', saveEvent);
  const btn  = document.getElementById('saveEvent') || document.querySelector('[data-action="save-event"]');
  if (btn) btn.addEventListener('click', (e)=>{ e.preventDefault(); form?.requestSubmit?.(); });

  // تهيئة عرض السياق كقائمة (Read-only) + تحميل من الرابط + زر تحديث من الحيوان
  try{
    setHiddenCtxFromQuery();
    updateCtxView();
    const reloadBtn = document.getElementById('ctxReloadBtn');
    if(reloadBtn){
      reloadBtn.addEventListener('click', async ()=>{
        const { animalId, eventDate } = deriveCtx();
        const res = await loadCtxFromAnimal(animalId, eventDate);
        // لا نستخدم alert؛ فقط نحدث شريط تحذير إن وجد
        const w = document.getElementById('warn');
        if(w){
          if(res.ok) { w.textContent = '✅ تم تحديث بيانات المجموعة من بطاقة الحيوان.'; w.style.display='block'; }
          else if(res.reason==='not_found'){ w.textContent = '⚠️ لم يتم العثور على الحيوان في القطيع (راجع الرقم/المالك).'; w.style.display='block'; }
          else if(res.reason==='no_uid'){ w.textContent = '⚠️ يلزم تسجيل الدخول أولاً.'; w.style.display='block'; }
          else { w.textContent = '⚠️ تعذر التحديث.'; w.style.display='block'; }
        }
      });
    }
  }catch(e){}

})();
