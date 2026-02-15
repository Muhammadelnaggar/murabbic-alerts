// /js/forms-init.js — ESM (Central Gate + Validation)
// ✅ Gate: يتحقق من وجود الحيوان أولًا (ويمنع ملء باقي الحقول حتى يثبت وجوده)
// ✅ Validation: عند الحفظ فقط (لتجنب Deadlock قبل إدخال الحقول)
// ✅ يجمع [data-field] ويُظهر رسائل في infobar أعلى النموذج
// ✅ عند النجاح يطلق "mbk:valid" ويحمل البيانات في detail.formData

import { validateEvent, uniqueAnimalNumber, thresholds, uniqueCalfNumbers, guards } from "./form-rules.js";
import { db, auth } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

function ensureInfoBar(form) {
  // 1) لو موجود sysbar أو infobar بالفعل (داخل الفورم أو خارجه) استخدمه
  let bar =
    document.getElementById("sysbar") ||
    form.querySelector("#sysbar") ||
    form.querySelector(".infobar") ||
    document.querySelector(".infobar");

  // 2) لو مش موجود: أنشئ واحد “قياسي” لمُرَبِّيك
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "sysbar";
    bar.className = "infobar mbk-infobar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");

    // 3) حطه في مكان ثابت قدر الإمكان:
    // - لو فيه header: ضعه بعده مباشرة
    // - وإلا ضعه أعلى الفورم
    const header = document.querySelector("header");
    if (header && header.parentNode) {
      header.insertAdjacentElement("afterend", bar);
    } else {
      form.prepend(bar);
    }
  }

  return bar;
}


function _escapeHtml(s){
  return String(s ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function showMsg(bar, msgs, type = "error", actions = []) {
  if (!bar) return;

  bar.style.display = "block";
 const cls =
  (type === "error") ? "error" :
  (type === "ok" || type === "success") ? "success" :
  (type === "warn" || type === "warning") ? "warning" :
  "info";

bar.className = "infobar show " + cls;


  const isErr = (type === "error");
 // bar.style.borderColor = isErr ? "#ef9a9a" : "#86efac";
  //bar.style.background  = isErr ? "#ffebee" : "#ecfdf5";
 // bar.style.color       = isErr ? "#b71c1c" : "#065f46";

  const lines = Array.isArray(msgs) ? msgs : [msgs];
  const safeLines = lines.filter(Boolean).map(_escapeHtml);

  const html = `
    <div class="msgrow" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
      <div style="white-space:pre-line;font-weight:900;font-size:18px;line-height:1.6">
        ${safeLines.join("<br>")}
      </div>

      <button type="button" class="okbtn"
        style="flex-shrink:0;border-radius:16px;padding:10px 14px;font-weight:900;border:2px solid #0b7f47;background:#fff;color:#0b7f47;cursor:pointer">
        حسنًا
      </button>
    </div>
  `;

  bar.innerHTML = html;

  try { bar.scrollIntoView({ behavior:"smooth", block:"start" }); } catch(_) {}

  // actions (اختياري)
  if (Array.isArray(actions) && actions.length) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:10px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";

    actions.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label || "إجراء";
      btn.style.cssText =
        "padding:10px 12px;border-radius:12px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-weight:800;font-size:14px;min-width:150px;";
      if (a.primary) {
        btn.style.border = "0";
        btn.style.background = "#0ea05a";
        btn.style.color = "#fff";
      }
      btn.addEventListener("click", () => { try { a.onClick && a.onClick(); } catch(_) {} });
      wrap.appendChild(btn);
    });

    bar.appendChild(wrap);
  }
}
// ✅ expose for other pages (ovsynch.html uses it)
window.showMsg = showMsg;
window.ensureInfoBar = ensureInfoBar;

/* ===================== UI: Field Errors (Inline) ===================== */
function clearFieldErrors(form){
  form.querySelectorAll(".mbk-field-error").forEach(el => el.remove());
  form.querySelectorAll(".mbk-field-error-target").forEach(el => {
    el.classList.remove("mbk-field-error-target");
    el.removeAttribute("aria-invalid");
  });
}

function placeFieldError(form, fieldName, msg){
  const el =
    form.querySelector(`[data-field="${fieldName}"]`) ||
    form.querySelector(`#${fieldName}`) ||
    null;

  if (!el || !el.parentNode) return null;

  const box = document.createElement("div");
  box.className = "mbk-field-error";
  box.style.cssText = "margin:6px 0 6px; padding:8px 10px; border-radius:10px; background:#ffebee; border:1px solid #ef9a9a; color:#b71c1c; font: 13px/1.4 system-ui,'Cairo',Arial;";
  box.textContent = String(msg || "خطأ في هذا الحقل.");

  el.parentNode.insertBefore(box, el);
  el.classList.add("mbk-field-error-target");
  el.setAttribute("aria-invalid", "true");
  return box;
}

function scrollToFirstFieldError(form){
  const first = form.querySelector(".mbk-field-error");
  if (first) {
    first.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* ===================== Helpers ===================== */
async function getUid() {
  if (auth?.currentUser?.uid) return auth.currentUser.uid;

  return await new Promise((res) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      try { unsub && unsub(); } catch(_) {}
      res(u?.uid || "");
    });
  });
}

function normalizeDigits(number) {
  const map = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9"
  };
  return String(number || "")
    .trim()
    .replace(/[^\d٠-٩۰-۹]/g, "")
    .replace(/[٠-٩۰-۹]/g, (d) => map[d]);
}

function stripTashkeel(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "");
}
function daysBetweenISO(a, b){
  const d1 = new Date(String(a || "").slice(0,10));
  const d2 = new Date(String(b || "").slice(0,10));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return NaN;
  d1.setHours(0,0,0,0); d2.setHours(0,0,0,0);
  return Math.round((d2 - d1) / 86400000);
}
function mbkOvsynchIgnoreFreshRule(){
  try{
    // 1 = تجاهل قاعدة حديث الولادة / ما بعد الولادة
    return localStorage.getItem("mbk_ov_ignore_fresh") === "1";
  }catch(_){
    return false;
  }
}

function getFieldEl(form, name) {
  return (
    form.querySelector(`[data-field="${name}"]`) ||
    form.querySelector(`#${name}`) ||
    null
  );
}

function setFormInputsDisabled(form, disabled, allowIds = []) {
  const allow = new Set((allowIds || []).filter(Boolean));
  form.querySelectorAll("input, select, textarea, button").forEach((el) => {
    if (allow.has(el.id)) return;
    if (allow.has(el.getAttribute("data-field"))) return;
    el.disabled = !!disabled;
  });
}

