// /js/form-rules.js — ESM فقط قواعد (لا UI أو DOM)

// ===================== ثوابت عامة =====================
export const thresholds = {
  "أبقار": { minGestationDays: 255 },
  "جاموس": { minGestationDays: 285 },
};

// حد أدنى لتشخيص الحمل حسب وسيلة التشخيص
const MIN_PD_BY_METHOD = { "سونار": 26, "جس يدوي": 40 };

// حد أدنى لأيام ما بعد الولادة قبل التلقيح حسب النوع (كما ثبّتناه)
const MIN_DAYS_POST_CALVING_FOR_AI = { "أبقار": 56, "جاموس": 45 };

// ===================== أدوات مساعدة =====================
const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));
const daysBetween = (a, b) => {
  const d1 = toDate(a), d2 = toDate(b);
  if (!d1 || !d2) return NaN;
  return Math.round((d2.setHours(0,0,0,0) - d1.setHours(0,0,0,0)) / 86400000);
};
const req    = (v) => !(v === undefined || v === null || String(v).trim() === "");
const isDate = (v) => !Number.isNaN(toDate(v)?.getTime());
const isNum  = (v) => (v === "" ? true : !Number.isNaN(Number(v)));

// ===================== الحقول المشتركة =====================
const commonFields = {
  animalId:  { required: true,  msg: "رقم/معرّف الحيوان مفقود." },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
};

// ===================== سكيمات الأحداث =====================
export const eventSchemas = {
  // ——— الولادة ———
  "ولادة": {
    fields: {
      ...commonFields,
      species: { required: true, enum: ["أبقار","جاموس"], msg: "نوع القطيع مطلوب." },
      reproStatus: { required: true, enum: ["عشار"], msg: "الولادة تتطلّب الحالة «عِشار»." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
      gestationOverrideDays: { type: "number" }, // اختياري لتجاوز الحساب الآلي
    },
    guards: ["calvingDecision"],
  },

  // ——— التلقيح ———
  "تلقيح": {
    fields: {
      ...commonFields,
      species: { required: true, enum: ["أبقار","جاموس"], msg: "نوع القطيع مطلوب." },
      // نقبل الصيغ الشائعة لملقّح/ملقّحة بالإضافة إلى مفتوحة
      reproStatus: { required: true, enum: ["ملقح","ملقّح","ملقحة","ملقّحة","مفتوحة"], msg: "الحالة يجب أن تكون «ملقح/ملقّحة» أو «مفتوحة»." },
      lastCalvingDate: { required: true, type: "date", msg: "تاريخ آخر ولادة مطلوب." },
      hasInseminationSameDay: { type: "boolean" }, // اختياري لمنع التكرار في نفس اليوم إن ممرّر
      method: { required: false }, // اختياري (طبيعي/AI)، لا يغيّر القاعدة
    },
    guards: ["inseminationDecision"],
  },

  // ——— تشخيص الحمل ———
  "تشخيص حمل": {
    fields: {
      ...commonFields,
      // الشرط: الحالة «ملقّح/ملقّحة» (لا نقبل «مفتوحة» هنا)
      reproStatus: { required: true, enum: ["ملقح","ملقّح","ملقحة","ملقّحة"], msg: "تشخيص الحمل يتطلّب الحالة «ملقّح/ملقّحة»." },
      method: { required: true, enum: ["سونار","جس يدوي"], msg: "اختَر وسيلة التشخيص (سونار/جس يدوي)." },
      // نعتمد على «آخر تلقيح» أيًا كان (غير مشروط بكونه مُخصّب)
      lastInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مطلوب." },
      // النتيجة حسب صفحات مُرَبِّك
      result: { required: false, enum: ["عشار","فارغة"] },
    },
    guards: ["pregnancyDiagnosisDecision"],
  },

  // ——— الإجهاض ———
// ——— الإجهاض ———

 // — الإجهاض —
abortionDecision(fd) {
  const { reproStatus, lastFertileInseminationDate, eventDate } = fd;

  // الشرط الوحيد المطلوب
  if (reproStatus !== "عشار") {
    return "❌ الحيوان ليس عِشار، لا يمكن تسجيل الإجهاض.";
  }

  // باقي الفحص الحسابي فقط بدون رسائل أخرى
  const d = daysBetween(lastFertileInseminationDate, eventDate);
  if (Number.isNaN(d)) return "تعذّر حساب عمر الحمل عند الإجهاض.";
  const months = (d / 30).toFixed(1);
  return `✅ عمر الإجهاض التقريبي ${months} شهر.`;
},

  // ——— التجفيف ———
  "تجفيف": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار","غير عشار"], msg: "حدّث الحالة التناسلية قبل التجفيف." },
      reason: { required: true, msg: "سبب التجفيف مطلوب." },
    },
    guards: [],
  },
};

