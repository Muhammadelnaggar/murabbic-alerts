// /js/forms-init.js — ESM
// يركّب تلقائيًا على أي <form data-validate="true" data-event="اسم الحدث">
// يجمع كل [data-field] ويُظهر رسائل في infobar أعلى النموذج.
// لا يُغيّر أي تصميم؛ لو مفيش infobar يصنع شريطًا صغيرًا فقط للرسالة.
// عند النجاح: يطلق حدثًا "mbk:valid" ويحمل البيانات في detail.formData.

import { validateEvent } from './form-rules.js';

function ensureInfoBar(form) {
  let bar = form.querySelector('.infobar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'infobar';
    // ستايل خفيف غير مخرّب للتصميم القائم
    bar.style.cssText = `
      margin:8px 0; padding:10px 12px; border-radius:10px;
      font: 14px/1.4 system-ui, 'Cairo', Arial;
      display:none; background:#fff; border:1px solid #e2e8f0; color:#0f172a;
    `;
    form.prepend(bar);
  }
  return bar;
}

function showMsg(bar, msgs, type="error") {
  if (!bar) return;
  bar.style.display = 'block';
  bar.style.borderColor = type === "error" ? "#ef9a9a" : "#bbf7d0";
  bar.style.background   = type === "error" ? "#ffebee" : "#ecfdf5";
  bar.style.color        = type === "error" ? "#b71c1c" : "#065f46";
  bar.innerHTML = Array.isArray(msgs) ? `<ul style="margin:0;padding-left:18px">${msgs.map(m=>`<li>${m}</li>`).join("")}</ul>` : msgs;
}

function collectFormData(form) {
  const data = {};
  form.querySelectorAll('[data-field]').forEach(el => {
    const k = el.getAttribute('data-field');
    let v = (el.type === 'checkbox') ? (el.checked ? (el.value || true) : "") :
            (el.type === 'radio') ? (el.checked ? el.value : data[k] || "") :
            el.value;
    data[k] = v;
  });
  // تطبيع شائع: لو فيه species فارغ حاول قراءته من localStorage
  if (!data.species && localStorage.getItem('herdSpecies')) {
    data.species = localStorage.getItem('herdSpecies'); // "أبقار"|"جاموس"
  }
  return data;
}

function attachOne(form) {
  const bar = ensureInfoBar(form);
  const eventName = form.getAttribute('data-event');
  if (!eventName) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const formData = collectFormData(form);
    const { ok, errors } = validateEvent(eventName, formData);

    if (!ok) {
      showMsg(bar, errors, "error");
      form.dataset.valid = "0";
      // تركيز أول خطأ إن أمكن
      const firstFieldName = (errors[0] || "").match(/«(.+?)»/)?.[1];
      if (firstFieldName) {
        const el = form.querySelector(`[data-field="${firstFieldName}"]`);
        if (el?.focus) el.focus();
      }
      return;
    }

    // نجاح ✅
    form.dataset.valid = "1";
    showMsg(bar, "✅ البيانات سليمة — جاري الحفظ...", "ok");

    // أطلِق حدث نجاح شامل؛ صفحة الحدث تتولّى onSave
    const ev = new CustomEvent('mbk:valid', { detail: { formData, eventName, form } });
    form.dispatchEvent(ev);
  });
}

function autoAttach() {
  document.querySelectorAll('form[data-validate="true"][data-event]').forEach(attachOne);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoAttach);
} else {
  autoAttach();
}

export { autoAttach };
