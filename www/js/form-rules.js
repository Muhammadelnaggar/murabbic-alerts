// ===================================================================
//   /js/form-rules.js — Murabbik Final Validation (Document-Based)
// ===================================================================

// ===================== Imports لـ Firestore (للـ uniqueAnimalNumber) =====================
import { db } from "./firebase-config.js";
import { collection, query, where, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ===================== ثوابت عامة =====================
export const thresholds = {
  "أبقار": { minGestationDays: 255 },
  "جاموس": { minGestationDays: 285 },
};

// حد أدنى لأيام ما بعد الولادة قبل التلقيح
const MIN_DAYS_POST_CALVING_FOR_AI = { "أبقار": 56, "جاموس": 45 };

// ===================== أدوات مساعدة =====================
const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));

const daysBetween = (a, b) => {
  const d1 = toDate(a), d2 = toDate(b);
  if (!d1 || !d2) return NaN;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d2 - d1) / 86400000);
};

const req = (v) => !(v === undefined || v === null || String(v).trim() === "");
const isDate = (v) => !Number.isNaN(toDate(v)?.getTime());
const isNum = (v) => (v === "" ? true : !Number.isNaN(Number(v)));

// ===================== الحقول المشتركة =====================
const commonFields = {
  animalId: { required: true, msg: "رقم الحيوان مطلوب." },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
  documentData: { required: true, msg: "بيانات الحيوان غير متاحة." },
};

// ===================================================================
//                         سكيمات الأحداث
// ===================================================================
export const eventSchemas = {
 "ولادة": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ الولادة غير صالح." },
    species: { required: true, msg: "نوع الحيوان مطلوب." },
    lastFertileInseminationDate: { required: true, type: "date", msg: "تاريخ آخر تلقيح مُخصِّب مطلوب." },
    documentData: { required: true, msg: "بيانات الحيوان غير متاحة." },
  },
  guards: ["calvingDecision"],
},


  "تلقيح": {
    fields: { ...commonFields, species: { required: true, msg: "نوع الحيوان مطلوب." } },
    guards: ["inseminationDecision"],
  },

  "تشخيص حمل": {
    fields: {
      ...commonFields,
      method: { required: true, msg: "طريقة التشخيص مطلوبة." },
      result: { required: true, msg: "نتيجة التشخيص مطلوبة." },
    },
    guards: ["pregnancyDiagnosisDecision"],
  },

  "إجهاض": {
    fields: { ...commonFields },
    guards: ["abortionDecision"],
  },

  // ✅ إضافة لبن يومي
  "لبن يومي": {
    fields: { ...commonFields },
    guards: [],
  },

  "تجفيف": {
    fields: { ...commonFields, reason: { required: true, msg: "سبب التجفيف مطلوب." } },
    guards: ["dryOffDecision"],
  },
};

// ===================================================================
//                          الحُرّاس (GUARDS للأحداث)
// ===================================================================
export const guards = {
calvingDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // 1) منع غير Active
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل ولادة — هذا الحيوان خارج القطيع.";

  // 2) لازم تكون عشار (من الوثيقة أو من نتيجة حساب مركزي لو هتضيفها)
  const rs = String(doc.reproductiveStatus || "").trim();
  if (rs !== "عشار") return "لا يمكن تسجيل ولادة — الحالة التناسلية ليست «عشار».";

  // 3) حد أدنى عمر حمل حسب النوع
  const sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  const th = thresholds[sp]?.minGestationDays;
  if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

  // 4) حساب عمر الحمل من آخر تلقيح مخصب
  const lf = fd.lastFertileInseminationDate || doc.lastFertileInseminationDate || "";
  const gDays = daysBetween(lf, fd.eventDate);
  if (Number.isNaN(gDays)) return "لا يوجد تلقيح مُخصِّب سابق.";
  if (gDays < th) return `عمر الحمل ${gDays} أقل من الحد الأدنى ${th}.`;

  return null;
},


  inseminationDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    const status = String(doc.reproductiveStatus || "").trim();
    const okStatus = new Set(["مفتوحة", "ملقح", "ملقّح", "ملقحة", "ملقّحة"]);
    if (!okStatus.has(status)) return "الحالة الحالية لا تسمح بالتلقيح.";

    if (!isDate(doc.lastCalvingDate)) return "تاريخ الولادة غير مسجل.";

    const th = MIN_DAYS_POST_CALVING_FOR_AI[doc.species];
    const d = daysBetween(doc.lastCalvingDate, fd.eventDate);
    if (d < th) return `التلقيح مبكر: ${d} يوم فقط (الحد الأدنى ${th}).`;

    return null;
  },

  pregnancyDiagnosisDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    const status = String(doc.reproductiveStatus || "").trim();
    if (status !== "ملقحة" && status !== "ملقّحة") {
      return "❌ لا يمكن تشخيص الحمل — الحالة التناسلية يجب أن تكون «ملقحة» فقط.";
    }
    return null;
  },

  abortionDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    if (doc.reproductiveStatus !== "عشار")
      return "❌ الحيوان ليس عِشار — لا يمكن تسجيل إجهاض.";

    return null;
  },

  dryOffDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    if (!["عشار", "غير عشار"].includes(doc.reproductiveStatus))
      return "الحالة التناسلية غير مناسبة للتجفيف.";

    return null;
  },
};

// ===================================================================
//      قاعدة منفصلة: منع تكرار رقم الحيوان لنفس المستخدم فقط
// ===================================================================
export async function uniqueAnimalNumber(ctx) {
  const userId = ctx.userId;
  const number = String(ctx.number || "").trim();

  if (!userId || !number) return { ok: false, msg: "البيانات غير مكتملة." };

  const key = `${userId}#${number}`;
  const q = query(collection(db, "animals"), where("userId_number", "==", key), limit(1));
  const snap = await getDocs(q);

  if (!snap.empty) {
    return { ok: false, msg: `⚠️ يوجد حيوان مسجَّل بالفعل برقم ${number} في حسابك.` };
  }
  return { ok: true };
}

// ===================================================================
//                   الدالة المركزية للـ Validation
// ===================================================================
export function validateEvent(eventType, payload = {}) {
  const schema = eventSchemas[eventType];
  if (!schema) return { ok: false, errors: ["نوع حدث غير معروف."] };

  // ✅ قفل مركزي واحد: يمنع أي حدث لحيوان خارج القطيع (بيع/نفوق/استبعاد)
  const doc = payload.documentData;
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return { ok: false, errors: ["❌ لا يمكن تسجيل أحداث لحيوان تم بيعه/نفوقه/استبعاده من القطيع."] };
  }

  const errors = [];

  for (const [key, rule] of Object.entries(schema.fields || {})) {
    const err = validateField(key, rule, payload[key]);
    if (err) errors.push(err);
  }
  if (errors.length) return { ok: false, errors };

  for (const gName of (schema.guards || [])) {
    const guardFn = guards[gName];
    if (typeof guardFn !== "function") continue;
    const gErr = guardFn(payload);
    if (gErr) errors.push(gErr);
  }

  return { ok: errors.length === 0, errors };
}

function validateField(key, rule, value) {
  if (rule.required && !req(value)) return rule.msg || `الحقل «${key}» مطلوب.`;
  if (rule.type === "date" && value && !isDate(value)) return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;
  if (rule.type === "number" && !isNum(value)) return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;
  if (rule.enum && value && !rule.enum.includes(value)) return rule.msg || `«${key}» خارج القيم المسموحة.`;
  return null;
}
