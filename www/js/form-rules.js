// /js/form-rules.js  — ESM (بدون أي UI)
// قواعد مركزية + حُرّاس (guards) للأحداث

// ============ ثوابت عامة ============
export const thresholds = {
  "أبقار": { minGestationDays: 255 },
  "جاموس": { minGestationDays: 285 },
};

// حدّ أدنى لتشخيص الحمل حسب الوسيلة
const MIN_PD_BY_METHOD = { "سونار": 26, "جس يدوي": 40 };

// ============ أدوات مساعدة ============
const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));
const daysBetween = (d1, d2) => {
  const a = toDate(d1), b = toDate(d2);
  if (!a || !b) return NaN;
  const ms = b.setHours(0,0,0,0) - a.setHours(0,0,0,0);
  return Math.round(ms / 86400000);
};

const req    = (val) => !(val === undefined || val === null || String(val).trim() === "");
const isDate = (val) => !Number.isNaN(toDate(val)?.getTime());
const isNum  = (val) => (val === "" ? true : !Number.isNaN(Number(val)));

// ============ الحقول المشتركة ============
const commonFields = {
  animalId:  { required: true,  msg: "رقم/معرّف الحيوان مفقود." },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
};

// ============ تعريف سكيمات الأحداث ============
export const eventSchemas = {
  "ولادة": {
    fields: {
      ...commonFields,
      species: { required: true, enum: ["أبقار","جاموس"], msg: "نوع القطيع (أبقار/جاموس) مطلوب." },
      reproStatus: { required: true, enum: ["عشار"], msg: "الولادة لا تُسجَّل إلا إذا كانت الحالة «عِشار»." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
      gestationOverrideDays: { type: "number" }, // اختياري
    },
    guards: ["calvingDecision"],
  },

  "تشخيص حمل": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["ملقح"], msg: "تشخيص الحمل مسموح فقط عندما تكون الحالة «ملقح»." },
      method: { required: true, enum: ["سونار","جس يدوي"], msg: "اختَر وسيلة التشخيص (سونار/جس يدوي)." },
      lastInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مطلوب." },
      // النتيجة اختيارية الآن حسب أسلوب مُرَبِّك
      result: { required: false, enum: ["عشار","فارغة"] },
    },
    guards: ["pregnancyDiagnosisDecision"],
  },

  "إجهاض": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار"], msg: "الإجهاض لا يُسجَّل إلا إذا كانت الحالة «عِشار»." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
    },
    guards: ["abortionDecision"],
  },

  "تجفيف": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار","غير عشار"], msg: "حدّث الحالة التناسلية قبل التجفيف." },
      reason: { required: true, msg: "سبب التجفيف مطلوب." },
    },
    guards: [],
  },
};

// ============ تحقق الحقول ============
function validateField(key, rule, value) {
  if (rule.required && !req(value))
    return rule.msg || `الحقل «${key}» مطلوب.`;

  if (rule.type === "date" && value && !isDate(value))
    return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;

  if (rule.type === "number" && !isNum(value))
    return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;

  if (rule.enum && value && !rule.enum.includes(value))
    return rule.msg || `قيمة «${key}» غير ضمن القيم المسموح بها.`;

  if (rule.min !== undefined && Number(value) < rule.min)
    return rule.msg || `قيمة «${key}» أقل من الحد الأدنى.`;

  if (rule.max !== u
