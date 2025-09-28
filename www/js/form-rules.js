// /js/form-rules.js  — ESM
// القاعدة: لا أي UI هنا. مجرد قواعد + حراس (guards) مركزية.
// species: "أبقار" | "جاموس"

export const thresholds = {
  أبقار: { minGestationDays: 255 },
  جاموس: { minGestationDays: 285 },
};

// حدّ أدنى لتشخيص الحمل حسب الطريقة
const MIN_PD_BY_METHOD = { "سونار": 26, "جس يدوي": 40 };

const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));
const daysBetween = (d1, d2) => {
  const a = toDate(d1), b = toDate(d2);
  if (!a || !b) return NaN;
  const ms = b.setHours(0,0,0,0) - a.setHours(0,0,0,0);
  return Math.round(ms / 86400000);
};

const req   = (val) => !(val === undefined || val === null || String(val).trim() === "");
const isDate= (val) => !Number.isNaN(toDate(val)?.getTime());
const isNum = (val) => val === "" ? true : !Number.isNaN(Number(val));

/** الحقول المشتركة */
const commonFields = {
  animalId:  { required: true, msg: "رقم/معرّف الحيوان مفقود." },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
};

/** تعريف قواعد كل حدث */
export const eventSchemas = {
  "ولادة": {
    fields: {
      ...commonFields,
      species: { required: true, enum: ["أبقار", "جاموس"], msg: "نوع القطيع (أبقار/جاموس) مطلوب." },
      reproStatus: { required: true, enum: ["عشار"], msg: "الولادة لا تُسجَّل إلا إذا كانت الحالة التناسلية عِشار." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
      // اختياري: إدخال يدوي لعمر الحمل (يتجاوز الحساب الآلي)
      gestationOverrideDays: { type: "number" },
    },
    guards: ["calvingDecision"],
  },

  // ✅ مضافة: سكيمة تشخيص الحمل حسب شروطك
  "تشخيص حمل": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["ملقح"], msg: "تشخيص الحمل مسموح فقط عندما تكون الحالة «ملقح»." },
      method: { required: true, enum: ["سونار", "جس يدوي"], msg: "اختَر وسيلة التشخيص (سونار/جس يدوي)." },
      // نعتمد على "آخر تلقيح" أيًّا كان (غير مشروط بكونه مُخصّب)
      lastInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مطلوب." },
      // النتيجة اختيارية هنا التزامًا بـ «فقط لا غير». يمكن جعلها مطلوبة عند الحاجة.
      result: { required: false, enum: ["حامل", "غير حامل", "مُلتبس"] },
    },
    guards: ["pregnancyDiagnosisDecision"],
  },

  "إجهاض": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار"], msg: "الإجهاض لا يُسجَّل إلا إذا كانت الحالة عِشار." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
    },
    guards: ["abortionDecision"],
  },

  "تجفيف": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار", "غير عشار"], msg: "حدّث الحالة التناسلية قبل التجفيف." },
      reason: { required: true, msg: "سبب التجفيف مطلوب." },
    },
    guards: [],
  },
};

/** محرّك التحقق للحقل */
function validateField(key, rule, value) {
  if (rule.required && !req(value)) {
    return rule.msg || `الحقل «${key}» مطلوب.`;
  }
  if (rule.type === "date" && value && !isDate(value)) {
    return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;
  }
  if (rule.type === "number" && !isNum(value)) {
    return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;
  }
  if (rule.enum && value && !rule.enum.includes(value)) {
    return rule.msg || `قيمة «${key}» غير ضمن القيم المسموح بها.`;
  }
  if (rule.min !== undefined && Number(value) < rule.min) {
    return rule.msg || `قيمة «${key}» أقل من الحد الأدنى.`;
  }
  if (rule.max !== undefined && Number(value) > rule.max) {
    return rule.msg || `قيمة «${key}» أكبر من الحد الأقصى.`;
  }
  return null;
}

/** الحُرّاس (Guards) الخاصة بقرارات الحدث */
const guards = {
  calvingDecision(formData) {
    // شرط مركزي: الحالة "عِشار" + عمر حمل ≥ العتبة حسب النوع
    const species = formData.species;
    const th = thresholds[species]?.minGestationDays;
    if (!th) return `نوع القطي
