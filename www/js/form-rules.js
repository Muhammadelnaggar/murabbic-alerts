// ===================================================================
//   /js/form-rules.js — Murabbik Final Validation (Document-Based)
// ===================================================================

// ===================== Imports لـ Firestore (للـ uniqueAnimalNumber) =====================
export const BUILD_ID = "rules-2026-02-21-A";
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
const isNum = (v) => {
  if (v === undefined || v === null) return true;   // ✅ اختياري ومش موجود
  const s = String(v).trim();
  if (s === "") return true;                        // ✅ فاضي = مسموح لو مش required
  return !Number.isNaN(Number(s));
};
// ===================== Repro helpers (Unified) =====================
function stripAr(s){
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "");
}

function reproCategory(raw){
  const n = stripAr(raw);

  // مستبعدة
  if (n.includes("لاتلقح") || n.includes("لاتلقحمرةاخرى")) return "blocked";

  // عشار
  if (n.includes("عشار")) return "pregnant";

  // ملقح/ملقحة/ملقّحة
  if (n.includes("ملقح") || n.includes("ملقحة") || n.includes("ملقّحة")) return "inseminated";

  // مفتوح/فارغ/فارغة
  if (n.includes("مفتوح") || n.includes("فارغ") || n.includes("فارغة")) return "open";

  return "unknown";
}

function normalizeSpecies(spRaw){
  let sp = String(spRaw || "").trim();
  if (/cow|بقر/i.test(sp)) return "أبقار";
  if (/buffalo|جاموس/i.test(sp)) return "جاموس";
  return sp;
}

function animalWord(sp){
  return (sp === "جاموس") ? "جاموسة" : "بقرة";
}

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
   animalId: { required: false },
  eventDate: { required: true, type: "date", msg: "تاريخ الحدث غير صالح." },
  documentData: { required: true, msg: "بيانات الحيوان غير متاحة." },
};

// ===================================================================
//                         سكيمات الأحداث
// ===================================================================
// ✅ منع تكرار "شياع" لنفس الحيوان خلال 3 أيام (بدون Index)
export async function recentHeatCheck(uid, animalNumber, eventDate, windowDays = 3){
  try{
    const num = String(animalNumber || "").trim();
    const dt  = String(eventDate || "").slice(0,10);
    if (!uid || !num || !dt) return null;

    // ✅ هات آخر (50) حدث للحيوان (بدون orderBy/inequality عشان ما نحتاج index)
    const qx = query(
      collection(db, "events"),
      where("userId", "==", uid),
      where("animalNumber", "==", num),
      limit(50)
    );

    const s = await getDocs(qx);
    if (s.empty) return null;

    const cur = new Date(dt); cur.setHours(0,0,0,0);

    let bestDate = "";       // أحدث تاريخ شياع
    let bestDiff = 999999;

    s.forEach(docSnap => {
      const ev = docSnap.data() || {};
     const t = String(ev.eventType || ev.type || "").trim();

// ✅ شياع فقط (يدعم type="heat" لو موجود)
if (t !== "شياع" && t !== "heat") return;

      const d = String(ev.eventDate || "").slice(0,10);
   if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;

      const last = new Date(d); last.setHours(0,0,0,0);
      const diff = Math.floor((cur - last) / 86400000); // أيام

      // diff>=0 يعني الشياع السابق قبل/نفس اليوم
      if (diff >= 0 && diff <= Number(windowDays)) {
        // خليك دايمًا على أحدث شياع
        if (diff < bestDiff) {
          bestDiff = diff;
          bestDate = d;
        }
      }
    });

    if (!bestDate) return null;

    if (bestDate === dt){
      return `❌ تم تسجيل شياع للحيوان رقم ${num} في نفس اليوم (${dt}).`;
    }
    return `❌ تم تسجيل شياع للحيوان رقم ${num} بتاريخ ${bestDate}. لا يمكن تكرار التسجيل خلال ${windowDays} أيام.`;

  }catch(e){
    // ✅ هنا نخليها Strict: أي خطأ = امنع الحفظ عشان ما يحصل تكرار
    return "⚠️ تعذّر التحقق من تكرار الشياع الآن (مشكلة اتصال/قراءة). أعد المحاولة بعد لحظات.";
  }
}

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
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ التلقيح غير صالح." },
    documentData: { required: true, msg: "تعذّر العثور على الحيوان." },
    species: { required: true, msg: "نوع الحيوان غير محدد." },
    inseminationMethod: { required: true, msg: "طريقة التلقيح مطلوبة." },
    semenCode: { required: true, msg: "كود السائل المنوي مطلوب." },
    inseminator: { required: true, msg: "اسم الملقّح مطلوب." },
    inseminationTime: { required: true, msg: "وقت التلقيح مطلوب." },
    heatStatus: { required: true, msg: "حالة الشياع مطلوبة." }
  },
  guards: ["inseminationDecision"]
},


 "تشخيص حمل": {
  fields: {
    ...commonFields,
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    method: { required: true, msg: "طريقة التشخيص مطلوبة." },
    result: { required: true, msg: "نتيجة التشخيص مطلوبة." },
  },
  guards: ["pregnancyDiagnosisDecision"],
},
"إجهاض": {
  fields: {
    ...commonFields,
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },

    // اختياري (للعرض فقط)
    abortionAgeMonths: { required: false, type: "number" },
    probableCause: { required: false },
    notes: { required: false },

    // هيتعمل له fallback من documentData لو مش موجود
    lastInseminationDate: { required: false, type: "date" },
    species: { required: false },
  },
  guards: ["abortionDecision"],
},


