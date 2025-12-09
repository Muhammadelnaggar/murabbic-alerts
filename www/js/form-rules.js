// ===================================================================
//   /js/form-rules.js — Murabbik Final Validation (Document-Based)
// ===================================================================

// ===================== Imports لـ Firestore (للـ uniqueAnimalNumber) =====================
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ===================== ثوابت عامة =====================
export const thresholds = {
  "أبقار": { minGestationDays: 255 },
  "جاموس": { minGestationDays: 285 },
};

// حد أدنى لتشخيص الحمل حسب وسيلة التشخيص
const MIN_PD_BY_METHOD = { "سونار": 26, "جس يدوي": 40 };

// حد أدنى لأيام ما بعد الولادة قبل التلقيح
const MIN_DAYS_POST_CALVING_FOR_AI = { "أبقار": 56, "جاموس": 45 };

// ===================== أدوات مساعدة =====================
const toDate = (v) =>
  v instanceof Date ? v : (v ? new Date(v) : null);

const daysBetween = (a, b) => {
  const d1 = toDate(a), d2 = toDate(b);
  if (!d1 || !d2) return NaN;
  d1.setHours(0,0,0,0);
  d2.setHours(0,0,0,0);
  return Math.round((d2 - d1) / 86400000);
};

const req    = (v) => !(v === undefined || v === null || String(v).trim() === "");
const isDate = (v) => !Number.isNaN(toDate(v)?.getTime());
const isNum  = (v) => (v === "" ? true : !Number.isNaN(Number(v)));


// ===================== الحقول المشتركة =====================
const commonFields = {
  animalId:  { required: true,  msg: "رقم الحيوان مطلوب." },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
  // ⚠️ مبدأ جديد:
  //     documentData = وثيقة الحيوان كاملة
  // ملاحظة: بعض الأحداث (زي تشخيص الحمل) مش بتستخدمه.
  documentData: { required: true, msg: "بيانات الحيوان غير متاحة." },
};


// ===================================================================
//                         سكيمات الأحداث
// ===================================================================
export const eventSchemas = {

  // ------------------- الولادة -------------------
  "ولادة": {
    fields: {
      ...commonFields,
      species: { required: true },
      documentData: { required: true },
    },
    guards: ["calvingDecision"],
  },

  // ------------------- التلقيح -------------------
  "تلقيح": {
    fields: {
      ...commonFields,
      species: { required: true },
      documentData: { required: true },
    },
    guards: ["inseminationDecision"],
  },

  // ================= تشخيص الحمل =================
  // 💡 هنا لا نستخدم commonFields عمداً حتى لا يكون documentData مطلوباً
  "تشخيص حمل": {
    fields: {
      animalId:  { required: true,  msg: "رقم الحيوان مطلوب." },
      eventDate: { required: true, type: "date", msg: "تاريخ التشخيص غير صالح." },
      method:    { required: true,  msg: "طريقة التشخيص مطلوبة." },           // "سونار" | "جس يدوي"
      result:    { required: true,  msg: "نتيجة التشخيص مطلوبة." },           // "عشار" | "فارغة"
      reproStatus: {
        required: true,
        msg: "الحالة التناسلية مطلوبة لتشخيص الحمل.",
      },
      lastInseminationDate: {
        required: true,
        type: "date",
        msg: "تاريخ آخر تلقيح غير صالح.",
      },
    },
    guards: ["pregnancyDiagnosisDecision"],
  },

  // ------------------- الإجهاض -------------------
  "إجهاض": {
    fields: {
      ...commonFields,
      documentData: { required: true },
    },
    guards: ["abortionDecision"],
  },

  // ------------------- التجفيف -------------------
  "تجفيف": {
    fields: {
      ...commonFields,
      reason: { required: true, msg: "سبب التجفيف مطلوب." },
      documentData: { required: true },
    },
    guards: ["dryOffDecision"],
  },
};



