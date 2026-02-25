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
  const nStr = String(animalNumberOrId||'').trim();
  if(!nStr) return { ok:false, reason:'no_number' };

  const API_BASE = window.API_BASE || "";
  const userId = window.currentUserId || localStorage.getItem("userId") || "";
  const headers = { "Accept":"application/json" };
  if(userId) headers["X-User-Id"] = userId;

  // ---- helpers
  async function getJSON(path){
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const res = await fetch(url, { headers, cache:'no-store' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }
  function pick(obj, keys, def=''){
    for(const k of keys){
      if(obj && obj[k]!==undefined && obj[k]!==null && obj[k]!=='') return obj[k];
    }
    return def;
  }
  function toNum(v){
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  // ---- 1) fetch animal doc via API (server-admin → Firestore)
  let animal = null;
  const tries = [
    `/api/animals?number=${encodeURIComponent(nStr)}`,
    `/api/animals?animalNumber=${encodeURIComponent(nStr)}`,
    `/api/animals?q=${encodeURIComponent(nStr)}`
  ];
  for(const path of tries){
    try{
      const data = await getJSON(path);
      if(Array.isArray(data)) animal = data[0] || null;
      else if(data && Array.isArray(data.items)) animal = data.items[0] || null;
      else if(data && data.animal) animal = data.animal;
      else if(data && data.animalNumber!==undefined) animal = data;
      if(animal) break;
    }catch(e){}
  }

  // ---- 2) compute DIM from animal doc
  const dim = toNum(pick(animal, ['daysInMilk','DIM','dim'], null));

  // ---- 3) milk avg last 7 days from events (preferred)
  const baseDate = (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) ? eventDate : todayLocal();
  const end = new Date(baseDate+"T00:00:00");
  const start = new Date(end); start.setDate(start.getDate()-6);
  const from = start.toISOString().slice(0,10);
  const to = end.toISOString().slice(0,10);

  let avgMilk = null;
  async function fetchMilkEvents(){
    const paths = [
      `/api/events?type=daily-milk&number=${encodeURIComponent(nStr)}&from=${from}&to=${to}`,
      `/api/events?eventType=لبن&number=${encodeURIComponent(nStr)}&from=${from}&to=${to}`,
      `/api/animal-timeline?number=${encodeURIComponent(nStr)}&from=${from}&to=${to}`,
      `/api/animal-timeline?animalNumber=${encodeURIComponent(nStr)}&from=${from}&to=${to}`
    ];
    for(const path of paths){
      try{
        const data = await getJSON(path);
        if(Array.isArray(data)) return data;
        if(data && Array.isArray(data.events)) return data.events;
        if(data && Array.isArray(data.items)) return data.items;
      }catch(e){}
    }
    return [];
  }

  const milkEvents = await fetchMilkEvents();

  // normalize milk events to (date -> last value)
  const byDay = new Map();
  for(const ev of (milkEvents||[])){
    const d = String(pick(ev, ['eventDate','date','day'], '')).slice(0,10);
    if(!d || d < from || d > to) continue;
    const v = pick(ev, ['milkKg','milk','value','kg','amount','dailyMilk'], null);
    const num = toNum(v);
    if(num===null) continue;
    // overwrite → last record for that day wins
    byDay.set(d, num);
  }
  if(byDay.size){
    let sum=0;
    for(const v of byDay.values()) sum += v;
    avgMilk = sum / byDay.size;
  }else{
    // fallback to animal.dailyMilk only if we have lastMilkDate within the window
    const lastMilkDate = String(pick(animal, ['lastMilkDate','lastMilkDateStr'], '')).slice(0,10);
    const dm = toNum(pick(animal, ['dailyMilk'], null));
    if(dm!==null && lastMilkDate && lastMilkDate >= from && lastMilkDate <= to) avgMilk = dm;
  }

  // ---- 4) other context fields
  const species = pick(animal, ['animalTypeAr','speciesAr','animaltype','species'], '');
  const dcc = toNum(pick(animal, ['dcc','daysCarried','pregDays','DCC'], null));
  const preg = pick(animal, ['reproductiveStatus','pregStatus','lastDiagnosis','preg'], '');

  return {
    ok: true,
    animal: animal || null,
    dim: dim,
    avgMilk: avgMilk,
    species: species,
    dcc: dcc,
    preg: preg,
    window: {from,to}
  };
}


// ✅ تحميل السياق تلقائيًا (بدون زر) — يدعم: حيوان واحد أو "مجموعة مؤقتة" (قائمة أرقام)
// المجموعة المؤقتة تُمرَّر عبر:
// - animalId/number = "201,203,206"  أو
// - numbers=201,203,206  أو
// - groupNumbers=...
function parseNumbersList(){
  const p = qp();
  const raw = (p.get('numbers') || p.get('groupNumbers') || p.get('animalIds') || p.get('animalId') || p.get('number') || p.get('animalNumber') || '').toString();
  const list = raw.split(/[,،;\s]+/).map(s=>s.trim()).filter(Boolean);
  // لو الرقم مفصول بشرطة (مثال 201-205) نتجاهله الآن لتفادي أخطاء
  const clean = [];
  for(const x of list){
    if(x.includes('-')) { clean.push(x); continue; }
    clean.push(x);
  }
  // unique
  return [...new Set(clean)];
}

async function fetchAvgMilkKgFor(fs, db, uid, animalVal, endDateStr, days=7){
  const { collection, query, where, limit, getDocs, orderBy } = fs;
  const end = new Date(endDateStr || todayLocal());
  if(isNaN(end.getTime())) return { avg:null, days:0 };
  const start = new Date(end); start.setDate(start.getDate() - (days-1));

  const candidates = [];
  async function pull(ownerField){
    try{
      const q = query(
        collection(db,'events'),
        where(ownerField,'==', uid),
        where('animalNumber','==', animalVal),
        orderBy('createdAt','desc'),
        limit(120)
      );
      const snap = await getDocs(q);
      snap.forEach(d=>candidates.push(d.data()));
    }catch(e){
      // fallback بدون orderBy
      try{
        const q = query(
          collection(db,'events'),
          where(ownerField,'==', uid),
          where('animalNumber','==', animalVal),
          limit(120)
        );
        const snap = await getDocs(q);
        snap.forEach(d=>candidates.push(d.data()));
      }catch(_){}
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
    if(!Number.isFinite(kg) || kg<=0) continue;

    // احتفظ بآخر قراءة في اليوم (الأحدث)
    const prev = byDay.get(day);
    const t = evTime(ev);
    if(!prev || t > prev.t){
      byDay.set(day, { kg, t });
    }
  }

  const vals = [...byDay.values()].map(x=>x.kg);
  if(!vals.length) return { avg:null, days:0 };
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return { avg, days: vals.length };
}

async function loadCtxFromGroup(numbers, eventDate){
  try{
    const { db, auth } = await import('/js/firebase-config.js');
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { collection, query, where, limit, getDocs } = fs;

    const uid = auth?.currentUser?.uid;
    if(!uid) return { ok:false, reason:'no_uid' };

    const docs = [];
    async function findAnimalDoc(val){
      // جرّب userId ثم ownerUid، وجرّب رقم/نص
      const tries = [];
      const nStr = String(val).trim();
      const nNum = Number(nStr);
      if(Number.isFinite(nNum)) tries.push(nNum);
      tries.push(nStr);

      const ownerFields = ['userId','ownerUid'];
      for(const ownerField of ownerFields){
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
          }catch(e){}
        }
      }
      return null;
    }

    // اجمع بيانات كل حيوان
    for(const n of numbers){
      const doc = await findAnimalDoc(n);
      if(!doc) continue;
      docs.push(doc);
    }
    if(!docs.length) return { ok:false, reason:'not_found' };

    // احسب متوسط DIM
    const dims = docs.map(d=>Number(d.daysInMilk)).filter(x=>Number.isFinite(x));
    const avgDIM = dims.length ? (dims.reduce((a,b)=>a+b,0)/dims.length) : null;

    // نوع القطيع (من أول حيوان كمصدر)
    const first = docs[0] || {};
    const typeAr = (first.animalTypeAr || (first.animaltype==='buffalo' ? 'جاموس' : (first.animaltype==='cow' ? 'بقر' : '')));
    const species = (typeAr==='جاموس' || typeAr==='بقر') ? typeAr : '';

    // متوسط لبن 7 أيام (نحسب لكل حيوان ثم ناخد المتوسط على الحيوانات اللي عندها بيانات)
    const ed = eventDate || todayLocal();
    const milks = [];
    for(const d of docs){
      const an = d.animalNumber;
      const val = Number.isFinite(Number(an)) ? Number(an) : String(an);
      const r = await fetchAvgMilkKgFor(fs, db, uid, val, ed, 7);
      if(r.avg!=null) milks.push(Number(r.avg));
    }
    const avgMilk = milks.length ? (milks.reduce((a,b)=>a+b,0)/milks.length) : null;

    // متوسط DCC (للعشار فقط) من lastInseminationDate
    const dccs = [];
    for(const d of docs){
      const repro = d.reproductiveStatus || '';
      if(repro!=='عشار') continue;
      const lastIns = d.lastInseminationDate;
      if(!lastIns) continue;
      const a = new Date(lastIns);
      const b = new Date(ed);
      if(isNaN(a.getTime()) || isNaN(b.getTime())) continue;
      const diff = Math.floor((b.getTime()-a.getTime())/86400000);
      if(diff>=0) dccs.push(diff);
    }
    const avgDCC = dccs.length ? (dccs.reduce((a,b)=>a+b,0)/dccs.length) : null;

    // اكتب القيم في الحقول المخفية (حتى لا نكسر منطق الحفظ)
    if(species) document.getElementById('ctxSpecies').value = species;
    if(avgDIM!=null) document.getElementById('ctxDIM').value = Math.round(avgDIM);
    document.getElementById('ctxAvgMilk').value = (avgMilk!=null ? avgMilk.toFixed(1) : '');
    if(avgDCC!=null) document.getElementById('ctxDCC').value = Math.round(avgDCC);

    // العرض
    const animalInfo = document.getElementById('animalInfo');
    if(animalInfo) animalInfo.textContent = `مجموعة (${docs.length} رأس)`;
    updateCtxView();

    return { ok:true, count: docs.length };
  }catch(e){
    return { ok:false, reason:'error', error:String(e?.message||e) };
  }
}

async function loadCtxAuto(){
  const { animalId, eventDate } = deriveCtx();
  const nums = parseNumbersList();
  // إذا كانت قائمة أرقام >1 نعتبرها مجموعة مؤقتة
  if(nums.length > 1){
    return await loadCtxFromGroup(nums, eventDate);
  }
  // حيوان واحد
  return await loadCtxFromAnimal(animalId, eventDate);
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

  // تهيئة عرض السياق كقائمة (Read-only) + تحميل تلقائي من الحيوان/المجموعة
  try{
    setHiddenCtxFromQuery();
    updateCtxView();
    (async ()=>{
      const res = await loadCtxAuto();
      const w = document.getElementById('warn');
      if(w){
        if(res?.ok) { w.textContent = '✅ تم تحميل بيانات السياق تلقائيًا.'; w.style.display='block'; }
        else if(res?.reason==='not_found'){ w.textContent = '⚠️ لم يتم العثور على الحيوان/المجموعة في القطيع.'; w.style.display='block'; }
        else if(res?.reason==='no_uid'){ w.textContent = '⚠️ يلزم تسجيل الدخول أولاً.'; w.style.display='block'; }
        else { w.textContent = '⚠️ تعذر تحميل البيانات تلقائيًا.'; w.style.display='block'; }
      }
    })();
  }catch(e){}


})();