"لبن يومي": {
  fields: {
    ...commonFields,
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },

    // الحلبات (قد تكون 2 أو 3 حسب النوع)
    milkS1: { required: false, type: "number", msg: "حلبة 1 يجب أن تكون رقمًا." },
    milkS2: { required: false, type: "number", msg: "حلبة 2 يجب أن تكون رقمًا." },
    milkS3: { required: false, type: "number", msg: "حلبة 3 يجب أن تكون رقمًا." },

    // هنحسبه مركزيًا قبل الفيلد-فاليديشن
    milkKg: { required: true, type: "number", msg: "إجمالي اللبن غير صالح." },
  },
  guards: ["dailyMilkDecision"],
},

"تحضير للولادة": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate:    { required: true, type: "date", msg: "تاريخ التحضير غير صالح." },
    documentData: { required: true, msg: "تعذّر العثور على الحيوان." },

    ration: { required: true, msg: "يجب تحديد هل تم تقديم عليقة التحضير." },
    anionicSalts: { required: true, msg: "يجب تحديد هل تم استخدام الأملاح الأنيونية." },

    species: { required: false },
    reproStatus: { required: false },
    lastInseminationDate: { required: false, type: "date" },
  },
  guards: ["closeupDecision"],
},

 "تجفيف": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ التجفيف غير صالح." },
    documentData: { required: true, msg: "تعذّر العثور على الحيوان." },

    reason: { required: true, msg: "سبب التجفيف مطلوب." },
    pregnancyStatus: { required: true, msg: "تأكيد الحمل مطلوب." },
    usedDryingAntibiotics: { required: true, msg: "حدد هل تم استخدام محاقن التجفيف." },

    gestationDays: { required: true, type: "number", msg: "أيام الحمل مطلوبة (محسوبة تلقائيًا)." },

    // اختياري للتوثيق لو حبينا نسجله
    lastInseminationDate: { required: false, type: "date" },
    species: { required: false }
  },
  guards: ["dryOffDecision"],
},
"بروتوكول تزامن": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ بدء البروتوكول غير صالح." },

    program: { required: true, msg: "نوع البرنامج مطلوب." },   // ✅ أضف
    steps: { required: true, msg: "خطوات البروتوكول غير متاحة." }, // ✅ أضف

    documentData: { required: true, msg: "تعذّر العثور على الحيوان." },
    species: { required: false },

  },
  guards: ["ovsynchEligibilityDecision"]
},
 "شياع": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ الشياع غير صالح." },
    documentData: { required: true, msg: "تعذّر العثور على الحيوان — تحقق من الرقم." },

    // ✅ إجباري (حسب طلبك)
    heatTime: { required: true, msg: "وقت ملاحظة الشياع مطلوب (ص/م)." },
    reproductiveStatusSnapshot: { required: true, msg: "تعذّر قراءة الحالة التناسلية — انتظر التحقق الأخضر." },
    dimAtEvent: { required: true, msg: "تعذّر حساب أيام الحليب (DIM) — انتظر التحقق الأخضر." },

    // ✅ اختياري
    notes: { required: false }
  },
  guards: ["heatDecision"]
},
  "تحصين": {
  fields: {
    animalNumber: { required: true, msg: "رقم الحيوان مطلوب." },
    eventDate: { required: true, type: "date", msg: "تاريخ التحصين غير صالح." },

    // ✅ لا نجبر documentData هنا عشان التحصين الجماعي (هنضيف Gate جماعي لاحقًا)
    documentData: { required: false },

    vaccine: { required: true, msg: "نوع التحصين مطلوب." },
    doseType: { required: true, msg: "نوع الجرعة مطلوب." },

    notes: { required: false }
  },
  guards: ["vaccinationDecision"]
},

};
// ===================================================================
//                 Vaccination Protocols (Egypt v1) + Helpers
// ===================================================================
// ===================== (DISABLED) Old vaccination generator =====================
// NOTE: We use vaccinationTasksFromEvent() as the ONLY source of truth. Do not use buildVaccinationTasks().
const vaccinationProtocols = {
  // ✅ FMD: 4 شهور + Booster 21 يوم + كل 6 شهور
  FMD: {
    key: "FMD",
    schedule({ eventDate, doseType }) {
      const tasks = [];
       
      if (doseType === "primary") {
        tasks.push({ dueDate: addDaysISO(eventDate, 21), title: "معزز الحمى القلاعية (بعد 21 يوم)", stage: "booster21" });
        tasks.push({ dueDate: addDaysISO(eventDate, 180), title: "إعادة الحمى القلاعية (بعد 6 شهور)", stage: "repeat6m" });
      } else if (doseType === "booster") {
        tasks.push({ dueDate: addDaysISO(eventDate, 180), title: "إعادة الحمى القلاعية (بعد 6 شهور)", stage: "repeat6m" });
      }
      return tasks;
    }
  },
};

