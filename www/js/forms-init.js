// www/js/forms-init.js
import { attachFormValidation, calvingDecision } from './form-rules.js';
import { db, auth } from './firebase-config.js';
import {
  collection, query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

(function startWhenReady(){
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once:true });
  } else {
    bootstrap();
  }

  async function getUid(){
    const ls = localStorage.getItem('userId') || localStorage.getItem('uid');
    if (ls) return ls;
    if (auth?.currentUser) return auth.currentUser.uid;
    const u = await new Promise(res => onAuthStateChanged(auth, u => res(u)));
    return u?.uid || '';
  }

  async function fetchCalvingCtx(form, clean){
    const num = (clean?.animalNumber || form.querySelector('[data-field="animalNumber"],#animalNumber')?.value || '').trim();
    const evDate = (clean?.eventDate || form.querySelector('[data-field="eventDate"],#eventDate')?.value || '').trim();
    const uid = await getUid();
    if (!uid || !num) return { species:'', reproStatus:'', lastInseminationISO:'', dup:false };

    const aSnap = await getDocs(query(
      collection(db,'animals'),
      where('userId','==',uid),
      where('animalNumber','==',num),
      limit(1)
    ));
    const animal = aSnap.empty ? {} : aSnap.docs[0].data();
    const species     = animal.type || animal.species || animal['النوع'] || '';
    const reproStatus = animal.reproStatus || animal['الحالة التناسلية'] || '';

    let lastInseminationISO = '';
    try {
      const s1 = await getDocs(query(
        collection(db,'events'),
        where('userId','==',uid),
        where('animalNumber','==',num),
        where('type','in',['تلقيح','insemination']),
        orderBy('eventDate','desc'), limit(1)
      ));
      if (!s1.empty) lastInseminationISO = s1.docs[0].data().eventDate || '';
    } catch {}
    if (!lastInseminationISO){
      try {
        const s2 = await getDocs(query(
          collection(db,'events'),
          where('userId','==',uid),
          where('animalNumber','==',num),
          where('eventType','in',['تلقيح','insemination']),
          orderBy('eventDate','desc'), limit(1)
        ));
        if (!s2.empty) lastInseminationISO = s2.docs[0].data().eventDate || '';
      } catch {}
    }

    // منع تكرار نفس تاريخ الولادة
    let dup = false;
    if (evDate){
      const s3 = await getDocs(query(
        collection(db,'events'),
        where('userId','==',uid),
        where('animalNumber','==',num),
        where('eventDate','==',evDate),
        limit(5)
      ));
      s3.forEach(d=>{
        const ev = d.data();
        const t = (ev.type || ev.eventType || ev['نوع الحدث'] || '').toString().toLowerCase();
        if (t === 'ولادة' || t === 'calving') dup = true;
      });
    }

    return { species, reproStatus, lastInseminationISO, dup };
  }

  function bootstrap(){
    // اختر الفورم مرة واحدة
    const form = document.querySelector('#calving-form') || document.querySelector('form');
    if (!form) return;

    // امنع أي ربط سابق
    if (form.dataset.validationAttached === '1') return;
    form.dataset.validationAttached = '1';

    const ctxBase = { todayISO: new Date().toISOString().slice(0,10) };
    const file = (location.pathname.split('/').pop() || '').toLowerCase();
    const selType = form.querySelector('[data-field="eventType"]');
    const pageToType = {
      'insemination.html'        : 'insemination',
      'pregnancy-diagnosis.html' : 'pregnancy_diagnosis',
      'calving.html'             : 'calving',
      'daily-milk.html'          : 'daily_milk',
      'dry-off.html'             : 'dry_off',
      'close-up.html'            : 'close_up',
      'visual-eval.html'         : 'milking_traits_eval',
      'bcs-eval.html'            : 'bcs_eval',
      'feces-eval.html'          : 'feces_eval',
      'mastitis.html'            : 'mastitis',
      'lameness.html'            : 'lameness',
      'vaccination.html'         : 'vaccination',
      'nutrition.html'           : 'nutrition'
    };
    const resolveType = () => (selType?.value) || pageToType[file] || '';

    function attachForType(){
      const t = resolveType();
      if (!t) return;

      // فك أي ربط قديم لمنع التسريب/التكرار
      form.querySelectorAll('.field-msg').forEach(n=>n.remove());
      form.querySelectorAll('.invalid').forEach(el=> el.classList.remove('invalid'));

      if (t === 'calving'){
        attachFormValidation(form, 'calving', {
          ...ctxBase,
          guard: async (clean) => {
            const { species, reproStatus, lastInseminationISO, dup } = await fetchCalvingCtx(form, clean);
            if (dup) return { ok:false, errors:{ eventDate:'هناك ولادة مسجلة لنفس اليوم لهذا الحيوان.' } };

            const dec = calvingDecision({
              species, reproStatus,
              lastInseminationISO,
              eventDateISO: clean.eventDate,
              animalNumber: clean.animalNumber
            });
            return (dec && typeof dec === 'object')
              ? dec
              : (dec === true ? {ok:true} : {ok:false, errors:{ _form:'لا يمكن حفظ الولادة حسب القواعد.' }});
          }
        });
      } else {
        attachFormValidation(form, t, { ...ctxBase });
      }
    }

    attachForType();
    if (selType){
      selType.addEventListener('change', attachForType, { passive:true });
    }
  }
})();
