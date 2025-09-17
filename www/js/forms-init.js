// www/js/forms-init.js — تفعيل مركزي لكل الصفحات (بدون أي export)
import { attachFormValidation, calvingDecision } from './form-rules.js';

// مطلوب للولادة فقط (لجلب الحالة وآخر تلقيح)
import { db, auth } from './firebase-config.js';
import {
  collection, query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const ctxBase = { todayISO: new Date().toISOString().slice(0,10) };
const form = document.querySelector('#calving-form') || document.querySelector('form');
if (!form) { /* صفحة عرض فقط */ } else {
  // امنع الربط المزدوج
  if (form.dataset.validationAttached === '1') return;

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

  async function getUid(){
    const ls = localStorage.getItem('userId') || localStorage.getItem('uid');
    if (ls) return ls;
    if (auth?.currentUser) return auth.currentUser.uid;
    const u = await new Promise(res => onAuthStateChanged(auth, u => res(u)));
    return u?.uid || '';
  }

  // جلب سياق الولادة
  async function fetchCalvingCtx(){
    const numEl = form.querySelector('[data-field="animalNumber"], #animalNumber');
    const num = (numEl?.value || '').trim();
    const uid = await getUid();
    if (!uid || !num) return { species:'', reproStatus:'', lastInseminationISO:'' };

    // النوع + الحالة
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
        orderBy('eventDate','desc'),
        limit(1)
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
          orderBy('eventDate','desc'),
          limit(1)
        ));
        if (!s2.empty) lastInseminationISO = s2.docs[0].data().eventDate || '';
      } catch {}
    }

    if (!lastInseminationISO){
      const s3 = await getDocs(query(
        collection(db,'events'),
        where('userId','==',uid),
        where('animalNumber','==',num),
        orderBy('eventDate','desc'),
        limit(50)
      ));
      let latest = '';
      s3.forEach(d=>{
        const ev = d.data();
        const t  = (ev.type || ev.eventType || ev['نوع الحدث'] || '').toString().trim().toLowerCase();
        if (t==='تلقيح' || t==='insemination'){
          const dt = ev.eventDate || '';
          if (dt && (!latest || dt > latest)) latest = dt;
        }
      });
      lastInseminationISO = latest || '';
    }
    return { species, reproStatus, lastInseminationISO };
  }

  async function attachCentral(){
    const t = resolveType();
    if (!t) return;
    if (t === 'calving'){
      attachFormValidation(form, 'calving', {
        ...ctxBase,
        // الحارس يمنع الولادة وهي "فارغة" أو "قبل 255/285 يوم"
        guard: async (clean) => {
          const { species, reproStatus, lastInseminationISO } = await fetchCalvingCtx();
          return calvingDecision({
            species,
            reproStatus,
            lastInseminationISO,
            eventDateISO: clean.eventDate,
            animalNumber: clean.animalNumber
          });
        }
      });
    } else {
      attachFormValidation(form, t, { ...ctxBase });
    }
    form.dataset.validationAttached = '1';
  }

  await attachCentral();
  if (selType) selType.addEventListener('change', ()=>{
    form.dataset.validationAttached = '';
    attachCentral();
  });
}