function toISODate(d){
  if (!d) return null;
  if (typeof d === "string") return d.slice(0,10);
  try {
    const x = new Date(d);
    if (isNaN(x)) return null;
    x.setMinutes(x.getMinutes()-x.getTimezoneOffset());
    return x.toISOString().slice(0,10);
  } catch { return null; }
}

export function addDaysISO(iso, days){
  const s = String(iso||"").slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + Number(days||0));
  d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
  return d.toISOString().slice(0,10);
}

// ✅ بناء Tasks التحصين (يرجع Array من {dueDate,title,stage})
function buildVaccinationTasks({ vaccineKey, doseType, eventDate }){
    throw new Error("buildVaccinationTasks is DISABLED. Use vaccinationTasksFromEvent() only.");
  const key = String(vaccineKey||"").trim();
  const dose = String(doseType||"").trim();
  const dt = toISODate(eventDate);
  if (!key || !dt) return [];
  const proto = vaccinationProtocols[key];
  if (!proto || typeof proto.schedule !== "function") return [];
  const out = proto.schedule({ eventDate: dt, doseType: dose }) || [];
  return out.filter(t => t && t.dueDate && t.title);
}
// ===================================================================
//                          الحُرّاس (GUARDS للأحداث)
// ===================================================================
export const guards = {
  
vaccinationDecision(fd) {
  const doc = fd.documentData;

  // ✅ التحصين الجماعي: ممكن لا يتوفر documentData داخل نفس الفورم
  // ساعتها لا نمنع الحفظ هنا (وجود/أهلية كل رقم تُحسم عند مرحلة الحفظ/التحميل)
  if (!doc) return null;

  // ✅ خارج القطيع
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل تحصين — الحيوان خارج القطيع.";

  // ✅ المستبعد تناسليًا يُحصَّن عادي
  return null;
},

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

// ✅ تسمية الحيوان لغويًا
const animalWord = (sp === "جاموس") ? "جاموسة" : "بقرة";

// ✅ عرض الحالة الفعلية للمستخدم
const shownStatus = rsRaw ? `«${rsRaw}»` : "غير معروفة";

// ✅ رسائل أدق حسب الحالة
if (!rsNorm.includes("عشار")) {

  // ملقحة
  if (rsNorm.includes("ملقح")) {
    return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
  }

  // مفتوحة/فارغة
  if (rsNorm.includes("مفتوح") || rsNorm.includes("فارغ")) {
    return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
  }

  // حديثة الولادة (لو عندك هذا النص في النظام)
  if (rsNorm.includes("حديث") || rsNorm.includes("ولاد")) {
    return `❌ لا يمكن تسجيل ولادة لـ${animalWord} ${shownStatus}.`;
  }

  // أي حالة أخرى
  return `❌ لا يمكن تسجيل ولادة لـ${animalWord} — الحالة التناسلية الحالية: ${shownStatus}.`;
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
  // مصير العجل/العجول حسب العدد
  if (!String(fd.calf1Fate || "").trim()) {
    return { field: "calf1Fate", msg: "❌ مصير العجل (1) مطلوب." };
  }
  if (count >= 2 && !String(fd.calf2Fate || "").trim()) {
    return { field: "calf2Fate", msg: "❌ مصير العجل (2) مطلوب." };
  }
  if (count >= 3 && !String(fd.calf3Fate || "").trim()) {
    return { field: "calf3Fate", msg: "❌ مصير العجل (3) مطلوب." };
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

  // ❌ خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل تلقيح — الحيوان خارج القطيع.";

  // ✅ تحديد النوع
  let sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const minPostCalving = { "أبقار": 60, "جاموس": 45 };

  // ❌ عشار
  const repro = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  if (repro.includes("عشار")) {
    return "❌ الحيوان مسجل عِشار — لا يمكن تلقيحه.";
  }

  // ❌ لازم تاريخ ولادة
  const lastCalving =
    String(doc.lastCalvingDate || "").trim() ||
    (String(fd.lastBoundaryType || "").trim() === "ولادة" ? String(fd.lastBoundary || "").trim() : "");

  if (!lastCalving) return "❌ لا يوجد تاريخ آخر ولادة.";
  const gapCalving = daysBetween(lastCalving, fd.eventDate);

  if (gapCalving < (minPostCalving[sp] || 60)) {
    return `❌ التلقيح مبكر بعد الولادة (${gapCalving} يوم). الحد الأدنى ${minPostCalving[sp] || 60} يوم.`;
  }

  // ✅ آخر تلقيح: من الأحداث أولًا ثم الوثيقة
  const lastAI = String(fd.lastInseminationDate || doc.lastInseminationDate || "").trim();
  if (lastAI) {
    const gapAI = daysBetween(lastAI, fd.eventDate);

    // ❌ منع تكرار نفس اليوم
    if (gapAI === 0) {
      return "❌ لا يمكن تسجيل تلقيح مرتين في نفس اليوم.";
    }

    // ⚠️ تحذير لو أقل من 11 يوم
    if (gapAI < 11) {
      return `WARN|⚠️ تنبيه: آخر تلقيح منذ ${gapAI} يوم فقط (أقل من 11 يوم).`;
    }
  }

  return null;
},
heatDecision(fd) {
  const d = fd.documentData;
  if (!d) return "تعذّر قراءة بيانات الحيوان.";

  // ✅ خارج القطيع (أمان إضافي — الـGate يمنعها أصلًا)
  const st = String(d.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ الحيوان خارج القطيع.";

  // ✅ تحديد النوع لغويًا: بقرة/جاموسة
  const sp = normalizeSpecies(fd.species || d.species || d.animalTypeAr || d.animalType || "");
  const aw = animalWord(sp);

  // ❌ مستبعدة تناسليًا
  const rsRaw = String(fd.reproStatusFromEvents || d.reproductiveStatus || "").trim();
  const cat = reproCategory(rsRaw);
  if (d.breedingBlocked === true || cat === "blocked") {
    return `❌ هذه ${aw} مستبعدة تناسليًا (لا تُلقّح مرة أخرى).`;
  }

  // ❌ عِشار: امنع + اعرض زر "تأكيد الحمل"
  if (cat === "pregnant") {
    return `OFFER_PREG|❌ هذه ${aw} عِشار — لا يمكن تسجيل شياع.
هل تريد فتح صفحة تشخيص الحمل للتأكيد؟`;
  }

  // ✅ باقي الحالات التناسلية مسموح تسجيلها شياع (مفتوحة/ملقحة/غير معروفة…)
  return null;
},


pregnancyDiagnosisDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // ✅ الحالة التناسلية: من الأحداث أولًا ثم الوثيقة
  const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  const cat = reproCategory(rsRaw);

  // لازم تكون "ملقحة"
  if (cat !== "inseminated") {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ لا يمكن تشخيص الحمل — الحالة التناسلية يجب أن تكون «ملقحة» فقط.\nالحالة الحالية: ${shown}.`;
  }

  // ✅ طريقة التشخيص
  const method = String(fd.method || "").trim();
  const isSono = (method === "سونار");
  const isManual = (method === "جس يدوي");
  if (!isSono && !isManual) return "❌ طريقة التشخيص غير معروفة.";

  const minDays = isSono ? 26 : 40;

  // ✅ آخر تلقيح (أي تلقيح) — من البوابة/الأحداث أولًا ثم الوثيقة
  const lastAI =
    String(fd.lastInseminationDate || doc.lastInseminationDate || doc.lastAI || doc.lastInsemination || "").trim();

  if (!isDate(lastAI)) return '❌ لا يمكن تشخيص الحمل — لا يوجد "آخر تلقيح" صحيح.';

  if (!isDate(fd.eventDate)) return "❌ تاريخ التشخيص غير صالح.";

  const diff = daysBetween(lastAI, fd.eventDate);
  if (!Number.isFinite(diff)) return "❌ تعذّر حساب الأيام منذ آخر تلقيح.";

  if (diff < minDays) {
    return `❌ لا يمكن تشخيص الحمل الآن — مرّ ${diff} يوم فقط منذ آخر تلقيح.\nالحد الأدنى لطريقة «${method}» هو ${minDays} يوم.`;
  }

  return null;
},

abortionDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // ✅ خارج القطيع (احتياطي - رغم إن validateEvent بيقفله)
  const st = String(doc?.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ لا يمكن تسجيل إجهاض — الحيوان خارج القطيع.";

  // ✅ لازم تاريخ صالح
  if (!isDate(fd.eventDate)) return "❌ تاريخ الإجهاض غير صالح.";

  // ✅ تحديد النوع (Normalize)
  let sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const th = thresholds[sp]?.minGestationDays;
  if (!th) return "نوع القطيع غير معروف لحساب عمر الحمل.";

  // ✅ لازم يكون عِشار (الأحداث أولًا لو أنت مررت reproStatusFromEvents، وإلا الوثيقة)
  const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  const rsNorm = rsRaw.replace(/\s+/g, "").replace(/[ًٌٍَُِّْ]/g, "");

  if (!rsNorm.includes("عشار")) {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ الحيوان ليس عِشار — الحالة التناسلية الحالية: ${shown}.`;
  }

  // ✅ لازم آخر تلقيح
  const lf =
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    doc.lastServiceDate ||
    "";

  if (!isDate(lf)) return '❌ لا يمكن تسجيل إجهاض — لا يوجد "آخر تلقيح".';

  // ✅ Boundary: لو في (ولادة/إجهاض) بعد التلقيح → الحمل اتلغى
  const boundary = String(fd.lastBoundary || "").trim();
  if (boundary && isDate(boundary)) {
    const b = new Date(boundary); b.setHours(0,0,0,0);
    const l = new Date(lf);       l.setHours(0,0,0,0);
    if (b.getTime() >= l.getTime()) {
      return `❌ لا يُسمح بتسجيل الإجهاض: آخر حدث (${boundary}) يلغي أي حمل حالي.`;
    }
  }

  // ✅ حساب عمر الحمل
  const gDays = daysBetween(lf, fd.eventDate);
  if (Number.isNaN(gDays)) return "تعذّر حساب عمر الحمل.";

  // ✅ لو عمر الحمل وصل/تخطى الحد الأدنى للولادة… غالبًا دي “ولادة مبكرة/نافقة”
  if (gDays >= th) {
    return `❌ عمر الحمل ${gDays} يوم — هذا أقرب لولادة وليس إجهاض (الحد الأدنى للولادة ${th} يوم).`;
  }

  // ✅ مسموح: أقل من حد الولادة
  return null;
},
dailyMilkDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  // تحديد النوع
  let sp = String(fd.species || doc.species || doc.animalTypeAr || doc.animalType || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const isBuffalo = (sp === "جاموس");

  const s1 = Number(String(fd.milkS1 || "").trim() || "0");
  const s2 = Number(String(fd.milkS2 || "").trim() || "0");
  const s3 = Number(String(fd.milkS3 || "").trim() || "0");

  const total = isBuffalo ? (s1 + s2) : (s1 + s2 + s3);

  // لازم يكون في لبن فعلي
  if (total <= 0) {
    return "❌ أدخل كمية اللبن (حلبة واحدة على الأقل) — لا يمكن الحفظ بإجمالي صفر.";
  }

  // تحذير منطقي (مش منع)
  const max = isBuffalo ? 40 : 80;
  if (total > max) {
    return `WARN|⚠️ تنبيه: إجمالي اللبن ${total.toFixed(1)} كجم رقم كبير جدًا — راجع الحلبات قبل الحفظ.`;
  }

  return null;
},
closeupDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "❌ تعذّر العثور على الحيوان.";
  // ✅ منع تكرار "تحضير للولادة" داخل نفس الموسم (نفس اللاكتشن)
  const lastCloseUp = String(doc.lastCloseUpDate || "").trim();
  const lastCalving = String(doc.lastCalvingDate || "").trim();

  if (isDate(lastCloseUp)) {
    // لو مفيش آخر ولادة مسجلة: أي تحضير سابق يعتبر تكرار
    if (!isDate(lastCalving)) {
      return `❌ تم تسجيل تحضير للولادة مسبقًا بتاريخ ${lastCloseUp} — لا يمكن تكراره في نفس الموسم.`;
    }

    // لو آخر تحضير حصل بعد/منذ آخر ولادة => يبقى داخل نفس الموسم الحالي
    const gapFromCalvingToCloseUp = daysBetween(lastCalving, lastCloseUp);
    if (!Number.isNaN(gapFromCalvingToCloseUp) && gapFromCalvingToCloseUp >= 0) {
      return `❌ تم تسجيل تحضير للولادة مسبقًا في هذا الموسم بتاريخ ${lastCloseUp} — لا يمكن تكراره.`;
    }
  }

  // خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    return "❌ لا يمكن تسجيل التحضير — الحيوان خارج القطيع.";
  }

  // تحديد النوع
  let sp = String(fd.species || doc.species || doc.animalTypeAr || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const th = thresholds[sp]?.minGestationDays;
  if (!th) return "❌ نوع القطيع غير معروف لحساب عمر الحمل.";

  // الحالة التناسلية
  const rsRaw = String(
    fd.reproStatusFromEvents ||
    doc.reproductiveStatus ||
    ""
  ).trim();

  const rsNorm = rsRaw.replace(/\s+/g, "").replace(/[ًٌٍَُِّْ]/g, "");
  if (!rsNorm.includes("عشار")) {
    const shown = rsRaw ? `«${rsRaw}»` : "غير معروفة";
    return `❌ لا يمكن تسجيل التحضير — الحالة التناسلية الحالية: ${shown}.`;
  }

  // آخر تلقيح
  const lf =
    fd.lastInseminationDate ||
    doc.lastInseminationDate ||
    doc.lastAI ||
    doc.lastInsemination ||
    doc.lastServiceDate ||
    "";

  if (!isDate(lf)) {
    return '❌ لا يمكن تسجيل التحضير — لا يوجد "آخر تلقيح مُخصِّب".';
  }

  if (!isDate(fd.eventDate)) return "❌ تاريخ التحضير غير صالح.";

  const gDays = daysBetween(lf, fd.eventDate);
  if (Number.isNaN(gDays)) return "❌ تعذّر حساب عمر الحمل.";

const remaining = th - gDays;

if (remaining > 40) {
  return `❌ لا يمكن تسجيل التحضير — المتبقي على أقل موعد ولادة ${remaining} يوم (أكثر من 40 يوم).`;
}
  return null;
},
dryOffDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة وثيقة الحيوان.";

  const norm = (s) => String(s || "").trim();

  // خارج القطيع
  const st = norm(doc.status).toLowerCase();
  if (st === "inactive") {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان خارج القطيع.";
  }

  // ممنوع لو بالفعل جاف
  const ps = norm(doc.productionStatus).toLowerCase();
  if (ps === "dry" || ps === "جاف") {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان مُسجّل بالفعل كـ «جاف».";
  }

  // منع تكرار قبل الولادة
  const lastDry = norm(doc.lastDryOffDate).slice(0,10);
  const lastCalv = norm(doc.lastCalvingDate).slice(0,10);
  if (isDate(lastDry)) {
    if (!isDate(lastCalv) || lastCalv <= lastDry) {
      return `❌ لا يمكن تسجيل تجفيف مرة أخرى قبل الولادة.\nآخر تجفيف: ${lastDry}`;
    }
  }

  // تحديد الاستبعاد التناسلي
  const reproDocRaw = norm(doc.reproductiveStatus);
  const blocked =
    doc.breedingBlocked === true ||
    reproCategory(reproDocRaw) === "blocked";

  const reason = norm(fd.reason);

  // 🟢 حالة البيع (مستبعد تناسليًا)
  if (blocked) {
    if (reason !== "تجفيف للبيع") {
      return "❌ الحيوان مستبعد تناسليًا — مسموح فقط بـ «تجفيف للبيع».";
    }
    return null;
  }

  // 🔴 غير مستبعد → لازم يكون عشار
  const reproEventsRaw = norm(fd.reproStatusFromEvents);
  const cat = reproCategory(reproEventsRaw || reproDocRaw);

  if (cat !== "pregnant") {
    return "❌ لا يمكن تسجيل تجفيف — الحيوان ليس عِشار.";
  }

  // الآن فقط نحسب الحمل
  const g = Number(fd.gestationDays);
  if (!Number.isFinite(g)) {
    return "❌ تعذّر حساب أيام الحمل — لا يوجد آخر تلقيح.";
  }

  const pregConfirm = norm(fd.pregnancyStatus);
  if (pregConfirm !== "عشار") {
    return "❌ يجب تأكيد الحمل «عشار» قبل الحفظ.";
  }

  // 6.5 شهر = 198 يوم
  const isNatural = (reason === "تجفيف طبيعي");
  const isUrgent  = (reason === "تجفيف اضطراري");

  if (g < 198 && !isUrgent) {
    return "❌ أقل من 6.5 شهر ⇒ «تجفيف اضطراري».";
  }

  if (g >= 198 && g <= 228 && !isNatural) {
    return "❌ من 6.5 إلى 7.5 شهر ⇒ «تجفيف طبيعي».";
  }

  return null;
},
ovsynchEligibilityDecision(fd) {
  const doc = fd.documentData;
  if (!doc) return "تعذّر قراءة بيانات الحيوان.";

  // ✅ خارج القطيع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") return "❌ الحيوان خارج القطيع.";

  // ✅ مستبعدة (لا تُلقّح مرة أخرى) — من الوثيقة نفسها
  const reproDocRaw = String(doc.reproductiveStatus || "").trim();
  const reproDocCat = reproCategory(reproDocRaw);
  if (doc.breedingBlocked === true || reproDocCat === "blocked") {
    return "❌ الحيوان مستبعد (لا تُلقّح مرة أخرى).";
  }
  // ✅ منع بدء بروتوكول جديد إذا كان الحيوان داخل بروتوكول نشط بالفعل (وثيقة الحيوان)
  const curProto = String(doc.currentProtocol || "").trim().toLowerCase();
  const protoStatus = String(doc.protocolStatus || "").trim().toLowerCase();
  const protoStart = String(doc.protocolStartDate || "").trim();

  if (curProto === "ovsynch" && protoStatus === "active") {
    const d = protoStart || "غير معروف";
    return `❌ لا يمكن بدء بروتوكول جديد — الحيوان بالفعل داخل بروتوكول تزامن نشط (بدأ ${d}).`;
  }

  // ✅ تحديد النوع
  const sp = normalizeSpecies(fd.species || doc.species || doc.animalTypeAr || doc.animalType || doc.animaltype || doc.type || "");
  const w  = animalWord(sp);

  // ✅ الحالة التناسلية الفعلية (الأحداث أولًا ثم الوثيقة)
  const rsRaw = String(fd.reproStatusFromEvents || doc.reproductiveStatus || "").trim();
  const cat   = reproCategory(rsRaw);
  const shownStatus = rsRaw ? `«${rsRaw}»` : "غير معروفة";

  // ❌ ممنوع: عشار / ملقحة / مستبعدة
  if (cat === "pregnant" || cat === "inseminated" || cat === "blocked") {
    return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — الحالة: ${shownStatus}.`;
  }

  // ✅ المسموح فقط: مفتوحة/فارغة
  if (cat !== "open") {
    return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — المسموح فقط للحيوانات المفتوحة.\nالحالة الحالية: ${shownStatus}.`;
  }

  // ✅ لازم تاريخ الحدث صالح
  if (!isDate(fd.eventDate)) return "❌ تاريخ بدء البروتوكول غير صالح.";

    // ✅ منع "حديثة الولادة" (رسالة مهنية واضحة)
  // (يمكن لاحقًا جعلها إعداد/Config، الآن ثابتة مثل التلقيح)
  const lastCalving = String(doc.lastCalvingDate || "").trim();
  if (lastCalving && isDate(lastCalving)) {
    // نفس حدودك المعتمدة: أبقار 60 / جاموس 45
    const minAfterCalving = (sp === "جاموس") ? 45 : 60;
    const sinceCalving = daysBetween(lastCalving, fd.eventDate);
    if (Number.isFinite(sinceCalving) && sinceCalving >= 0 && sinceCalving < minAfterCalving) {
      return `❌ لا يمكن بدء بروتوكول تزامن لـ${w} — حديثة الولادة (منذ ${sinceCalving} يوم).`;
    }
  }

  // ✅ قاعدة 14 يوم — تُحسب من نهاية آخر Ovsynch (وليس من بدايته)
  // forms-init سيمرّر fd.lastOvsynchEndDate
  const lastEnd = String(fd.lastOvsynchEndDate || "").trim();
  if (lastEnd && isDate(lastEnd)) {
    const diff = daysBetween(lastEnd, fd.eventDate);
    if (Number.isFinite(diff) && diff >= 0 && diff < 14) {
      // كود خاص: عشان preview يستبعده من القائمة بدل ما يوقف الدنيا كخطأ
      return `SKIP_OV_ACTIVE|${w} ضمن برنامج تزامن حديث — يلزم مرور 14 يوم بعد انتهاء آخر Ovsynch (انتهى ${lastEnd}).`;
    }
  }

  return null;

}
};
// ===================================================================
//  Vaccination Tasks Generator (Egypt v1) — Central Source of Truth
// ===================================================================
function ymdAddDays(ymd, days){
  const d = new Date(String(ymd||"").slice(0,10));
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + Number(days||0));
  const x = new Date(d.getTime());
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0,10);
}

