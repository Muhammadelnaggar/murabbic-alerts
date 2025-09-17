/* مُرَبِّك — قواعد إدخال النماذج (Frontend Validation)
   استعمال:
     import { attachFormValidation } from '/js/form-rules.js';
     attachFormValidation(formEl, 'insemination', {seasonStart:'2025-06-01', todayISO:'2025-09-09'});
*/

const AR_DIGITS_RX = /[٠-٩۰-۹]/g;
const AR_DIGITS_MAP = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
                       '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};

export function normalizeDigits(s){
  if (s == null) return s;
  return String(s).replace(AR_DIGITS_RX, d=>AR_DIGITS_MAP[d]||d).trim();
}

export function isISODate(str){
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function toNumber(v){
  const s = normalizeDigits(v);
  if (s === '' || s == null) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function inEnum(v, arr){ return arr.includes(v); }

function between(n, min, max){
  return Number.isFinite(n) && n >= min && n <= max;
}

/* ========= قواعد عامة مشتركة ========= */
const COMMON = {
  eventDate: {
    required: true,
    test: (v, ctx)=>{
      if (!isISODate(v)) return 'التاريخ بصيغة YYYY-MM-DD';
      if (ctx?.seasonStart && v < ctx.seasonStart) return `لا يجوز قبل بداية الموسم ${ctx.seasonStart}`;
      if (ctx?.todayISO && v > ctx.todayISO) return 'لا يجوز بتاريخ مستقبلي';
      return true;
    }
  },
  animalNumber: {
    required: true,
    normalize: normalizeDigits,
    test: (v)=> v && v.length<=20 || 'رقم الحيوان غير صالح'
  }
};

/* ========= سكيمات حسب نوع الحدث ========= */
const SCHEMAS = {

  // ——— تلقيح ———
  insemination: {
    ...COMMON,
    timeOfDay: {
      required: true,
      normalize: (v)=> (v||'').trim(),
      test: (v)=> inEnum(v, ['صباح','مساء']) || 'اختر صباح/مساء'
    },
    bullName: {
      required: true,
      test: (v)=> (v||'').trim().length>=2 || 'اسم الطلوقة مطلوب'
    },
    strawNo: {
      required: false,
      normalize: normalizeDigits,
      test: (v)=> !v || /^[A-Za-z0-9\-]{1,15}$/.test(v) || 'رقم القشّة حروف/أرقام وشرطة فقط'
    },
    daysInMilk: {
      required: false,
      normalize: toNumber,
      test: (n)=> Number.isNaN(n) || between(n, 0, 600) || 'DIM بين 0 و 600'
    },
    heatScore: {
      required: false,
      normalize: toNumber,
      test: (n)=> Number.isNaN(n) || between(n, 1, 3) || 'درجة الشبق 1..3'
    },
    technician: { required:false }
  },

  // ——— تشخيص حمل ———
  pregnancy_diagnosis: {
    ...COMMON,
    result: {
      required: true,
      test: (v)=> inEnum(v, ['حامل','غير حامل']) || 'اختر النتيجة: حامل/غير حامل'
    },
    method: {
      required: false,
      test: (v)=> !v || inEnum(v, ['سونار','يدوي']) || 'الطريقة: سونار/يدوي'
    },
    fetusAgeDays: {
      required: false,
      normalize: toNumber,
      test: (n)=> Number.isNaN(n) || between(n, 20, 200) || 'عمر الجنين 20..200 يوم'
    },
    twin: { required:false }
  },

  // ——— ولادة ———
  calving: {
    ...COMMON,
    calvingType: { required:false }, // مفرد/توائم
    calfSex: { required:false, test:(v)=> !v || inEnum(v,['ذكر','أنثى']) || 'الجنس: ذكر/أنثى' },
    calfNumber: { required:false, normalize: normalizeDigits },
    retainedPlacenta: { required:false }
  },

  // ——— لبن يومي ———
  daily_milk: {
    ...COMMON,
    milkKg: { required:true, normalize: toNumber, test:(n)=> between(n, 0, 80) || 'اللبن بالكيلو 0..80' },
    shift: { required:true, test:(v)=> inEnum(v,['صباح','مساء']) || 'اختر الوردية: صباح/مساء' },
    fatPct: { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 0, 10) || 'دهن % 0..10' },
    proteinPct:{ required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 0, 8) || 'بروتين % 0..8' },
    lactosePct:{ required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 0, 8) || 'لاكتوز % 0..8' },
    scc:     { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 0, 5000_000) || 'SCC حتى 5 مليون' },
    ec:      { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 0, 20) || 'EC mS/cm حتى 20' },
  },

  // ——— سمات اللبن (كاميرا) ———
  milking_traits_eval: {
    ...COMMON,
    milkingSpeed: { required:true,  normalize: toNumber, test:(n)=> between(n, 0.1, 8) || 'سرعة الحلب 0.1..8 كجم/د' },
    letdownTime:  { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 5, 300) || 'نزول اللبن 5..300 ث' },
    mastitisRisk: { required:false, test:(v)=> !v || inEnum(v,['منخفض','متوسط','مرتفع']) || 'مخاطر الضرع: منخفض/متوسط/مرتفع' },
    teatLength:   { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 20, 80) || 'طول الحلمة 20..80 مم' },
    teatDiameter: { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n, 10, 40) || 'قطر الحلمة 10..40 مم' }
  },

  // ——— التهاب ضرع / عرج / تطعيم ———
  mastitis: {
    ...COMMON,
    quarter: { required:true, test:(v)=> inEnum(v,['RF','LF','RH','LH']) || 'الربع: RF/LF/RH/LH' },
    cmtScore:{ required:false, test:(v)=> !v || inEnum(v,['N','T','1','2','3']) || 'CMT: N/T/1/2/3' },
    severity:{ required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,1,3) || 'الشدة 1..3' }
  },
  lameness: {
    ...COMMON,
    lamenessScore: { required:true, normalize: toNumber, test:(n)=> between(n,1,5) || 'درجة العرج 1..5' },
    affectedLeg:   { required:false, test:(v)=> !v || inEnum(v,['RF','LF','RH','LH']) || 'الرجل: RF/LF/RH/LH' }
  },
  vaccination: {
    ...COMMON,
    vaccineName: { required:true, test:(v)=> (v||'').trim().length>=2 || 'اسم اللقاح مطلوب' },
    dose:        { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,0.1, 50) || 'الجرعة رقمية' },
    route:       { required:false, test:(v)=> !v || inEnum(v,['SC','IM','IV','PO','IN']) || 'مسار: SC/IM/IV/PO/IN' }
  },

  // ——— تغذية ———
  nutrition: {
    ...COMMON,
    rationType: { required:false },
    dmPct:      { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,20,60) || 'DM % 20..60' },
    cpPct:      { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,10,24) || 'CP % 10..24' },
    ndfPct:     { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,25,45) || 'NDF % 25..45' },
    starchPct:  { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,10,35) || 'نشا % 10..35' },
    feedCost:   { required:false, normalize: toNumber, test:(n)=> Number.isNaN(n) || between(n,0, 5000) || 'تكلفة رقمية' }
  }
};

