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
    // أساسيات
    eventDate: { required: true, type: "date", msg: "تاريخ الولادة غير صالح." },
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    documentData: { required: true, msg: "تعذّر العثور على الحيوان — تحقق من الرقم." },

    // إجباري (حسب طلبك)
    calvingKind: { required: true, msg: "نوع الولادة مطلوب." },
    lastFertileInseminationDate: { required: true, type: "date", msg: "آخر تلقيح مُخصِّب مطلوب." },

    // ملحوظة: notes مش إجباري
    notes: { required: false },

    // تُملأ لاحقًا من البوابة/الكونتكست (مش شرط هنا)
    animalId: { required: false },
    species: { required: false },
    reproStatus: { required: false },

    // حقول العجول (هتتأكد مركزيًا في Guard)
    calfCount: { required: false },
    calf1Sex:  { required: false },
    calfId:    { required: false },
    calf2Sex:  { required: false },
    calf2Id:   { required: false },
    calf3Sex:  { required: false },
    calf3Id:   { required: false },
    calfFate:  { required: false },
  },
  guards: ["calvingDecision", "calvingRequiredFields"],
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
  if (!doc) return "تعذّر العثور على الحيوان — تحقق من الرقم.";

  // ✅ خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل ولادة — الحيوان خارج القطيع.";

  // ✅ تحديد النوع (Normalize)
  let sp = String(fd.species || doc.species || doc.animalTypeAr || doc.animalType || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const th = thresholds[sp]?.minGestationDays;
  if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

  // ✅ الحالة التناسلية: events أولًا ثم الوثيقة
  const rsRaw = String(
    fd.reproStatusFromEvents ||
    doc.reproductiveStatus ||
    doc.reproStatus ||
    ""
  ).trim();

  const rsNorm = rsRaw.replace(/\s+/g, "").replace(/[ًٌٍَُِّْ]/g, "");
  if (!rsNorm.includes("عشار")) {
    return "❌ لا يمكن تسجيل ولادة — الحالة التناسلية ليست «عِشار».";
  }

  // ✅ آخر تلقيح مُخصِّب: events أولًا ثم الوثيقة
  const lf =
    fd.lastFertileInseminationDate ||
    doc.lastFertileInseminationDate ||
    doc.lastFertileInsemination ||
    doc.lastInseminationDate ||
    "";

  if (!isDate(lf)) return '❌ لا يمكن تسجيل ولادة — لا يوجد "آخر تلقيح مُخصِّب".';
  if (!isDate(fd.eventDate)) return "❌ تاريخ الولادة غير صالح.";

  // ✅ Boundary: لو في (ولادة/إجهاض) أحدث من التلقيح → يلغي الحمل
  const boundary = String(fd.lastBoundary || "").trim();
  if (boundary && isDate(boundary)) {
    const b = new Date(boundary); b.setHours(0,0,0,0);
    const l = new Date(lf);       l.setHours(0,0,0,0);
    if (b.getTime() >= l.getTime()) {
      return `❌ لا يُسمح بتسجيل الولادة: آخر حدث (${boundary}) يلغي أي حمل حالي.`;
    }
  }

  const gDays = daysBetween(lf, fd.eventDate);
  if (Number.isNaN(gDays)) return "تعذّر حساب عمر الحمل.";

  if (gDays < th) {
    // ✅ Prefix خاص عشان forms-init يعرف يعرض زر “تسجيل إجهاض”
    return `OFFER_ABORT|لا يُسمح بتسجيل الولادة: عمر الحمل ${gDays} يوم أقل من الحد الأدنى ${th} يوم للـ${sp}.`;
  }

  return null;
},
calvingRequiredFields(fd) {
  // 1) نوع الولادة لازم موجود
  const kind = String(fd.calvingKind || "").trim();
  if (!kind) return "❌ نوع الولادة مطلوب.";

  // 2) آخر تلقيح مُخصِّب لازم موجود وصالح
  const lf = String(fd.lastFertileInseminationDate || "").trim();
  if (!isDate(lf)) return '❌ "آخر تلقيح مُخصِّب" مطلوب (تاريخ صحيح).';

  // 3) لو الولادة "نافقة" → لا نطلب أي بيانات عجول
  if (kind === "نافقة") return null;

  // 4) غير نافقة → بيانات العجول إجبارية
  const count = Number(String(fd.calfCount || "").trim());
  if (!(count === 1 || count === 2 || count === 3)) return "❌ عدد المواليد مطلوب (1 أو 2 أو 3).";

  // المولود 1
  if (!String(fd.calf1Sex || "").trim()) return "❌ جنس المولود (1) مطلوب.";
  if (!String(fd.calfId || "").trim())   return "❌ رقم العجل (1) مطلوب.";

  // مصير العجل
  if (!String(fd.calfFate || "").trim()) return "❌ مصير العجل مطلوب.";

  // المولود 2
  if (count >= 2) {
    if (!String(fd.calf2Sex || "").trim()) return "❌ جنس المولود (2) مطلوب.";
    if (!String(fd.calf2Id || "").trim())  return "❌ رقم العجل (2) مطلوب.";
  }

  // المولود 3
  if (count >= 3) {
    if (!String(fd.calf3Sex || "").trim()) return "❌ جنس المولود (3) مطلوب.";
    if (!String(fd.calf3Id || "").trim())  return "❌ رقم العجل (3) مطلوب.";
  }

  return null;
},

  inseminationDecision(fd) {
    const doc = fd.documentData;
    if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

    const status = String(doc.reproductiveStatus || "").trim();
    const okStatus = new Set(["مفتوحة", "ملقح", "ملقّح", "ملقحة", "ملقّحة"]);
    if (!okStatus.has(status)) return "الحالة الحالية لا تسمح بالتلقيح.";

    if (!isDate(doc.lastCalvingDate)) return "تاريخ الولادة غير مسجل.";

   const th = MIN_DAYS_POST_CALVING_FOR_AI[String(doc.species || "").trim()];

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