// ✅ نافذة 7 أيام ثابتة: start = dueDate ، end = dueDate + 6
function makeTask(typeKey, dueDate, meta = {}){
  const dd = String(dueDate||"").slice(0,10);
  return {
    taskType: "vaccination",
    vaccineKey: typeKey,
    dueDate: dd,
    windowStart: dd,
    windowEnd: ymdAddDays(dd, 6),
    status: "open",
    ...meta
  };
}

// ✅ المصدر المركزي للبروتوكولات (مصر v1)
// تُرجع قائمة Tasks (واحدة أو أكثر) بناءً على Event التحصين الحالي
export function vaccinationTasksFromEvent({ vaccine, doseType, eventDate, campaignId }){
  const v = String(vaccine||"").trim();
  const dose = String(doseType||"").trim(); // primary | booster
  const normalizedDose =
  dose === "prime" ? "primary" :
  dose === "periodic" ? "booster" :
  dose;
 
  const dt = String(eventDate||"").slice(0,10);
  if (!v || !normalizedDose || !dt) return [];

  const meta = campaignId ? { campaignId } : {};

  // قاعدة Zero History (Booster 21 يوم) عند الجرعة الأولية
  if (normalizedDose === "primary") {
    // Task Booster بعد 21 يوم
    return [
      makeTask(v, ymdAddDays(dt, 21), { ...meta, doseType: "booster", basedOn: "primary+21" })
    ];
  }

  // جرعة منشطة (Booster): مواعيد التكرار حسب البروتوكول
  // ملاحظة: لو احتجت "أولي + سنوي" لبعض اللقاحات، ده يُدار من صفحة "أولي" أعلاه (بوستر)
  // هنا نضبط تكرار الجرعة المنشطة نفسها:

  // 6 شهور ≈ 182 يوم
  const SIX_MONTHS = 182;
  // سنة ≈ 365 يوم
  const ONE_YEAR = 365;

  // بروتوكولات مصر v1 (مبسطة مركزياً)
  // - FMD: كل 6 شهور
  // - تنفسي ميت/منفصل: كل 6 شهور
  // - باسترِيلا: كل 6 شهور
  // - LSD حي: سنوي
  // - تنفسي حي: سنوي
  // - 3 أيام: سنوي
  // - بروسيلا: مرة واحدة (لا تكرار)
  // - لاهوائيات للعجول: كل 6 شهور حتى سنة (ده يُحسم لاحقًا من عمر الحيوان في Engine/Save)

  if (v.includes("FMD") || v.includes("الحمى القلاعية")) {
    return [ makeTask(v, ymdAddDays(dt, SIX_MONTHS), { ...meta, doseType: "booster", cycle: "6m" }) ];
  }

  if (v.includes("Pasteurella") || v.includes("الباستريلا") || v.includes("HS")) {
    return [ makeTask(v, ymdAddDays(dt, SIX_MONTHS), { ...meta, doseType: "booster", cycle: "6m" }) ];
  }

  if (v.includes("Clostridial") || v.includes("التسمم المعوي")) {
    return [ makeTask(v, ymdAddDays(dt, SIX_MONTHS), { ...meta, doseType: "booster", cycle: "6m" }) ];
  }

  if (v.includes("LSD") || v.includes("الجلد العقدي")) {
    return [ makeTask(v, ymdAddDays(dt, ONE_YEAR), { ...meta, doseType: "booster", cycle: "1y" }) ];
  }

  if (v === "IBR" || v === "BVD" || v.includes("تنفسي")) {
    return [ makeTask(v, ymdAddDays(dt, ONE_YEAR), { ...meta, doseType: "booster", cycle: "1y" }) ];
  }

  if (v.includes("Brucella") || v.includes("البروسيلا")) {
    // مرة واحدة — لا مهام لاحقة
    return [];
  }

  // Default: سنوي احتياطي
  return [ makeTask(v, ymdAddDays(dt, ONE_YEAR), { ...meta, doseType: "booster", cycle: "1y" }) ];
}
// ===================================================================

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
// ✅ Fallback مركزي لحدث "إجهاض": آخر تلقيح من الوثيقة (لأن الصفحة قد لا تُرسله)
if (eventType === "إجهاض") {
  const d = payload.documentData || {};
  if (!payload.lastInseminationDate) {
    payload.lastInseminationDate = String(d.lastInseminationDate || "").trim();
  }
  if (!payload.species) {
    payload.species = String(d.species || d.animalTypeAr || "").trim();
  }
}
  // ✅ Fallback مركزي لحدث "تلقيح": تحديد النوع تلقائيًا من documentData
