// مُرَبِّيك — صفحة التغذية (Cloud-only)
// ✅ لا LocalStorage / لا API
// ✅ تحميل سياق الحيوان/المجموعة من Firestore فقط
// ✅ حفظ حدث التغذية إلى Firestore فقط (events)

import { onNutritionSave } from '/js/track-nutrition.js';

// Engines (targets)
import { computeBuffalo } from '/js/engine-buffalo.js';
import { computeCow } from '/js/engine-cow.js';

function computeTargetsFromCtx(ctx){
  const species = String(ctx?.species||'').trim();
  // ctx.species في صفحتك: 'جاموس' أو 'بقر' (وأحيانًا animalTypeAr)
  if(species.includes('جاموس')) return computeBuffalo({
    bodyWeightKg: ctx?.bodyWeightKg,
    avgMilkKg: ctx?.avgMilkKg,
    milkFatPct: ctx?.milkFatPct,
    pregnancyDays: ctx?.pregnancyDays,
    earlyDry: ctx?.earlyDry,
    closeUp: ctx?.closeUp,
    breed: ctx?.breed
  });
  return computeCow({
    bodyWeightKg: ctx?.bodyWeightKg,
    avgMilkKg: ctx?.avgMilkKg,
    milkFatPct: ctx?.milkFatPct,
    pregnancyDays: ctx?.pregnancyDays,
    earlyDry: ctx?.earlyDry,
    closeUp: ctx?.closeUp,
    assumedDietNelMcalPerKgDM: ctx?.assumedDietNelMcalPerKgDM
  });
}

// ✅ للتجربة من الكونسول: window.mbkNutrition.computeTargets()
window.mbkNutrition = window.mbkNutrition || {};
window.mbkNutrition.computeTargets = () => {
  const ctx = readContext();
  // readContext يرجّع species + avgMilkKg + pregnancyDays + flags
  return computeTargetsFromCtx({
    species: ctx?.species,
    avgMilkKg: ctx?.avgMilkKg,
    pregnancyDays: ctx?.pregnancyDays,
    earlyDry: ctx?.earlyDry,
    closeUp: ctx?.closeUp
  });
};

