// www/js/forms-init.js
import { attachFormValidation } from './form-rules.js';

// تاريخ اليوم لسياق القيود
const ctx = { todayISO: new Date().toISOString().slice(0,10) };

// جِب أول فورم في الصفحة (أو عدّل لو عندك أكثر من فورم)
const form = document.querySelector('form');
if (!form) {
  // صفحات عرض فقط.. مفيش حاجة نعملها
} else {
  // 1) لو عندك قائمة نوع الحدث داخل الفورم (add-event.html مثلاً)
  const typeSel = form.querySelector('[data-field="eventType"]');
  if (typeSel) {
    const init = () => attachFormValidation(form, typeSel.value, ctx);
    init();
    typeSel.addEventListener('change', init);
  } else {
    // 2) لو الصفحة مخصصة لنوع حدث معيّن: حدده من اسم الملف
    const file = (location.pathname.split('/').pop() || '').toLowerCase();

    const pageToType = {
      'insemination.html':        'insemination',
      'pregnancy-diagnosis.html': 'pregnancy_diagnosis',
      'calving.html':             'calving',
      'daily-milk.html':          'daily_milk',
      'dry-off.html':             'dry_off',
      'close-up.html':            'close_up',
      'visual-eval.html':         'milking_traits_eval', // سمات اللبن (كاميرا)
      'bcs-eval.html':            'bcs_eval',
      'feces-eval.html':          'feces_eval',
      'mastitis.html':            'mastitis',
      'lameness.html':            'lameness',
      'vaccination.html':         'vaccination',
      'nutrition.html':           'nutrition',
      // صفحات ممكن تضيفها لاحقًا:
      // 'abortion.html':         'abortion',
      // 'disease.html':          'treatment' أو 'health' حسب ما تعتمد
    };

    const t = pageToType[file];
    if (t) {
      attachFormValidation(form, t, ctx);
    }
    // لو t غير معروف، السكربت يسكت بدون تأثير
  }
}