if (eventType === "تلقيح") {
  const d = payload.documentData || {};
  if (!payload.species) {
    let sp = String(d.species || d.animalTypeAr || d.animalType || "").trim();
    if (/cow|بقر/i.test(sp)) sp = "أبقار";
    if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";
    payload.species = sp;
  }
}
// ✅ Fallback مركزي لحدث "تحضير للولادة"
if (eventType === "تحضير للولادة") {
  const d = payload.documentData || {};
  if (!payload.lastInseminationDate) {
    payload.lastInseminationDate = String(d.lastInseminationDate || "").trim();
  }
  if (!payload.species) {
    payload.species = String(d.species || d.animalTypeAr || "").trim();
  }
}
// ✅ Fallback مركزي لحدث "تجفيف"
if (eventType === "تجفيف") {
  const d = payload.documentData || {};
  if (!payload.species) {
    payload.species = String(d.species || d.animalTypeAr || d.animalType || "").trim();
  }
  if (!payload.lastInseminationDate) {
    payload.lastInseminationDate = String(d.lastInseminationDate || "").trim();
  }
}

  const errors = [];
  const fieldErrors = {};
  const guardErrors = [];
// ✅ Pre-calc مركزي لحدث "لبن يومي": احسب milkKg قبل فحص الحقول
if (eventType === "لبن يومي") {
  const d = payload.documentData || {};
  let sp = String(payload.species || d.species || d.animalTypeAr || d.animalType || "").trim();
  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

  const isBuffalo = (sp === "جاموس");

  const s1 = Number(String(payload.milkS1 || "").trim() || "0");
  const s2 = Number(String(payload.milkS2 || "").trim() || "0");
  const s3 = Number(String(payload.milkS3 || "").trim() || "0");

  const total = isBuffalo ? (s1 + s2) : (s1 + s2 + s3);
  payload.milkKg = Number.isFinite(total) ? Number(total.toFixed(1)) : "";
}

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
    // ✅ تحذيرات لا تمنع الحفظ
if (typeof gErr === "string" && gErr.startsWith("WARN|")) continue;


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