/* ===================== Data: Collect (Robust) ===================== */
function readFieldValue(form, el) {
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();

  if (type === "radio") {
    const name = el.getAttribute("name");
    if (!name) return "";
    const checked = form.querySelector(
      `input[type="radio"][name="${CSS.escape(name)}"]:checked`
    );
    return checked ? String(checked.value || "").trim() : "";
  }

  if (type === "checkbox") return !!el.checked;
  if (tag === "select") return String(el.value || "").trim();
  return String(el.value || "").trim();
}

function collectFormData(form) {
  const data = {};
  const fields = Array.from(form.querySelectorAll("[data-field]"));

  for (const el of fields) {
    const key = el.getAttribute("data-field");
    if (!key) continue;

    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "radio" && key in data) continue;

    data[key] = readFieldValue(form, el);
  }

  if (!data.species && localStorage.getItem("herdSpecies")) {
    data.species = localStorage.getItem("herdSpecies");
  }

  return data;
}

/* ===================== Animal Gate ===================== */
async function fetchAnimalByNumberForUser(uid, number) {
  const num = normalizeDigits(number);
  if (!uid || !num) return null;

  try {
    const key = `${uid}#${num}`;
    const q1 = query(
      collection(db, "animals"),
      where("userId_number", "==", key),
      limit(1)
    );
    const s1 = await getDocs(q1);
    if (!s1.empty) {
      const d = s1.docs[0];
      return { id: d.id, data: d.data() || {} };
    }
  } catch (_) {}

  const tries = [
    ["number", num],
    ["animalNumber", num],
    ["animalNumber", Number(num)]
  ].filter((t) => !(typeof t[1] === "number" && Number.isNaN(t[1])));

  for (const [field, val] of tries) {
    try {
      const q2 = query(
        collection(db, "animals"),
        where("userId", "==", uid),
        where(field, "==", val),
        limit(1)
      );
      const s2 = await getDocs(q2);
      if (!s2.empty) {
        const d = s2.docs[0];
        return { id: d.id, data: d.data() || {} };
      }
    } catch (_) {}
  }

  return null;
}

async function fetchCalvingSignalsFromEvents(uid, number) {
  const num = String(normalizeDigits(number || "")).trim();

  if (!uid || !num) {
   return { reproStatusFromEvents: "", lastBoundary: "", lastBoundaryType: "", lastInseminationDateFromEvents: "" };

  }

  const qEv = query(
    collection(db, "events"),
    where("userId", "==", uid),
    where("animalNumber", "==", num),
    limit(60)
  );

  const snap = await getDocs(qEv);
  const arr = snap.docs
    .map((d) => d.data() || {})
    .filter((ev) => ev.eventDate)
    .sort((a, b) => String(b.eventDate).localeCompare(String(a.eventDate)));

  let reproStatusFromEvents = "";
  let lastBoundary = "";
  let lastBoundaryType = "";
  let lastInseminationDateFromEvents = "";


  for (const ev of arr) {
    const type = String(ev.eventType || ev.type || "").trim();
    const res  = String(ev.result || ev.status || "").trim();
    const dt   = String(ev.eventDate || "").trim();

    if ((type === "ولادة" || type === "إجهاض") && !lastBoundary) {
      lastBoundary = dt;
      lastBoundaryType = type;
      if (!reproStatusFromEvents) reproStatusFromEvents = "مفتوحة";
      continue;
    }
   // ✅ آخر تلقيح من الأحداث (حتى لو وثيقة الحيوان لم تتحدث بعد)
if ((type === "تلقيح" || type === "insemination") && !lastInseminationDateFromEvents) {
  lastInseminationDateFromEvents = dt;
}

    if (type === "تشخيص حمل") {
      const r = stripTashkeel(res);
      if (!reproStatusFromEvents) {
        if (r.includes("عشار")) reproStatusFromEvents = "عشار";
        if (r.includes("فارغه") || r.includes("فارغة")) reproStatusFromEvents = "مفتوحة";
      }
    }

    if (reproStatusFromEvents && lastBoundary) break;
  }

  return { reproStatusFromEvents, lastBoundary, lastBoundaryType, lastInseminationDateFromEvents };

}
// ======================================================
// ✅ Murabbik Central: Ovsynch Bulk Preview (DOC-BASED)
// يعتمد على وثيقة الحيوان فقط للحالة التناسلية + آخر ولادة + inactive
// + يمنع Ovsynch خلال آخر 14 يوم ويقترح Presynch + Ovsynch
// ======================================================
async function previewOvsynchList(numbers = [], eventDate = "") {
  const uid = await getUid();
  const dt = String(eventDate || "").trim().slice(0,10);

  if (!uid) {
    return { ok:false, valid: [], rejected: [{ number:"", reason:"⚠️ لم يتم تأكيد الدخول." }] };
  }
  if (!dt) {
    return { ok:false, valid: [], rejected: [{ number:"", reason:"⚠️ اختر تاريخ بدء البروتوكول أولًا." }] };
  }

  const clean = Array.isArray(numbers) ? numbers.map(normalizeDigits).filter(Boolean) : [];
  const uniq = [...new Set(clean)];

  const valid = [];
  const rejected = [];

  // ✅ helper: species normalize
  function normSpeciesFromDoc(doc){
    let sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || doc?.animaltype || doc?.type || "").trim();
    if (/cow|بقر/i.test(sp)) sp = "أبقار";
    if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";
    return sp || "أبقار";

  }
function animalLabelFromDoc(doc){
  const sp = normSpeciesFromDoc(doc);
  return (sp === "جاموس") ? "الجاموسة" : "البقرة";
}
function compactOvsynchReason(reason){
  let s = String(reason || "").trim();

  // وحّد النص
  s = s.replace(/^\s*❌\s*/,"");
  s = s.replace(/\s+/g," ").trim();

  // اختصار “الحالة الحالية”
  s = s.replace(/الحالة الحالية:\s*«?\s*حديث(?:ة)? الولادة\s*»?/g, "حديثة الولادة");
  s = s.replace(/الحالة الحالية:\s*«?\s*تحضير(?: لل)?ولادة\s*»?/g, "تحضير للولادة");
  s = s.replace(/الحالة الحالية:\s*«?\s*ملقح(?:ة)?\s*»?/g, "ملقحة");
  s = s.replace(/الحالة الحالية:\s*«?\s*عشار\s*»?/g, "عشار");
  s = s.replace(/الحالة الحالية:\s*«?\s*مفتوح(?:ة)?\s*»?/g, "مفتوحة");

  // قص أي ذيل طويل بعد “—”
  s = s.replace(/\s*—\s*المسموح.*$/,"").trim();

  return "❌ " + s;
}

  // ✅ helper: last ovsynch check (14 days)
  async function getLastOvsynchEvent(uid, animalNumber){
    const num = String(animalNumber||"").trim();
    try{
      // أقل تعقيدًا لتقليل مشاكل الـindex: userId + animalNumber + eventType ثم orderBy eventDate
      const qx = query(
        collection(db, "events"),
        where("userId", "==", uid),
        where("animalNumber", "==", num),
        where("eventType", "==", "بروتوكول تزامن"),
        orderBy("eventDate", "desc"),
        limit(1)
      );
      const s = await getDocs(qx);
      if (s.empty) return null;
      const d = s.docs[0].data() || {};
      return {
        eventDate: String(d.eventDate || "").slice(0,10),
        program: String(d.program || "").trim()
      };
    }catch(_){
      return null;
    }
  }

