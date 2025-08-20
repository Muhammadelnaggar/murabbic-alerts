// =========================
// File: /js/events-core.js
// Simple – Effective – Very Smart (no visual changes)
// أدوات مشتركة لكل صفحات الأحداث
// =========================

export const Q = (s) => document.querySelector(s);

export function pickVal(ids = []) {
  for (const id of ids) {
    const byId = document.getElementById(id);
    if (byId && byId.value?.toString().trim() !== '') return byId.value.trim();
    const byName = document.querySelector(`[name="${id}"]`);
    if (byName && byName.value?.toString().trim() !== '') return byName.value.trim();
  }
  return '';
}

export function readCtxFromURL() {
  const p = new URLSearchParams(location.search);
  const pick = (...keys) => { for (const k of keys) { const v = p.get(k); if (v) return v; } return ''; };
  return {
    animalId: pick('animalId','number','animalNumber','id'),
    eventDate: pick('eventDate','date','dt','Date'),
  };
}

export function persistCtx({ animalId, eventDate }) {
  try {
    if (animalId) ['lastAnimalId','currentAnimalId','ctxAnimalId'].forEach(k=>localStorage.setItem(k, animalId));
    if (eventDate) ['lastEventDate','eventDate','Date','dt'].forEach(k=>localStorage.setItem(k, eventDate));
  } catch {}
}

export function deriveCtx() {
  const u = readCtxFromURL();
  const animalId = u.animalId || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
  let eventDate = u.eventDate || localStorage.getItem('eventDate') || localStorage.getItem('lastEventDate') || '';
  if (!eventDate) eventDate = new Date().toISOString().slice(0,10);
  persistCtx({ animalId, eventDate });
  return { animalId, eventDate };
}

export function prefillStandard(ctx, { animalSel = ['#animalId','[name="animalId"]'], dateSel = ['#eventDate','[name="eventDate"]'] } = {}) {
  const a = animalSel.map(s=>Q(s)).find(Boolean); if (a && !a.value) a.value = ctx.animalId || '';
  const d = dateSel.map(s=>Q(s)).find(Boolean); if (d && !d.value) d.value = ctx.eventDate || '';
}

function toKeysFromSelectors(selectors = []) {
  return selectors.map(s => s.replace(/^#/, '').replace(/^\[name=\"/, '').replace(/\"\]$/, ''));
}

export function buildBase(eventType, ctx, { dateSel = ['#eventDate','[name="eventDate"]'], extra = {} } = {}) {
  const dateKeys = Array.from(new Set(['eventDate', ...toKeysFromSelectors(dateSel), 'date', 'dt', 'Date']));
  const eventDate = pickVal(dateKeys) || ctx.eventDate;
  const details = extra.details || {};
  const payload = {
    type: eventType,
    eventType,
    userId: localStorage.getItem('userId'),
    tenantId: localStorage.getItem('tenantId') || 'default',
    animalId: pickVal(['animalId']) || ctx.animalId,
    animalNumber: pickVal(['animalNumber','number']) || ctx.animalId,
    eventDate,
    source: location.pathname.slice(1),
    details,
    ...details // flatten لملاءمة مسارات قديمة تتوقع الحقول أعلى المستوى
  };
  return payload;
}

export async function postToAPI(payload) {
  const API_BASE = (localStorage.getItem('API_BASE') || '').replace(/\/$/, '');
  const url = (API_BASE ? API_BASE : '') + '/api/events';
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('API failed: ' + res.status);
  return res.json().catch(()=>({}));
}

export async function saveToFirestoreFallback(payload) {
  try {
    const cfgMod = await import('/js/firebase-config.js');
    const firebaseConfig = cfgMod.default || cfgMod.firebaseConfig || cfgMod.config;
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
    const { getFirestore, collection, addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);
    await addDoc(collection(db, 'events'), { ...payload, createdAt: serverTimestamp() });
  } catch (e) {
    console.error('Firestore fallback failed', e);
    throw e;
  }
}

export function dispatchSaved(detail) { document.dispatchEvent(new CustomEvent('event:saved', { detail })); }
export function smartRedirect(to = (Q('form[data-redirect]')?.dataset?.redirect) || '/dashboard.html') { setTimeout(()=>{ location.href = to; }, 1200); }

export function bindStandardForm({ formSelector = 'form', saveBtnSelector = '#saveEvent' }, onSubmit) {
  const form = Q(formSelector) || Q('form');
  if (form) form.addEventListener('submit', onSubmit);
  const btn = Q(saveBtnSelector) || Q('[data-action="save-event"]');
  if (btn && form) btn.addEventListener('click', (e)=>{ e.preventDefault(); form.requestSubmit(); });
}

export function guardLoggedIn() {
  const userId = localStorage.getItem('userId');
  if (!userId) {
    alert('⚠️ يجب تسجيل الدخول أولًا.');
    location.href = 'login.html';
    return false;
  }
  return true;
}

export function initEventPage({
  eventType,
  formSelector = 'form',
  animalSel = ['#animalId','[name="animalId"]'],
  dateSel = ['#eventDate','[name="eventDate"]'],
  onPrefill = ()=>{},
  buildDetails = ()=>({}),
  onSaved = ()=>{},
  redirectTo,
}) {
  const ctx = deriveCtx();
  prefillStandard(ctx, { animalSel, dateSel });

  try { onPrefill(ctx); } catch(e){}

  async function handle(e){
    e?.preventDefault?.();
    if (!guardLoggedIn()) return;

    const details = buildDetails(ctx) || {};
    const payload = buildBase(eventType, ctx, { dateSel, extra: { details } });

    let mode = 'api';
    try { await postToAPI(payload); }
    catch(err){ console.warn('API error; fallback to Firestore', err); await saveToFirestoreFallback(payload); mode = 'firestore'; }

    try { onSaved({ payload, mode }); } catch(e){}
    dispatchSaved({ ok:true, mode, payload });
    smartRedirect(redirectTo);
  }

  bindStandardForm({ formSelector }, handle);
}



