// www/js/forms-init.js — تفعيل مركزي لكل الصفحات
import { attachFormValidation, calvingDecision } from './form-rules.js';

// (اختياري/مطلوب لصفحة الولادة فقط)
import { db, auth } from './firebase-config.js';
import {
  collection, query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// اليوم بصيغة ISO
const ctxBase = { todayISO: new Date().toISOString().slice(0,10) };

// اختَر الفورم الصحيح: لو موجود #calving-form استخدمه، وإلا أول <form>
const form = document.querySelector('#calving-form') || document.querySelector('form');
if (!form) {
  // صفحة عرض فقط
  export default null;
} else {
  // امنع الـ attach المزدوج
  if (form.dataset.validationAttached === '1') {
    // سبق وتم الربط
  } else {
    const file = (location.pathname.split('/').pop() || '').toLowerCase();

    // خريطة الصفحات -> نوع الحدث
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
      // أضف صفحات أخرى حسب الحاجة
    };

    // لو عندك حقل يحدد نوع الحدث داخل نفس الفورم (مثل add-event)
    const selType = form.querySelector('[data-field="eventType"]');
    const resolveType = () => (selType?.value) || pageToType[file] || '';

    // ---------- أدوات دعم الولادة (مركزيًا هنا) ----------
    async function getUid(){
      const ls = localStorage.getItem('userId') || localStorage.getItem('uid');
      if (ls) return ls;
      if (auth?.currentUser) return auth.currentUser.uid;
      const u = await new Promise(res => onAuthStateChanged(auth, u => res(u)));
      return u?.uid || '';
    }

    async function fetchCalvingCtx(){
      // نقرأ رقم الحيوان من الحقل الموجود في أي صفحة
      const numEl = form.querySelector('[data-field="animalNumber"], #animalNumber');
      const num = (numEl?.value || '').trim();
      const uid = await getUid();
      if (!uid || !num) return { species:'', reproStatus:'', lastInseminationISO:'' };

      // النوع + الحالة من animals
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

      // محاولة 1: events.type
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

      // محاولة 2: events.eventType
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

      // محاولة 3: آخر 50 حدث وفِلتر محلي
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
          if (t==='تلقيح' || t==='insemination') {
            const dt = ev.eventDate || '';
            if (dt && (!latest || dt > latest)) latest = dt;
          }
        });
        lastInseminationISO = latest || '';
      }

      return { species, reproStatus, lastInseminationISO };
    }
    // ------------------------------------------------------

    function attachCentral(){
      const t = resolveType();
      if (!t) return; // صفحة غير معروفة — نسكت

      // لا تُعيد الربط
      if (form.dataset.validationAttached === '1') return;

      if (t === 'calving'){
        // ربط الولادة مع الحارس المركزي
        attachFormValidation(form, 'calving', {
          ...ctxBase,
          guard: async (clean) => {
            const { species, reproStatus, lastInseminationISO } = await fetchCalvingCtx();
            return calvingDecision({
              species,
              reproStatus,
              lastInseminationISO,
              eventDateISO: clean.eventDate,     // من الحقول (data-field)
              animalNumber: clean.animalNumber
            });
          }
        });
      } else {
        // باقي الصفحات — بدون حارس
        attachFormValidation(form, t, { ...ctxBase });
      }

      form.dataset.validationAttached = '1';
    }

    // أول مرة
    attachCentral();
    // لو فيه select يغيّر نوع الحدث في نفس الصفحة (add-event)
    if (selType) selType.addEventListener('change', ()=>{
      // لو حبيت تدعم إعادة التبديل بين أنواع — يمكنك مسح علامة الربط وإعادة الربط:
      form.dataset.validationAttached = '';
      attachCentral();
    });
  }
}