for (const num of uniq) {
  // 1) الحيوان موجود؟
  const animal = await fetchAnimalByNumberForUser(uid, num);
  if (!animal) {
    rejected.push({ number:num, reason:`❌ الحيوان رقم ${num}: غير موجود في القطيع/حسابك.` });
    continue;
  }

  const doc = animal.data || {};
  const animalLabel = animalLabelFromDoc(doc);

  // 2) status: inactive ممنوع
  const st = String(doc.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    rejected.push({ number:num, reason:`❌ ${animalLabel} رقم ${num}: خارج القطيع (inactive).` });
    continue;
  }

  // 3) مستبعدة (لا تُلقّح مرة أخرى)
  const reproDocRaw = String(doc.reproductiveStatus || "").trim();
  const reproDoc = stripTashkeel(reproDocRaw);

  if (
    doc.breedingBlocked === true ||
    reproDoc.includes("لاتلقحمرةاخرى") ||
    reproDoc.includes("لاتلقحمرهاخرى") ||
    reproDoc.includes("لاتلقحمرةاخري") ||
    reproDoc.includes("لاتلقح")
  ) {
    rejected.push({ number:num, reason:`❌ ${animalLabel} رقم ${num}: مستبعدة (لا تُلقّح مرة أخرى).` });
    continue;
  }

     // 4) ✅ قرار الأهلية = نفس Guard المركزي (مصدر واحد)
    // جهّز fd للـGuard
    const sp = normSpeciesFromDoc(doc);
    const reproFromDoc = String(doc.reproductiveStatus || "").trim();

    const fd = {
      animalNumber: num,
      eventDate: dt,
      species: sp,
      documentData: doc,
      // في بروتوكول التزامن: نعتمد على الوثيقة (كما اتفقنا)
      reproStatusFromEvents: "", 
    };
    // ✅ 4) قرار الأهلية = نفس Guard المركزي (مصدر واحد)
    // قبل الـGuard: جهّز lastOvsynchEndDate (إن وجد) عشان قاعدة 14 يوم تكون موحّدة من نفس المصدر
    const last = await getLastOvsynchEvent(uid, num);

    let lastEnd = "";
    try{
      const steps = last?.steps;
      if (Array.isArray(steps) && steps.length){
        // أقصى تاريخ خطوة (آخر يوم في البروتوكول)
        const maxISO = steps
          .map(s => String(s?.date || "").trim().slice(0,10))
          .filter(Boolean)
          .sort()
          .slice(-1)[0];
        lastEnd = maxISO || "";
      }
    }catch(_){}

    // fallback: لو مفيش خطوات محفوظة، اعتبر نهاية البروتوكول = تاريخ بدايته
    if (!lastEnd) lastEnd = String(last?.eventDate || "").trim().slice(0,10);

    // جهّز fd للـGuard
    const sp = normSpeciesFromDoc(doc);

    const fd = {
      animalNumber: num,
      eventDate: dt,
      species: sp,
      documentData: doc,
      // في بروتوكول التزامن: نعتمد على الوثيقة (كما اتفقنا)
      reproStatusFromEvents: "",
      lastOvsynchEndDate: lastEnd
    };

    // ✅ نفّذ Guard المركزي نفسه
    try{
      const g = (typeof guards?.ovsynchEligibilityDecision === "function")
        ? guards.ovsynchEligibilityDecision(fd)
        : null;

      if (g) {
        const gs = String(g || "");
        // كود خاص للـPreview: استبعده من القائمة برسالة واضحة بدل ما يوقف الدنيا
        if (gs.startsWith("SKIP_OV_ACTIVE|")){
          const reason = gs.split("|").slice(1).join("|").trim() || "غير مؤهل الآن.";
          rejected.push({ number:num, reason:`❌ ${animalLabel} رقم ${num}: ${reason}` });
          continue;
        }

        rejected.push({ number:num, reason:`❌ ${animalLabel} رقم ${num}: ${gs.replace(/^❌\s*/,"")}` });
        continue;
      }
    }catch(_){
      rejected.push({ number:num, reason:`❌ ${animalLabel} رقم ${num}: تعذّر التحقق من الأهلية الآن.` });
      continue;
    }

    valid.push(num);
}
  
 // ===============================
// Murabbik Official Message Style
// ===============================
if (!valid.length) {

 const reasons = rejected.map(r => compactOvsynchReason(r.reason));


  const finalMessage =
    "🔎 تم فحص القائمة\n" +
    "لا يوجد أرقام مؤهلة لبدء برنامج التزامن حاليًا.\n\n" +
    "هذه الحيوانات غير مؤهلة للدخول في برنامج التزامن للأسباب التالية:\n\n" +
    reasons.join("\n");

  return {
    ok: true,
    valid: [],
    rejected,
    message: finalMessage
  };
}
// ✅ رسالة مختصرة واحترافية (مركزيًا)
const accepted = valid.length;
const refused  = rejected.length;

let message =
  "🔎 تم فحص القائمة\n" +
  `✅ مقبول: ${accepted}\n` +
  `🚫 مرفوض: ${refused}`;

if (!accepted) {
  message =
    "🔎 تم فحص القائمة\n" +
    "لا يوجد أرقام مؤهلة لبدء برنامج التزامن حاليًا.\n" +
    "راجِع حالة الحيوانات (ملقحة/عشار/خارج القطيع/مستبعدة) أو التاريخ.";
}

// ✅ ضمّن الرسالة في نتيجة الدالة
return { ok:true, valid, rejected, message };

}

// ✅ اجعلها متاحة للصفحات بدون استيراد
window.mbk = window.mbk || {};
window.mbk.previewOvsynchList = previewOvsynchList;

