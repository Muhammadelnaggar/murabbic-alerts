// /js/form-rules.js  — ESM
// القاعدة: لا أي UI هنا. مجرد قواعد + حراس (guards) مركزية.
// species: "أبقار" | "جاموس"

export const thresholds = {
  أبقار: { minGestationDays: 255 },
  جاموس: { minGestationDays: 285 },
};

const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));
const daysBetween = (d1, d2) => {
  const a = toDate(d1), b = toDate(d2);
  if (!a || !b) return NaN;
  const ms = b.setHours(0,0,0,0) - a.setHours(0,0,0,0);
  return Math.round(ms / 86400000);
};

const req = (val) => !(val === undefined || val === null || String(val).trim() === "");
const isDate = (val) => !Number.isNaN(toDate(val)?.getTime());
const isNum  = (val) => val === "" ? true : !Number.isNaN(Number(val));

/** تعريف الحقول المشتركة */
const commonFields = {
  animalId:   { required: true, msg: "رقم/معرّف الحيوان مفقود." },
  eventDate:  { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
};

/** تعريف قواعد كل حدث */
export const eventSchemas = {
  "ولادة": {
    fields: {
      ...commonFields,
      species: { required: true, enum: ["أبقار", "جاموس"], msg: "نوع القطيع (أبقار/جاموس) مطلوب." },
      reproStatus: { required: true, enum: ["عشار"], msg: "الولادة لا تُسجَّل إلا إذا كانت الحالة التناسلية عشار." },
      lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
      // اختياري: إدخال يدوي لعمر الحمل لو حبيت تستخدمه (يتجاوز الحساب الآلي)
      gestationOverrideDays: { type: "number" },
    },
    guards: ["calvingDecision"],
  },

  "تشخيص حمل": {
    fields: {
      ...commonFields,
      method: { required: true, enum: ["سونار", "جس", "اختبار معملي", "أخرى"], msg: "اختَر وسيلة التشخيص." },
      result: { required: true, enum: ["حامل", "غير حامل", "مُلتبس"], msg: "نتيجة التشخيص مطلوبة." },
    },
    guards: [],
  },

  "إجهاض": {
    fields: {
      ...commonFields,
      reproStatus: { required: true, enum: ["عشار"], msg: "الإجهاض لا يُسجَّل إلا إذا كانت الحالة عشار." },
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
    // شرط مركزي: الحالة "عشار" + عمر حمل ≥ العتبة حسب النوع
    const species = formData.species;
    const th = thresholds[species]?.minGestationDays;
    if (!th) return `نوع القطيع غير معروف: «${species}».`;

    const eventDate = formData.eventDate;
    const lastFertile = formData.lastFertileInseminationDate;

    let g = formData.gestationOverrideDays;
    if (!g || Number.isNaN(Number(g))) {
      g = daysBetween(lastFertile, eventDate);
    } else {
      g = Number(g);
    }

    if (Number.isNaN(g) || g <= 0) {
      return "تعذّر حساب عمر الحمل. راجع تاريخ آخر تلقيح مُخصِّب وتاريخ الحدث.";
    }
    if (g < th) {
      return `لا يسمح بتسجيل الولادة قبل تمام الحمل (${th} يوم للـ${species}). العمر المحسوب = ${g} يوم.`;
    }
    return null;
  },

  abortionDecision(formData) {
    // شرط المستخدم: الإجهاض لا يحدث إلا من عِشار، ويُحسب عمر الحمل من آخر تلقيح مُخصِّب
    const eventDate = formData.eventDate;
    const lastFertile = formData.lastFertileInseminationDate;
    const g = daysBetween(lastFertile, eventDate);

    if (Number.isNaN(g) || g <= 0) {
      return "عمر الحمل للإجهاض غير منطقي. تحقّق من تاريخ آخر تلقيح مُخصِّب وتاريخ الحدث.";
    }
    // لا نضع حدًا أدنى هنا؛ يكفي منطقية التاريخين وأن الحالة عِشار (تم فحصها في الحقول)
    return null;
  },
};

/** التحقق الكامل حسب نوع الحدث */
export function validateEvent(eventName, formData) {
  const schema = eventSchemas[eventName];
  if (!schema) return { ok: false, errors: [`نوع حدث غير معرّف: «${eventName}».`] };

  const errors = [];
  // حقول
  for (const [key, rule] of Object.entries(schema.fields)) {
    const v = formData[key];
    const err = validateField(key, rule, v);
    if (err) errors.push(err);
  }

  // حُرّاس
  if (errors.length === 0 && schema.guards?.length) {
    for (const g of schema.guards) {
      const msg = guards[g]?.(formData);
      if (msg) errors.push(msg);
    }
  }

  return { ok: errors.length === 0, errors };
}
