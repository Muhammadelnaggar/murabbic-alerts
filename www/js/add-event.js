// /js/add-event.js
(() => {
  'use strict';

  const DEV = /[?&]debug=1/.test(location.search) || localStorage.getItem('mbk_debug') === '1';
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const on = (el, ev, fn, opts) => el.addEventListener(ev, fn, opts);
  const okbar = $('#okbar'); // اختياري؛ لو مش موجود هيكمل عادي
  const okmsg = okbar?.querySelector?.('.msg');
  const okactions = okbar?.querySelector?.('.actions');

  function ok(message, actions=[]){
    if(!okbar) return;
    okmsg.textContent = message;
    okactions.innerHTML = '';
    actions.forEach(a=>{
      const b = document.createElement('button');
      b.textContent = a.label;
      if(a.variant==='secondary') b.classList.add('secondary');
      b.onclick = a.onClick;
      okactions.appendChild(b);
    });
    okbar.style.display = 'block';
    setTimeout(()=> okbar.style.display='none', 6000);
  }

  function logDev(err){
    try { window.dataLayer.push({event:'err', msg:String(err)}); } catch(_){}
    if (DEV) console.error(err);
  }

  // ========== سياق page ==========
  function getQuery(){
    const p = new URLSearchParams(location.search), o={};
    for (const [k,v] of p) o[k]=v;
    return o;
  }
  function getContext(){
    const q=getQuery();
    const number   = q.number || q.animalNumber || localStorage.getItem('currentAnimalNumber') || localStorage.getItem('lastAnimalNumber') || '';
    const animalId = q.animalId || localStorage.getItem('currentAnimalId') || localStorage.getItem('lastAnimalId') || '';
    const date     = q.date || q.eventDate || localStorage.getItem('lastEventDate') || new Date().toISOString().slice(0,10);
    if(number) localStorage.setItem('currentAnimalNumber', number);
    if(animalId) localStorage.setItem('currentAnimalId', animalId);
    if(date) localStorage.setItem('lastEventDate', date);
    return { number, animalId, date };
  }
  const ctx = getContext();
  try { window.dataLayer.push({event:'page_view', page:'/add-event', ctx}); } catch(_){}

  function buildTargetUrl(page){
    const p = new URLSearchParams();
    if (ctx.animalId) p.set('animalId', ctx.animalId);
    if (ctx.number) p.set('number', ctx.number);
    if (ctx.date) p.set('date', ctx.date);
    const curr=getQuery();
    ['demo','farmId','tenantId','userId','eventDate'].forEach(k=>{ if(curr[k] && !p.has(k)) p.set(k,curr[k]); });
    return `${page}?${p.toString()}`;
  }

  // ========== Outbox محلي ==========
  const BOX_KEY = 'mbk_outbox_events';
  function pushOutbox(evt){
    const box = JSON.parse(localStorage.getItem(BOX_KEY) || '[]');
    box.push({...evt, _ts: Date.now()});
    localStorage.setItem(BOX_KEY, JSON.stringify(box.slice(-200))); // سقف 200
  }
  async function flushOutbox(){
    const box = JSON.parse(localStorage.getItem(BOX_KEY) || '[]');
    if (!box.length) return;
    const remain=[];
    for (const evt of box){
      const ok = await tryApi(evt) || await tryFirestore(evt);
      if (!ok) remain.push(evt);
    }
    localStorage.setItem(BOX_KEY, JSON.stringify(remain));
  }
  on(window, 'online', flushOutbox);
  setTimeout(flushOutbox, 1500);

  // ========== مسارات الحفظ ==========
  async function tryFirestore(payload){
    try{
      const [{ initializeApp, getApps }, { getFirestore, addDoc, collection, serverTimestamp }] =
        await Promise.all([
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        ]);

      const { default: fb } = await import('/js/firebase-config.js');
      const cfg = fb?.config || fb;
      if (!cfg?.projectId || !cfg?.apiKey) throw new Error('cfg-missing');
      const app = (getApps && getApps().length) ? getApps()[0] : initializeApp(cfg);
      const db = getFirestore(app);

      await addDoc(collection(db,'events'), {
        ...payload,
        createdAt: serverTimestamp()
      });
      return true;
    } catch(e){ logDev(e); return false; }
  }

  async function tryApi(payload){
    try{
      const base = '