function applyAnimalToForm(form, animal) {
  form.__mbkDoc = animal?.data || null;
  form.__mbkAnimalId = animal?.id || "";

  const animalIdEl = getFieldEl(form, "animalId");
  if (animalIdEl) animalIdEl.value = form.__mbkAnimalId || "";

  const speciesEl = getFieldEl(form, "species");
 let sp = String(animal?.data?.species || animal?.data?.animalTypeAr || animal?.data?.animalType || animal?.data?.animaltype || animal?.data?.type || "").trim();

  if (/cow|بقر/i.test(sp)) sp = "أبقار";
  if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";
  if (speciesEl && sp) speciesEl.value = sp;

  const lastAIEl = getFieldEl(form, "lastInseminationDate");
  const lastAI = String(animal?.data?.lastInseminationDate || "").trim();
  if (lastAIEl && lastAI && !lastAIEl.value) lastAIEl.value = lastAI;
}

async function ensureAnimalExistsGate(form, bar) {
  if (!localStorage.getItem("userId") && !auth?.currentUser) {
    showMsg(bar, "سجّل الدخول أولًا.", "error");
    return false;
  }

  const uid = await getUid();
  const numEl = getFieldEl(form, "animalNumber");
  const n = normalizeDigits(numEl?.value || "");

  const ALLOW = ["animalNumber", "eventDate"];

  if (!uid) {
    applyAnimalToForm(form, null);
    showMsg(bar, "سجّل الدخول أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  if (!n) {
    applyAnimalToForm(form, null);
    bar.style.display = "none";
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  if (form.__mbkLastCheckedNumber === n && form.dataset.animalOk === "1") {
    return true;
  }

  form.__mbkLastCheckedNumber = n;
  form.dataset.animalOk = "0";
  applyAnimalToForm(form, null);

  showMsg(bar, "جارِ التحقق من رقم الحيوان…", "info");
  setFormInputsDisabled(form, true, ALLOW);

  const animal = await fetchAnimalByNumberForUser(uid, n);
  if (!animal) {
    showMsg(bar, "❌ رقم الحيوان غير موجود في حسابك. اكتب الرقم الصحيح أولًا.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  const st = String(animal.data?.status ?? "").trim().toLowerCase();
  if (st === "inactive") {
    showMsg(bar, "❌ هذا الحيوان خارج القطيع (بيع/نفوق/استبعاد) — لا يمكن تسجيل أحداث له.", "error");
    form.dataset.animalOk = "0";
    setFormInputsDisabled(form, true, ALLOW);
    return false;
  }

  applyAnimalToForm(form, animal);
  form.dataset.animalOk = "1";
  setFormInputsDisabled(form, false, ALLOW);
  return true;
}

/* ===================== Attach ===================== */
function attachOne(form) {
  const bar = ensureInfoBar(form);
  const eventName = form.getAttribute("data-event");
  if (form.dataset.mbkOvsynchAttached === "1") return;
form.dataset.mbkOvsynchAttached = "1";

  if (!eventName) return;

  function lockForm(locked) {
    form.dataset.locked = locked ? "1" : "0";
    form.querySelectorAll("input, select, textarea, button").forEach((el) => {
      const key = el.id || el.getAttribute("data-field") || "";
      if (key === "animalNumber" || key === "eventDate") return;
      el.disabled = !!locked;
    });
  }

  lockForm(true);

  async function runGateOnly() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();
    clearFieldErrors(form);

    if (!n || !d) {
      bar.style.display = "none";
      lockForm(true);
      return false;
    }

    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) {
      lockForm(true);
      return false;
    }

    if (eventName === "ولادة") {
      if (typeof guards?.calvingDecision !== "function") {
        showMsg(bar, "❌ تعذّر تحميل قواعد التحقق (calvingDecision). حدّث الصفحة أو راجع form-rules.js", "error");
        lockForm(true);
        return false;
      }

      const uid = await getUid();
      const sig = await fetchCalvingSignalsFromEvents(uid, n);

      const doc = form.__mbkDoc || {};
      const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

      let sp = String(getFieldEl(form, "species")?.value || "").trim() || docSpecies;
      if (/cow|بقر/i.test(sp)) sp = "أبقار";
      if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

      const reproFromEvents = String(sig.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const repro = reproFromEvents || reproFromDoc || "";

      const lastAI = String(doc.lastInseminationDate || "").trim();

      const gateData = {
        animalNumber: n,
        eventDate: d,
        animalId: form.__mbkAnimalId || "",
        species: sp,
        documentData: doc,
        reproductiveStatus: repro,
        reproStatusFromEvents: reproFromEvents,
        lastInseminationDate: lastAI,
        lastBoundary: String(sig.lastBoundary || "").trim(),
        lastBoundaryType: String(sig.lastBoundaryType || "").trim()
      };

      const g = guards.calvingDecision(gateData);

      if (g) {
        const errs = [String(g)];
        const cleaned = errs.map((e) => String(e || "").replace(/^OFFER_ABORT\|/, ""));
        const hasAbortHint = errs.some((e) => String(e || "").startsWith("OFFER_ABORT|"));

        if (hasAbortHint) {
          const url = `/abortion.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`;
          showMsg(bar, cleaned, "error", [
            { label: "نعم — تسجيل إجهاض", primary: true, onClick: () => (location.href = url) },
            { label: "لا — تعديل التاريخ", onClick: () => getFieldEl(form, "eventDate")?.focus?.() }
          ]);
        } else {
          showMsg(bar, cleaned, "error");
        }

        lockForm(true);
        return false;
      }
    }
       // ✅ Gate خاص لحدث "إجهاض" (لا يفتح النموذج إلا إذا كانت عِشار فعلاً)
    if (eventName === "إجهاض") {
      if (typeof guards?.abortionDecision !== "function") {
        showMsg(bar, "❌ تعذّر تحميل قواعد التحقق (abortionDecision). حدّث الصفحة أو راجع form-rules.js", "error");
        lockForm(true);
        return false;
      }

      const uid = await getUid();
      const sig = await fetchCalvingSignalsFromEvents(uid, n);

      const doc = form.__mbkDoc || {};
      const docSpecies = String(doc.species || doc.animalTypeAr || "").trim();

      let sp = String(getFieldEl(form, "species")?.value || "").trim() || docSpecies;
      if (/cow|بقر/i.test(sp)) sp = "أبقار";
      if (/buffalo|جاموس/i.test(sp)) sp = "جاموس";

      const reproFromEvents = String(sig.reproStatusFromEvents || "").trim();
      const reproFromDoc = String(doc.reproductiveStatus || "").trim();
      const repro = reproFromEvents || reproFromDoc || "";

      const lastAI = String(doc.lastInseminationDate || "").trim();

      const gateData = {
        animalNumber: n,
        eventDate: d,
        animalId: form.__mbkAnimalId || "",
        species: sp,
        documentData: doc,
        reproductiveStatus: repro,
        reproStatusFromEvents: reproFromEvents,
        lastInseminationDate: lastAI,
        lastBoundary: String(sig.lastBoundary || "").trim(),
        lastBoundaryType: String(sig.lastBoundaryType || "").trim()
      };

      const g = guards.abortionDecision(gateData);
      if (g) {
        showMsg(bar, [String(g)], "error");
        lockForm(true);
        return false;
      }
    }
        // ✅ Gate خاص لحدث "تلقيح" قبل فتح النموذج (60 يوم بعد آخر ولادة)
    if (eventName === "تلقيح") {
      if (typeof guards?.inseminationDecision !== "function") {
        showMsg(bar, "❌ تعذّر تحميل قواعد التحقق (inseminationDecision).", "error");
        lockForm(true);
        return false;
      }

      const uid2 = await getUid();
      const sig2 = await fetchCalvingSignalsFromEvents(uid2, n);

      const doc2 = form.__mbkDoc || {};
      const docSpecies2 = String(doc2.species || doc2.animalTypeAr || doc2.animalType || doc2.animaltype || doc2.type || "").trim();


      let sp2 = String(getFieldEl(form, "species")?.value || "").trim() || docSpecies2;
      if (/cow|بقر/i.test(sp2)) sp2 = "أبقار";
      if (/buffalo|جاموس/i.test(sp2)) sp2 = "جاموس";

      const gateData2 = {
        animalNumber: n,
        eventDate: d,
        species: sp2,
        documentData: doc2,
        lastInseminationDate: String(sig2.lastInseminationDateFromEvents || "").trim(),

        reproStatusFromEvents: String(sig2.reproStatusFromEvents || "").trim(),
        lastBoundary: String(sig2.lastBoundary || "").trim(),
        lastBoundaryType: String(sig2.lastBoundaryType || "").trim()
      };

      const g2 = guards.inseminationDecision(gateData2);

      // لو رجع تحذير/منع
    if (g2) {
  const s = String(g2);
  if (s.startsWith("WARN|")) {
    showMsg(bar, [s.replace(/^WARN\|/, "")], "info");
    lockForm(false);
    return true;
  }
  showMsg(bar, [s], "error");
  lockForm(true);
  return false;
}
}
    // ✅ Gate خاص لحدث "شياع"
if (eventName === "شياع") {

  const uidH = await getUid();
  const sigH = await fetchCalvingSignalsFromEvents(uidH, n);

  const docH = form.__mbkDoc || {};
  const docSpeciesH = String(docH.species || docH.animalTypeAr || "").trim();

  let spH = String(getFieldEl(form, "species")?.value || "").trim() || docSpeciesH;
  if (/cow|بقر/i.test(spH)) spH = "أبقار";
  if (/buffalo|جاموس/i.test(spH)) spH = "جاموس";

  const reproFromEventsH = String(sigH.reproStatusFromEvents || "").trim();
  const reproFromDocH = String(docH.reproductiveStatus || "").trim();

  const gateDataH = {
    animalNumber: n,
    eventDate: d,
    species: spH,
    documentData: docH,
    reproStatusFromEvents: reproFromEventsH || reproFromDocH
  };

  const gH = guards.heatDecision(gateDataH);

  if (gH) {

    if (gH.action === "confirmPregnancy") {
      showMsg(bar, gH.msg, "error", [
        {
          label: "تأكيد الحمل",
          primary: true,
          onClick: () => {
            location.href = `/pregnancy-diagnosis.html?number=${encodeURIComponent(n)}&date=${encodeURIComponent(d)}`;
          }
        }
      ]);
    } else {
      showMsg(bar, gH.msg, "error");
    }

    lockForm(true);
    return false;
  }
}

        // ✅ Gate خاص لحدث "تحضير للولادة" قبل فتح النموذج
    if (eventName === "تحضير للولادة") {
      if (typeof guards?.closeupDecision !== "function") {
        showMsg(bar, "❌ تعذّر تحميل قواعد التحقق (closeupDecision). حدّث الصفحة أو راجع form-rules.js", "error");
        lockForm(true);
        return false;
      }

      const uid3 = await getUid();
      const sig3 = await fetchCalvingSignalsFromEvents(uid3, n);

      const doc3 = form.__mbkDoc || {};
      const docSpecies3 = String(doc3.species || doc3.animalTypeAr || doc3.animalType || "").trim();

      let sp3 = String(getFieldEl(form, "species")?.value || "").trim() || docSpecies3;
      if (/cow|بقر/i.test(sp3)) sp3 = "أبقار";
      if (/buffalo|جاموس/i.test(sp3)) sp3 = "جاموس";

      const reproFromEvents3 = String(sig3.reproStatusFromEvents || "").trim();
      const reproFromDoc3 = String(doc3.reproductiveStatus || "").trim();
      const repro3 = reproFromEvents3 || reproFromDoc3 || "";

      const lastAI3 = String(
        getFieldEl(form, "lastInseminationDate")?.value ||
        doc3.lastInseminationDate ||
        ""
      ).trim();

      const gateData3 = {
        animalNumber: n,
        eventDate: d,
        animalId: form.__mbkAnimalId || "",
        species: sp3,
        documentData: doc3,
        reproductiveStatus: repro3,
        reproStatusFromEvents: reproFromEvents3,
        lastInseminationDate: lastAI3,
        lastBoundary: String(sig3.lastBoundary || "").trim(),
        lastBoundaryType: String(sig3.lastBoundaryType || "").trim()
      };

      const g3 = guards.closeupDecision(gateData3);
      if (g3) {
        showMsg(bar, [String(g3)], "error");
        lockForm(true);
        return false;
      }
    }
   // ✅ Gate خاص لحدث "تجفيف": حساب أيام الحمل وملء الحقل تلقائيًا
if (eventName === "تجفيف") {
  const uid4 = await getUid();
  const sig4 = await fetchCalvingSignalsFromEvents(uid4, n);

  const doc4 = form.__mbkDoc || {};

  // آخر تلقيح: من الأحداث أولًا ثم الوثيقة
  const lastAI4 = String(sig4.lastInseminationDateFromEvents || doc4.lastInseminationDate || "").trim();

  if (!lastAI4) {
    showMsg(bar, '❌ لا يمكن حساب أيام الحمل — لا يوجد "آخر تلقيح" لهذا الحيوان.', "error");
    lockForm(true);
    return false;
  }

  const g = daysBetweenISO(lastAI4, d);
  if (!Number.isFinite(g) || g < 0) {
    showMsg(bar, "❌ تعذّر حساب أيام الحمل — راجع تاريخ التجفيف.", "error");
    lockForm(true);
    return false;
  }

  // اكتبها في الحقل (مطلوب + readonly)
  const gEl = getFieldEl(form, "gestationDays");
  if (gEl) gEl.value = String(g);

  // خزّن آخر تلقيح في الفورم لاستخدامه عند الحفظ
  form.__mbkDryOffLastAI = lastAI4;
}
   showMsg(bar, "✅ التحقق صحيح — يمكنك إدخال البيانات", "ok");
    lockForm(false);
    return true;
  }

  async function runFullValidationAndDispatch() {
    const n = normalizeDigits(getFieldEl(form, "animalNumber")?.value || "");
    const d = String(getFieldEl(form, "eventDate")?.value || "").trim();

    if (!n || !d) {
      showMsg(bar, "أدخل رقم الحيوان وتاريخ الحدث أولًا.", "error");
      lockForm(true);
      return false;
    }

    const okAnimal = await ensureAnimalExistsGate(form, bar);
    if (!okAnimal) {
      lockForm(true);
      return false;
    }

    const formData = collectFormData(form);
    // ✅ Dry-off: احفظ آخر تلقيح المحسوب من الـ Gate داخل payload
if (eventName === "تجفيف" && form.__mbkDryOffLastAI && !formData.lastInseminationDate) {
  formData.lastInseminationDate = String(form.__mbkDryOffLastAI).slice(0,10);
}

    // =======================
// Murabbik — Daily Milk: force numeric fields
// =======================
if (eventName === "لبن يومي") {
  ["milkS1","milkS2","milkS3"].forEach(k => {
    if (!(k in formData)) return;
    const v = String(formData[k] ?? "").trim();
    formData[k] = v === "" ? "" : Number(v);
  });
}

    formData.documentData = form.__mbkDoc || null;
    if (!formData.animalId && form.__mbkAnimalId) formData.animalId = form.__mbkAnimalId;
    
        // ✅ Auto-calc للإجهاض: يحسب عمر الإجهاض + السبب من آخر تلقيح (من الوثيقة)
    if (eventName === "إجهاض") {
      const doc = formData.documentData || {};
      const lastAI = String(formData.lastInseminationDate || doc.lastInseminationDate || "").slice(0,10);
      const evDate = String(formData.eventDate || "").slice(0,10);

      formData.lastInseminationDate = lastAI;
      if (!formData.species) formData.species = String(doc.species || doc.animalTypeAr || "").trim();

      let months = "";
      let cause = "";

      if (lastAI && evDate) {
        const d1 = new Date(lastAI);
        const d2 = new Date(evDate);
        if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
          const m = Math.max(0, (d2 - d1) / (1000*60*60*24*30.44));
          months = Number.isFinite(m) ? Number(m.toFixed(1)) : "";
          cause = (months !== "" && months >= 6) ? "احتمال بروسيلا (≥6 شهور)" : "احتمال BVD (<6 شهور)";
        }
      }

      formData.abortionAgeMonths = months;
      formData.probableCause = cause;

      // ✅ اكتبهم في الحقول (بدون ما يعتمد على سكربت الصفحة)
      const ageEl = document.getElementById("abortionAgeMonths");
      const causeEl = document.getElementById("probableCause");
      if (ageEl) ageEl.value = months === "" ? "" : String(months);
      if (causeEl) causeEl.value = cause || "";
    }

    if (eventName === "ولادة") {
      const uid = await getUid();
      const kind = String(formData.calvingKind || "").trim();

      if (kind !== "نافقة") {
        const count = parseInt(String(formData.calfCount || "1"), 10) || 1;

        const calfNums = [
          String(formData.calfId || "").trim(),
          count >= 2 ? String(formData.calf2Id || "").trim() : "",
          count >= 3 ? String(formData.calf3Id || "").trim() : ""
        ].filter(Boolean);

        if (calfNums.length) {
          try {
            const chk = await uniqueCalfNumbers({ userId: uid, calfNumbers: calfNums });
            if (!chk || chk.ok === false) {
              clearFieldErrors(form);
              showMsg(bar, (chk && chk.msg) ? chk.msg : "⚠️ رقم عجل مكرر في حسابك.", "error");
              lockForm(false);
              return false;
            }
          } catch (err) {
            console.error("uniqueCalfNumbers failed:", err);
            clearFieldErrors(form);
            showMsg(bar, "تعذّر التحقق من تكرار أرقام العجول الآن. جرّب مرة أخرى.", "error");
            lockForm(false);
            return false;
          }
        }
      }
    }
    // ✅ 1) Validation المركزي لكل الأحداث (إجهاض/تلقيح/تشخيص/…)
    const v = validateEvent(eventName, formData);

    if (!v || v.ok === false) {
      clearFieldErrors(form);

      // Inline field errors
      if (v?.fieldErrors && typeof v.fieldErrors === "object") {
        for (const [fname, msg] of Object.entries(v.fieldErrors)) {
          placeFieldError(form, fname, msg);
        }
        scrollToFirstFieldError(form);
      }

      // رسائل أعلى النموذج
      const topMsgs =
        (Array.isArray(v?.guardErrors) && v.guardErrors.length) ? v.guardErrors :
        (Array.isArray(v?.errors) && v.errors.length) ? v.errors :
        ["❌ البيانات غير صحيحة — راجع الحقول."];

      showMsg(bar, topMsgs, "error");
      lockForm(false);
      return false;
    }

    form.dispatchEvent(
      new CustomEvent("mbk:valid", {
        bubbles: true,
        detail: { formData, eventName, form }
      })
    );
    return true;
  }

  // ✅ Gate startup watcher
  let gateStarted = false;
  const watcher = setInterval(() => {
    if (gateStarted) return;

    const n = getFieldEl(form, "animalNumber")?.value?.trim();
    const d = getFieldEl(form, "eventDate")?.value?.trim();

    if (n && d) {
      gateStarted = true;
      clearInterval(watcher);
      runGateOnly();
    }
  }, 120);

  // ✅ هنا الإصلاح الحقيقي: input + change (خصوصًا للتاريخ)
  const numEl = getFieldEl(form, "animalNumber");
  const dateEl = getFieldEl(form, "eventDate");

  ["input", "change"].forEach(evt => {
    numEl?.addEventListener(evt, runGateOnly);
    dateEl?.addEventListener(evt, runGateOnly);
  });

  // ✅ submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // بدل الصمت: لو لسه مقفول
    if (form.dataset.locked === "1") {
      showMsg(bar, "⚠️ أكمل إدخال رقم الحيوان والتاريخ وانتظر التحقق الأخضر أولًا.", "error");
      return;
    }

    const ok = await runFullValidationAndDispatch();
    if (!ok) return;
  });
}