// ===================================================================
//                          الحُرّاس (GUARDS للأحداث)
// ===================================================================
export const guards = {

  // ------------------- الولادة -------------------
  calvingDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    if (doc.reproductiveStatus !== "عشار")
      return "لا يمكن تسجيل ولادة — الحيوان ليس عِشار.";

    const th = thresholds[doc.species]?.minGestationDays;
    if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

    const gDays = daysBetween(doc.lastFertileInseminationDate, fd.eventDate);
    if (Number.isNaN(gDays)) return "لا يوجد تلقيح مُخصِّب سابق.";
    if (gDays < th) return `عمر الحمل ${gDays} أقل من الحد الأدنى ${th}.`;

    return null;
  },

  // ------------------- التلقيح -------------------
  inseminationDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    const status = String(doc.reproductiveStatus || "").trim();

    const okStatus = new Set(["مفتوحة", "ملقح", "ملقّح", "ملقحة", "ملقّحة"]);
    if (!okStatus.has(status))
      return "الحالة الحالية لا تسمح بالتلقيح.";

    if (!isDate(doc.lastCalvingDate))
      return "تاريخ الولادة غير مسجل.";

    const th = MIN_DAYS_POST_CALVING_FOR_AI[doc.species];
    const d  = daysBetween(doc.lastCalvingDate, fd.eventDate);
    if (d < th) return `التلقيح مبكر: ${d} يوم فقط (الحد الأدنى ${th}).`;

    return null;
  },

  // -------------- تشخيص الحمل ---------------------
  pregnancyDiagnosisDecision(fd) {
    // هنا نعتمد على payload القادم من صفحة تشخيص الحمل
    const status = String(fd.reproStatus || "").trim();
    const okStatus = new Set(["ملقح", "ملقّح", "ملقحة", "ملقّحة"]);

    if (!okStatus.has(status))
      return "لا يُسمح بتشخيص الحمل إلا للحيوانات الملقّحة.";

    if (!isDate(fd.lastInseminationDate))
      return "لا يوجد تاريخ تلقيح سابق قبل هذا التاريخ؛ لا يمكن تشخيص الحمل.";

    const need = MIN_PD_BY_METHOD[fd.method];
    if (!need) return null; // طريقة غير معروفة، نتجاهل الحارس بهدوء

    const d = daysBetween(fd.lastInseminationDate, fd.eventDate);

    if (Number.isNaN(d) || d < need)
      return `لا يمكن تشخيص الحمل الآن: طريقة ${fd.method} تتطلّب مرور ${need} يومًا على الأقل من آخر تلقيح (الفارق الحالي ${d} يوم).`;

    return null;
  },

  // ------------------- الإجهاض --------------------
  abortionDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    if (doc.reproductiveStatus !== "عشار")
      return "❌ الحيوان ليس عِشار — لا يمكن تسجيل إجهاض.";

    return null;
  },

  // ------------------- التجفيف --------------------
  dryOffDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    // هنا الفاليديشن بسيط، التفاصيل الطبية في المنطق التشغيلي
    if (!["عشار", "غير عشار"].includes(doc.reproductiveStatus))
      return "الحالة التناسلية غير مناسبة للتجفيف.";

    return null;
  },
};



// ===================================================================
//      قاعدة منفصلة: منع تكرار رقم الحيوان لنفس المستخدم فقط
// ===================================================================
export async function uniqueAnimalNumber(ctx) {
  // ctx.userId  = معرف المستخدم الحالي
  // ctx.number  = رقم الحيوان الذي أدخله المستخدم

  const userId = ctx.userId;
  const number = String(ctx.number || "").trim();

  if (!userId || !number) {
    return { ok: false, msg: "البيانات غير مكتملة." };
  }

  const key = `${userId}#${number}`;

  const q = query(
    collection(db, "animals"),
    where("userId_number", "==", key),
    limit(1)
  );

  const snap = await getDocs(q);

  if (!snap.empty) {
    return {
      ok: false,
      msg: `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${number} في حسابك.`,
    };
  }

  return { ok: true };
}



// ===================================================================
//                   الدالة المركزية للـ Validation
// ===================================================================
export function validateEvent(eventType, payload = {}) {
  const schema = eventSchemas[eventType];
  if (!schema) return { ok: false, errors: ["نوع حدث غير معروف."] };

  const errors = [];

  // فحص الحقول
  for (const [key, rule] of Object.entries(schema.fields || {})) {
    const err = validateField(key, rule, payload[key]);
    if (err) errors.push(err);
  }
  if (errors.length) return { ok: false, errors };

  // فحص الحراس (كلهم متزامنين sync)
  for (const gName of (schema.guards || [])) {
    const guardFn = guards[gName];
    if (typeof guardFn !== "function") continue;
    const gErr = guardFn(payload);
    if (gErr) errors.push(gErr);
  }

  return { ok: errors.length === 0, errors };
}

function validateField(key, rule, value) {
  if (rule.required && !req(value))
    return rule.msg || `الحقل «${key}» مطلوب.`;

  if (rule.type === "date" && value && !isDate(value))
    return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;

  if (rule.type === "number" && !isNum(value))
    return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;

  if (rule.enum && value && !rule.enum.includes(value))
    return rule.msg || `«${key}» خارج القيم المسموحة.`;

  return null;
}

// (انتهى الملف)