/* ========== المحرّك ========== */
/**
 * يتحقق من كائن بيانات واحد وفق سكيمة النوع.
 * @returns { ok:boolean, data:any, errors:Record<string,string> }
 */
export function validateEvent(eventType, data, ctx={}){
  const schema = SCHEMAS[eventType];
  if (!schema) return {ok:false, data, errors:{_:'نوع الحدث غير معروف'}};

  const clean = {};
  const errors = {};

  for (const key in schema){
    const rule = schema[key];
    let val = data[key];

    // Normalize (تحويل أرقام عربية/تفريغ مسافات…)
    if (rule.normalize) val = rule.normalize(val);

    // Required
    if (rule.required && (val === undefined || val === null || val === '')){
      errors[key] = 'هذا الحقل مطلوب';
    }

    // Custom test
    if (!errors[key] && rule.test){
      const res = rule.test(val, ctx);
      if (res !== true) errors[key] = res || 'قيمة غير صالحة';
    }

    clean[key] = val;
  }

  return { ok: Object.keys(errors).length===0, data: clean, errors };
}

/* ========== ربط بالنموذج ========== */
/**
 * يربط النموذج ليعرض الأخطاء تحت الحقول ويمنع الإرسال عند وجودها.
 * يتوقع أن تكون الحقول تحمل data-field="اسم_الحقل".
 */
export function attachFormValidation(formEl, eventType, ctx={}){
  const submitBtn = formEl.querySelector('[type="submit"]');

  // عنصر خطأ أسفل كل حقل
  function ensureErrorEl(fieldEl){
    let msg = fieldEl.parentElement.querySelector('.field-msg');
    if (!msg){
      msg = document.createElement('div');
      msg.className = 'field-msg';
      fieldEl.parentElement.appendChild(msg);
    }
    return msg;
  }

  // رسالة عامة أسفل/يمين النموذج (بدون بوب-أب)
  function ensureFormMsg(formEl){
    let box = formEl.querySelector('.form-msg');
    if(!box){
      box = document.createElement('div');
      box.className = 'form-msg';
      box.style.cssText = 'margin-top:10px;color:#c62828;text-align:right;direction:rtl;font:12px system-ui';
      formEl.appendChild(box);
    }
    return box;
  }
  function clearFormMsg(formEl){
    const box = formEl.querySelector('.form-msg');
    if (box) box.textContent = '';
  }

  function readForm(){
    const out = {};
    formEl.querySelectorAll('[data-field]').forEach(el=>{
      const k = el.getAttribute('data-field');
      let v = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value;
      out[k] = v;
    });
    return out;
  }

  function renderErrors(errors){
    // امسح
    formEl.querySelectorAll('.invalid').forEach(el=> el.classList.remove('invalid'));
    formEl.querySelectorAll('.field-msg').forEach(el=> el.textContent='');
    clearFormMsg(formEl);

    if (!errors) return;

    for (const k in errors){
      if (k === '_form') continue;
      const el = formEl.querySelector(`[data-field="${k}"]`);
      if (!el) continue;
      el.classList.add('invalid');
      const m = ensureErrorEl(el);
      m.textContent = errors[k];
    }

    if (errors._form){
      const fm = ensureFormMsg(formEl);
      fm.textContent = errors._form;
    }
  }

  function validateAndShow(){
    const data = readForm();
    const {ok, data:clean, errors} = validateEvent(eventType, data, ctx);
    renderErrors(errors);
    if (submitBtn) submitBtn.disabled = !ok;
    return {ok, clean, errors};
  }

  // أولي + عند الإدخال
  validateAndShow();
  formEl.addEventListener('input', validateAndShow);
  formEl.addEventListener('change', validateAndShow);

  // عند الإرسال (مع حارس اختياري بلا أي نوافذ)
 formEl.addEventListener('submit', async (e)=>{
  const {ok, clean, errors} = validateAndShow();
  if (!ok){ e.preventDefault(); e.stopPropagation(); return; }

  // 🔒 حارس اختياري (مثلاً للولادة)
  if (typeof ctx.guard === 'function') {
    const g = await Promise.resolve(ctx.guard(clean));
    const allow = (g === true) || (g && g.ok === true);
    if (!allow) {
      e.preventDefault(); e.stopPropagation();
      const gErrors = (g && g.errors) ? g.errors : {_form:'غير مسموح بالحفظ حسب القواعد.'};
      renderErrors(gErrors);
      return;
    }
  }

  // استبدال القيم المنظّفة…
  for (const k in clean){
    const el = formEl.querySelector(`[data-field="${k}"]`);
    if (el && el.type!=='checkbox') el.value = clean[k] ?? '';
  }
});

}

