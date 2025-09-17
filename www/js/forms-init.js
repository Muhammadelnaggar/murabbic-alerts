// www/js/forms-init.js — تفعيل مركزي لكل الصفحات
import { attachFormValidation, calvingDecision } from './form-rules.js';
import { db, auth } from './firebase-config.js';
import {
  collection, query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

(function () {
  const ctxBase = { todayISO: new Date().toISOString().slice(0,10) };
  const form = document.querySelector('#calving-form') || document.querySelector('form');
  if (!form) return; // صفحة عرض فقط
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

  // جلب سياق الولادة + فحص تكرار نفس التاريخ
  async function fetchCalvingCtx(clean){
    const num = (clean?.animalNumber || form.querySelector('[data-field="animalNumber"],#animalNumber')?.value || '').trim();
    const evDate = (clean?.eventDate || form.querySelector('[data-field="eventDate"],#eventDate')?.value || '').trim();
    const uid = await getUid();
    if (!uid || !num) return { species:'', reproStatus:'', lastInseminationISO:'', dup:false };

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

    // آخر تلقيح
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

    // تكرار نفس تاريخ الولادة
    let dup = false;
    if (evDate){
      const s3 = await getDocs(query(
        collection(db,'events'),
        where('userId','==',uid),
        where('animalNumber','==',num),
        where('type','in',['ولادة','calving']),
        where('eventDate','==',evDate),
        limit(1)
      ));
      dup = !s3.empty;
    }

    return { species, reproStatus, lastInseminationISO, dup };
  }

  async function attachCentral(){
    const t = resolveType();
    if (!t) return;

    if (t === 'calving'){
      attachFormValidation(form, 'calving', {
        ...ctxBase,
        guard: async (clean) => {
          const { species, reproStatus, lastInseminationISO, dup } = await fetchCalvingCtx(clean);

          // 1) منع تكرار الولادة لنفس التاريخ
          if (dup) {
            return { ok:false, errors:{ eventDate:'هناك ولادة مسجلة لنفس اليوم لهذا الحيوان.' } };
          }

          // 2) الحد الأدنى للحمل/الحالة — باستخدام دالتك كما هي
          const allowed = calvingDecision({
            species,
            reproStatus,
            lastInseminationISO,
            eventDateISO: clean.eventDate,
            animalNumber: clean.animalNumber
          });
          // calvingDecision عندك ترجع Boolean → حوّلها لصيغة {ok}
          return allowed === true ? {ok:true} : {ok:false, errors:{ _form:'لا يمكن حفظ الولادة حسب القواعد.' }};
        }
      });
    } else {
      attachFormValidation(form, t, { ...ctxBase });
    }

    form.dataset.validationAttached = '1';
  }

  // أول ربط
  attachCentral();
  // لو عندك select يغيّر نوع الحدث داخل نفس الفورم
  if (selType){
    selType.addEventListener('change', ()=>{
      form.dataset.validationAttached = '';
      attachCentral();
    });
  }
})();
