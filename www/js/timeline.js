// /js/timeline.js  (type="module")
// يحافظ على init/log ويضيف: popup, check, checkWithPopup, وقواعد التلقيح مركزيًا.

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, serverTimestamp, enableIndexedDbPersistence,
  getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ========= Firestore + Offline ========= */
const _db = getFirestore(getApp());
enableIndexedDbPersistence(_db).catch(() => {});

/* ========= طابور تسجيل الأنشطة (لا يمس) ========= */
const _q = []; let _flushing = false;
async function _flush(){
  if (_flushing) return; _flushing = true;
  while(_q.length){
    const { tenantId, payload } = _q.shift();
    try {
      await addDoc(collection(_db, `tenants/${tenantId}/activity`), payload);
    } catch (e) {
      _q.unshift({ tenantId, payload }); break; // نتوقف عند فشل الشبكة/الصلاحيات
    }
  }
  _flushing = false;
}

/* ========= أدوات عامة ========= */
const DAY = 24*60*60*1000;
const iso = d => new Date(d).toISOString().slice(0,10);
const diffDays = (a,b)=> Math.round((new Date(a+'T00:00:00') - new Date(b+'T00:00:00'))/DAY);
const norm = v => (v==null || v==='undefined' || v==='null' || v==='NaN') ? '' : String(v).trim();

/* ========= Popup مركزي (منتصف الشاشة) ========= */
function ensurePopupHost(){
  let host = document.getElementById('mbk-popup-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'mbk-popup-host';
  host.innerHTML = `
    <style>
      #mbk-popup-host .mbk-mask{position:fixed;inset:0;background:rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;z-index:9999}
      #mbk-popup-host .mbk-card{max-width:560px;width:calc(100% - 32px);background:#fff;border-radius:14px;border:1px solid #e2e8f0;box-shadow:0 10px 30px rgba(0,0,0,.14)}
      #mbk-popup-host .mbk-body{padding:18px 16px 8px;font:15px system-ui,'Cairo',Arial;color:#0f172a}
      #mbk-popup-host .mbk-title{font-weight:800;margin:0 0 8px;color:#0b7f47}
      #mbk-popup-host .mbk-msg{margin:0 0 4px;line-height:1.6}
      #mbk-popup-host .mbk-actions{display:flex;gap:10px;justify-content:flex-end;padding:12px 16px}
      #mbk-popup-host .btn{appearance:none;border:0;border-radius:10px;padding:10px 12px;font-weight:700;cursor:pointer}
      #mbk-popup-host .ok{background:#0ea05a;color:#fff}
      #mbk-popup-host .warn{background:#eef2f7;color:#0f172a;border:1px solid #cbd5e1}
      #mbk-popup-host .err-title{color:#9a3412}
    </style>
    <div class="mbk-mask" style="display:none">
      <div class="mbk-card" role="dialog" aria-modal="true" aria-live="assertive">
        <div class="mbk-body">
          <h3 class="mbk-title">تنبيه من مربيك</h3>
          <p class="mbk-msg"></p>
        </div>
        <div class="mbk-actions">
          <button class="btn warn" data-action="cancel">إغلاق</button>
          <button class="btn ok" data-action="ok">متابعة</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(host);
  return host;
}
function popup(message, kind='info', {okText='متابعة', cancelText='إغلاق', cancellable=true}={}){
  const host = ensurePopupHost();
  const mask = host.querySelector('.mbk-mask');
  const msg  = host.querySelector('.mbk-msg');
  const title= host.querySelector('.mbk-title');
  const okBtn= host.querySelector('button[data-action="ok"]');
  const canBtn= host.querySelector('button[data-action="cancel"]');

  title.classList.toggle('err-title', kind==='error');
  title.textContent = kind==='error' ? 'تنبيه هام' : 'تنبيه من مربيك';
  msg.innerHTML = message;
  okBtn.textContent = okText;
  canBtn.textContent = cancelText;
  canBtn.style.display = cancellable ? '' : 'none';

  mask.style.display = 'flex';
  return new Promise(resolve=>{
    const close = (val)=>{
      mask.style.display = 'none';
      okBtn.removeEventListener('click', okH);
      canBtn.removeEventListener('click', canH);
      mask.removeEventListener('click', bgH);
      resolve(val);
    };
    const okH  = ()=> close(true);
    const canH = ()=> close(false);
    const bgH  = (e)=> { if(e.target===mask && cancellable) close(false); };
    okBtn.addEventListener('click', okH);
    canBtn.addEventListener('click', canH);
    mask.addEventListener('click', bgH);
  });
}

/* ========= جلب أحداث الحيوان حتى تاريخ معيّن ========= */
async function fetchEventsUntil(userId, animalNumber, uptoISO){
  try{
    const qy = query(
      collection(_db, 'events'),
      where('userId','==', userId),
      where('animalNumber','==', animalNumber),
      orderBy('eventDate','desc'),
      limit(50)
    );
    const snap = await getDocs(qy);
    const arr = [];
    snap.forEach(d=>{
      const x = d.data() || {};
      if (x?.eventDate && x.eventDate <= uptoISO) arr.push(x);
    });
    arr.sort((a,b)=> a.eventDate < b.eventDate ? 1 : -1); // تنازلي
    return arr;
  }catch(e){
    console.warn('fetchEventsUntil faile