// ======== حسابات بسيطة مساعدة للولادة ========

// فرق الأيام بين تاريخين ISO (YYYY-MM-DD)
// فرق الأيام (UTC) من دون تأثير المنطقة الزمنية
export function daysBetween(aISO, bISO){
  const [ay, am, ad] = aISO.split('-').map(Number);
  const [by, bm, bd] = bISO.split('-').map(Number);
  const a = Date.UTC(ay, am-1, ad);
  const b = Date.UTC(by, bm-1, bd);
  return Math.floor((b - a) / 86400000);
}


// حدّ أدنى للحمل حسب النوع: أبقار 255 / جاموس 285
export function speciesMinDays(speciesStr){
  const s = (speciesStr||'').toString().toLowerCase();
  const isBuffalo = /buff|جاموس/.test(s);
  return { min: isBuffalo ? 285 : 255, kind: isBuffalo ? 'الجاموسة' : 'البقرة' };
}

/**
 * قرار حفظ الولادة (نسخة صامتة بلا أي نوافذ):
 * - يشترط الحالة التناسلية "عشار" إن كانت معروفة.
 * - يمنع الحفظ لو عمر الحمل أقل من الحد الأدنى (255 أبقار / 285 جاموس).
 * - يُرجِع { ok:false, errors:{ ... , _form } } لعرضها داخليًا.
 */
export function calvingDecision({
  species,
  reproStatus,
  lastInseminationISO,
  eventDateISO,
  animalNumber
}){
  const errors = {};

  // اعتبر أي نص يحتوي "عشار" = حامل
  const rs = (reproStatus || '').toString().trim();
  const isPreg = /عشار/.test(rs);

  // لو الحالة مذكورة وليست "عشار" → امنع
  if (rs && !isPreg) {
    errors.reproStatus = 'لا يمكن تسجيل ولادة لحيوان غير «عشار».';
    errors._form = 'الحالة التناسلية تمنع الحفظ.';
    return { ok:false, errors };
  }

  // إن كانت عشار فلابد من تواريخ صحيحة لحساب عمر الحمل
  if (isPreg){
    if (!isISODate(lastInseminationISO)){
      errors.lastPregnantInseminationDate = 'سجّل تاريخ آخر تلقيح مُخصِّب أولًا.';
    }
    if (!isISODate(eventDateISO)){
      errors.eventDate = 'التاريخ بصيغة YYYY-MM-DD.';
    }
    if (Object.keys(errors).length){
      errors._form = 'لا يمكن التحقق من عمر الحمل بدون تواريخ صحيحة.';
      return { ok:false, errors };
    }

    // حساب عمر الحمل والحد الأدنى حسب النوع
    const { min, kind } = speciesMinDays(species); // 255 بقر / 285 جاموس
    const ga = daysBetween(lastInseminationISO, eventDateISO);

    if (ga < 0) { // تاريخ ولادة أقدم من آخر تلقيح
      errors.eventDate = 'تاريخ الولادة أقدم من تاريخ آخر تلقيح.';
      errors._form = 'راجع التواريخ.';
      return { ok:false, errors };
    }

    if (ga < min) {
      errors.eventDate = `عمر الحمل أقل من الحد الأدنى (${min} يوم) لـ${kind}.`;
      errors._form = 'هذه ولادة قبل الميعاد المنطقي. استخدم «إجهاض» بدلًا من الولادة.';
      return { ok:false, errors };
    }
  }

  return { ok:true };
}
