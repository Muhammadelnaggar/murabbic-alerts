// /js/closeup.js
import { app } from '/js/firebase-config.js';
import {
  getFirestore, collection, addDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ملاحظة: يمكن استخدام window.__tenant.userId من tenant-bootstrap.js
const db = getFirestore(app);

// قراءة باراميترات من URL + نسخ احتياطية من التخزين
function getParam(name){
  const u = new URL(location.href);
  return u.searchParams.get(name) || '';
}
function getCtx(){
  const p = (k)=> getParam(k) || localStorage.getItem(k) || '';
  // دعم المفاتيح الشائعة المتفق عليها
  const animalId = p('animalId') || p('number') || p('animalNumber') || '';
  const eventDate = p('date') || p('eventDate') || '';
  return { animalId, eventDate };
}
function setIfEmpty(input, value){
  if (input && !input.value && value) input.value = value;
}
function storeCtx(animalId, eventDate){
  if (animalId) {
    localStorage.setItem('lastAnimalId', animalId);
    localStorage.setItem('currentAnimalId', animalId);
  }
  if (eventDate) {
    localStorage.setItem('lastEventDate', eventDate);
    localStorage.setItem('eventDate', eventDate);
  }
}
function buildUrl(path, params){
  const u = new URL(path, location.origin);
  Object.entries(params||{}).forEach(([k,v])=>{
    if (v !== undefined && v !== null && String(v).trim() !== '') u.searchParams.set(k, v);
  });
  return u.toString();
}

(async function init(){
  const form = document.getElementById('closeupForm');
  const inputAnimal = document.getElementById('animalId');
  const inputDate = document.getElementById('closeupDate');
  const confirmBox = document.getElementById('confirmBox');
  const goNutritionBtn = document.getElementById('goNutrition');
  const backDashBtn = document.getElementById('backDash');
  const dialog = document.getElementById('nutritionDialog');
  const ndYes = document.getElementById('nd_yes');
  const ndNo  = document.getElementById('nd_no');

  // تهيئة الحقول من السياق
  const ctx = getCtx();
  setIfEmpty(inputAnimal, ctx.animalId);
  setIfEmpty(inputDate, ctx.eventDate);

  // حفظ آخر قيم للرجوع السريع
  storeCtx(inputAnimal.value, inputDate.value);

  // إرسال النموذج → يحفظ في Firestore ثم يُظهر التأكيد داخل النموذج
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const animalId = (inputAnimal.value || '').trim();
    const eventDate = (inputDate.value || '').trim();
    const ration = (form.querySelector('input[name="ration"]:checked')?.value || '').trim();
    const anionicSalts = (form.querySelector('input[name="anionicSalts"]:checked')?.value || '').trim();

    if (!animalId || !eventDate) {
      alert('من فضلك أدخل رقم الحيوان وتاريخ التحضير.');
      return;
    }

    // تحضير الحِمل
    const payload = {
      userId: (window.__tenant?.userId || localStorage.getItem('userId') || '').trim(),
      animalId,
      animalNumber: animalId, // دعمًا للبحث برقم الحيوان إن استُخدم كرقم ظاهر
      eventType: 'تحضير للولادة',
      type: 'closeup',
      eventDate,
      ration,           // نعم/لا
      anionicSalts,     // نعم/لا
      source: location.pathname,
      createdAt: serverTimestamp()
    };

    // تتبّع قبل الحفظ
    window.t?.event('closeup_save_attempt', { page: location.pathname, animalId, eventDate });

    try {
      await addDoc(collection(db, 'events'), payload);

      // تتبّع نجاح
      window.t?.event('closeup_save', { page: location.pathname, animalId, eventDate });

      // تأكيد داخل النموذج
      confirmBox.style.display = 'block';

      // لو اختيار "عليقة التحضير" = نعم → أظهر حوار إدخال العليقة
      if (ration === 'نعم') {
        dialog.style.display = 'flex';
      }

      // حفظ السياق لصفحات لاحقة
      storeCtx(animalId, eventDate);
    } catch (err) {
      console.error('Firestore error (closeup):', err);
      window.t?.event('closeup_save_error', { message: String(err && err.message || err), page: location.pathname });
      alert('تعذّر حفظ تحضير الولادة. جرّب ثانيةً.');
    }
  });

  // أزرار التأكيد داخل النموذج
  backDashBtn?.addEventListener('click', ()=>{
    const to = form.dataset.redirect || '/dashboard.html';
    location.href = to;
  });

  goNutritionBtn?.addEventListener('click', ()=>{
    const url = buildUrl('/nutrition.html', {
      animalId: document.getElementById('animalId').value,
      date: document.getElementById('closeupDate').value
    });
    location.href = url;
  });

  // حوار التغذية
  ndNo?.addEventListener('click', ()=>{ dialog.style.display = 'none'; });
  ndYes?.addEventListener('click', ()=>{
    const url = buildUrl('/nutrition.html', {
      animalId: document.getElementById('animalId').value,
      date: document.getElementById('closeupDate').value
    });
    location.href = url;
  });
})();