function todayLocal(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function qp(){ return new URLSearchParams(location.search); }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function setElText(id, val){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = (val===null || val===undefined || val==='') ? '—' : String(val);
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

// =====================
// Firestore helpers (سياق)
// =====================
function isMilkEvent(ev){
  const t = String(ev?.type || ev?.eventType || '').trim();
  return (t === 'daily_milk' || t === 'daily-milk' || t === 'dailyMilk' || t === 'لبن' || t === 'لبن يومي' || t === 'تسجيل اللبن اليومي');
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
  const start = new Date(end); start.setDate(start.getDate() - (days-1));

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
    if(!Number.isFinite(kg) || kg<=0) continue;

    const prev = byDay.get(day);
    const t = evTime(ev);
    if(!prev || t > prev.t) byDay.set(day, { kg, t });
  }

  const vals = [...byDay.values()].map(x=>x.kg);
  if(!vals.length) return { avg:null, days:0 };
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return { avg, days: vals.length };
}

function parseNumbersList(){
  const p = qp();
  const raw = (p.get('numbers') || p.get('groupNumbers') || p.get('animalIds') || p.get('animalNumber') || p.get('number') || p.get('animalId') || '').toString();
  const list = raw.split(/[,،;\s]+/).map(s=>s.trim()).filter(Boolean);
  return [...new Set(list)];
}

function readUrlCtx(){
  const p = qp();
  const rawNumber =
    p.get('animalNumber') || p.get('number') || p.get('animalId') ||
    p.get('numbers') || p.get('groupNumbers') || '';

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

  const dim = Number.isFinite(Number(animal?.daysInMilk)) ? Number(animal.daysInMilk) : null;

  const species =
    (animal?.animalTypeAr) ||
    (animal?.animaltype === 'buffalo' ? 'جاموس' : (animal?.animaltype === 'cow' ? 'بقر' : '')) ||
    '';

  const preg = (animal?.reproductiveStatus || animal?.lastDiagnosis || animal?.pregStatus || '') || '';

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
  if(species) document.getElementById('ctxSpecies').value = species;
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
  if(!numbers?.length) return { ok:false, reason:'no_number' };

  const { db, auth } = await import('/js/firebase-config.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const uid = auth?.currentUser?.uid;
  if(!uid) return { ok:false, reason:'no_uid' };

  const docs = [];
  for(const n of numbers){
    const doc = await findAnimalDocByNumber(db, fs, uid, n);
    if(doc) docs.push(doc);
  }
  if(!docs.length) return { ok:false, reason:'not_found' };

  const dims = docs.map(d=>Number(d.daysInMilk)).filter(x=>Number.isFinite(x));
  const avgDIM = dims.length ? (dims.reduce((a,b)=>a+b,0)/dims.length) : null;

  const first = docs[0] || {};
  const typeAr = (first.animalTypeAr || (first.animaltype==='buffalo' ? 'جاموس' : (first.animaltype==='cow' ? 'بقر' : '')));
  const species = (typeAr==='جاموس' || typeAr==='بقر') ? typeAr : '';

  const milks = [];
  for(const d of docs){
    const an = d.animalNumber;
    const val = Number.isFinite(Number(an)) ? Number(an) : String(an);
    const r = await fetchAvgMilkKgFor(fs, db, uid, val, eventDate, 7);
    if(r.avg!=null) milks.push(Number(r.avg));
  }
  const avgMilk = milks.length ? (milks.reduce((a,b)=>a+b,0)/milks.length) : null;

  const dccs = [];
  for(const d of docs){
    const repro = d.reproductiveStatus || '';
    if(repro!=='عشار') continue;
    const lastIns = d.lastInseminationDate;
    if(!lastIns) continue;
    const a = new Date(lastIns);
    const b = new Date(eventDate);
    if(isNaN(a.getTime()) || isNaN(b.getTime())) continue;
    const diff = Math.floor((b.getTime()-a.getTime())/86400000);
    if(diff>=0) dccs.push(diff);
  }
  const avgDCC = dccs.length ? (dccs.reduce((a,b)=>a+b,0)/dccs.length) : null;

  if(species) document.getElementById('ctxSpecies').value = species;
  if(avgDIM!=null) document.getElementById('ctxDIM').value = Math.round(avgDIM);
  document.getElementById('ctxAvgMilk').value = (avgMilk!=null ? avgMilk.toFixed(1) : '');
  if(avgDCC!=null) document.getElementById('ctxDCC').value = Math.round(avgDCC);

  const animalInfo = document.getElementById('animalInfo');
  if(animalInfo) animalInfo.textContent = `مجموعة (${docs.length} رأس)`;

  updateCtxView();
  return { ok:true, count: docs.length };
}

async function loadCtxAuto(){
  const { rawNumber, nums, eventDate } = readUrlCtx();

  // لازم رقم (فردي أو قائمة) من الـURL
  if(!rawNumber){
    disableSave(true);
    msgWarn('⚠️ افتح صفحة التغذية من داخل مُرَبِّيك (لازم رقم الحيوان/المجموعة في الرابط).');
    return { ok:false, reason:'no_number' };
  }

  // فردي/جماعي
  const res = (nums.length > 1)
    ? await loadCtxFromGroup(nums, eventDate)
    : await loadCtxFromAnimal(nums[0] || rawNumber, eventDate);

  if(res?.ok){
    disableSave(false);
    msgWarn('✅ تم تحميل بيانات السياق تلقائيًا.');
  }else if(res?.reason==='no_uid'){
    disableSave(true);
    msgWarn('⚠️ يلزم تسجيل الدخول أولاً.');
  }else if(res?.reason==='not_found'){
    disableSave(true);
    msgWarn('⚠️ لم يتم العثور على الحيوان/المجموعة في القطيع.');
  }else{
    disableSave(true);
    msgWarn('⚠️ تعذر تحميل البيانات تلقائيًا.');
  }
  return res;
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

async function saveToFirestore(payload){
  const { db, auth } = await import('/js/firebase-config.js');
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const { collection, addDoc, serverTimestamp } = fs;

  const uid = auth?.currentUser?.uid;
  if(!uid) throw new Error('NO_AUTH');

  await addDoc(collection(db, 'events'), { ...payload, createdAt: serverTimestamp() });
}

function redirectSmart(){
  const to = (document.querySelector('form[data-redirect]')?.dataset?.redirect) || '/dashboard.html';
  setTimeout(()=>{ location.href = to; }, 250);
}

async function saveEvent(e){
  e?.preventDefault?.();

  const p = qp();
  const rawNumber =
    p.get('animalNumber') || p.get('number') || p.get('animalId') ||
    p.get('numbers') || p.get('groupNumbers') || '';

  const rawDate = p.get('eventDate') || p.get('date') || '';
  const animalId = String(rawNumber||'').trim();
  const eventDate = DATE_RE.test(String(rawDate||'')) ? String(rawDate) : todayLocal();

  if(!animalId){
    msgWarn('⚠️ لا يمكن الحفظ بدون رقم الحيوان/المجموعة في الرابط.');
    return;
  }

  // منع الحفظ لو السياق لم يُحمَّل
  if((document.getElementById('ctxSpecies')?.value || '') === '' &&
     (document.getElementById('ctxDIM')?.value || '') === '' &&
     (document.getElementById('ctxAvgMilk')?.value || '') === ''){
    msgWarn('⚠️ تم منع الحفظ: لم يتم تحميل بيانات السياق.');
    return;
  }

  const rows = collectRows();
  const payload = {
    type: 'nutrition',
    eventType: 'تغذية',
    animalId,
    animalNumber: animalId,
    eventDate,
    nutritionMode: (document.getElementById('mode')?.value || 'tmr_asfed'),
    nutritionRows: rows,
    nutritionKPIs: readKPIs(),
    nutritionContext: readContext(),
    source: 'nutrition.html'
  };

  // userId من auth (Cloud-only)
  try{
    const { auth } = await import('/js/firebase-config.js');
    payload.userId = auth?.currentUser?.uid || null;
    payload.tenantId = payload.userId || null;
  }catch(_){}

  disableSave(true);
  msgWarn('⏳ جارٍ الحفظ...');

  try{
    await saveToFirestore(payload);
    try { await window.updateAnimalByEvent?.(payload); } catch (e) { console.warn('updateAnimalByEvent failed', e); }

    try{
      onNutritionSave({
        animalId,
        date: eventDate,
        rows: rows.length,
        mode: 'firestore',
        source: 'nutrition.html'
      });
    }catch(_){}

    msgWarn('✅ تم الحفظ على السحابة.');
    redirectSmart();
  }catch(err){
    console.error(err);
    disableSave(false);
    msgWarn('❌ فشل الحفظ على السحابة. تأكد من الاتصال وتسجيل الدخول.');
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
  const form = document.getElementById('nutritionForm') || document.querySelector('form[data-event="nutrition"]');
  if (form) form.addEventListener('submit', saveEvent);

  const btn  = document.getElementById('saveEvent') || document.querySelector('[data-action="save-event"]');
  if (btn) btn.addEventListener('click', (e)=>{ e.preventDefault(); form?.requestSubmit?.(); });

  // init
  try{
    setHiddenCtxFromQuery();
    updateCtxView();
   disableSave(true);
waitForAuthReady().then(user=>{
  if(!user){
    disableSave(true);
    msgWarn('⚠️ يلزم تسجيل الدخول أولاً.');
    return;
  }
  loadCtxAuto();
});
  }catch(e){
    console.error(e);
    disableSave(true);
    msgWarn('⚠️ تعذر تهيئة الصفحة.');
  }
})();