/* ===================== add-animal watcher (كما هو) ===================== */
function attachUniqueAnimalNumberWatcher() {
  const form = document.getElementById("animalForm");
  const input = form?.querySelector("#animalNumber");
  if (!form || !input) return;

  const bar = ensureInfoBar(form);
  let timer = null;
  let lastValue = "";

  input.addEventListener("input", () => {
    const num = String(input.value || "").trim();

    form.dataset.numberOk = "";
    if (!num) {
      bar.style.display = "none";
      lastValue = "";
      return;
    }

    if (num === lastValue) return;
    lastValue = num;

    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      try {
        const res = await uniqueAnimalNumber({ userId, number: num });
        if (!res.ok) {
          showMsg(bar, res.msg || "هذا الرقم مستخدم بالفعل.", "error");
          form.dataset.numberOk = "0";
        } else {
          showMsg(bar, "✅ رقم الحيوان متاح في حسابك.", "ok");
          form.dataset.numberOk = "1";
        }
      } catch (e) {
        console.error("uniqueAnimalNumber check failed", e);
      }
    }, 400);
  });
}
/* ===================== Special: Ovsynch Protocol (NO GATE / NO LOCK / NO VALIDATION) ===================== */
function attachOvsynchProtocol(form){
  const bar = ensureInfoBar(form);
  const eventName = String(form.getAttribute("data-event") || "").trim();
  if (eventName !== "بروتوكول تزامن") return;
  if (form.dataset.mbkOvsynchAttached === "1") return;
form.dataset.mbkOvsynchAttached = "1";


  // لا Lock ولا Gate عام
  form.dataset.locked = "0";

  // Helpers محلية للصفحة (لو موجودة عناصرها)
  const modeGroupEl = document.getElementById("modeGroup");
  const animalUIEl  = document.getElementById("animalNumberUI");
  const bulkEl      = document.getElementById("bulkAnimals");
  const programEl   = document.getElementById("program");
  const startDateUIEl = document.getElementById("startDate"); // تاريخ بدء البروتوكول في الصفحة

  function parseBulkLocal(){
    const raw = String(bulkEl?.value || "").trim();
    if (!raw) return [];
    return [...new Set(raw.split(/\n|,|;/g).map(x=>normalizeDigits(x)).filter(Boolean))];
  }async function previewAndCleanBulk(){
  if (!bulkEl) return;

  const dt  = String(startDateUIEl?.value || "").trim().slice(0,10);
  const list = parseBulkLocal();

  if (!dt || !list.length) return;

  if (typeof window.mbk?.previewOvsynchList !== "function"){
    showMsg(bar, "❌ تعذّر تحميل نظام التحقق المركزي. حدّث الصفحة.", "error");
    return;
  }

  showMsg(bar, "⏳ جارِ فحص القائمة…", "info");

  const r = await window.mbk.previewOvsynchList(list, dt);
  if (!r || r.ok === false){
    showMsg(bar, (r?.rejected?.[0]?.reason || "❌ تعذّر التحقق الآن."), "error");
    return;
  }

  const valid = Array.isArray(r.valid) ? r.valid : [];
  const rejected = Array.isArray(r.rejected) ? r.rejected : [];

  // ✅ امسح غير المؤهلين فورًا
  bulkEl.value = valid.join("\n");

  // ✅ نفس رسائل الأحمر ولكن بتنسيق أخضر “محترم”
  const lines = [];
  lines.push(`✅ صالح للتسجيل: ${valid.length} رقم`);

  if (rejected.length){
    lines.push(`🚫 تم حذف: ${rejected.length} رقم للأسباب التالية:`);
    rejected.forEach(x=>{
      const num = String(x?.number ?? x?.animalNumber ?? "").trim();
      const rs  = String(x?.reason || "").trim().replace(/^❌\s*/,"");
      lines.push(num ? `✖ رقم ${num}: ${rs}` : `✖ ${rs}`);
    });
  }

  // ✅ لو لا يوجد مؤهلين: فضّي القائمة
  if (!valid.length){
    bulkEl.value = "";
  }

  // 🔥 هنا سر “النسخة الخضراء”: حتى لو فيها رفض، نخليها ok (أخضر)
  showMsg(bar, lines, "ok");
}

// ===============================
// ✅ Gate فردي قبل إدخال أي بيانات
// ===============================
function lockOvsynchUI(locked){
  // ✅ مسموح حتى مع القفل: الوضع + رقم الفردي + تاريخ البدء + وقت البدء + إدخال الجماعي
 const allowIds = new Set([
  "modeSingle","modeGroup",
  "animalNumberUI","startDate","startTime","bulkAnimals",
  "applyBulk","groupSelect","groupName","loadGroup","saveGroup"
]);


  // اقفل/افتح عناصر الفورم الداخلية
  form.querySelectorAll("input, select, textarea, button").forEach(el=>{
    if (allowIds.has(el.id)) return;
    el.disabled = !!locked;
  });

  // اقفل/افتح checkboxes الخاصة بالخطوات (إن وجدت)
  document.querySelectorAll('#stepsBox input[type="checkbox"]').forEach(cb=>{
    cb.disabled = !!locked;
  });

}

async function runSingleGateIfReady(){
  const isGroup = !!modeGroupEl?.checked;
  if (isGroup) return; // الفردي فقط

  const num = normalizeDigits(animalUIEl?.value || "");
  const dt  = String(startDateUIEl?.value || "").trim().slice(0,10);

  // لو لسه ناقص رقم/تاريخ: ما نزعجش المستخدم
  if (!num || !dt){
    
    lockOvsynchUI(true);
form.dataset.ov_single_ok = "0";

    return;
  }

  if (typeof window.mbk?.previewOvsynchList !== "function"){
   
    lockOvsynchUI(true);
form.dataset.ov_single_ok = "0";

    showMsg(bar, "❌ تعذّر تحميل نظام التحقق المركزي (previewOvsynchList). حدّث الصفحة.", "error");
    return;
  }

  showMsg(bar, "⏳ جارِ التحقق من أهلية الرقم…", "info");

  const r = await window.mbk.previewOvsynchList([num], dt);

  if (!r || r.ok === false){
  
    lockOvsynchUI(true);
   form.dataset.ov_single_ok = "0";

    // ✅ امسح الرقم زي الجماعي
    animalUIEl.value = "";
    const hiddenNum = form.querySelector('[data-field="animalNumber"]');
    if (hiddenNum) hiddenNum.value = "";
    showMsg(bar, (r?.rejected?.[0]?.reason || "❌ تعذّر التحقق الآن."), "error");
    try{ animalUIEl.focus(); }catch(_){}
    return;
  }

  const valid = Array.isArray(r.valid) ? r.valid : [];
  const rejected = Array.isArray(r.rejected) ? r.rejected : [];

  if (!valid.includes(num)){
   
    lockOvsynchUI(true);
form.dataset.ov_single_ok = "0";
    // ✅ امسح الرقم زي الجماعي
    animalUIEl.value = "";
    const hiddenNum = form.querySelector('[data-field="animalNumber"]');
    if (hiddenNum) hiddenNum.value = "";
    showMsg(bar, rejected[0]?.reason || `❌ رقم ${num}: غير مؤهل للتزامن.`, "error");
    try{ animalUIEl.focus(); }catch(_){}
    return;
  }

  // ✅ مؤهل
form.dataset.ov_single_ok = "1";
  lockOvsynchUI(false);

  const hiddenNum = form.querySelector('[data-field="animalNumber"]');
  if (hiddenNum) hiddenNum.value = num;
  showMsg(bar, `✅ رقم ${num} مؤهل لبروتوكول التزامن بتاريخ ${dt}.`, "ok");
}

// ✅ شغّل Gate الفردي تلقائيًا عند تغيير الرقم/التاريخ/الوضع
["input","change"].forEach(evt=>{
  animalUIEl?.addEventListener(evt, runSingleGateIfReady);
  startDateUIEl?.addEventListener(evt, runSingleGateIfReady);
});

// ✅ تنظيف تلقائي للأرقام غير المؤهلة في الإدخال الجماعي
bulkEl?.addEventListener("blur", previewAndCleanBulk);
bulkEl?.addEventListener("change", previewAndCleanBulk);
startDateUIEl?.addEventListener("change", previewAndCleanBulk);

// لو عندك زر “تطبيق” للأرقام الجماعية
document.getElementById("applyBulk")?.addEventListener("click", (e)=>{
  e.preventDefault();
  previewAndCleanBulk();
});

modeGroupEl?.addEventListener("change", runSingleGateIfReady);
document.getElementById("modeSingle")?.addEventListener("change", runSingleGateIfReady);

// ✅ عند فتح الصفحة: اقفل فورًا ثم حاول Gate لو الرقم/التاريخ موجودين
lockOvsynchUI(true);
setTimeout(runSingleGateIfReady, 50);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
// ✅ لو فردي ولم ينجح الـGate: امنع أي حفظ
const isGroupNow = !!modeGroupEl?.checked;
if (!isGroupNow && form.dataset.ov_single_ok !== "1"){
  showMsg(bar, "⚠️ اكتب رقم الحيوان واختر التاريخ… وانتظر رسالة الأهلية ✅ قبل إدخال أي بيانات أو حفظ.", "error");
  return;
}

    const formData = collectFormData(form);

   // ✅ مصدر التاريخ في Ovsynch لازم يكون من UI (startDate) لأن hidden قد يكون غير متزامن
const startDateUI = document.getElementById("startDate");
const dt = String((startDateUI?.value || formData.eventDate || "")).trim().slice(0,10);

// ✅ تأكيد مزامنة payload قبل التحقق/الحفظ
formData.eventDate = dt;

    const program = String(programEl?.value || formData.program || "").trim();

    // ✅ فحوصات UI بسيطة (وليست أهلية)
    if (!dt) { showMsg(bar, "⚠️ اختر تاريخ بدء البروتوكول أولًا.", "error"); return; }
    if (!program) { showMsg(bar, "⚠️ اختر نوع البرنامج أولًا.", "error"); return; }

    // ✅ steps لازم تكون موجودة وصالحة (مركزيًا مطلوب)
    let stepsArr = [];
    try{
      stepsArr = JSON.parse(String(formData.steps || "[]"));
    }catch(_){
      stepsArr = [];
    }
    if (!Array.isArray(stepsArr) || !stepsArr.length){
      showMsg(bar, "⚠️ لازم تختار البرنامج علشان الجدول يظهر، وبعدها سجّل.", "error");
      return;
    }

    // ✅ حدّد targets حسب الوضع
    const isGroup = !!modeGroupEl?.checked;
    let targets = [];

    if (isGroup){
      targets = parseBulkLocal();
    }else{
      const one = normalizeDigits(animalUIEl?.value || formData.animalNumber || "");
      if (one) targets = [one];
    }

    if (!targets.length){
      showMsg(bar, "⚠️ اكتب رقم الحيوان (أو قائمة الأرقام) أولًا.", "error");
      return;
    }

    // ✅ تحقق الدخول
    const uid = await getUid();
    if (!uid){
      showMsg(bar, "⚠️ لم يتم تأكيد الدخول.", "error");
      return;
    }

    // ✅ التحقق المركزي (أهلية + 14 يوم) = previewOvsynchList (الذي يستدعي Guard)
    if (typeof window.mbk?.previewOvsynchList !== "function"){
      showMsg(bar, "❌ تعذّر تحميل نظام التحقق المركزي (previewOvsynchList).", "error");
      return;
    }

    const r = await window.mbk.previewOvsynchList(targets, dt);
    if (!r || r.ok === false){
      const msg = (r?.rejected?.[0]?.reason) ? String(r.rejected[0].reason) : "❌ تعذّر التحقق الآن.";
      showMsg(bar, msg, "error");
      return;
    }

    const valid = Array.isArray(r.valid) ? r.valid : [];
    const rejected = Array.isArray(r.rejected) ? r.rejected : [];

    if (!valid.length){
      const prev = rejected.slice(0,6).map(x=>x.reason).join("\n");
      showMsg(bar, prev || "🚫 لا يوجد رقم صالح للتسجيل.", "error");
      return;
    }

    // ✅ لو جماعي: رجّع القائمة بعد التنظيف
    if (isGroup && bulkEl){
      bulkEl.value = valid.join("\n");
    }

    // ✅ جهّز formData لإطلاق mbk:valid (مرّة واحدة)
    formData.userId = uid;
    formData.program = program;
    formData.steps = JSON.stringify(stepsArr);
    formData.animalNumber = valid[0];        // للتوافق
    formData.animalNumbers = valid;          // ✅ قائمة كاملة
    formData.rejected = rejected;            // ✅ لأجل الرسالة النهائية

    form.dispatchEvent(
      new CustomEvent("mbk:valid", {
        bubbles: true,
        detail: { formData, eventName, form }
      })
    );
  });
}

// ✅ Global OK button handler (delegation) — fixes "حسنًا" not closing
(function attachGlobalInfobarOk(){
  if (window.__MBK_OKBTN_BOUND__) return;
  window.__MBK_OKBTN_BOUND__ = true;

  document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".infobar .okbtn");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const bar = btn.closest(".infobar");
    if (bar) bar.style.display = "none";
  }, true); // ✅ capture
})();

function autoAttach() {
document
  .querySelectorAll('form[data-validate="true"][data-event]')
  .forEach((f) => {
    const ev = String(f.getAttribute("data-event") || "").trim();

    if (ev === "بروتوكول تزامن") {
      attachOvsynchProtocol(f);   // ✅ Attach خفيف يطلق mbk:valid فقط
      return;
    }

    attachOne(f);
  });


  attachUniqueAnimalNumberWatcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", autoAttach);
} else {
  autoAttach();
}