// ===================== تحقق الحقول =====================
function validateField(key, rule, value) {
  if (rule.required && !req(value)) return rule.msg || `الحقل «${key}» مطلوب.`;
  if (rule.type === "date" && value && !isDate(value)) return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;
  if (rule.type === "number" && !isNum(value)) return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;
  if (rule.enum && value && !rule.enum.includes(value)) return rule.msg || `قيمة «${key}» خارج القيم المسموحة.`;
  if (rule.min !== undefined && Number(value) < rule.min) return rule.msg || `قيمة «${key}» أقل من الحد الأدنى.`;
  if (rule.max !== undefined && Number(value) > rule.max) return rule.msg || `قيمة «${key}» أكبر من الحد الأقصى.`;
  return null;
}

// ===================== الحُرّاس (Guards) =====================
const guards = {
  // — الولادة —
  calvingDecision(fd) {
    const { species, reproStatus, lastFertileInseminationDate, eventDate, gestationOverrideDays } = fd;
    if (reproStatus !== "عشار") return "الولادة تتطلّب أن تكون الحالة «عِشار».";
    const th = thresholds[species]?.minGestationDays; if (!th) return "نوع القطيع غير معروف لتحديد حدّ عمر الحمل.";

    const gDays = req(gestationOverrideDays)
      ? Number(gestationOverrideDays)
      : daysBetween(lastFertileInseminationDate, eventDate);

    if (Number.isNaN(gDays)) return "تعذّر حساب عمر الحمل.";
    if (gDays < th) return `عمر الحمل ${gDays} يوم أقل من الحد الأدنى ${th} يوم.`;
    return null;
  },

  // — التلقيح — (حد أدنى بعد الولادة حسب النوع + إمكانية منع التكرار اليومي)
  inseminationDecision(fd) {
    const { species, reproStatus, lastCalvingDate, eventDate, hasInseminationSameDay } = fd;

    const okStatus = new Set(["ملقح","ملقّح","ملقحة","ملقّحة","مفتوحة"]);
    if (!okStatus.has(String(reproStatus || "").trim())) return "الحالة يجب أن تكون «ملقح/ملقّحة» أو «مفتوحة».";

    const th = MIN_DAYS_POST_CALVING_FOR_AI[species];
    if (!th) return "نوع القطيع غير معروف لحساب الحد الأدنى للأيام.";
    if (!isDate(lastCalvingDate)) return "تاريخ آخر ولادة غير متاح.";
    const d = daysBetween(lastCalvingDate, eventDate);
    if (Number.isNaN(d)) return "تعذّر حساب المدة منذ آخر ولادة.";
    if (d < th) return `التلقيح مبكّر: يلزم ≥ ${th} يوم بعد الولادة (الحالي ${d}).`;

    if (hasInseminationSameDay === true) return "يوجد تلقيح مُسجَّل لنفس الحيوان اليوم.";
    return null;
  },

  // — تشخيص الحمل — (الحالة ملقّح/ملقّحة + حد أدنى أيام حسب الوسيلة من آخر تلقيح)
  pregnancyDiagnosisDecision(fd) {
    const { reproStatus, lastInseminationDate, eventDate, method } = fd;

    const okPregStatus = new Set(["ملقح","ملقّح","ملقحة","ملقّحة"]);
    if (!okPregStatus.has(String(reproStatus || "").trim())) return "تشخيص الحمل يتطلّب الحالة «ملقّح/ملقّحة».";

    if (!isDate(lastInseminationDate)) return "لا يوجد تلقيح سابق مسجَّل.";
    const need = MIN_PD_BY_METHOD[method]; if (!need) return "طريقة التشخيص غير معروفة.";

    const d = daysBetween(lastInseminationDate, eventDate);
    if (Number.isNaN(d)) return "تعذّر حساب الأيام منذ آخر تلقيح.";
    if (d < need) return `${method} يتطلّب ≥ ${need} يوم من آخر تلقيح (الحالي ${d}).`;

    return null;
  },

  // — الإجهاض —
  abortionDecision(fd) {
    const { reproStatus, lastFertileInseminationDate, eventDate } = fd;
    if (reproStatus !== "عشار") return "الإجهاض يتطلّب أن تكون الحالة «عِشار».";
    if (!isDate(lastFertileInseminationDate)) return "لا يوجد تلقيح مُخصِّب مُسجَّل.";
    const d = daysBetween(lastFertileInseminationDate, eventDate);
    if (Number.isNaN(d)) return "تعذّر حساب عمر الحمل عند الإجهاض.";
    return null;
  },
};

// ===================== الدالة المركزية =====================
export function validateEvent(eventType, payload = {}) {
  const schema = eventSchemas[eventType];
  if (!schema) return { ok: false, errors: ["نوع حدث غير معروف."] };

  const errors = [];

  // تحقق الحقول أولًا
  for (const [key, rule] of Object.entries(schema.fields || {})) {
    const err = validateField(key, rule, payload[key]);
    if (err) errors.push(err);
  }
  if (errors.length) return { ok: false, errors };

  // ثم الحُرّاس بالتتابع
  for (const gName of (schema.guards || [])) {
    const guardFn = guards[gName];
    if (typeof guardFn === "function") {
      const gErr = guardFn(payload);
      if (gErr) errors.push(gErr);
    }
  }

  return { ok: errors.length === 0, errors };
}

// (انتهى الملف)
