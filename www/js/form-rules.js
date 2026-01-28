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
// ===================== Calves helpers =====================
function normDigitsOnly(s){
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
               '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||'')
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g,'')
    .replace(/[٠-٩۰-۹]/g, d=>map[d]);
}
function isOdd(n){ return Number(n) % 2 === 1; }
function isEven(n){ return Number(n) % 2 === 0; }

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
    lastInseminationDate: { required: true, type: "date", msg: "آخر تلقيح مُخصِّب مطلوب." },

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
  fd.lastInseminationDate ||
  doc.lastInseminationDate ||
  doc.lastAI ||
  doc.lastInsemination ||
  doc.lastServiceDate ||
  "";

  if (!isDate(lf)) return '❌ لا يمكن تسجيل ولادة — لا يوجد "آخر تلقيح".';

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
  const lf = String(fd.lastInseminationDate || "").trim();
  if (!isDate(lf)) return '❌ "آخر تلقيح مُخصِّب" مطلوب (تاريخ صحيح).';

  // 3) لو الولادة "نافقة" → لا نطلب أي بيانات عجول
  if (kind === "نافقة") return null;

  // 4) غير نافقة → بيانات العجول إجبارية
  // 4) غير نافقة → بيانات العجول إجبارية
  const count = Number(String(fd.calfCount || "").trim());
  if (!(count === 1 || count === 2 || count === 3)) {
    return { field: "calfCount", msg: "❌ عدد المواليد مطلوب (1 أو 2 أو 3)." };
  }

  // المولود 1
  if (!String(fd.calf1Sex || "").trim()) {
    return { field: "calf1Sex", msg: "❌ جنس المولود (1) مطلوب." };
  }
  if (!String(fd.calfId || "").trim()) {
    return { field: "calfId", msg: "❌ رقم العجل (1) مطلوب." };
  }

  // مصير العجل
  if (!String(fd.calfFate || "").trim()) {
    return { field: "calfFate", msg: "❌ مصير العجل مطلوب." };
  }

  // المولود 2
  if (count >= 2) {
    if (!String(fd.calf2Sex || "").trim()) {
      return { field: "calf2Sex", msg: "❌ جنس المولود (2) مطلوب." };
    }
    if (!String(fd.calf2Id || "").trim()) {
      return { field: "calf2Id", msg: "❌ رقم العجل (2) مطلوب." };
    }
  }

  // المولود 3
  if (count >= 3) {
    if (!String(fd.calf3Sex || "").trim()) {
      return { field: "calf3Sex", msg: "❌ جنس المولود (3) مطلوب." };
    }
    if (!String(fd.calf3Id || "").trim()) {
      return { field: "calf3Id", msg: "❌ رقم العجل (3) مطلوب." };
    }
  }
  // 5) قواعد أرقام العجول: الذكر فردي، الأنثى زوجي + منع تكرار داخل الولادة
  const nums = [];
  const checkOne = (sexKey, idKey, label) => {
    const sex = String(fd[sexKey] || "").trim();
    const id  = normDigitsOnly(fd[idKey]);
    if (!sex || !id) return null;

    nums.push(id);

    const n = Number(id);
    if (!Number.isFinite(n)) return { field: idKey, msg: `❌ رقم العجل (${label}) غير صالح.` };

    if (sex === "ذكر" && !isOdd(n)) {
      return { field: idKey, msg: `❌ رقم العجل الذكر يجب أن يكون فردي. (${id})` };
    }
    if (sex === "أنثى" && !isEven(n)) {
      return { field: idKey, msg: `❌ رقم العجل الأنثى يجب أن يكون زوجي. (${id})` };
    }
    return null;
  };

  let e;
  e = checkOne("calf1Sex", "calfId", "1");   if (e) return e;
  if (count >= 2) { e = checkOne("calf2Sex", "calf2Id", "2"); if (e) return e; }
  if (count >= 3) { e = checkOne("calf3Sex", "calf3Id", "3"); if (e) return e; }

  const s2 = new Set(nums);
  if (s2.size !== nums.length) {
    return { field: "calfId", msg: "❌ لا يجوز تكرار رقم العجل داخل نفس الولادة." };
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
//      قاعدة منفصلة: منع تكرار رقم العجل لنفس المستخدم فقط (DB-level)
// ===================================================================
export async function uniqueCalfNumbers(ctx) {
  const userId = String(ctx.userId || "").trim();
  const nums = Array.isArray(ctx.calfNumbers) ? ctx.calfNumbers : [];

  const cleaned = nums
    .map(normDigitsOnly)
    .filter(Boolean);

  if (!userId || cleaned.length === 0) return { ok: true };

  // منع تكرار داخل نفس الطلب
  const s = new Set();
  for (const n of cleaned){
    if (s.has(n)) return { ok:false, msg:`⚠️ رقم العجل "${n}" مكرر داخل نفس الولادة.` };
    s.add(n);
  }

  // شيك قاعدة البيانات
  for (const n of cleaned){
    const q1 = query(
      collection(db, "calves"),
      where("userId", "==", userId),
      where("calfNumber", "==", n),
      limit(1)
    );
    const snap = await getDocs(q1);
    if (!snap.empty){
      return { ok:false, msg:`⚠️ رقم العجل "${n}" موجود بالفعل في حسابك — اختر رقمًا آخر.` };
    }
  }

  return { ok:true };
}

// ===================================================================
//                   الدالة المركزية للـ Validation
// ===================================================================
export function validateEvent(eventType, payload = {}) {
  const schema = eventSchemas[eventType];
  if (!schema) return { ok: false, errors: ["نوع حدث غير معروف."], fieldErrors: {}, guardErrors: [] };

  // ✅ قفل مركزي واحد: يمنع أي حدث لحيوان خارج القطيع
  const doc = payload.documentData;
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return {
      ok: false,
      errors: ["❌ لا يمكن تسجيل أحداث لحيوان تم بيعه/نفوقه/استبعاده من القطيع."],
      fieldErrors: {},
      guardErrors: ["❌ لا يمكن تسجيل أحداث لحيوان تم بيعه/نفوقه/استبعاده من القطيع."]
    };
  }

  // ✅ Fallback مركزي لحدث "ولادة": آخر تلقيح من الوثيقة فقط (حسب الاتفاق)
  if (eventType === "ولادة") {
    const d = payload.documentData || {};
    if (!payload.lastInseminationDate) {
      payload.lastInseminationDate = String(d.lastInseminationDate || "").trim();
    }
  }

  const errors = [];
  const fieldErrors = {};
  const guardErrors = [];

  // 1) Field validation
  for (const [key, rule] of Object.entries(schema.fields || {})) {
    const err = validateField(key, rule, payload[key]);
    if (err) {
      fieldErrors[key] = err;
      errors.push(err);
    }
  }
  if (Object.keys(fieldErrors).length) {
    return { ok: false, errors, fieldErrors, guardErrors };
  }

  // 2) Guards
  for (const gName of (schema.guards || [])) {
    const guardFn = guards[gName];
    if (typeof guardFn !== "function") continue;

    const gErr = guardFn(payload);
    if (!gErr) continue;

    // ✅ لو Guard رجّع { field, msg }
    if (typeof gErr === "object" && gErr.field) {
      const m = gErr.msg || "خطأ في هذا الحقل.";
      fieldErrors[gErr.field] = m;
      guardErrors.push(m);
      errors.push(m);
      continue;
    }

    // ✅ لو string
    guardErrors.push(gErr);
    errors.push(gErr);
  }

  if (Object.keys(fieldErrors).length) {
    return { ok: false, errors, fieldErrors, guardErrors };
  }

  return { ok: errors.length === 0, errors, fieldErrors, guardErrors };
} // ✅ اقفال validateEvent

function validateField(key, rule, value) {
  if (rule.required && !req(value)) return rule.msg || `الحقل «${key}» مطلوب.`;
  if (rule.type === "date" && value && !isDate(value)) return rule.msg || `قيمة «${key}» يجب أن تكون تاريخًا صالحًا.`;
  if (rule.type === "number" && !isNum(value)) return rule.msg || `قيمة «${key}» يجب أن تكون رقمًا.`;
  if (rule.enum && value && !rule.enum.includes(value)) return rule.msg || `«${key}» خارج القيم المسموحة.`;
  return null;
}
